package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
)

// ErrSiteNotFound is returned by SiteStore.GetSite when the requested site
// doesn't exist -- handlers check for it with errors.Is to decide between a
// 404 and a 500, the same distinction handleGetSite made against siteExists
// before this abstraction existed.
var ErrSiteNotFound = errors.New("site not found")

// SiteStore is the read side of wherever site data actually lives -- local
// YAML files under sites/, or (see Phase 4) objects in R2. Only the read
// path moves behind this interface for now (GET /api/sites and GET
// /api/sites/{id}); every write handler still talks to the local
// filesystem directly via sitesDir/readSiteYaml/writeSiteYaml, unchanged.
type SiteStore interface {
	GetAllSites(ctx context.Context) ([]Site, error)
	GetSite(ctx context.Context, id string) (Site, error)
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

func (s *localSiteStore) GetSite(ctx context.Context, id string) (Site, error) {
	path := siteYamlPathIn(s.dir, id)
	if _, err := os.Stat(path); err != nil {
		if os.IsNotExist(err) {
			return Site{}, ErrSiteNotFound
		}
		return Site{}, err
	}
	return readSiteYaml(path, id)
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
