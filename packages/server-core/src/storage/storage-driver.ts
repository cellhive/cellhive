/**
 * Object storage abstraction (SPEC §16, ADR-0016). Two implementations share
 * this interface: `S3StorageDriver` (Garage or any S3-compatible service) and
 * `LocalStorageDriver` (files on a volume, URLs signed by the API).
 *
 * Keys are `{organization_id}/{attachment_id}` (see `STORAGE_KEY_PATTERN`);
 * callers never put filenames or user input into keys.
 */
import type { Readable } from 'node:stream';

export interface PresignPutOptions {
  /** MIME type the client must send as `Content-Type`; covered by the signature. */
  readonly contentType: string;
  /**
   * Upper bound for the object size in bytes. Enforced during upload by the
   * local driver. S3 presigned PUT URLs cannot carry a size range (POST
   * policies are not used, ADR-0016), so callers must verify the size with
   * `head()` when the upload is completed (SPEC §16).
   */
  readonly maxBytes: number;
  /**
   * Exact size of the body, when known (attachments, BACKLOG S4 #13): the S3
   * driver signs `Content-Length`, so the storage refuses any other size;
   * the local driver refuses bodies larger than it. `complete` still checks
   * the stored size with `head()`.
   */
  readonly contentLength?: number;
  /** Validity in seconds (SPEC §16: 10 minutes for uploads). */
  readonly expiresIn: number;
}

export interface PresignGetOptions {
  /** Original filename, sent back as an RFC 5987 `Content-Disposition`. */
  readonly filename: string;
  /** Validity in seconds (SPEC §16: 60 seconds for downloads). */
  readonly expiresIn: number;
  /** Defaults to `attachment`: user uploads are never rendered inline unless asked. */
  readonly disposition?: 'attachment' | 'inline';
}

export interface PresignedRequest {
  readonly method: 'GET' | 'PUT';
  readonly url: string;
  /** Headers the client must send with the request (e.g. `content-type` for PUT). */
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: Date;
}

export interface StoredObjectInfo {
  readonly size: number;
  readonly contentType: string | null;
  readonly etag: string | null;
  readonly lastModified: Date | null;
}

/** A server-side upload (exports and other files the server produces itself). */
export interface PutObjectOptions {
  readonly contentType: string;
}

/** A server-side streamed upload: the exact size must be known in advance. */
export interface PutStreamOptions extends PutObjectOptions {
  /** Bytes the stream delivers; a different count fails the upload. */
  readonly contentLength: number;
}

export interface StorageDriver {
  readonly kind: 's3' | 'local';
  /**
   * Stores `body` under `key` from the server (not through a presigned URL),
   * replacing any existing object. For files the server generates, such as
   * exports; user uploads go through `presignPut`.
   */
  put(key: string, body: Uint8Array, options: PutObjectOptions): Promise<StoredObjectInfo>;
  /**
   * `put` from a stream, without holding the object in memory (import
   * uploads, T308). The stream must deliver exactly `contentLength` bytes.
   */
  putStream(key: string, body: Readable, options: PutStreamOptions): Promise<StoredObjectInfo>;
  /** Reads an object as a stream from the server; `null` when it does not exist. */
  getStream(key: string): Promise<Readable | null>;
  /**
   * A presigned `PUT` stays valid until it expires, even after the upload
   * was checked: user uploads are therefore signed for
   * `uploadStagingKey(key)` and moved to `key` when completed, never for a
   * key the application serves.
   */
  presignPut(key: string, options: PresignPutOptions): Promise<PresignedRequest>;
  presignGet(key: string, options: PresignGetOptions): Promise<PresignedRequest>;
  /** `null` when the object does not exist. */
  head(key: string): Promise<StoredObjectInfo | null>;
  /**
   * Moves an object server-side (S3: `CopyObject` + `DeleteObject`; local:
   * rename), replacing `toKey`. `false` when `fromKey` does not exist. Used
   * to take a finished upload out of reach of its presigned `PUT`
   * (`uploadStagingKey`).
   */
  move(fromKey: string, toKey: string): Promise<boolean>;
  /** Idempotent: deleting a missing object succeeds. */
  delete(key: string): Promise<void>;
  /** Resolves when the backend is usable; rejects otherwise (used by `/readyz`). */
  health(signal?: AbortSignal): Promise<void>;
  /** Releases connections. */
  close(): Promise<void>;
}

/** Longest validity accepted for presigned URLs (SigV4 maximum). */
export const MAX_PRESIGN_SECONDS = 7 * 24 * 60 * 60;
