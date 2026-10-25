import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import { uploadStagingKey } from '../../storage/storage-key.js';

import { contentContradictsType, isNativeExecutable, SNIFF_BYTES } from './content-sniff.js';

import type { StorageDriver } from '../../storage/storage-driver.js';

/** Why `complete` refuses an upload (detail codes of CONTRACTS §20). */
export type UploadCheckFailure =
  'UPLOAD_INCOMPLETE' | 'SIZE_MISMATCH' | 'CONTENT_MISMATCH' | 'BLOCKED_FILE_TYPE';

export type UploadCheckResult =
  | { readonly ok: true; readonly size: number; readonly sha256: string }
  | { readonly ok: false; readonly reason: UploadCheckFailure };

/**
 * Checks an uploaded object against what its upload announced (SPEC §16,
 * BACKLOG T406): `HEAD` for existence and size, then one streamed read that
 * sniffs the first bytes (`content-sniff.ts`: native executables are
 * blocked, known signatures must match) and computes SHA-256 without holding
 * the file in memory.
 *
 * The presigned `PUT` wrote to `uploadStagingKey(key)`; the object is first
 * moved to `key`, which no URL can write, and only then checked: a `PUT`
 * URL replayed after `complete` (valid for its whole lifetime) cannot swap
 * the checked bytes. When `key` already exists (a concurrent or repeated
 * `complete`, or a server-side `put`) the staging object is discarded.
 */
export async function checkUploadedObject(
  storage: Pick<StorageDriver, 'head' | 'getStream' | 'move' | 'delete'>,
  key: string,
  expected: {
    readonly size: number;
    readonly mime: string;
    /** Refuse native binaries (the field's `blocked_extensions` lists `exe`). */
    readonly blockNativeExecutables: boolean;
  },
): Promise<UploadCheckResult> {
  const staging = uploadStagingKey(key);
  let info = await storage.head(key);
  if (info === null) {
    if (await storage.move(staging, key)) info = await storage.head(key);
  } else {
    await storage.delete(staging);
  }
  if (info === null) return { ok: false, reason: 'UPLOAD_INCOMPLETE' };
  if (info.size !== expected.size) return { ok: false, reason: 'SIZE_MISMATCH' };
  const stream = await storage.getStream(key);
  if (stream === null) return { ok: false, reason: 'UPLOAD_INCOMPLETE' };
  const hash = createHash('sha256');
  const head: Buffer[] = [];
  let headLength = 0;
  let size = 0;
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    if (headLength < SNIFF_BYTES) {
      const part = bytes.subarray(0, SNIFF_BYTES - headLength);
      head.push(part);
      headLength += part.length;
    }
    hash.update(bytes);
    size += bytes.length;
  }
  if (size !== expected.size) return { ok: false, reason: 'SIZE_MISMATCH' };
  const first = Buffer.concat(head);
  if (expected.blockNativeExecutables && isNativeExecutable(first)) {
    return { ok: false, reason: 'BLOCKED_FILE_TYPE' };
  }
  if (contentContradictsType(expected.mime, first)) {
    return { ok: false, reason: 'CONTENT_MISMATCH' };
  }
  return { ok: true, size, sha256: hash.digest('hex') };
}
