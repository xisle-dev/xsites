# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

X/Sites: a MapLibre GL map of Vancouver Island paragliding launch sites plus a CRUD editor. See `README.md` for the full write-up; the essentials are below.

## Commands

Server (`server/`, Cloudflare Worker + static assets):

```bash
cd server
npm install
npm run dev         # wrangler dev --remote --env qa, http://127.0.0.1:8787, QA buckets (needs `wrangler login`)
npm run typecheck   # tsc --noEmit — the only check; there is no test suite or linter
npx wrangler deploy # PROD; add --env qa for QA. Normally done by .github/workflows/deploy.yml, not by hand
npx wrangler secret put ADMIN_PASSWORD
```

`dev` runs against the **real** R2 buckets (`--remote`); there is no local-disk mode. The `xsite` entry in `.claude/launch.json` starts this for previews.

ETL (`etl/`, Go, offline dev-time only):

```bash
cd etl
go run . airspace          # OpenAIP -> etl/output/airspace.geojson
go run . tiles [YYYYMMDD]  # Protomaps extract -> etl/output/labels-vancouver-island.pmtiles (~200MB, gitignored)
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
- Two environments in `wrangler.toml`: PROD (top level, `xsites-editor`, xisle.net) and `[env.qa]` (`xsites-editor-qa`, qa.xisle.net, buckets suffixed `-qa`). Bucket names below are PROD's.
- Two R2 buckets bound in `wrangler.toml`: `LIVE_DATA` (`xsites-live-data`, authoritative per-site YAML at `sites/<id>.yaml`, media at `sites/<id>/media/<file>`) and `PUBLIC_SITE` (`xsites`, holds the published `sites.json`, `media/<id>/<file>`, and the `.pmtiles` label archive).
- `publish.ts` mirrors every save from LIVE_DATA into PUBLIC_SITE so anonymous views never touch/parse the YAML store.
- `tiles.ts` serves vector label tiles via byte-range reads on the `.pmtiles` object in R2 (`pmtiles` package).
- `store.ts`, `publish.ts`, `tiles.ts` depend on the `ObjectStore` interface (`objectstore.ts`), not R2 directly.
- `siteyaml.ts` is a hand-rolled flat-scalar YAML dialect, **not** general YAML; read its header comment before changing the site format.

Frontend has no bundler: `app.js` files are plain ES modules using MapLibre GL loaded from jsdelivr. Satellite imagery is Google 2D tiles via a custom `gtiles://` protocol (API key embedded in both `app.js` files); terrain uses two separate raster-dem sources on the same AWS tiles (one for hillshade, one for `setTerrain`) — don't merge them; labels are text-only Protomaps symbol layers.

## Gotchas

- Bump the `?v=<unix time>` query on `app.js`/`style.css` in both `index.html` files whenever those change, or browsers serve stale JS/CSS.
- `server/public/data/airspace.geojson` is a tracked copy; after `etl airspace`, copy `etl/output/airspace.geojson` over it manually and redeploy.
- The `.pmtiles` is uploaded per environment by the Tiles workflow; by hand it's `npx wrangler r2 object put <xsites|xsites-qa>/tiles/labels-vancouver-island.pmtiles --file=... --remote` (`--remote` is required or it writes to local simulated storage).
- Site markers: name labels are a second, independent MapLibre `Marker` anchored to the pin's coordinate, deliberately not a child of the pin element.
- The site list is fetched before constructing the `Map` and rendered without waiting for the `load` event, so a slow basemap doesn't leave the sidebar empty.

## Reply style

- Keep replies terse.
- Break into small sections, in bullet form, easy to read.
