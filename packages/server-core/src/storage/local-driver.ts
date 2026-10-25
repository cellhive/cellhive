import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, type ReadStream } from 'node:fs';
import { access, constants, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { AppError } from '../errors/app-error.js';

import { contentDisposition } from './content-disposition.js';
import {
  deriveLocalSigningKey,
  LOCAL_STORAGE_ROUTE,
  localGrantQuery,
  verifyLocalRequest,
  type LocalGrant,
  type LocalVerifyResult,
} from './local-signing.js';
import { assertValidExpiry, assertValidStorageKey } from './storage-key.js';

import type {
  PutObjectOptions,
  PutStreamOptions,
  PresignedRequest,
  PresignGetOptions,
  PresignPutOptions,
  StorageDriver,
  StoredObjectInfo,
} from './storage-driver.js';

export interface LocalStorageDriverOptions {
  /** Root directory (STORAGE_LOCAL_PATH). */
  readonly root: string;
  /** Origin + optional path that routes `/api/v1/…` to this API (PUBLIC_URL). */
  readonly publicUrl: string;
  /** SESSION_SECRET; the URL signing key is derived from it. */
  readonly sessionSecret: string;
  /** Clock in milliseconds, injectable for tests. */
  readonly now?: () => number;
}

interface ObjectMeta {
  readonly content_type: string;
  readonly size: number;
  readonly etag: string;
  readonly uploaded_at: string;
}

export interface LocalObjectStream {
  readonly stream: ReadStream;
  readonly size: number;
  readonly contentType: string;
  readonly etag: string;
}

/** Counts bytes and fails with 413 as soon as the limit is exceeded. */
function byteLimit(maxBytes: number, onChunk: (chunk: Buffer) => void): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) {
        callback(
          new AppError('PAYLOAD_TOO_LARGE', {
            detail: `The upload exceeds the allowed size of ${String(maxBytes)} bytes.`,
          }),
        );
        return;
      }
      onChunk(chunk);
      callback(null, chunk);
    },
  });
}

function isNotFound(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ENOENT';
}

/**
 * Files on a local volume (profile `minimal`, ADR-0016). Upload and download
 * URLs point at the API itself and carry an HMAC signature
 * (`local-signing.ts`); `apps/api` serves them.
 *
 * Layout under `root`: `objects/<key>`, `meta/<key>.json` (content type, size,
 * ETag) and `tmp/` for uploads in progress, which are renamed into place only
 * once complete.
 */
export class LocalStorageDriver implements StorageDriver {
  readonly kind = 'local' as const;
  private readonly root: string;
  private readonly baseUrl: string;
  private readonly signingKey: Buffer;
  private readonly now: () => number;

  constructor(options: LocalStorageDriverOptions) {
    this.root = resolve(options.root);
    this.baseUrl = `${options.publicUrl.replace(/\/+$/, '')}${LOCAL_STORAGE_ROUTE}`;
    this.signingKey = deriveLocalSigningKey(options.sessionSecret);
    this.now = options.now ?? Date.now;
  }

  presignPut(key: string, options: PresignPutOptions): Promise<PresignedRequest> {
    // The executor turns validation errors into a rejected promise.
    return new Promise((resolve) => {
      assertValidStorageKey(key);
      assertValidExpiry(options.expiresIn);
      const expiresAt = this.nowSeconds() + options.expiresIn;
      const grant: LocalGrant = {
        method: 'PUT',
        key,
        expiresAt,
        contentType: options.contentType,
        maxBytes: Math.min(options.maxBytes, options.contentLength ?? options.maxBytes),
      };
      resolve({
        method: 'PUT',
        url: this.urlFor(grant),
        headers: { 'content-type': options.contentType },
        expiresAt: new Date(expiresAt * 1000),
      });
    });
  }

  presignGet(key: string, options: PresignGetOptions): Promise<PresignedRequest> {
    return new Promise((resolve) => {
      assertValidStorageKey(key);
      assertValidExpiry(options.expiresIn);
      const expiresAt = this.nowSeconds() + options.expiresIn;
      const grant: LocalGrant = {
        method: 'GET',
        key,
        expiresAt,
        filename: options.filename,
        disposition: options.disposition ?? 'attachment',
      };
      resolve({
        method: 'GET',
        url: this.urlFor(grant),
        headers: {},
        expiresAt: new Date(expiresAt * 1000),
      });
    });
  }

  put(key: string, body: Uint8Array, options: PutObjectOptions): Promise<StoredObjectInfo> {
    return this.write(key, Readable.from([Buffer.from(body)]), {
      contentType: options.contentType,
      maxBytes: body.byteLength,
    });
  }

  async putStream(
    key: string,
    body: Readable,
    options: PutStreamOptions,
  ): Promise<StoredObjectInfo> {
    const info = await this.write(key, body, {
      contentType: options.contentType,
      maxBytes: options.contentLength,
    });
    if (info.size !== options.contentLength) {
      await this.delete(key);
      throw new Error('putStream: the stream ended before contentLength bytes');
    }
    return info;
  }

  async getStream(key: string): Promise<Readable | null> {
    return (await this.openRead(key))?.stream ?? null;
  }

  async head(key: string): Promise<StoredObjectInfo | null> {
    assertValidStorageKey(key);
    const meta = await this.readMeta(key);
    if (meta === null) return null;
    try {
      const info = await stat(this.objectPath(key));
      return {
        size: info.size,
        contentType: meta.content_type,
        etag: meta.etag,
        lastModified: info.mtime,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async move(fromKey: string, toKey: string): Promise<boolean> {
    assertValidStorageKey(fromKey);
    assertValidStorageKey(toKey);
    const meta = await this.readMeta(fromKey);
    if (meta === null) return false;
    await mkdir(dirname(this.objectPath(toKey)), { recursive: true });
    await mkdir(dirname(this.metaPath(toKey)), { recursive: true });
    try {
      // The object first: once it is gone, a concurrent move finds nothing.
      await rename(this.objectPath(fromKey), this.objectPath(toKey));
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
    await writeFile(this.metaPath(toKey), JSON.stringify(meta), { mode: 0o600 });
    await rm(this.metaPath(fromKey), { force: true });
    return true;
  }

  async delete(key: string): Promise<void> {
    assertValidStorageKey(key);
    await rm(this.objectPath(key), { force: true });
    await rm(this.metaPath(key), { force: true });
  }

  async health(): Promise<void> {
    await mkdir(join(this.root, 'tmp'), { recursive: true });
    await access(this.root, constants.R_OK | constants.W_OK);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  /** Checks a request against its signature; see `verifyLocalRequest`. */
  verify(method: string, key: string, query: Readonly<Record<string, unknown>>): LocalVerifyResult {
    return verifyLocalRequest(this.signingKey, {
      method,
      key,
      query,
      now: this.nowSeconds(),
    });
  }

  /**
   * Stores `body` under `key`, failing with 413 once more than `maxBytes`
   * arrive. The object becomes visible only after the whole body was written.
   */
  async write(
    key: string,
    body: Readable,
    options: { readonly contentType: string; readonly maxBytes: number },
  ): Promise<StoredObjectInfo> {
    assertValidStorageKey(key);
    const tmpDir = join(this.root, 'tmp');
    await mkdir(tmpDir, { recursive: true });
    const tmpPath = join(tmpDir, randomUUID());
    const hash = createHash('md5');
    let size = 0;
    try {
      await pipeline(
        body,
        byteLimit(options.maxBytes, (chunk) => {
          size += chunk.length;
          hash.update(chunk);
        }),
        createWriteStream(tmpPath, { flags: 'wx', mode: 0o600 }),
      );
      const meta: ObjectMeta = {
        content_type: options.contentType,
        size,
        // Same shape as S3 single-part ETags (quoted MD5 hex).
        etag: `"${hash.digest('hex')}"`,
        uploaded_at: new Date(this.now()).toISOString(),
      };
      const objectPath = this.objectPath(key);
      await mkdir(dirname(objectPath), { recursive: true });
      await mkdir(dirname(this.metaPath(key)), { recursive: true });
      await writeFile(this.metaPath(key), JSON.stringify(meta), { mode: 0o600 });
      await rename(tmpPath, objectPath);
      return { size, contentType: meta.content_type, etag: meta.etag, lastModified: null };
    } catch (error) {
      await rm(tmpPath, { force: true });
      throw error;
    }
  }

  /**
   * Opens an object for streaming, or the inclusive byte `range` of it
   * (`Range` requests of media players, T406); `null` when it does not exist.
   * `size` is always the size of the whole object.
   */
  async openRead(
    key: string,
    range?: { readonly start: number; readonly end: number },
  ): Promise<LocalObjectStream | null> {
    const info = await this.head(key);
    if (info === null) return null;
    return {
      stream: createReadStream(
        this.objectPath(key),
        range === undefined ? {} : { start: range.start, end: range.end },
      ),
      size: info.size,
      contentType: info.contentType ?? 'application/octet-stream',
      etag: info.etag ?? '',
    };
  }

  /** `Content-Disposition` for a verified GET grant. */
  static dispositionFor(grant: Extract<LocalGrant, { method: 'GET' }>): string {
    return contentDisposition(grant.filename, grant.disposition);
  }

  private nowSeconds(): number {
    return Math.floor(this.now() / 1000);
  }

  private urlFor(grant: LocalGrant): string {
    return `${this.baseUrl}/${grant.key}?${localGrantQuery(this.signingKey, grant).toString()}`;
  }

  private objectPath(key: string): string {
    return this.inside(join(this.root, 'objects', key));
  }

  private metaPath(key: string): string {
    return this.inside(join(this.root, 'meta', `${key}.json`));
  }

  /** Defence in depth on top of the key pattern: never leave `root`. */
  private inside(path: string): string {
    const resolved = resolve(path);
    if (!resolved.startsWith(this.root + sep)) {
      throw new AppError('VALIDATION_FAILED', { detail: 'Invalid storage key.' });
    }
    return resolved;
  }

  private async readMeta(key: string): Promise<ObjectMeta | null> {
    try {
      return JSON.parse(await readFile(this.metaPath(key), 'utf8')) as ObjectMeta;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }
}
