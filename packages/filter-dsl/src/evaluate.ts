import {
  isFieldRefValue,
  isFilterCondition,
  RECORD_ID_REF,
  type FilterConditionOf,
} from './ast.js';
import { addDays, civilDateInZone, formatCivilDate, startOfDay } from './dates.js';
import { compareDecimal, parseDecimal, type Decimal } from './decimal.js';
import {
  fieldProfile,
  isDateOnlyField,
  type FieldProfile,
  type FilterFieldMeta,
  type FilterTableMeta,
} from './field-meta.js';
import { type DslOperator } from './operators.js';
import {
  isDateRange,
  type DateRange,
  type ResolvedFilterNode,
  type ResolvedOperand,
  type ResolvedValue,
} from './resolve.js';
import { foldText } from './unaccent.js';
import { equalityOperator } from './validate.js';

/**
 * Values of one record in **storage form**, keyed by field id (system fields
 * such as `created_at` by their field id too). A missing key is an empty cell.
 * Accepted shapes, i.e. what `toStorage` produces and what node-pg returns
 * with the parsers the query layer configures:
 *
 * | field (or formula/lookup result) | value |
 * |---|---|
 * | text, auto_number | `string` \| `null` |
 * | number | `string` (node-pg `numeric`) \| `number` \| `null` |
 * | datetime with time, created_at, updated_at | `Date` (node-pg `timestamptz`) \| ISO 8601 string \| epoch ms \| `null`; sub-millisecond precision is floored |
 * | datetime date only | `'YYYY-MM-DD'` (node-pg `date` parser set to return text) \| `Date` (read at UTC) \| `null` |
 * | checkbox | `boolean` (`null` reads as `false`) |
 * | select (single and multiple), user, link | `string[]` (`text[]`) \| `null` |
 * | created_by, updated_by | `string` (`text` column) \| `null` |
 * | attachment | array \| `null` |
 */
export type EvaluateRecord = Readonly<Record<string, unknown>>;

export interface EvaluateContext {
  /** Fields of the table the filter was validated against. */
  readonly table: FilterTableMeta;
  /**
   * Automation conditions (`changed`, `changed_to`, `changed_from`, SPEC §11.3):
   * the record before the change, same shape as `record`; `null` for a record
   * that was just created (every field was empty).
   */
  readonly before?: EvaluateRecord | null;
  /**
   * Automation conditions: the field ids in the event diff. When given, it
   * decides `changed`; otherwise `before` and `record` are compared.
   */
  readonly changedFieldIds?: Iterable<string>;
  /**
   * Lookup `where` (SPEC §5.8): the current-table record a `field_ref` reads,
   * keyed by field id, with its record id under `__id`.
   */
  readonly refRecord?: EvaluateRecord;
  /** Lookup `where`: zone that turns a date-only `field_ref` value into instants. Defaults to UTC. */
  readonly timeZone?: string;
}

/** Thrown when a filter cannot be evaluated; always a programming error (unvalidated AST or wrong context). */
export class FilterEvaluationError extends Error {
  override readonly name = 'FilterEvaluationError';
}

/** Negative operators and the positive operator they are the exact complement of. */
const NEGATION: Partial<Record<DslOperator, DslOperator>> = {
  neq: 'eq',
  not_contains: 'contains',
  is_not: 'is',
  is_none_of: 'is_any_of',
  has_none_of: 'has_any_of',
  disjoint: 'intersects',
};

/** Operators whose operand is a list. */
const LIST_OPERATORS: ReadonlySet<DslOperator> = new Set([
  'is_any_of',
  'has_any_of',
  'has_all_of',
  'is_exactly',
  'intersects',
]);

/** The positive operator a negative one complements, or `null`. */
export function negatedOperator(operator: DslOperator): DslOperator | null {
  return NEGATION[operator] ?? null;
}

// ---------------------------------------------------------------------------
// Cell readers (storage form → comparable form).

const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;
const DATE_TEXT = /^\d{4}-\d{2}-\d{2}/;

function parseInstant(text: string): number | null {
  const match = ISO_INSTANT.exec(text.trim());
  if (match === null) return null;
  const [, y, mo, d, h, mi, s = '0', fraction = '', zone = 'Z'] = match;
  let offsetMinutes = 0;
  if (zone.toUpperCase() !== 'Z') {
    const digits = zone.slice(1).replace(':', '');
    offsetMinutes = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2) || '0');
    if (zone.startsWith('-')) offsetMinutes = -offsetMinutes;
  }
  const utc = new Date(0);
  utc.setUTCFullYear(Number(y), Number(mo) - 1, Number(d));
  utc.setUTCHours(Number(h), Number(mi), Number(s), Number(fraction.slice(0, 3).padEnd(3, '0')));
  const epochMs = utc.getTime() - offsetMinutes * 60_000;
  return Number.isFinite(epochMs) ? epochMs : null;
}

function instantOf(raw: unknown): number | null {
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw.getTime();
  if (typeof raw === 'number') return Number.isFinite(raw) ? Math.floor(raw) : null;
  if (typeof raw === 'string') return parseInstant(raw);
  return null;
}

function dateOf(raw: unknown): string | null {
  if (typeof raw === 'string') return DATE_TEXT.test(raw) ? raw.slice(0, 10) : null;
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) return raw.toISOString().slice(0, 10);
  return null;
}

function textOf(raw: unknown): string | null {
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  return null;
}

/** Elements of a list cell; a scalar (`created_by`) is a one-element list, `''`/`null` none. */
function listOf(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw as unknown[];
  if (raw === null || raw === undefined || raw === '') return [];
  return [raw];
}

const isEmptyText = (text: string | null): boolean => text === null || text === '';

// ---------------------------------------------------------------------------
// Evaluation.

interface FieldInfo {
  readonly field: FilterFieldMeta;
  readonly profile: FieldProfile;
  readonly dateOnly: boolean;
}

class Evaluator {
  private readonly fields: ReadonlyMap<string, FilterFieldMeta>;
  private readonly infos = new Map<string, FieldInfo>();
  private readonly changed: ReadonlySet<string> | null;

  constructor(private readonly ctx: EvaluateContext) {
    this.fields = new Map(ctx.table.fields.map((field) => [field.id, field]));
    this.changed = ctx.changedFieldIds === undefined ? null : new Set(ctx.changedFieldIds);
  }

  node(node: ResolvedFilterNode, record: EvaluateRecord): boolean {
    if (isFilterCondition(node)) return this.condition(node, record);
    if (node.op === 'not') return !this.node(node.item, record);
    if (node.op === 'and') return node.items.every((item) => this.node(item, record));
    return node.items.some((item) => this.node(item, record));
  }

  private info(fieldId: string): FieldInfo {
    let info = this.infos.get(fieldId);
    if (info === undefined) {
      const field = this.fields.get(fieldId);
      if (field === undefined) throw new FilterEvaluationError(`Unknown field ${fieldId}`);
      info = { field, profile: fieldProfile(field), dateOnly: isDateOnlyField(field) };
      this.infos.set(fieldId, info);
    }
    return info;
  }

  private condition(condition: FilterConditionOf<ResolvedValue>, record: EvaluateRecord): boolean {
    if ((condition.field as string) === RECORD_ID_REF)
      return this.recordIdCondition(condition, record);
    const info = this.info(condition.field);
    const { operator } = condition;
    const raw = record[condition.field] ?? null;
    switch (operator) {
      case 'changed':
        return this.isChanged(info, record);
      case 'changed_to':
      case 'changed_from': {
        if (!this.isChanged(info, record)) return false;
        const equality = equalityOperator(info.profile.group);
        if (equality === null) throw new FilterEvaluationError(`${operator} is not supported here`);
        const value =
          operator === 'changed_to' ? raw : (this.ctx.before?.[condition.field] ?? null);
        return this.positive(info, equality, value, condition.value ?? null);
      }
      default:
        break;
    }
    const positiveOperator = NEGATION[operator] ?? operator;
    const negate = positiveOperator !== operator;
    const result = isFieldRefValue(condition.value)
      ? this.withFieldRef(info, positiveOperator, raw, condition.value.field_ref)
      : this.positive(info, positiveOperator, raw, condition.value ?? null);
    return negate ? !result : result;
  }

  /**
   * Lookup `where` on `__id` (CONTRACTS §13): the record (`record.__id`) is
   * (`is_any_of`) or is not (`is_none_of`) one of the records the current
   * record links to (`refRecord[field_ref]`: ids or `{ id }`).
   */
  private recordIdCondition(
    condition: FilterConditionOf<ResolvedValue>,
    record: EvaluateRecord,
  ): boolean {
    const refRecord = this.ctx.refRecord;
    if (refRecord === undefined || !isFieldRefValue(condition.value)) {
      throw new FilterEvaluationError('A record ID condition needs ctx.refRecord (lookup mode)');
    }
    const id = record[RECORD_ID_REF];
    const linked = listOf(refRecord[condition.value.field_ref] ?? null).map((item) =>
      typeof item === 'object' && item !== null && 'id' in item ? item.id : item,
    );
    const member = typeof id === 'string' && linked.includes(id);
    return condition.operator === 'is_none_of' ? !member : member;
  }

  private withFieldRef(info: FieldInfo, operator: DslOperator, raw: unknown, ref: string): boolean {
    const refRecord = this.ctx.refRecord;
    if (refRecord === undefined) {
      throw new FilterEvaluationError('field_ref needs ctx.refRecord (lookup mode)');
    }
    const candidates = this.refOperands(info, refRecord[ref] ?? null);
    if (LIST_OPERATORS.has(operator)) return this.positive(info, operator, raw, candidates);
    // A field_ref with several values matches when one of them does.
    return candidates.some((candidate) => this.positive(info, operator, raw, candidate));
  }

  /** Turns the stored value a `field_ref` points at into operands of the condition field's kind. */
  private refOperands(info: FieldInfo, stored: unknown): ResolvedOperand[] {
    const values = listOf(stored);
    if (info.profile.group !== 'datetime') {
      return values.filter(
        (value): value is string | number | boolean =>
          typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean',
      );
    }
    const timeZone = this.ctx.timeZone ?? 'UTC';
    return values.flatMap((value): DateRange[] => {
      const date = typeof value === 'string' && value.length === 10 ? dateOf(value) : null;
      if (date !== null) return [zonedDay(date, timeZone)];
      const instant = instantOf(value);
      if (instant === null) return [];
      const day = civilDateInZone(instant, timeZone);
      return [
        {
          $range: {
            start: new Date(instant).toISOString(),
            end: new Date(instant + 1).toISOString(),
            start_date: formatCivilDate(day),
            end_date: formatCivilDate(addDays(day, 1)),
          },
        },
      ];
    });
  }

  private isChanged(info: FieldInfo, record: EvaluateRecord): boolean {
    if (this.changed !== null) return this.changed.has(info.field.id);
    const before = this.ctx.before;
    if (before === undefined) {
      throw new FilterEvaluationError('changed/changed_to/changed_from need ctx.before');
    }
    const id = info.field.id;
    return !sameStoredValue(info, before?.[id] ?? null, record[id] ?? null);
  }

  /** A positive (non-negated) operator; `operand` null means "no operand" and never matches. */
  private positive(
    info: FieldInfo,
    operator: DslOperator,
    raw: unknown,
    operand: ResolvedValue,
  ): boolean {
    if (operator === 'is_empty') return isEmptyCell(info, raw);
    if (operator === 'is_not_empty') return !isEmptyCell(info, raw);
    switch (info.profile.group) {
      case 'text':
        return textTest(operator, textOf(raw), operand);
      case 'number':
        return numberTest(operator, parseDecimal(raw), operand);
      case 'datetime':
        return info.dateOnly
          ? rangeTest(operator, dateOf(raw), operand, (range) => [
              range.$range.start_date,
              range.$range.end_date,
            ])
          : rangeTest(operator, instantOf(raw), operand, (range) => [
              Date.parse(range.$range.start),
              Date.parse(range.$range.end),
            ]);
      case 'checkbox':
        if (operator !== 'is') break;
        return typeof operand === 'boolean' && (raw === true) === operand;
      case 'single_select':
      case 'multi':
        return listTest(operator, listOf(raw), operand);
      default:
        break;
    }
    throw new FilterEvaluationError(
      `Operator ${operator} is not supported for field type ${info.field.resultType ?? info.field.type}`,
    );
  }
}

/** The day `YYYY-MM-DD` as a range, its instants taken in `timeZone`. */
function zonedDay(date: string, timeZone: string): DateRange {
  const [year = 0, month = 0, day = 0] = date.split('-').map(Number);
  const civil = { year, month, day };
  const next = addDays(civil, 1);
  return {
    $range: {
      start: new Date(startOfDay(civil, timeZone)).toISOString(),
      end: new Date(startOfDay(next, timeZone)).toISOString(),
      start_date: date,
      end_date: formatCivilDate(next),
    },
  };
}

function isEmptyCell(info: FieldInfo, raw: unknown): boolean {
  switch (info.profile.group) {
    case 'text':
      return isEmptyText(textOf(raw));
    case 'number':
      return parseDecimal(raw) === null;
    case 'datetime':
      return (info.dateOnly ? dateOf(raw) : instantOf(raw)) === null;
    case 'checkbox':
      return raw !== true;
    default:
      return listOf(raw).length === 0;
  }
}

function sameStoredValue(info: FieldInfo, a: unknown, b: unknown): boolean {
  switch (info.profile.group) {
    case 'text': {
      const left = textOf(a);
      const right = textOf(b);
      return isEmptyText(left) ? isEmptyText(right) : left === right;
    }
    case 'number': {
      const left = parseDecimal(a);
      const right = parseDecimal(b);
      return left === null || right === null ? left === right : compareDecimal(left, right) === 0;
    }
    case 'datetime':
      return info.dateOnly ? dateOf(a) === dateOf(b) : instantOf(a) === instantOf(b);
    case 'checkbox':
      return (a === true) === (b === true);
    case 'single_select':
    case 'multi': {
      const left = new Set(listOf(a));
      const right = new Set(listOf(b));
      return left.size === right.size && [...left].every((item) => right.has(item));
    }
    default:
      return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  }
}

function asList(operand: ResolvedValue): ResolvedOperand[] {
  if (Array.isArray(operand)) return operand;
  return operand === null ? [] : [operand];
}

function textTest(operator: DslOperator, cell: string | null, operand: ResolvedValue): boolean {
  if (operator === 'intersects') {
    return asList(operand).some((item) => textTest('eq', cell, item));
  }
  if (cell === null || typeof operand !== 'string') return false;
  const value = foldText(cell);
  const needle = foldText(operand);
  switch (operator) {
    case 'eq':
      return value === needle;
    case 'contains':
      return value.includes(needle);
    case 'starts_with':
      return value.startsWith(needle);
    case 'ends_with':
      return value.endsWith(needle);
    default:
      throw new FilterEvaluationError(`Operator ${operator} is not supported for text`);
  }
}

function numberTest(operator: DslOperator, cell: Decimal | null, operand: ResolvedValue): boolean {
  if (operator === 'intersects') {
    return asList(operand).some((item) => numberTest('eq', cell, item));
  }
  if (cell === null) return false;
  if (operator === 'between') {
    if (!Array.isArray(operand) || operand.length !== 2) return false;
    const low = parseDecimal(operand[0]);
    const high = parseDecimal(operand[1]);
    return (
      low !== null &&
      high !== null &&
      compareDecimal(cell, low) >= 0 &&
      compareDecimal(cell, high) <= 0
    );
  }
  const value = parseDecimal(operand);
  if (value === null) return false;
  const order = compareDecimal(cell, value);
  switch (operator) {
    case 'eq':
      return order === 0;
    case 'gt':
      return order > 0;
    case 'gte':
      return order >= 0;
    case 'lt':
      return order < 0;
    case 'lte':
      return order <= 0;
    default:
      throw new FilterEvaluationError(`Operator ${operator} is not supported for number`);
  }
}

/** Datetime operators against half-open ranges (see {@link DateRange}); `T` is epoch ms or `YYYY-MM-DD`. */
function rangeTest<T extends number | string>(
  operator: DslOperator,
  cell: T | null,
  operand: ResolvedValue,
  bounds: (range: DateRange) => [T, T],
): boolean {
  if (cell === null) return false;
  if (operator === 'between') {
    if (!Array.isArray(operand) || operand.length !== 2) return false;
    const [from, to] = operand;
    if (!isDateRange(from) || !isDateRange(to)) return false;
    return cell >= bounds(from)[0] && cell < bounds(to)[1];
  }
  if (operator === 'intersects') {
    return asList(operand).some((item) => rangeTest('is', cell, item, bounds));
  }
  if (!isDateRange(operand)) return false;
  const [start, end] = bounds(operand);
  switch (operator) {
    case 'is':
      return cell >= start && cell < end;
    case 'before':
      return cell < start;
    case 'after':
      return cell >= end;
    case 'on_or_before':
      return cell < end;
    case 'on_or_after':
      return cell >= start;
    default:
      throw new FilterEvaluationError(`Operator ${operator} is not supported for datetime`);
  }
}

function listTest(
  operator: DslOperator,
  cell: readonly unknown[],
  operand: ResolvedValue,
): boolean {
  const has = (item: unknown) => cell.includes(item);
  if (operator === 'is') return operand !== null && !Array.isArray(operand) && has(operand);
  const list = asList(operand);
  switch (operator) {
    case 'is_any_of':
    case 'has_any_of':
    case 'intersects':
      return list.some(has);
    case 'has_all_of':
      return list.length > 0 && list.every(has);
    case 'is_exactly':
      return (
        list.length > 0 &&
        list.every(has) &&
        cell.every((item) => list.includes(item as ResolvedOperand))
      );
    default:
      throw new FilterEvaluationError(`Operator ${operator} is not supported for list fields`);
  }
}

/**
 * Evaluates a resolved filter (see `resolveVariables`) against one record in
 * storage form (SPEC §6.3). Same semantics as the SQL compiler in
 * `@cellhive/server-core` — the integration harness checks both on the same
 * fixture:
 *
 * - text `eq`/`contains`/`starts_with`/`ends_with` compare
 *   `meta.f_unaccent(lower(x))` of both sides (see {@link foldText});
 * - an empty cell (`null`, `''`, `[]`) never matches a positive operator, and
 *   always matches its complement (`neq`, `not_contains`, `is_not`,
 *   `is_none_of`, `has_none_of`, `disjoint` are exactly `not` of
 *   `eq`, `contains`, `is`, `is_any_of`, `has_any_of`, `intersects`);
 * - `has_any_of`, `has_all_of`, `is_exactly` with an empty list (e.g. no
 *   current user) match nothing; `has_none_of []` matches everything;
 * - numbers compare exactly as decimals; dates use the half-open ranges of
 *   {@link DateRange} (`start`/`end` for timestamps, `start_date`/`end_date`
 *   for date-only fields).
 *
 * Throws {@link FilterEvaluationError} for fields missing from `ctx.table`,
 * or automation/lookup operators without the context they need.
 */
export function evaluate(
  ast: ResolvedFilterNode,
  record: EvaluateRecord,
  ctx: EvaluateContext,
): boolean {
  return new Evaluator(ctx).node(ast, record);
}

/**
 * Like {@link evaluate}, but prepares once for many records (e.g. filtering
 * a page of rows in memory).
 */
export function createEvaluator(
  ast: ResolvedFilterNode,
  ctx: EvaluateContext,
): (record: EvaluateRecord) => boolean {
  const evaluator = new Evaluator(ctx);
  return (record) => evaluator.node(ast, record);
}
