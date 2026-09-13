// xsite-server replaces the original PowerShell prototype (_serve.ps1):
// static file serving for the MapLibre frontend, plus a small CRUD API over
// the sites/*.yaml launch-site database and their photo media.
package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"io"
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

// store is where all site data and media actually live -- see store.go.
var store SiteStore

// publisher best-effort mirrors edits into the public static-site bucket --
// see publish.go. nil (and every call on it a no-op) until R2_PUBLIC_* is
// configured.
var publisher *publicPublisher

// defaultPort respects Cloud Run's convention of injecting the port to
// listen on via $PORT (see server/Dockerfile) rather than requiring an
// explicit -port on every deploy; local dev still just gets 8933.
func defaultPort() string {
	if p := os.Getenv("PORT"); p != "" {
		return p
	}
	return "8933"
}

func main() {
	port := flag.String("port", defaultPort(), "HTTP port")
	host := flag.String("host", "127.0.0.1", "Bind address (use 0.0.0.0 to accept connections from outside localhost, e.g. from other containers)")
	root := flag.String("root", ".", "Project root to serve static files from")
	storeKind := flag.String("store", "local", "Where GET /api/sites reads from: \"local\" (sites/*.yaml under -root) or \"r2\" (see README for required R2_* environment variables)")
	flag.Parse()

	absRoot, err := filepath.Abs(*root)
	if err != nil {
		log.Fatalf("resolving root: %v", err)
	}
	sitesDir = filepath.Join(absRoot, "sites")

	switch *storeKind {
	case "local":
		store = newLocalSiteStore(sitesDir)
	case "r2":
		cfg, err := r2ConfigFromEnv()
		if err != nil {
			log.Fatalf("configuring -store=r2: %v", err)
		}
		store = newR2SiteStore(cfg)
	default:
		log.Fatalf("unknown -store %q (want \"local\" or \"r2\")", *storeKind)
	}
	publisher = newPublicPublisherFromEnv()

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
		".pdf":  "application/pdf",
		".gpx":  "application/gpx+xml",
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
	mux.HandleFunc("PUT /api/sites/{id}/media/{filename}", handleUpdateMedia)
	mux.HandleFunc("DELETE /api/sites/{id}/media/{filename}", handleDeleteMedia)
	mux.HandleFunc("GET /media/{id}/{rest...}", handleMedia)

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

	addr := *host + ":" + *port
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

func siteYamlPathIn(dir, id string) string {
	return filepath.Join(dir, id+".yaml")
}

func handleListSites(w http.ResponseWriter, r *http.Request) {
	sites, err := store.GetAllSites(r.Context())
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	sort.Slice(sites, func(i, j int) bool { return sites[i].ID < sites[j].ID })
	writeJSON(w, 200, sites)
}

func handleGetSite(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	site, err := store.GetSite(r.Context(), id)
	if err != nil {
		if errors.Is(err, ErrSiteNotFound) {
			writeError(w, 404, "not found")
			return
		}
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, site)
}

// publishAllSites refreshes the public bucket's sites.json from the current
// full site list -- a no-op if publisher isn't configured (see publish.go).
// Called after every mutation that changes what /api/sites would return,
// same set of call sites as store.SaveSite/DeleteSite below.
func publishAllSites(ctx context.Context) {
	if publisher == nil {
		return
	}
	sites, err := store.GetAllSites(ctx)
	if err != nil {
		log.Printf("[publish] refreshing sites.json: %v", err)
		return
	}
	sort.Slice(sites, func(i, j int) bool { return sites[i].ID < sites[j].ID })
	publisher.publishSites(ctx, sites)
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
	id, err := uniqueSiteID(r.Context(), store, *in.Name)
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	site := Site{ID: id, References: []Reference{}}
	applySiteInput(&site, in)
	if err := store.SaveSite(r.Context(), site); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	publishAllSites(r.Context())
	saved, _ := store.GetSite(r.Context(), id)
	writeJSON(w, 201, saved)
}

func handleUpdateSite(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	site, err := store.GetSite(r.Context(), id)
	if err != nil {
		if errors.Is(err, ErrSiteNotFound) {
			writeError(w, 404, "not found")
			return
		}
		writeError(w, 500, err.Error())
		return
	}
	var in SiteInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeError(w, 400, "invalid JSON body")
		return
	}
	applySiteInput(&site, in)
	if err := store.SaveSite(r.Context(), site); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	publishAllSites(r.Context())
	saved, _ := store.GetSite(r.Context(), id)
	writeJSON(w, 200, saved)
}

func handleDeleteSite(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, err := store.GetSite(r.Context(), id); err != nil {
		if errors.Is(err, ErrSiteNotFound) {
			writeError(w, 404, "not found")
			return
		}
		writeError(w, 500, err.Error())
		return
	}
	if err := store.DeleteSite(r.Context(), id); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	if publisher != nil {
		publisher.deleteSiteMedia(r.Context(), id)
	}
	publishAllSites(r.Context())
	writeJSON(w, 200, map[string]bool{"ok": true})
}

type mediaUploadBody struct {
	Filename    string `json:"filename"`
	DataBase64  string `json:"dataBase64"`
	Description string `json:"description"`
}

// mediaTypeForFilename classifies an uploaded file by extension into one of
// the gallery's known media kinds, so the UI can render it appropriately
// (image thumbnail vs. a named PDF/GPX link) without trusting a client-
// supplied type. The empty string means "not an accepted media type".
func mediaTypeForFilename(filename string) string {
	switch strings.ToLower(filepath.Ext(filename)) {
	case ".png", ".jpg", ".jpeg", ".gif":
		return "photo"
	case ".pdf":
		return "pdf"
	case ".gpx":
		return "gpx"
	default:
		return ""
	}
}

func handleUploadMedia(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	site, err := store.GetSite(r.Context(), id)
	if err != nil {
		if errors.Is(err, ErrSiteNotFound) {
			writeError(w, 404, "not found")
			return
		}
		writeError(w, 500, err.Error())
		return
	}
	var body mediaUploadBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, 400, "invalid JSON body")
		return
	}
	filename := safeFileName(body.Filename)
	mediaType := mediaTypeForFilename(filename)
	if mediaType == "" {
		writeError(w, 400, "unsupported file type (use PNG, JPG, PDF, or GPX)")
		return
	}
	data, err := base64.StdEncoding.DecodeString(body.DataBase64)
	if err != nil {
		writeError(w, 400, "invalid dataBase64")
		return
	}
	if err := store.SaveMedia(r.Context(), id, filename, data); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	if publisher != nil {
		publisher.publishMedia(r.Context(), id, filename, data)
	}

	newRef := Reference{
		Type:        mediaType,
		Title:       filename,
		Description: body.Description,
		URL:         "/media/" + id + "/" + filename,
	}
	// Re-uploading the same filename overwrites the file on disk above --
	// replace its reference in place too, rather than appending a second
	// entry that would now point at the new file's content.
	replaced := false
	for i := range site.References {
		if site.References[i].URL == newRef.URL {
			site.References[i] = newRef
			replaced = true
			break
		}
	}
	if !replaced {
		site.References = append(site.References, newRef)
	}
	if err := store.SaveSite(r.Context(), site); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	publishAllSites(r.Context())
	saved, _ := store.GetSite(r.Context(), id)
	writeJSON(w, 201, saved)
}

type mediaUpdateBody struct {
	Description string `json:"description"`
}

func handleUpdateMedia(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	filename := r.PathValue("filename")
	site, err := store.GetSite(r.Context(), id)
	if err != nil {
		if errors.Is(err, ErrSiteNotFound) {
			writeError(w, 404, "not found")
			return
		}
		writeError(w, 500, err.Error())
		return
	}
	var body mediaUpdateBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, 400, "invalid JSON body")
		return
	}
	found := false
	for i := range site.References {
		if strings.HasSuffix(site.References[i].URL, "/"+filename) {
			site.References[i].Description = body.Description
			found = true
		}
	}
	if !found {
		writeError(w, 404, "media not found")
		return
	}
	if err := store.SaveSite(r.Context(), site); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	publishAllSites(r.Context())
	saved, _ := store.GetSite(r.Context(), id)
	writeJSON(w, 200, saved)
}

func handleDeleteMedia(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	filename := r.PathValue("filename")
	site, err := store.GetSite(r.Context(), id)
	if err != nil {
		if errors.Is(err, ErrSiteNotFound) {
			writeError(w, 404, "not found")
			return
		}
		writeError(w, 500, err.Error())
		return
	}
	// Best-effort: if the underlying file/object is already gone, still
	// proceed to drop the reference below, matching the previous behavior
	// of ignoring os.Remove's error entirely.
	if err := store.DeleteMedia(r.Context(), id, filename); err != nil && !errors.Is(err, ErrMediaNotFound) {
		writeError(w, 500, err.Error())
		return
	}
	if publisher != nil {
		publisher.deleteMedia(r.Context(), id, filename)
	}

	kept := site.References[:0]
	for _, ref := range site.References {
		if !strings.HasSuffix(ref.URL, "/"+filename) {
			kept = append(kept, ref)
		}
	}
	site.References = kept
	if err := store.SaveSite(r.Context(), site); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	publishAllSites(r.Context())
	saved, _ := store.GetSite(r.Context(), id)
	writeJSON(w, 200, saved)
}

func handleMedia(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	filename := r.PathValue("rest")
	body, contentType, err := store.GetMedia(r.Context(), id, filename)
	if err != nil {
		if errors.Is(err, ErrMediaNotFound) {
			http.NotFound(w, r)
			return
		}
		writeError(w, 500, err.Error())
		return
	}
	defer body.Close()
	w.Header().Set("Content-Type", contentType)
	_, _ = io.Copy(w, body)
}
