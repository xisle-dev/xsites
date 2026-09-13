package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// publicPublisher mirrors live edits straight into the same R2 bucket the
// static viewer already reads from (see tools/buildstatic and
// .github/workflows/deploy-r2.yml), in the exact key shape buildstatic
// produces -- sites.json at the bucket root, media at media/<id>/<filename>
// -- so a save is visible on the public site within seconds instead of
// waiting on a GitHub Actions rebuild (Phase 8, github issue #9).
//
// This is a best-effort mirror, not the source of truth: R2_LIVE_* (see
// r2SiteStore) remains authoritative. A publish failure is logged, not
// surfaced to the API caller -- the edit itself already succeeded by the
// time this runs.
//
// Configured by a second set of R2 credentials (R2_PUBLIC_*) scoped to the
// public bucket, separate from R2_LIVE_* -- deliberately optional: with
// them unset, newPublicPublisherFromEnv returns nil and every call below is
// a no-op, so this only activates once those credentials are provisioned
// and wired into Cloud Run (see README).
type publicPublisher struct {
	client *s3.Client
	bucket string
}

func newPublicPublisherFromEnv() *publicPublisher {
	accountID := os.Getenv("R2_ACCOUNT_ID")
	accessKeyID := os.Getenv("R2_PUBLIC_ACCESS_KEY_ID")
	secretAccessKey := os.Getenv("R2_PUBLIC_SECRET_ACCESS_KEY")
	bucket := os.Getenv("R2_PUBLIC_BUCKET_NAME")
	if accountID == "" || accessKeyID == "" || secretAccessKey == "" || bucket == "" {
		log.Printf("[publish] R2_PUBLIC_* not fully configured -- edits will only reach the git+Actions static deploy, not publish instantly")
		return nil
	}
	client := s3.New(s3.Options{
		Region:       "auto",
		BaseEndpoint: aws.String(fmt.Sprintf("https://%s.r2.cloudflarestorage.com", accountID)),
		Credentials:  credentials.NewStaticCredentialsProvider(accessKeyID, secretAccessKey, ""),
	})
	return &publicPublisher{client: client, bucket: bucket}
}

// publishSites overwrites sites.json with the full current site list --
// buildstatic writes this same file in this same shape, so the static
// viewer needs no changes to read whichever one is newer.
func (p *publicPublisher) publishSites(ctx context.Context, sites []Site) {
	if p == nil {
		return
	}
	data, err := json.Marshal(sites)
	if err != nil {
		log.Printf("[publish] marshaling sites.json: %v", err)
		return
	}
	_, err = p.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(p.bucket),
		Key:         aws.String("sites.json"),
		Body:        bytes.NewReader(data),
		ContentType: aws.String("application/json; charset=utf-8"),
	})
	if err != nil {
		log.Printf("[publish] writing sites.json: %v", err)
	}
}

// publishMedia mirrors one uploaded file to media/<id>/<filename>, matching
// buildstatic's copyMedia layout (flat under media/, not nested under
// sites/ the way the live-data bucket and local disk are).
func (p *publicPublisher) publishMedia(ctx context.Context, id, filename string, data []byte) {
	if p == nil {
		return
	}
	_, err := p.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(p.bucket),
		Key:         aws.String("media/" + id + "/" + filename),
		Body:        bytes.NewReader(data),
		ContentType: aws.String(mediaContentType(filename)),
	})
	if err != nil {
		log.Printf("[publish] writing media/%s/%s: %v", id, filename, err)
	}
}

func (p *publicPublisher) deleteMedia(ctx context.Context, id, filename string) {
	if p == nil {
		return
	}
	_, err := p.client.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(p.bucket),
		Key:    aws.String("media/" + id + "/" + filename),
	})
	if err != nil {
		log.Printf("[publish] deleting media/%s/%s: %v", id, filename, err)
	}
}

// deleteSiteMedia removes every object under media/<id>/ -- called when a
// site is deleted, since sites.json's own rewrite (via publishSites) only
// covers the site list, not its now-orphaned media files.
func (p *publicPublisher) deleteSiteMedia(ctx context.Context, id string) {
	if p == nil {
		return
	}
	prefix := "media/" + id + "/"
	var continuationToken *string
	for {
		out, err := p.client.ListObjectsV2(ctx, &s3.ListObjectsV2Input{
			Bucket:            aws.String(p.bucket),
			Prefix:            aws.String(prefix),
			ContinuationToken: continuationToken,
		})
		if err != nil {
			log.Printf("[publish] listing %s: %v", prefix, err)
			return
		}
		for _, obj := range out.Contents {
			if _, err := p.client.DeleteObject(ctx, &s3.DeleteObjectInput{
				Bucket: aws.String(p.bucket),
				Key:    obj.Key,
			}); err != nil {
				log.Printf("[publish] deleting %s: %v", aws.ToString(obj.Key), err)
			}
		}
		if out.IsTruncated == nil || !*out.IsTruncated {
			return
		}
		continuationToken = out.NextContinuationToken
	}
}
