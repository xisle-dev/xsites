// fetchairspace downloads Canada's airspace dataset from OpenAIP's public,
// anonymous export bucket (CC BY-NC 4.0 -- see https://www.openaip.net,
// attribution required), keeps only the polygons that overlap the Vancouver
// Island flying area, and writes a trimmed data/airspace.geojson checked
// into the repo. Re-run this by hand occasionally to pick up NAV CANADA
// airspace revisions -- it's not part of the automated build since airspace
// boundaries change on the order of months, not every push.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
)

const sourceURL = "https://storage.openaip.net/openaip-system-exports/ca_asp.geojson"

// Vancouver Island plus a margin covering the southern Gulf Islands and the
// nearby mainland coast (XC flights routinely range beyond the launch pin).
const (
	minLon = -127.2
	minLat = 47.7
	maxLon = -122.4
	maxLat = 51.0
)

type rawFeature struct {
	Type       string          `json:"type"`
	Properties rawProperties   `json:"properties"`
	Geometry   json.RawMessage `json:"geometry"`
}

type rawProperties struct {
	Name       string `json:"name"`
	IcaoClass  int    `json:"icaoClass"`
	UpperLimit rawAlt `json:"upperLimit"`
	LowerLimit rawAlt `json:"lowerLimit"`
}

type rawAlt struct {
	Value           float64 `json:"value"`
	Unit            int     `json:"unit"`
	ReferenceDatum  int     `json:"referenceDatum"`
}

type rawCollection struct {
	Type     string       `json:"type"`
	Features []rawFeature `json:"features"`
}

type outFeature struct {
	Type       string          `json:"type"`
	Properties outProperties   `json:"properties"`
	Geometry   json.RawMessage `json:"geometry"`
}

type outProperties struct {
	Name    string `json:"name"`
	Class   string `json:"class"`
	Floor   string `json:"floor"`
	Ceiling string `json:"ceiling"`
	// Numeric limits in meters, used to extrude the single highlighted
	// airspace into a real 3D volume (see setAirspaceHighlight in app.js).
	// Datum is "GND" (already ground-relative -- use directly as extrusion
	// base/height) or "MSL" (sea-level-referenced -- the client subtracts
	// local terrain elevation at render time, since fill-extrusion's
	// base/height are ground-relative once terrain is on). Flight levels
	// are converted to an approximate MSL feet equivalent (standard-
	// atmosphere assumption -- fine for this non-navigational visual).
	FloorM       float64 `json:"floorM"`
	FloorDatum   string  `json:"floorDatum"`
	CeilingM     float64 `json:"ceilingM"`
	CeilingDatum string  `json:"ceilingDatum"`
}

type outCollection struct {
	Type       string          `json:"type"`
	Attributes map[string]any  `json:"attribution"`
	Features   []outFeature    `json:"features"`
}

// icaoClass values empirically confirmed against known BC airspace (e.g.
// Vancouver TCA -> 2/C, Comox CZ -> 3/D, Nanaimo CZ -> 4/E, CYR restricted
// areas -> 8). OpenAIP's public schema docs don't spell this out; see the
// Google Group thread linked from their docs page for others hitting the
// same gap.
func classLabel(c int) string {
	switch c {
	case 0:
		return "A"
	case 1:
		return "B"
	case 2:
		return "C"
	case 3:
		return "D"
	case 4:
		return "E"
	case 5:
		return "F"
	case 6:
		return "G"
	case 8:
		return "SUA" // restricted/danger/FIR boundary -- not a standard ICAO class
	default:
		return "?"
	}
}

const feetToMeters = 0.3048

// toMeters converts a raw limit to meters plus which datum it's relative
// to. Flight levels (unit 6, always paired with the STD datum) are treated
// as an MSL feet equivalent -- see the outProperties comment.
func toMeters(a rawAlt) (meters float64, datum string) {
	if a.Unit == 6 {
		return a.Value * 100 * feetToMeters, "MSL"
	}
	if a.ReferenceDatum == 0 {
		return a.Value * feetToMeters, "GND"
	}
	return a.Value * feetToMeters, "MSL"
}

func formatLimit(a rawAlt) string {
	if a.Unit == 6 { // flight level
		return fmt.Sprintf("FL%d", int(a.Value))
	}
	if a.ReferenceDatum == 0 && a.Value == 0 {
		return "SFC"
	}
	switch a.ReferenceDatum {
	case 0:
		return fmt.Sprintf("%d' AGL", int(a.Value))
	case 1:
		return fmt.Sprintf("%d' MSL", int(a.Value))
	default:
		return fmt.Sprintf("%d'", int(a.Value))
	}
}

func bboxOverlaps(geom json.RawMessage) (bool, error) {
	var g struct {
		Coordinates json.RawMessage `json:"coordinates"`
	}
	if err := json.Unmarshal(geom, &g); err != nil {
		return false, err
	}
	var minX, minY, maxX, maxY float64
	first := true
	var walk func(raw json.RawMessage) error
	walk = func(raw json.RawMessage) error {
		var probe []json.RawMessage
		if err := json.Unmarshal(raw, &probe); err != nil {
			return err
		}
		if len(probe) == 0 {
			return nil
		}
		var num float64
		if err := json.Unmarshal(probe[0], &num); err == nil {
			// this level is a [lon, lat] pair
			var pt [2]float64
			if err := json.Unmarshal(raw, &pt); err != nil {
				return err
			}
			if first {
				minX, maxX, minY, maxY = pt[0], pt[0], pt[1], pt[1]
				first = false
			}
			if pt[0] < minX {
				minX = pt[0]
			}
			if pt[0] > maxX {
				maxX = pt[0]
			}
			if pt[1] < minY {
				minY = pt[1]
			}
			if pt[1] > maxY {
				maxY = pt[1]
			}
			return nil
		}
		for _, item := range probe {
			if err := walk(item); err != nil {
				return err
			}
		}
		return nil
	}
	if err := walk(g.Coordinates); err != nil {
		return false, err
	}
	if first {
		return false, nil
	}
	return !(maxX < minLon || minX > maxLon || maxY < minLat || minY > maxLat), nil
}

func main() {
	out := "data/airspace.geojson"
	if len(os.Args) > 1 {
		out = os.Args[1]
	}

	resp, err := http.Get(sourceURL)
	if err != nil {
		log.Fatalf("downloading %s: %v", sourceURL, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		log.Fatal(err)
	}

	var raw rawCollection
	if err := json.Unmarshal(body, &raw); err != nil {
		log.Fatalf("parsing source geojson: %v", err)
	}
	log.Printf("downloaded %d Canada-wide airspace features", len(raw.Features))

	result := outCollection{
		Type: "FeatureCollection",
		Attributes: map[string]any{
			"source":  "OpenAIP (https://www.openaip.net)",
			"license": "CC BY-NC 4.0",
		},
	}
	for _, f := range raw.Features {
		overlap, err := bboxOverlaps(f.Geometry)
		if err != nil || !overlap {
			continue
		}
		floorM, floorDatum := toMeters(f.Properties.LowerLimit)
		ceilingM, ceilingDatum := toMeters(f.Properties.UpperLimit)
		result.Features = append(result.Features, outFeature{
			Type: "Feature",
			Properties: outProperties{
				Name:         f.Properties.Name,
				Class:        classLabel(f.Properties.IcaoClass),
				Floor:        formatLimit(f.Properties.LowerLimit),
				Ceiling:      formatLimit(f.Properties.UpperLimit),
				FloorM:       floorM,
				FloorDatum:   floorDatum,
				CeilingM:     ceilingM,
				CeilingDatum: ceilingDatum,
			},
			Geometry: f.Geometry,
		})
	}
	log.Printf("kept %d features overlapping the Vancouver Island area", len(result.Features))

	outJSON, err := json.Marshal(result)
	if err != nil {
		log.Fatal(err)
	}
	if err := os.MkdirAll("data", 0755); err != nil {
		log.Fatal(err)
	}
	if err := os.WriteFile(out, outJSON, 0644); err != nil {
		log.Fatal(err)
	}
	log.Printf("wrote %s (%d bytes)", out, len(outJSON))
}
