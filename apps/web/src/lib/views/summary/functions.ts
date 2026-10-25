import {
  CHECKBOX_SUMMARY_FUNCTIONS,
  DATE_SUMMARY_FUNCTIONS,
  NUMBER_SUMMARY_FUNCTIONS,
  PERCENT_SUMMARY_FUNCTIONS,
  summaryFunctionsOf,
  summaryKindOf,
  type FieldDto,
  type SummaryFunction,
  type SummaryKind,
} from '@cellhive/contracts';

/**
 * The functions of the summary bar a column offers (T472, CONTRACTS §15):
 * by field type, formula/lookup by their result type — the same table as
 * the server (`summaryFunctionsOf` of the contracts).
 */

/** Groups of the menu (board "S4b · Thanh thống kê"): Count, Percent, then the type's own. */
export type SummaryMenuGroupKey = 'count' | 'percent' | 'number' | 'date' | 'checkbox';

export interface SummaryMenuGroup {
  readonly key: SummaryMenuGroupKey;
  readonly functions: readonly SummaryFunction[];
}

export function summaryKindOfField(field: Pick<FieldDto, 'type' | 'result_type'>): SummaryKind {
  return summaryKindOf(field.type, field.result_type ?? null);
}

export function summaryFunctionsOfField(
  field: Pick<FieldDto, 'type' | 'result_type'>,
): readonly SummaryFunction[] {
  return summaryFunctionsOf(field.type, field.result_type ?? null);
}

/**
 * Whether the reader may summarise the field: a formula/lookup locked for
 * them (T457) has no value to summarise, and the server leaves it out.
 */
export function canSummarize(field: Pick<FieldDto, 'locked'>): boolean {
  return field.locked !== true;
}

const COUNTS: readonly SummaryFunction[] = ['count_all', 'filled', 'empty', 'unique'];

/** The menu of a column: its functions in groups, empty groups left out. */
export function summaryMenuGroups(
  field: Pick<FieldDto, 'type' | 'result_type'>,
): SummaryMenuGroup[] {
  const allowed = new Set(summaryFunctionsOfField(field));
  const groups: SummaryMenuGroup[] = [
    { key: 'count', functions: COUNTS },
    { key: 'percent', functions: PERCENT_SUMMARY_FUNCTIONS },
    { key: 'number', functions: NUMBER_SUMMARY_FUNCTIONS },
    { key: 'date', functions: DATE_SUMMARY_FUNCTIONS },
    { key: 'checkbox', functions: CHECKBOX_SUMMARY_FUNCTIONS },
  ];
  return groups
    .map((group) => ({ ...group, functions: group.functions.filter((fn) => allowed.has(fn)) }))
    .filter((group) => group.functions.length > 0);
}

/**
 * The saved or temporary summaries that still apply: fields shown, readable,
 * not locked, with a function their type takes (a type change makes an
 * entry stale; it is skipped, never an error).
 */
export function applicableSummaries(
  config: Readonly<Record<string, SummaryFunction>> | undefined,
  fields: readonly FieldDto[],
): Record<string, SummaryFunction> {
  const byId = new Map(fields.map((field) => [field.id as string, field]));
  const out: Record<string, SummaryFunction> = {};
  for (const [id, fn] of Object.entries(config ?? {})) {
    const field = byId.get(id);
    if (field === undefined || !canSummarize(field)) continue;
    if (!summaryFunctionsOfField(field).includes(fn)) continue;
    out[id] = fn;
  }
  return out;
}

/** Numbers are right-aligned like number cells (board). */
export function alignsRight(field: Pick<FieldDto, 'type' | 'result_type'>): boolean {
  return summaryKindOfField(field) === 'number';
}
