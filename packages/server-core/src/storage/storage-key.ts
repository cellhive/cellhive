import { AppError } from '../errors/app-error.js';

import { MAX_PRESIGN_SECONDS } from './storage-driver.js';

/**
 * `{prefix}/{name}`, e.g. `org_A1b2C3d4E5f6G7h8/att_A1b2C3d4E5f6G7h8`.
 * The prefix is an organization ID (base62 plus `_`); the name may also hold
 * `.` and `-`. Exactly one `/`, so a key can never climb out of its directory.
 */
export const STORAGE_KEY_PATTERN = /^[A-Za-z0-9_]+\/[A-Za-z0-9_.-]+$/;

const MAX_KEY_LENGTH = 512;

export function isValidStorageKey(key: unknown): key is string {
  if (typeof key !== 'string' || key.length > MAX_KEY_LENGTH || !STORAGE_KEY_PATTERN.test(key)) {
    return false;
  }
  const name = key.slice(key.indexOf('/') + 1);
  return name !== '.' && name !== '..';
}

/** Throws `422 VALIDATION_FAILED` for keys outside `STORAGE_KEY_PATTERN`. */
export function assertValidStorageKey(key: unknown): asserts key is string {
  if (!isValidStorageKey(key)) {
    throw new AppError('VALIDATION_FAILED', {
      detail: 'Invalid storage key.',
      errors: [{ path: 'key', code: 'INVALID_FORMAT', message: 'Invalid storage key' }],
    });
  }
}

/** Throws `422 VALIDATION_FAILED` unless `seconds` is an integer in 1..7 days. */
export function assertValidExpiry(seconds: number): void {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_PRESIGN_SECONDS) {
    throw new AppError('VALIDATION_FAILED', {
      detail: 'Invalid presigned URL lifetime.',
      errors: [
        {
          path: 'expiresIn',
          code: 'OUT_OF_RANGE',
          message: `Must be an integer between 1 and ${String(MAX_PRESIGN_SECONDS)} seconds`,
        },
      ],
    });
  }
}

/**
 * Where the presigned `PUT` of a user upload writes: `complete` moves the
 * object from here to `key` before checking it, so a `PUT` URL replayed
 * after `complete` (it stays valid for its whole lifetime) can never replace
 * the checked object. `.` cannot start an ID, so no application key ends
 * with `.upload`.
 */
export function uploadStagingKey(key: string): string {
  return `${key}.upload`;
}
