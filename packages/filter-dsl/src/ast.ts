import { idOf, type Id } from '@cellhive/contracts';
import { z } from 'zod';

import { parseExactDate } from './dates.js';
import { DSL_OPERATORS, type DslOperator } from './operators.js';

/** SPEC §6.1: at most 5 nested groups (`and`/`or`/`not` each count as one level). */
export const MAX_FILTER_DEPTH = 5;
/** SPEC §6.1: at most 50 conditions in one filter. */
export const MAX_FILTER_CONDITIONS = 50;
/** Longest list value (matches the 1 000-option cap of select fields). */
export const MAX_VALUE_ITEMS = 1000;
/** Longest text operand. */
export const MAX_TEXT_VALUE_LENGTH = 10_000;
/** Largest `amount` of `days_ago`/`days_from_now` (about 100 years). */
export const MAX_RELATIVE_AMOUNT = 36_500;

/** Variables (SPEC §6.1). */
export const FILTER_VARIABLES = ['current_user', 'current_user_groups', 'today', 'now'] as const;
export type FilterVariable = (typeof FILTER_VARIABLES)[number];

/** Relative dates (SPEC §6.1), all computed in the org/user time zone. */
export const RELATIVE_DATES = [
  'today',
  'tomorrow',
  'yesterday',
  'days_ago',
  'days_from_now',
  'this_week',
  'this_month',
  'last_month',
  'this_year',
] as const;
export type RelativeDate = (typeof RELATIVE_DATES)[number];

/** Relative dates that require `amount` (and the only ones that accept it). */
export const RELATIVE_DATES_WITH_AMOUNT: ReadonlySet<RelativeDate> = new Set([
  'days_ago',
  'days_from_now',
]);

/** `field_ref` target meaning "the id of the current record" (SPEC §5.8 example). */
export const RECORD_ID_REF = '__id';

export interface VariableValue {
  $var: FilterVariable;
}

export type DateSpec = { relative: RelativeDate; amount?: number | undefined } | { exact: string };

export interface DateValue {
  $date: DateSpec;
}

/** Lookup `where` only: compare against a field of the current table, row by row (SPEC §5.8). */
export interface FieldRefValue {
  field_ref: Id<'fld'> | typeof RECORD_ID_REF;
}

export type FilterScalar = string | number | boolean | null;
export type FilterOperand = FilterScalar | VariableValue | DateValue | FieldRefValue;
export type FilterValue = FilterOperand | FilterOperand[];

export interface FilterConditionOf<V> {
  field: Id<'fld'>;
  operator: DslOperator;
  value?: V | undefined;
}

export interface FilterGroupOf<V> {
  op: 'and' | 'or';
  items: FilterNodeOf<V>[];
}

export interface FilterNotOf<V> {
  op: 'not';
  item: FilterNodeOf<V>;
}

export type FilterNodeOf<V> = FilterConditionOf<V> | FilterGroupOf<V> | FilterNotOf<V>;

/** Filter DSL as stored and exchanged (SPEC §6.1). */
export type FilterCondition = FilterConditionOf<FilterValue>;
export type FilterGroup = FilterGroupOf<FilterValue>;
export type FilterNot = FilterNotOf<FilterValue>;
export type FilterNode = FilterNodeOf<FilterValue>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function isVariableValue(value: unknown): value is VariableValue {
  return isObject(value) && '$var' in value;
}

export function isDateValue(value: unknown): value is DateValue {
  return isObject(value) && '$date' in value;
}

export function isFieldRefValue(value: unknown): value is FieldRefValue {
  return isObject(value) && 'field_ref' in value;
}

export function isFilterCondition<V>(node: FilterNodeOf<V>): node is FilterConditionOf<V> {
  return 'field' in node;
}

// ---------------------------------------------------------------------------
// zod schemas (structural: operator/value compatibility with the field type
// needs table meta and is checked by `validateFilter`).

export const filterVariableSchema = z.enum(FILTER_VARIABLES);
export const relativeDateSchema = z.enum(RELATIVE_DATES);

export const variableValueSchema = z.strictObject({ $var: filterVariableSchema });

export const exactDateSchema = z.string().refine((text) => parseExactDate(text) !== null, {
  message: 'Expected YYYY-MM-DD or YYYY-MM-DDTHH:mm',
});

export const dateSpecSchema = z.union([
  z
    .strictObject({
      relative: relativeDateSchema,
      amount: z.int().min(0).max(MAX_RELATIVE_AMOUNT).optional(),
    })
    .superRefine((spec, ctx) => {
      const needsAmount = RELATIVE_DATES_WITH_AMOUNT.has(spec.relative);
      if (needsAmount && spec.amount === undefined) {
        ctx.addIssue({ code: 'custom', path: ['amount'], message: 'amount is required' });
      }
      if (!needsAmount && spec.amount !== undefined) {
        ctx.addIssue({ code: 'custom', path: ['amount'], message: 'amount is not allowed' });
      }
    }),
  z.strictObject({ exact: exactDateSchema }),
]);

export const dateValueSchema = z.strictObject({ $date: dateSpecSchema });

export const fieldRefValueSchema = z.strictObject({
  field_ref: z.union([idOf('fld'), z.literal(RECORD_ID_REF)]),
});

export const filterScalarSchema = z.union([
  z.string().max(MAX_TEXT_VALUE_LENGTH),
  z.number(),
  z.boolean(),
  z.null(),
]);

export const filterOperandSchema = z.union([
  filterScalarSchema,
  variableValueSchema,
  dateValueSchema,
  fieldRefValueSchema,
]);

export const filterValueSchema = z.union([
  filterOperandSchema,
  z.array(filterOperandSchema).max(MAX_VALUE_ITEMS),
]);

export const filterOperatorSchema = z.enum(DSL_OPERATORS as [DslOperator, ...DslOperator[]]);

export const filterConditionSchema = z.strictObject({
  field: idOf('fld'),
  operator: filterOperatorSchema,
  value: filterValueSchema.optional(),
});

/**
 * Structural schema of a Filter DSL tree (SPEC §6.1). Depth and condition
 * limits are enforced here too so that stored filters (role configs, views)
 * can never exceed them.
 */
export const filterNodeSchema: z.ZodType<FilterNode> = z
  .lazy(() =>
    z.union([
      filterConditionSchema,
      z.strictObject({ op: z.enum(['and', 'or']), items: z.array(filterNodeSchema) }),
      z.strictObject({ op: z.literal('not'), item: filterNodeSchema }),
    ]),
  )
  .superRefine((node, ctx) => {
    const { depth, conditions } = measureFilter(node);
    if (depth > MAX_FILTER_DEPTH) {
      ctx.addIssue({
        code: 'custom',
        message: `Filter nesting exceeds ${String(MAX_FILTER_DEPTH)} levels`,
      });
    }
    if (conditions > MAX_FILTER_CONDITIONS) {
      ctx.addIssue({
        code: 'custom',
        message: `Filter has more than ${String(MAX_FILTER_CONDITIONS)} conditions`,
      });
    }
  });

// ---------------------------------------------------------------------------
// Helpers.

/** Group nesting depth (a lone condition has depth 0) and number of conditions. */
export function measureFilter<V>(node: FilterNodeOf<V>): { depth: number; conditions: number } {
  if (isFilterCondition(node)) return { depth: 0, conditions: 1 };
  const children = node.op === 'not' ? [node.item] : node.items;
  let depth = 0;
  let conditions = 0;
  for (const child of children) {
    const measured = measureFilter(child);
    depth = Math.max(depth, measured.depth);
    conditions += measured.conditions;
  }
  return { depth: depth + 1, conditions };
}

/** Calls `visit` for every condition of the tree, depth first, left to right. */
export function forEachCondition<V>(
  filter: FilterNodeOf<V> | null | undefined,
  visit: (condition: FilterConditionOf<V>) => void,
): void {
  if (filter === null || filter === undefined) return;
  if (isFilterCondition(filter)) {
    visit(filter);
  } else if (filter.op === 'not') {
    forEachCondition(filter.item, visit);
  } else {
    for (const item of filter.items) forEachCondition(item, visit);
  }
}

/** Returns the distinct field IDs referenced anywhere in `filter`, in first-seen order. */
export function collectFieldIds<V>(filter: FilterNodeOf<V> | null | undefined): Id<'fld'>[] {
  const seen = new Set<Id<'fld'>>();
  forEachCondition(filter, (condition) => seen.add(condition.field));
  return [...seen];
}

/**
 * Returns the distinct `field_ref` targets of a lookup `where`, in first-seen
 * order (for the dependency graph, SPEC §5.9).
 */
export function collectFieldRefs<V>(
  filter: FilterNodeOf<V> | null | undefined,
): FieldRefValue['field_ref'][] {
  const seen = new Set<FieldRefValue['field_ref']>();
  forEachCondition(filter, (condition) => {
    if (isFieldRefValue(condition.value)) seen.add(condition.value.field_ref);
  });
  return [...seen];
}
