// Keeps sites.json -- every site in one JSON array, at the bucket root next
// to the per-site YAML under sites/ -- current on every save, so the list
// views (GET /sites.json for the public viewer, GET /api/sites for the
// editor) read one object instead of parsing every site's YAML. Measured
// ~150ms for the one object vs ~5s for 63 individual reads.
//
// sites.json is purely derived: if it's missing or unreadable it's rebuilt
// from the YAML (see publishAllSites), so deleting it is always safe.

import { type Site } from "./siteyaml";
import { getAllSites } from "./store";
import type { ObjectStore } from "./objectstore";

const SITES_JSON = "sites.json";
const textDecoder = new TextDecoder();

export async function publishAllSites(store: ObjectStore): Promise<Site[]> {
  const sites = await getAllSites(store);
  sites.sort((a, b) => a.id.localeCompare(b.id));
  await writeSites(store, sites);
  return sites;
}

async function writeSites(store: ObjectStore, sites: Site[]): Promise<void> {
  await store.put(SITES_JSON, JSON.stringify(sites), "application/json; charset=utf-8");
}

// The current sites.json bytes, or null if it doesn't exist yet.
export async function readPublishedSites(store: ObjectStore): Promise<ArrayBuffer | null> {
  const obj = await store.get(SITES_JSON);
  return obj ? obj.data : null;
}

async function readPublishedSiteList(store: ObjectStore): Promise<Site[] | null> {
  const data = await readPublishedSites(store);
  if (!data) return null;
  try {
    return JSON.parse(textDecoder.decode(data)) as Site[];
  } catch {
    return null; // corrupt snapshot -- treat the same as missing
  }
}

// Patches one created/updated site into sites.json instead of rebuilding it
// from every site's YAML the way publishAllSites does (~2.5s against 85
// sites, just to change one entry). Falls back to publishAllSites if the
// current snapshot is missing or unreadable, so it self-heals.
export async function publishSiteChange(store: ObjectStore, site: Site): Promise<void> {
  const current = await readPublishedSiteList(store);
  if (current == null) {
    await publishAllSites(store);
    return;
  }
  const next = current.filter((s) => s.id !== site.id);
  next.push(site);
  next.sort((a, b) => a.id.localeCompare(b.id));
  await writeSites(store, next);
}

// Same idea as publishSiteChange, for a deleted site.
export async function publishSiteRemoval(store: ObjectStore, id: string): Promise<void> {
  const current = await readPublishedSiteList(store);
  if (current == null) {
    await publishAllSites(store);
    return;
  }
  await writeSites(
    store,
    current.filter((s) => s.id !== id),
  );
}
