// dev runs X/Sites locally for development -- no Node, no Cloudflare:
//
//	cd dev
//	go run .
//
// then open http://localhost:8787 (viewer) and /admin (editor, no password).
//
//   - Web files are served straight from server/public, and every open page
//     reloads itself when one of them changes.
//   - Site data lives in dev/data/ with the same layout as an R2 bucket
//     (sites/<id>.yaml, sites/<id>/media/<file>, sites.json). On first run
//     it's filled from the repo's "backup" branch (a copy of PROD); delete
//     dev/data/ to start over. Edits made in /admin stay local.
//   - Label tiles and the airspace overlay come straight from etl/output
//     (labels-vancouver-island.pmtiles, airspace.geojson), the files
//     `cd etl && go run . tiles` and `go run . airspace` write. QA and PROD
//     serve the same two files from their R2 bucket.
//
// The API here is a Go stand-in for the Worker in server/src (index.ts,
// store.ts, publish.ts, siteyaml.ts). When the Worker's routes or the site
// format change, change this to match.
package main

import (
	"archive/zip"
	"bytes"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func main() {
	addr := flag.String("addr", "localhost:8787", "listen address")
	flag.Parse()
	log.SetFlags(log.Ltime)

	root, err := repoRoot()
	if err != nil {
		log.Fatal(err)
	}
	public := filepath.Join(root, "server", "public")
	data := filepath.Join(root, "dev", "data")
	tiles := filepath.Join(root, "etl", "output")

	if err := seed(root, data); err != nil {
		log.Printf("WARNING: %v -- starting with no sites", err)
	}
	if _, err := os.Stat(filepath.Join(tiles, "labels-vancouver-island.pmtiles")); err != nil {
		log.Print("WARNING: no label tiles yet; build them with: cd etl && go run . tiles")
	}
	airspace := filepath.Join(tiles, "airspace.geojson")
	if _, err := os.Stat(airspace); err != nil {
		log.Print("WARNING: no airspace yet; build it with: cd etl && go run . airspace")
	}

	reload := newReloader(public)
	api := &api{store: &dirStore{root: data}}
	tileServer, err := newTileServer(tiles)
	if err != nil {
		log.Fatal(err)
	}

	mux := http.NewServeMux()
	mux.Handle("/__dev/reload", reload)
	mux.Handle("/tiles/", http.StripPrefix("/tiles", tileServer))
	mux.HandleFunc("/data/airspace.geojson", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/geo+json")
		http.ServeFile(w, r, airspace)
	})
	mux.HandleFunc("/sites.json", api.listSites)
	mux.Handle("/api/", api)
	mux.HandleFunc("/media/", api.getMedia)
	mux.Handle("/", static(public))

	log.Printf("X/Sites DEV on http://%s  (editor: http://%s/admin/)", *addr, *addr)
	log.Fatal(http.ListenAndServe(*addr, logRequests(mux)))
}

// repoRoot finds the repo from wherever `go run` was started inside it.
func repoRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "server", "public", "index.html")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("run this from inside the xsites repo")
		}
		dir = parent
	}
}

// seed fills an empty data dir from the "backup" branch's data/ folder.
func seed(root, data string) error {
	if entries, err := os.ReadDir(filepath.Join(data, "sites")); err == nil && len(entries) > 0 {
		return nil
	}
	log.Print("dev/data is empty; copying sites from the backup branch")
	git := func(args ...string) ([]byte, error) {
		cmd := exec.Command("git", args...)
		cmd.Dir = root
		cmd.Stderr = os.Stderr
		return cmd.Output()
	}
	if _, err := git("fetch", "--depth=1", "origin", "backup"); err != nil {
		return fmt.Errorf("fetching the backup branch: %v", err)
	}
	archive, err := git("archive", "--format=zip", "FETCH_HEAD", "data")
	if err != nil {
		return fmt.Errorf("reading the backup branch: %v", err)
	}
	zr, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		return err
	}
	n := 0
	for _, f := range zr.File {
		rel, ok := strings.CutPrefix(f.Name, "data/")
		if !ok || f.FileInfo().IsDir() || !fs.ValidPath(rel) {
			continue
		}
		dst := filepath.Join(data, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		b, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			return err
		}
		if err := os.WriteFile(dst, b, 0o644); err != nil {
			return err
		}
		n++
	}
	log.Printf("copied %d files into dev/data", n)
	return nil
}

func logRequests(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/tiles/") && r.URL.Path != "/__dev/reload" {
			log.Printf("%s %s", r.Method, r.URL.Path)
		}
		h.ServeHTTP(w, r)
	})
}
