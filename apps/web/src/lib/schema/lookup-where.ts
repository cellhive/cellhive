import {
  fieldProfile,
  NO_VALUE_OPERATORS,
  RECORD_ID_REF,
  validateFilter,
  type DslOperator,
  type FilterFieldMeta,
  type FieldProfile,
} from '@cellhive/filter-dsl';

import type { FieldDto } from '@cellhive/contracts';
import type { FieldType } from '@cellhive/field-types';

/**
 * The conditions of a lookup field (`where`, SPEC §5.8, BACKLOG T467) as
 * the lookup dialog edits them: one level, all / any, at most 5 conditions,
 * at least 1; each compares a field of the **source** table with a
 * constant or with a field of **this** table (`field_ref`, "This record" =
 * `__id`). Pure functions shared by `features/lookup` (the dialog) and the
 * condition editor of `features/view/toolbar` (the T311 value editors),
 * which features may not import from each other (FRONTEND §1.2).
 *
 * The operators offered are the ones the three places that read a lookup
 * `where` accept: `validateFilter` (lookup mode), `lookupToAst` (formula
 * engine) and the SQL of `field_ref` conditions (`filter-sql.ts`). The set
 * operators `intersects`/`disjoint` are never shown by name (BACKLOG S4b
 * supplementary decision #7): a stored one is labelled with the existing
 * filter wording — "has any of / has none of" on multi-value fields,
 * "is any of / is none of" on single values.
 */

/** At most 5 conditions (Lark lookup, board "S4b · Cấu hình tra cứu"). */
export const MAX_LOOKUP_CONDITIONS = 5;

/** `field_ref` of "this record" (its id). */
export const THIS_RECORD_REF = RECORD_ID_REF;

/** Value of a condition: a constant (`undefined` until typed) or a field of this table. */
export type LookupValueDraft =
  | { readonly kind: 'constant'; readonly value?: unknown }
  | { readonly kind: 'ref'; readonly ref: string };

export interface LookupConditionDraft {
  /** Stable key (React, issue placement). */
  readonly key: string;
  /** Field of the source table (`''` until chosen). */
  readonly field: string;
  readonly operator: DslOperator;
  readonly value: LookupValueDraft;
  /** Made by the "through a link field" shortcut (badge "auto"). */
  readonly auto?: boolean;
}

export interface LookupConditionsDraft {
  readonly op: 'and' | 'or';
  readonly conditions: readonly LookupConditionDraft[];
  /**
   * A stored `where` this editor cannot show (nested groups, `not`, made
   * through the API): kept and sent as is until the user replaces it.
   */
  readonly advanced?: Readonly<Record<string, unknown>>;
}

let nextKey = 0;
/** Keys of conditions: unique in the tab. */
export function newConditionKey(): string {
  nextKey += 1;
  return `lk${String(nextKey)}`;
}

export const EMPTY_CONDITIONS: LookupConditionsDraft = { op: 'and', conditions: [] };

// ---------------------------------------------------------------------------
// Fields

/**
 * The source record itself in a condition (`__id`, CONTRACTS §13): it is
 * (not) one of the records a link field of this table links to — how a
 * lookup goes through a one-way link of this table.
 */
export const RECORD_FIELD_ID = THIS_RECORD_REF;

/**
 * The pseudo field of the source record's ID in the condition editor
 * (`name`: e.g. "Record of Orders"); `options.link_table` = the source table.
 */
export function recordIdField(sourceTableId: string, name: string): FieldDto {
  return {
    id: RECORD_FIELD_ID as FieldDto['id'],
    table_id: sourceTableId as FieldDto['table_id'],
    name,
    type: 'link',
    options: { link_table: sourceTableId },
    is_primary: false,
    required: false,
    unique_values: false,
    description: null,
    position: -1,
    created_at: '1970-01-01T00:00:00.000Z',
    updated_at: '1970-01-01T00:00:00.000Z',
  };
}

const isRecordId = (field: FieldDto) => (field.id as string) === RECORD_FIELD_ID;

/** How a source field compares in a lookup condition. */
export type LookupGroup =
  | 'record'
  | 'text'
  | 'number'
  | 'datetime'
  | 'checkbox'
  | 'single_select'
  | 'multi'
  | 'link'
  | 'none';

/** Filter meta of a field as the server builds it for a lookup (`lookupFilterFieldMeta`). */
export function lookupFilterMeta(field: FieldDto): FilterFieldMeta {
  const meta: FilterFieldMeta = {
    id: field.id,
    name: field.name,
    type: field.type,
    options: field.options,
  };
  if (field.type !== 'formula' && field.type !== 'lookup') return meta;
  const type = field.result_type;
  if (type === undefined || type.list) return meta;
  const scalar: FieldType | undefined =
    type.kind === 'number'
      ? 'number'
      : type.kind === 'text'
        ? 'text'
        : type.kind === 'boolean'
          ? 'checkbox'
          : type.kind === 'date' || type.kind === 'datetime'
            ? 'datetime'
            : undefined;
  return scalar === undefined ? meta : { ...meta, resultType: scalar };
}

function profileOf(field: FieldDto): FieldProfile | null {
  try {
    return fieldProfile(lookupFilterMeta(field));
  } catch {
    return null;
  }
}

/** The comparison group of a source field (`none`: not usable in a condition). */
export function lookupGroupOf(field: FieldDto): LookupGroup {
  if (isRecordId(field)) return 'record';
  if (field.type === 'parent' || field.type === 'attachment') return 'none';
  if (field.type === 'link') return 'link';
  const profile = profileOf(field);
  if (profile === null) return 'none';
  switch (profile.group) {
    case 'text':
    case 'number':
    case 'datetime':
    case 'checkbox':
    case 'single_select':
      return profile.group;
    case 'multi':
      return profile.element === 'record' ? 'none' : 'multi';
    default:
      return 'none';
  }
}

const OPERATORS: Readonly<Record<LookupGroup, readonly DslOperator[]>> = {
  text: [
    'eq',
    'neq',
    'contains',
    'not_contains',
    'starts_with',
    'ends_with',
    'is_empty',
    'is_not_empty',
  ],
  number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'is_empty', 'is_not_empty'],
  datetime: [
    'is',
    'before',
    'after',
    'on_or_before',
    'on_or_after',
    'between',
    'is_empty',
    'is_not_empty',
  ],
  checkbox: ['is'],
  single_select: ['is', 'is_not', 'is_any_of', 'is_none_of', 'is_empty', 'is_not_empty'],
  multi: ['has_any_of', 'has_all_of', 'has_none_of', 'is_exactly', 'is_empty', 'is_not_empty'],
  link: ['has_any_of', 'has_all_of', 'has_none_of', 'is_exactly', 'is_empty', 'is_not_empty'],
  record: ['is_any_of', 'is_none_of'],
  none: [],
};

/** Source fields a condition may name (the caller passes the fields the user reads). */
export function conditionFields(fields: readonly FieldDto[]): FieldDto[] {
  return fields.filter((field) => lookupGroupOf(field) !== 'none' && !isRecordId(field));
}

/** Link fields of this table to `sourceTableId` (a record ID condition compares with them). */
export function linksTo(current: readonly FieldDto[], sourceTableId: string): FieldDto[] {
  return current.filter(
    (field) =>
      field.type === 'link' &&
      (field.options as { link_table?: unknown }).link_table === sourceTableId,
  );
}

/**
 * The operators offered for a source field; `current` (a stored operator
 * not in the list, e.g. `intersects` on a text field) is kept first so the
 * condition shows as saved.
 */
export function lookupOperators(field: FieldDto, current?: DslOperator): DslOperator[] {
  const list = [...OPERATORS[lookupGroupOf(field)]];
  if (current !== undefined && !list.includes(current)) list.unshift(current);
  return list;
}

/** Whether values of the group hold several items ("has any of" wording). */
function isMultiGroup(group: LookupGroup): boolean {
  return group === 'multi' || group === 'link';
}

/**
 * The key (under `toolbar:filter.operators`) of an operator's label on a
 * field: `intersects`/`disjoint` borrow the wording of the matching filter
 * operator (decision #7).
 */
export function operatorLabelKey(field: FieldDto | undefined, operator: DslOperator): string {
  const multi = field !== undefined && isMultiGroup(lookupGroupOf(field));
  if (operator === 'intersects') return multi ? 'has_any_of' : 'is_any_of';
  if (operator === 'disjoint') return multi ? 'has_none_of' : 'is_none_of';
  return operator;
}

/**
 * A stored set operator where the field has the same operator by another
 * name (select, multi-value, link: same SQL and evaluation); other groups
 * keep `intersects`/`disjoint` (labelled "is any of / is none of").
 */
export function normalizeOperator(field: FieldDto, operator: DslOperator): DslOperator {
  const group = lookupGroupOf(field);
  if (operator === 'intersects') {
    if (group === 'single_select') return 'is_any_of';
    if (isMultiGroup(group)) return 'has_any_of';
  }
  if (operator === 'disjoint') {
    if (group === 'single_select') return 'is_none_of';
    if (isMultiGroup(group)) return 'has_none_of';
  }
  return operator;
}

// ---------------------------------------------------------------------------
// field_ref: which fields of this table a source field compares with
// (server `checkLookupFieldRefs`: text ← text/number/date/ids/`__id`,
// number ← number, date ← date/datetime, ids ← text/ids/`__id`).

type SourceKind = 'text' | 'numeric' | 'date' | 'ids' | 'none';
type RefKind = 'text' | 'numeric' | 'date' | 'ids' | 'none';

function sourceKind(field: FieldDto): SourceKind {
  switch (field.type) {
    case 'text':
    case 'auto_number':
      return 'text';
    case 'number':
      return 'numeric';
    case 'datetime':
    case 'created_at':
    case 'updated_at':
      return 'date';
    case 'select':
    case 'user':
    case 'created_by':
    case 'updated_by':
    case 'link':
      return 'ids';
    default:
      return 'none';
  }
}

function refKind(field: FieldDto): RefKind {
  switch (field.type) {
    case 'text':
    case 'auto_number':
      return 'text';
    case 'number':
      return 'numeric';
    case 'datetime':
    case 'created_at':
    case 'updated_at':
      return 'date';
    case 'select':
    case 'user':
    case 'created_by':
    case 'updated_by':
      return 'ids';
    default:
      return 'none';
  }
}

const COMPARABLE: Readonly<Record<SourceKind, ReadonlySet<RefKind | 'id'>>> = {
  text: new Set(['text', 'numeric', 'date', 'ids', 'id']),
  numeric: new Set(['numeric']),
  date: new Set(['date']),
  ids: new Set(['text', 'ids', 'id']),
  none: new Set(),
};

/** Shape of a condition's value: none, one, a pair (`between`) or a list. */
export function valueShape(operator: DslOperator): 'none' | 'one' | 'pair' | 'list' {
  if (NO_VALUE_OPERATORS.has(operator)) return 'none';
  if (operator === 'between') return 'pair';
  if (
    operator === 'is_any_of' ||
    operator === 'is_none_of' ||
    operator === 'has_any_of' ||
    operator === 'has_all_of' ||
    operator === 'has_none_of' ||
    operator === 'is_exactly' ||
    operator === 'intersects' ||
    operator === 'disjoint'
  ) {
    return 'list';
  }
  return 'one';
}

/** Whether the value of the condition may be a field of this table. */
export function refAllowed(field: FieldDto, operator: DslOperator): boolean {
  if (isRecordId(field)) return true;
  const shape = valueShape(operator);
  return (shape === 'one' || shape === 'list') && sourceKind(field) !== 'none';
}

/** Whether the value may be a constant (a link field is compared with this record only). */
export function constantAllowed(field: FieldDto): boolean {
  return field.type !== 'link' && !isRecordId(field);
}

/**
 * Fields of this table a source field compares with, and whether "this
 * record" (`__id`) does. `current` = the fields of this table the user
 * reads (the edited field itself left out by the caller).
 */
export function refChoices(
  field: FieldDto,
  current: readonly FieldDto[],
): { readonly record: boolean; readonly fields: FieldDto[] } {
  if (isRecordId(field)) return { record: false, fields: linksTo(current, field.table_id) };
  const allowed = COMPARABLE[sourceKind(field)];
  return {
    record: allowed.has('id'),
    fields: current.filter((candidate) => {
      const kind = refKind(candidate);
      return kind !== 'none' && allowed.has(kind);
    }),
  };
}

/** The value a condition starts with when its field or operator changes. */
export function initialValue(
  field: FieldDto,
  operator: DslOperator,
  currentTableId: string,
): LookupValueDraft {
  if (valueShape(operator) === 'none') return { kind: 'constant' };
  if (isRecordId(field)) return { kind: 'ref', ref: '' };
  if (field.type === 'link') {
    const target = (field.options as { link_table?: unknown }).link_table;
    // A link to this table: its records are compared with this record.
    return target === currentTableId
      ? { kind: 'ref', ref: THIS_RECORD_REF }
      : { kind: 'ref', ref: '' };
  }
  if (lookupGroupOf(field) === 'checkbox') return { kind: 'constant', value: true };
  return { kind: 'constant' };
}

/** A new condition on `field`. */
export function newCondition(field: FieldDto, currentTableId: string): LookupConditionDraft {
  const operator = lookupOperators(field)[0] ?? 'is_not_empty';
  return {
    key: newConditionKey(),
    field: field.id,
    operator,
    value: initialValue(field, operator, currentTableId),
  };
}

/** The condition with another operator: a value that still fits stays. */
export function withOperator(
  condition: LookupConditionDraft,
  field: FieldDto,
  operator: DslOperator,
  currentTableId: string,
): LookupConditionDraft {
  const before = valueShape(condition.operator);
  const after = valueShape(operator);
  let value: LookupValueDraft;
  if (after === 'none') value = { kind: 'constant' };
  else if (condition.value.kind === 'ref' && refAllowed(field, operator)) value = condition.value;
  else if (condition.value.kind === 'constant' && before === after) value = condition.value;
  else value = initialValue(field, operator, currentTableId);
  // A changed condition is no longer the shortcut's ("auto" badge goes).
  return { key: condition.key, field: condition.field, operator, value };
}

// ---------------------------------------------------------------------------
// DSL ⇄ draft

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function conditionOf(
  node: Record<string, unknown>,
  byId: ReadonlyMap<string, FieldDto>,
): LookupConditionDraft | null {
  const field = node['field'];
  const operator = node['operator'];
  if (typeof field !== 'string' || typeof operator !== 'string') return null;
  const source = byId.get(field);
  const raw = node['value'];
  const value: LookupValueDraft =
    isObject(raw) && typeof raw['field_ref'] === 'string'
      ? { kind: 'ref', ref: raw['field_ref'] }
      : raw === undefined
        ? { kind: 'constant' }
        : { kind: 'constant', value: raw };
  const op = operator as DslOperator;
  return {
    key: newConditionKey(),
    field,
    operator: source === undefined ? op : normalizeOperator(source, op),
    value,
  };
}

/** Source fields by id, with the record ID pseudo field (`__id`). */
function withRecordId(sourceFields: readonly FieldDto[]): Map<string, FieldDto> {
  const byId = new Map(sourceFields.map((field) => [field.id as string, field]));
  const tableId = sourceFields[0]?.table_id;
  if (tableId !== undefined) byId.set(RECORD_FIELD_ID, recordIdField(tableId, ''));
  return byId;
}

/**
 * The draft of a stored `where` (Filter DSL). One condition or one
 * `and`/`or` group of conditions is edited here; anything else is kept as
 * `advanced`.
 */
export function conditionsOf(
  where: unknown,
  sourceFields: readonly FieldDto[],
): LookupConditionsDraft {
  if (!isObject(where)) return EMPTY_CONDITIONS;
  const byId = withRecordId(sourceFields);
  if ('field' in where) {
    const condition = conditionOf(where, byId);
    return condition === null
      ? { ...EMPTY_CONDITIONS, advanced: where }
      : { op: 'and', conditions: [condition] };
  }
  const op = where['op'];
  const items = where['items'];
  if ((op === 'and' || op === 'or') && Array.isArray(items)) {
    const conditions = (items as unknown[]).map((item) =>
      isObject(item) && 'field' in item ? conditionOf(item, byId) : null,
    );
    if (
      conditions.every((item): item is LookupConditionDraft => item !== null) &&
      conditions.length <= MAX_LOOKUP_CONDITIONS
    ) {
      return { op, conditions };
    }
  }
  return { ...EMPTY_CONDITIONS, advanced: where };
}

function filled(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length > 0 && value.every(filled);
  return true;
}

/** Whether a condition has everything its operator needs. */
export function isComplete(condition: LookupConditionDraft, field: FieldDto | undefined): boolean {
  if (field === undefined || condition.field === '') return false;
  const shape = valueShape(condition.operator);
  if (shape === 'none') return true;
  if (condition.value.kind === 'ref') return condition.value.ref !== '';
  const value = condition.value.value;
  if (shape === 'pair') return Array.isArray(value) && value.length === 2 && value.every(filled);
  return filled(value);
}

/** The DSL node of a complete condition. */
function nodeOf(condition: LookupConditionDraft): Record<string, unknown> {
  const shape = valueShape(condition.operator);
  if (shape === 'none') return { field: condition.field, operator: condition.operator };
  const value =
    condition.value.kind === 'ref' ? { field_ref: condition.value.ref } : condition.value.value;
  return { field: condition.field, operator: condition.operator, value };
}

export interface BuiltWhere {
  /** The `where` to save; `null` while no condition is complete (or valid). */
  readonly where: Readonly<Record<string, unknown>> | null;
  /** Conditions not complete yet (left out of `where`). */
  readonly incomplete: ReadonlySet<string>;
  /** Filter issue codes by condition key (client validation, as the server's). */
  readonly issues: ReadonlyMap<string, readonly string[]>;
  /** Condition key of each `items[i]` of `where` (server error paths). */
  readonly keys: readonly string[];
}

/**
 * The `where` of the draft — always an `and`/`or` group — validated like
 * the server does (`validateFilter`, lookup mode, the fields the user
 * reads). Incomplete conditions are left out and listed.
 */
export function buildWhere(
  draft: LookupConditionsDraft,
  sourceFields: readonly FieldDto[],
  currentFields: readonly FieldDto[],
): BuiltWhere {
  if (draft.advanced !== undefined && draft.conditions.length === 0) {
    return { where: draft.advanced, incomplete: new Set(), issues: new Map(), keys: [] };
  }
  const byId = withRecordId(sourceFields);
  const incomplete = new Set<string>();
  const keys: string[] = [];
  const items: Record<string, unknown>[] = [];
  for (const condition of draft.conditions) {
    if (!isComplete(condition, byId.get(condition.field))) {
      incomplete.add(condition.key);
      continue;
    }
    keys.push(condition.key);
    items.push(nodeOf(condition));
  }
  if (items.length === 0) return { where: null, incomplete, issues: new Map(), keys };
  const where = { op: draft.op, items };
  const result = validateFilter(
    where,
    { fields: sourceFields.map(lookupFilterMeta) },
    sourceFields.map((field) => field.id),
    { mode: 'lookup', refFieldIds: currentFields.map((field) => field.id) },
  );
  if (result.ok) return { where, incomplete, issues: new Map(), keys };
  return { where: null, incomplete, issues: issuesByKey(result.errors, keys), keys };
}

/**
 * Condition keys of issue paths: `items[2].value` (client) or
 * `options.where.items.2.value.field_ref` (server). Issues of the whole
 * `where` go under `''`.
 */
export function issuesByKey(
  issues: readonly { readonly path: string; readonly code: string }[],
  keys: readonly string[],
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const issue of issues) {
    const match = /items(?:\[|\.)(\d+)/u.exec(issue.path);
    const key = match === null ? '' : (keys[Number(match[1])] ?? '');
    result.set(key, [...(result.get(key) ?? []), issue.code]);
  }
  return result;
}
