/**
 * Filter operators per field group (SPEC §6.2). `packages/filter-dsl`
 * validates conditions against the list a field type returns.
 */
export const TEXT_OPERATORS = [
  'eq',
  'neq',
  'contains',
  'not_contains',
  'starts_with',
  'ends_with',
  'is_empty',
  'is_not_empty',
] as const;

export const NUMBER_OPERATORS = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'is_empty',
  'is_not_empty',
] as const;

export const DATETIME_OPERATORS = [
  'is',
  'before',
  'after',
  'on_or_before',
  'on_or_after',
  'between',
  'is_empty',
  'is_not_empty',
] as const;

export const CHECKBOX_OPERATORS = ['is'] as const;

export const SINGLE_SELECT_OPERATORS = [
  'is',
  'is_not',
  'is_any_of',
  'is_none_of',
  'is_empty',
  'is_not_empty',
] as const;

/** Multi select, user, created_by, updated_by (and in S4 link, list lookups). */
export const MULTI_VALUE_OPERATORS = [
  'has_any_of',
  'has_all_of',
  'has_none_of',
  'is_exactly',
  'is_empty',
  'is_not_empty',
] as const;

/** Every operator a field type may return (automation-only operators are not included). */
export const FILTER_OPERATORS = [
  ...new Set([
    ...TEXT_OPERATORS,
    ...NUMBER_OPERATORS,
    ...DATETIME_OPERATORS,
    ...CHECKBOX_OPERATORS,
    ...SINGLE_SELECT_OPERATORS,
    ...MULTI_VALUE_OPERATORS,
  ]),
] as readonly FilterOperator[];

export type FilterOperator =
  | (typeof TEXT_OPERATORS)[number]
  | (typeof NUMBER_OPERATORS)[number]
  | (typeof DATETIME_OPERATORS)[number]
  | (typeof CHECKBOX_OPERATORS)[number]
  | (typeof SINGLE_SELECT_OPERATORS)[number]
  | (typeof MULTI_VALUE_OPERATORS)[number];
