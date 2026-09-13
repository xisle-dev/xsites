package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
)

// ErrSiteNotFound is returned by SiteStore methods when the requested site
// doesn't exist -- handlers check for it with errors.Is to decide between a
// 404 and a 500, the same distinction siteExists made before this
// abstraction existed.
var ErrSiteNotFound = errors.New("site not found")

// ErrMediaNotFound is returned by SiteStore.GetMedia when the requested
// file doesn't exist.
var ErrMediaNotFound = errors.New("media not found")

// SiteStore is everywhere site data and media actually live -- local files
// under sites/, or objects in R2 (see Phase 1-3, github issue #1). Every
// HTTP handler in main.go goes through this now; nothing touches the local
// filesystem or an R2 client directly outside this file.
type SiteStore interface {
	GetAllSites(ctx context.Context) ([]Site, error)
	GetSite(ctx context.Context, id string) (Site, error)
	SaveSite(ctx context.Context, site Site) error
	DeleteSite(ctx context.Context, id string) error // also removes all of that site's media

	SaveMedia(ctx context.Context, id, filename string, data []byte) error
	DeleteMedia(ctx context.Context, id, filename string) error
	GetMedia(ctx context.Context, id, filename string) (io.ReadCloser, string, error) // body, content-type, error
}

// uniqueSiteID mirrors the old newUniqueSiteID's collision-avoidance logic
// (slugify the name, then try -2, -3, ... until free), but through the
// store abstraction instead of os.Stat, so it works against either backend.
func uniqueSiteID(ctx context.Context, store SiteStore, name string) (string, error) {
	base := slugify(name)
	id := base
	for n := 2; ; n++ {
		_, err := store.GetSite(ctx, id)
		if errors.Is(err, ErrSiteNotFound) {
			return id, nil
		}
		if err != nil {
			return "", err
		}
		id = fmt.Sprintf("%s-%d", base, n)
	}
}

// mediaContentType classifies by extension -- the same mapping main.go
// registers with the mime package for local static serving, kept in sync
// here so R2-served media reports the same Content-Type local files did.
func mediaContentType(filename string) string {
	switch strings.ToLower(filepath.Ext(filename)) {
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".pdf":
		return "application/pdf"
	case ".gpx":
		return "application/gpx+xml"
	default:
		if ct := mime.TypeByExtension(filepath.Ext(filename)); ct != "" {
			return ct
		}
		return "application/octet-stream"
	}
}

// --- local filesystem store (today's default, and local dev going forward) ---

type localSiteStore struct {
	dir string
}

func newLocalSiteStore(dir string) *localSiteStore {
	return &localSiteStore{dir: dir}
}

func (s *localSiteStore) GetAllSites(ctx context.Context) ([]Site, error) {
	return getAllSites(s.dir)
}

// isFlatComponent rejects anything that isn't a single plain path segment --
// no "/", no "..", no leading "." tricks -- since id and filename both land
// straight in a filepath.Join from URL path values. R2 keys are just
// strings (no traversal risk there), but this same store also has to be
// safe to run against the local filesystem for dev.
func isFlatComponent(s string) bool {
	return s != "" && s != "." && s != ".." && !strings.ContainsAny(s, `/\`)
}

func (s *localSiteStore) GetSite(ctx context.Context, id string) (Site, error) {
	if !isFlatComponent(id) {
		return Site{}, ErrSiteNotFound
	}
	path := siteYamlPathIn(s.dir, id)
	if _, err := os.Stat(path); err != nil {
		if os.IsNotExist(err) {
			return Site{}, ErrSiteNotFound
		}
		return Site{}, err
	}
	return readSiteYaml(path, id)
}

func (s *localSiteStore) SaveSite(ctx context.Context, site Site) error {
	if !isFlatComponent(site.ID) {
		return fmt.Errorf("invalid site id %q", site.ID)
	}
	return writeSiteYaml(site, siteYamlPathIn(s.dir, site.ID))
}

func (s *localSiteStore) DeleteSite(ctx context.Context, id string) error {
	if !isFlatComponent(id) {
		return ErrSiteNotFound
	}
	if err := os.Remove(siteYamlPathIn(s.dir, id)); err != nil {
		return err
	}
	return os.RemoveAll(filepath.Join(s.dir, id))
}

func (s *localSiteStore) mediaPath(id, filename string) (string, bool) {
	if !isFlatComponent(id) || !isFlatComponent(filename) {
		return "", false
	}
	return filepath.Join(s.dir, id, "media", filename), true
}

func (s *localSiteStore) SaveMedia(ctx context.Context, id, filename string, data []byte) error {
	path, ok := s.mediaPath(id, filename)
	if !ok {
		return fmt.Errorf("invalid media path for site %q, file %q", id, filename)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}

func (s *localSiteStore) DeleteMedia(ctx context.Context, id, filename string) error {
	path, ok := s.mediaPath(id, filename)
	if !ok {
		return ErrMediaNotFound
	}
	err := os.Remove(path)
	if os.IsNotExist(err) {
		return ErrMediaNotFound
	}
	return err
}

func (s *localSiteStore) GetMedia(ctx context.Context, id, filename string) (io.ReadCloser, string, error) {
	path, ok := s.mediaPath(id, filename)
	if !ok {
		return nil, "", ErrMediaNotFound
	}
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, "", ErrMediaNotFound
		}
		return nil, "", err
	}
	return f, mediaContentType(filename), nil
}

// --- R2-backed store (Cloudflare R2, via its S3-compatible API) ---

// r2Config holds everything needed to reach the live-data bucket -- see
// Phase 1 (issue #2) for how the bucket and credentials were provisioned,
// and README.md for the required environment variables.
type r2Config struct {
	AccountID       string
	AccessKeyID     string
	SecretAccessKey string
	Bucket          string
}

func r2ConfigFromEnv() (r2Config, error) {
	cfg := r2Config{
		AccountID:       os.Getenv("R2_ACCOUNT_ID"),
		AccessKeyID:     os.Getenv("R2_LIVE_ACCESS_KEY_ID"),
		SecretAccessKey: os.Getenv("R2_LIVE_SECRET_ACCESS_KEY"),
		Bucket:          os.Getenv("R2_LIVE_BUCKET_NAME"),
	}
	var missing []string
	for name, val := range map[string]string{
		"R2_ACCOUNT_ID":             cfg.AccountID,
		"R2_LIVE_ACCESS_KEY_ID":     cfg.AccessKeyID,
		"R2_LIVE_SECRET_ACCESS_KEY": cfg.SecretAccessKey,
		"R2_LIVE_BUCKET_NAME":       cfg.Bucket,
	} {
		if val == "" {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		sort.Strings(missing)
		return r2Config{}, fmt.Errorf("-store=r2 requires environment variables: %s", strings.Join(missing, ", "))
	}
	return cfg, nil
}

// r2SiteStore stores each site as a single object at sites/<id>.yaml in the
// bucket -- the exact same key shape as the local layout's sites/<id>.yaml
// path, and the exact same YAML bytes (parsed with the same parseSiteYaml
// used for local files), so migrating data in (Phase 3) is a plain object
// upload with no reshaping.
type r2SiteStore struct {
	client *s3.Client
	bucket string
}

func newR2SiteStore(cfg r2Config) *r2SiteStore {
	client := s3.New(s3.Options{
		Region:       "auto", // R2 doesn't have regions; the SDK still requires a value
		BaseEndpoint: aws.String(fmt.Sprintf("https://%s.r2.cloudflarestorage.com", cfg.AccountID)),
		Credentials: credentials.NewStaticCredentialsProvider(
			cfg.AccessKeyID, cfg.SecretAccessKey, "",
		),
	})
	return &r2SiteStore{client: client, bucket: cfg.Bucket}
}

const r2SitesPrefix = "sites/"

func (s *r2SiteStore) GetAllSites(ctx context.Context) ([]Site, error) {
	var sites []Site
	var continuationToken *string
	for {
		out, err := s.client.ListObjectsV2(ctx, &s3.ListObjectsV2Input{
			Bucket:            aws.String(s.bucket),
			Prefix:            aws.String(r2SitesPrefix),
			ContinuationToken: continuationToken,
		})
		if err != nil {
			return nil, fmt.Errorf("listing sites in R2: %w", err)
		}
		for _, obj := range out.Contents {
			key := aws.ToString(obj.Key)
			if !strings.HasSuffix(key, ".yaml") {
				continue
			}
			id := strings.TrimSuffix(strings.TrimPrefix(key, r2SitesPrefix), ".yaml")
			if id == "" || strings.Contains(id, "/") {
				continue // a media object or other nested key, not a top-level site
			}
			site, err := s.GetSite(ctx, id)
			if err != nil {
				continue // skip anything unreadable rather than failing the whole list
			}
			sites = append(sites, site)
		}
		if out.IsTruncated == nil || !*out.IsTruncated {
			break
		}
		continuationToken = out.NextContinuationToken
	}
	if sites == nil {
		sites = []Site{}
	}
	return sites, nil
}

func (s *r2SiteStore) GetSite(ctx context.Context, id string) (Site, error) {
	if !isFlatComponent(id) {
		return Site{}, ErrSiteNotFound
	}
	out, err := s.client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(r2SitesPrefix + id + ".yaml"),
	})
	if err != nil {
		if isR2NotFound(err) {
			return Site{}, ErrSiteNotFound
		}
		return Site{}, fmt.Errorf("fetching site %q from R2: %w", id, err)
	}
	defer out.Body.Close()
	data, err := io.ReadAll(out.Body)
	if err != nil {
		return Site{}, fmt.Errorf("reading site %q from R2: %w", id, err)
	}
	return parseSiteYaml(data, id), nil
}

func (s *r2SiteStore) SaveSite(ctx context.Context, site Site) error {
	if !isFlatComponent(site.ID) {
		return fmt.Errorf("invalid site id %q", site.ID)
	}
	_, err := s.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(s.bucket),
		Key:         aws.String(r2SitesPrefix + site.ID + ".yaml"),
		Body:        bytes.NewReader(renderSiteYaml(site)),
		ContentType: aws.String("application/x-yaml; charset=utf-8"),
	})
	if err != nil {
		return fmt.Errorf("saving site %q to R2: %w", site.ID, err)
	}
	return nil
}

// DeleteSite removes the site's YAML object and everything under its media
// prefix. R2 has no delete-by-prefix call, so this lists first -- fine at
// the handful-of-files-per-site scale this app deals with.
func (s *r2SiteStore) DeleteSite(ctx context.Context, id string) error {
	if !isFlatComponent(id) {
		return ErrSiteNotFound
	}
	if _, err := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(r2SitesPrefix + id + ".yaml"),
	}); err != nil {
		return fmt.Errorf("deleting site %q from R2: %w", id, err)
	}

	mediaPrefix := s.mediaPrefix(id)
	var continuationToken *string
	for {
		out, err := s.client.ListObjectsV2(ctx, &s3.ListObjectsV2Input{
			Bucket:            aws.String(s.bucket),
			Prefix:            aws.String(mediaPrefix),
			ContinuationToken: continuationToken,
		})
		if err != nil {
			return fmt.Errorf("listing media for site %q in R2: %w", id, err)
		}
		for _, obj := range out.Contents {
			if _, err := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{
				Bucket: aws.String(s.bucket),
				Key:    obj.Key,
			}); err != nil {
				return fmt.Errorf("deleting media %q for site %q in R2: %w", aws.ToString(obj.Key), id, err)
			}
		}
		if out.IsTruncated == nil || !*out.IsTruncated {
			return nil
		}
		continuationToken = out.NextContinuationToken
	}
}

func (s *r2SiteStore) mediaPrefix(id string) string {
	return r2SitesPrefix + id + "/media/"
}

func (s *r2SiteStore) mediaKey(id, filename string) string {
	return s.mediaPrefix(id) + filename
}

func (s *r2SiteStore) SaveMedia(ctx context.Context, id, filename string, data []byte) error {
	if !isFlatComponent(id) || !isFlatComponent(filename) {
		return fmt.Errorf("invalid media path for site %q, file %q", id, filename)
	}
	_, err := s.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(s.bucket),
		Key:         aws.String(s.mediaKey(id, filename)),
		Body:        bytes.NewReader(data),
		ContentType: aws.String(mediaContentType(filename)),
	})
	if err != nil {
		return fmt.Errorf("saving media %q for site %q to R2: %w", filename, id, err)
	}
	return nil
}

func (s *r2SiteStore) DeleteMedia(ctx context.Context, id, filename string) error {
	if !isFlatComponent(id) || !isFlatComponent(filename) {
		return ErrMediaNotFound
	}
	_, err := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(s.mediaKey(id, filename)),
	})
	if err != nil {
		return fmt.Errorf("deleting media %q for site %q from R2: %w", filename, id, err)
	}
	return nil
}

func (s *r2SiteStore) GetMedia(ctx context.Context, id, filename string) (io.ReadCloser, string, error) {
	if !isFlatComponent(id) || !isFlatComponent(filename) {
		return nil, "", ErrMediaNotFound
	}
	out, err := s.client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(s.mediaKey(id, filename)),
	})
	if err != nil {
		if isR2NotFound(err) {
			return nil, "", ErrMediaNotFound
		}
		return nil, "", fmt.Errorf("fetching media %q for site %q from R2: %w", filename, id, err)
	}
	contentType := aws.ToString(out.ContentType)
	if contentType == "" {
		contentType = mediaContentType(filename)
	}
	return out.Body, contentType, nil
}

// isR2NotFound covers both error shapes the SDK can hand back for a missing
// key: a typed NoSuchKey (the documented case) and, in practice with R2,
// sometimes a generic API error carrying a 404 status instead.
func isR2NotFound(err error) bool {
	var nsk *s3types.NoSuchKey
	if errors.As(err, &nsk) {
		return true
	}
	return strings.Contains(err.Error(), "StatusCode: 404") || strings.Contains(err.Error(), "NotFound")
}
