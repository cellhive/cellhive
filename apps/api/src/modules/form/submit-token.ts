import { createHmac, randomBytes } from 'node:crypto';

import { safeEqual } from '../../common/auth/secrets.js';

/**
 * Submit tokens of public forms (CONTRACTS §17, ADR-0030): a signed,
 * stateless proof that the form was opened some time before it was sent,
 * bound to one share link. Format: `v1.<issued ms>.<nonce>.<HMAC>` where
 * the HMAC (SHA-256, key derived from `SESSION_SECRET`) covers the version,
 * link id, issue time and nonce. The nonce makes each token single use
 * (checked by the caller in Valkey).
 */

const VERSION = 'v1';
const NONCE_BYTES = 16;
const TOKEN_PATTERN = /^v1\.(\d{1,15})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;

export interface IssuedSubmitToken {
  readonly token: string;
  readonly issuedAt: Date;
}

export type SubmitTokenCheck =
  | { readonly ok: true; readonly nonce: string; readonly issuedAt: Date }
  | { readonly ok: false; readonly reason: 'invalid' | 'expired' }
  | { readonly ok: false; readonly reason: 'too_fast'; readonly retryAfterMs: number };

function signature(key: Buffer, linkId: string, issuedMs: string, nonce: string): string {
  return createHmac('sha256', key)
    .update(`${VERSION}.${linkId}.${issuedMs}.${nonce}`, 'utf8')
    .digest('base64url');
}

/** A new token for `linkId`, issued at `now`. */
export function issueSubmitToken(key: Buffer, linkId: string, now: Date): IssuedSubmitToken {
  const issuedMs = String(now.getTime());
  const nonce = randomBytes(NONCE_BYTES).toString('base64url');
  return {
    token: `${VERSION}.${issuedMs}.${nonce}.${signature(key, linkId, issuedMs, nonce)}`,
    issuedAt: new Date(Number(issuedMs)),
  };
}

/**
 * Checks `token` for `linkId` at `now`: well formed and signed for this
 * link (else `invalid`), issued at least `minAgeMs` ago (else `too_fast`,
 * with the wait left) and at most `maxAgeMs` ago (else `expired`).
 * Constant-time signature comparison.
 */
export function checkSubmitToken(
  key: Buffer,
  linkId: string,
  token: string | undefined,
  now: Date,
  limits: { readonly minAgeMs: number; readonly maxAgeMs: number },
): SubmitTokenCheck {
  const match = token === undefined ? null : TOKEN_PATTERN.exec(token);
  if (match === null) return { ok: false, reason: 'invalid' };
  const [, issuedMs = '', nonce = '', mac = ''] = match;
  if (!safeEqual(mac, signature(key, linkId, issuedMs, nonce))) {
    return { ok: false, reason: 'invalid' };
  }
  const age = now.getTime() - Number(issuedMs);
  // A token from the future (clock skew between instances) waits like a fresh one.
  if (age < limits.minAgeMs)
    return { ok: false, reason: 'too_fast', retryAfterMs: limits.minAgeMs - age };
  if (age > limits.maxAgeMs) return { ok: false, reason: 'expired' };
  return { ok: true, nonce, issuedAt: new Date(Number(issuedMs)) };
}
