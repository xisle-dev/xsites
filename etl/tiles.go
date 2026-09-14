package main

// Extracts the Vancouver Island bounding box out of Protomaps' latest daily
// basemap build (https://maps.protomaps.com/builds/) into
// output/labels-vancouver-island.pmtiles, ready to upload to R2 (see
// worker/wrangler.toml's PUBLIC_SITE binding and worker/scripts/ for how
// the Worker serves it). Uses go-pmtiles's own Extract function directly
// (github.com/protomaps/go-pmtiles/pmtiles) -- byte-range reads against the
// remote multi-GB archive, so nothing is downloaded locally except the ~few
// hundred MB VI-sized result.
//
// Protomaps doesn't publish a build for every single calendar date (gaps of
// a day or two aren't unusual), so this walks backward from the given (or
// today's) date until it finds one that actually exists, rather than
// requiring the caller to know the exact right date up front.

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/protomaps/go-pmtiles/pmtiles"
)

// Vancouver Island proper, tight enough to keep the extract small -- unlike
// the airspace bbox above, XC-range margin doesn't matter here since this
// only draws place/road labels, not a safety-relevant overlay.
const tilesBbox = "-126.9,48.1,-122.8,50.6"

const tilesMaxLookback = 10 // days to walk backward before giving up

func protomapsBuildURL(date time.Time) string {
	return fmt.Sprintf("https://build.protomaps.com/%s.pmtiles", date.Format("20060102"))
}

func findLatestBuild(start time.Time) (time.Time, string, error) {
	for i := 0; i < tilesMaxLookback; i++ {
		date := start.AddDate(0, 0, -i)
		url := protomapsBuildURL(date)
		resp, err := http.Head(url)
		if err != nil {
			continue
		}
		resp.Body.Close()
		if resp.StatusCode == http.StatusOK {
			return date, url, nil
		}
	}
	return time.Time{}, "", fmt.Errorf("no Protomaps build found in the %d days before %s", tilesMaxLookback, start.Format("2006-01-02"))
}

func runTiles(args []string) {
	start := time.Now()
	if len(args) > 0 {
		parsed, err := time.Parse("20060102", args[0])
		if err != nil {
			log.Fatalf("invalid date %q, expected YYYYMMDD: %v", args[0], err)
		}
		start = parsed
	}

	date, buildURL, err := findLatestBuild(start)
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("using Protomaps build %s (%s)", date.Format("2006-01-02"), buildURL)

	outPath := filepath.Join("output", "labels-vancouver-island.pmtiles")
	if err := os.MkdirAll("output", 0755); err != nil {
		log.Fatal(err)
	}

	logger := log.New(os.Stderr, "", log.LstdFlags)
	ctx := context.Background()
	// bucketURL empty + key as the full URL matches how the go-pmtiles CLI
	// itself calls Extract when given a plain URL instead of a
	// bucket+relative-key pair. minzoom/maxzoom -1 means "use the archive's
	// own range"; downloadThreads/overfetch match the CLI's own defaults.
	if err := pmtiles.Extract(ctx, logger, "", buildURL, -1, -1, "", tilesBbox, outPath, 4, 0.05, false); err != nil {
		log.Fatalf("extracting tiles: %v", err)
	}
	log.Printf("wrote %s", outPath)
}
