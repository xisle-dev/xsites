// Serves PMTiles vector tiles straight out of R2 -- the Worker equivalent
// of server/main.go's pmtiles.NewServer(tilesDir, ...), which read the same
// .pmtiles archive from local disk. Follows Protomaps' documented
// Workers+R2 pattern (byte-range reads against the archive object, no local
// file or separate tile server needed). See github issue #17.

import { PMTiles, Source, RangeResponse, Compression, TileType, ResolvedValueCache } from "pmtiles";

export interface TilesEnv {
  PUBLIC_SITE: R2Bucket;
}

// Directory/header sections of a PMTiles archive can be internally
// compressed independently of the tile data itself -- this is what the
// cache's `decompress` hook is for. Individual tile bytes are handled
// separately below via the Content-Encoding response header instead.
async function nativeDecompress(buf: ArrayBuffer, compression: Compression): Promise<ArrayBuffer> {
  if (compression === Compression.None || compression === Compression.Unknown) return buf;
  if (compression === Compression.Gzip) {
    const stream = new Response(buf).body!.pipeThrough(new DecompressionStream("gzip"));
    return await new Response(stream).arrayBuffer();
  }
  throw new Error(`unsupported PMTiles internal compression: ${compression}`);
}

// One shared cache across requests for archive headers/directories -- mirrors
// the Go server's pmtiles.NewServer(..., 64, ...) LRU entry count.
const directoryCache = new ResolvedValueCache(64, undefined, nativeDecompress);

class R2Source implements Source {
  constructor(
    private bucket: R2Bucket,
    private key: string,
  ) {}

  getKey(): string {
    return this.key;
  }

  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    const obj = await this.bucket.get(this.key, { range: { offset, length } });
    if (!obj) throw new Error(`archive not found: ${this.key}`);
    return { data: await obj.arrayBuffer() };
  }
}

function tileContentType(t: TileType): string {
  switch (t) {
    case TileType.Mvt:
      return "application/x-protobuf";
    case TileType.Png:
      return "image/png";
    case TileType.Jpeg:
      return "image/jpeg";
    case TileType.Webp:
      return "image/webp";
    case TileType.Avif:
      return "image/avif";
    default:
      return "application/octet-stream";
  }
}

// Matches /tiles/{archive}/{z}/{x}/{y}.{ext} -- {ext} is whatever the
// archive's own tile type uses (.mvt for the vector labels archive) and is
// only used to strip the suffix off {y}, not to pick the content type.
const tileUrlRe = /^\/tiles\/([^/]+)\/(\d+)\/(\d+)\/(\d+)\.[A-Za-z0-9]+$/;

export async function handleTileRequest(request: Request, env: TilesEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const match = tileUrlRe.exec(url.pathname);
  if (!match) return null;

  const [, archive, zStr, xStr, yStr] = match;
  const z = Number(zStr);
  const x = Number(xStr);
  const y = Number(yStr);

  const pmtiles = new PMTiles(new R2Source(env.PUBLIC_SITE, `tiles/${archive}.pmtiles`), directoryCache, nativeDecompress);

  let header;
  try {
    header = await pmtiles.getHeader();
  } catch {
    return new Response("archive not found", { status: 404 });
  }

  const tile = await pmtiles.getZxy(z, x, y);
  if (!tile) return new Response("tile not found", { status: 404 });

  const headers = new Headers({ "Content-Type": tileContentType(header.tileType) });
  if (header.tileCompression === Compression.Gzip) headers.set("Content-Encoding", "gzip");
  return new Response(tile.data, { headers });
}
