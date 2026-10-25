import { Buffer } from 'node:buffer';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

import { z } from 'zod';

import { causationSchema, type Causation } from '../../events/event.js';

/**
 * Causation token of `X-Cellhive-Causation` (ADR-27, ADR-35 §5, CONTRACTS
 * §10): carries the loop-guard causation of an outbound `http_request` /
 * `run_n8n_workflow` call so that `/hooks/:token` of this instance can
 * continue the chain. Format `v1.<base64url(iv ‖ tag ‖ AES-256-GCM(json))>`
 * with `json = { root_event_id, depth, automation_chain, target, exp }` and
 * `exp = now + 1 h`. `target = SHA-256(host + path)` names **this
 * instance** — the host of `PUBLIC_URL` + {@link CAUSATION_HOOK_PATH_PREFIX}
 * (amendment 2026-10-18 of ADR-27 §5 / ADR-35 §5, T616) — not the
 * destination URL, so a chain survives a hop through n8n or any system that
 * forwards the header to `/hooks/:token`.
 * The key is HKDF-SHA256(`APP_MASTER_KEY`, info `automation-causation-v1`,
 * exactly as ADR-27 names it — not the `<purpose>:v1` scheme of
 * `secret-box.ts`). Encrypted, not only signed, so a third-party receiver
 * learns no internal id. Tokens are bearer-like: never log them.
 */

export const CAUSATION_TOKEN_PREFIX = 'v1.';
export const CAUSATION_TOKEN_TTL_S = 3600;
/** Path prefix of the public hook route `POST /api/v1/hooks/:token`; the token target's path. */
export const CAUSATION_HOOK_PATH_PREFIX = '/api/v1/hooks';
const HKDF_INFO = 'automation-causation-v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Far above the longest legal token (a 64-id chain is ~2.2 KB); bounds work on hostile input. */
const MAX_TOKEN_LENGTH = 4096;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export type CausationTokenFailure = 'malformed' | 'expired' | 'target_mismatch' | 'bad_tag';

export type CausationTokenResult =
  | { readonly ok: true; readonly causation: Causation }
  | { readonly ok: false; readonly reason: CausationTokenFailure };

export interface EncodeCausationOptions {
  /** `deriveCausationKey(APP_MASTER_KEY)`. */
  readonly key: Buffer;
  /**
   * Host the token is bound to (`URL.host`, with a non-default port): the
   * host of `PUBLIC_URL` for outbound calls.
   */
  readonly host: string;
  /**
   * Path the token is bound to; a query or fragment is ignored. Outbound
   * calls use {@link CAUSATION_HOOK_PATH_PREFIX}.
   */
  readonly path: string;
  readonly now: Date;
}

export interface DecodeCausationOptions {
  readonly key: Buffer;
  /**
   * Hosts the request may have been addressed to: the host of `PUBLIC_URL`
   * and the `Host` header after `TRUSTED_PROXIES` (ADR-35 §5); missing
   * entries are skipped.
   */
  readonly hosts: readonly (string | null | undefined)[];
  /** Path of the inbound request; a query or fragment is ignored. */
  readonly path: string;
  /**
   * Path-prefix mode: the request path must be `pathPrefix` or below it
   * (`pathPrefix/…`, on a segment boundary) and the target is checked
   * against `host + pathPrefix` instead of `host + path`. Without it the
   * target must match the exact request path.
   */
  readonly pathPrefix?: string;
  readonly now: Date;
}

const payloadSchema = causationSchema.extend({
  target: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  exp: z.number().int().nonnegative(),
});

/** The 32-byte token key. */
export function deriveCausationKey(masterKey: Buffer | string): Buffer {
  return Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), HKDF_INFO, 32));
}

/**
 * SHA-256 of `host + path` after normalisation: host lower-cased, trailing
 * dot and default ports `:80` / `:443` dropped (the receiver cannot tell the
 * scheme from a `Host` header); path without query or fragment, `/` when empty.
 */
export function causationTarget(host: string, path: string): Buffer {
  return createHash('sha256')
    .update(`${normalizeHost(host)}${normalizePath(path)}`, 'utf8')
    .digest();
}

/**
 * A new token for one attempt (fresh IV, `exp = now + 1 h`). Throws
 * `RangeError` when `causation` is not a valid causation (SPEC §11.6 limits).
 */
export function encodeCausationToken(
  causation: Causation,
  options: EncodeCausationOptions,
): string {
  const parsed = causationSchema.safeParse(causation);
  if (!parsed.success) throw new RangeError('invalid causation');
  const payload = {
    root_event_id: parsed.data.root_event_id,
    depth: parsed.data.depth,
    automation_chain: parsed.data.automation_chain,
    target: causationTarget(options.host, options.path).toString('base64url'),
    exp: Math.floor(options.now.getTime() / 1000) + CAUSATION_TOKEN_TTL_S,
  };
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', options.key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  return `${CAUSATION_TOKEN_PREFIX}${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url')}`;
}

/**
 * The causation carried by `token` exactly as encoded (the caller adds the
 * `+1` depth of ADR-27 §2), or why it is rejected, checked in order:
 * `malformed` (not `v1.<base64url>`, too short/long, or a payload that is
 * not a valid causation), `bad_tag` (altered, or another master key),
 * `expired` (`now > exp`), `target_mismatch` (no `hosts` entry + `path`
 * matches — or, with `pathPrefix`, the request path is outside the prefix
 * or no `hosts` entry + `pathPrefix` matches). The caller treats every failure as "no causation" (depth 0)
 * and never rejects the request because of it.
 */
export function decodeCausationToken(
  token: string,
  options: DecodeCausationOptions,
): CausationTokenResult {
  const raw = decodeBody(token);
  if (raw === null) return { ok: false, reason: 'malformed' };

  let plaintext: string;
  try {
    const decipher = createDecipheriv('aes-256-gcm', options.key, raw.subarray(0, IV_BYTES));
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    plaintext = Buffer.concat([
      decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return { ok: false, reason: 'bad_tag' };
  }

  let json: unknown;
  try {
    json = JSON.parse(plaintext);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const parsed = payloadSchema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: 'malformed' };
  const { target, exp, ...causation } = parsed.data;

  if (Math.floor(options.now.getTime() / 1000) > exp) return { ok: false, reason: 'expired' };

  let targetPath = options.path;
  if (options.pathPrefix !== undefined) {
    const prefix = trimTrailingSlash(normalizePath(options.pathPrefix));
    const path = normalizePath(options.path);
    if (prefix !== '/' && path !== prefix && !path.startsWith(`${prefix}/`)) {
      return { ok: false, reason: 'target_mismatch' };
    }
    targetPath = prefix;
  }
  const expected = Buffer.from(target, 'base64url');
  const matches = options.hosts.some(
    (host) =>
      host !== null &&
      host !== undefined &&
      host.length > 0 &&
      timingSafeEqual(causationTarget(host, targetPath), expected),
  );
  if (!matches) return { ok: false, reason: 'target_mismatch' };

  return { ok: true, causation };
}

/** `iv ‖ tag ‖ ciphertext` of a well-formed token, else `null`. */
function decodeBody(token: string): Buffer | null {
  if (token.length > MAX_TOKEN_LENGTH || !token.startsWith(CAUSATION_TOKEN_PREFIX)) return null;
  const body = token.slice(CAUSATION_TOKEN_PREFIX.length);
  // Unpadded base64url never has a length of 1 mod 4.
  if (!BASE64URL.test(body) || body.length % 4 === 1) return null;
  const raw = Buffer.from(body, 'base64url');
  return raw.length > IV_BYTES + TAG_BYTES ? raw : null;
}

function normalizeHost(host: string): string {
  const value = host.trim().toLowerCase();
  let name = value;
  let port: string | null = null;
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end !== -1 && value.charAt(end + 1) === ':') {
      name = value.slice(0, end + 1);
      port = value.slice(end + 2);
    }
  } else {
    const colon = value.indexOf(':');
    // A single colon separates the port; several mean a bare IPv6 literal.
    if (colon !== -1 && colon === value.lastIndexOf(':')) {
      name = value.slice(0, colon);
      port = value.slice(colon + 1);
    }
  }
  if (name.endsWith('.')) name = name.slice(0, -1);
  return port === null || port === '' || port === '80' || port === '443' ? name : `${name}:${port}`;
}

/** `/api/v1/hooks/` → `/api/v1/hooks` (a root `/` stays `/`). */
function trimTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

function normalizePath(path: string): string {
  const end = path.search(/[?#]/);
  const bare = end === -1 ? path : path.slice(0, end);
  return bare === '' ? '/' : bare;
}
