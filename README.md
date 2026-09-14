# X/Sites

A MapLibre GL map of Vancouver Island paragliding launch sites: Google satellite
imagery draped over AWS's global DEM for 3D terrain, vector place/road labels
from a local Protomaps basemap extract, and a CRUD UI (backed by a Cloudflare
Worker) for managing the site database.

## Architecture

A single Cloudflare Worker (`worker/`) serves the whole app:

- `worker/public/` at `/` — a public, unauthenticated read-only viewer,
  reading site data from `GET /sites.json` (a snapshot kept current by the
  instant-publish mirror, see below -- not a live `/api/sites` call) and
  labels from the Worker's own `/tiles/*` route.
- `worker/public/admin/` at `/admin` — the full read/write CRUD editor.
- `/api/sites` (CRUD JSON), `/media/<id>/<file>` (site photos), and
  `/tiles/*` (vector tiles read straight out of R2) round out the Worker;
  the public viewer only ever hits the latter two.

`/admin` and `/api` are the only paths gated by Cloudflare Access (email
one-time-PIN, no external identity provider) -- see **Live editing
(Cloudflare Workers)** below. Site data and media live in a Cloudflare R2
bucket, read/written directly via a native R2 binding (no S3 SDK, no
credentials in the data path).

Everything -- compute, storage, DNS, and auth -- runs on Cloudflare. There is
no other cloud provider involved; an earlier iteration ran as a Go server on
Google Cloud Run, and before that the public read-only view was a separate,
independently-deployed static site (`static/` + `tools/buildstatic`, synced
to R2 by GitHub Actions, with its own preview server in `tools/localserve`).
All of that -- along with the repo-root `app.js`/`index.html`/`style.css`/
`logo.svg`/`favicon.svg` copies it left behind, and the `sites/*.yaml`
snapshot the old Go server used to read directly -- was retired once the
Worker itself could serve an equivalent (and for the public view, strictly
better -- live rather than periodically rebuilt) experience on its own.
`worker/public/` is the sole source of truth for every file the app serves;
see github issue #11 for the Cloud Run migration.

### Map rendering

- **MapLibre GL JS 6.7.0**, loaded as an ES module straight from jsdelivr —
  no bundler, no `node_modules` for the map code itself (the Worker's own
  build tooling is separate, see **Live editing** below).
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
  upright at any bearing, unlike Google's raster labels. Served straight out
  of the `.pmtiles` archive in R2 by the Worker (`worker/src/tiles.ts`),
  using the `pmtiles` npm package's documented Workers+R2 pattern -- byte-range
  reads directly against the archive object, no separate tile server. Both
  `/` and `/admin` read this same route.
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
- **Glide range tool** (`/admin` only): click anywhere on the map to draw
  terrain-aware glide range bands (1:1 through 1:10) radiating from that
  point, computed by ray-marching outward along 72 bearings and sampling the
  DEM at each step until height above terrain drops below what the ratio
  allows, then bisecting between the last-safe and first-failing distance
  for a clean edge. Hovering after a click shows the exact decimal glide
  ratio required to reach the cursor. Click elsewhere (or the same point) to
  clear it.
- **URL state** (`/admin` only): the selected site, camera position,
  search/area filters, and airspace visibility are all reflected in the URL
  query string as they change, so any view is bookmarkable/shareable and
  back/forward-navigable.
- **Site markers**: each pin carries a small text label (the site's name) as
  a *second*, independent MapLibre `Marker` anchored to the same coordinate
  (`anchor: "left"` with a fixed offset) rather than baked into the pin's own
  element — an earlier version built the label as a child of the pin's DOM
  element with hand-rolled absolute positioning, which broke pin placement
  in at least one real browser despite checking out fine in testing here;
  a second independent marker relies entirely on MapLibre's own anchor/offset
  math instead.
- **Initial render**: the site list is fetched *before* constructing the
  `Map`, and the fetched sites both frame the map's initial camera bounds
  and render into the sidebar/markers immediately once the `Map` object
  exists -- deliberately not gated on the map's `"load"` event, since
  populating the list is plain DOM + Marker calls that don't need the
  style/tiles to have finished loading, and gating it on `"load"` meant a
  slow or failed basemap left the sidebar empty even though the site data
  had already arrived fine.
- **Responsive UI**: a fixed left-side panel on desktop; below a CSS
  breakpoint it becomes a draggable bottom sheet, with map controls
  (zoom, pitch, terrain exaggeration, airspace legend) moved into a
  hamburger-menu dropdown off the header instead of living inline in the
  panel.

### Site data

Each launch site is one record covering name, area, description/hazards
(rich text), lat/lon, elevation, a saved camera preset for "Fly here", and a
list of reference links (photos, PDFs, GPX tracks).

The sole source of truth is a Cloudflare R2 bucket (`worker/src/store.ts`),
one object per site at `sites/<id>.yaml` plus media at
`sites/<id>/media/<filename>`, using a small hand-rolled flat-scalar YAML
dialect (see `worker/src/siteyaml.ts`'s header comment). All reads and
writes from the Worker editor go here, via a native R2 binding -- there's no
local disk, no repo-checked-in copy, and no S3-style credentials involved.

## Running it

Run the Worker locally with Wrangler, against real R2 buckets (no
local-disk mode):

```bash
cd worker
npm install
npm run dev   # wrangler dev --remote
```

Then open http://127.0.0.1:8787. This needs `wrangler login` once, and
access to the `xsites-live-data` / `xsites` R2 buckets on the Cloudflare
account (see below).

## Live editing (Cloudflare Workers)

The dynamic app runs as a Cloudflare Worker (`worker/`). `/` is public and
read-only; `/admin` (the full CRUD editor) and `/api` are gated by
Cloudflare Access (email one-time-PIN) so only allowlisted addresses can
reach them. Compute, storage, DNS, and auth are all Cloudflare-native -- see
github issue #11 for the full phased migration this came from (replacing an
earlier Cloud Run + IAP setup that couldn't be scripted end-to-end for a
personal Google account).

### Initial setup (one-time)

1. **Two R2 buckets**: `xsites-live-data` (the editor's live source of
   truth) and `xsites` (the public bucket, used for the instant-publish
   mirror and the PMTiles archive). Both are declared as native bindings in
   `worker/wrangler.toml` -- no separate credentials needed for the Worker
   to read/write them.
2. **Upload the `.pmtiles` label archive** to the `xsites` bucket once (it's
   too large for git and rarely changes):
   ```bash
   npx wrangler r2 object put xsites/tiles/labels-vancouver-island.pmtiles \
     --file=tiles/labels-vancouver-island.pmtiles \
     --content-type=application/octet-stream --remote
   ```
   (`--remote` matters -- without it, `wrangler r2 object put` writes to
   Miniflare's local simulated storage instead of the real bucket.)
3. **Deploy the Worker**:
   ```bash
   cd worker
   npm install
   npx wrangler deploy
   ```
   `wrangler.toml`'s `[[routes]]` with `custom_domain = true` has Wrangler
   provision the DNS record and SSL cert for `sites.xisle.net` itself --
   no manual DNS record to maintain.
4. **Enable Zero Trust on the account** (one-time, dashboard-only -- there's
   no API for this first step): dash.cloudflare.com → Zero Trust → pick a
   team name, Free plan.
5. **Provision Cloudflare Access** with the idempotent setup script:
   ```bash
   CF_ACCOUNT_ID=<account-id> CF_ACCESS_TOKEN=<token> \
     worker/scripts/setup-access.sh sites.xisle.net you@example.com [more emails...]
   ```
   The token needs "Access: Apps and Policies: Edit" and "Access:
   Organizations, Identity Providers, and Groups: Edit" (My Profile → API
   Tokens → Create Token). The script creates (or updates, if re-run) the
   email one-time-PIN login method, a self-hosted Access application for the
   domain, and an allow policy for the given emails. By default it scopes
   the application to just `<domain>/admin*` and `<domain>/api*` (matching
   the public/admin split above) -- pass `--paths ""` before the domain to
   protect the whole hostname instead. It also brands the Access login page
   and renames the Zero Trust team domain -- see its header comment for the
   override env vars.

### Applying updates

```bash
cd worker
npx wrangler deploy
```

Wrangler re-uploads changed static assets (`worker/public/`) and the Worker
script together; no image build, no container registry.

### Instant publish

`worker/src/publish.ts` mirrors every save into the `xsites` bucket's
`sites.json` / `media/<id>/<file>`, which is what the Worker's own public
viewer (`GET /sites.json`, `GET /media/...`) actually reads -- kept separate
from the live-editing bucket (`xsites-live-data`) so an anonymous page view
never touches the authoritative per-site YAML store or pays for re-parsing
it. Because `PUBLIC_SITE` is just another R2 binding (not a separate set of
credentials the way the old Cloud Run setup needed), this always runs --
there's no "not configured yet" state to worry about.

## Regenerating the tile extract

`tiles/*.pmtiles` isn't checked in (regenerable, and over GitHub's file size
limit). Rebuild it with [go-pmtiles](https://github.com/protomaps/go-pmtiles):

```powershell
go install github.com/protomaps/go-pmtiles@latest
go-pmtiles extract https://build.protomaps.com/<YYYYMMDD>.pmtiles tiles/labels-vancouver-island.pmtiles --bbox=-126.9,48.1,-122.8,50.6
```

Use today's date (or a recent one) for the build filename — see
https://maps.protomaps.com/builds/. After regenerating, re-upload it (see
**Live editing** step 2).

## Notes

- `worker/public/app.js` and `worker/public/admin/app.js` each embed a
  Google Maps Platform API key for satellite tiles, from a dedicated GCP
  project (`xisle-maps`) with the Map Tiles API and Places API (New)
  enabled and billing linked. Swap it for your own if it's ever
  rotated/revoked -- test with a direct `POST` to
  `tile.googleapis.com/v1/createSession`, which returns a clear
  `API_KEY_INVALID` if not.
- The site YAML dialect (see `worker/src/siteyaml.ts`'s header comment) is a
  small hand-rolled flat-scalar format, not general YAML -- it round-trips
  exactly what R2 already holds, but wasn't built to handle arbitrary YAML.
- Both `index.html` files load their `app.js`/`style.css` with a
  `?v=<unix time>` query string. Browsers were observed holding onto a
  stale cached copy of one and not the other across edits (mismatched
  JS/CSS versions), badly enough that even a manual hard refresh didn't
  reliably fix it. Bump the relevant `?v=` value(s) (e.g. to the current
  unix time) whenever `app.js` or `style.css` changes, or a deploy can
  silently keep serving stale JS to already-open tabs.
