package main

// The site API, a stand-in for server/src/index.ts, store.ts and
// publish.ts against a local folder instead of R2. Same routes, same
// request/response shapes, same keys on disk. No auth: DEV only listens on
// localhost.

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"

	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/protomaps/go-pmtiles/pmtiles"
)

// dirStore keeps "bucket" keys as files under root.
type dirStore struct {
	mu   sync.Mutex // one write at a time, like the Worker's awaited writes
	root string
}

func (d *dirStore) path(key string) string { return filepath.Join(d.root, filepath.FromSlash(key)) }

func (d *dirStore) get(key string) ([]byte, error) { return os.ReadFile(d.path(key)) }

func (d *dirStore) put(key string, b []byte) error {
	if err := os.MkdirAll(filepath.Dir(d.path(key)), 0o755); err != nil {
		return err
	}
	return os.WriteFile(d.path(key), b, 0o644)
}

func (d *dirStore) exists(key string) bool {
	_, err := os.Stat(d.path(key))
	return err == nil
}

func isFlat(s string) bool { return s != "" && s != "." && s != ".." && !strings.ContainsAny(s, `/\`) }

func siteKey(id string) string        { return "sites/" + id + ".yaml" }
func mediaKey(id, file string) string { return "sites/" + id + "/media/" + file }

var errNotFound = errors.New("not found")

func (d *dirStore) getSite(id string) (Site, error) {
	if !isFlat(id) {
		return Site{}, errNotFound
	}
	b, err := d.get(siteKey(id))
	if err != nil {
		return Site{}, errNotFound
	}
	return parseSiteYAML(string(b), id), nil
}

func (d *dirStore) allSites() []Site {
	entries, _ := os.ReadDir(filepath.Join(d.root, "sites"))
	sites := []Site{}
	for _, e := range entries {
		if id, ok := strings.CutSuffix(e.Name(), ".yaml"); ok && !e.IsDir() {
			if s, err := d.getSite(id); err == nil {
				sites = append(sites, s)
			}
		}
	}
	sort.Slice(sites, func(i, j int) bool { return sites[i].ID < sites[j].ID })
	return sites
}

// saveSite writes the YAML and rebuilds sites.json. The Worker patches
// sites.json in place for speed; locally a rebuild is instant and can't
// drift.
func (d *dirStore) saveSite(s Site) error {
	if err := d.put(siteKey(s.ID), []byte(renderSiteYAML(s))); err != nil {
		return err
	}
	return d.publish()
}

func (d *dirStore) publish() error {
	b, err := json.Marshal(d.allSites())
	if err != nil {
		return err
	}
	return d.put("sites.json", b)
}

type api struct{ store *dirStore }

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// listSites serves sites.json, rebuilding it if it's missing.
func (a *api) listSites(w http.ResponseWriter, r *http.Request) {
	a.store.mu.Lock()
	defer a.store.mu.Unlock()
	b, err := a.store.get("sites.json")
	if err != nil {
		if err := a.store.publish(); err != nil {
			writeError(w, 500, err.Error())
			return
		}
		b, _ = a.store.get("sites.json")
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Write(b)
}

func (a *api) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	seg := strings.Split(strings.Trim(r.URL.Path, "/"), "/") // api, sites, ...
	if len(seg) < 2 || seg[1] != "sites" {
		http.NotFound(w, r)
		return
	}
	if len(seg) == 2 && r.Method == http.MethodGet {
		a.listSites(w, r)
		return
	}
	a.store.mu.Lock()
	defer a.store.mu.Unlock()
	switch {
	case len(seg) == 2 && r.Method == http.MethodPost:
		a.createSite(w, r)
	case len(seg) == 3 && r.Method == http.MethodGet:
		a.withSite(w, seg[2], func(s Site) { writeJSON(w, 200, s) })
	case len(seg) == 3 && r.Method == http.MethodPut:
		a.withSite(w, seg[2], func(s Site) { a.updateSite(w, r, s) })
	case len(seg) == 3 && r.Method == http.MethodDelete:
		a.withSite(w, seg[2], func(s Site) { a.deleteSite(w, s) })
	case len(seg) == 4 && seg[3] == "media" && r.Method == http.MethodPost:
		a.withSite(w, seg[2], func(s Site) { a.uploadMedia(w, r, s) })
	case len(seg) == 5 && seg[3] == "media" && r.Method == http.MethodPut:
		a.withSite(w, seg[2], func(s Site) { a.updateMedia(w, r, s, seg[4]) })
	case len(seg) == 5 && seg[3] == "media" && r.Method == http.MethodDelete:
		a.withSite(w, seg[2], func(s Site) { a.deleteMedia(w, s, seg[4]) })
	default:
		http.NotFound(w, r)
	}
}

func (a *api) withSite(w http.ResponseWriter, id string, fn func(Site)) {
	s, err := a.store.getSite(id)
	if err != nil {
		writeError(w, 404, "not found")
		return
	}
	fn(s)
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		writeError(w, 400, "invalid JSON body")
		return false
	}
	return true
}

func (a *api) save(w http.ResponseWriter, status int, s Site) {
	if err := a.store.saveSite(s); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, status, s)
}

func (a *api) createSite(w http.ResponseWriter, r *http.Request) {
	var in SiteInput
	if !decode(w, r, &in) {
		return
	}
	if in.Name == nil || strings.TrimSpace(*in.Name) == "" {
		writeError(w, 400, "name is required")
		return
	}
	base := slugify(*in.Name)
	id := base
	for n := 2; a.store.exists(siteKey(id)); n++ {
		id = fmt.Sprintf("%s-%d", base, n)
	}
	s := Site{ID: id, References: []Reference{}}
	s.apply(in)
	a.save(w, 201, s)
}

func (a *api) updateSite(w http.ResponseWriter, r *http.Request, s Site) {
	var in SiteInput
	if !decode(w, r, &in) {
		return
	}
	s.apply(in)
	a.save(w, 200, s)
}

func (a *api) deleteSite(w http.ResponseWriter, s Site) {
	os.Remove(a.store.path(siteKey(s.ID)))
	os.RemoveAll(a.store.path("sites/" + s.ID))
	if err := a.store.publish(); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func mediaType(filename string) string {
	switch strings.ToLower(filename[strings.LastIndex(filename, ".")+1:]) {
	case "png", "jpg", "jpeg", "gif":
		return "photo"
	case "pdf":
		return "pdf"
	case "gpx":
		return "gpx"
	}
	return ""
}

func (a *api) uploadMedia(w http.ResponseWriter, r *http.Request, s Site) {
	var body struct {
		Filename    string `json:"filename"`
		DataBase64  string `json:"dataBase64"`
		Description string `json:"description"`
	}
	if !decode(w, r, &body) {
		return
	}
	filename := safeFileName(body.Filename)
	kind := mediaType(filename)
	if kind == "" {
		writeError(w, 400, "unsupported file type (use PNG, JPG, PDF, or GPX)")
		return
	}
	data, err := base64.StdEncoding.DecodeString(body.DataBase64)
	if err != nil {
		writeError(w, 400, "invalid dataBase64")
		return
	}
	if err := a.store.put(mediaKey(s.ID, filename), data); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	ref := Reference{Type: kind, Title: filename, Description: body.Description, URL: "/media/" + s.ID + "/" + filename}
	replaced := false
	for i := range s.References {
		if s.References[i].URL == ref.URL {
			s.References[i], replaced = ref, true
		}
	}
	if !replaced {
		s.References = append(s.References, ref)
	}
	a.save(w, 201, s)
}

func (a *api) updateMedia(w http.ResponseWriter, r *http.Request, s Site, filename string) {
	var body struct {
		Description string `json:"description"`
	}
	if !decode(w, r, &body) {
		return
	}
	found := false
	for i := range s.References {
		if strings.HasSuffix(s.References[i].URL, "/"+filename) {
			s.References[i].Description, found = body.Description, true
		}
	}
	if !found {
		writeError(w, 404, "media not found")
		return
	}
	a.save(w, 200, s)
}

func (a *api) deleteMedia(w http.ResponseWriter, s Site, filename string) {
	if isFlat(filename) {
		os.Remove(a.store.path(mediaKey(s.ID, filename)))
	}
	refs := s.References[:0]
	for _, ref := range s.References {
		if !strings.HasSuffix(ref.URL, "/"+filename) {
			refs = append(refs, ref)
		}
	}
	s.References = refs
	a.save(w, 200, s)
}

// getMedia serves GET /media/<id>/<file>.
func (a *api) getMedia(w http.ResponseWriter, r *http.Request) {
	seg := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(seg) != 3 || !isFlat(seg[1]) || !isFlat(seg[2]) || r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}
	http.ServeFile(w, r, a.store.path(mediaKey(seg[1], seg[2])))
}

// newTileServer serves /tiles/<archive>/<z>/<x>/<y>.mvt from the .pmtiles
// files in dir, as the Worker does from R2's tiles/ folder.
func newTileServer(dir string) (http.Handler, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	server, err := pmtiles.NewServerWithBucket(pmtiles.NewFileBucket(dir), "", log.New(discard{}, "", 0), 64, "")
	if err != nil {
		return nil, err
	}
	server.Start()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { server.ServeHTTP(w, r) }), nil
}

// discard drops the tile server's per-request logging.
type discard struct{}

func (discard) Write(p []byte) (int, error) { return len(p), nil }
