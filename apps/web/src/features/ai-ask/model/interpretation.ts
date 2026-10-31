import type { AiAskInterpretation } from '@cellhive/contracts';

/** `t` of the `aiAsk` namespace (a fake in tests). */
export type Translate = (key: string, params?: Record<string, unknown>) => string;

export interface InterpretationChip {
  readonly id: string;
  readonly kind: 'metric' | 'dimension' | 'series' | 'compare' | 'logic' | 'filter';
  readonly text: string;
}

const RELATIVE: Readonly<Record<string, string>> = {
  Today: 'values.today',
  Yesterday: 'values.yesterday',
  Tomorrow: 'values.tomorrow',
  CurrentUser: 'values.me',
};
const EXACT_DATE = /^ExactDate\((\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?\)$/u;

/** A planned filter value in words: option names, numbers, dates (CONTRACTS §3 tuples). */
export function filterValueText(value: unknown, t: Translate, locale: string): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    return value.map((item) => filterValueText(item, t, locale)).join(', ');
  }
  if (typeof value === 'boolean') return t(value ? 'values.checked' : 'values.unchecked');
  if (typeof value === 'number') return new Intl.NumberFormat(locale).format(value);
  if (typeof value === 'string') {
    const relative = RELATIVE[value];
    if (relative !== undefined) return t(relative);
    const exact = EXACT_DATE.exec(value);
    if (exact !== null) {
      const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(
        new Date(`${exact[1] ?? ''}T00:00:00Z`),
      );
      return exact[2] === undefined ? date : `${date} ${exact[2]}`;
    }
    return value;
  }
  const name = (value as { name?: unknown }).name;
  return typeof name === 'string' ? name : '';
}

/** The words of a filter's operator: lists read "is any of", text "contains". */
function operatorKey(operator: string, value: unknown): string {
  if (operator === 'intersects' || operator === 'disjoint') {
    return `operators.${operator}${Array.isArray(value) ? 'List' : 'Text'}`;
  }
  return `operators.${operator}`;
}

/**
 * The "Interpretation" row of an answer (T914, research S8 §5.5): what the
 * numbers are — the metric, the grouping (with its date bucket), the split,
 * the comparison, the filters — from `interpretation`, which the server
 * builds from the plan, never from the model's words (CONTRACTS §29.4).
 * Enums are translated; names are the user's field names as they are.
 */
export function interpretationChips(
  interpretation: AiAskInterpretation,
  t: Translate,
  locale: string,
): InterpretationChip[] {
  const chips: InterpretationChip[] = [
    {
      id: 'metric',
      kind: 'metric',
      text: t(`metrics.${interpretation.metric}`, { field: interpretation.field?.name ?? '' }),
    },
  ];
  const grouping = (
    kind: 'dimension' | 'series',
    field: { name: string } | null,
    bucket: string | null,
  ) => {
    if (field === null) return;
    chips.push({
      id: kind,
      kind,
      text:
        bucket === null
          ? t(`${kind}.plain`, { field: field.name })
          : t(`${kind}.bucket`, { field: field.name, bucket: t(`buckets.${bucket}`) }),
    });
  };
  grouping('dimension', interpretation.dimension, interpretation.bucket);
  grouping('series', interpretation.series, interpretation.series_bucket);
  if (interpretation.compare !== null) {
    chips.push({
      id: 'compare',
      kind: 'compare',
      text: t(`compare.${interpretation.compare}`),
    });
  }
  if (interpretation.filter_logic === 'or' && interpretation.filters.length > 1) {
    chips.push({ id: 'logic', kind: 'logic', text: t('anyOf') });
  }
  interpretation.filters.forEach((filter, index) => {
    const value = filterValueText(filter.value, t, locale);
    chips.push({
      id: `filter-${String(index)}`,
      kind: 'filter',
      text: t(operatorKey(filter.operator, filter.value), {
        field: filter.field.name,
        value,
      }).trim(),
    });
  });
  return chips;
}
