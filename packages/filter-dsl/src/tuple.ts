import { z } from 'zod';

import { type FilterNode, type FilterValue } from './ast.js';
import {
  fieldProfile,
  type FieldGroup,
  type FilterFieldMeta,
  type FilterTableMeta,
} from './field-meta.js';
import { joinPath, type FilterIssue } from './issues.js';

import type { FilterOperator } from './operators.js';
import type { Id } from '@cellhive/contracts';

/** Operators of the tuple form (CONTRACTS §3). */
export const TUPLE_OPERATORS = [
  '==',
  '!=',
  '>',
  '>=',
  '<',
  '<=',
  'intersects',
  'disjoint',
  'empty',
  'non_empty',
] as const;
export type TupleOperator = (typeof TUPLE_OPERATORS)[number];

export type TupleCondition = [string, TupleOperator] | [string, TupleOperator, unknown];

export interface TupleFilter {
  logic: 'and' | 'or';
  conditions: TupleCondition[];
}

const tupleOperatorSchema = z.enum(TUPLE_OPERATORS);

/** Structural schema of the tuple form (one level, like Lark). */
export const tupleFilterSchema = z.strictObject({
  logic: z.enum(['and', 'or']),
  conditions: z.array(
    z.union([
      z.tuple([z.string(), tupleOperatorSchema]),
      z.tuple([z.string(), tupleOperatorSchema, z.unknown()]),
    ]),
  ),
}) as z.ZodType<TupleFilter>;

export interface NormalizeTupleOptions {
  /** How the tuple names fields (CONTRACTS §1.3). */
  readonly fieldKeyType: 'name' | 'id';
  /**
   * Fields the caller may read. Pass it so that a hidden field fails here
   * with the same issue as a missing one; otherwise every field of
   * `tableMeta` resolves and `validateFilter` reports hidden ones.
   */
  readonly visibleFieldIds?: Iterable<string>;
}

export type NormalizeTupleResult =
  | { readonly ok: true; readonly ast: FilterNode }
  | { readonly ok: false; readonly errors: FilterIssue[] };

/** How one tuple operator maps for a field group (a cell of the CONTRACTS §3 table). */
interface Mapping {
  readonly operator: FilterOperator;
  /** Wrap in `{ op: 'not' }` (`!=` on datetime and multi-value fields). */
  readonly negate?: boolean;
  /** Checkbox `!=`: `is` with the boolean inverted. */
  readonly invert?: boolean;
  /** Text `intersects`/`disjoint` with several strings: one condition per string. */
  readonly spread?: 'or' | 'and';
}

type Table = Partial<Record<TupleOperator, Mapping>>;

const EMPTY: Table = { empty: { operator: 'is_empty' }, non_empty: { operator: 'is_not_empty' } };

/** CONTRACTS §3, column by column. */
const TUPLE_TABLE: Record<FieldGroup, Table> = {
  text: {
    '==': { operator: 'eq' },
    '!=': { operator: 'neq' },
    intersects: { operator: 'contains', spread: 'or' },
    disjoint: { operator: 'not_contains', spread: 'and' },
    ...EMPTY,
  },
  number: {
    '==': { operator: 'eq' },
    '!=': { operator: 'neq' },
    '>': { operator: 'gt' },
    '>=': { operator: 'gte' },
    '<': { operator: 'lt' },
    '<=': { operator: 'lte' },
    ...EMPTY,
  },
  datetime: {
    '==': { operator: 'is' },
    '!=': { operator: 'is', negate: true },
    '>': { operator: 'after' },
    '>=': { operator: 'on_or_after' },
    '<': { operator: 'before' },
    '<=': { operator: 'on_or_before' },
    ...EMPTY,
  },
  // A checkbox is never empty (`boolean NOT NULL`, SPEC §5.5) and only has `is` (SPEC §6.2).
  checkbox: {
    '==': { operator: 'is' },
    '!=': { operator: 'is', invert: true },
  },
  single_select: {
    '==': { operator: 'is' },
    '!=': { operator: 'is_not' },
    intersects: { operator: 'is_any_of' },
    disjoint: { operator: 'is_none_of' },
    ...EMPTY,
  },
  multi: {
    '==': { operator: 'is_exactly' },
    '!=': { operator: 'is_exactly', negate: true },
    intersects: { operator: 'has_any_of' },
    disjoint: { operator: 'has_none_of' },
    ...EMPTY,
  },
  attachment: EMPTY,
  unsupported: {},
};

const EXACT_DATE_TOKEN = /^ExactDate\((\d{4}-\d{2}-\d{2})(?: (\d{2}:\d{2}))?\)$/;
const RELATIVE_TOKENS: Record<string, 'today' | 'yesterday' | 'tomorrow'> = {
  Today: 'today',
  Yesterday: 'yesterday',
  Tomorrow: 'tomorrow',
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `ExactDate(…)`/`Today`/`Yesterday`/`Tomorrow` → `$date`; `null` for a malformed `ExactDate(`. */
function dateToken(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const relative = RELATIVE_TOKENS[value];
  if (relative !== undefined) return { $date: { relative } };
  if (!value.startsWith('ExactDate(')) return value;
  const match = EXACT_DATE_TOKEN.exec(value);
  if (match === null) return null;
  const [, date = '', time] = match;
  return { $date: { exact: time === undefined ? date : `${date}T${time}` } };
}

/** `CurrentUser` → `$var`, `{ id }` → id; other values are left to `validateFilter`. */
function referenceToken(value: unknown): unknown {
  if (value === 'CurrentUser') return { $var: 'current_user' };
  if (isRecord(value) && Object.keys(value).length === 1 && typeof value['id'] === 'string') {
    return value['id'];
  }
  return value;
}

type Converted = { ok: true; value: unknown } | { ok: false; message: string };

function convertValue(
  field: FilterFieldMeta,
  group: FieldGroup,
  mapping: Mapping,
  raw: unknown,
): Converted {
  if (group === 'datetime') {
    // Lark sends dates either bare or as a one-element list.
    const single = Array.isArray(raw) && raw.length === 1 ? (raw as unknown[])[0] : raw;
    const converted = Array.isArray(single) ? single.map(dateToken) : dateToken(single);
    const malformed = Array.isArray(converted) ? converted.includes(null) : converted === null;
    return malformed
      ? { ok: false, message: 'Expected ExactDate(YYYY-MM-DD) or ExactDate(YYYY-MM-DD HH:mm)' }
      : { ok: true, value: converted };
  }
  if (group === 'multi') {
    const list = Array.isArray(raw) ? raw : [raw];
    return { ok: true, value: list.map(referenceToken) };
  }
  if (mapping.invert === true) {
    return typeof raw === 'boolean'
      ? { ok: true, value: !raw }
      : { ok: false, message: `Field ${JSON.stringify(field.name)} expects true or false` };
  }
  return { ok: true, value: raw };
}

function conditionOf(fieldId: Id<'fld'>, operator: FilterOperator, value: unknown): FilterNode {
  // Values are checked by `validateFilter`; the tuple step only maps shapes.
  return value === undefined
    ? { field: fieldId, operator }
    : { field: fieldId, operator, value: value as FilterValue };
}

/**
 * Converts the tuple form `{ logic, conditions: [[field, op, value?], …] }`
 * (CONTRACTS §3) to the Filter DSL: field names/ids → field ids, tuple
 * operators → DSL operators per field type, `ExactDate(…)`, `Today`,
 * `Yesterday`, `Tomorrow` → `$date`, `CurrentUser` → `$var`, `{ id }` → id.
 *
 * Values are otherwise passed through; run {@link validateFilter} on the
 * result (or use `parseFilterInput`, which does both and maps paths back).
 * Issue paths point into the tuple: `conditions[2][1]`.
 */
export function normalizeTuple(
  input: unknown,
  tableMeta: FilterTableMeta,
  options: NormalizeTupleOptions,
): NormalizeTupleResult {
  const errors: FilterIssue[] = [];
  if (!isRecord(input)) {
    return {
      ok: false,
      errors: [{ path: '', code: 'INVALID_STRUCTURE', message: 'Expected { logic, conditions }' }],
    };
  }
  for (const key of Object.keys(input)) {
    if (key !== 'logic' && key !== 'conditions') {
      errors.push({
        path: key,
        code: 'INVALID_STRUCTURE',
        message: `Unknown key ${JSON.stringify(key)}`,
      });
    }
  }
  const { logic, conditions } = input;
  if (logic !== 'and' && logic !== 'or') {
    errors.push({ path: 'logic', code: 'INVALID_STRUCTURE', message: 'Expected "and" or "or"' });
  }
  if (!Array.isArray(conditions)) {
    errors.push({ path: 'conditions', code: 'INVALID_STRUCTURE', message: 'Expected an array' });
    return { ok: false, errors };
  }

  const visible = options.visibleFieldIds === undefined ? null : new Set(options.visibleFieldIds);
  const candidates = tableMeta.fields.filter((field) => visible === null || visible.has(field.id));
  const key = options.fieldKeyType;
  const byKey = new Map(candidates.map((field) => [key === 'name' ? field.name : field.id, field]));

  const items: FilterNode[] = [];
  (conditions as unknown[]).forEach((condition, index) => {
    const path = joinPath('conditions', index);
    if (
      !Array.isArray(condition) ||
      condition.length < 2 ||
      condition.length > 3 ||
      typeof condition[0] !== 'string' ||
      typeof condition[1] !== 'string'
    ) {
      errors.push({
        path,
        code: 'INVALID_STRUCTURE',
        message: 'Expected [field, operator] or [field, operator, value]',
      });
      return;
    }
    const [fieldKey, op, raw] = condition as [string, string, unknown];
    const field = byKey.get(fieldKey);
    if (field === undefined) {
      errors.push({
        path: joinPath(path, 0),
        code: 'UNKNOWN_FIELD',
        message: 'Field does not exist',
        params: { field: fieldKey },
      });
      return;
    }
    const group = fieldProfile(field).group;
    const mapping = (TUPLE_TABLE[group] as Partial<Record<string, Mapping>>)[op];
    if (mapping === undefined) {
      errors.push({
        path: joinPath(path, 1),
        code: 'OPERATOR_NOT_ALLOWED',
        message: `Operator ${op} is not allowed for this field`,
        params: { operator: op, field_type: field.resultType ?? field.type },
      });
      return;
    }
    const fieldId = field.id as Id<'fld'>;
    if (mapping.operator === 'is_empty' || mapping.operator === 'is_not_empty') {
      if (raw !== undefined && raw !== null) {
        errors.push({
          path: joinPath(path, 2),
          code: 'VALUE_NOT_ALLOWED',
          message: `Operator ${op} takes no value`,
          params: { operator: op },
        });
        return;
      }
      items.push(conditionOf(fieldId, mapping.operator, undefined));
      return;
    }
    const converted = convertValue(field, group, mapping, raw);
    if (!converted.ok) {
      errors.push({ path: joinPath(path, 2), code: 'INVALID_VALUE', message: converted.message });
      return;
    }
    const { value } = converted;
    if (mapping.spread !== undefined && Array.isArray(value) && value.length > 0) {
      const parts = value.map((part) => conditionOf(fieldId, mapping.operator, part));
      items.push(
        parts.length === 1 ? (parts[0] as FilterNode) : { op: mapping.spread, items: parts },
      );
      return;
    }
    const node = conditionOf(fieldId, mapping.operator, value);
    items.push(mapping.negate === true ? { op: 'not', item: node } : node);
  });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, ast: { op: logic as 'and' | 'or', items } };
}
