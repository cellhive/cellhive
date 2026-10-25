import {
  isSensitiveWebhookHeader,
  readValuePath,
  webhookTemplateReferenceOf,
  type ValuePathSegment,
  type WebhookTriggerPart,
} from '@cellhive/contracts';

import type { SchemaSnapshot, SnapshotField } from '@cellhive/formula-engine';

/**
 * Data of a `webhook.received` run (BACKLOG T604, SPEC §11.4, ADR-35 §2):
 * the stored request (`meta.incoming_webhook_requests`) read by
 * `{ "trigger": "body" | "headers" | "query", "path" }` values and the
 * `[@body…]`/`[@headers…]`/`[@query…]` template references. Pure: the
 * engine loads the row, this shapes what a value or a template sees.
 */

/** The parts of a stored request a run reads. */
export interface WebhookRequestData {
  readonly body: unknown;
  readonly headers: unknown;
  readonly query: unknown;
}

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Stored headers as a run sees them: names in lower case, every sensitive
 * header (`INCOMING_WEBHOOK_SENSITIVE_HEADERS`) left out. The route never
 * stores them; this guards rows written otherwise (an older row, a change
 * of the list).
 */
function visibleHeaders(headers: unknown): Record<string, unknown> {
  if (!isObject(headers)) return {};
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (isSensitiveWebhookHeader(lower)) continue;
    out[lower] = value;
  }
  return out;
}

/**
 * The value of `part` at `path` (`null` when missing). A header name is
 * matched in lower case; a sensitive header is always `null`.
 */
export function webhookPartValue(
  data: WebhookRequestData,
  part: WebhookTriggerPart,
  path: readonly ValuePathSegment[],
): unknown {
  switch (part) {
    case 'body':
      return readValuePath(data.body ?? null, path);
    case 'query':
      return readValuePath(data.query ?? null, path);
    case 'headers': {
      const [name, ...rest] = path;
      const headers = visibleHeaders(data.headers);
      if (name === undefined) return headers;
      if (typeof name !== 'string') return null;
      return readValuePath(headers, [name.toLowerCase(), ...rest]);
    }
  }
}

/**
 * A webhook value as template text: a string as is, a number or boolean
 * as written in JSON, an object or list as JSON text, nothing → `null`
 * (an empty placeholder).
 */
export function webhookTemplateText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** The value of a webhook template reference id (`@body.customer.email`…) as text. */
export function webhookReferenceText(data: WebhookRequestData, id: string): string | null {
  const reference = webhookTemplateReferenceOf(id);
  if (reference === null) return null;
  return webhookTemplateText(webhookPartValue(data, reference.part, reference.path));
}

/**
 * Webhook references named in `source`: every `[…]` (escapes `\]`, `\\`
 * decoded like the formula lexer) whose content parses as one. A bracket
 * in plain text or in a string literal may be listed too — it only adds a
 * field nothing reads.
 */
export function webhookReferencesIn(source: string): string[] {
  const found = new Set<string>();
  let index = source.indexOf('[@');
  while (index !== -1) {
    let name = '';
    let end = -1;
    for (let at = index + 1; at < source.length; at += 1) {
      const char = source.charAt(at);
      if (char === '\\' && at + 1 < source.length) {
        name += source.charAt(at + 1);
        at += 1;
        continue;
      }
      if (char === ']') {
        end = at;
        break;
      }
      name += char;
    }
    if (end === -1) break;
    if (webhookTemplateReferenceOf(name) !== null) found.add(name);
    index = source.indexOf('[@', end + 1);
  }
  return [...found];
}

/** The webhook part fields (`@body`, `@headers`, `@query`) mark a row that reads webhook data. */
export const WEBHOOK_PART_REFERENCES = ['@body', '@headers', '@query'] as const;

/**
 * The snapshot a template on a `webhook.received` row is checked and
 * evaluated with: its row table (the one holding the `@body` field of
 * `TRIGGER_REFERENCES`) gains one text field per webhook reference with a
 * path in `source` — such references are open-ended, so they cannot be
 * listed beforehand like `[@fired_at]`. Any other snapshot is returned as is.
 */
export function withWebhookReferences(snapshot: SchemaSnapshot, source: string): SchemaSnapshot {
  const row = snapshot.tables.find((table) => table.id === snapshot.tableId);
  if (row === undefined || !row.fields.some((field) => field.id === WEBHOOK_PART_REFERENCES[0])) {
    return snapshot;
  }
  const known = new Set(row.fields.map((field) => field.id));
  const extra: SnapshotField[] = webhookReferencesIn(source)
    .filter((id) => !known.has(id))
    .map((id) => ({ id, name: id, type: 'text' }));
  if (extra.length === 0) return snapshot;
  return {
    ...snapshot,
    tables: snapshot.tables.map((table) =>
      table === row ? { ...table, fields: [...table.fields, ...extra] } : table,
    ),
  };
}

/** Whether `id` names webhook data (`@body`, `@headers.x`…). */
export function isWebhookReference(id: string): boolean {
  return webhookTemplateReferenceOf(id) !== null;
}
