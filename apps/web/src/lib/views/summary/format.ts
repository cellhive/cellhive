import {
  FIELD_TYPE_REGISTRY,
  formatComputedText,
  isImplementedFieldType,
  numberFieldType,
  numberOptionsSchema,
  type ComputedStyle,
  type LocaleContext,
  type NumberStyle,
} from '@cellhive/field-types';

import { summaryKindOfField } from './functions';

import type { FieldDto, RecordSummaryDto, SummaryFunction } from '@cellhive/contracts';

/**
 * Text of a summary of the bar (board "S4b · Thanh thống kê", "Cách đọc
 * số"): values formatted like the field's cells (currency, date format…),
 * a sum or an average of ratings as a plain number, percentages rounded
 * with the count behind them ("46 (96%)"), ranges "min → max" and date
 * ranges with their days. Pure: the texts come in `labels`.
 */
export interface SummaryTexts {
  /** Short label shown before the value ("Tổng"). */
  readonly label: (fn: SummaryFunction) => string;
  /** "(1,041 days)". */
  readonly days: (days: number) => string;
}

export interface FormattedSummary {
  readonly label: string;
  /** `null`: no cell has a value ("—"). */
  readonly value: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function styleOf(field: FieldDto): unknown {
  return isRecord(field.options) ? field.options['style'] : undefined;
}

/** A sum or an average of ratings is a number, not stars. */
function plainRating(style: NumberStyle, fn: SummaryFunction): NumberStyle {
  if (style.type !== 'rating') return style;
  return {
    type: 'plain',
    precision: fn === 'avg' ? 2 : 0,
    percentage: false,
    thousands_separator: true,
  };
}

function numberText(
  field: FieldDto,
  value: number,
  fn: SummaryFunction,
  locale: LocaleContext,
): string {
  if (field.type === 'number') {
    const parsed = numberOptionsSchema.safeParse(field.options);
    const style: NumberStyle = parsed.success
      ? parsed.data.style
      : { type: 'plain', precision: 0, percentage: false, thousands_separator: true };
    return numberFieldType.formatText(value, { style: plainRating(style, fn) }, locale);
  }
  const style = styleOf(field);
  const computedStyle =
    isRecord(style) && style['type'] === 'rating'
      ? plainRating(style as NumberStyle, fn)
      : ((style ?? null) as ComputedStyle | null);
  if (computedStyle === null) {
    return new Intl.NumberFormat(locale.locale, { maximumFractionDigits: 2 }).format(value);
  }
  return formatComputedText(value, { kind: 'number', list: false }, computedStyle, locale);
}

function dateText(field: FieldDto, value: unknown, locale: LocaleContext): string {
  if (field.type === 'formula' || field.type === 'lookup') {
    const type = field.result_type ?? { kind: 'datetime', list: false };
    return formatComputedText(
      value,
      type,
      (styleOf(field) ?? null) as ComputedStyle | null,
      locale,
    );
  }
  if (!isImplementedFieldType(field.type)) return String(value);
  const definition = FIELD_TYPE_REGISTRY[field.type] as {
    optionsSchema: { safeParse: (value: unknown) => { success: boolean; data?: unknown } };
    formatText: (value: unknown, options: unknown, ctx: LocaleContext) => string;
  };
  const options = definition.optionsSchema.safeParse(field.options);
  try {
    return definition.formatText(value, options.success ? options.data : {}, locale);
  } catch {
    return String(value);
  }
}

/** A value of `min`/`max`/`sum`… in the field's own format. */
function valueText(
  field: FieldDto,
  value: unknown,
  fn: SummaryFunction,
  locale: LocaleContext,
): string {
  if (typeof value === 'number') return numberText(field, value, fn, locale);
  if (summaryKindOfField(field) === 'date') return dateText(field, value, locale);
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function formatSummary(
  field: FieldDto,
  summary: RecordSummaryDto,
  locale: LocaleContext,
  texts: SummaryTexts,
): FormattedSummary {
  const { fn, value } = summary;
  const label = texts.label(fn);
  const integer = new Intl.NumberFormat(locale.locale, { maximumFractionDigits: 0 });
  switch (fn) {
    case 'count_all':
    case 'filled':
    case 'empty':
    case 'unique':
    case 'checked':
    case 'unchecked':
      return { label, value: integer.format(typeof value === 'number' ? value : 0) };
    case 'percent_filled':
    case 'percent_empty':
    case 'percent_checked': {
      const count = integer.format(summary.count ?? 0);
      if (typeof value !== 'number') return { label, value: count };
      const percent = new Intl.NumberFormat(locale.locale, {
        style: 'percent',
        maximumFractionDigits: 0,
      }).format(value);
      return { label, value: `${count} (${percent})` };
    }
    case 'range':
    case 'date_range': {
      if (!isRecord(value)) return { label, value: null };
      const range = `${valueText(field, value['min'], fn, locale)} → ${valueText(field, value['max'], fn, locale)}`;
      const days = value['days'];
      return {
        label,
        value:
          fn === 'date_range' && typeof days === 'number' ? `${range} ${texts.days(days)}` : range,
      };
    }
    default:
      return {
        label,
        value: value === null || value === undefined ? null : valueText(field, value, fn, locale),
      };
  }
}

/**
 * The record count of the row-number gutter, shortened (board: 1,234 →
 * "1.2k", 203,000 → "203k"); the full count is in its tooltip.
 */
export function shortCount(count: number, locale: string): string {
  const format = (value: number, digits: number) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value);
  if (count < 1000) return format(count, 0);
  if (count < 1_000_000) {
    const thousands = count / 1000;
    return `${format(Math.floor(thousands * (thousands < 100 ? 10 : 1)) / (thousands < 100 ? 10 : 1), 1)}k`;
  }
  const millions = count / 1_000_000;
  return `${format(Math.floor(millions * (millions < 100 ? 10 : 1)) / (millions < 100 ? 10 : 1), 1)}M`;
}
