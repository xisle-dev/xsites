// A minimal object-storage interface that store.ts, publish.ts, and
// tiles.ts depend on instead of Cloudflare's R2Bucket type directly. R2Store
// below is the only implementation today, but the interface is small and
// generic enough (get/getRange/put/delete/list/exists on string keys and
// ArrayBuffers) that an S3-compatible or local-filesystem adapter is a
// contained, isolated piece of work -- no changes needed anywhere else.
// This is the one genuinely platform-specific dependency in the whole
// server; index.ts's routing itself is plain Request/Response/URL, portable
// to any runtime that supports them.

export interface StoredObject {
  data: ArrayBuffer;
  contentType?: string;
}

export interface ObjectStore {
  get(key: string): Promise<StoredObject | null>;
  getRange(key: string, offset: number, length: number): Promise<ArrayBuffer | null>;
  put(key: string, data: ArrayBuffer | Uint8Array | string, contentType?: string): Promise<void>;
  delete(key: string): Promise<void>;
  deleteMany(keys: string[]): Promise<void>;
  // Every key with the given prefix, in no particular order. Adapters that
  // paginate internally (e.g. R2's list()) should exhaust all pages.
  list(prefix: string): Promise<string[]>;
  exists(key: string): Promise<boolean>;
}

export class R2ObjectStore implements ObjectStore {
  constructor(private bucket: R2Bucket) {}

  async get(key: string): Promise<StoredObject | null> {
    const obj = await this.bucket.get(key);
    if (!obj) return null;
    return { data: await obj.arrayBuffer(), contentType: obj.httpMetadata?.contentType };
  }

  async getRange(key: string, offset: number, length: number): Promise<ArrayBuffer | null> {
    const obj = await this.bucket.get(key, { range: { offset, length } });
    if (!obj) return null;
    return await obj.arrayBuffer();
  }

  async put(key: string, data: ArrayBuffer | Uint8Array | string, contentType?: string): Promise<void> {
    await this.bucket.put(key, data, contentType ? { httpMetadata: { contentType } } : undefined);
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }

  async deleteMany(keys: string[]): Promise<void> {
    if (keys.length > 0) await this.bucket.delete(keys);
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const listed: R2Objects = await this.bucket.list({ prefix, cursor });
      keys.push(...listed.objects.map((o) => o.key));
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
    return keys;
  }

  async exists(key: string): Promise<boolean> {
    return (await this.bucket.head(key)) !== null;
  }
}
