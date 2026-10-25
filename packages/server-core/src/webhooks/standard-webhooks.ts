import { Buffer } from 'node:buffer';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Standard Webhooks v1 (ADR-22, CONTRACTS §10,
 * https://github.com/standard-webhooks/standard-webhooks): headers
 * `webhook-id`, `webhook-timestamp` (Unix seconds) and `webhook-signature`
 * (`v1,<base64 HMAC-SHA256(key, "<id>.<timestamp>.<raw body>")>`, several
 * space-separated while a secret rotates). Implemented in-repo with
 * `node:crypto` only (S5c decision #4); signatures are compared in constant
 * time. Secrets and bodies are never logged or put into errors.
 */

export const SIGNING_SECRET_PREFIX = 'whsec_';
/** Secret size bounds of the spec ("Signature scheme"). */
export const MIN_SIGNING_SECRET_BYTES = 24;
export const MAX_SIGNING_SECRET_BYTES = 64;
/** Size of the secrets Cellhive generates (CONTRACTS §10). */
export const GENERATED_SIGNING_SECRET_BYTES = 32;
/** Default tolerance between `webhook-timestamp` and the receiver's clock (CONTRACTS §10). */
export const DEFAULT_WEBHOOK_TOLERANCE_S = 300;

const SIGNATURE_VERSION = 'v1';
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const TIMESTAMP = /^[0-9]{1,15}$/;
/** `webhook-id` must not break the signed `id.timestamp.body` framing or the header. */
const MESSAGE_ID = /^[\x21-\x7e]{1,255}$/;

/** Request headers as Node/Fastify expose them (any case; repeated headers as arrays). */
export type WebhookHeaders = Readonly<Record<string, string | readonly string[] | undefined>>;

export interface WebhookMessage {
  /** `webhook-id`: the delivery row id `hdl_…` for outbound webhooks (ADR-35, T605). */
  readonly id: string;
  /** `webhook-timestamp`: Unix epoch seconds of this attempt. */
  readonly timestamp: number;
  /** Exact bytes sent as the body (a string is taken as UTF-8). */
  readonly body: string | Buffer;
}

export type WebhookVerifyFailure = 'missing_header' | 'bad_timestamp' | 'expired' | 'bad_signature';

export type WebhookVerifyResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: WebhookVerifyFailure };

/**
 * Key bytes of a `whsec_<base64>` secret, or `null` when the prefix is
 * missing, the base64 is not canonical standard base64, or the key is not
 * 24–64 bytes.
 */
export function parseSigningSecret(secret: string): Buffer | null {
  if (!secret.startsWith(SIGNING_SECRET_PREFIX)) return null;
  const encoded = secret.slice(SIGNING_SECRET_PREFIX.length);
  if (encoded.length === 0 || !BASE64.test(encoded)) return null;
  const key = Buffer.from(encoded, 'base64');
  // Node ignores non-zero padding bits; only the canonical spelling is accepted.
  if (key.toString('base64') !== encoded) return null;
  if (key.length < MIN_SIGNING_SECRET_BYTES || key.length > MAX_SIGNING_SECRET_BYTES) return null;
  return key;
}

/** A new random `whsec_` secret of 32 bytes. */
export function generateSigningSecret(): string {
  return `${SIGNING_SECRET_PREFIX}${randomBytes(GENERATED_SIGNING_SECRET_BYTES).toString('base64')}`;
}

/**
 * Value of the `webhook-signature` header: one `v1,<sig>` per secret, in the
 * given order, separated by a space (current + previous secret during a
 * rotation). Throws `RangeError` on no secret, a malformed secret, an id
 * that is not 1–255 visible ASCII characters, or a timestamp that is not a
 * non-negative integer — all programming or stored-data errors.
 */
export function signWebhook(message: WebhookMessage, secrets: readonly string[]): string {
  if (secrets.length === 0) throw new RangeError('at least one signing secret is required');
  if (!MESSAGE_ID.test(message.id)) throw new RangeError('invalid webhook id');
  if (!Number.isSafeInteger(message.timestamp) || message.timestamp < 0) {
    throw new RangeError('invalid webhook timestamp');
  }
  return secrets
    .map((secret) => {
      const key = parseSigningSecret(secret);
      if (key === null) throw new RangeError('invalid signing secret');
      return `${SIGNATURE_VERSION},${signature(key, message.id, String(message.timestamp), message.body)}`;
    })
    .join(' ');
}

/**
 * Verifies an inbound Standard Webhooks request against any of `secrets`
 * (two while a secret rotates; malformed secrets are skipped). Checks, in
 * order: the three headers are present once and non-empty
 * (`missing_header`), the timestamp is a non-negative integer
 * (`bad_timestamp`) within `toleranceS` of `now` in either direction
 * (`expired`), and one `v1` signature matches (`bad_signature`). Entries
 * with another version (`v1a`, `v2`, …) or without a comma are ignored.
 * Replay protection by `webhook-id` is the caller's job (CONTRACTS §10).
 */
export function verifyWebhook(
  headers: WebhookHeaders,
  rawBody: string | Buffer,
  secrets: readonly string[],
  now: Date,
  toleranceS: number = DEFAULT_WEBHOOK_TOLERANCE_S,
): WebhookVerifyResult {
  const id = headerValue(headers, 'webhook-id');
  const timestamp = headerValue(headers, 'webhook-timestamp');
  const signatures = headerValue(headers, 'webhook-signature');
  if (id === null || timestamp === null || signatures === null) {
    return { ok: false, reason: 'missing_header' };
  }

  if (!TIMESTAMP.test(timestamp)) return { ok: false, reason: 'bad_timestamp' };
  const nowS = Math.floor(now.getTime() / 1000);
  if (Math.abs(nowS - Number(timestamp)) > toleranceS) return { ok: false, reason: 'expired' };

  const candidates = signatures
    .split(' ')
    .filter((entry) => entry.startsWith(`${SIGNATURE_VERSION},`))
    .map((entry) => Buffer.from(entry.slice(SIGNATURE_VERSION.length + 1), 'utf8'));
  if (candidates.length === 0) return { ok: false, reason: 'bad_signature' };

  let matched = false;
  for (const secret of secrets) {
    const key = parseSigningSecret(secret);
    if (key === null) continue;
    const expected = Buffer.from(signature(key, id, timestamp, rawBody), 'utf8');
    for (const candidate of candidates) {
      // Lengths are public (always 44 for SHA-256); only equal lengths are compared.
      if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
        matched = true;
      }
    }
  }
  return matched ? { ok: true } : { ok: false, reason: 'bad_signature' };
}

function signature(key: Buffer, id: string, timestamp: string, body: string | Buffer): string {
  return createHmac('sha256', key)
    .update(`${id}.${timestamp}.`, 'utf8')
    .update(typeof body === 'string' ? Buffer.from(body, 'utf8') : body)
    .digest('base64');
}

/** The single non-empty value of header `name` (case-insensitive), else `null`. */
function headerValue(headers: WebhookHeaders, name: string): string | null {
  let found: string | null = null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    if (typeof value !== 'string' || value.length === 0 || found !== null) return null;
    found = value;
  }
  return found;
}
