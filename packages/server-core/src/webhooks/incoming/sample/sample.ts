import { Buffer } from 'node:buffer';

import { INCOMING_WEBHOOK_SAMPLE_MAX_BODY_BYTES } from '@cellhive/contracts';

import type { JsonObject, JsonValue } from '../../../db/schema.js';

/**
 * The sample request of a hook ("listen for a sample request", S§11.4,
 * CONTRACTS §25.3, BACKLOG T603): what `meta.incoming_webhooks.sample`
 * holds and `GET …/sample` returns. Headers are the stored ones (sensitive
 * headers already removed).
 */
export interface IncomingWebhookSampleData {
  readonly body: JsonValue;
  readonly headers: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string | string[]>>;
  readonly truncated: boolean;
}

/**
 * Builds the sample of a request. A body whose JSON is over 64 KB (UTF-8
 * bytes) is replaced by its first 64 KB as a string — whole UTF-8
 * characters only — and `truncated` is set.
 */
export function buildSample(input: {
  readonly body: JsonValue;
  readonly headers: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string | string[]>>;
}): IncomingWebhookSampleData {
  const json = JSON.stringify(input.body);
  const bytes = Buffer.from(json, 'utf8');
  if (bytes.length <= INCOMING_WEBHOOK_SAMPLE_MAX_BODY_BYTES) {
    return { body: input.body, headers: input.headers, query: input.query, truncated: false };
  }
  return {
    body: utf8Prefix(bytes, INCOMING_WEBHOOK_SAMPLE_MAX_BODY_BYTES),
    headers: input.headers,
    query: input.query,
    truncated: true,
  };
}

/** The stored form (`jsonb`) of a sample. */
export function sampleToJson(sample: IncomingWebhookSampleData): JsonObject {
  return {
    body: sample.body,
    headers: { ...sample.headers },
    query: { ...sample.query },
    truncated: sample.truncated,
  };
}

/** A stored sample read back; `null` when the value is not one. */
export function sampleFromJson(value: JsonValue | null): IncomingWebhookSampleData | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { body, headers, query, truncated } = value;
  if (!isStringRecord(headers) || !isQueryRecord(query) || typeof truncated !== 'boolean') {
    return null;
  }
  return { body: body ?? null, headers, query, truncated };
}

/** The longest prefix of `bytes` of at most `max` bytes ending on a UTF-8 character boundary. */
function utf8Prefix(bytes: Buffer, max: number): string {
  let end = max;
  // Continuation bytes are 10xxxxxx: back off to the start of the cut character.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === 'string')
  );
}

function isQueryRecord(value: unknown): value is Record<string, string | string[]> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (item) =>
        typeof item === 'string' ||
        (Array.isArray(item) && item.every((entry) => typeof entry === 'string')),
    )
  );
}
