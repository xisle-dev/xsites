# X/Sites

A MapLibre GL map of Vancouver Island paragliding launch sites: Google satellite
imagery draped over AWS's global DEM for 3D terrain, vector place/road labels
from a local Protomaps basemap extract, and a CRUD UI (backed by `server/`)
for managing the site database.

## Architecture

A single server (`server/`) serves the whole app, deployed as a Cloudflare
Worker today (see **Live editing** below) but written to be portable --
see **Portability** below for exactly what is and isn't Cloudflare-specific:

- `server/public/` at `/` — a public read-only viewer, reading site data
  from `GET /sites.json` (a snapshot kept current on every save, see
  **sites.json** below) and labels from the
  server's own `/tiles/*` route.
- `server/public/admin/` at `/admin` — the full read/write CRUD editor.
- `/api/sites` (CRUD JSON), `/media/<id>/<file>` (site photos), and
  `/tiles/*` (vector tiles read straight out of R2) round out the server;
  the public viewer only ever hits the latter two.

The viewer and all read routes are public. `/admin` and every write route
(`POST`/`PUT`/`DELETE` under `/api`) are protected by HTTP Basic auth with a
single shared password (any username), stored as the `ADMIN_PASSWORD` Worker
secret.
Site data and media live in a Cloudflare R2 bucket, read/written directly
via a native R2 binding (no S3 SDK, no credentials in the data path).

Everything -- compute, storage, and DNS -- runs on Cloudflare. There is no
other cloud provider involved; an earlier iteration ran as a Go server on
Google Cloud Run, and before that the public read-only view was a separate,
independently-deployed static site (`static/` + `tools/buildstatic`, synced
to R2 by GitHub Actions, with its own preview server in `tools/localserve`).
All of that -- along with the repo-root `app.js`/`index.html`/`style.css`/
`logo.svg`/`favicon.svg` copies it left behind, and the `sites/*.yaml`
snapshot the old Go server used to read directly -- was retired once the
server itself could serve an equivalent (and for the public view, strictly
better -- live rather than periodically rebuilt) experience on its own.
`server/public/` is the sole source of truth for every file the app serves;
see github issue #11 for the Cloud Run migration.

### Map rendering

- **MapLibre GL JS 6.7.0**, loaded as an ES module straight from jsdelivr —
  no bundler, no `node_modules` for the map code itself (the server's own
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
  of the `.pmtiles` archive in R2 by the server (`server/src/tiles.ts`),
  using the `pmtiles` npm package's documented Workers+R2 pattern -- byte-range
  reads directly against the archive object, no separate tile server. Both
  `/` and `/admin` read this same route.
- **Airspace overlay**: Canadian airspace polygons (Class B–G, plus
  restricted/danger areas and FIR boundaries, lumped together as "SUA") from
  OpenAIP (CC BY-NC 4.0, ultimately sourced from NAV CANADA's Designated
  Airspace Handbook), pre-filtered to the Vancouver Island flying area by
  `etl airspace` (see **Regenerating the ETL outputs** below) and served
  from `server/public/data/airspace.geojson`. Off by default (most visits
  never need it), and this file itself isn't even fetched until the "Show
  airspace" checkbox is first ticked — its GeoJSON source starts out empty
  and is populated on demand.
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

The sole source of truth is one Cloudflare R2 bucket per environment
(`server/src/store.ts`; PROD's is `xsites-live-data`), one object per site
at `sites/<id>.yaml` plus media at `sites/<id>/media/<filename>`, using a small hand-rolled flat-scalar YAML
dialect (see `server/src/siteyaml.ts`'s header comment). All reads and
writes from the editor go here, via a native R2 binding -- there's no
local disk, no repo-checked-in copy, and no S3-style credentials involved.

## Running it

Run the server locally with Wrangler, against real R2 buckets (no
local-disk mode):

```bash
cd server
npm install
npm run dev   # wrangler dev --remote --env qa (QA's buckets)
```

Then open http://127.0.0.1:8787. This needs `wrangler login` once, and
access to QA's `xsites-live-data-qa` R2 bucket on the Cloudflare account
(see below).

## Live editing (Cloudflare Workers)

The dynamic app runs as a server (`server/`), deployed as a Cloudflare
Worker. Every route -- `/`, `/admin` (the full CRUD editor), and `/api` --
is public except `/admin` and the write routes under `/api`, which require
HTTP Basic auth (see "Admin password" below).
Compute, storage, and DNS are all Cloudflare-native -- see github issue #11
for the full phased migration this came from (replacing an earlier Cloud
Run + IAP setup that couldn't be scripted end-to-end for a personal Google
account).

### Initial setup (one-time)

(Normally all done by `go run ./setup` and the workflows -- see **GitHub
Actions** below. The manual equivalent for PROD:)

1. **One R2 bucket**: `xsites-live-data`, holding the site YAML and media
   (`sites/`), the derived `sites.json`, and the PMTiles archive
   (`tiles/`). It's declared as the `DATA` binding in
   `server/wrangler.toml` -- no separate credentials needed for the server
   to read/write it.
2. **Upload the `.pmtiles` label archive** to it once (it's too large for
   git and rarely changes):
   ```bash
   npx wrangler r2 object put xsites-live-data/tiles/labels-vancouver-island.pmtiles \
     --file=etl/output/labels-vancouver-island.pmtiles \
     --content-type=application/octet-stream --remote
   ```
   (`--remote` matters -- without it, `wrangler r2 object put` writes to
   Miniflare's local simulated storage instead of the real bucket.)
3. **Deploy the server**:
   ```bash
   cd server
   npm install
   npx wrangler deploy
   ```
   `wrangler.toml`'s `[[routes]]` with `custom_domain = true` has Wrangler
   provision the DNS record and SSL cert for `xisle.net` itself --
   no manual DNS record to maintain.

### Admin password

Set (or rotate) the shared admin password as a Worker secret -- it is never
stored in the repo:

```bash
cd server
npx wrangler secret put ADMIN_PASSWORD
```

### Applying updates

```bash
cd server
npx wrangler deploy
```

Wrangler re-uploads changed static assets (`server/public/`) and the server
script together; no image build, no container registry.

### QA and PROD

Two environments run side by side in the same Cloudflare account and share
only the code. Everything else is separate:

| | QA | PROD |
| --- | --- | --- |
| URL | <https://qa.xisle.net> | <https://xisle.net> |
| Worker | `xsites-editor-qa` (`wrangler deploy --env qa`) | `xsites-editor` |
| R2 bucket | `xsites-live-data-qa` | `xsites-live-data` |
| Admin password | its own | its own |
| GitHub environment | `qa` | `prod` (deploys need your approval) |
| Cloudflare tokens | `xsites-deploy-qa`, `xsites-r2-qa` | `xsites-deploy-prod`, `xsites-r2-prod` |

Each environment's R2 token can reach only its own bucket. The deploy
tokens are account-wide by necessity (Cloudflare can't scope a token to one
Worker), so the wall between QA and PROD Workers is the `prod` GitHub
environment: only jobs that target it, after your approval, get its token.
`npm run dev` runs against QA.

Code moves QA -> PROD like this: push to `master` -> Deploy ships it to QA
-> you check qa.xisle.net -> approve the waiting `prod` job in the Actions
run -> the same commit ships to PROD. A newer push replaces an unapproved
PROD deploy.

### GitHub Actions

Workflows in `.github/workflows/` take every routine job off your own
machine -- no Node, npm or wrangler needed locally:

| Workflow | Runs | Does |
| --- | --- | --- |
| `deploy.yml` | push to `master` touching `server/`, or by hand | typecheck, deploy to QA, then to PROD after your approval |
| `airspace.yml` | 1st of each month, or by hand | `etl airspace`, copies it into `server/public/data/`, opens a PR to review; merging deploys it |
| `tiles.yml` | by hand: pick `qa` or `prod` (optional build date) | `etl tiles`, uploads the `.pmtiles` to that environment's bucket |
| `backup.yml` | nightly, or by hand | `rclone sync` of PROD's site YAML and media into a private backup repo, committed only on change |
| `seed-qa.yml` | by hand | replaces QA's data with the latest PROD backup |

One-time setup is a single command, `setup/` (Go, stdlib plus
`golang.org/x/crypto`), which builds both environments through the
Cloudflare and GitHub APIs:

- Per environment: its R2 bucket (created by a temporary token that is
  deleted straight after), a deploy token (Workers scripts, routes, DNS --
  no R2), an R2 token on just its bucket, and a GitHub environment holding
  `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
  `R2_SECRET_ACCESS_KEY`, `ADMIN_PASSWORD` and variable `R2_BUCKET`
- Backups: the private backup repo (`xisle-dev/xsites-backup`), a
  `prod-backup` environment with a read-only token on PROD's bucket
  and the repo's write deploy key, a read-only key on the backup repo for
  QA's seeding, and the `BACKUP_REPO` variable
- "Allow GitHub Actions to create and approve pull requests"

Every step is safe to re-run, and a re-run rotates every token value and
deploy key and writes the new ones into GitHub -- that's also how you
rotate credentials.

It needs two credentials that no API can create for you:

1. **Cloudflare bootstrap token**: at
   <https://dash.cloudflare.com/profile/api-tokens>, select **Create Token**
   and use the **Create Additional Tokens** template. It can only mint
   other tokens; give it a short expiry (a day) and delete it afterwards.
2. **GitHub**: `gh auth login` once (or set `GITHUB_TOKEN` to a token with
   `repo` scope).

Then, in PowerShell:

```powershell
cd setup
$env:CLOUDFLARE_ACCOUNT_ID = "<account id>"
$env:CLOUDFLARE_BOOTSTRAP_TOKEN = "<bootstrap token>"
$env:ADMIN_PASSWORD_QA = "<QA admin password>"      # first run, or to change it
$env:ADMIN_PASSWORD_PROD = "<PROD admin password>"  # first run, or to change it
go run . -deploy
```

The account ID is the hex string in your dashboard URL
(`dash.cloudflare.com/<account id>/...`). `-deploy` runs the Deploy
workflow at the end. On first setup, also run Tiles for each environment,
then Seed QA once the first backup exists. Admin passwords live in GitHub
and every deploy pushes them to their Worker.

To restore PROD's live data from a backup checkout (needs PROD's
read/write R2 keys, not the backup's read-only ones):
`rclone sync data r2:xsites-live-data --exclude "tiles/**"`.

### sites.json

`server/src/publish.ts` keeps `sites.json` -- every site in one JSON array,
at the bucket root beside `sites/` -- current on every save, and both list
views (`GET /sites.json` for the public viewer, `GET /api/sites` for the
editor) read that one object instead of parsing every site's YAML (~150ms
vs ~5s for 63 sites). It's purely derived: if it's missing it's rebuilt from
the YAML on the next request, so deleting it is always safe. Media is
served straight from `sites/<id>/media/`.

## Portability

`server/`'s request-handling code (`index.ts`'s routing, `siteyaml.ts`'s
parsing, the `pmtiles` tile-serving logic) is written against plain
`Request`/`Response`/`URL` -- the same shape Deno Deploy and Bun support
natively, and Node 18+ can via a thin adapter. One thing is genuinely
platform-specific, and sits behind an interface for exactly that reason:

- **Storage** (`objectstore.ts`): `store.ts`, `publish.ts`, and `tiles.ts`
  all depend on the `ObjectStore` interface (get/getRange/put/delete/list/
  exists on string keys and ArrayBuffers), not on R2 directly.
  `R2ObjectStore` is the only implementation today; adding an
  S3-compatible or local-filesystem one is contained entirely to a new
  class satisfying that interface -- nothing else changes.

The auth layer is one small function (`requireAuth` in `index.ts`) comparing a
shared password from the environment.

What's *not* abstracted, because there's nothing generic to abstract it
into: Workers Assets (static file serving) and `wrangler.toml`'s deploy
config (custom domain, routes) are Cloudflare-specific by nature -- another
platform needs its own static-file story and its own deploy mechanism
regardless of how the request-handling code is structured.

## Regenerating the ETL outputs

`etl/` is a single Go program (`etl/main.go`, `etl/airspace.go`,
`etl/tiles.go`) that builds this app's two regenerable, offline data
artifacts. Both are dev-time-only -- nothing here runs in production, and
neither is part of any automated build (airspace boundaries change on the
order of months, basemap builds are refreshed by hand when wanted, not on
every push). Raw downloads worth caching land in `etl/data-sources/`
(gitignored); final artifacts land in `etl/output/` -- `airspace.geojson`
is small and committed there directly, `labels-vancouver-island.pmtiles` is
~200MB and gitignored.

```bash
cd etl
go build -o etl.exe .   # or just `go run .`
```

**Airspace** (`./etl.exe airspace`): downloads OpenAIP's Canada-wide export,
caches it at `etl/data-sources/openaip-ca-airspace.geojson`, trims it to the
Vancouver Island flying area, and writes `etl/output/airspace.geojson`.
Copy that into `server/public/data/airspace.geojson` and redeploy (see
**Notes** below for why it's not read directly from `etl/output/`).

**Tiles** (`./etl.exe tiles [YYYYMMDD]`): extracts the Vancouver Island bbox
out of a [Protomaps daily basemap build](https://maps.protomaps.com/builds/)
into `etl/output/labels-vancouver-island.pmtiles`, using `go-pmtiles`'s own
`Extract` function directly (`github.com/protomaps/go-pmtiles/pmtiles`) --
byte-range reads against the remote archive, nothing multi-GB downloaded
locally. Defaults to today's date, walking backward up to 10 days if
there's no build for it (Protomaps doesn't publish one every single day).
After regenerating, re-upload it (see **Live editing** step 2).

## Notes

- `server/public/app.js` and `server/public/admin/app.js` each embed a
  Google Maps Platform API key for satellite tiles, from a dedicated GCP
  project (`xisle-maps`) with the Map Tiles API and Places API (New)
  enabled and billing linked. Swap it for your own if it's ever
  rotated/revoked -- test with a direct `POST` to
  `tile.googleapis.com/v1/createSession`, which returns a clear
  `API_KEY_INVALID` if not.
- The site YAML dialect (see `server/src/siteyaml.ts`'s header comment) is a
  small hand-rolled flat-scalar format, not general YAML -- it round-trips
  exactly what R2 already holds, but wasn't built to handle arbitrary YAML.
- Both `index.html` files load their `app.js`/`style.css` with a
  `?v=<unix time>` query string. Browsers were observed holding onto a
  stale cached copy of one and not the other across edits (mismatched
  JS/CSS versions), badly enough that even a manual hard refresh didn't
  reliably fix it. Bump the relevant `?v=` value(s) (e.g. to the current
  unix time) whenever `app.js` or `style.css` changes, or a deploy can
  silently keep serving stale JS to already-open tabs.
- `server/public/data/airspace.geojson` is its own tracked copy, not read
  directly from `etl/output/` -- Workers Assets deploys whatever's
  physically in `server/public/` at `wrangler deploy` time, and the server
  has no access to a developer's local `etl/output/` at runtime. Copy the
  file over after every `etl airspace` regen, same as `app.js`/`style.css`.
