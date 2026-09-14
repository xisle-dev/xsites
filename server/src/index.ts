// xsites-editor's request handler. Deployed as a Cloudflare Worker today
// (see wrangler.toml), but written against standard Request/Response/URL
// so it's portable to Node/Deno/Bun with a thin adapter. The only
// Cloudflare-specific code in this whole file is CloudflareEnv and the two
// lines in fetch() that wrap its R2 bindings into ObjectStore instances --
// every handler below operates on Ctx (see objectstore.ts), never on a
// storage-specific type. Auth is the other platform-specific piece (see
// auth.ts): / is public, /admin and /api are gated by whatever
// Authenticator fetch() is given -- CloudflareAccessAuthenticator today.
// Replaces the old Go server (server/ pre-rewrite) entirely; see github
// issue #11 for the phased port this was built against.

import { type Site, type SiteInput, type Reference, applySiteInput, safeFileName } from "./siteyaml";
import {
  getAllSites,
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
import { publishAllSites, publishMedia, publishDeleteMedia, publishDeleteSiteMedia } from "./publish";
import { R2ObjectStore, type ObjectStore } from "./objectstore";
import { CloudflareAccessAuthenticator, type Authenticator } from "./auth";

// The raw shape Cloudflare hands fetch() -- R2 bindings plus the Access
// team domain/app audience needed to verify a request's JWT. Nothing past
// fetch() itself should reference this type.
export interface CloudflareEnv {
  LIVE_DATA: R2Bucket;
  PUBLIC_SITE: R2Bucket;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ACCESS_ALLOWED_EMAILS: string;
}

interface Ctx {
  live: ObjectStore;
  publicStore: ObjectStore;
  auth: Authenticator;
  allowedEmails: Set<string>;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function errorResponse(status: number, message: string): Response {
  return json({ error: message }, status);
}

// GET /api/sites and GET /sites.json (the latter unauthenticated, for the
// public viewer) both read this same pre-aggregated snapshot rather than
// fetching every site individually from LIVE_DATA -- safe for the
// authenticated list too, not just the public one, because every write
// handler below awaits publishAllSites before responding, so the mirror is
// always current by the time a client could plausibly re-fetch the list.
// Individual site reads/writes (GET/PUT/DELETE /api/sites/<id>) still go
// straight to LIVE_DATA, unaffected -- only the "fetch all N sites" path
// benefited from this (measured ~5s doing that individually, vs ~150ms
// for one object here).
async function readPublishedSites(ctx: Ctx): Promise<Response | null> {
  const obj = await ctx.publicStore.get("sites.json");
  if (!obj) return null;
  return new Response(obj.data, { headers: { "Content-Type": "application/json; charset=utf-8" } });
}

async function handleListSites(ctx: Ctx): Promise<Response> {
  const cached = await readPublishedSites(ctx);
  if (cached) return cached;
  // Falls back to a live aggregate only if the mirror doesn't exist yet
  // (e.g. a fresh deployment before the first save) -- normal operation
  // never reaches this branch.
  const sites = await getAllSites(ctx.live);
  sites.sort((a, b) => a.id.localeCompare(b.id));
  return json(sites);
}

async function handleSitesJson(ctx: Ctx): Promise<Response> {
  return (await readPublishedSites(ctx)) ?? json([]);
}

async function handleGetSite(ctx: Ctx, id: string): Promise<Response> {
  try {
    return json(await getSite(ctx.live, id));
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

  const id = await uniqueSiteId(ctx.live, input.name);
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
  await saveSite(ctx.live, site);
  await publishAllSites(ctx.live, ctx.publicStore);
  return json(await getSite(ctx.live, id), 201);
}

async function handleUpdateSite(ctx: Ctx, id: string, request: Request): Promise<Response> {
  let site: Site;
  try {
    site = await getSite(ctx.live, id);
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
  await saveSite(ctx.live, site);
  await publishAllSites(ctx.live, ctx.publicStore);
  return json(await getSite(ctx.live, id));
}

async function handleDeleteSite(ctx: Ctx, id: string): Promise<Response> {
  try {
    await getSite(ctx.live, id);
  } catch (err) {
    if (err instanceof SiteNotFoundError) return errorResponse(404, "not found");
    throw err;
  }
  await deleteSite(ctx.live, id);
  await publishDeleteSiteMedia(ctx.publicStore, id);
  await publishAllSites(ctx.live, ctx.publicStore);
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
    site = await getSite(ctx.live, id);
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
  await saveMedia(ctx.live, id, filename, data);
  await publishMedia(ctx.publicStore, id, filename, data);

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

  await saveSite(ctx.live, site);
  await publishAllSites(ctx.live, ctx.publicStore);
  return json(await getSite(ctx.live, id), 201);
}

async function handleUpdateMedia(ctx: Ctx, id: string, filename: string, request: Request): Promise<Response> {
  let site: Site;
  try {
    site = await getSite(ctx.live, id);
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
  await saveSite(ctx.live, site);
  await publishAllSites(ctx.live, ctx.publicStore);
  return json(await getSite(ctx.live, id));
}

async function handleDeleteMedia(ctx: Ctx, id: string, filename: string): Promise<Response> {
  let site: Site;
  try {
    site = await getSite(ctx.live, id);
  } catch (err) {
    if (err instanceof SiteNotFoundError) return errorResponse(404, "not found");
    throw err;
  }
  // Best-effort: if the underlying object is already gone, still proceed
  // to drop the reference below.
  try {
    await deleteMedia(ctx.live, id, filename);
  } catch (err) {
    if (!(err instanceof MediaNotFoundError)) throw err;
  }
  await publishDeleteMedia(ctx.publicStore, id, filename);

  site.references = site.references.filter((ref) => !ref.url.endsWith("/" + filename));
  await saveSite(ctx.live, site);
  await publishAllSites(ctx.live, ctx.publicStore);
  return json(await getSite(ctx.live, id));
}

async function handleGetMedia(ctx: Ctx, id: string, filename: string): Promise<Response> {
  try {
    const obj = await getMedia(ctx.live, id, filename);
    return new Response(obj.data, {
      headers: { "Content-Type": obj.contentType ?? "application/octet-stream" },
    });
  } catch (err) {
    if (err instanceof MediaNotFoundError) return new Response("Not found", { status: 404 });
    throw err;
  }
}

// /admin and /api are the only gated paths (see README's Live editing
// section) -- everything else (/, static assets, /sites.json, /media/*,
// /tiles/*) is intentionally public.
function requiresAuth(segments: string[]): boolean {
  return segments[0] === "admin" || segments[0] === "api";
}

async function dispatch(ctx: Ctx, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method;
  const segments = url.pathname.split("/").filter(Boolean); // ["api","sites",...] etc.

  if (segments.length === 1 && segments[0] === "sites.json" && method === "GET") {
    return await handleSitesJson(ctx);
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
  } else if (segments[0] === "media" && segments.length === 3 && method === "GET") {
    return await handleGetMedia(ctx, segments[1], segments[2]);
  } else if (segments[0] === "tiles" && method === "GET") {
    const tileResponse = await handleTileRequest(request, ctx.publicStore);
    if (tileResponse) return tileResponse;
  }

  return new Response("Not found", { status: 404 });
}

// Module-scoped, not per-request: a Worker isolate stays warm across many
// requests, and CloudflareAccessAuthenticator caches the team's JWKS
// in-instance for an hour (see auth.ts) specifically to avoid a network
// fetch on every authenticated request. Constructing a fresh authenticator
// inside fetch() would throw that cache away every single request --
// exactly what was causing a multi-second delay on every /admin and /api
// call while signed in (unauthenticated requests never hit this path at
// all, since authenticate() short-circuits before fetching JWKS when
// there's no token to verify -- which is why only the signed-in case was
// slow).
let sharedAuthenticator: CloudflareAccessAuthenticator | null = null;

export default {
  async fetch(request: Request, env: CloudflareEnv): Promise<Response> {
    if (!sharedAuthenticator) {
      sharedAuthenticator = new CloudflareAccessAuthenticator(env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD);
    }
    const ctx: Ctx = {
      live: new R2ObjectStore(env.LIVE_DATA),
      publicStore: new R2ObjectStore(env.PUBLIC_SITE),
      auth: sharedAuthenticator,
      allowedEmails: new Set(env.ACCESS_ALLOWED_EMAILS.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean)),
    };

    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);

    if (requiresAuth(segments)) {
      const identity = await ctx.auth.authenticate(request);
      if (!identity || !ctx.allowedEmails.has(identity.email.toLowerCase())) {
        return ctx.auth.challenge(request);
      }
    }

    try {
      return await dispatch(ctx, request);
    } catch (err) {
      return errorResponse(500, err instanceof Error ? err.message : String(err));
    }
  },
} satisfies ExportedHandler<CloudflareEnv>;
