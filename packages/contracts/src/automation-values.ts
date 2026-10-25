import { z } from 'zod';

import { idOf } from './ids.js';

/**
 * Building blocks shared by automation triggers and actions (SPEC §11,
 * CONTRACTS §21): action ids, filters and the values of SPEC §11.4.
 *
 * Kept apart from `automations.ts` so that the trigger and action files
 * (`automation-triggers/*.ts`, `automation-actions/*.ts`) can use them
 * without an import cycle. BACKLOG T502 defines the frame; T504 completes
 * the values: `path` syntax, templates (`{{ formula }}` stored with field
 * ids, checked by `@cellhive/formula-engine` against what `run_as` reads,
 * `REGEX*` refused), `digest`, the text contexts and output limits.
 */

/** Longest action id, `act_` included. */
export const MAX_ACTION_ID_LENGTH = 36;

/**
 * Id of an action inside one definition (`act_…`, chosen by the client,
 * unique across the definition including `if` branches). Not a CONTRACTS
 * §1.2 public id: it only names a step for `{ "step": … }` values and the
 * run log.
 */
export const automationActionIdSchema = z
  .string()
  .regex(/^act_[0-9A-Za-z_]{1,32}$/u, {
    message: 'Expected an action id of the form act_<1–32 letters, digits or _>',
  })
  .meta({ description: 'Action id, unique in the definition', example: 'act_1' });
export type AutomationActionId = z.infer<typeof automationActionIdSchema>;

/**
 * A Filter DSL tree (SPEC §6.1) or its tuple form (CONTRACTS §3). The
 * structure is checked by the server (`@cellhive/filter-dsl`) against the
 * table and the saver's permissions; errors come back under
 * `422 AUTOMATION_INVALID` with the filter's path. Stored as DSL with ids.
 */
export const automationFilterSchema = z.record(z.string(), z.unknown()).meta({
  id: 'AutomationFilter',
  description:
    'Filter DSL `{ op, items }` / condition `{ field, operator, value }` (SPEC §6.1), or the ' +
    'tuple form (CONTRACTS §3). Validated against the table by the server.',
});
export type AutomationFilter = z.infer<typeof automationFilterSchema>;

/** Longest template source (SPEC §11.4; the email body cap of BACKLOG T504). */
export const MAX_TEMPLATE_LENGTH = 20_000;
/** Longest `path` of a `step`/`trigger` value. */
export const MAX_VALUE_PATH_LENGTH = 500;
/** Most rows a `digest` renders (SPEC §11.4). */
export const MAX_DIGEST_ROWS = 200;
export const DEFAULT_DIGEST_ROWS = 50;

/** Any JSON value of a `literal`. */
const literalJsonSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
]);

/** One step of a value path: an object key or an array index. */
export type ValuePathSegment = string | number;

/**
 * Parses a value `path` (SPEC §11.4): keys separated by `.`, `[n]` for an
 * array item (`items[0].sku`, `records[2].fields.fld_…`, `[0]`). A key is
 * any run of characters other than `.`, `[`, `]`. `null` when malformed
 * (empty key, `[x]`, unclosed bracket…).
 */
export function parseValuePath(path: string): ValuePathSegment[] | null {
  if (path === '') return null;
  const out: ValuePathSegment[] = [];
  let index = 0;
  let expectKey = true;
  while (index < path.length) {
    const char = path[index];
    if (char === '[') {
      if (expectKey && out.length > 0) return null;
      const close = path.indexOf(']', index);
      const digits = close === -1 ? '' : path.slice(index + 1, close);
      if (!/^\d{1,9}$/u.test(digits)) return null;
      out.push(Number(digits));
      index = close + 1;
      expectKey = false;
      continue;
    }
    if (char === '.') {
      if (expectKey) return null;
      index += 1;
      expectKey = true;
      continue;
    }
    if (!expectKey) return null;
    let end = index;
    while (end < path.length && !'.[]'.includes(path[end] ?? '')) end += 1;
    if (end === index) return null;
    out.push(path.slice(index, end));
    index = end;
    expectKey = false;
  }
  return expectKey ? null : out;
}

/**
 * The value at `path` in `value` (JSON), `null` when any step is missing:
 * a key on a non-object, an index out of range or on a non-array.
 */
export function readValuePath(value: unknown, path: readonly ValuePathSegment[]): unknown {
  let current: unknown = value;
  for (const segment of path) {
    if (typeof segment === 'number') {
      if (!Array.isArray(current) || segment >= current.length) return null;
      current = current[segment] as unknown;
    } else {
      if (current === null || typeof current !== 'object' || Array.isArray(current)) return null;
      if (!Object.hasOwn(current, segment)) return null;
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return current ?? null;
}

const valuePathSchema = z
  .string()
  .min(1)
  .max(MAX_VALUE_PATH_LENGTH)
  .refine((path) => parseValuePath(path) !== null, {
    message: 'Expected keys separated by "." and [n] for array items, e.g. items[0].sku',
  })
  .meta({ description: 'Dotted path with `[n]` for array items, e.g. `items[0].sku`' });

export const literalValueSchema = z
  .strictObject({ literal: literalJsonSchema })
  .meta({ id: 'AutomationLiteralValue', description: 'A constant (SPEC §11.4)' });

export const fieldValueSchema = z.strictObject({ field: idOf('fld') }).meta({
  id: 'AutomationFieldValue',
  description: 'A field of the trigger record (latest version, read as `run_as`)',
});

export const stepValueSchema = z
  .strictObject({ step: automationActionIdSchema, path: valuePathSchema.optional() })
  .meta({
    id: 'AutomationStepValue',
    description: 'Output of an earlier action (`null` when it did not run or has no such path)',
  });

export const triggerValueSchema = z
  .strictObject({ trigger: z.string().min(1).max(64), path: valuePathSchema.optional() })
  .meta({
    id: 'AutomationTriggerValue',
    description:
      'Data of the trigger (SPEC §11.4): `fired_at` (`schedule`), `due_at` ' +
      '(`record.date_reached`), `clicked_by`/`clicked_at` (`button.clicked`), `actor` ' +
      '(`record.*`, `form.submitted`: id of the user who caused the event, `null` for the ' +
      'system or an automation), `body`/`headers`/`query` (`webhook.received`: the stored ' +
      'request — header names in lower case, sensitive headers always `null`; a request no ' +
      'longer stored fails the step `trigger_data_expired`)',
  });

export const templateValueSchema = z
  .strictObject({ template: z.string().max(MAX_TEMPLATE_LENGTH) })
  .meta({
    id: 'AutomationTemplateValue',
    description:
      'Text with `{{ formula }}` placeholders (formula of the trigger record, stored form: ' +
      '`{{ [fld_…] }}`; `\\{` is a literal brace). `REGEXMATCH`/`REGEXEXTRACT`/`REGEXREPLACE` ' +
      'and whole-table references are refused. Any result becomes text like `cell_format=text`',
  });

export const digestValueSchema = z
  .strictObject({
    digest: z.strictObject({
      step: automationActionIdSchema,
      row_template: z.string().max(MAX_TEMPLATE_LENGTH),
      max_rows: z.int().min(1).max(MAX_DIGEST_ROWS).default(DEFAULT_DIGEST_ROWS),
      separator: z.string().max(100).default('\n'),
    }),
  })
  .meta({
    id: 'AutomationDigestValue',
    description:
      'One line per record of an earlier `find_records` step: `row_template` is a template ' +
      'on each record (only the fields the step returns), lines joined by `separator`; past ' +
      '`max_rows` (≤ 200) one more line "… and N more records" in the organization locale; ' +
      'no record → ""',
  });

/** A value of an action config (SPEC §11.4). */
export const automationValueSchema = z
  .union([
    literalValueSchema,
    fieldValueSchema,
    stepValueSchema,
    triggerValueSchema,
    templateValueSchema,
    digestValueSchema,
  ])
  .meta({ id: 'AutomationValue', description: 'A value of an action config (SPEC §11.4)' });
export type AutomationValue = z.infer<typeof automationValueSchema>;

/** Field → value map of `create_record`/`update_record`/`update_records` (field ids). */
export const automationFieldValuesSchema = z
  .record(idOf('fld'), automationValueSchema)
  .meta({ description: 'Field id → value to write' });
export type AutomationFieldValues = z.infer<typeof automationFieldValuesSchema>;

// --- Templates: rendering (BACKLOG T504) ----------------------------------------------

/** Functions refused in every automation expression (S4b-followup §1.4, Quyết định S5 #2). */
export const AUTOMATION_DISALLOWED_FUNCTIONS = [
  'REGEXMATCH',
  'REGEXEXTRACT',
  'REGEXREPLACE',
] as const;

/** Longest time one render (a template or a whole digest) may evaluate, in milliseconds. */
export const TEMPLATE_RENDER_BUDGET_MS = 100;

/**
 * Longest rendered text per place it goes (BACKLOG T504; the actions
 * T514–T516 apply theirs): longer output is cut with `…`. The HTML of an
 * email body is limited separately by `EMAIL_MAX_HTML_BYTES` (T514).
 */
export const TEMPLATE_OUTPUT_LIMITS = {
  email_subject: 255,
  email_body_source: MAX_TEMPLATE_LENGTH,
  telegram_text: 4_096,
  notification_title: 200,
  notification_body: 2_000,
} as const;

/**
 * How placeholder values are made safe for where the text goes:
 * - `raw`: as is (a value written to a record field);
 * - `plain`: control characters other than line feed and tab removed,
 *   line breaks normalised to `\n`;
 * - `header`: one line — CR/LF and every control character become a space
 *   (email subject, display names);
 * - `telegram_html`: values HTML-escaped (`& < > "`); inside a tag only an
 *   `http`/`https`/`mailto` URL survives (Telegram `parse_mode=HTML`);
 * - `url_component`: each value percent-encoded like `encodeURIComponent`
 *   (the URL of `http_request`, T606 — a value can never add a path
 *   segment, a query or a fragment); the whole text is one line;
 * - `json_string`: each value escaped as the content of a JSON string
 *   (quotes, backslashes, control characters — a JSON body template of
 *   `http_request`, T606).
 * Email bodies do not escape: they are parsed as Markdown first and each
 * value replaces its placeholder as a text node (`@cellhive/markdown`).
 */
export const AUTOMATION_TEXT_CONTEXTS = [
  'raw',
  'plain',
  'header',
  'telegram_html',
  'url_component',
  'json_string',
] as const;
export type AutomationTextContext = (typeof AUTOMATION_TEXT_CONTEXTS)[number];

/**
 * Warnings of a render, kept in the step output (never with record values):
 * `unknown_reference` (a field deleted or no longer readable by `run_as`: the
 * placeholder is empty), `invalid_expression` (does not check any more),
 * `field_unavailable` (a `{ field }` value `run_as` cannot read),
 * `render_timeout` (cut after `TEMPLATE_RENDER_BUDGET_MS`),
 * `linked_records_truncated` (more linked records than one render reads),
 * `inline_image_skipped` (an email image left out — a field image not
 * `ready`, without thumbnail or that `run_as` may not download, with
 * `field_id`; an asset gone, without — BACKLOG T534).
 */
export const TEMPLATE_WARNING_CODES = [
  'unknown_reference',
  'invalid_expression',
  'field_unavailable',
  'render_timeout',
  'linked_records_truncated',
  'inline_image_skipped',
] as const;
export type TemplateWarningCode = (typeof TEMPLATE_WARNING_CODES)[number];

/**
 * Errors that stop a step (`error.code` of the step, lower case like other
 * run errors): `unsupported_function` — a stored expression calls a refused
 * function (the worker checks again before evaluating; `params.function`);
 * `trigger_data_expired` — a `webhook.received` value or template reads a
 * request that is no longer stored (kept 7 days, BACKLOG T604).
 */
export const TEMPLATE_STEP_ERROR_CODES = ['unsupported_function', 'trigger_data_expired'] as const;
export type TemplateStepErrorCode = (typeof TEMPLATE_STEP_ERROR_CODES)[number];

// --- Templates: trigger and step references (BACKLOG T505) -----------------------------

/**
 * References a template may use besides the fields of its record (SPEC
 * §11.4), stored by ID like fields (`[…]` in the formula):
 * - `[@id]`, `[@url]` on every record (the trigger record, a linked record,
 *   a step record): its ID and its link in the web app;
 * - trigger data on the trigger row: `[@fired_at]` (every trigger),
 *   `[@due_at]` (`record.date_reached`), `[@clicked_by]` / `[@clicked_at]`
 *   (`button.clicked`), `[@actor]` (`record.*`, `form.submitted`: the user
 *   whose change caused the event; empty for a change of the system or of
 *   an automation);
 * - webhook data (`webhook.received`, BACKLOG T604): `[@body]` (the whole body
 *   as JSON text), `[@body.<path>]`, `[@headers.<name>]`, `[@query.<path>]`
 *   — `<path>` as in a value path (`[@body.items[0\].sku]`: `]` is escaped
 *   inside `[…]`), text like any template value (an object or list as JSON text),
 *   sensitive headers always empty (`webhookTemplateReferenceOf`);
 * - `[@previous]` (`record.updated` only): the trigger record as it was
 *   before the change, a single-record link — `{{ [@previous].[fld_…] }}`
 *   is the value before the change of a field in the event's `changes`,
 *   the current value of any other field;
 * - the record of an earlier `create_record` / `update_record` /
 *   `find_records` step (the first record found): `[act_…]`, a single-record
 *   link — `{{ [act_1].[fld_…] }}`, `{{ [act_1].[@url] }}`, `{{ [act_1] }}`
 *   (its title). The record is read again as `run_as` when the template
 *   renders; a step that has not run (other `if` branch) or found nothing
 *   is empty.
 */
export const TEMPLATE_RECORD_REFERENCES = ['@id', '@url'] as const;
export const TEMPLATE_TRIGGER_REFERENCES = [
  '@fired_at',
  '@due_at',
  '@clicked_by',
  '@clicked_at',
  '@actor',
  '@body',
  '@headers',
  '@query',
] as const;
/** The trigger record before the change (`record.updated`), `[@previous].[fld_…]`. */
export const TEMPLATE_PREVIOUS_REFERENCE = '@previous';
export type TemplateTriggerReference = (typeof TEMPLATE_TRIGGER_REFERENCES)[number];

/** Action types whose step record a template can reference as `[act_…]`. */
export const TEMPLATE_STEP_ACTION_TYPES = [
  'create_record',
  'update_record',
  'find_records',
] as const;

/** Whether `id` is a template reference other than a field (`[@…]`, `[act_…]`). */
export function isTemplateReferenceId(id: string): boolean {
  return (
    /^(?:@[a-z_]{1,32}|act_[0-9A-Za-z_]{1,32})$/u.test(id) ||
    webhookTemplateReferenceOf(id) !== null
  );
}

// --- Webhook data (BACKLOG T604) ---------------------------------------------------------

/** Parts of the `webhook.received` trigger data (SPEC §11.4, ADR-35 §2). */
export const WEBHOOK_TRIGGER_PARTS = ['body', 'headers', 'query'] as const;
export type WebhookTriggerPart = (typeof WEBHOOK_TRIGGER_PARTS)[number];

/** A template reference to webhook data, parsed. */
export interface WebhookTemplateReference {
  readonly part: WebhookTriggerPart;
  /** Steps into the part (empty = the whole part). */
  readonly path: readonly ValuePathSegment[];
}

const WEBHOOK_REFERENCE = /^@(body|headers|query)(.*)$/su;

/**
 * Parses a template reference to webhook data: `@body`, `@headers`,
 * `@query` alone, or followed by `.<path>` / `[n]…` in the syntax of
 * {@link parseValuePath} (`@body.customer.email`, `@body[0].sku`,
 * `@headers.x-shop-topic`, `@query.tags[1]`). `null` for anything else,
 * including a path longer than `MAX_VALUE_PATH_LENGTH`.
 */
export function webhookTemplateReferenceOf(id: string): WebhookTemplateReference | null {
  const match = WEBHOOK_REFERENCE.exec(id);
  if (match === null) return null;
  const part = match[1] as WebhookTriggerPart;
  const rest = match[2] ?? '';
  if (rest === '') return { part, path: [] };
  const source = rest.startsWith('.') ? rest.slice(1) : rest.startsWith('[') ? rest : null;
  if (source === null || source.length > MAX_VALUE_PATH_LENGTH) return null;
  const path = parseValuePath(source);
  return path === null ? null : { part, path };
}
