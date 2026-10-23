// etl builds this app's two regenerable, offline data artifacts: the
// Vancouver Island airspace overlay and the vector-label PMTiles archive.
// Both commands are dev-time-only -- nothing here runs in production; see
// worker/ for the actual app. Merges what used to be tools/fetchairspace
// (a standalone Go program) and a separately-installed go-pmtiles CLI into
// one binary, since go-pmtiles's extract logic turned out to be an
// importable library (github.com/protomaps/go-pmtiles/pmtiles.Extract),
// not just a CLI-only feature.
//
// Usage:
//
//	etl airspace              downloads + trims OpenAIP's Canada airspace export
//	etl tiles [YYYYMMDD]      extracts the VI bbox from a Protomaps basemap build
//	                          (walks backward from today, or the given date, until
//	                          a build is found)
//	etl tiles-latest          prints the latest Protomaps build date (YYYYMMDD)
//
// Raw downloads that are worth caching land in data-sources/; final,
// checked-in-or-uploaded artifacts land in output/. Tiles has no raw
// download to cache -- Extract range-reads the remote multi-GB archive
// directly, never pulling the whole thing locally.
package main

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
)

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	// Every path below is relative to etl/, so output always lands in
	// etl/output whichever folder of the repo this is started from.
	if err := chdirToETL(); err != nil {
		log.Fatal(err)
	}
	switch os.Args[1] {
	case "airspace":
		runAirspace()
	case "tiles":
		runTiles(os.Args[2:])
	case "tiles-latest":
		runTilesLatest()
	default:
		usage()
	}
}

// chdirToETL walks up from the current folder to the repo root and moves
// into its etl/ folder.
func chdirToETL() error {
	dir, err := os.Getwd()
	if err != nil {
		return err
	}
	for {
		etl := filepath.Join(dir, "etl")
		if _, err := os.Stat(filepath.Join(etl, "go.mod")); err == nil {
			return os.Chdir(etl)
		}
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil && filepath.Base(dir) == "etl" {
			return os.Chdir(dir)
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return fmt.Errorf("run this from inside the xsites repo")
		}
		dir = parent
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: etl <airspace|tiles|tiles-latest> [args]")
	os.Exit(1)
}
