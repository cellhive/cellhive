import { FILTER_OPERATORS, type FilterOperator } from '@cellhive/field-types';

export type { FilterOperator } from '@cellhive/field-types';

/** Set operators accepted only inside a lookup `where` (SPEC §5.8, §6.2). */
export const LOOKUP_ONLY_OPERATORS = ['intersects', 'disjoint'] as const;

/** Operators accepted only inside an automation condition (SPEC §11.3). */
export const AUTOMATION_ONLY_OPERATORS = ['changed', 'changed_to', 'changed_from'] as const;

export type LookupOnlyOperator = (typeof LOOKUP_ONLY_OPERATORS)[number];
export type AutomationOnlyOperator = (typeof AUTOMATION_ONLY_OPERATORS)[number];

/** Any operator the DSL can carry; which ones a condition may use depends on field type and mode. */
export type DslOperator = FilterOperator | LookupOnlyOperator | AutomationOnlyOperator;

export const DSL_OPERATORS: readonly DslOperator[] = [
  ...FILTER_OPERATORS,
  ...LOOKUP_ONLY_OPERATORS,
  ...AUTOMATION_ONLY_OPERATORS,
];

export function isDslOperator(value: unknown): value is DslOperator {
  return typeof value === 'string' && (DSL_OPERATORS as readonly string[]).includes(value);
}

export function isLookupOnlyOperator(operator: DslOperator): operator is LookupOnlyOperator {
  return (LOOKUP_ONLY_OPERATORS as readonly string[]).includes(operator);
}

export function isAutomationOnlyOperator(
  operator: DslOperator,
): operator is AutomationOnlyOperator {
  return (AUTOMATION_ONLY_OPERATORS as readonly string[]).includes(operator);
}

/** Operators whose condition carries no `value`. */
export const NO_VALUE_OPERATORS: ReadonlySet<DslOperator> = new Set([
  'is_empty',
  'is_not_empty',
  'changed',
]);
