import { z } from 'zod';

import { deriveSecretKey, sealSecret, unsealSecret } from '../auth/secret-box.js';
import { causationSchema, type Causation } from '../events/event.js';

/**
 * The rendered request of a delivery, sealed in `request_enc` (ADR-35 §4):
 * AES-256-GCM with the key HKDF(`APP_MASTER_KEY`, `http-delivery:v1`)
 * — a key that serves nothing else. It holds the URL (which may carry a
 * token in its query), the headers the user set (never a secret value:
 * those stay in `meta.secrets`, referenced by id), the body, the name of
 * the auth header and the loop-guard causation of the step (a fresh
 * `X-Cellhive-Causation` token is made from it at each attempt). Erased
 * when the delivery is final; never logged.
 */
export interface HttpDeliveryRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Full URL after rendering (≤ 2 048 characters). */
  readonly url: string;
  /** Header name/value pairs set by the action (order kept, no secret values). */
  readonly headers: readonly (readonly [string, string])[];
  /** Exact body bytes as UTF-8 text, `null` without body. */
  readonly body: string | null;
  /** Header that carries the value of `auth_secret_id` (`Authorization`, `X-Api-Key`…). */
  readonly authHeaderName: string | null;
  /** Causation of the step (`null` for a test, which carries none). */
  readonly causation: Causation | null;
  /**
   * A signing secret was set: a delivery whose `signing_secret_id` was
   * cleared since (secret deleted) fails instead of going out unsigned.
   */
  readonly signed: boolean;
  /**
   * `false` (`http_request` with `fail_on_http_error: false`, T606): a final
   * `3xx`/`4xx`/`5xx` ends the step `succeeded` with its status. Absent in
   * requests sealed before T606: `true`.
   */
  readonly failOnHttpError?: boolean;
}

const sealedSchema = z.object({
  v: z.literal(1),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  url: z.string().min(1),
  headers: z.array(z.tuple([z.string(), z.string()])),
  body: z.string().nullable(),
  auth_header_name: z.string().nullable(),
  causation: causationSchema.nullable(),
  signed: z.boolean(),
  fail_on_http_error: z.boolean().optional(),
});

/** The 32-byte key of `request_enc`. */
export function deriveDeliveryKey(masterKey: Buffer | string): Buffer {
  return deriveSecretKey(masterKey, 'http-delivery');
}

export function sealDeliveryRequest(key: Buffer, request: HttpDeliveryRequest): string {
  return sealSecret(
    key,
    JSON.stringify({
      v: 1,
      method: request.method,
      url: request.url,
      headers: request.headers.map(([name, value]) => [name, value]),
      body: request.body,
      auth_header_name: request.authHeaderName,
      causation: request.causation,
      signed: request.signed,
      ...(request.failOnHttpError === false ? { fail_on_http_error: false } : {}),
    }),
  );
}

/**
 * The request sealed by {@link sealDeliveryRequest}, or `null` when it
 * cannot be opened (another master key, altered, unknown version).
 */
export function openDeliveryRequest(key: Buffer, sealed: string): HttpDeliveryRequest | null {
  let text: string;
  try {
    text = unsealSecret(key, sealed);
  } catch {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = sealedSchema.safeParse(raw);
  if (!parsed.success) return null;
  const value = parsed.data;
  return {
    method: value.method,
    url: value.url,
    headers: value.headers,
    body: value.body,
    authHeaderName: value.auth_header_name,
    causation: value.causation,
    signed: value.signed,
    failOnHttpError: value.fail_on_http_error ?? true,
  };
}
