import { Buffer } from 'node:buffer';
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed URLs of the local storage driver (ADR-0016): the API serves
 * `GET|PUT {PUBLIC_URL}/api/v1/storage/local/<key>?exp=…&…&sig=…` where `sig`
 * is HMAC-SHA256 over every parameter that restricts the request. The HMAC key
 * is derived from SESSION_SECRET with a fixed label, so these signatures can
 * never be confused with other HMACs made from the same secret (e.g. CSRF).
 */

export const LOCAL_STORAGE_ROUTE = '/api/v1/storage/local';

const KEY_LABEL = 'storage-local-url:v1';
const SIGNATURE_VERSION = 'v1';
const DIGITS = /^\d{1,15}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/;

export type LocalGrant =
  | {
      readonly method: 'PUT';
      readonly key: string;
      /** Unix time in seconds. */
      readonly expiresAt: number;
      readonly contentType: string;
      readonly maxBytes: number;
    }
  | {
      readonly method: 'GET';
      readonly key: string;
      readonly expiresAt: number;
      readonly filename: string;
      readonly disposition: 'attachment' | 'inline';
    };

export type LocalVerifyResult =
  | { readonly ok: true; readonly grant: LocalGrant }
  | { readonly ok: false; readonly reason: 'invalid' | 'expired' };

export function deriveLocalSigningKey(sessionSecret: string): Buffer {
  return createHmac('sha256', sessionSecret).update(KEY_LABEL).digest();
}

function canonical(grant: LocalGrant): string {
  const parts =
    grant.method === 'PUT'
      ? [grant.contentType, String(grant.maxBytes)]
      : [grant.filename, grant.disposition];
  // Newlines cannot occur in keys, numbers or header-safe values, and every
  // part is length-prefixed, so two different grants never share a string.
  return [SIGNATURE_VERSION, grant.method, grant.key, String(grant.expiresAt), ...parts]
    .map((part) => `${String(part.length)}:${part}`)
    .join('\n');
}

export function signLocalGrant(signingKey: Buffer, grant: LocalGrant): string {
  return createHmac('sha256', signingKey).update(canonical(grant)).digest('base64url');
}

/** Query-string parameters (including `sig`) for a grant. */
export function localGrantQuery(signingKey: Buffer, grant: LocalGrant): URLSearchParams {
  const query = new URLSearchParams({ exp: String(grant.expiresAt) });
  if (grant.method === 'PUT') {
    query.set('ct', grant.contentType);
    query.set('max', String(grant.maxBytes));
  } else {
    query.set('fn', grant.filename);
    query.set('disp', grant.disposition);
  }
  query.set('sig', signLocalGrant(signingKey, grant));
  return query;
}

function single(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseGrant(
  method: string,
  key: string,
  query: Readonly<Record<string, unknown>>,
): LocalGrant | null {
  const exp = single(query.exp);
  if (exp === undefined || !DIGITS.test(exp)) return null;
  const expiresAt = Number(exp);
  if (method === 'PUT') {
    const contentType = single(query.ct);
    const max = single(query.max);
    if (contentType === undefined || max === undefined || !DIGITS.test(max)) return null;
    return { method: 'PUT', key, expiresAt, contentType, maxBytes: Number(max) };
  }
  if (method === 'GET' || method === 'HEAD') {
    const filename = single(query.fn);
    const disposition = single(query.disp);
    if (filename === undefined || (disposition !== 'attachment' && disposition !== 'inline')) {
      return null;
    }
    return { method: 'GET', key, expiresAt, filename, disposition };
  }
  return null;
}

/**
 * Verifies a signed request. The signature is checked in constant time before
 * the expiry, so an attacker learns nothing from the order of the checks.
 * `HEAD` is accepted with a `GET` signature.
 */
export function verifyLocalRequest(
  signingKey: Buffer,
  input: {
    readonly method: string;
    readonly key: string;
    readonly query: Readonly<Record<string, unknown>>;
    /** Unix time in seconds. */
    readonly now: number;
  },
): LocalVerifyResult {
  const grant = parseGrant(input.method.toUpperCase(), input.key, input.query);
  const provided = single(input.query.sig);
  if (grant === null || provided === undefined || !SIGNATURE.test(provided)) {
    return { ok: false, reason: 'invalid' };
  }
  const expected = Buffer.from(signLocalGrant(signingKey, grant), 'base64url');
  const actual = Buffer.from(provided, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return { ok: false, reason: 'invalid' };
  }
  if (grant.expiresAt <= input.now) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, grant };
}
