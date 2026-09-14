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
//
// Raw downloads that are worth caching land in data-sources/; final,
// checked-in-or-uploaded artifacts land in output/. Tiles has no raw
// download to cache -- Extract range-reads the remote multi-GB archive
// directly, never pulling the whole thing locally.
package main

import (
	"fmt"
	"os"
)

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	switch os.Args[1] {
	case "airspace":
		runAirspace()
	case "tiles":
		runTiles(os.Args[2:])
	default:
		usage()
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: etl <airspace|tiles> [args]")
	os.Exit(1)
}
