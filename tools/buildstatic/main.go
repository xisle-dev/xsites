// buildstatic assembles the read-only static deployment: sites/*.yaml -> a
// single sites.json, site media copied alongside, and the hand-authored
// static/ viewer files (index.html, app.js) plus the shared assets
// (style.css, favicon.svg, logo.svg) copied in verbatim. The output directory
// is a complete, self-contained static site ready to sync to R2 -- nothing
// in it depends on the Go server.
//
// This intentionally re-implements (rather than imports) the read side of
// server/siteyaml.go: the two binaries are deployed independently, and
// duplicating ~80 lines of stable parsing logic is a smaller risk than
// coupling this tool's build to the live server's package layout.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

type Reference struct {
	Type  string `json:"type"`
	Title string `json:"title"`
	URL   string `json:"url"`
}

type Site struct {
	ID            string      `json:"id"`
	Name          string      `json:"name"`
	Area          string      `json:"area"`
	Description   string      `json:"description"`
	Hazards       string      `json:"hazards"`
	Latitude      float64     `json:"latitude"`
	Longitude     float64     `json:"longitude"`
	ElevationM    *float64    `json:"elevation_m,omitempty"`
	ViewLatitude  float64     `json:"view_latitude"`
	ViewLongitude float64     `json:"view_longitude"`
	ViewZoom      float64     `json:"view_zoom"`
	ViewBearing   *float64    `json:"view_bearing,omitempty"`
	ViewPitch     float64     `json:"view_pitch"`
	References    []Reference `json:"references"`
}

var (
	topLineRe = regexp.MustCompile(`^([A-Za-z_]+):\s?(.*)$`)
	refItemRe = regexp.MustCompile(`^\s*-\s*([A-Za-z_]+):\s?(.*)$`)
	refFieldRe = regexp.MustCompile(`^\s+([A-Za-z_]+):\s?(.*)$`)
)

func trimQuotes(s string) string { return strings.Trim(s, `"`) }

func readSiteYaml(path, id string) (Site, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Site{}, err
	}
	site := Site{ID: id, References: []Reference{}}
	lines := strings.Split(string(data), "\n")
	mode := "top"
	var current *Reference
	flush := func() {
		if current != nil {
			site.References = append(site.References, *current)
			current = nil
		}
	}
	for _, raw := range lines {
		line := strings.TrimRight(raw, "\r")
		if strings.TrimSpace(line) == "" {
			continue
		}
		if mode == "top" && line == "references:" {
			mode = "refs"
			continue
		}
		if mode == "refs" {
			if m := refItemRe.FindStringSubmatch(line); m != nil {
				flush()
				current = &Reference{}
				setRefField(current, m[1], trimQuotes(m[2]))
				continue
			}
			if m := refFieldRe.FindStringSubmatch(line); m != nil && current != nil {
				setRefField(current, m[1], trimQuotes(m[2]))
				continue
			}
			mode = "top"
		}
		if mode == "top" {
			if m := topLineRe.FindStringSubmatch(line); m != nil {
				setTopField(&site, m[1], trimQuotes(m[2]))
			}
		}
	}
	flush()
	return site, nil
}

func setRefField(r *Reference, key, val string) {
	switch key {
	case "type":
		r.Type = val
	case "title":
		r.Title = val
	case "url":
		r.URL = val
	}
}

func setTopField(site *Site, key, val string) {
	switch key {
	case "name":
		site.Name = val
	case "area":
		site.Area = val
	case "description":
		site.Description = val
	case "hazards":
		site.Hazards = val
	case "latitude":
		site.Latitude, _ = strconv.ParseFloat(val, 64)
	case "longitude":
		site.Longitude, _ = strconv.ParseFloat(val, 64)
	case "elevation_m":
		if f, err := strconv.ParseFloat(val, 64); err == nil {
			site.ElevationM = &f
		}
	case "view_latitude":
		site.ViewLatitude, _ = strconv.ParseFloat(val, 64)
	case "view_longitude":
		site.ViewLongitude, _ = strconv.ParseFloat(val, 64)
	case "view_zoom":
		site.ViewZoom, _ = strconv.ParseFloat(val, 64)
	case "view_bearing":
		if f, err := strconv.ParseFloat(val, 64); err == nil {
			site.ViewBearing = &f
		}
	case "view_pitch":
		site.ViewPitch, _ = strconv.ParseFloat(val, 64)
	}
}

func getAllSites(sitesDir string) ([]Site, error) {
	entries, err := os.ReadDir(sitesDir)
	if err != nil {
		return nil, err
	}
	sites := []Site{}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".yaml") {
			continue
		}
		id := strings.TrimSuffix(e.Name(), ".yaml")
		site, err := readSiteYaml(filepath.Join(sitesDir, e.Name()), id)
		if err != nil {
			return nil, fmt.Errorf("reading %s: %w", e.Name(), err)
		}
		sites = append(sites, site)
	}
	return sites, nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
		return err
	}
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}

// copyMedia copies sites/<id>/media/* -> outDir/media/<id>/* for every site
// that has a media folder, matching the /media/<id>/<filename> URL scheme
// already stored in each site's references.
func copyMedia(root, outDir string, sites []Site) error {
	for _, s := range sites {
		mediaDir := filepath.Join(root, "sites", s.ID, "media")
		entries, err := os.ReadDir(mediaDir)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return err
		}
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			src := filepath.Join(mediaDir, e.Name())
			dst := filepath.Join(outDir, "media", s.ID, e.Name())
			if err := copyFile(src, dst); err != nil {
				return err
			}
		}
	}
	return nil
}

func main() {
	root := "."
	out := "dist"
	if len(os.Args) > 1 {
		root = os.Args[1]
	}
	if len(os.Args) > 2 {
		out = os.Args[2]
	}

	root, err := filepath.Abs(root)
	if err != nil {
		log.Fatal(err)
	}
	out, err = filepath.Abs(out)
	if err != nil {
		log.Fatal(err)
	}

	sites, err := getAllSites(filepath.Join(root, "sites"))
	if err != nil {
		log.Fatalf("reading sites: %v", err)
	}
	log.Printf("read %d sites", len(sites))

	if err := os.MkdirAll(out, 0755); err != nil {
		log.Fatal(err)
	}

	sitesJSON, err := json.Marshal(sites)
	if err != nil {
		log.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(out, "sites.json"), sitesJSON, 0644); err != nil {
		log.Fatal(err)
	}
	log.Printf("wrote sites.json (%d bytes)", len(sitesJSON))

	if err := copyMedia(root, out, sites); err != nil {
		log.Fatalf("copying media: %v", err)
	}

	// Hand-authored viewer files (structurally different from the dynamic
	// app) plus shared assets that are identical between both modes.
	copies := map[string]string{
		filepath.Join(root, "static", "index.html"):     filepath.Join(out, "index.html"),
		filepath.Join(root, "static", "app.js"):          filepath.Join(out, "app.js"),
		filepath.Join(root, "style.css"):                  filepath.Join(out, "style.css"),
		filepath.Join(root, "favicon.svg"):                filepath.Join(out, "favicon.svg"),
		filepath.Join(root, "logo.svg"):                    filepath.Join(out, "logo.svg"),
		filepath.Join(root, "data", "airspace.geojson"):    filepath.Join(out, "data", "airspace.geojson"),
	}
	for src, dst := range copies {
		if err := copyFile(src, dst); err != nil {
			log.Fatalf("copying %s: %v", src, err)
		}
	}

	log.Printf("static build written to %s", out)
}
