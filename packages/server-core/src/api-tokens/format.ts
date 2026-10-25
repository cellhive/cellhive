import { createHash, randomInt } from 'node:crypto';
import { crc32 } from 'node:zlib';

import { API_TOKEN_PREFIX, API_TOKEN_PREFIX_LENGTH, BASE62_ALPHABET } from '@cellhive/contracts';

/**
 * API token format (CONTRACTS §26.1, ADR-36 §1): `cht_` + 30 base62
 * characters from a CSPRNG (≥ 178 bits) + 6 base62 characters of the CRC32
 * of those 30, zero-padded (GitHub's scheme). The checksum lets a request
 * with a mistyped or made-up token fail without touching the database, and
 * lets secret scanners recognise a token; only the SHA-256 of the whole
 * token is stored.
 */

const RANDOM_LENGTH = 30;
const CHECKSUM_LENGTH = 6;
const TOKEN_PATTERN = /^cht_[0-9A-Za-z]{36}$/u;

/** A new token: `token` is returned once and never stored, logged or audited. */
export interface GeneratedApiToken {
  readonly token: string;
  /** `token_prefix`: the 8 characters after `cht_`. */
  readonly prefix: string;
  /** `token_hash`: SHA-256 of the whole token (32 bytes). */
  readonly hash: Buffer;
}

export type ApiTokenParseResult = 'ok' | 'malformed' | 'bad_checksum';

/** CRC32 of `random` as 6 base62 characters (CRC32 < 62⁶). */
export function apiTokenChecksum(random: string): string {
  let rest = crc32(random);
  let out = '';
  while (rest > 0) {
    out = `${BASE62_ALPHABET.charAt(rest % 62)}${out}`;
    rest = Math.floor(rest / 62);
  }
  return out.padStart(CHECKSUM_LENGTH, '0');
}

/** SHA-256 of a token: the lookup key (`meta.api_tokens.token_hash`). */
export function hashApiToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

export function generateApiToken(): GeneratedApiToken {
  // `randomInt` is uniform (no modulo bias) and backed by the CSPRNG.
  const random = Array.from({ length: RANDOM_LENGTH }, () =>
    BASE62_ALPHABET.charAt(randomInt(BASE62_ALPHABET.length)),
  ).join('');
  const token = `${API_TOKEN_PREFIX}${random}${apiTokenChecksum(random)}`;
  return {
    token,
    prefix: random.slice(0, API_TOKEN_PREFIX_LENGTH),
    hash: hashApiToken(token),
  };
}

/**
 * Offline check of a presented token: `malformed` (not `cht_` + 36 base62
 * characters) or `bad_checksum` are answered without a lookup.
 */
export function parseApiToken(value: string): ApiTokenParseResult {
  if (!TOKEN_PATTERN.test(value)) return 'malformed';
  const random = value.slice(API_TOKEN_PREFIX.length, API_TOKEN_PREFIX.length + RANDOM_LENGTH);
  return value.slice(-CHECKSUM_LENGTH) === apiTokenChecksum(random) ? 'ok' : 'bad_checksum';
}
