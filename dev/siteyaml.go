package main

// Go port of server/src/siteyaml.ts -- the flat-scalar site YAML dialect,
// not general YAML. Keep the two in step: DEV reads and writes the same
// files QA and PROD do, so any format change must land in both.

import (
	"regexp"
	"strconv"
	"strings"
)

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

// SiteInput is a PUT/POST body: nil means "leave the field alone".
type SiteInput struct {
	Name          *string      `json:"name"`
	Area          *string      `json:"area"`
	Description   *string      `json:"description"`
	Hazards       *string      `json:"hazards"`
	Latitude      *float64     `json:"latitude"`
	Longitude     *float64     `json:"longitude"`
	ElevationM    *float64     `json:"elevation_m"`
	ViewLatitude  *float64     `json:"view_latitude"`
	ViewLongitude *float64     `json:"view_longitude"`
	ViewZoom      *float64     `json:"view_zoom"`
	ViewBearing   *float64     `json:"view_bearing"`
	ViewPitch     *float64     `json:"view_pitch"`
	References    *[]Reference `json:"references"`
}

func (s *Site) apply(in SiteInput) {
	setS := func(dst *string, v *string) {
		if v != nil {
			*dst = *v
		}
	}
	setF := func(dst *float64, v *float64) {
		if v != nil {
			*dst = *v
		}
	}
	setS(&s.Name, in.Name)
	setS(&s.Area, in.Area)
	setS(&s.Description, in.Description)
	setS(&s.Hazards, in.Hazards)
	setF(&s.Latitude, in.Latitude)
	setF(&s.Longitude, in.Longitude)
	if in.ElevationM != nil {
		s.ElevationM = in.ElevationM
	}
	setF(&s.ViewLatitude, in.ViewLatitude)
	setF(&s.ViewLongitude, in.ViewLongitude)
	setF(&s.ViewZoom, in.ViewZoom)
	if in.ViewBearing != nil {
		s.ViewBearing = in.ViewBearing
	}
	setF(&s.ViewPitch, in.ViewPitch)
	if in.References != nil {
		s.References = *in.References
	}
}

var (
	topLineRe  = regexp.MustCompile(`^([A-Za-z_]+):\s?(.*)$`)
	refItemRe  = regexp.MustCompile(`^\s*-\s*([A-Za-z_]+):\s?(.*)$`)
	refFieldRe = regexp.MustCompile(`^\s+([A-Za-z_]+):\s?(.*)$`)
)

func parseSiteYAML(data, id string) Site {
	site := Site{ID: id, References: []Reference{}}
	inRefs := false
	var cur *Reference
	flush := func() {
		if cur != nil {
			site.References = append(site.References, *cur)
			cur = nil
		}
	}
	setRef := func(r *Reference, key, val string) {
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
	num := func(val string, dst *float64) {
		if f, err := strconv.ParseFloat(strings.TrimSpace(val), 64); err == nil {
			*dst = f
		} else {
			*dst = 0
		}
	}
	optNum := func(val string) *float64 {
		if f, err := strconv.ParseFloat(strings.TrimSpace(val), 64); err == nil {
			return &f
		}
		return nil
	}
	setTop := func(key, val string) {
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
			num(val, &site.Latitude)
		case "longitude":
			num(val, &site.Longitude)
		case "elevation_m":
			if f := optNum(val); f != nil {
				site.ElevationM = f
			}
		case "view_latitude":
			num(val, &site.ViewLatitude)
		case "view_longitude":
			num(val, &site.ViewLongitude)
		case "view_zoom":
			num(val, &site.ViewZoom)
		case "view_bearing":
			if f := optNum(val); f != nil {
				site.ViewBearing = f
			}
		case "view_pitch":
			num(val, &site.ViewPitch)
		}
	}
	trim := func(s string) string { return strings.Trim(s, `"`) }

	for _, raw := range strings.Split(data, "\n") {
		line := strings.TrimSuffix(raw, "\r")
		if strings.TrimSpace(line) == "" {
			continue
		}
		if !inRefs && line == "references:" {
			inRefs = true
			continue
		}
		if inRefs {
			if m := refItemRe.FindStringSubmatch(line); m != nil {
				flush()
				cur = &Reference{}
				setRef(cur, m[1], trim(m[2]))
				continue
			}
			if m := refFieldRe.FindStringSubmatch(line); m != nil && cur != nil {
				setRef(cur, m[1], trim(m[2]))
				continue
			}
			inRefs = false
		}
		if m := topLineRe.FindStringSubmatch(line); m != nil {
			setTop(m[1], trim(m[2]))
		}
	}
	flush()
	return site
}

const yamlSpecialLead = "-?:,[]{}#&*!|>'\"%@`"

func yamlScalar(s string) string {
	needsQuote := s == "" ||
		strings.Contains(s, ": ") ||
		strings.Contains(s, " #") ||
		strings.ContainsAny(s, "\r\n") ||
		s != strings.TrimSpace(s) ||
		strings.ContainsRune(yamlSpecialLead, rune(s[0]))
	if !needsQuote {
		return s
	}
	esc := strings.ReplaceAll(s, `\`, `\\`)
	esc = strings.ReplaceAll(esc, `"`, `\"`)
	esc = strings.ReplaceAll(esc, "\r\n", `\n`)
	esc = strings.ReplaceAll(esc, "\n", `\n`)
	return `"` + esc + `"`
}

func formatNum(v float64) string { return strconv.FormatFloat(v, 'f', -1, 64) }

func renderSiteYAML(s Site) string {
	var b strings.Builder
	w := func(k, v string) { b.WriteString(k + ": " + v + "\n") }
	w("name", yamlScalar(s.Name))
	w("area", yamlScalar(s.Area))
	w("description", yamlScalar(s.Description))
	w("hazards", yamlScalar(s.Hazards))
	w("latitude", formatNum(s.Latitude))
	w("longitude", formatNum(s.Longitude))
	if s.ElevationM != nil {
		w("elevation_m", formatNum(*s.ElevationM))
	}
	w("view_latitude", formatNum(s.ViewLatitude))
	w("view_longitude", formatNum(s.ViewLongitude))
	w("view_zoom", formatNum(s.ViewZoom))
	if s.ViewBearing != nil {
		w("view_bearing", formatNum(*s.ViewBearing))
	}
	w("view_pitch", formatNum(s.ViewPitch))
	if len(s.References) > 0 {
		b.WriteString("references:\n")
		for _, r := range s.References {
			b.WriteString("    - type: " + yamlScalar(r.Type) + "\n")
			b.WriteString("      title: " + yamlScalar(r.Title) + "\n")
			if r.Description != "" {
				b.WriteString("      description: " + yamlScalar(r.Description) + "\n")
			}
			b.WriteString("      url: " + yamlScalar(r.URL) + "\n")
		}
	}
	return b.String()
}

var nonSlug = regexp.MustCompile(`[^a-z0-9]+`)

func slugify(name string) string {
	s := strings.Trim(nonSlug.ReplaceAllString(strings.ToLower(name), "-"), "-")
	if s == "" {
		return "site"
	}
	return s
}

var unsafeFileChars = regexp.MustCompile(`[^A-Za-z0-9._-]`)

func safeFileName(name string) string {
	s := unsafeFileChars.ReplaceAllString(name[strings.LastIndexAny(name, `/\`)+1:], "_")
	if s == "" || s == "." {
		return "file"
	}
	return s
}
