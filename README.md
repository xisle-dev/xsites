# X/Sites

A MapLibre GL map of Vancouver Island paragliding launch sites: Google satellite
imagery draped over AWS's global DEM for 3D terrain, vector place/road labels
from a local Protomaps basemap extract, and a CRUD UI (backed by a small Go
server) for managing the site database in `sites/*.yaml`.

## Running it

Build and run the server (serves the static frontend, the `/api/sites` CRUD
API, and `/tiles/*` vector tiles, all on one port):

```powershell
cd server
go build -o xsite-server.exe .
.\xsite-server.exe -port=8933 -root=..
```

Then open http://localhost:8933.

## Regenerating the tile extract

`tiles/*.pmtiles` isn't checked in (regenerable, and over GitHub's file size
limit). Rebuild it with [go-pmtiles](https://github.com/protomaps/go-pmtiles):

```powershell
go install github.com/protomaps/go-pmtiles@latest
go-pmtiles extract https://build.protomaps.com/<YYYYMMDD>.pmtiles tiles/labels-vancouver-island.pmtiles --bbox=-126.9,48.1,-122.8,50.6
```

Use today's date (or a recent one) for the build filename — see
https://maps.protomaps.com/builds/.

## Notes

- `app.js` embeds a Google Maps Platform API key for satellite tiles. It's
  the same key already used in a couple of sibling projects on this machine;
  swap it for your own if it's ever rotated/revoked.
- `sites/*.yaml` is a small hand-rolled flat-scalar YAML format (see
  `server/siteyaml.go`), not general YAML — it round-trips exactly what's
  already in this repo, but wasn't built to handle arbitrary YAML.
