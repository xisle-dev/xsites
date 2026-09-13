// R2-backed site store -- the Worker equivalent of server/store.go's
// r2SiteStore, but simpler: Workers get a native R2 binding (env.LIVE_DATA),
// so there's no S3 SDK, no credentials, no endpoint URL at all. Same key
// layout as the Go version (sites/<id>.yaml, sites/<id>/media/<filename>),
// so the data in R2 needs no reshaping.

import { type Site, parseSiteYaml, renderSiteYaml, slugify } from "./siteyaml";

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
// straight from the URL, and while R2 keys aren't filesystem paths (so
// there's no literal traversal risk), rejecting anything but a single
// plain path segment keeps behavior identical to the Go version and
// avoids ever constructing a confusing key like "sites/../x.yaml".
function isFlatComponent(s: string): boolean {
  return s !== "" && s !== "." && s !== ".." && !/[/\\]/.test(s);
}

export async function getAllSites(bucket: R2Bucket): Promise<Site[]> {
  const sites: Site[] = [];
  let cursor: string | undefined;
  do {
    const listed: R2Objects = await bucket.list({ prefix: SITES_PREFIX, cursor });
    for (const obj of listed.objects) {
      const rest = obj.key.slice(SITES_PREFIX.length);
      if (!obj.key.endsWith(".yaml") || rest.includes("/")) continue; // a media object, not a top-level site
      const id = rest.slice(0, -".yaml".length);
      try {
        sites.push(await getSite(bucket, id));
      } catch {
        // skip anything unreadable rather than failing the whole list
      }
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return sites;
}

export async function getSite(bucket: R2Bucket, id: string): Promise<Site> {
  if (!isFlatComponent(id)) throw new SiteNotFoundError(id);
  const obj = await bucket.get(siteKey(id));
  if (!obj) throw new SiteNotFoundError(id);
  return parseSiteYaml(await obj.text(), id);
}

export async function saveSite(bucket: R2Bucket, site: Site): Promise<void> {
  if (!isFlatComponent(site.id)) throw new Error(`invalid site id "${site.id}"`);
  await bucket.put(siteKey(site.id), renderSiteYaml(site), {
    httpMetadata: { contentType: "application/x-yaml; charset=utf-8" },
  });
}

// Removes the site's YAML object and everything under its media prefix.
export async function deleteSite(bucket: R2Bucket, id: string): Promise<void> {
  if (!isFlatComponent(id)) throw new SiteNotFoundError(id);
  await bucket.delete(siteKey(id));
  const prefix = mediaPrefix(id);
  let cursor: string | undefined;
  do {
    const listed: R2Objects = await bucket.list({ prefix, cursor });
    if (listed.objects.length > 0) await bucket.delete(listed.objects.map((o) => o.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

// Mirrors the old newUniqueSiteID / today's uniqueSiteID in store.go:
// slugify the name, then try -2, -3, ... until an unused id is found.
export async function uniqueSiteId(bucket: R2Bucket, name: string): Promise<string> {
  const base = slugify(name);
  let id = base;
  for (let n = 2; ; n++) {
    const exists = await bucket.head(siteKey(id));
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

export async function saveMedia(bucket: R2Bucket, id: string, filename: string, data: ArrayBuffer | Uint8Array): Promise<void> {
  if (!isFlatComponent(id) || !isFlatComponent(filename)) throw new Error(`invalid media path for site "${id}", file "${filename}"`);
  await bucket.put(mediaKey(id, filename), data, {
    httpMetadata: { contentType: mediaContentType(filename) },
  });
}

export async function deleteMedia(bucket: R2Bucket, id: string, filename: string): Promise<void> {
  if (!isFlatComponent(id) || !isFlatComponent(filename)) throw new MediaNotFoundError(filename);
  await bucket.delete(mediaKey(id, filename));
}

export async function getMedia(bucket: R2Bucket, id: string, filename: string): Promise<R2ObjectBody> {
  if (!isFlatComponent(id) || !isFlatComponent(filename)) throw new MediaNotFoundError(filename);
  const obj = await bucket.get(mediaKey(id, filename));
  if (!obj) throw new MediaNotFoundError(filename);
  return obj;
}
