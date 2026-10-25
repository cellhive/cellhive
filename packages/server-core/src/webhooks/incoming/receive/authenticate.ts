import { Buffer } from 'node:buffer';
import { createHash, timingSafeEqual } from 'node:crypto';

import {
  authUsesBearer,
  authUsesSignature,
  INCOMING_WEBHOOK_MAX_MESSAGE_ID_LENGTH,
  type IncomingWebhookAuth,
} from '@cellhive/contracts';

import { verifyWebhook, type WebhookHeaders } from '../../standard-webhooks.js';
import { hashHookSecret } from '../credentials.js';

export interface HookCredentialsInput {
  readonly auth: IncomingWebhookAuth;
  /** `bearer_hash` of the hook (hex SHA-256), when the Bearer check is on. */
  readonly bearerHash: string | null;
  /**
   * Plain signing secrets accepted now: the current one and, during the
   * 24 h after a rotation, the previous one (ADR-22 §3).
   */
  readonly signingSecrets: readonly string[];
}

export type HookAuthResult =
  | {
      readonly ok: true;
      /**
       * Replay key (`message_id`): the signed `webhook-id` when the
       * signature is checked, else `null` (no dedupe, ADR-35 §1).
       */
      readonly messageId: string | null;
    }
  | { readonly ok: false };

/**
 * Checks the credentials of a request to a hook, in order (ADR-35 §1 step
 * 6): the Bearer token (`Authorization: Bearer <token>`, its SHA-256
 * compared in constant time with `bearer_hash`), then the Standard
 * Webhooks signature (T601 `verifyWebhook`: timestamp within 300 s, one
 * `v1` signature of a current or previous secret, constant time). Any
 * failure is the same `{ ok: false }` — the route answers `401` with no
 * reason (CONTRACTS §10). Never logs anything.
 */
export function authenticateHookRequest(
  hook: HookCredentialsInput,
  headers: WebhookHeaders,
  rawBody: Buffer,
  now: Date,
): HookAuthResult {
  if (authUsesBearer(hook.auth)) {
    if (hook.bearerHash === null || !bearerMatches(headers, hook.bearerHash)) return { ok: false };
  }
  if (!authUsesSignature(hook.auth)) return { ok: true, messageId: null };
  if (hook.signingSecrets.length === 0) return { ok: false };
  const result = verifyWebhook(headers, rawBody, hook.signingSecrets, now);
  if (!result.ok) return { ok: false };
  const id = singleHeader(headers, 'webhook-id');
  return id === null ? { ok: false } : { ok: true, messageId: messageIdOf(id) };
}

/**
 * The stored replay key of a `webhook-id`: as is up to 256 characters,
 * else `sha256:<hex>` (still unique per id, fits the column).
 */
export function messageIdOf(webhookId: string): string {
  return webhookId.length <= INCOMING_WEBHOOK_MAX_MESSAGE_ID_LENGTH
    ? webhookId
    : `sha256:${createHash('sha256').update(webhookId, 'utf8').digest('hex')}`;
}

const BEARER = /^Bearer[ ]+([^\s]+)[ ]*$/iu;

function bearerMatches(headers: WebhookHeaders, bearerHash: string): boolean {
  const value = singleHeader(headers, 'authorization');
  const token = value === null ? undefined : BEARER.exec(value)?.[1];
  if (token === undefined) return false;
  const presented = Buffer.from(hashHookSecret(token), 'utf8');
  const expected = Buffer.from(bearerHash, 'utf8');
  // Both are 64 hex characters; the length check only guards a corrupt row.
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

/** The single value of header `name` (case-insensitive), else `null`. */
function singleHeader(headers: WebhookHeaders, name: string): string | null {
  let found: string | null = null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    if (typeof value !== 'string' || found !== null) return null;
    found = value;
  }
  return found;
}
