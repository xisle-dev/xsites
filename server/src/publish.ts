// Mirrors live edits into the PUBLIC_SITE store (sites.json at the root,
// media at media/<id>/<filename>) so the public read-only viewer's
// GET /sites.json reflects an edit within seconds, without touching
// LIVE_DATA (and its per-site YAML parse) on every anonymous page view.
// Ports server/publish.go's publicPublisher -- but with no optional
// credentials to configure, since both stores are just ObjectStore
// instances here. See github issue #18.
//
// Best-effort like the Go version: source of truth is LIVE_DATA (see
// store.ts); a publish failure here would only delay the public mirror, not
// the edit itself, so callers can treat these as fire-and-forget.

import { type Site } from "./siteyaml";
import { getAllSites, mediaContentType } from "./store";
import type { ObjectStore } from "./objectstore";

export async function publishAllSites(live: ObjectStore, publicStore: ObjectStore): Promise<void> {
  const sites = await getAllSites(live);
  sites.sort((a, b) => a.id.localeCompare(b.id));
  await publishSites(publicStore, sites);
}

async function publishSites(store: ObjectStore, sites: Site[]): Promise<void> {
  await store.put("sites.json", JSON.stringify(sites), "application/json; charset=utf-8");
}

// Mirrors one uploaded file to media/<id>/<filename> (flat, not nested
// under sites/ the way LIVE_DATA is).
export async function publishMedia(store: ObjectStore, id: string, filename: string, data: ArrayBuffer | Uint8Array): Promise<void> {
  await store.put(`media/${id}/${filename}`, data, mediaContentType(filename));
}

export async function publishDeleteMedia(store: ObjectStore, id: string, filename: string): Promise<void> {
  await store.delete(`media/${id}/${filename}`);
}

// Removes every object under media/<id>/ -- called when a site is deleted,
// since the sites.json rewrite above only covers the site list, not its
// now-orphaned media files.
export async function publishDeleteSiteMedia(store: ObjectStore, id: string): Promise<void> {
  await store.deleteMany(await store.list(`media/${id}/`));
}
