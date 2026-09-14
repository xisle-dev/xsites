// The live-editable site store -- same key layout as the old Go server's
// r2SiteStore (sites/<id>.yaml, sites/<id>/media/<filename>), but built
// against the ObjectStore interface (see objectstore.ts) instead of a
// storage-specific type, so swapping the backing store doesn't touch this
// file at all.

import { type Site, parseSiteYaml, renderSiteYaml, slugify } from "./siteyaml";
import type { ObjectStore } from "./objectstore";

const SITES_PREFIX = "sites/";

export class SiteNotFoundError extends Error {}
export class MediaNotFoundError extends Error {}

function siteKey(id: string): string {
  return `${SITES_PREFIX}${id}.yaml`;
}

function mediaPrefix(id: string): string {
  return `${SITES_PREFIX}${id}/media/`;
}

function mediaKey(id: string, filename: string): string {
  return `${mediaPrefix(id)}${filename}`;
}

// Same guard as server/store.go's isFlatComponent -- id/filename come
// straight from the URL, and while object-store keys aren't filesystem
// paths (so there's no literal traversal risk against most backends),
// rejecting anything but a single plain path segment keeps behavior
// identical to the Go version and avoids ever constructing a confusing key
// like "sites/../x.yaml".
function isFlatComponent(s: string): boolean {
  return s !== "" && s !== "." && s !== ".." && !/[/\\]/.test(s);
}

const textDecoder = new TextDecoder();

export async function getAllSites(store: ObjectStore): Promise<Site[]> {
  const keys = await store.list(SITES_PREFIX);
  const sites: Site[] = [];
  for (const key of keys) {
    const rest = key.slice(SITES_PREFIX.length);
    if (!key.endsWith(".yaml") || rest.includes("/")) continue; // a media object, not a top-level site
    const id = rest.slice(0, -".yaml".length);
    try {
      sites.push(await getSite(store, id));
    } catch {
      // skip anything unreadable rather than failing the whole list
    }
  }
  return sites;
}

export async function getSite(store: ObjectStore, id: string): Promise<Site> {
  if (!isFlatComponent(id)) throw new SiteNotFoundError(id);
  const obj = await store.get(siteKey(id));
  if (!obj) throw new SiteNotFoundError(id);
  return parseSiteYaml(textDecoder.decode(obj.data), id);
}

export async function saveSite(store: ObjectStore, site: Site): Promise<void> {
  if (!isFlatComponent(site.id)) throw new Error(`invalid site id "${site.id}"`);
  await store.put(siteKey(site.id), renderSiteYaml(site), "application/x-yaml; charset=utf-8");
}

// Removes the site's YAML object and everything under its media prefix.
export async function deleteSite(store: ObjectStore, id: string): Promise<void> {
  if (!isFlatComponent(id)) throw new SiteNotFoundError(id);
  await store.delete(siteKey(id));
  await store.deleteMany(await store.list(mediaPrefix(id)));
}

// Mirrors the old newUniqueSiteID / today's uniqueSiteID in store.go:
// slugify the name, then try -2, -3, ... until an unused id is found.
export async function uniqueSiteId(store: ObjectStore, name: string): Promise<string> {
  const base = slugify(name);
  let id = base;
  for (let n = 2; ; n++) {
    const exists = await store.exists(siteKey(id));
    if (!exists) return id;
    id = `${base}-${n}`;
  }
}

// Same extension -> content-type mapping as server/store.go's
// mediaContentType.
export function mediaContentType(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "pdf":
      return "application/pdf";
    case "gpx":
      return "application/gpx+xml";
    default:
      return "application/octet-stream";
  }
}

export async function saveMedia(store: ObjectStore, id: string, filename: string, data: ArrayBuffer | Uint8Array): Promise<void> {
  if (!isFlatComponent(id) || !isFlatComponent(filename)) throw new Error(`invalid media path for site "${id}", file "${filename}"`);
  await store.put(mediaKey(id, filename), data, mediaContentType(filename));
}

export async function deleteMedia(store: ObjectStore, id: string, filename: string): Promise<void> {
  if (!isFlatComponent(id) || !isFlatComponent(filename)) throw new MediaNotFoundError(filename);
  await store.delete(mediaKey(id, filename));
}

export async function getMedia(store: ObjectStore, id: string, filename: string) {
  if (!isFlatComponent(id) || !isFlatComponent(filename)) throw new MediaNotFoundError(filename);
  const obj = await store.get(mediaKey(id, filename));
  if (!obj) throw new MediaNotFoundError(filename);
  return obj;
}
