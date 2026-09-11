package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// Purpose-built YAML read/write for the site schema -- not a general YAML
// library. Every site file is a flat set of known scalar keys plus one
// "references" list of {type,title,url} maps, so a line-oriented
// reader/writer is enough and keeps this dependency-free. Ported from the
// PowerShell prototype (_serve.ps1) that this server replaces.

type Reference struct {
	Type        string `json:"type"`
	Title       string `json:"title"`
	Description string `json:"description"`
	URL         string `json:"url"`
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

// SiteInput mirrors Site but with pointer fields, so a PUT/POST body can
// distinguish "field omitted" (nil, leave existing value alone) from
// "field explicitly set" -- same semantics as Apply-SiteFields in the
// PowerShell version.
type SiteInput struct {
	Name          *string     `json:"name"`
	Area          *string     `json:"area"`
	Description   *string     `json:"description"`
	Hazards       *string     `json:"hazards"`
	Latitude      *float64    `json:"latitude"`
	Longitude     *float64    `json:"longitude"`
	ElevationM    *float64    `json:"elevation_m"`
	ViewLatitude  *float64    `json:"view_latitude"`
	ViewLongitude *float64    `json:"view_longitude"`
	ViewZoom      *float64    `json:"view_zoom"`
	ViewBearing   *float64    `json:"view_bearing"`
	ViewPitch     *float64    `json:"view_pitch"`
	References    []Reference `json:"references"`
}

func applySiteInput(site *Site, in SiteInput) {
	if in.Name != nil {
		site.Name = *in.Name
	}
	if in.Area != nil {
		site.Area = *in.Area
	}
	if in.Description != nil {
		site.Description = *in.Description
	}
	if in.Hazards != nil {
		site.Hazards = *in.Hazards
	}
	if in.Latitude != nil {
		site.Latitude = *in.Latitude
	}
	if in.Longitude != nil {
		site.Longitude = *in.Longitude
	}
	if in.ElevationM != nil {
		site.ElevationM = in.ElevationM
	}
	if in.ViewLatitude != nil {
		site.ViewLatitude = *in.ViewLatitude
	}
	if in.ViewLongitude != nil {
		site.ViewLongitude = *in.ViewLongitude
	}
	if in.ViewZoom != nil {
		site.ViewZoom = *in.ViewZoom
	}
	if in.ViewBearing != nil {
		site.ViewBearing = in.ViewBearing
	}
	if in.ViewPitch != nil {
		site.ViewPitch = *in.ViewPitch
	}
	if in.References != nil {
		site.References = in.References
	}
}

var (
	topLineRe = regexp.MustCompile(`^([A-Za-z_]+):\s?(.*)$`)
	refItemRe = regexp.MustCompile(`^\s*-\s*([A-Za-z_]+):\s?(.*)$`)
	refFieldRe = regexp.MustCompile(`^\s+([A-Za-z_]+):\s?(.*)$`)
)

func trimQuotes(s string) string {
	return strings.Trim(s, `"`)
}

func readSiteYaml(path, id string) (Site, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Site{}, err
	}
	site := Site{ID: id, References: []Reference{}}
	lines := strings.Split(string(data), "\n")

	mode := "top" // or "refs"
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
				key, val := m[1], trimQuotes(m[2])
				setTopField(&site, key, val)
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
	case "description":
		r.Description = val
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

var yamlSpecialLead = "-?:,[]{}#&*!|>'\"%@`"

func yamlScalar(s string) string {
	needsQuote := s == "" ||
		strings.Contains(s, ": ") ||
		strings.Contains(s, " #") ||
		strings.ContainsAny(s, "\r\n") ||
		s != strings.TrimSpace(s) ||
		(len(s) > 0 && strings.ContainsRune(yamlSpecialLead, rune(s[0])))
	if !needsQuote {
		return s
	}
	esc := strings.ReplaceAll(s, `\`, `\\`)
	esc = strings.ReplaceAll(esc, `"`, `\"`)
	esc = strings.ReplaceAll(esc, "\r\n", `\n`)
	esc = strings.ReplaceAll(esc, "\n", `\n`)
	return `"` + esc + `"`
}

func formatNum(v float64) string {
	return strconv.FormatFloat(v, 'f', -1, 64)
}

func writeSiteYaml(site Site, path string) error {
	var b strings.Builder
	b.WriteString("name: " + yamlScalar(site.Name) + "\n")
	b.WriteString("area: " + yamlScalar(site.Area) + "\n")
	b.WriteString("description: " + yamlScalar(site.Description) + "\n")
	b.WriteString("hazards: " + yamlScalar(site.Hazards) + "\n")
	b.WriteString("latitude: " + formatNum(site.Latitude) + "\n")
	b.WriteString("longitude: " + formatNum(site.Longitude) + "\n")
	if site.ElevationM != nil {
		b.WriteString("elevation_m: " + formatNum(*site.ElevationM) + "\n")
	}
	b.WriteString("view_latitude: " + formatNum(site.ViewLatitude) + "\n")
	b.WriteString("view_longitude: " + formatNum(site.ViewLongitude) + "\n")
	b.WriteString("view_zoom: " + formatNum(site.ViewZoom) + "\n")
	if site.ViewBearing != nil {
		b.WriteString("view_bearing: " + formatNum(*site.ViewBearing) + "\n")
	}
	b.WriteString("view_pitch: " + formatNum(site.ViewPitch) + "\n")
	if len(site.References) > 0 {
		b.WriteString("references:\n")
		for _, r := range site.References {
			b.WriteString("    - type: " + yamlScalar(r.Type) + "\n")
			b.WriteString("      title: " + yamlScalar(r.Title) + "\n")
			if r.Description != "" {
				b.WriteString("      description: " + yamlScalar(r.Description) + "\n")
			}
			b.WriteString("      url: " + yamlScalar(r.URL) + "\n")
		}
	}
	return os.WriteFile(path, []byte(b.String()), 0644)
}

var slugNonAlnumRe = regexp.MustCompile(`[^a-z0-9]+`)

func slugify(name string) string {
	s := slugNonAlnumRe.ReplaceAllString(strings.ToLower(name), "-")
	s = strings.Trim(s, "-")
	if s == "" {
		s = "site"
	}
	return s
}

func newUniqueSiteID(sitesDir, name string) string {
	base := slugify(name)
	id := base
	for n := 2; ; n++ {
		if _, err := os.Stat(filepath.Join(sitesDir, id+".yaml")); os.IsNotExist(err) {
			return id
		}
		id = base + "-" + strconv.Itoa(n)
	}
}

func getAllSites(sitesDir string) ([]Site, error) {
	entries, err := os.ReadDir(sitesDir)
	if err != nil {
		if os.IsNotExist(err) {
			return []Site{}, nil
		}
		return nil, err
	}
	var sites []Site
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".yaml") {
			continue
		}
		id := strings.TrimSuffix(e.Name(), ".yaml")
		site, err := readSiteYaml(filepath.Join(sitesDir, e.Name()), id)
		if err != nil {
			continue
		}
		sites = append(sites, site)
	}
	if sites == nil {
		sites = []Site{}
	}
	return sites, nil
}

var safeFileNameRe = regexp.MustCompile(`[^A-Za-z0-9._-]`)

func safeFileName(name string) string {
	base := filepath.Base(name)
	base = safeFileNameRe.ReplaceAllString(base, "_")
	if base == "" || base == "." || base == string(filepath.Separator) {
		base = "file"
	}
	return base
}
