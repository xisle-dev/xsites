// xsites-editor Worker -- replaces server/ (Go) entirely. See github issue
// #11 for the phased port this is being built against.

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

export interface Env {
  LIVE_DATA: R2Bucket;
  PUBLIC_SITE: R2Bucket;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function errorResponse(status: number, message: string): Response {
  return json({ error: message }, status);
}

async function handleListSites(env: Env): Promise<Response> {
  const sites = await getAllSites(env.LIVE_DATA);
  sites.sort((a, b) => a.id.localeCompare(b.id));
  return json(sites);
}

async function handleGetSite(env: Env, id: string): Promise<Response> {
  try {
    return json(await getSite(env.LIVE_DATA, id));
  } catch (err) {
    if (err instanceof SiteNotFoundError) return errorResponse(404, "not found");
    throw err;
  }
}

async function handleCreateSite(env: Env, request: Request): Promise<Response> {
  let input: SiteInput;
  try {
    input = await request.json();
  } catch {
    return errorResponse(400, "invalid JSON body");
  }
  if (input.name == null || input.name.trim() === "") return errorResponse(400, "name is required");

  const id = await uniqueSiteId(env.LIVE_DATA, input.name);
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
  await saveSite(env.LIVE_DATA, site);
  await publishAllSites(env.LIVE_DATA, env.PUBLIC_SITE);
  return json(await getSite(env.LIVE_DATA, id), 201);
}

async function handleUpdateSite(env: Env, id: string, request: Request): Promise<Response> {
  let site: Site;
  try {
    site = await getSite(env.LIVE_DATA, id);
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
  await saveSite(env.LIVE_DATA, site);
  await publishAllSites(env.LIVE_DATA, env.PUBLIC_SITE);
  return json(await getSite(env.LIVE_DATA, id));
}

async function handleDeleteSite(env: Env, id: string): Promise<Response> {
  try {
    await getSite(env.LIVE_DATA, id);
  } catch (err) {
    if (err instanceof SiteNotFoundError) return errorResponse(404, "not found");
    throw err;
  }
  await deleteSite(env.LIVE_DATA, id);
  await publishDeleteSiteMedia(env.PUBLIC_SITE, id);
  await publishAllSites(env.LIVE_DATA, env.PUBLIC_SITE);
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

async function handleUploadMedia(env: Env, id: string, request: Request): Promise<Response> {
  let site: Site;
  try {
    site = await getSite(env.LIVE_DATA, id);
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
  await saveMedia(env.LIVE_DATA, id, filename, data);
  await publishMedia(env.PUBLIC_SITE, id, filename, data);

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

  await saveSite(env.LIVE_DATA, site);
  await publishAllSites(env.LIVE_DATA, env.PUBLIC_SITE);
  return json(await getSite(env.LIVE_DATA, id), 201);
}

async function handleUpdateMedia(env: Env, id: string, filename: string, request: Request): Promise<Response> {
  let site: Site;
  try {
    site = await getSite(env.LIVE_DATA, id);
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
  await saveSite(env.LIVE_DATA, site);
  await publishAllSites(env.LIVE_DATA, env.PUBLIC_SITE);
  return json(await getSite(env.LIVE_DATA, id));
}

async function handleDeleteMedia(env: Env, id: string, filename: string): Promise<Response> {
  let site: Site;
  try {
    site = await getSite(env.LIVE_DATA, id);
  } catch (err) {
    if (err instanceof SiteNotFoundError) return errorResponse(404, "not found");
    throw err;
  }
  // Best-effort: if the underlying object is already gone, still proceed
  // to drop the reference below.
  try {
    await deleteMedia(env.LIVE_DATA, id, filename);
  } catch (err) {
    if (!(err instanceof MediaNotFoundError)) throw err;
  }
  await publishDeleteMedia(env.PUBLIC_SITE, id, filename);

  site.references = site.references.filter((ref) => !ref.url.endsWith("/" + filename));
  await saveSite(env.LIVE_DATA, site);
  await publishAllSites(env.LIVE_DATA, env.PUBLIC_SITE);
  return json(await getSite(env.LIVE_DATA, id));
}

async function handleGetMedia(env: Env, id: string, filename: string): Promise<Response> {
  try {
    const obj = await getMedia(env.LIVE_DATA, id, filename);
    return new Response(obj.body, {
      headers: { "Content-Type": obj.httpMetadata?.contentType ?? "application/octet-stream" },
    });
  } catch (err) {
    if (err instanceof MediaNotFoundError) return new Response("Not found", { status: 404 });
    throw err;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const segments = url.pathname.split("/").filter(Boolean); // ["api","sites",...] etc.

    try {
      if (segments[0] === "api" && segments[1] === "sites") {
        if (segments.length === 2) {
          if (method === "GET") return await handleListSites(env);
          if (method === "POST") return await handleCreateSite(env, request);
        } else if (segments.length === 3) {
          const id = segments[2];
          if (method === "GET") return await handleGetSite(env, id);
          if (method === "PUT") return await handleUpdateSite(env, id, request);
          if (method === "DELETE") return await handleDeleteSite(env, id);
        } else if (segments.length === 4 && segments[3] === "media") {
          if (method === "POST") return await handleUploadMedia(env, segments[2], request);
        } else if (segments.length === 5 && segments[3] === "media") {
          const id = segments[2];
          const filename = segments[4];
          if (method === "PUT") return await handleUpdateMedia(env, id, filename, request);
          if (method === "DELETE") return await handleDeleteMedia(env, id, filename);
        }
      } else if (segments[0] === "media" && segments.length === 3 && method === "GET") {
        return await handleGetMedia(env, segments[1], segments[2]);
      } else if (segments[0] === "tiles" && method === "GET") {
        const tileResponse = await handleTileRequest(request, env);
        if (tileResponse) return tileResponse;
      }
    } catch (err) {
      return errorResponse(500, err instanceof Error ? err.message : String(err));
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
