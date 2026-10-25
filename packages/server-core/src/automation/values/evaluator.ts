import {
  AUTOMATION_DISALLOWED_FUNCTIONS,
  EMAIL_BODY_DIGEST_REFERENCE,
  isTemplateReferenceId,
  parseValuePath,
  readValuePath,
  TEMPLATE_RENDER_BUDGET_MS,
  WEBHOOK_TRIGGER_PARTS,
  type AutomationAction,
  type AutomationBranchAction,
  type AutomationDefinition,
  type AutomationTextContext,
  type AutomationValue,
  type Id,
  type TemplateStepErrorCode,
  type TemplateWarningCode,
} from '@cellhive/contracts';
import {
  checkTemplate,
  evaluate,
  EvaluationInterrupted,
  formatTemplateValue,
  FormulaError,
  type CheckedPlaceholder,
  type FormulaDataSource,
  type FormulaRecord,
  type SchemaSnapshot,
  type TemplatePart,
} from '@cellhive/formula-engine';

import { flattenActions, type AutomationValidationContext } from '../definition/validate.js';

import { moreRecordsLine } from './digest-text.js';
import { endsInsideTag, escapeValue, finishText, truncateText } from './escape.js';
import {
  definitionSources,
  PREVIOUS_RECORD_ID,
  RECORD_ID_REFERENCE,
  RECORD_URL_REFERENCE,
  stepRecordId,
  TRIGGER_REFERENCE_DATA,
  type TemplateSources,
} from './references.js';
import { automationSnapshot, stepFieldsOf } from './snapshot.js';
import {
  isWebhookReference,
  webhookPartValue,
  webhookReferenceText,
  withWebhookReferences,
  type WebhookRequestData,
} from './webhook-data.js';

/**
 * Run-time values of SPEC §11.4 (BACKLOG T504): the evaluator the run
 * engine (T505) and the send actions (T514–T516) call for every value of an
 * action config.
 *
 * - **Permissions**: every record is read through `reader` — the engine
 *   gives one bound to the effective access of `run_as` now (ADR-25 §1,
 *   `RecordQueryService`, see `recordQueryReader`) — and templates resolve
 *   against `context` (schema + access of `run_as` now). A field deleted or
 *   no longer readable renders empty with an `unknown_reference` warning;
 *   T507 decides whether the automation must be turned off.
 * - **REGEX**: before evaluating, every expression of the template is
 *   checked again; `REGEXMATCH`/`REGEXEXTRACT`/`REGEXREPLACE` throw
 *   `AutomationValueError('unsupported_function')` (the step fails) and the
 *   evaluator runs with `disallow` as well, so no path reaches `RegExp`.
 * - **Budget**: one render (a template, a whole digest) evaluates for at most
 *   `budgetMs` (100 ms) — record reads before it do not count. Past it the
 *   text is cut where it is (`truncated`, `render_timeout`).
 * - Templates never read whole tables (refused when saved); links are
 *   followed by reading the linked records (≤ `MAX_LINKED_RECORDS` per hop).
 * - Trigger data and step records (T505, `references.ts`): `[@fired_at]`…
 *   come from `trigger.data`, `[act_…]` from the step outputs (a step not
 *   run yet is empty), `[@id]`/`[@url]` from each record read — step
 *   records are read again through `reader` like linked records.
 * - Webhook data (T604, `webhook-data.ts`): `{ "trigger": "body" | "headers" |
 *   "query" }` values and `[@body…]` references read the stored request
 *   through `webhook.load`, only when a value or a placeholder needs it; a
 *   request no longer stored throws `trigger_data_expired` (the step fails).
 * - Warnings carry codes and positions only, never record values.
 */

/** Records read per link hop of one render; more → `linked_records_truncated`. */
export const MAX_LINKED_RECORDS = 1_000;

/** Reads records as `run_as` (unreadable records left out, unreadable fields absent). */
export interface AutomationRecordReader {
  read(
    tableId: Id<'tbl'>,
    recordIds: readonly string[],
    fieldIds: readonly string[],
  ): Promise<readonly FormulaRecord[]>;
}

export interface TemplateWarning {
  readonly code: TemplateWarningCode;
  /** Placeholder index in its template, when the warning is about one. */
  readonly placeholder?: number;
  /** Field of a `{ field }` value. */
  readonly field_id?: string;
}

/** A value that stops the step (`error.code` of the step, SPEC §11.7). */
export class AutomationValueError extends Error {
  override readonly name = 'AutomationValueError';

  constructor(
    readonly code: TemplateStepErrorCode,
    message: string,
    readonly params: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

export interface ResolvedValue {
  /** JSON of `literal`/`field`/`step`/`trigger`; text of `template`/`digest`. */
  readonly value: unknown;
  readonly warnings: readonly TemplateWarning[];
  /** The text was cut (budget or `maxLength`). */
  readonly truncated: boolean;
}

export interface RenderedText {
  readonly text: string;
  readonly warnings: readonly TemplateWarning[];
  readonly truncated: boolean;
}

export interface RenderOptions {
  /** How values are escaped (default `raw`). */
  readonly context?: AutomationTextContext;
  /** Longest text, in code points (`TEMPLATE_OUTPUT_LIMITS`); longer is cut with `…`. */
  readonly maxLength?: number;
}

export interface AutomationValueEvaluatorOptions {
  /** Schema of the base and access of `run_as` now (the shape definitions are validated with). */
  readonly context: AutomationValidationContext;
  /** The definition being run (for `find_records` steps behind `digest`). */
  readonly definition: AutomationDefinition;
  readonly reader: AutomationRecordReader;
  /** Trigger table and record (`null` without record) and the trigger data (`fired_at`…). */
  readonly trigger: {
    readonly tableId: Id<'tbl'> | null;
    readonly recordId: string | null;
    readonly data?: Readonly<Record<string, unknown>>;
  };
  /** Outputs of the steps run so far, by action id. */
  readonly steps?: ReadonlyMap<string, unknown>;
  /** Organization zone (ADR-21) and locale (number formats, the digest "more" line). */
  readonly timeZone: string;
  readonly locale: string;
  /** `NOW()` / `TODAY()`. */
  readonly now: Date;
  /** Milliseconds clock of the budget (default `performance.now`). */
  readonly clock?: () => number;
  readonly budgetMs?: number;
  /** Link to a record in the web app (`[@url]`); absent → empty. */
  readonly recordUrl?: (tableId: string, recordId: string) => string | null;
  /** Names of users known beforehand (the event's actor), by id. */
  readonly userNames?: ReadonlyMap<string, string>;
  /**
   * The request of a `webhook.received` run (T604): loaded on first use,
   * `null` when it is no longer stored. Absent → webhook values are `null`.
   */
  readonly webhook?: { readonly load: () => Promise<WebhookRequestData | null> };
}

interface CachedRecord {
  readonly id: string;
  readonly fields: Record<string, unknown>;
  readonly loaded: Set<string>;
  /** Not returned by the reader (missing, trashed, outside the read rule). */
  missing: boolean;
}

/** A template ready to evaluate on records of its snapshot's table. */
interface Prepared {
  readonly source: string;
  readonly snapshot: SchemaSnapshot;
  readonly parts: readonly TemplatePart[];
  readonly placeholders: ReadonlyMap<number, CheckedPlaceholder>;
  /** Placeholders that cannot be evaluated, with the warning they render with. */
  readonly broken: ReadonlyMap<number, TemplateWarningCode>;
}

const REFERENCE_CODES: ReadonlySet<string> = new Set([
  'UNKNOWN_FIELD',
  'UNKNOWN_TABLE',
  'NOT_A_LINK',
  'INVALID_MEMBER',
  'INVALID_REFERENCE',
]);

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Budget of one render. */
class Budget {
  private readonly started: number;
  expired = false;

  constructor(
    private readonly clock: () => number,
    private readonly limit: number,
  ) {
    this.started = clock();
  }

  readonly over = (): boolean => {
    if (!this.expired && this.clock() - this.started > this.limit) this.expired = true;
    return this.expired;
  };
}

export class AutomationValueEvaluator {
  private readonly actions = new Map<string, AutomationAction | AutomationBranchAction>();
  private readonly steps: Map<string, unknown>;
  private readonly records = new Map<string, CachedRecord>();
  private readonly userNames = new Map<string, string>();
  private readonly snapshots = new Map<string, SchemaSnapshot>();
  private readonly clock: () => number;
  private readonly budgetMs: number;
  private readonly sources: TemplateSources;
  private readonly primaryFields = new Map<string, string>();
  private webhookRequest: Promise<WebhookRequestData | null> | undefined;

  constructor(private readonly options: AutomationValueEvaluatorOptions) {
    const flat = flattenActions(options.definition.actions).map(({ action }) => action);
    for (const action of flat) this.actions.set(action.id, action);
    const { tableId, recordId } = options.trigger;
    this.sources = definitionSources(
      options.definition,
      flat,
      tableId !== null && recordId !== null ? tableId : null,
    );
    for (const table of options.context.tables) {
      if (table.primary_field_id != null) this.primaryFields.set(table.id, table.primary_field_id);
    }
    this.steps = new Map(options.steps ?? []);
    for (const [id, name] of options.userNames ?? []) this.userNames.set(id, name);
    this.clock = options.clock ?? (() => performance.now());
    this.budgetMs = options.budgetMs ?? TEMPLATE_RENDER_BUDGET_MS;
  }

  /**
   * The same run — trigger, step outputs so far, clock, zone, locale — read
   * as another person: their schema and access (`context`) and a `reader`
   * bound to them. `send_notification` renders its text once per permission
   * group of its recipients this way, never as `run_as` (ADR-32 §1, T515).
   */
  withAccess(
    context: AutomationValidationContext,
    reader: AutomationRecordReader,
  ): AutomationValueEvaluator {
    return new AutomationValueEvaluator({ ...this.options, context, reader, steps: this.steps });
  }

  /** Records the output of a step that just ran, for later `step`/`digest` values. */
  setStepOutput(actionId: string, output: unknown): void {
    this.steps.set(actionId, output);
  }

  /** The value of `value` now (see the module comment). */
  async resolve(value: AutomationValue, options: RenderOptions = {}): Promise<ResolvedValue> {
    if ('literal' in value) return { value: value.literal, warnings: [], truncated: false };
    if ('field' in value) return this.fieldValue(value.field);
    if ('step' in value) {
      return {
        value: this.pathValue(this.steps.get(value.step), value.path),
        warnings: [],
        truncated: false,
      };
    }
    if ('trigger' in value) {
      if (isWebhookPart(value.trigger) && this.options.webhook !== undefined) {
        const segments = value.path === undefined ? [] : parseValuePath(value.path);
        const request = await this.webhookData();
        return {
          value:
            segments === null ? null : (webhookPartValue(request, value.trigger, segments) ?? null),
          warnings: [],
          truncated: false,
        };
      }
      const data = this.options.trigger.data ?? {};
      const part = Object.hasOwn(data, value.trigger) ? data[value.trigger] : null;
      return { value: this.pathValue(part, value.path), warnings: [], truncated: false };
    }
    const rendered =
      'template' in value
        ? await this.renderTemplate(value.template, options)
        : await this.renderDigest(value.digest, options);
    return { value: rendered.text, warnings: rendered.warnings, truncated: rendered.truncated };
  }

  /**
   * Cells of the trigger record as the evaluator's person reads them now
   * (`send_email` attachments, T532): `null` without a trigger record or
   * when it is not readable (trash, outside the read rule, gone); fields
   * they cannot read are absent. Callers name readable fields only.
   */
  async triggerRecordCells(
    fieldIds: readonly string[],
  ): Promise<Readonly<Record<string, unknown>> | null> {
    const { tableId, recordId } = this.options.trigger;
    if (tableId === null || recordId === null) return null;
    const [record] = await this.ensureRecords(tableId, [recordId], fieldIds);
    return record === undefined ? null : record.fields;
  }

  /**
   * A template on the trigger record (SPEC §11.4). With `digest` (the lines
   * of a `send_telegram` text, T516), `{{ [@digest] }}` may place them: they
   * were rendered for the same `context` already (their row template kept,
   * their values escaped), so that exact placeholder is not escaped again.
   */
  async renderTemplate(
    source: string,
    options: RenderOptions & { readonly digest?: string } = {},
  ): Promise<RenderedText> {
    const withDigest = options.digest !== undefined;
    const prepared = this.prepare(source, this.rootSnapshot(withDigest));
    const warnings: TemplateWarning[] = [];
    const row = await this.rootRow(
      prepared,
      warnings,
      withDigest ? { [EMAIL_BODY_DIGEST_REFERENCE]: options.digest } : {},
    );
    const budget = new Budget(this.clock, this.budgetMs);
    const context = options.context ?? 'raw';
    const text = this.renderRow(prepared, row, context, budget, warnings, withDigest);
    return this.finish(text, context, options, budget, warnings);
  }

  /**
   * The values of the placeholders of `source`, in order, as plain text —
   * for an email body: `@cellhive/markdown` `parseTemplate` finds the same
   * placeholders (same scanner) and `substitute` puts each value in as a
   * text node, so nothing is escaped here.
   */
  async placeholderValues(
    source: string,
    options: {
      /** The digest lines of a `send_email` body (`[@digest]`, T514); absent = no digest. */
      readonly digest?: string;
    } = {},
  ): Promise<{
    values: string[];
    warnings: readonly TemplateWarning[];
    truncated: boolean;
  }> {
    const withDigest = options.digest !== undefined;
    const prepared = this.prepare(source, this.rootSnapshot(withDigest));
    const warnings: TemplateWarning[] = [];
    const row = await this.rootRow(
      prepared,
      warnings,
      withDigest ? { [EMAIL_BODY_DIGEST_REFERENCE]: options.digest } : {},
    );
    const budget = new Budget(this.clock, this.budgetMs);
    const values: string[] = [];
    for (const part of prepared.parts) {
      if (part.kind !== 'expression') continue;
      values[part.index] = this.placeholderText(prepared, part.index, row, budget, warnings);
    }
    if (budget.expired) warnings.push({ code: 'render_timeout' });
    return { values, warnings: dedupe(warnings), truncated: budget.expired };
  }

  /** A `digest` of a `find_records` step (SPEC §11.4). */
  async renderDigest(
    digest: { step: string; row_template: string; max_rows: number; separator: string },
    options: RenderOptions = {},
  ): Promise<RenderedText> {
    const action = this.actions.get(digest.step);
    const findTable = action?.type === 'find_records' ? action.config.table_id : undefined;
    const output = this.steps.get(digest.step);
    const records = isObject(output) && Array.isArray(output['records']) ? output['records'] : [];
    const rows: FormulaRecord[] = records
      .filter((record): record is Record<string, unknown> => isObject(record))
      .filter((record) => typeof record['id'] === 'string')
      .map((record) => {
        const id = record['id'] as string;
        const fields = isObject(record['fields']) ? { ...record['fields'] } : {};
        return { id, fields: { ...fields, ...this.recordCells(findTable, id) } };
      });
    const count =
      isObject(output) && typeof output['count'] === 'number'
        ? Math.max(output['count'], rows.length)
        : rows.length;
    const warnings: TemplateWarning[] = [];
    const context = options.context ?? 'raw';
    if (rows.length === 0 || action?.type !== 'find_records') {
      return this.finish('', context, options, null, warnings);
    }
    const tableId = action.config.table_id;
    const prepared = this.prepare(
      digest.row_template,
      this.snapshot(tableId, stepFieldsOf(this.options.context, tableId, action.config.fields)),
    );
    const shown = rows.slice(0, digest.max_rows);
    for (const row of shown) this.rememberUsers(row.fields);
    await this.loadLinked(prepared, shown, warnings);
    const budget = new Budget(this.clock, this.budgetMs);
    const lines: string[] = [];
    for (const row of shown) {
      if (budget.over()) break;
      lines.push(this.renderRow(prepared, row, context, budget, warnings));
    }
    const left = count - lines.length;
    if (left > 0) lines.push(moreRecordsLine(left, this.options.locale));
    return this.finish(lines.join(digest.separator), context, options, budget, warnings);
  }

  // --- Preparing ------------------------------------------------------------------

  private snapshot(
    tableId: string | null,
    onlyFields: ReadonlySet<string> | null,
    sources: TemplateSources | null = null,
  ): SchemaSnapshot {
    const root = sources === null ? '' : sources.digest === true ? 'root+digest:' : 'root:';
    const key = `${root}${tableId ?? ''}|${
      onlyFields === null ? '*' : [...onlyFields].sort().join(',')
    }`;
    let snapshot = this.snapshots.get(key);
    if (snapshot === undefined) {
      snapshot = automationSnapshot(this.options.context, tableId, onlyFields, sources);
      this.snapshots.set(key, snapshot);
    }
    return snapshot;
  }

  /** Snapshot of the trigger row: its fields, the trigger data and the step records. */
  private rootSnapshot(withDigest = false): SchemaSnapshot {
    const { tableId, recordId } = this.options.trigger;
    return this.snapshot(
      recordId === null ? null : tableId,
      null,
      withDigest ? { ...this.sources, digest: true } : this.sources,
    );
  }

  /** `[@id]`/`[@url]` of a record of `tableId`. */
  private recordCells(tableId: string | undefined, recordId: string): Record<string, unknown> {
    return {
      [RECORD_ID_REFERENCE]: recordId,
      [RECORD_URL_REFERENCE]:
        tableId === undefined ? null : (this.options.recordUrl?.(tableId, recordId) ?? null),
    };
  }

  /**
   * The row a template runs on: the trigger record (fields the placeholders
   * read, links followed) with the trigger data and the record of every
   * step that ran; an empty row for a trigger without record.
   */
  private async rootRow(
    prepared: Prepared,
    warnings: TemplateWarning[],
    extra: Readonly<Record<string, unknown>> = {},
  ): Promise<FormulaRecord> {
    const { tableId, recordId, data = {} } = this.options.trigger;
    const cells: Record<string, unknown> = { ...extra };
    for (const reference of this.sources.trigger) {
      const key = TRIGGER_REFERENCE_DATA[reference];
      cells[reference] = Object.hasOwn(data, key) ? data[key] : null;
    }
    for (const actionId of this.sources.steps.keys()) {
      cells[actionId] = stepRecordId(this.steps.get(actionId));
    }
    if (this.sources.previous !== undefined && recordId !== null) {
      cells[PREVIOUS_RECORD_ID] = PREVIOUS_RECORD_ID;
    }
    const webhookIds = this.webhookReferencesOf(prepared);
    if (webhookIds.length > 0) {
      const request = await this.webhookData();
      for (const id of webhookIds) cells[id] = webhookReferenceText(request, id);
    }
    let row: FormulaRecord = { id: '', fields: cells };
    if (tableId !== null && recordId !== null) {
      const [found] = await this.ensureRecords(tableId, [recordId], this.rootFields(prepared));
      row = {
        id: recordId,
        fields: { ...(found?.fields ?? {}), ...this.recordCells(tableId, recordId), ...cells },
      };
    }
    await this.loadLinked(prepared, [row], warnings);
    return row;
  }

  /**
   * Checks the template again with the access of `run_as` now: a refused
   * function stops everything (`unsupported_function`), any other problem
   * empties its placeholder with a warning.
   */
  private prepare(source: string, base: SchemaSnapshot): Prepared {
    // `[@body.<path>]`… of a `webhook.received` row (T604): declared per template.
    const snapshot = withWebhookReferences(base, source);
    const check = checkTemplate(source, snapshot, {
      form: 'stored',
      disallow: AUTOMATION_DISALLOWED_FUNCTIONS,
      allowTables: false,
      referenceIds: isTemplateReferenceId,
    });
    const refused = check.errors.find((error) => error.code === 'UNSUPPORTED_FUNCTION');
    if (refused !== undefined) {
      throw new AutomationValueError(
        'unsupported_function',
        'A template calls a function automations cannot use.',
        { function: refused.params['function'], position: refused.params.position },
      );
    }
    const placeholders = new Map(check.placeholders.map((item) => [item.index, item]));
    const broken = new Map<number, TemplateWarningCode>();
    for (const part of check.parts) {
      if (part.kind !== 'expression' || placeholders.has(part.index)) continue;
      const error = check.errors.find(
        (item) =>
          item.params.position.start >= part.start &&
          item.params.position.start < part.start + part.length,
      );
      broken.set(
        part.index,
        error !== undefined && REFERENCE_CODES.has(error.code)
          ? 'unknown_reference'
          : 'invalid_expression',
      );
    }
    return { source, snapshot, parts: check.parts, placeholders, broken };
  }

  // --- Reading --------------------------------------------------------------------

  /** Webhook references the placeholders of `prepared` read on its row (T604). */
  private webhookReferencesOf(prepared: Prepared): string[] {
    if (this.options.webhook === undefined) return [];
    const ids = new Set<string>();
    for (const placeholder of prepared.placeholders.values()) {
      for (const dependency of placeholder.dependencies) {
        if (dependency.kind === 'same_row' && isWebhookReference(dependency.field_id)) {
          ids.add(dependency.field_id);
        }
      }
    }
    return [...ids];
  }

  /** The stored request of the run, loaded once; gone → `trigger_data_expired`. */
  private async webhookData(): Promise<WebhookRequestData> {
    const webhook = this.options.webhook;
    if (webhook === undefined) return { body: null, headers: null, query: null };
    this.webhookRequest ??= webhook.load();
    const request = await this.webhookRequest;
    if (request === null) {
      throw new AutomationValueError(
        'trigger_data_expired',
        'The webhook request of this run is no longer stored.',
      );
    }
    return request;
  }

  /** Fields of the root records the placeholders read (same row + first link hops). */
  private rootFields(prepared: Prepared): string[] {
    const fields = new Set<string>();
    for (const placeholder of prepared.placeholders.values()) {
      for (const dependency of placeholder.dependencies) {
        if (dependency.kind === 'same_row') fields.add(dependency.field_id);
        else if (dependency.kind === 'via_link' && dependency.link_path[0] !== undefined) {
          fields.add(dependency.link_path[0]);
        }
      }
    }
    return [...fields].filter((field) => !isTemplateReferenceId(field));
  }

  /** Records by id with at least `fieldIds` loaded; missing ones are left out. */
  private async ensureRecords(
    tableId: Id<'tbl'>,
    recordIds: readonly string[],
    fieldIds: readonly string[],
  ): Promise<FormulaRecord[]> {
    const toLoad = new Map<string, Set<string>>();
    const readable = fieldIds.filter((field) => !isTemplateReferenceId(field));
    for (const id of new Set(recordIds)) {
      const cached = this.records.get(`${tableId}:${id}`);
      if (cached?.missing === true) continue;
      const lacking = readable.filter((field) => cached?.loaded.has(field) !== true);
      if (cached === undefined || lacking.length > 0) {
        const key = lacking.slice().sort().join(',');
        const ids = toLoad.get(key) ?? new Set<string>();
        ids.add(id);
        toLoad.set(key, ids);
      }
    }
    for (const [key, ids] of toLoad) {
      const fields = key === '' ? [] : key.split(',');
      const found = await this.options.reader.read(tableId, [...ids], fields);
      const returned = new Set<string>();
      for (const record of found) {
        returned.add(record.id);
        const cacheKey = `${tableId}:${record.id}`;
        const cached = this.records.get(cacheKey) ?? {
          id: record.id,
          fields: {},
          loaded: new Set<string>(),
          missing: false,
        };
        Object.assign(cached.fields, record.fields);
        for (const field of fields) cached.loaded.add(field);
        this.records.set(cacheKey, cached);
        this.rememberUsers(record.fields);
      }
      for (const id of ids) {
        if (returned.has(id)) continue;
        this.records.set(`${tableId}:${id}`, {
          id,
          fields: {},
          loaded: new Set(),
          missing: true,
        });
      }
    }
    return recordIds.flatMap((id) => {
      const cached = this.records.get(`${tableId}:${id}`);
      return cached === undefined || cached.missing ? [] : [{ id, fields: cached.fields }];
    });
  }

  /**
   * Follows the link paths the placeholders read (`via_link` dependencies),
   * hop by hop from `roots`, reading each table once per hop.
   */
  private async loadLinked(
    prepared: Prepared,
    roots: readonly FormulaRecord[],
    warnings: TemplateWarning[],
  ): Promise<void> {
    const needs = new Map<string, Set<string>>();
    const need = (path: readonly string[], field: string) => {
      const key = path.join('.');
      const set = needs.get(key) ?? new Set<string>();
      set.add(field);
      needs.set(key, set);
    };
    for (const placeholder of prepared.placeholders.values()) {
      for (const dependency of placeholder.dependencies) {
        if (dependency.kind !== 'via_link') continue;
        const path = dependency.link_path;
        for (let index = 1; index < path.length; index += 1) {
          need(path.slice(0, index), path[index] as string);
        }
        need(path, dependency.field_id);
      }
    }
    const linkTable = new Map<string, string>();
    for (const table of prepared.snapshot.tables) {
      for (const field of table.fields) {
        if (typeof field.linkTableId === 'string') linkTable.set(field.id, field.linkTableId);
      }
    }
    const level = new Map<string, readonly FormulaRecord[]>([['', roots]]);
    const keys = [...needs.keys()].sort((a, b) => a.split('.').length - b.split('.').length);
    for (const key of keys) {
      const path = key.split('.');
      const linkField = path.at(-1) as string;
      const parent = level.get(path.slice(0, -1).join('.')) ?? [];
      const target = linkTable.get(linkField);
      if (target === undefined) continue;
      // A step record is shown by its title (`{{ [act_1] }}`): read its primary field too.
      const primary = this.primaryFields.get(target);
      if (this.sources.steps.has(linkField) && primary !== undefined) {
        needs.get(key)?.add(primary);
      }
      const ids: string[] = [];
      const seen = new Set<string>();
      for (const record of parent) {
        const cell = record.fields[linkField];
        // A link cell is a list; a step reference is one record id.
        const items = Array.isArray(cell) ? (cell as unknown[]) : cell == null ? [] : [cell];
        for (const item of items) {
          const id = typeof item === 'string' ? item : isObject(item) ? item['id'] : undefined;
          if (typeof id !== 'string' || seen.has(id)) continue;
          seen.add(id);
          ids.push(id);
        }
      }
      if (ids.length > MAX_LINKED_RECORDS) {
        warnings.push({ code: 'linked_records_truncated' });
        ids.length = MAX_LINKED_RECORDS;
      }
      const records =
        linkField === PREVIOUS_RECORD_ID
          ? await this.previousRecords(target as Id<'tbl'>, [...(needs.get(key) ?? [])])
          : ids.length === 0
            ? []
            : await this.ensureRecords(target as Id<'tbl'>, ids, [...(needs.get(key) ?? [])]);
      level.set(key, records);
    }
  }

  /**
   * The trigger record before the change (`[@previous]`): the current
   * record with the event's `from` values (`trigger.data.previous`) over the
   * fields that changed. Cached like a record of `tableId` under the id
   * `@previous`, so `dataSource` resolves the link.
   */
  private async previousRecords(
    tableId: Id<'tbl'>,
    fieldIds: readonly string[],
  ): Promise<FormulaRecord[]> {
    const { recordId, data = {} } = this.options.trigger;
    if (recordId === null) return [];
    const [current] = await this.ensureRecords(tableId, [recordId], fieldIds);
    if (current === undefined) return [];
    const before = isObject(data['previous']) ? data['previous'] : {};
    const fields: Record<string, unknown> = { ...current.fields };
    for (const field of fieldIds) {
      // Only fields `run_as` reads now: the reader left the others out of `current`.
      if (Object.hasOwn(before, field) && Object.hasOwn(current.fields, field)) {
        fields[field] = before[field];
      }
    }
    this.records.set(`${tableId}:${PREVIOUS_RECORD_ID}`, {
      id: PREVIOUS_RECORD_ID,
      fields,
      loaded: new Set(fieldIds),
      missing: false,
    });
    return [{ id: PREVIOUS_RECORD_ID, fields }];
  }

  private rememberUsers(fields: Readonly<Record<string, unknown>>): void {
    for (const value of Object.values(fields)) {
      const items = Array.isArray(value) ? (value as unknown[]) : [value];
      for (const item of items) {
        if (
          isObject(item) &&
          typeof item['id'] === 'string' &&
          item['id'].startsWith('usr_') &&
          typeof item['name'] === 'string'
        ) {
          this.userNames.set(item['id'], item['name']);
        }
      }
    }
  }

  private dataSource(): FormulaDataSource {
    return {
      table: () => [],
      record: (tableId, recordId) => {
        const cached = this.records.get(`${tableId}:${recordId}`);
        if (cached === undefined || cached.missing) return null;
        const primary = this.primaryFields.get(tableId);
        const title = primary === undefined ? undefined : cached.fields[primary];
        return {
          id: cached.id,
          ...(typeof title === 'string' ? { title } : {}),
          fields: {
            ...cached.fields,
            // The record before the change is the trigger record: its id and link.
            ...this.recordCells(
              tableId,
              cached.id === PREVIOUS_RECORD_ID
                ? (this.options.trigger.recordId ?? cached.id)
                : cached.id,
            ),
          },
        };
      },
    };
  }

  // --- Rendering ------------------------------------------------------------------

  private renderRow(
    prepared: Prepared,
    row: FormulaRecord,
    context: AutomationTextContext,
    budget: Budget,
    warnings: TemplateWarning[],
    digestRendered = false,
  ): string {
    let text = '';
    for (const part of prepared.parts) {
      if (part.kind === 'text') {
        text += part.text;
        continue;
      }
      const value = this.placeholderText(prepared, part.index, row, budget, warnings);
      if (digestRendered && isDigestPlaceholder(prepared.placeholders.get(part.index))) {
        text += value;
        continue;
      }
      text += escapeValue(value, context, context === 'telegram_html' && endsInsideTag(text));
    }
    return text;
  }

  private placeholderText(
    prepared: Prepared,
    index: number,
    row: FormulaRecord,
    budget: Budget,
    warnings: TemplateWarning[],
  ): string {
    const brokenAs = prepared.broken.get(index);
    if (brokenAs !== undefined) {
      warnings.push({ code: brokenAs, placeholder: index });
      return '';
    }
    const placeholder = prepared.placeholders.get(index);
    if (placeholder === undefined || budget.over()) return '';
    try {
      const value = evaluate(placeholder.ast, {
        snapshot: prepared.snapshot,
        row,
        resolve: this.dataSource(),
        tz: this.options.timeZone,
        now: this.options.now,
        types: placeholder.types,
        disallow: new Set(AUTOMATION_DISALLOWED_FUNCTIONS),
        interrupt: budget.over,
      });
      return formatTemplateValue(value, placeholder.type, placeholder.style, {
        locale: this.options.locale,
        timeZone: this.options.timeZone,
        userName: (id) => this.userNames.get(id) ?? null,
      });
    } catch (error) {
      if (error instanceof EvaluationInterrupted) return '';
      if (error instanceof FormulaError && error.detail === 'UNSUPPORTED_FUNCTION') {
        throw new AutomationValueError(
          'unsupported_function',
          'A template calls a function automations cannot use.',
          { function: error.params['function'] },
        );
      }
      throw error;
    }
  }

  private finish(
    text: string,
    context: AutomationTextContext,
    options: RenderOptions,
    budget: Budget | null,
    warnings: TemplateWarning[],
  ): RenderedText {
    const timedOut = budget?.expired === true;
    if (timedOut) warnings.push({ code: 'render_timeout' });
    const finished = finishText(text, context);
    const cut =
      options.maxLength === undefined
        ? { text: finished, truncated: false }
        : truncateText(finished, options.maxLength);
    return { text: cut.text, warnings: dedupe(warnings), truncated: timedOut || cut.truncated };
  }

  // --- Plain values ---------------------------------------------------------------

  private async fieldValue(fieldId: string): Promise<ResolvedValue> {
    const { tableId, recordId } = this.options.trigger;
    const readable = (table: string): boolean =>
      this.snapshot(table, null)
        .tables.find((item) => item.id === table)
        ?.fields.some((field) => field.id === fieldId) === true;
    if (tableId === null || recordId === null || !readable(tableId)) {
      return {
        value: null,
        warnings: [{ code: 'field_unavailable', field_id: fieldId }],
        truncated: false,
      };
    }
    const [record] = await this.ensureRecords(tableId, [recordId], [fieldId]);
    return { value: record?.fields[fieldId] ?? null, warnings: [], truncated: false };
  }

  private pathValue(value: unknown, path: string | undefined): unknown {
    if (path === undefined) return value ?? null;
    const segments = parseValuePath(path);
    return segments === null ? null : readValuePath(value, segments);
  }
}

const WEBHOOK_PARTS: ReadonlySet<string> = new Set(WEBHOOK_TRIGGER_PARTS);

function isWebhookPart(part: string): part is (typeof WEBHOOK_TRIGGER_PARTS)[number] {
  return WEBHOOK_PARTS.has(part);
}

/** `{{ [@digest] }}` alone: the lines placed as rendered (T516). */
function isDigestPlaceholder(placeholder: CheckedPlaceholder | undefined): boolean {
  return placeholder?.stored.trim() === `[${EMAIL_BODY_DIGEST_REFERENCE}]`;
}

function dedupe(warnings: readonly TemplateWarning[]): TemplateWarning[] {
  const seen = new Set<string>();
  return warnings.filter((warning) => {
    const key = `${warning.code}|${String(warning.placeholder ?? '')}|${warning.field_id ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Every refused function call in the templates of a definition, checked
 * before a run starts (S4b-followup §1.4: definitions written before the
 * rule, imported or put in the database directly): the path of the value
 * and the function. Only parses — no schema needed.
 */
export function refusedFunctionsIn(
  definition: AutomationDefinition,
): { path: string; function: string }[] {
  const out: { path: string; function: string }[] = [];
  const empty: SchemaSnapshot = { tableId: '', tables: [] };
  const visit = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => {
        visit(item, `${path}[${String(index)}]`);
      });
      return;
    }
    if (!isObject(node)) return;
    const template =
      typeof node['template'] === 'string'
        ? { source: node['template'], at: `${path}.template` }
        : isObject(node['digest']) && typeof node['digest']['row_template'] === 'string'
          ? { source: node['digest']['row_template'], at: `${path}.digest.row_template` }
          : null;
    if (template !== null) {
      const check = checkTemplate(template.source, empty, {
        form: 'stored',
        disallow: AUTOMATION_DISALLOWED_FUNCTIONS,
        referenceIds: isTemplateReferenceId,
      });
      for (const error of check.errors) {
        if (error.code === 'UNSUPPORTED_FUNCTION') {
          out.push({ path: template.at, function: String(error.params['function']) });
        }
      }
    }
    for (const [key, value] of Object.entries(node)) visit(value, `${path}.${key}`);
  };
  visit(definition.actions, 'definition.actions');
  return out;
}
