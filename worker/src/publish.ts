// Mirrors live edits into the PUBLIC_SITE bucket in buildstatic's exact key
// shape (sites.json at the bucket root, media at media/<id>/<filename>) so
// an edit is visible on the public static site within seconds, instead of
// waiting on the GitHub Actions rebuild. Ports server/publish.go's
// publicPublisher -- but with no optional credentials to configure: Workers
// get PUBLIC_SITE as a plain R2 binding, the same as LIVE_DATA, so this
// always runs rather than being a conditional no-op. See github issue #18.
//
// Best-effort like the Go version: source of truth is LIVE_DATA (see
// store.ts); a publish failure here would only delay the public mirror, not
// the edit itself, so callers can treat these as fire-and-forget.

import { type Site } from "./siteyaml";
import { getAllSites, mediaContentType } from "./store";

export async function publishAllSites(live: R2Bucket, publicBucket: R2Bucket): Promise<void> {
  const sites = await getAllSites(live);
  sites.sort((a, b) => a.id.localeCompare(b.id));
  await publishSites(publicBucket, sites);
}

// buildstatic writes this same file in this same shape (JSON array of
// Site, field order matching the Go struct) -- the static viewer needs no
// changes to read whichever one is newer.
async function publishSites(bucket: R2Bucket, sites: Site[]): Promise<void> {
  await bucket.put("sites.json", JSON.stringify(sites), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
}

// Mirrors one uploaded file to media/<id>/<filename>, matching buildstatic's
// copyMedia layout (flat under media/, not nested under sites/ the way the
// live-data bucket is).
export async function publishMedia(bucket: R2Bucket, id: string, filename: string, data: ArrayBuffer | Uint8Array): Promise<void> {
  await bucket.put(`media/${id}/${filename}`, data, {
    httpMetadata: { contentType: mediaContentType(filename) },
  });
}

export async function publishDeleteMedia(bucket: R2Bucket, id: string, filename: string): Promise<void> {
  await bucket.delete(`media/${id}/${filename}`);
}

// Removes every object under media/<id>/ -- called when a site is deleted,
// since the sites.json rewrite above only covers the site list, not its
// now-orphaned media files.
export async function publishDeleteSiteMedia(bucket: R2Bucket, id: string): Promise<void> {
  const prefix = `media/${id}/`;
  let cursor: string | undefined;
  do {
    const listed: R2Objects = await bucket.list({ prefix, cursor });
    if (listed.objects.length > 0) await bucket.delete(listed.objects.map((o) => o.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}
