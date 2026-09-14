package main

// Downloads Canada's airspace dataset from OpenAIP's public, anonymous
// export bucket (CC BY-NC 4.0 -- see https://www.openaip.net, attribution
// required), caches the raw download, then keeps only the polygons that
// overlap the Vancouver Island flying area and writes a trimmed
// output/airspace.geojson checked into the repo. Re-run this by hand
// occasionally to pick up NAV CANADA airspace revisions -- it's not part
// of any automated build since airspace boundaries change on the order of
// months, not every push.

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
)

const airspaceSourceURL = "https://storage.openaip.net/openaip-system-exports/ca_asp.geojson"

// Vancouver Island plus a margin covering the southern Gulf Islands and the
// nearby mainland coast (XC flights routinely range beyond the launch pin).
const (
	airspaceMinLon = -127.2
	airspaceMinLat = 47.7
	airspaceMaxLon = -122.4
	airspaceMaxLat = 51.0
)

type airspaceRawFeature struct {
	Type       string              `json:"type"`
	Properties airspaceRawProperties `json:"properties"`
	Geometry   json.RawMessage     `json:"geometry"`
}

type airspaceRawProperties struct {
	Name       string       `json:"name"`
	IcaoClass  int          `json:"icaoClass"`
	UpperLimit airspaceRawAlt `json:"upperLimit"`
	LowerLimit airspaceRawAlt `json:"lowerLimit"`
}

type airspaceRawAlt struct {
	Value          float64 `json:"value"`
	Unit           int     `json:"unit"`
	ReferenceDatum int     `json:"referenceDatum"`
}

type airspaceRawCollection struct {
	Type     string               `json:"type"`
	Features []airspaceRawFeature `json:"features"`
}

type airspaceOutFeature struct {
	Type       string             `json:"type"`
	Properties airspaceOutProperties `json:"properties"`
	Geometry   json.RawMessage    `json:"geometry"`
}

type airspaceOutProperties struct {
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

type airspaceOutCollection struct {
	Type       string                 `json:"type"`
	Attributes map[string]any         `json:"attribution"`
	Features   []airspaceOutFeature   `json:"features"`
}

// icaoClass values empirically confirmed against known BC airspace (e.g.
// Vancouver TCA -> 2/C, Comox CZ -> 3/D, Nanaimo CZ -> 4/E, CYR restricted
// areas -> 8). OpenAIP's public schema docs don't spell this out; see the
// Google Group thread linked from their docs page for others hitting the
// same gap.
func airspaceClassLabel(c int) string {
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

const airspaceFeetToMeters = 0.3048

// toMeters converts a raw limit to meters plus which datum it's relative
// to. Flight levels (unit 6, always paired with the STD datum) are treated
// as an MSL feet equivalent -- see airspaceOutProperties' comment.
func airspaceToMeters(a airspaceRawAlt) (meters float64, datum string) {
	if a.Unit == 6 {
		return a.Value * 100 * airspaceFeetToMeters, "MSL"
	}
	if a.ReferenceDatum == 0 {
		return a.Value * airspaceFeetToMeters, "GND"
	}
	return a.Value * airspaceFeetToMeters, "MSL"
}

func airspaceFormatLimit(a airspaceRawAlt) string {
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

func airspaceBboxOverlaps(geom json.RawMessage) (bool, error) {
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
	return !(maxX < airspaceMinLon || minX > airspaceMaxLon || maxY < airspaceMinLat || minY > airspaceMaxLat), nil
}

func runAirspace() {
	rawCachePath := filepath.Join("data-sources", "openaip-ca-airspace.geojson")
	outPath := filepath.Join("output", "airspace.geojson")

	resp, err := http.Get(airspaceSourceURL)
	if err != nil {
		log.Fatalf("downloading %s: %v", airspaceSourceURL, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		log.Fatal(err)
	}

	if err := os.MkdirAll("data-sources", 0755); err != nil {
		log.Fatal(err)
	}
	if err := os.WriteFile(rawCachePath, body, 0644); err != nil {
		log.Fatal(err)
	}
	log.Printf("cached raw download at %s (%d bytes)", rawCachePath, len(body))

	var raw airspaceRawCollection
	if err := json.Unmarshal(body, &raw); err != nil {
		log.Fatalf("parsing source geojson: %v", err)
	}
	log.Printf("downloaded %d Canada-wide airspace features", len(raw.Features))

	result := airspaceOutCollection{
		Type: "FeatureCollection",
		Attributes: map[string]any{
			"source":  "OpenAIP (https://www.openaip.net)",
			"license": "CC BY-NC 4.0",
		},
	}
	for _, f := range raw.Features {
		overlap, err := airspaceBboxOverlaps(f.Geometry)
		if err != nil || !overlap {
			continue
		}
		floorM, floorDatum := airspaceToMeters(f.Properties.LowerLimit)
		ceilingM, ceilingDatum := airspaceToMeters(f.Properties.UpperLimit)
		result.Features = append(result.Features, airspaceOutFeature{
			Type: "Feature",
			Properties: airspaceOutProperties{
				Name:         f.Properties.Name,
				Class:        airspaceClassLabel(f.Properties.IcaoClass),
				Floor:        airspaceFormatLimit(f.Properties.LowerLimit),
				Ceiling:      airspaceFormatLimit(f.Properties.UpperLimit),
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
	if err := os.MkdirAll("output", 0755); err != nil {
		log.Fatal(err)
	}
	if err := os.WriteFile(outPath, outJSON, 0644); err != nil {
		log.Fatal(err)
	}
	log.Printf("wrote %s (%d bytes)", outPath, len(outJSON))
}
