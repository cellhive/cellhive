import type { JsonValue } from '../../db/schema.js';

/**
 * What the person looking at a run log may read **now** (BACKLOG T518,
 * "Quy ước S5": a run log shows only the values its viewer can read).
 */
export interface StepReadability {
  /** Fields of `tableId` the viewer reads now; `undefined` when the table is not readable. */
  fieldsOf(tableId: string): ReadonlySet<string> | undefined;
  /** Whether the viewer reads this record now (exists, not trashed, inside their read rule). */
  recordVisible(tableId: string, recordId: string): boolean;
}

/** A step output as shown to one viewer. */
export interface RedactedOutput {
  readonly output: JsonValue | null;
  /** Some value was replaced by `null`. */
  readonly redacted: boolean;
}

/** Records of a step output whose visibility must be known (one table per step). */
export interface StepRecordRefs {
  readonly tableId: string;
  readonly recordIds: readonly string[];
}

/**
 * Action types whose output carries record values (`find_records`:
 * `{ records: [{ id, fields }], count, truncated }`, CONTRACTS §21): their
 * values are shown by the viewer's permissions. Every other output — `{ id }`
 * of the record actions, `{ result, branch }` of `if`, the counts and ids of
 * `update_records` (T506), the `send_email` output (T514: masked
 * recipients, sizes, SMTP codes), the `send_telegram` output (T516:
 * `{ message_id, secret_id, length, truncated }` — numbers, an id and a
 * boolean, never the text or the chat id), warnings, and any action added later — goes
 * through an allowlist instead ({@link idsAndCodes}): numbers, booleans,
 * ids, codes under code keys and the few formatted strings below are kept,
 * any other string becomes `null` (`redacted`). A new action whose output
 * must show other strings adds a rule here.
 */
export const VALUE_OUTPUT_ACTION_TYPES: ReadonlySet<string> = new Set(['find_records']);

/**
 * HTTP actions (T605–T607): `{ delivery_id, status, headers: { content-type },
 * body, body_truncated }`. The response `body` is what the destination
 * answered to a request rendered with `run_as`'s values (it may echo them):
 * it is shown only when the caller decides the viewer may see it
 * (`showHttpBody` — they read every field the step's values use now,
 * {@link valuesVisible}); otherwise `null` and `redacted`. The rest goes
 * through the allowlist (`content-type` is kept when it is a media type).
 */
export const HTTP_OUTPUT_ACTION_TYPES: ReadonlySet<string> = new Set([
  'http_request',
  'run_n8n_workflow',
]);

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Public ids (`rec_…`, `eid_…`, `run_…`; CONTRACTS §1.2). */
const ID = /^[a-z]{3}_[0-9A-Za-z]{16}$/u;
/** Machine codes (`then`, `send_as`, `RECIPIENT_MAY_NOT_READ`, `smtp_rejected`). */
const CODE = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/u;
/** An ISO UTC timestamp (`2026-10-05T03:15:00.000Z`). */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u;
/** A masked address: one character, stars, the domain (or only stars). */
const MASKED_ADDRESS = /^(?:[^\s@]?\*+@[^\s@]+|\*+)$/u;
/** Strings kept under these keys only, when they match (never free text). */
const STRING_RULES: Readonly<Record<string, RegExp>> = {
  code: CODE,
  branch: CODE,
  mode: CODE,
  footer: CODE,
  cause: CODE,
  status: CODE,
  // `send_email` (T514): the deterministic Message-ID, masked addresses
  // (`a***@corp.vn`, `***` — `maskAddress`), the RFC 3463 enhanced status code.
  message_id: /^<[^\s<>@]+@[^\s<>@]+>$/u,
  masked: MASKED_ADDRESS,
  accepted: MASKED_ADDRESS,
  enhanced: /^[245]\.\d{1,3}\.\d{1,3}$/u,
  // `delay` (T506): when it resumes and the recheck result.
  until: ISO_TIME,
  resumed_at: ISO_TIME,
  recheck: CODE,
  // `send_notification` (T515): why a recipient was left out (`skipped[].reason`);
  // recipients are user ids, the rest counts — never the title or body.
  reason: CODE,
  // HTTP steps (T606): the media type of the response (`application/json; charset=utf-8`).
  'content-type':
    /^[\w.+-]{1,64}\/[\w.+-]{1,64}(?:\s*;\s*[\w.+-]{1,64}=(?:[\w.+-]{1,64}|"[\w .+-]{0,64}"))*$/u,
};

/**
 * Keeps only numbers, booleans, `null`, ids, and the strings allowed under
 * their key by {@link STRING_RULES} (array items use their array's key);
 * every other string becomes `null` and is reported.
 */
function idsAndCodes(value: unknown, key: string | null, hidden: { found: boolean }): JsonValue {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const rule = key === null ? undefined : STRING_RULES[key];
    if (ID.test(value) || rule?.test(value) === true) return value;
    hidden.found = true;
    return null;
  }
  if (Array.isArray(value)) return value.map((item) => idsAndCodes(item, key, hidden));
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, idsAndCodes(item, name, hidden)]),
    );
  }
  hidden.found = true;
  return null;
}

// --- `delay` until a value (T506): its times show the value -----------------------------

/** What a `delay` waiting `until` a value read, to show its times (`until`, `resumed_at`). */
export interface DelayUntilContext {
  /** `config.until` of the step in the run's definition; `null`/absent = `minutes`. */
  readonly until: unknown;
  /** The trigger record and, for `record.date_reached`, its date field. */
  readonly trigger: {
    readonly tableId: string | null;
    readonly recordId: string | null;
    readonly dueFieldId: string | null;
  };
  /** Earlier steps: their table and the records of their output. */
  readonly steps: ReadonlyMap<
    string,
    { readonly tableId: string | null; readonly recordIds: readonly string[] }
  >;
}

const FIELD_ID = /fld_[0-9A-Za-z]{16}/gu;
const STEP_REF = /\[(act_[0-9A-Za-z_]{1,32})\]/gu;

interface UntilSources {
  readonly fields: readonly string[];
  readonly steps: readonly string[];
  readonly dueAt: boolean;
  /** Read from something whose visibility cannot be decided (a digest): hide. */
  readonly opaque: boolean;
}

/** Where a `delay`'s `until` value comes from; `null` for a delay of `minutes`. */
function untilSourcesOf(until: unknown): UntilSources | null {
  if (until === null || until === undefined) return null;
  const none = { fields: [], steps: [], dueAt: false, opaque: false };
  if (!isObject(until)) return { ...none, opaque: true };
  if ('literal' in until) return none;
  if (typeof until['field'] === 'string') return { ...none, fields: [until['field']] };
  if (typeof until['step'] === 'string') {
    const path = typeof until['path'] === 'string' ? until['path'] : '';
    return { ...none, steps: [until['step']], fields: path.match(FIELD_ID) ?? [] };
  }
  if (typeof until['trigger'] === 'string')
    return { ...none, dueAt: until['trigger'] === 'due_at' };
  if (typeof until['template'] === 'string') {
    const template = until['template'];
    return {
      fields: template.match(FIELD_ID) ?? [],
      steps: [...template.matchAll(STEP_REF)].map((match) => match[1] ?? ''),
      dueAt: template.includes('[@due_at]'),
      opaque: false,
    };
  }
  return { ...none, opaque: true };
}

/**
 * Whether the viewer may see what several values produced — the response
 * body of an HTTP step, T606 — by the rule of a `delay`'s `until`
 * ({@link delayUntilVisible}) applied to each: literals, trigger data
 * other than `due_at` and `NOW()` always; a field or an earlier step only
 * when the viewer reads it now; a `digest` never.
 */
export function valuesVisible(
  values: readonly unknown[],
  context: Omit<DelayUntilContext, 'until'>,
  readability: StepReadability,
): boolean {
  return values.every((until) => delayUntilVisible({ ...context, until }, readability));
}

/** Records whose visibility decides {@link valuesVisible}. */
export function valuesRecordRefs(
  values: readonly unknown[],
  context: Omit<DelayUntilContext, 'until'>,
): StepRecordRefs[] {
  return values.flatMap((until) => delayUntilRecordRefs({ ...context, until }));
}

/** Records whose visibility decides whether a `delay`'s times are shown. */
export function delayUntilRecordRefs(context: DelayUntilContext): StepRecordRefs[] {
  const sources = untilSourcesOf(context.until);
  if (sources === null || sources.opaque) return [];
  const refs: StepRecordRefs[] = [];
  const { tableId, recordId } = context.trigger;
  if ((sources.fields.length > 0 || sources.dueAt) && tableId !== null && recordId !== null) {
    refs.push({ tableId, recordIds: [recordId] });
  }
  for (const stepId of sources.steps) {
    const step = context.steps.get(stepId);
    if (step?.tableId != null) refs.push({ tableId: step.tableId, recordIds: step.recordIds });
  }
  return refs;
}

/**
 * Whether the viewer may see when a `delay` resumes (the coordinator's
 * decision for T518): always for `minutes`, a literal, `NOW()`/`TODAY()` or
 * a trigger time other than `due_at`; when it comes from a field or a step,
 * only if the viewer reads that field (on the trigger table or the step's
 * table) and the record(s) it was read from — the check of `find_records`.
 */
export function delayUntilVisible(
  context: DelayUntilContext,
  readability: StepReadability,
): boolean {
  const sources = untilSourcesOf(context.until);
  if (sources === null) return true;
  if (sources.opaque) return false;
  const tables: string[] = [];
  for (const stepId of sources.steps) {
    const step = context.steps.get(stepId);
    if (step?.tableId == null || readability.fieldsOf(step.tableId) === undefined) return false;
    if (!step.recordIds.every((id) => readability.recordVisible(step.tableId as string, id))) {
      return false;
    }
    tables.push(step.tableId);
  }
  const { tableId, recordId, dueFieldId } = context.trigger;
  const needsTrigger = sources.dueAt || sources.fields.some((field) => !readableOn(tables, field));
  if (!needsTrigger) return true;
  if (tableId === null || recordId === null || !readability.recordVisible(tableId, recordId)) {
    return false;
  }
  const own = readability.fieldsOf(tableId);
  if (own === undefined) return false;
  if (sources.dueAt && (dueFieldId === null || !own.has(dueFieldId))) return false;
  return sources.fields.every((field) => own.has(field) || readableOn(tables, field));

  function readableOn(stepTables: readonly string[], field: string): boolean {
    return stepTables.some((table) => readability.fieldsOf(table)?.has(field) === true);
  }
}

/** `records[]` of a `find_records` output, or `undefined` when it has another shape. */
function recordsOf(output: JsonValue | null): readonly unknown[] | undefined {
  if (!isObject(output)) return undefined;
  const records = output['records'];
  return Array.isArray(records) ? records : undefined;
}

/** The records of a step output the viewer's visibility is needed for. */
export function stepRecordRefs(
  actionType: string | null,
  tableId: string | null,
  output: JsonValue | null,
): StepRecordRefs | undefined {
  if (actionType === null || !VALUE_OUTPUT_ACTION_TYPES.has(actionType) || tableId === null) {
    return undefined;
  }
  const records = recordsOf(output) ?? [];
  const recordIds = records.flatMap((record) =>
    isObject(record) && typeof record['id'] === 'string' ? [record['id']] : [],
  );
  return { tableId, recordIds };
}

/**
 * The output of one step for a viewer: `find_records` values the viewer
 * cannot read now become `null` — a record outside their read rule (or of a
 * table they do not read, or an unknown table) is `{ id, fields: all null,
 * redacted: true, redacted_fields }`, a field they cannot read is `null` and
 * listed in `redacted_fields`. Other outputs keep ids, codes and counts
 * only ({@link idsAndCodes}). Something unexpected in a value-carrying
 * output hides the whole output.
 */
export function redactStepOutput(
  actionType: string | null,
  tableId: string | null,
  output: JsonValue | null,
  readability: StepReadability,
  options: {
    /** A `delay` whose `until` the viewer may not read ({@link delayUntilVisible}). */
    readonly hideDelayTimes?: boolean;
    /** An HTTP step whose response body the viewer may read ({@link valuesVisible}). */
    readonly showHttpBody?: boolean;
  } = {},
): RedactedOutput {
  if (output === null) return { output: null, redacted: false };
  if (actionType !== null && HTTP_OUTPUT_ACTION_TYPES.has(actionType) && isObject(output)) {
    const hidden = { found: false };
    const { body, ...rest } = output as Record<string, JsonValue>;
    const shown = idsAndCodes(rest, null, hidden) as Record<string, JsonValue>;
    if (body === undefined) return { output: shown, redacted: hidden.found };
    if (options.showHttpBody === true)
      return { output: { ...shown, body }, redacted: hidden.found };
    return { output: { ...shown, body: null }, redacted: hidden.found || body !== null };
  }
  if (actionType === null || !VALUE_OUTPUT_ACTION_TYPES.has(actionType)) {
    const hidden = { found: false };
    const shown = idsAndCodes(output, null, hidden);
    if (options.hideDelayTimes === true && isObject(shown)) {
      const times: Record<string, JsonValue> = {};
      for (const key of ['until', 'resumed_at']) {
        if (shown[key] !== undefined && shown[key] !== null) {
          times[key] = null;
          hidden.found = true;
        }
      }
      return {
        output: { ...(shown as Record<string, JsonValue>), ...times },
        redacted: hidden.found,
      };
    }
    return { output: shown, redacted: hidden.found };
  }
  const records = recordsOf(output);
  if (records === undefined || !isObject(output)) return { output: null, redacted: true };
  const readable = tableId === null ? undefined : readability.fieldsOf(tableId);
  let redacted = false;
  const shown = records.map((record): JsonValue => {
    if (!isObject(record) || typeof record['id'] !== 'string' || !isObject(record['fields'])) {
      redacted = true;
      return null;
    }
    const id = record['id'];
    const fields = record['fields'];
    const visible =
      tableId !== null && readable !== undefined && readability.recordVisible(tableId, id);
    const out: Record<string, JsonValue> = {};
    const hidden: string[] = [];
    for (const [fieldId, value] of Object.entries(fields)) {
      if (visible && readable.has(fieldId)) {
        out[fieldId] = value as JsonValue;
      } else {
        out[fieldId] = null;
        hidden.push(fieldId);
      }
    }
    if (!visible || hidden.length > 0) redacted = true;
    return { id, fields: out, redacted: !visible, redacted_fields: hidden };
  });
  return { output: { ...(output as Record<string, JsonValue>), records: shown }, redacted };
}
