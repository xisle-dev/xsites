// xsites-editor's request handler. Deployed as a Cloudflare Worker today
// (see wrangler.toml), but written against standard Request/Response/URL
// so it's portable to Node/Deno/Bun with a thin adapter. The only
// Cloudflare-specific code in this whole file is CloudflareEnv and the line
// in fetch() that wraps its R2 binding into an ObjectStore --
// every handler below operates on Ctx (see objectstore.ts), never on a
// storage-specific type. The site is public to read; /admin and every
// write route (POST/PUT/DELETE under /api) require HTTP Basic auth against
// the ADMIN_PASSWORD secret (see requireAuth below).
// Replaces the old Go server (server/ pre-rewrite) entirely; see github
// issue #11 for the phased port this was built against.

import { type Site, type SiteInput, type Reference, applySiteInput, safeFileName } from "./siteyaml";
import {
  getSite,
  saveSite,
  deleteSite,
  uniqueSiteId,
  saveMedia,
  deleteMedia,
  getMedia,
  SiteNotFoundError,
  MediaNotFoundError,
} from "./store";
import { handleTileRequest } from "./tiles";
import { publishAllSites, publishSiteChange, publishSiteRemoval, readPublishedSites } from "./publish";
import { R2ObjectStore, type ObjectStore } from "./objectstore";

// The raw shape Cloudflare hands fetch(). DATA is the environment's one R2
// bucket: per-site YAML and media under sites/, the derived sites.json, and
// the label tiles under tiles/. Nothing past fetch() itself should
// reference this type.
export interface CloudflareEnv {
  DATA: R2Bucket;
  ASSETS: Fetcher;
  ADMIN_PASSWORD: string;
}

interface Ctx {
  store: ObjectStore;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function errorResponse(status: number, message: string): Response {
  return json({ error: message }, status);
}

// GET /api/sites and GET /sites.json (for the public viewer) both read the
// pre-aggregated sites.json rather than every site's YAML -- safe for the
// authenticated list too, because every write handler below awaits
// publishSiteChange/publishSiteRemoval before responding, so it's always
// current by the time a client could plausibly re-fetch the list. If it
// doesn't exist yet (a fresh or freshly seeded bucket), it's built from the
// YAML on the spot and stored for next time.
async function handleListSites(ctx: Ctx): Promise<Response> {
  const data = await readPublishedSites(ctx.store);
  if (data) return new Response(data, { headers: { "Content-Type": "application/json; charset=utf-8" } });
  return json(await publishAllSites(ctx.store));
}

async function handleGetSite(ctx: Ctx, id: string): Promise<Response> {
  try {
    return json(await getSite(ctx.store, id));
  } catch (err) {
    if (err instanceof SiteNotFoundError) return errorResponse(404, "not found");
    throw err;
  }
}

async function handleCreateSite(ctx: Ctx, request: Request): Promise<Response> {
  let input: SiteInput;
  try {
    input = await request.json();
  } catch {
    return errorResponse(400, "invalid JSON body");
  }
  if (input.name == null || input.name.trim() === "") return errorResponse(400, "name is required");

  const id = await uniqueSiteId(ctx.store, input.name);
  const site: Site = {
    id,
    name: "",
    area: "",
    description: "",
    hazards: "",
    latitude: 0,
    longitude: 0,
    view_latitude: 0,
    view_longitude: 0,
    view_zoom: 0,
    view_pitch: 0,
    references: [],
  };
  applySiteInput(site, input);
  // The YAML save and the sites.json update are different objects and don't
  // depend on each other's result, so they run concurrently instead of as
  // two sequential round trips. Returning the
  // in-memory site (rather than re-fetching it) skips a third: saveSite
  // writes exactly this object, and parseSiteYaml/renderSiteYaml are
  // lossless inverses of each other, so a re-read would just reconstruct
  // what's already in hand.
  await Promise.all([saveSite(ctx.store, site), publishSiteChange(ctx.store, site)]);
  return json(site, 201);
}

async function handleUpdateSite(ctx: Ctx, id: string, request: Request): Promise<Response> {
  let site: Site;
  try {
    site = await getSite(ctx.store, id);
  } catch (err) {
    if (err instanceof SiteNotFoundError) return errorResponse(404, "not found");
    throw err;
  }
  let input: SiteInput;
  try {
    input = await request.json();
  } catch {
    return errorResponse(400, "invalid JSON body");
  }
  applySiteInput(site, input);
  // See handleCreateSite: the two writes are independent, and the
  // in-memory site is already exactly what saveSite persisted.
  await Promise.all([saveSite(ctx.store, site), publishSiteChange(ctx.store, site)]);
  return json(site);
}

async function handleDeleteSite(ctx: Ctx, id: string): Promise<Response> {
  try {
    await getSite(ctx.store, id);
  } catch (err) {
    if (err instanceof SiteNotFoundError) return errorResponse(404, "not found");
    throw err;
  }
  await deleteSite(ctx.store, id);
  await publishSiteRemoval(ctx.store, id);
  return json({ ok: true });
}

// Classifies an uploaded file by extension into one of the gallery's known
// media kinds, so the UI can render it appropriately without trusting a
// client-supplied type. Empty string means "not an accepted media type" --
// mirrors server/main.go's mediaTypeForFilename exactly.
function mediaTypeForFilename(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
      return "photo";
    case "pdf":
      return "pdf";
    case "gpx":
      return "gpx";
    default:
      return "";
  }
}

interface MediaUploadBody {
  filename?: string;
  dataBase64?: string;
  description?: string;
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function handleUploadMedia(ctx: Ctx, id: string, request: Request): Promise<Response> {
  let site: Site;
  try {
    site = await getSite(ctx.store, id);
  } catch (err) {
    if (err instanceof SiteNotFoundError) return errorResponse(404, "not found");
    throw err;
  }
  let body: MediaUploadBody;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "invalid JSON body");
  }
  const filename = safeFileName(body.filename ?? "");
  const mediaType = mediaTypeForFilename(filename);
  if (mediaType === "") return errorResponse(400, "unsupported file type (use PNG, JPG, PDF, or GPX)");

  let data: Uint8Array;
  try {
    data = base64ToBytes(body.dataBase64 ?? "");
  } catch {
    return errorResponse(400, "invalid dataBase64");
  }
  await saveMedia(ctx.store, id, filename, data);

  const newRef: Reference = {
    type: mediaType,
    title: filename,
    description: body.description ?? "",
    url: `/media/${id}/${filename}`,
  };
  // Re-uploading the same filename overwrites the object above -- replace
  // its reference in place too, rather than appending a second entry that
  // would now point at the new file's content.
  const existingIndex = site.references.findIndex((r) => r.url === newRef.url);
  if (existingIndex >= 0) site.references[existingIndex] = newRef;
  else site.references.push(newRef);

  // See handleCreateSite: the two writes are independent, and the
  // in-memory site is already exactly what saveSite persisted.
  await Promise.all([saveSite(ctx.store, site), publishSiteChange(ctx.store, site)]);
  return json(site, 201);
}

async function handleUpdateMedia(ctx: Ctx, id: string, filename: string, request: Request): Promise<Response> {
  let site: Site;
  try {
    site = await getSite(ctx.store, id);
  } catch (err) {
    if (err instanceof SiteNotFoundError) return errorResponse(404, "not found");
    throw err;
  }
  let body: { description?: string };
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "invalid JSON body");
  }
  let found = false;
  for (const ref of site.references) {
    if (ref.url.endsWith("/" + filename)) {
      ref.description = body.description ?? "";
      found = true;
    }
  }
  if (!found) return errorResponse(404, "media not found");
  // See handleCreateSite: the two writes are independent, and the
  // in-memory site is already exactly what saveSite persisted.
  await Promise.all([saveSite(ctx.store, site), publishSiteChange(ctx.store, site)]);
  return json(site);
}

async function handleDeleteMedia(ctx: Ctx, id: string, filename: string): Promise<Response> {
  let site: Site;
  try {
    site = await getSite(ctx.store, id);
  } catch (err) {
    if (err instanceof SiteNotFoundError) return errorResponse(404, "not found");
    throw err;
  }
  // Best-effort: if the underlying object is already gone, still proceed
  // to drop the reference below.
  try {
    await deleteMedia(ctx.store, id, filename);
  } catch (err) {
    if (!(err instanceof MediaNotFoundError)) throw err;
  }

  site.references = site.references.filter((ref) => !ref.url.endsWith("/" + filename));
  // See handleCreateSite: the two writes are independent, and the
  // in-memory site is already exactly what saveSite persisted.
  await Promise.all([saveSite(ctx.store, site), publishSiteChange(ctx.store, site)]);
  return json(site);
}

async function handleGetMedia(ctx: Ctx, id: string, filename: string): Promise<Response> {
  try {
    const obj = await getMedia(ctx.store, id, filename);
    return new Response(obj.data, {
      headers: { "Content-Type": obj.contentType ?? "application/octet-stream" },
    });
  } catch (err) {
    if (err instanceof MediaNotFoundError) return new Response("Not found", { status: 404 });
    throw err;
  }
}

// SHA-256 both sides first so the comparison is constant-length and the
// timing doesn't leak how much of the password matched.
async function digest(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

async function passwordMatches(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([digest(given), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// HTTP Basic auth with a single shared password; the username is ignored.
// Returns a 401 challenge (which makes the browser prompt, then resend the
// credentials on every same-origin request) or null if the caller may proceed.
async function requireAuth(request: Request, env: CloudflareEnv): Promise<Response | null> {
  const header = request.headers.get("Authorization") ?? "";
  if (env.ADMIN_PASSWORD && header.startsWith("Basic ")) {
    try {
      const decoded = atob(header.slice(6));
      const password = decoded.slice(decoded.indexOf(":") + 1);
      if (await passwordMatches(password, env.ADMIN_PASSWORD)) return null;
    } catch {
      // malformed base64 -- fall through to the challenge
    }
  }
  return new Response("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="xsites admin", charset="UTF-8"' },
  });
}

function needsAuth(method: string, segments: string[]): boolean {
  if (segments[0] === "admin") return true;
  if (segments[0] === "api") return method !== "GET" && method !== "HEAD";
  return false;
}

async function dispatch(ctx: Ctx, env: CloudflareEnv, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method;
  const segments = url.pathname.split("/").filter(Boolean); // ["api","sites",...] etc.

  if (needsAuth(method, segments)) {
    const denied = await requireAuth(request, env);
    if (denied) return denied;
  }

  if (segments.length === 1 && segments[0] === "sites.json" && method === "GET") {
    return await handleListSites(ctx);
  } else if (segments[0] === "api" && segments[1] === "sites") {
    if (segments.length === 2) {
      if (method === "GET") return await handleListSites(ctx);
      if (method === "POST") return await handleCreateSite(ctx, request);
    } else if (segments.length === 3) {
      const id = segments[2];
      if (method === "GET") return await handleGetSite(ctx, id);
      if (method === "PUT") return await handleUpdateSite(ctx, id, request);
      if (method === "DELETE") return await handleDeleteSite(ctx, id);
    } else if (segments.length === 4 && segments[3] === "media") {
      if (method === "POST") return await handleUploadMedia(ctx, segments[2], request);
    } else if (segments.length === 5 && segments[3] === "media") {
      const id = segments[2];
      const filename = segments[4];
      if (method === "PUT") return await handleUpdateMedia(ctx, id, filename, request);
      if (method === "DELETE") return await handleDeleteMedia(ctx, id, filename);
    }
  } else if (segments[0] === "admin" && method === "GET") {
    // Static editor files; only reached because wrangler.toml's
    // run_worker_first routes /admin/* through this Worker for the auth check.
    return await env.ASSETS.fetch(request);
  } else if (segments[0] === "media" && segments.length === 3 && method === "GET") {
    return await handleGetMedia(ctx, segments[1], segments[2]);
  } else if (segments[0] === "tiles" && method === "GET") {
    const tileResponse = await handleTileRequest(request, ctx.store);
    if (tileResponse) return tileResponse;
  }

  return new Response("Not found", { status: 404 });
}

export default {
  async fetch(request: Request, env: CloudflareEnv): Promise<Response> {
    const ctx: Ctx = { store: new R2ObjectStore(env.DATA) };

    try {
      return await dispatch(ctx, env, request);
    } catch (err) {
      return errorResponse(500, err instanceof Error ? err.message : String(err));
    }
  },
} satisfies ExportedHandler<CloudflareEnv>;
