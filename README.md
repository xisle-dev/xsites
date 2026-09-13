# X/Sites

A MapLibre GL map of Vancouver Island paragliding launch sites: Google satellite
imagery draped over AWS's global DEM for 3D terrain, vector place/road labels
from a local Protomaps basemap extract, and a CRUD UI (backed by a Cloudflare
Worker) for managing the site database.

## Architecture

The app ships in two independent modes that share the same map code and data
format but nothing at runtime:

- **Dynamic** — a Cloudflare Worker (`worker/`) serving a public read-only
  viewer at `/` and the full read/write CRUD editor at `/admin` (only
  `/admin` and `/api` sit behind Cloudflare Access -- see **Live editing
  (Cloudflare Workers)** below). Site data and media live in a Cloudflare
  R2 bucket, read/written directly via a native R2 binding (no S3 SDK, no
  credentials in the data path).
- **Static** — a *separate* read-only mirror (`static/` + `tools/buildstatic`)
  deployed to the same public R2 bucket the Worker's own public viewer reads
  from, rebuilt and synced automatically on every push via GitHub Actions.
  This exists independently of the Worker's `/` route above -- a fully
  static, CDN-cacheable fallback that needs no Worker at all (e.g. for a
  separate hostname or a disaster-recovery mirror), sharing the same bucket
  and `sites.json`/`media/*` shape by design. Since the Worker publishes
  straight into this same bucket on every save (see **Instant publish**),
  both the Worker's own `/` and this static mirror reflect an edit within
  seconds, without waiting on a GitHub Actions run.

Everything -- compute, storage, DNS, and auth -- runs on Cloudflare. There is
no other cloud provider involved; an earlier iteration of the dynamic mode
ran as a Go server on Google Cloud Run (see github issue #11 for why it was
replaced: mainly that IAP's OAuth setup can't be scripted for a personal
Google account, forcing manual Console click-through on every fresh setup).

### Map rendering (both modes)

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
  upright at any bearing, unlike Google's raster labels. The two modes read
  the same `.pmtiles` archive differently:
  - *Dynamic*: served straight out of the `.pmtiles` archive in R2 by the
    Worker (`worker/src/tiles.ts`), using the `pmtiles` npm package's
    documented Workers+R2 pattern -- byte-range reads directly against the
    archive object, no separate tile server.
  - *Static*: read directly out of the `.pmtiles` archive in the (public) R2
    bucket via HTTP range requests, using the `pmtiles` JS library's own
    `pmtiles://` protocol handler client-side — no server involved at all.
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
- **Glide range tool**: click anywhere on the map to draw terrain-aware glide
  range bands (1:1 through 1:10) radiating from that point, computed by
  ray-marching outward along 72 bearings and sampling the DEM at each step
  until height above terrain drops below what the ratio allows, then
  bisecting between the last-safe and first-failing distance for a clean
  edge. Hovering after a click shows the exact decimal glide ratio required
  to reach the cursor. Click elsewhere (or the same point) to clear it.
- **URL state**: the selected site, camera position, search/area filters, and
  airspace visibility are all reflected in the URL query string as they
  change, so any view is bookmarkable/shareable and back/forward-navigable.
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

Each launch site is one record covering name, area, description/hazards
(rich text), lat/lon, elevation, a saved camera preset for "Fly here", and a
list of reference links (photos, PDFs, GPX tracks). The two modes read it
from different places:

- **Dynamic mode's live source of truth** is a Cloudflare R2 bucket
  (`worker/src/store.ts`), one object per site at `sites/<id>.yaml` plus
  media at `sites/<id>/media/<filename>`, using the same small hand-rolled
  flat-scalar YAML dialect described below. All reads and writes from the
  Worker editor go here, via a native R2 binding -- there's no local disk
  and no S3-style credentials involved.
- **`sites/<id>.yaml` in this repo** (plus `sites/<id>/media/*` alongside)
  is that same flat-scalar YAML dialect (not general YAML; see
  `worker/src/siteyaml.ts`'s header comment), and is what `tools/buildstatic`
  reads for the static build. Once the R2 store is the real editor's
  backend, these files are a point-in-time snapshot, not a live mirror of
  R2 -- don't expect them to stay in sync with real edits made through the
  deployed editor.

### Dynamic mode

`worker/src/index.ts` is a single Cloudflare Worker serving (via Workers
Assets):

- `worker/public/` at `/` — a public, unauthenticated read-only viewer
  (adapted from `static/`'s app, see **Static mode** below), reading site
  data from `GET /sites.json` (the same object the instant-publish mirror
  keeps current, not a live `/api/sites` call) and labels from the Worker's
  own `/tiles/*` route.
- `worker/public/admin/` at `/admin` — the full read/write CRUD editor.

`/api/sites` (CRUD JSON), `/media/<id>/<file>` (site photos), and `/tiles/*`
(vector tiles read straight out of R2) are also part of the Worker; the
public viewer above only ever hits the latter two. `/admin` and `/api` are
the only paths gated by Cloudflare Access (email one-time-PIN, no external
identity provider) -- see **Live editing (Cloudflare Workers)** below.

Every write also best-effort mirrors into the *public* static-site bucket
(`worker/src/publish.ts`) so edits show up on the live site immediately --
see **Instant publish**.

### Static mode

`tools/buildstatic` assembles a complete, self-contained static site with no
server-side dependency: it reads `sites/*.yaml` into one `sites.json`, copies
site media, and copies the hand-authored `static/index.html` +
`static/app.js` (structurally simpler than the dynamic app — no CRUD forms,
no auth, no write paths) plus the assets shared with the dynamic mode
(`style.css`, `favicon.svg`, `logo.svg`, `data/airspace.geojson`) into
`dist/`. It intentionally re-implements (rather than imports) the read side
of the site YAML format, since it deploys independently from the Worker and
duplicating that ~80-line parser is a smaller risk than coupling this tool's
build to the Worker's TypeScript.

`.github/workflows/deploy-r2.yml` runs `tools/buildstatic` and syncs the
result to a Cloudflare R2 bucket (via the AWS CLI against R2's
S3-compatible endpoint) on every push to `master`, or on demand — see
**Deploy** below. The `.pmtiles` label archive is excluded from that sync
(it's large and only changes when the tile extract is regenerated) and is
uploaded to the bucket by hand instead.

## Running it

The dynamic editor is a Cloudflare Worker; run it locally with Wrangler,
against real R2 buckets (no local-disk mode, unlike the old Go server):

```bash
cd worker
npm install
npm run dev   # wrangler dev --remote
```

Then open http://127.0.0.1:8787. This needs `wrangler login` once, and
access to the `xsites-live-data` / `xsites` R2 buckets on the Cloudflare
account (see below).

To just preview the static/read-only build locally instead (no R2 access
needed, reads local `sites/*.yaml`):

```powershell
cd tools/buildstatic
go build -o buildstatic .
./buildstatic ../.. ../../dist
cd ../localserve
go build -o localserve .
./localserve -dir=../../dist -port=8934
```

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
   truth) and `xsites` (the public static site's bucket, also used for the
   instant-publish mirror and the PMTiles archive). Both are declared as
   native bindings in `worker/wrangler.toml` -- no separate credentials
   needed for the Worker to read/write them.
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
   protect the whole hostname instead.
6. **Set up instant publish** -- nothing extra to do here; `worker/src/publish.ts`
   always mirrors into the `xsites` bucket via its own R2 binding, unlike the
   old Cloud Run setup which needed a second set of credentials to make this
   optional.

### Applying updates

```bash
cd worker
npx wrangler deploy
```

Wrangler re-uploads changed static assets (`worker/public/`) and the Worker
script together; no image build, no container registry.

### Instant publish

`worker/src/publish.ts` mirrors every save straight into the public
static-site bucket (in the exact `sites.json` / `media/<id>/<file>` shape
`tools/buildstatic` produces), so an edit is live on the public site within
seconds instead of waiting on a GitHub Actions run. Because `PUBLIC_SITE` is
just another R2 binding (not a separate set of credentials the way the old
Cloud Run setup needed), this always runs -- there's no "not configured yet"
state to worry about.

Because of this, `.github/workflows/deploy-r2.yml`'s sync excludes
`sites.json` and `media/*` from its `--delete` scope -- without that, a
routine code-only deploy would wipe out whatever the editor most recently
published.

## Deploy (static site)

This section covers the static mode's deploy to Cloudflare R2, which is
fully automated via GitHub Actions.

### Initial setup (static site)

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
   `aws s3 sync dist/ s3://<bucket> --delete --exclude "*.pmtiles" --exclude "sites.json" --exclude "media/*"`
   against the R2 endpoint (the last two excludes are so this doesn't
   clobber whatever the Worker editor's instant-publish most recently
   wrote -- see **Instant publish** above).
8. **Verify** — open the bucket's public URL (or custom domain) and confirm
   the map, sites, and airspace overlay all load.

### Applying updates (static site)

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
https://maps.protomaps.com/builds/. After regenerating, re-upload it to both
R2 buckets (see **Live editing** step 2 and **Deploy** step 6).

## Notes

- `app.js` embeds a Google Maps Platform API key for satellite tiles. It's
  the same key already used in a couple of sibling projects on this machine;
  swap it for your own if it's ever rotated/revoked.
- `sites/*.yaml` is a small hand-rolled flat-scalar YAML format (see
  `worker/src/siteyaml.ts`'s header comment), not general YAML — it
  round-trips exactly what's already in this repo, but wasn't built to
  handle arbitrary YAML.
- `index.html`/`static/index.html` load `app.js`/`style.css` with a
  `?v=<unix time>` query string. Browsers were observed holding onto a
  stale cached copy of one and not the other across edits (mismatched
  JS/CSS versions), badly enough that even a manual hard refresh didn't
  reliably fix it. Bump both `?v=` values (e.g. to the current unix time)
  whenever `app.js` or `style.css` changes.
- `worker/public/` (the public read-only viewer, adapted from `static/`)
  and `worker/public/admin/` (the full editor, copied from the repo root)
  are their own files, not symlinks -- editing `app.js`/`style.css`/etc. at
  the repo root or in `static/` doesn't automatically update them. Copy the
  changed file(s) into the matching `worker/public/` location (and bump its
  own `?v=`) before running `wrangler deploy`.
