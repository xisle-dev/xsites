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

const textDecoder = new TextDecoder();

export async function publishAllSites(live: ObjectStore, publicStore: ObjectStore): Promise<void> {
  const sites = await getAllSites(live);
  sites.sort((a, b) => a.id.localeCompare(b.id));
  await publishSites(publicStore, sites);
}

async function publishSites(store: ObjectStore, sites: Site[]): Promise<void> {
  await store.put("sites.json", JSON.stringify(sites), "application/json; charset=utf-8");
}

async function readPublishedSites(store: ObjectStore): Promise<Site[] | null> {
  const obj = await store.get("sites.json");
  if (!obj) return null;
  try {
    return JSON.parse(textDecoder.decode(obj.data)) as Site[];
  } catch {
    return null; // corrupt snapshot -- treat the same as missing
  }
}

// Patches one created/updated site into the published sites.json instead
// of rebuilding it from every site in LIVE_DATA the way publishAllSites
// does. With dozens of sites, that full re-fetch (even parallelized -- see
// getAllSites) was the dominant cost of a save: ~2.5s of it measured
// against 85 sites, just to regenerate a snapshot where only one entry
// actually changed. Falls back to publishAllSites if the current mirror
// is missing or unreadable, so a broken/absent snapshot still self-heals
// rather than staying broken.
export async function publishSiteChange(live: ObjectStore, publicStore: ObjectStore, site: Site): Promise<void> {
  const current = await readPublishedSites(publicStore);
  if (current == null) {
    await publishAllSites(live, publicStore);
    return;
  }
  const next = current.filter((s) => s.id !== site.id);
  next.push(site);
  next.sort((a, b) => a.id.localeCompare(b.id));
  await publishSites(publicStore, next);
}

// Same idea as publishSiteChange, for a deleted site.
export async function publishSiteRemoval(live: ObjectStore, publicStore: ObjectStore, id: string): Promise<void> {
  const current = await readPublishedSites(publicStore);
  if (current == null) {
    await publishAllSites(live, publicStore);
    return;
  }
  await publishSites(
    publicStore,
    current.filter((s) => s.id !== id),
  );
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
