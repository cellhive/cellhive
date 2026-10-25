import { Buffer } from 'node:buffer';
import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

export { generateToken, hashToken, TOKEN_BYTES } from '@cellhive/server-core';

/**
 * Tokens handed to browsers (session cookie, reset links) and the signed
 * CSRF token (SPEC §14.2). Only SHA-256 hashes of bearer tokens are stored;
 * comparisons of secrets are constant-time.
 */

/** base64url without padding of `TOKEN_BYTES` (32) bytes. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function isWellFormedToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

/** Constant-time string equality (length is not secret). */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Derives a purpose-specific key from `SESSION_SECRET` (HKDF-SHA256), so the
 * CSRF key differs from the key signing local storage URLs.
 */
export function deriveKey(secret: string, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), `${purpose}:v1`, 32));
}

const CSRF_NONCE_BYTES = 16;
const CSRF_PATTERN = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;

function csrfSignature(key: Buffer, sessionId: string, nonce: string): string {
  return createHmac('sha256', key).update(`${sessionId}.${nonce}`, 'utf8').digest('base64url');
}

/**
 * Signed double-submit CSRF token (OWASP): `<nonce>.<HMAC(key, session id + nonce)>`.
 * Bound to the session, so a token planted by an attacker for another
 * session does not validate.
 */
export function createCsrfToken(key: Buffer, sessionId: string): string {
  const nonce = randomBytes(CSRF_NONCE_BYTES).toString('base64url');
  return `${nonce}.${csrfSignature(key, sessionId, nonce)}`;
}

/** Whether `token` was issued for `sessionId` with `key`. */
export function verifyCsrfToken(key: Buffer, sessionId: string, token: string): boolean {
  const match = CSRF_PATTERN.exec(token);
  if (match === null) return false;
  const [, nonce = '', signature = ''] = match;
  return safeEqual(signature, csrfSignature(key, sessionId, nonce));
}

/**
 * The double-submit check: the header must repeat the cookie, and the token
 * must be signed for the current session.
 */
export function checkCsrf(
  key: Buffer,
  sessionId: string,
  cookieToken: string | undefined,
  headerToken: string | undefined,
): boolean {
  if (cookieToken === undefined || headerToken === undefined) return false;
  if (!safeEqual(cookieToken, headerToken)) return false;
  return verifyCsrfToken(key, sessionId, headerToken);
}
