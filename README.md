# X/Sites

A MapLibre GL map of Vancouver Island paragliding launch sites: Google satellite
imagery draped over AWS's global DEM for 3D terrain, vector place/road labels
from a local Protomaps basemap extract, and a CRUD UI (backed by a small Go
server) for managing the site database in `sites/*.yaml`.

## Architecture

The app ships in two independent modes that share the same map code and data
format but nothing at runtime:

- **Dynamic** — a Go server (`server/`) with full read/write CRUD, currently
  deployed on a GCP VM.
- **Static** — a read-only mirror (`static/` + `tools/buildstatic`) deployed
  to Cloudflare R2, rebuilt and synced automatically on every push via
  GitHub Actions.

### Map rendering (both modes)

- **MapLibre GL JS 6.7.0**, loaded as an ES module straight from jsdelivr —
  no bundler, no `node_modules`.
- **Satellite imagery**: Google's 2D satellite raster tiles, fetched
  client-side through a custom `gtiles://` protocol (`addProtocol`) that
  opens a Google Maps Platform tile session (`tile.googleapis.com/v1/createSession`)
  and re-authenticates it as the session token nears expiry. No road/place
  labels are requested from Google — its labels are baked into the raster
  pixels and rotate (even go upside-down) with map bearing.
- **Terrain**: AWS's public Terrarium-encoded `elevation-tiles-prod` DEM
  (~30m resolution), wired up as *two* separate raster-dem sources pointed at
  the same tiles — one feeds a `hillshade` layer, the other feeds
  `setTerrain()`. Using a single shared source for both causes MapLibre's
  terrain-exaggeration updates to contend with the hillshade layer's own use
  of it; two sources sidesteps that.
- **Labels**: real vector text from a Protomaps basemap extract
  (`@protomaps/basemaps`), filtered down to text-only symbol layers (no
  sprite icons, since the sprite sheet isn't loaded) so place/road names stay
  upright at any bearing, unlike Google's raster labels. The two modes read
  the same `.pmtiles` archive differently:
  - *Dynamic*: served locally over HTTP by the Go server's embedded
    go-pmtiles tile server, from `tiles/labels-vancouver-island.pmtiles` on
    the VM's disk (`/tiles/labels-vancouver-island/{z}/{x}/{y}.mvt`).
  - *Static*: read directly out of the `.pmtiles` archive in the R2 bucket
    via HTTP range requests, using the `pmtiles` JS library's own
    `pmtiles://` protocol handler — no server involved at all.
- **Airspace overlay**: Canadian airspace polygons (Class B–G, plus
  restricted/danger areas and FIR boundaries, lumped together as "SUA") from
  OpenAIP (CC BY-NC 4.0, ultimately sourced from NAV CANADA's Designated
  Airspace Handbook), pre-filtered to the Vancouver Island flying area by
  `tools/fetchairspace` and checked into the repo as `data/airspace.geojson`.
  Off by default (most visits never need it), and `data/airspace.geojson`
  itself isn't even fetched until the "Show airspace" checkbox is first
  ticked — its GeoJSON source starts out empty and is populated on demand.
  Once on, rendered as flat 2D fill + line layers; a separate
  `airspace-highlight` GeoJSON source drives the selected/pinned entry's
  outline, on-map label, and a `fill-extrusion` layer that extrudes just
  that one shape into its true floor-to-ceiling 3D volume (terrain-corrected
  via `queryTerrainElevation()`, height-capped so an SFC–FL999 FIR doesn't
  render as an unusable wall). Clicking an airspace list entry pins its
  highlight so it survives panning/rotating; a fresh click query clears the
  old pin and auto-pins its own top (lowest-ceiling) entry.
- **Site markers**: each pin carries a small text label (the site's name) as
  a *second*, independent MapLibre `Marker` anchored to the same coordinate
  (`anchor: "left"` with a fixed offset) rather than baked into the pin's own
  element — an earlier version built the label as a child of the pin's DOM
  element with hand-rolled absolute positioning, which broke pin placement
  in at least one real browser despite checking out fine in testing here;
  a second independent marker relies entirely on MapLibre's own anchor/offset
  math instead.
- **Initial camera**: both apps fetch the site list *before* constructing
  the `Map`, and pass the bounding box of every site straight in as the
  map's initial `bounds`. Fetching sites only after the map's first `load`
  event (the original approach) meant starting at a fixed, tight view and
  then jumping to the fitted-to-all-sites view a moment later once the
  fetch resolved — visibly a second, differently-zoomed set of
  terrain/satellite tiles loading right after the first.
- **Responsive UI**: a fixed left-side panel on desktop; below a CSS
  breakpoint it becomes a draggable bottom sheet, with map controls
  (zoom, pitch, terrain exaggeration, airspace legend) moved into a
  hamburger-menu dropdown off the header instead of living inline in the
  panel.

### Site data

`sites/<id>.yaml` — one file per launch site, in a small hand-rolled
flat-scalar YAML dialect (not general YAML; see `server/siteyaml.go`'s
header comment) covering name, area, description/hazards (rich text),
lat/lon, elevation, a saved camera preset for "Fly here", and a list of
reference links. Site photos live alongside at `sites/<id>/media/*`. There is
no database — the yaml directory *is* the source of truth in both modes.

### Dynamic mode

`server/main.go` builds a single Go binary that serves everything on one
port: the frontend's static files, the `/api/sites` CRUD JSON API (reading
and writing `sites/*.yaml` directly), `/media/<id>/<file>` for site photos,
and `/tiles/*` vector tiles via an embedded go-pmtiles server. This is the
only mode with write access — adding, editing, or deleting a site or photo
through the UI persists straight to the yaml files on the VM's disk.

### Static mode

`tools/buildstatic` assembles a complete, self-contained static site with no
server-side dependency: it reads `sites/*.yaml` into one `sites.json`, copies
site media, and copies the hand-authored `static/index.html` +
`static/app.js` (structurally simpler than the dynamic app — no CRUD forms,
no auth, no write paths) plus the assets shared with the dynamic mode
(`style.css`, `favicon.svg`, `logo.svg`, `data/airspace.geojson`) into
`dist/`. It intentionally re-implements (rather than imports) the read side
of `server/siteyaml.go`, since the two binaries deploy independently and
duplicating that ~80-line parser is a smaller risk than coupling this tool's
build to the live server's package layout.

`.github/workflows/deploy-r2.yml` runs `tools/buildstatic` and syncs the
result to a Cloudflare R2 bucket (via the AWS CLI against R2's
S3-compatible endpoint) on every push to `master`, or on demand — see
**Deploy** below. The `.pmtiles` label archive is excluded from that sync
(it's large and only changes when the tile extract is regenerated) and is
uploaded to the bucket by hand instead.

## Running it

Build and run the server (serves the static frontend, the `/api/sites` CRUD
API, and `/tiles/*` vector tiles, all on one port):

```powershell
cd server
go build -o xsite-server.exe .
.\xsite-server.exe -port=8933 -root=..
```

Then open http://localhost:8933.

## Deploy

The dynamic app deploys as the `xsite-server` binary above run on a GCP VM
(build for Linux with `GOOS=linux GOARCH=amd64 go build ...` and copy it
over). This section covers the static mode's deploy to Cloudflare R2, which
is the one that's automated.

### Initial setup

1. **Create an R2 bucket** — Cloudflare dashboard → R2 → Create bucket.
2. **Make it publicly readable** — bucket → Settings → Public Access: either
   enable the bucket's `r2.dev` subdomain, or (recommended for a real domain)
   connect a custom domain you already have on Cloudflare DNS.
3. **Create an R2 API token** — Cloudflare dashboard → R2 → Manage R2 API
   Tokens → Create API Token, with Edit permission scoped to that bucket.
   This gives you an Access Key ID and Secret Access Key (R2's API is
   S3-compatible).
4. **Note your Cloudflare Account ID** — shown in the dashboard sidebar;
   it's part of the R2 S3 endpoint, `https://<account-id>.r2.cloudflarestorage.com`.
5. **Add GitHub repository secrets** — repo → Settings → Secrets and
   variables → Actions → New repository secret:
   - `R2_ACCESS_KEY_ID`
   - `R2_SECRET_ACCESS_KEY`
   - `R2_ACCOUNT_ID`
   - `R2_BUCKET_NAME`
6. **Upload the `.pmtiles` label archive once, by hand** — it's excluded
   from the automated sync (see below). Build it per **Regenerating the tile
   extract**, then upload it to the bucket root, e.g.:
   ```powershell
   aws s3 cp tiles/labels-vancouver-island.pmtiles `
     s3://<bucket>/labels-vancouver-island.pmtiles `
     --endpoint-url https://<account-id>.r2.cloudflarestorage.com
   ```
   (or drag it in through the R2 dashboard's object browser, or
   `wrangler r2 object put`).
7. **Run the deploy** — push to `master`, or trigger it manually from
   Actions → "Deploy static site to R2" → Run workflow. This builds `dist/`
   with `tools/buildstatic` and runs
   `aws s3 sync dist/ s3://<bucket> --delete --exclude "*.pmtiles"`
   against the R2 endpoint.
8. **Verify** — open the bucket's public URL (or custom domain) and confirm
   the map, sites, and airspace overlay all load.

### Applying updates

Once the above is set up, shipping a change is just:

```bash
git push origin master
```

GitHub Actions rebuilds `dist/` from the current `sites/*.yaml`, `static/`,
and shared assets, and re-syncs it to the bucket (`--delete`, so removed
files are cleaned up too). You can also re-run it without a new commit from
Actions → "Deploy static site to R2" → Run workflow.

Two things the automated sync does *not* handle:

- **A regenerated `.pmtiles` extract** (new basemap build, or a different
  bbox) still needs the manual upload step above — it's excluded from the
  sync on purpose so a routine site-data push doesn't re-upload a large file
  that hasn't changed.
- **Stale CDN cache** on a custom domain — if a change doesn't show up
  immediately, purge the cache for the affected files (or Purge Everything)
  under the zone's Caching → Configuration in the Cloudflare dashboard.

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
- `index.html`/`static/index.html` load `app.js`/`style.css` with a
  `?v=<unix time>` query string. Browsers were observed holding onto a
  stale cached copy of one and not the other across edits (mismatched
  JS/CSS versions), badly enough that even a manual hard refresh didn't
  reliably fix it. Bump both `?v=` values (e.g. to the current unix time)
  whenever `app.js` or `style.css` changes.
