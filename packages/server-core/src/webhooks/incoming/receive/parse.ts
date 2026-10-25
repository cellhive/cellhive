import {
  INCOMING_WEBHOOK_MAX_HEADER_VALUE_LENGTH,
  INCOMING_WEBHOOK_MAX_JSON_DEPTH,
  INCOMING_WEBHOOK_MAX_STORED_HEADERS,
  isSensitiveWebhookHeader,
} from '@cellhive/contracts';

import type { JsonValue } from '../../../db/schema.js';
import type { Buffer } from 'node:buffer';

/**
 * Pure parsing of what the public route `POST /api/v1/hooks/:token` stores
 * (BACKLOG T603, ADR-35 §1, CONTRACTS §25.2): the body by its
 * `Content-Type`, the query string and the headers kept on the request row.
 * Nothing here logs or throws on hostile input.
 */

export type ParsedWebhookBody =
  | { readonly ok: true; readonly value: JsonValue }
  | {
      readonly ok: false;
      /** `unsupported` → `415`; `malformed` → `400 MALFORMED_JSON`. */
      readonly error: 'unsupported' | 'malformed';
    };

const JSON_TYPE = 'application/json';
const FORM_TYPE = 'application/x-www-form-urlencoded';
const UTF8_CHARSETS: ReadonlySet<string> = new Set(['utf-8', 'utf8']);

/**
 * Characters PostgreSQL `jsonb` refuses: NUL (`\u0000`) and a lone UTF-16
 * surrogate (JSON.stringify writes it as an escape `jsonb` rejects).
 */
// In `u` mode a surrogate range only matches a surrogate that is not part of a pair.
// eslint-disable-next-line no-control-regex -- NUL is exactly what jsonb refuses.
const NOT_STORABLE = /[\u0000\ud800-\udfff]/u;
// eslint-disable-next-line no-control-regex -- as above.
const NOT_STORABLE_GLOBAL = /[\u0000\ud800-\udfff]/gu;

/**
 * The body of a webhook request:
 * - empty (0 bytes) → `null`, whatever the `Content-Type`;
 * - `application/json` (charset UTF-8 or none) → an object or an array
 *   (another JSON value, invalid UTF-8 or invalid JSON → `malformed`);
 * - `application/x-www-form-urlencoded` → an object of strings, a repeated
 *   key becoming an array in arrival order;
 * - anything else, or another charset → `unsupported`.
 * A value with a NUL character or a lone surrogate cannot be stored in
 * `jsonb`, and objects/arrays nested deeper than
 * `INCOMING_WEBHOOK_MAX_JSON_DEPTH` (64) are refused (QA S5c: a 1 MiB body
 * of `[` made `JSON.stringify` throw later, a `500`): both `malformed` too.
 */
export function parseWebhookBody(raw: Buffer, contentType: string | undefined): ParsedWebhookBody {
  if (raw.length === 0) return { ok: true, value: null };
  const media = parseMediaType(contentType);
  if (media === null) return { ok: false, error: 'unsupported' };
  if (media.charset !== null && !UTF8_CHARSETS.has(media.charset)) {
    return { ok: false, error: 'unsupported' };
  }

  if (media.type === JSON_TYPE) {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(raw);
    } catch {
      return { ok: false, error: 'malformed' };
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return { ok: false, error: 'malformed' };
    }
    if (typeof value !== 'object' || value === null) return { ok: false, error: 'malformed' };
    return storable(value)
      ? { ok: true, value: value as JsonValue }
      : { ok: false, error: 'malformed' };
  }

  if (media.type === FORM_TYPE) {
    const value = formFields(new URLSearchParams(raw.toString('utf8')));
    return storable(value) ? { ok: true, value } : { ok: false, error: 'malformed' };
  }

  return { ok: false, error: 'unsupported' };
}

/**
 * The query string of the request URL (`?a=1&a=2&b=`) as an object: a
 * repeated key becomes an array. Characters `jsonb` refuses are replaced
 * with U+FFFD (the query is informational; the request is not refused).
 */
export function parseWebhookQuery(search: string): Record<string, string | string[]> {
  const fields = formFields(new URLSearchParams(search));
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      sanitize(key),
      Array.isArray(value) ? value.map(sanitize) : sanitize(value),
    ]),
  );
}

/** Request headers as Node exposes them (lower-case names). */
export type IncomingHeaders = Readonly<Record<string, string | readonly string[] | undefined>>;

/**
 * Headers kept on the request row and in a sample (ADR-35 §1): lower-case
 * names in arrival order, the sensitive ones removed
 * (`INCOMING_WEBHOOK_SENSITIVE_HEADERS`), at most 50, each value cut to
 * 8 192 characters, repeated values joined with `, `.
 */
export function storedWebhookHeaders(headers: IncomingHeaders): Record<string, string> {
  const kept: [string, string][] = [];
  for (const [rawName, rawValue] of Object.entries(headers)) {
    if (kept.length >= INCOMING_WEBHOOK_MAX_STORED_HEADERS) break;
    if (rawValue === undefined) continue;
    const name = rawName.toLowerCase();
    if (isSensitiveWebhookHeader(name)) continue;
    const joined = typeof rawValue === 'string' ? rawValue : rawValue.join(', ');
    kept.push([
      sanitize(name),
      sanitize(joined.slice(0, INCOMING_WEBHOOK_MAX_HEADER_VALUE_LENGTH)),
    ]);
  }
  return Object.fromEntries(kept);
}

/** `type/subtype` (lower case) and `charset` of a `Content-Type`, or `null` without one. */
function parseMediaType(
  contentType: string | undefined,
): { readonly type: string; readonly charset: string | null } | null {
  if (contentType === undefined) return null;
  const [type = '', ...params] = contentType.split(';');
  const normalized = type.trim().toLowerCase();
  if (normalized === '') return null;
  let charset: string | null = null;
  for (const param of params) {
    const eq = param.indexOf('=');
    if (eq === -1) continue;
    if (param.slice(0, eq).trim().toLowerCase() !== 'charset') continue;
    charset = param
      .slice(eq + 1)
      .trim()
      .replace(/^"(.*)"$/u, '$1')
      .toLowerCase();
  }
  return { type: normalized, charset };
}

/**
 * Fields of a form or query string. `Object.fromEntries` defines own
 * properties, so a key such as `__proto__` stays a plain key.
 */
function formFields(params: URLSearchParams): Record<string, string | string[]> {
  const grouped = new Map<string, string[]>();
  for (const [key, value] of params) {
    const values = grouped.get(key);
    if (values === undefined) grouped.set(key, [value]);
    else values.push(value);
  }
  return Object.fromEntries(
    [...grouped].map(([key, values]) => [key, values.length === 1 ? (values[0] ?? '') : values]),
  );
}

/**
 * Whether every string and key of `value` can be stored in `jsonb`, and no
 * object or array is nested deeper than `INCOMING_WEBHOOK_MAX_JSON_DEPTH`.
 * Iterative.
 */
function storable(value: unknown): boolean {
  const stack: { item: unknown; depth: number }[] = [{ item: value, depth: 0 }];
  while (stack.length > 0) {
    const next = stack.pop();
    if (next === undefined) break;
    const { item, depth } = next;
    if (typeof item === 'string') {
      if (NOT_STORABLE.test(item)) return false;
    } else if (typeof item === 'object' && item !== null) {
      if (depth >= INCOMING_WEBHOOK_MAX_JSON_DEPTH) return false;
      if (Array.isArray(item)) {
        for (const child of item as unknown[]) stack.push({ item: child, depth: depth + 1 });
      } else {
        for (const [key, child] of Object.entries(item)) {
          if (NOT_STORABLE.test(key)) return false;
          stack.push({ item: child, depth: depth + 1 });
        }
      }
    }
  }
  return true;
}

function sanitize(value: string): string {
  return value.replace(NOT_STORABLE_GLOBAL, '�');
}
