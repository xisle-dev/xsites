// xsite-server replaces the original PowerShell prototype (_serve.ps1):
// static file serving for the MapLibre frontend, plus a small CRUD API over
// the sites/*.yaml launch-site database and their photo media.
package main

import (
	"encoding/base64"
	"encoding/json"
	"flag"
	"log"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/protomaps/go-pmtiles/pmtiles"
)

var sitesDir string

func main() {
	port := flag.String("port", "8933", "HTTP port")
	root := flag.String("root", ".", "Project root to serve static files from")
	flag.Parse()

	absRoot, err := filepath.Abs(*root)
	if err != nil {
		log.Fatalf("resolving root: %v", err)
	}
	sitesDir = filepath.Join(absRoot, "sites")

	for ext, ct := range map[string]string{
		".html": "text/html; charset=utf-8",
		".js":   "text/javascript; charset=utf-8",
		".mjs":  "text/javascript; charset=utf-8",
		".css":  "text/css; charset=utf-8",
		".json": "application/json; charset=utf-8",
		".svg":  "image/svg+xml",
		".png":  "image/png",
		".jpg":  "image/jpeg",
		".jpeg": "image/jpeg",
		".gif":  "image/gif",
	} {
		mime.AddExtensionType(ext, ct)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/sites", handleListSites)
	mux.HandleFunc("POST /api/sites", handleCreateSite)
	mux.HandleFunc("GET /api/sites/{id}", handleGetSite)
	mux.HandleFunc("PUT /api/sites/{id}", handleUpdateSite)
	mux.HandleFunc("DELETE /api/sites/{id}", handleDeleteSite)
	mux.HandleFunc("POST /api/sites/{id}/media", handleUploadMedia)
	mux.HandleFunc("DELETE /api/sites/{id}/media/{filename}", handleDeleteMedia)
	mux.HandleFunc("GET /media/{id}/{rest...}", handleMedia(absRoot))

	// Vector label tiles (Protomaps basemap extract) -- same tile-serving
	// code as the go-pmtiles CLI's own `serve` command, embedded here so
	// one process covers static files, the sites API, and tiles instead of
	// running `go-pmtiles serve` as a second server.
	tilesDir := filepath.Join(absRoot, "tiles")
	tileServer, err := pmtiles.NewServer("", tilesDir, log.Default(), 64, "http://127.0.0.1:"+*port+"/tiles")
	if err != nil {
		log.Fatalf("starting tile server: %v", err)
	}
	tileServer.Start()
	mux.Handle("/tiles/", http.StripPrefix("/tiles", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tileServer.ServeHTTP(w, r)
	})))

	mux.Handle("/", http.FileServer(http.Dir(absRoot)))

	addr := "127.0.0.1:" + *port
	log.Printf("Serving %s on http://%s/", absRoot, addr)
	log.Fatal(http.ListenAndServe(addr, mux))
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func siteYamlPath(id string) string {
	return filepath.Join(sitesDir, id+".yaml")
}

func siteExists(id string) bool {
	_, err := os.Stat(siteYamlPath(id))
	return err == nil
}

func handleListSites(w http.ResponseWriter, r *http.Request) {
	sites, err := getAllSites(sitesDir)
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	sort.Slice(sites, func(i, j int) bool { return sites[i].ID < sites[j].ID })
	writeJSON(w, 200, sites)
}

func handleGetSite(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !siteExists(id) {
		writeError(w, 404, "not found")
		return
	}
	site, err := readSiteYaml(siteYamlPath(id), id)
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, site)
}

func handleCreateSite(w http.ResponseWriter, r *http.Request) {
	var in SiteInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeError(w, 400, "invalid JSON body")
		return
	}
	if in.Name == nil || strings.TrimSpace(*in.Name) == "" {
		writeError(w, 400, "name is required")
		return
	}
	id := newUniqueSiteID(sitesDir, *in.Name)
	site := Site{ID: id, References: []Reference{}}
	applySiteInput(&site, in)
	if err := writeSiteYaml(site, siteYamlPath(id)); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	saved, _ := readSiteYaml(siteYamlPath(id), id)
	writeJSON(w, 201, saved)
}

func handleUpdateSite(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !siteExists(id) {
		writeError(w, 404, "not found")
		return
	}
	site, err := readSiteYaml(siteYamlPath(id), id)
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	var in SiteInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeError(w, 400, "invalid JSON body")
		return
	}
	applySiteInput(&site, in)
	if err := writeSiteYaml(site, siteYamlPath(id)); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	saved, _ := readSiteYaml(siteYamlPath(id), id)
	writeJSON(w, 200, saved)
}

func handleDeleteSite(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !siteExists(id) {
		writeError(w, 404, "not found")
		return
	}
	if err := os.Remove(siteYamlPath(id)); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	_ = os.RemoveAll(filepath.Join(sitesDir, id))
	writeJSON(w, 200, map[string]bool{"ok": true})
}

type mediaUploadBody struct {
	Filename   string `json:"filename"`
	DataBase64 string `json:"dataBase64"`
}

func handleUploadMedia(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !siteExists(id) {
		writeError(w, 404, "not found")
		return
	}
	var body mediaUploadBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, 400, "invalid JSON body")
		return
	}
	data, err := base64.StdEncoding.DecodeString(body.DataBase64)
	if err != nil {
		writeError(w, 400, "invalid dataBase64")
		return
	}
	filename := safeFileName(body.Filename)
	mediaDir := filepath.Join(sitesDir, id, "media")
	if err := os.MkdirAll(mediaDir, 0755); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	if err := os.WriteFile(filepath.Join(mediaDir, filename), data, 0644); err != nil {
		writeError(w, 500, err.Error())
		return
	}

	site, err := readSiteYaml(siteYamlPath(id), id)
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	site.References = append(site.References, Reference{
		Type:  "photo",
		Title: filename,
		URL:   "/media/" + id + "/" + filename,
	})
	if err := writeSiteYaml(site, siteYamlPath(id)); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	saved, _ := readSiteYaml(siteYamlPath(id), id)
	writeJSON(w, 201, saved)
}

func handleDeleteMedia(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	filename := r.PathValue("filename")
	if !siteExists(id) {
		writeError(w, 404, "not found")
		return
	}
	mediaPath := filepath.Join(sitesDir, id, "media", filepath.Base(filename))
	_ = os.Remove(mediaPath)

	site, err := readSiteYaml(siteYamlPath(id), id)
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	kept := site.References[:0]
	for _, ref := range site.References {
		if !strings.HasSuffix(ref.URL, "/"+filename) {
			kept = append(kept, ref)
		}
	}
	site.References = kept
	if err := writeSiteYaml(site, siteYamlPath(id)); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	saved, _ := readSiteYaml(siteYamlPath(id), id)
	writeJSON(w, 200, saved)
}

func handleMedia(root string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		rest := r.PathValue("rest")
		mediaDir := filepath.Join(root, "sites", id, "media")
		full := filepath.Join(mediaDir, filepath.FromSlash(rest))
		// filepath.Join cleans ".." segments lexically, so guard against the
		// result escaping mediaDir (id/rest both come straight from the URL).
		if full != mediaDir && !strings.HasPrefix(full, mediaDir+string(filepath.Separator)) {
			http.NotFound(w, r)
			return
		}
		http.ServeFile(w, r, full)
	}
}
