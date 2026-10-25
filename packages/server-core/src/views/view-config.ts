import {
  INVALID_FIELD_TYPE,
  REQUIRES_LOGIN,
  SUBMISSION_LIMITS,
  summaryFunctionsOf,
  VIEW_CONFIG_INPUT_SCHEMAS,
  type FormConfigInput,
  type GridConfigInput,
  type KanbanConfigInput,
  type ProblemErrorItem,
  type StoredFormField,
  type StoredFormSettings,
  type StoredKanbanSettings,
  type StoredRecordDetailSettings,
  type StoredViewConfig,
  type StoredViewSort,
  type SummaryFunction,
  type ViewConfigInput,
  type ViewType,
} from '@cellhive/contracts';
import { getFieldType, type FieldType } from '@cellhive/field-types';
import {
  MAX_FILTER_CONDITIONS,
  parseFilterInput,
  type FilterFieldMeta,
} from '@cellhive/filter-dsl';

import { publicResultType } from '../computed/definition/definition.js';
import { formulaTypeOf } from '../computed/definition/schema-rows.js';
import { AppError } from '../errors/app-error.js';
import { zodIssuesToProblemErrors } from '../errors/zod-issues.js';
import {
  buildColorRules,
  colorRuleFieldIds,
  restrictColorRules,
  storedColorRulesOf,
} from '../records/color-rules/config.js';
import {
  computedFilterResultOf,
  isComputedSortable,
} from '../records/computed/read/computed-fields.js';

import type { JsonObject, JsonValue } from '../db/schema.js';

/** What view configs need to know about one active field of the table. */
export interface ViewFieldMeta {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly options: unknown;
  readonly required: boolean;
  /**
   * `meta.fields.result_type` of a formula/lookup field (T457): filters and
   * sorts on it follow its result type.
   */
  readonly result_type?: unknown;
}

/** The linked table of a link field of the view's table (T402, `record_detail`). */
export interface ViewLinkTarget {
  /** Active fields of the linked table (trash excluded). */
  readonly fields: readonly Pick<ViewFieldMeta, 'id'>[];
  /** Fields of the linked table the person may read (none when the table is unreadable). */
  readonly readable: ReadonlySet<string>;
}

export interface ViewConfigContext {
  /** Active fields of the table (trash excluded), in display order. */
  readonly fields: readonly ViewFieldMeta[];
  /** Fields the person saving (or reading) the view may read. */
  readonly readable: ReadonlySet<string>;
  /**
   * Linked tables of the table's active link fields, by link field id
   * (T402): the columns of `record_detail.link_columns`. Absent (or a link
   * missing from it: linked table in the trash) = no column is visible.
   */
  readonly linkTargets?: ReadonlyMap<string, ViewLinkTarget>;
  /**
   * Formula/lookup fields locked for the person (T457, S4b open question
   * #1a): readable, but filters, sorts and groups on them answer like on a
   * hidden field.
   */
  readonly locked?: ReadonlySet<string>;
}

/**
 * Types whose values the system computes (SPEC §14.1): never on a form.
 * Kept in step with `COMPUTED_FIELD_TYPES` of `@cellhive/permissions`.
 */
const NOT_WRITABLE_TYPES: ReadonlySet<string> = new Set([
  // Link and attachment questions are asked since T410 (pickers, form uploads).
  // Sub-records are arranged in the grid, not on forms (T405).
  'parent',
  'formula',
  'lookup',
  // A button holds no value (T517): it is clicked in the grid, never asked.
  'button',
  'auto_number',
  'created_at',
  'updated_at',
  'created_by',
  'updated_by',
]);

/** Keys holding lists of field ids, whose entries unseen by the saver survive a `PATCH`. */
const FIELD_LIST_KEYS = ['hidden_fields', 'field_order'] as const;

const EMPTY_TREE = { enabled: false, show_ancestors: true };

function defaultRecordDetail(): StoredRecordDetailSettings {
  return { link_columns: {} };
}

function defaultKanban(): StoredKanbanSettings {
  return { group_field: null, card_fields: [], cover_field: null, hide_empty_columns: false };
}

function isWritable(field: ViewFieldMeta): boolean {
  return !NOT_WRITABLE_TYPES.has(field.type);
}

function defaultForm(context: ViewConfigContext | undefined): StoredFormSettings {
  const fields: StoredFormField[] =
    context === undefined
      ? []
      : context.fields
          .filter((field) => isWritable(field) && context.readable.has(field.id))
          .map((field) => ({ field: field.id, required: field.required, label: null, help: null }));
  return {
    title: '',
    description: '',
    cover_attachment_id: null,
    fields,
    success_message: '',
    redirect_url: null,
    allow_multiple_submissions: true,
    require_login: false,
    submission_limit: 'none',
  };
}

/**
 * Form settings of a stored row completed with the defaults. Rows saved
 * before T306 have no `submission_limit`: `allow_multiple_submissions =
 * false` then reads as `once`.
 */
function storedFormOf(stored: Partial<StoredFormSettings> | undefined): StoredFormSettings {
  const form: StoredFormSettings = { ...defaultForm(undefined), ...(stored ?? {}) };
  const limit = stored?.submission_limit;
  if (limit === undefined || !(SUBMISSION_LIMITS as readonly string[]).includes(limit)) {
    form.submission_limit = form.allow_multiple_submissions ? 'none' : 'once';
  }
  form.allow_multiple_submissions = form.submission_limit === 'none';
  return form;
}

/**
 * The config a new view of `type` starts from. A form lists every writable
 * field the creator can read, in display order, required as in the table.
 */
export function defaultViewConfig(type: ViewType, context?: ViewConfigContext): StoredViewConfig {
  const config: StoredViewConfig = {
    filter: null,
    sort: [],
    group: [],
    hidden_fields: [],
    field_order: [],
    column_widths: {},
    frozen_count: 1,
    row_height: 'short',
    tree: { ...EMPTY_TREE },
    record_detail: defaultRecordDetail(),
  };
  // The summary bar (T472) and color rules (T816) are a grid's.
  if (type === 'grid') {
    config.summaries = {};
    config.color_rules = [];
  }
  if (type === 'kanban') config.kanban = defaultKanban();
  if (type === 'form') config.form = defaultForm(context);
  return config;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A stored config (`meta.views.config`) with every key of its type present:
 * keys missing from older rows take their defaults.
 */
export function storedViewConfigOf(type: ViewType, json: JsonValue): StoredViewConfig {
  const stored = isObject(json) ? (json as Partial<StoredViewConfig>) : {};
  const defaults = defaultViewConfig(type);
  const config: StoredViewConfig = { ...defaults, ...stored };
  // Rows saved before T402 have no `record_detail`.
  config.record_detail = { ...defaultRecordDetail(), ...(stored.record_detail ?? {}) };
  // Rows saved before T472 have no `summaries`; only grids keep them.
  if (type === 'grid') config.summaries = { ...(stored.summaries ?? {}) };
  else delete config.summaries;
  // Rows saved before T816 have no `color_rules`; only grids keep them.
  if (type === 'grid') config.color_rules = storedColorRulesOf(stored.color_rules);
  else delete config.color_rules;
  delete config.kanban;
  delete config.form;
  if (type === 'kanban') config.kanban = { ...defaultKanban(), ...(stored.kanban ?? {}) };
  if (type === 'form') config.form = storedFormOf(stored.form);
  return config;
}

export function configJson(config: StoredViewConfig): JsonObject {
  return config as unknown as JsonObject;
}

// ---------------------------------------------------------------------------
// Reading: what a reader may see

type FilterJson = Record<string, unknown>;

/**
 * `node` without the conditions whose field `keep` rejects; groups left
 * empty and `not` nodes left without an item disappear. `null` when nothing
 * is left.
 */
export function pruneFilter(node: unknown, keep: (fieldId: string) => boolean): FilterJson | null {
  if (!isObject(node)) return null;
  if (node.op === 'and' || node.op === 'or') {
    const items = Array.isArray(node.items) ? node.items : [];
    const kept = items
      .map((item) => pruneFilter(item, keep))
      .filter((item): item is FilterJson => item !== null);
    if (kept.length === 0 && items.length > 0) return null;
    return { ...node, items: kept };
  }
  if (node.op === 'not') {
    const item = pruneFilter(node.item, keep);
    return item === null ? null : { ...node, item };
  }
  return typeof node.field === 'string' && keep(node.field) ? node : null;
}

/** Field ids named by the conditions of a filter. */
export function filterFieldIds(node: unknown, into: Set<string> = new Set()): Set<string> {
  if (!isObject(node)) return into;
  if (Array.isArray(node.items)) for (const item of node.items) filterFieldIds(item, into);
  if (node.item !== undefined) filterFieldIds(node.item, into);
  if (typeof node.field === 'string') into.add(node.field);
  return into;
}

// ---------------------------------------------------------------------------
// Saved filters and fields the reader cannot read (BACKLOG S3 decision 3, T311)
//
// A saved filter S splits, for one reader, into the part shown to them
// (`visibleFilterOf`) and the part that stays hidden (`hiddenFilterOf`),
// with S ≡ visible AND hidden (conditions on deleted fields aside: they are
// ignored when querying and dropped when the key is saved again). A hidden
// condition is one on an active field the reader cannot read. Inside an
// `and` group the two parts separate condition by condition; an `or` or
// `not` node holding a hidden condition cannot be split, so it is hidden
// whole. What the reader edits is the visible part only: a temporary
// filter replaces it (`filter_mode: replace`) and a saved one is merged
// back with the hidden part (`mergeHiddenFilter`), so hidden conditions are
// never dropped by someone who cannot see them.

/** Number of conditions of a filter. */
function filterFieldCount(node: unknown): number {
  if (!isObject(node)) return 0;
  if (Array.isArray(node.items)) {
    return node.items.reduce<number>((sum, item) => sum + filterFieldCount(item), 0);
  }
  if (node.item !== undefined) return filterFieldCount(node.item);
  return typeof node.field === 'string' ? 1 : 0;
}

/** Whether a filter names a field for which `hidden` is true. */
function namesHidden(node: unknown, hidden: (fieldId: string) => boolean): boolean {
  for (const id of filterFieldIds(node)) if (hidden(id)) return true;
  return false;
}

/**
 * The part of a saved filter shown to a reader: conditions on `visible`
 * fields, without `or`/`not` nodes that hold a `hidden` condition. Groups
 * left empty disappear (`null` when nothing is left).
 */
export function visibleFilterOf(
  node: unknown,
  visible: (fieldId: string) => boolean,
  hidden: (fieldId: string) => boolean,
): FilterJson | null {
  if (!isObject(node)) return null;
  if ((node.op === 'or' || node.op === 'not') && namesHidden(node, hidden)) return null;
  if (node.op === 'and' || node.op === 'or') {
    const items = Array.isArray(node.items) ? node.items : [];
    const kept = items
      .map((item) => visibleFilterOf(item, visible, hidden))
      .filter((item): item is FilterJson => item !== null);
    if (kept.length === 0 && items.length > 0) return null;
    return { ...node, items: kept };
  }
  if (node.op === 'not') {
    const item = visibleFilterOf(node.item, visible, hidden);
    return item === null ? null : { ...node, item };
  }
  return typeof node.field === 'string' && visible(node.field) ? node : null;
}

/**
 * The part of a saved filter hidden from a reader: conditions on `hidden`
 * fields, and whole `or`/`not` nodes that hold one. `null` when the reader
 * sees the whole filter.
 */
export function hiddenFilterOf(
  node: unknown,
  hidden: (fieldId: string) => boolean,
): FilterJson | null {
  if (!isObject(node)) return null;
  if (node.op === 'and') {
    const items = Array.isArray(node.items) ? node.items : [];
    const kept = items
      .map((item) => hiddenFilterOf(item, hidden))
      .filter((item): item is FilterJson => item !== null);
    return kept.length === 0 ? null : { op: 'and', items: kept };
  }
  return namesHidden(node, hidden) ? node : null;
}

/**
 * `sent AND hidden`, flattened into one top-level `and` group: the filter
 * stored when someone saves a view filter while conditions of it are hidden
 * from them. `sent` alone when nothing is hidden.
 */
export function mergeHiddenFilter(
  sent: FilterJson | null,
  hidden: FilterJson | null,
): FilterJson | null {
  if (hidden === null) return sent;
  if (sent === null) return hidden;
  const itemsOf = (node: FilterJson): unknown[] =>
    node.op === 'and' && Array.isArray(node.items) ? node.items : [node];
  return { op: 'and', items: [...itemsOf(sent), ...itemsOf(hidden)] };
}

/**
 * The summary functions a field accepts (T472, CONTRACTS §15): by type, and
 * for formula/lookup fields by their result type.
 */
export function summaryFunctionsOfField(field: ViewFieldMeta): readonly SummaryFunction[] {
  if (field.type !== 'formula' && field.type !== 'lookup') return summaryFunctionsOf(field.type);
  const type = formulaTypeOf(field.result_type);
  return summaryFunctionsOf(
    field.type,
    type === null || type.kind === 'any' ? null : publicResultType(type),
  );
}

/**
 * `summaries` for a reader: entries on fields they read (active), with a
 * function the field still takes (a type change may have made it invalid:
 * the entry is left out, never an error). Without `fields` only the
 * readability is checked.
 */
function restrictSummaries(
  summaries: Readonly<Record<string, SummaryFunction>>,
  keep: (fieldId: string) => boolean,
  fields: readonly ViewFieldMeta[] | undefined,
): Record<string, SummaryFunction> {
  const byId = fields === undefined ? null : new Map(fields.map((field) => [field.id, field]));
  const out: Record<string, SummaryFunction> = {};
  for (const [id, fn] of Object.entries(summaries)) {
    if (!keep(id)) continue;
    const field = byId?.get(id);
    if (byId !== null && (field === undefined || !summaryFunctionsOfField(field).includes(fn))) {
      continue;
    }
    out[id] = fn;
  }
  return out;
}

/**
 * `config` restricted to the fields in `visible` (BACKLOG S3 decision 3):
 * filter conditions, sort and group items on other fields are left out
 * entirely, and so are their entries in lists and widths; kanban
 * `group_field` / `cover_field` on them become `null`. Used for responses
 * (visible = active fields the reader can read), and when copying a view
 * to a new owner. With `active` (the table's active field ids), an
 * `or`/`not` node holding a condition on an active field outside `visible`
 * is left out whole ({@link visibleFilterOf}); without it, every field
 * outside `visible` counts as hidden. With `fields` (the table's active
 * fields), `summaries` entries whose function the field no longer takes are
 * left out too (T472).
 */
export function restrictViewConfig(
  config: StoredViewConfig,
  visible: ReadonlySet<string>,
  active?: ReadonlySet<string>,
  linkTargets?: ReadonlyMap<string, ViewLinkTarget>,
  fields?: readonly ViewFieldMeta[],
): StoredViewConfig {
  const keep = (id: string) => visible.has(id);
  const hidden = (id: string) => !visible.has(id) && (active === undefined || active.has(id));
  const sorts = (items: readonly StoredViewSort[]) => items.filter((item) => keep(item.field));
  const result: StoredViewConfig = {
    ...config,
    filter: config.filter === null ? null : visibleFilterOf(config.filter, keep, hidden),
    sort: sorts(config.sort),
    group: sorts(config.group),
    hidden_fields: config.hidden_fields.filter(keep),
    field_order: config.field_order.filter(keep),
    column_widths: Object.fromEntries(
      Object.entries(config.column_widths).filter(([id]) => keep(id)),
    ),
    record_detail: restrictRecordDetail(config.record_detail, keep, linkTargets),
  };
  if (config.summaries !== undefined) {
    result.summaries = restrictSummaries(config.summaries, keep, fields);
  }
  if (config.color_rules !== undefined) {
    result.color_rules = restrictColorRules(config.color_rules, visible, active);
  }
  if (config.kanban !== undefined) {
    const kanban = config.kanban;
    result.kanban = {
      group_field:
        kanban.group_field !== null && keep(kanban.group_field) ? kanban.group_field : null,
      card_fields: kanban.card_fields.filter(keep),
      cover_field:
        kanban.cover_field !== null && keep(kanban.cover_field) ? kanban.cover_field : null,
      hide_empty_columns: kanban.hide_empty_columns,
    };
  }
  if (config.form !== undefined) {
    result.form = { ...config.form, fields: config.form.fields.filter((item) => keep(item.field)) };
  }
  return result;
}

/** Active fields of a linked table the person reads. */
function linkTargetVisible(target: ViewLinkTarget | undefined): Set<string> {
  if (target === undefined) return new Set();
  return new Set(
    target.fields.filter((field) => target.readable.has(field.id)).map((field) => field.id),
  );
}

/**
 * `record_detail` for a reader (T402): entries of link fields the reader
 * reads, with the columns of the linked table they read; entries left empty
 * are dropped. Without `linkTargets` no column is known to be visible.
 */
function restrictRecordDetail(
  settings: StoredRecordDetailSettings | undefined,
  keep: (fieldId: string) => boolean,
  linkTargets: ReadonlyMap<string, ViewLinkTarget> | undefined,
): StoredRecordDetailSettings {
  const linkColumns: Record<string, string[]> = {};
  for (const [linkId, columns] of Object.entries(settings?.link_columns ?? {})) {
    if (!keep(linkId)) continue;
    const visible = linkTargetVisible(linkTargets?.get(linkId));
    const shown = columns.filter((id) => visible.has(id));
    if (shown.length > 0) linkColumns[linkId] = shown;
  }
  return { link_columns: linkColumns };
}

/** Ids of the active fields of `context` that are readable. */
export function visibleFieldIds(context: ViewConfigContext): Set<string> {
  return new Set(
    context.fields.filter((field) => context.readable.has(field.id)).map((field) => field.id),
  );
}

/** Ids of the active fields of `context`. */
export function activeFieldIds(context: ViewConfigContext): Set<string> {
  return new Set(context.fields.map((field) => field.id));
}

/** Whether `fieldId` is an active field of `context` its reader cannot read. */
function hiddenIn(context: ViewConfigContext): (fieldId: string) => boolean {
  const active = activeFieldIds(context);
  // A locked computed field (T457) filters like a hidden one.
  return (id) => active.has(id) && (!context.readable.has(id) || context.locked?.has(id) === true);
}

// ---------------------------------------------------------------------------
// Writing: validating a config sent by a client

type ErrorCode = 'VALIDATION_FAILED' | 'INVALID_FILTER' | 'INVALID_SORT';

class Issues {
  private readonly byCode = new Map<ErrorCode, ProblemErrorItem[]>();

  add(code: ErrorCode, item: ProblemErrorItem): void {
    const list = this.byCode.get(code) ?? [];
    list.push(item);
    this.byCode.set(code, list);
  }

  /** Throws the first error class that has issues (request shape, then filter, then sort). */
  throwIfAny(): void {
    for (const code of ['VALIDATION_FAILED', 'INVALID_FILTER', 'INVALID_SORT'] as const) {
      const errors = this.byCode.get(code);
      if (errors !== undefined) {
        throw new AppError(code, { detail: 'The view config is invalid.', errors });
      }
    }
  }
}

function unknownField(path: string): ProblemErrorItem {
  return { path, code: 'UNKNOWN_FIELD', message: 'The field does not exist in the table' };
}

function duplicateField(path: string): ProblemErrorItem {
  return { path, code: 'DUPLICATE_FIELD', message: 'The field is listed more than once' };
}

function joinPath(prefix: string, path: string): string {
  if (path === '') return prefix;
  return path.startsWith('[') ? `${prefix}${path}` : `${prefix}.${path}`;
}

function isSingleValue(field: ViewFieldMeta): boolean {
  const definition = getFieldType(field.type as FieldType);
  if (definition === undefined) return false;
  const parsed = definition.optionsSchema.safeParse(field.options ?? {});
  if (!parsed.success) return false;
  const multiple = (parsed.data as { multiple?: unknown }).multiple;
  return multiple !== true;
}

interface Checker {
  readonly visible: ReadonlyMap<string, ViewFieldMeta>;
  readonly issues: Issues;
}

/** Validates a list of field ids; returns it without the invalid entries. */
function checkFieldList(checker: Checker, ids: readonly string[], path: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  ids.forEach((id, index) => {
    const itemPath = `${path}[${String(index)}]`;
    if (!checker.visible.has(id)) {
      checker.issues.add('VALIDATION_FAILED', unknownField(itemPath));
    } else if (seen.has(id)) {
      checker.issues.add('VALIDATION_FAILED', duplicateField(itemPath));
    } else {
      seen.add(id);
      result.push(id);
    }
  });
  return result;
}

/** `next` plus the entries of `previous` the saver cannot see (unreadable or deleted fields). */
function keepUnseen(
  checker: Checker,
  next: readonly string[],
  previous: readonly string[],
): string[] {
  return [...next, ...previous.filter((id) => !checker.visible.has(id) && !next.includes(id))];
}

/** Field types a view cannot sort or group on (cells hold records or files: T401, T405, T406). */
const UNSORTABLE_TYPES: ReadonlySet<string> = new Set(['link', 'attachment', 'parent', 'button']);

function checkSorts(
  checker: Checker,
  items: readonly StoredViewSort[],
  path: string,
): StoredViewSort[] {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    const fieldPath = `${path}[${String(index)}].field`;
    const field = checker.visible.get(item.field);
    if (field === undefined) {
      checker.issues.add('INVALID_SORT', unknownField(fieldPath));
    } else if (
      UNSORTABLE_TYPES.has(field.type) ||
      ((field.type === 'formula' || field.type === 'lookup') &&
        !isComputedSortable(field.result_type))
    ) {
      checker.issues.add('INVALID_SORT', {
        path: fieldPath,
        code: 'FIELD_NOT_SORTABLE',
        message: 'This field cannot be sorted or grouped',
      });
    } else if (seen.has(item.field)) {
      checker.issues.add('INVALID_SORT', duplicateField(fieldPath));
    }
    seen.add(item.field);
  });
  return items.map((item) => ({ field: item.field, direction: item.direction }));
}

function checkFieldOfType(
  checker: Checker,
  id: string | null,
  path: string,
  accepts: (field: ViewFieldMeta) => boolean,
  expected: string,
): void {
  if (id === null) return;
  const field = checker.visible.get(id);
  if (field === undefined) {
    checker.issues.add('VALIDATION_FAILED', unknownField(path));
  } else if (!accepts(field)) {
    checker.issues.add('VALIDATION_FAILED', {
      path,
      code: INVALID_FIELD_TYPE,
      message: `Expected ${expected}`,
      params: { expected, type: field.type },
    });
  }
}

function checkForm(
  checker: Checker,
  context: ViewConfigContext,
  items: readonly StoredFormField[],
): StoredFormField[] {
  const path = 'config.form.fields';
  const seen = new Set<string>();
  const result: StoredFormField[] = [];
  items.forEach((item, index) => {
    const itemPath = `${path}[${String(index)}].field`;
    const field = checker.visible.get(item.field);
    if (field === undefined) {
      checker.issues.add('VALIDATION_FAILED', unknownField(itemPath));
    } else if (!isWritable(field)) {
      checker.issues.add('VALIDATION_FAILED', {
        path: itemPath,
        code: 'FIELD_READ_ONLY',
        message: 'Computed fields cannot be filled in by a form',
      });
    } else if (seen.has(item.field)) {
      checker.issues.add('VALIDATION_FAILED', duplicateField(itemPath));
    } else {
      seen.add(item.field);
      result.push({ ...item, required: item.required || field.required });
    }
  });
  for (const field of context.fields) {
    if (!field.required || seen.has(field.id)) continue;
    const readable = checker.visible.has(field.id);
    checker.issues.add('VALIDATION_FAILED', {
      path,
      code: 'REQUIRED_FIELD_MISSING',
      message: 'Every required field of the table must be on the form',
      // Never name a field the saver cannot read.
      ...(readable ? { params: { field_id: field.id, field_name: field.name } } : {}),
    });
  }
  return result;
}

/**
 * `record_detail.link_columns` sent by a saver (T402): each key a link field
 * of the table they read (`UNKNOWN_FIELD`, else `INVALID_FIELD_TYPE`), each
 * column an active field of its linked table they read (`UNKNOWN_FIELD`,
 * `DUPLICATE_FIELD`). Like `hidden_fields`, what the saver cannot see
 * survives: stored entries of link fields they cannot read (or deleted
 * ones), and stored columns they cannot read (or deleted) after the sent
 * ones. An entry left empty is removed (default columns).
 */
function checkRecordDetail(
  checker: Checker,
  context: ViewConfigContext,
  input: Readonly<Record<string, readonly string[]>>,
  previous: StoredRecordDetailSettings | undefined,
): StoredRecordDetailSettings {
  const path = 'config.record_detail.link_columns';
  const stored = previous?.link_columns ?? {};
  const linkColumns: Record<string, string[]> = {};
  for (const [linkId, columns] of Object.entries(stored)) {
    if (!checker.visible.has(linkId)) linkColumns[linkId] = [...columns];
  }
  for (const [linkId, columns] of Object.entries(input)) {
    const entryPath = `${path}.${linkId}`;
    const field = checker.visible.get(linkId);
    if (field === undefined) {
      checker.issues.add('VALIDATION_FAILED', unknownField(entryPath));
      continue;
    }
    if (field.type !== 'link') {
      checker.issues.add('VALIDATION_FAILED', {
        path: entryPath,
        code: INVALID_FIELD_TYPE,
        message: 'Expected a link field',
        params: { expected: 'a link field', type: field.type },
      });
      continue;
    }
    const visible = linkTargetVisible(context.linkTargets?.get(linkId));
    const seen = new Set<string>();
    const next: string[] = [];
    columns.forEach((id, index) => {
      const itemPath = `${entryPath}[${String(index)}]`;
      if (!visible.has(id)) {
        checker.issues.add('VALIDATION_FAILED', unknownField(itemPath));
      } else if (seen.has(id)) {
        checker.issues.add('VALIDATION_FAILED', duplicateField(itemPath));
      } else {
        seen.add(id);
        next.push(id);
      }
    });
    const unseen = (stored[linkId] ?? []).filter((id) => !visible.has(id) && !seen.has(id));
    const merged = [...next, ...unseen];
    if (merged.length > 0) linkColumns[linkId] = merged;
  }
  return { link_columns: linkColumns };
}

/**
 * Keeps `allow_multiple_submissions` and `submission_limit` in step on
 * `form` (the merged settings) and checks that a limit comes with
 * `require_login` (BACKLOG S3 decision 9). Only checked when the request
 * touches one of these keys, so older forms keep saving.
 */
function checkSubmissionSettings(
  checker: Checker,
  input: NonNullable<FormConfigInput['form']>,
  previous: StoredFormSettings,
  form: StoredFormSettings,
): void {
  const path = 'config.form';
  if (input.submission_limit !== undefined) {
    if (
      input.allow_multiple_submissions !== undefined &&
      input.allow_multiple_submissions !== (input.submission_limit === 'none')
    ) {
      checker.issues.add('VALIDATION_FAILED', {
        path: `${path}.allow_multiple_submissions`,
        code: 'NOT_ALLOWED',
        message: 'Contradicts submission_limit',
      });
    }
  } else if (input.allow_multiple_submissions !== undefined) {
    form.submission_limit = input.allow_multiple_submissions
      ? 'none'
      : previous.submission_limit === 'none'
        ? 'once'
        : previous.submission_limit;
  }
  form.allow_multiple_submissions = form.submission_limit === 'none';
  const touched =
    input.submission_limit !== undefined ||
    input.allow_multiple_submissions !== undefined ||
    input.require_login !== undefined;
  if (touched && form.submission_limit !== 'none' && !form.require_login) {
    checker.issues.add('VALIDATION_FAILED', {
      path: `${path}.submission_limit`,
      code: REQUIRES_LOGIN,
      message: 'A submission limit needs require_login',
    });
  }
}

/**
 * `summaries` sent by a saver (T472): each key a field of the table they read
 * (`UNKNOWN_FIELD`) with a function its type takes (`INVALID_FIELD_TYPE`,
 * CONTRACTS §15). Like `column_widths`, stored entries on fields the saver
 * cannot see (unreadable, deleted) survive.
 */
function checkSummaries(
  checker: Checker,
  input: Readonly<Record<string, SummaryFunction>>,
  previous: Readonly<Record<string, SummaryFunction>>,
): Record<string, SummaryFunction> {
  const out: Record<string, SummaryFunction> = {};
  for (const [id, fn] of Object.entries(previous)) {
    if (!checker.visible.has(id)) out[id] = fn;
  }
  for (const [id, fn] of Object.entries(input)) {
    const path = `config.summaries.${id}`;
    const field = checker.visible.get(id);
    if (field === undefined) {
      checker.issues.add('VALIDATION_FAILED', unknownField(path));
    } else if (!summaryFunctionsOfField(field).includes(fn)) {
      checker.issues.add('VALIDATION_FAILED', {
        path,
        code: INVALID_FIELD_TYPE,
        message: `The field type does not take the summary ${fn}`,
        params: { expected: summaryFunctionsOfField(field).join(', '), type: field.type },
      });
    } else {
      out[id] = fn;
    }
  }
  return out;
}

function parseInput(type: ViewType, input: unknown): ViewConfigInput {
  const parsed = VIEW_CONFIG_INPUT_SCHEMAS[type].safeParse(input ?? {});
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', {
      detail: 'The view config does not match its type.',
      errors: zodIssuesToProblemErrors(parsed.error.issues).map((item) => ({
        ...item,
        path: joinPath('config', item.path),
      })),
    });
  }
  return parsed.data;
}

function filterMetaOf(field: ViewFieldMeta): FilterFieldMeta {
  return {
    id: field.id,
    name: field.name,
    type: field.type as FieldType,
    options: field.options,
    ...(field.type === 'formula' || field.type === 'lookup'
      ? computedFilterResultOf(field.result_type)
      : {}),
  };
}

/**
 * Validates `input` (a `ViewConfigInput` of `type`) against the table and
 * the saver's field permissions, and returns the complete config to store:
 *
 * - keys left out keep their `stored` value (defaults for a new view);
 *   `kanban` and `form` merge one level deeper;
 * - every field named must be an active field of the table that the saver
 *   can read; a filter validates like a request filter (`INVALID_FILTER`,
 *   tuple form accepted, stored as DSL), sort/group items answer
 *   `INVALID_SORT`, everything else `VALIDATION_FAILED` / `UNKNOWN_FIELD`
 *   (a hidden field and a missing one are the same error);
 * - `hidden_fields`, `field_order`, `column_widths` and kanban
 *   `card_fields` keep the stored entries the saver cannot see (fields they
 *   cannot read, deleted fields); `filter`, `sort` and `group` are replaced
 *   as sent;
 * - kanban `group_field` is a single select or single user field,
 *   `cover_field` an attachment field (`INVALID_FIELD_TYPE`);
 * - a form lists writable fields only (`FIELD_READ_ONLY` for computed
 *   ones) and every required field of the table (`REQUIRED_FIELD_MISSING`);
 *   a field required by the table is required on the form.
 */
export function buildViewConfig(
  type: ViewType,
  input: unknown,
  context: ViewConfigContext,
  stored: StoredViewConfig | null,
): StoredViewConfig {
  const parsed = parseInput(type, input);
  const base = stored ?? defaultViewConfig(type, context);
  const checker: Checker = {
    visible: new Map(
      context.fields
        .filter((field) => context.readable.has(field.id))
        .map((field) => [field.id, field]),
    ),
    issues: new Issues(),
  };
  // Filters, sorts and groups: readable fields that are not locked (T457).
  const ordering: Checker = {
    visible: new Map([...checker.visible].filter(([id]) => context.locked?.has(id) !== true)),
    issues: checker.issues,
  };
  const config: StoredViewConfig = { ...base };

  if (parsed.filter !== undefined) {
    // Saved conditions the saver cannot read stay (BACKLOG S3 decision 3, T311).
    const hidden = stored === null ? null : hiddenFilterOf(stored.filter, hiddenIn(context));
    if (parsed.filter === null) {
      config.filter = hidden;
    } else {
      const result = parseFilterInput(
        parsed.filter,
        { fields: context.fields.map(filterMetaOf) },
        [...ordering.visible.keys()],
        { fieldKeyType: 'id' },
      );
      if (result.ok) {
        const merged = mergeHiddenFilter(result.ast as unknown as FilterJson, hidden);
        const count = merged === null ? 0 : filterFieldCount(merged);
        if (count > MAX_FILTER_CONDITIONS) {
          checker.issues.add('INVALID_FILTER', {
            path: 'config.filter',
            code: 'MAX_CONDITIONS_EXCEEDED',
            message: `Filter has more than ${String(MAX_FILTER_CONDITIONS)} conditions`,
            params: { max: MAX_FILTER_CONDITIONS, count },
          });
        }
        config.filter = merged;
      } else {
        for (const issue of result.errors) {
          checker.issues.add('INVALID_FILTER', {
            ...issue,
            path: joinPath('config.filter', issue.path),
          });
        }
      }
    }
  }
  if (parsed.sort !== undefined) {
    config.sort = checkSorts(ordering, parsed.sort, 'config.sort');
  }
  if (parsed.group !== undefined) {
    config.group = checkSorts(ordering, parsed.group, 'config.group');
  }
  for (const key of FIELD_LIST_KEYS) {
    const list = parsed[key];
    if (list === undefined) continue;
    config[key] = keepUnseen(checker, checkFieldList(checker, list, `config.${key}`), base[key]);
  }
  if (parsed.column_widths !== undefined) {
    const widths: Record<string, number> = {};
    for (const [id, width] of Object.entries(base.column_widths)) {
      if (!checker.visible.has(id)) widths[id] = width;
    }
    for (const [id, width] of Object.entries(parsed.column_widths)) {
      if (checker.visible.has(id)) widths[id] = width;
      else checker.issues.add('VALIDATION_FAILED', unknownField(`config.column_widths.${id}`));
    }
    config.column_widths = widths;
  }
  const summaries = (parsed as GridConfigInput).summaries;
  if (summaries !== undefined) {
    config.summaries = checkSummaries(checker, summaries, base.summaries ?? {});
  }
  const colorRules = (parsed as GridConfigInput).color_rules;
  if (colorRules !== undefined) {
    config.color_rules = buildColorRules(
      colorRules,
      base.color_rules ?? [],
      {
        readable: new Set(checker.visible.keys()),
        filterable: [...ordering.visible.keys()],
        filterMeta: { fields: context.fields.map(filterMetaOf) },
        active: activeFieldIds(context),
      },
      (code, item) => {
        checker.issues.add(code, item);
      },
    );
  }
  if (parsed.frozen_count !== undefined) config.frozen_count = parsed.frozen_count;
  if (parsed.row_height !== undefined) config.row_height = parsed.row_height;
  if (parsed.tree !== undefined) config.tree = parsed.tree;
  // A tree is never grouped (T405, BACKLOG S4 open question #10).
  if (
    type === 'grid' &&
    (parsed.tree !== undefined || parsed.group !== undefined) &&
    config.tree.enabled &&
    config.group.length > 0
  ) {
    checker.issues.add('VALIDATION_FAILED', {
      path: parsed.tree === undefined ? 'config.group' : 'config.tree.enabled',
      code: 'TREE_WITH_GROUP',
      message: 'A view shown as a tree cannot be grouped',
    });
  }
  if (parsed.record_detail !== undefined) {
    config.record_detail = checkRecordDetail(
      checker,
      context,
      parsed.record_detail.link_columns,
      base.record_detail,
    );
  }

  if (type === 'kanban') {
    const kanbanInput = (parsed as KanbanConfigInput).kanban ?? {};
    const previous = base.kanban ?? defaultKanban();
    const kanban: StoredKanbanSettings = { ...previous };
    if (kanbanInput.group_field !== undefined) {
      checkFieldOfType(
        checker,
        kanbanInput.group_field,
        'config.kanban.group_field',
        (field) => (field.type === 'select' || field.type === 'user') && isSingleValue(field),
        'a single select or single user field',
      );
      kanban.group_field = kanbanInput.group_field;
    }
    if (kanbanInput.cover_field !== undefined) {
      checkFieldOfType(
        checker,
        kanbanInput.cover_field,
        'config.kanban.cover_field',
        (field) => field.type === 'attachment',
        'an attachment field',
      );
      kanban.cover_field = kanbanInput.cover_field;
    }
    if (kanbanInput.card_fields !== undefined) {
      kanban.card_fields = keepUnseen(
        checker,
        checkFieldList(checker, kanbanInput.card_fields, 'config.kanban.card_fields'),
        previous.card_fields,
      );
    }
    if (kanbanInput.hide_empty_columns !== undefined) {
      kanban.hide_empty_columns = kanbanInput.hide_empty_columns;
    }
    config.kanban = kanban;
  }

  if (type === 'form') {
    const formInput = (parsed as FormConfigInput).form ?? {};
    const previous = base.form ?? defaultForm(context);
    const form: StoredFormSettings = { ...previous, ...formInput } as StoredFormSettings;
    checkSubmissionSettings(checker, formInput, previous, form);
    // A new form, or a new field list, must hold every required field.
    if (formInput.fields !== undefined || stored === null) {
      form.fields = checkForm(checker, context, formInput.fields ?? previous.fields);
    }
    config.form = form;
  }

  checker.issues.throwIfAny();
  return config;
}

/**
 * The config of `source` for a new view (duplicate, or a view changing
 * between shared and personal): references the new saver cannot see are
 * dropped, then the result is validated like a new view.
 */
export function copyViewConfig(
  type: ViewType,
  source: StoredViewConfig,
  context: ViewConfigContext,
): StoredViewConfig {
  const visible = visibleFieldIds(context);
  const active = activeFieldIds(context);
  const restricted = restrictViewConfig(
    source,
    visible,
    active,
    context.linkTargets,
    context.fields,
  );
  // Color rules (T816) are copied as stored, without those the new saver
  // cannot see: a broken rule stays broken (and mends when its field is
  // restored) rather than being validated again.
  delete restricted.color_rules;
  const config = buildViewConfig(type, restricted, context, null);
  if (source.color_rules !== undefined && config.color_rules !== undefined) {
    config.color_rules = source.color_rules.filter((rule) =>
      [...colorRuleFieldIds(rule)].every((id) => visible.has(id) || !active.has(id)),
    );
  }
  return config;
}
