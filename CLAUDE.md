# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

X/Sites: a MapLibre GL map of Vancouver Island paragliding launch sites plus a CRUD editor. See `README.md` for the full write-up; the essentials are below.

## Commands

DEV (`dev/`, Go, no Node needed):

```bash
go run ./dev        # http://localhost:8787, /admin/ needs no password; live-reloads server/public
```

Serves `server/public` directly, site data from `dev/data/` (gitignored, seeded from the `backup` branch on first run), tiles from `etl/output/*.pmtiles`. Its API (`dev/api.go`, `dev/siteyaml.go`) is a Go port of the Worker -- **change it in step with `server/src/` routes and `siteyaml.ts`**. The `xsite` entry in `.claude/launch.json` starts it for previews.

Server (`server/`, Cloudflare Worker + static assets):

```bash
cd server
npm install
npm run typecheck   # tsc --noEmit — the only check; there is no test suite or linter
```

Deploys only via the Deploy workflow: merge to `master` -> QA; Run workflow on `master` -> PROD (approval); on a `prod-*` tag -> PROD rollback to that version (approval); on another branch/tag -> QA. Each successful deploy is tagged `qa-`/`prod-YYYYMMDD-HHMMSS`. It also fetches the latest airspace (falling back to the committed copy), fills in missing tiles (vs `etl/tiles-date.txt`) and, into an empty bucket, sites from the `backup` branch. The Update workflow bumps `etl/tiles-date.txt` via a PR.

ETL (`etl/`, Go, offline dev-time only):

```bash
cd etl
go run . airspace          # OpenAIP -> etl/output/airspace.geojson
go run . tiles [YYYYMMDD]  # Protomaps extract -> etl/output/labels-vancouver-island.pmtiles (~200MB, gitignored)
go run . tiles-latest      # newest Protomaps build date
```

Setup (`setup/`, Go, run once per account or to rotate credentials):

```bash
cd setup
go run . -deploy   # needs CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_BOOTSTRAP_TOKEN, ADMIN_PASSWORD_QA/_PROD; gh auth
```

Builds both environments (QA and PROD): Cloudflare tokens, R2 buckets, GitHub environments and every secret the workflows in `.github/workflows/` need -- see README "QA and PROD" and "GitHub Actions".

## Architecture

One Worker (`server/src/index.ts`) serves everything; `server/public/` is the sole source of truth for served static files.

- `/` — public read-only viewer (`public/app.js`), reads `GET /sites.json` (a published snapshot, not `/api/sites`).
- `/admin` — full editor (`public/admin/app.js`). `/admin` and all writes under `/api` require HTTP Basic auth (any username, password = `ADMIN_PASSWORD` secret) via `requireAuth` in `index.ts`. `run_worker_first` in `wrangler.toml` is what routes those through the Worker before assets.
- Two environments in `wrangler.toml`: PROD (top level, `xsites-prod`, xisle.net, bucket `xsites-prod`) and `[env.qa]` (`xsites-qa`, qa.xisle.net, bucket `xsites-qa`).
- One R2 bucket per environment, bound as `DATA`: authoritative per-site YAML at `sites/<id>.yaml`, media at `sites/<id>/media/<file>`, the derived `sites.json`, and the `.pmtiles` label archive under `tiles/`.
- `publish.ts` rewrites `sites.json` on every save so list views read one object instead of parsing every YAML; it's rebuilt from the YAML if missing.
- `tiles.ts` serves vector label tiles via byte-range reads on `tiles/<archive>.pmtiles` in R2 (`pmtiles` package).
- `store.ts`, `publish.ts`, `tiles.ts` depend on the `ObjectStore` interface (`objectstore.ts`), not R2 directly.
- `siteyaml.ts` is a hand-rolled flat-scalar YAML dialect, **not** general YAML; read its header comment before changing the site format.

Frontend has no bundler: `app.js` files are plain ES modules using MapLibre GL loaded from jsdelivr. Satellite imagery is Google 2D tiles via a custom `gtiles://` protocol (API key embedded in both `app.js` files); terrain uses two separate raster-dem sources on the same AWS tiles (one for hillshade, one for `setTerrain`) — don't merge them; labels are text-only Protomaps symbol layers.

## Gotchas

- Bump the `?v=<unix time>` query on `app.js`/`style.css` in both `index.html` files whenever those change, or browsers serve stale JS/CSS.
- `server/public/data/airspace.geojson` is a tracked copy used by DEV and as Deploy's fallback; Deploy overwrites it with a fresh `etl airspace` before every deploy (refresh it by hand: `etl airspace`, then copy `etl/output/airspace.geojson` over it).
- The `.pmtiles` reaches QA/PROD R2 only through Deploy, which rebuilds it when `etl/tiles-date.txt` is newer than the bucket's `tiles/labels-vancouver-island.date`.
- Site markers: name labels are a second, independent MapLibre `Marker` anchored to the pin's coordinate, deliberately not a child of the pin element.
- The site list is fetched before constructing the `Map` and rendered without waiting for the `load` event, so a slow basemap doesn't leave the sidebar empty.

## Reply style

- Keep replies terse.
- Break into small sections, in bullet form, easy to read.
