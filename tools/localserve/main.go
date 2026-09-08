// localserve is a throwaway static file server for testing the static/R2
// build locally. http.FileServer supports Range requests natively (Python's
// http.server does not), which matters here since PMTiles reads its archive
// via range reads -- this is the only way to catch that class of bug before
// it hits production.
package main

import (
	"flag"
	"log"
	"net/http"
)

func main() {
	dir := flag.String("dir", "dist", "directory to serve")
	port := flag.String("port", "8934", "port to listen on")
	flag.Parse()

	log.Printf("serving %s on :%s", *dir, *port)
	log.Fatal(http.ListenAndServe(":"+*port, http.FileServer(http.Dir(*dir))))
}
