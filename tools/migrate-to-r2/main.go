// migrate-to-r2 is a one-off tool (Phase 3 of the Cloud Run + R2 migration,
// see github issue #4) that uploads every sites/*.yaml and each site's
// media file into the R2 bucket server's -store=r2 mode reads from (see
// server/store.go). Files are copied byte-for-byte with no YAML parsing --
// the R2 key is just the file's path relative to the project root, which
// gives exactly the sites/<id>.yaml and sites/<id>/media/<filename> layout
// the R2-backed store already expects, matching the local layout with
// nothing reshaped.
package main

import (
	"bytes"
	"context"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"mime"
	"os"
	"path/filepath"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

func main() {
	root := flag.String("root", "../..", "Project root containing sites/")
	dryRun := flag.Bool("dry-run", false, "List what would be uploaded without uploading or requiring R2 credentials")
	flag.Parse()

	absRoot, err := filepath.Abs(*root)
	if err != nil {
		log.Fatalf("resolving root: %v", err)
	}
	sitesDir := filepath.Join(absRoot, "sites")

	var client *s3.Client
	var bucket string
	if !*dryRun {
		accountID := requireEnv("R2_ACCOUNT_ID")
		accessKeyID := requireEnv("R2_LIVE_ACCESS_KEY_ID")
		secretAccessKey := requireEnv("R2_LIVE_SECRET_ACCESS_KEY")
		bucket = requireEnv("R2_LIVE_BUCKET_NAME")
		client = s3.New(s3.Options{
			Region:       "auto",
			BaseEndpoint: aws.String(fmt.Sprintf("https://%s.r2.cloudflarestorage.com", accountID)),
			Credentials:  credentials.NewStaticCredentialsProvider(accessKeyID, secretAccessKey, ""),
		})
	}

	var count int
	var totalBytes int64
	err = filepath.WalkDir(sitesDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(absRoot, path)
		if err != nil {
			return err
		}
		key := filepath.ToSlash(rel)
		data, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("reading %s: %w", path, err)
		}
		count++
		totalBytes += int64(len(data))
		if *dryRun {
			fmt.Printf("would upload %s (%d bytes)\n", key, len(data))
			return nil
		}
		_, err = client.PutObject(context.Background(), &s3.PutObjectInput{
			Bucket:      aws.String(bucket),
			Key:         aws.String(key),
			Body:        bytes.NewReader(data),
			ContentType: aws.String(contentTypeForKey(key)),
		})
		if err != nil {
			return fmt.Errorf("uploading %s: %w", key, err)
		}
		fmt.Printf("uploaded %s (%d bytes)\n", key, len(data))
		return nil
	})
	if err != nil {
		log.Fatalf("migration failed: %v", err)
	}
	fmt.Printf("\n%d files, %d bytes total\n", count, totalBytes)
}

// contentTypeForKey mirrors the extension map server/main.go registers with
// the mime package, so objects uploaded here carry the same content types
// the server already serves local media as.
func contentTypeForKey(key string) string {
	switch strings.ToLower(filepath.Ext(key)) {
	case ".yaml", ".yml":
		return "application/x-yaml; charset=utf-8"
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
		if ct := mime.TypeByExtension(filepath.Ext(key)); ct != "" {
			return ct
		}
		return "application/octet-stream"
	}
}

func requireEnv(name string) string {
	v := os.Getenv(name)
	if v == "" {
		log.Fatalf("missing required environment variable %s (see server/store.go for what's expected)", name)
	}
	return v
}
