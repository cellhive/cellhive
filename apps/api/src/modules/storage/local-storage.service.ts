import {
  AppError,
  assertValidStorageKey,
  LocalStorageDriver,
  type LocalGrant,
  type LocalObjectStream,
  type StorageDriver,
  type StoredObjectInfo,
} from '@cellhive/server-core';
import { Inject, Injectable } from '@nestjs/common';

import { STORAGE_DRIVER } from '../../common/tokens.js';

import type { Readable } from 'node:stream';

type Query = Readonly<Record<string, unknown>>;

function normalizeMediaType(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

/** An inclusive byte range of an object. */
export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

/**
 * A single-range `Range: bytes=…` header against an object of `size` bytes
 * (RFC 9110 §14): the range, `'unsatisfiable'` (416), or `null` to send the
 * whole object (no header, a malformed one, or several ranges).
 */
export function parseByteRange(
  header: string | undefined,
  size: number,
): ByteRange | 'unsatisfiable' | null {
  if (header === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return null;
  const [, first = '', last = ''] = match;
  if (first === '' && last === '') return null;
  if (first === '') {
    const suffix = Number(last);
    if (suffix === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1);
  if (!Number.isSafeInteger(start) || start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

/** A download: the whole object, or one byte range of it (`range`). */
export interface LocalDownload extends LocalObjectStream {
  readonly contentDisposition: string;
  readonly range: ByteRange | null;
}

/**
 * Serves the signed URLs of `LocalStorageDriver` (STORAGE_DRIVER=local,
 * ADR-0016). The signature is the only credential: it binds method, key,
 * expiry and, for uploads, Content-Type and size limit.
 */
@Injectable()
export class LocalStorageService {
  constructor(@Inject(STORAGE_DRIVER) private readonly storage: StorageDriver) {}

  async upload(
    key: string,
    query: Query,
    request: {
      readonly contentType: string | undefined;
      readonly contentLength: string | undefined;
      readonly body: Readable;
    },
  ): Promise<StoredObjectInfo> {
    const { driver, grant } = this.authorize('PUT', key, query);
    if (grant.method !== 'PUT') throw new AppError('PERMISSION_DENIED');
    if (normalizeMediaType(request.contentType) !== normalizeMediaType(grant.contentType)) {
      throw new AppError('PERMISSION_DENIED', {
        detail: 'Content-Type does not match the signed URL.',
      });
    }
    const declared = Number(request.contentLength);
    if (request.contentLength !== undefined && declared > grant.maxBytes) {
      throw new AppError('PAYLOAD_TOO_LARGE', {
        detail: `The upload exceeds the allowed size of ${String(grant.maxBytes)} bytes.`,
      });
    }
    return driver.write(key, request.body, {
      contentType: grant.contentType,
      maxBytes: grant.maxBytes,
    });
  }

  /**
   * A signed GET/HEAD, whole or one byte range (`Range`, so that `<video>`
   * and `<audio>` can seek; T406). An unsatisfiable range is `416`.
   */
  async download(
    method: string,
    key: string,
    query: Query,
    rangeHeader?: string,
  ): Promise<LocalDownload | { readonly unsatisfiable: true; readonly size: number }> {
    const { driver, grant } = this.authorize(method, key, query);
    if (grant.method !== 'GET') throw new AppError('PERMISSION_DENIED');
    const info = await driver.head(key);
    if (info === null) throw new AppError('NOT_FOUND');
    const range = parseByteRange(rangeHeader, info.size);
    if (range === 'unsatisfiable') return { unsatisfiable: true, size: info.size };
    const object = await driver.openRead(key, range ?? undefined);
    if (object === null) throw new AppError('NOT_FOUND');
    return { ...object, contentDisposition: LocalStorageDriver.dispositionFor(grant), range };
  }

  private authorize(
    method: string,
    key: string,
    query: Query,
  ): { driver: LocalStorageDriver; grant: LocalGrant } {
    // These URLs exist only with the local driver.
    if (!(this.storage instanceof LocalStorageDriver)) throw new AppError('NOT_FOUND');
    assertValidStorageKey(key);
    const result = this.storage.verify(method, key, query);
    if (!result.ok) {
      throw new AppError('PERMISSION_DENIED', {
        detail:
          result.reason === 'expired'
            ? 'The signed URL has expired.'
            : 'The signed URL is invalid.',
      });
    }
    return { driver: this.storage, grant: result.grant };
  }
}
