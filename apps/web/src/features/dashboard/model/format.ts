import type { MetricAggregation } from '@cellhive/contracts';

/**
 * Number formatting of dashboard values (T811, SPEC §10.2): the widget's own
 * `display.number_format` when set, else the field's number style (the same
 * `Intl.NumberFormat` options as the grid's `number` cells: plain with
 * precision/percentage/thousands, currency), else a plain number. Counts are
 * whole numbers. Pure, so the chart option and the data table read alike.
 */

/** `display.number_format` of a widget (CONTRACTS §28.2). */
export interface WidgetNumberFormat {
  readonly style?: 'number' | 'currency' | 'percent' | undefined;
  readonly currency?: string | null | undefined;
  readonly decimals?: number | null | undefined;
  readonly compact?: boolean | undefined;
}

/** The parts of a number field's `options.style` used here (field-types `NumberStyle`). */
export type FieldNumberStyle =
  | {
      readonly type: 'plain';
      readonly precision?: number;
      readonly percentage?: boolean;
      readonly thousands_separator?: boolean;
    }
  | { readonly type: 'currency'; readonly precision?: number; readonly currency_code: string }
  | { readonly type: 'progress'; readonly percentage?: boolean }
  | { readonly type: 'rating' };

export type NumberFormatter = (value: number) => string;

const cache = new Map<string, Intl.NumberFormat>();

function numberFormat(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let format = cache.get(key);
  if (format === undefined) {
    try {
      format = new Intl.NumberFormat(locale, options);
    } catch {
      // An unknown currency code saved by an older client: plain digits.
      format = new Intl.NumberFormat(locale);
    }
    cache.set(key, format);
  }
  return format;
}

/** Reads a field's number style from untyped `options` (`null` when it has none). */
export function fieldNumberStyle(options: unknown): FieldNumberStyle | null {
  if (typeof options !== 'object' || options === null) return null;
  const style = (options as { style?: unknown }).style;
  if (typeof style !== 'object' || style === null) return null;
  const type = (style as { type?: unknown }).type;
  if (type === 'plain' || type === 'currency' || type === 'progress' || type === 'rating') {
    return style as FieldNumberStyle;
  }
  return null;
}

function fromWidget(format: WidgetNumberFormat): Intl.NumberFormatOptions {
  const options: Intl.NumberFormatOptions = {};
  if (format.style === 'currency' && typeof format.currency === 'string') {
    options.style = 'currency';
    options.currency = format.currency;
  } else if (format.style === 'percent') {
    options.style = 'percent';
  }
  if (typeof format.decimals === 'number') {
    options.minimumFractionDigits = format.decimals;
    options.maximumFractionDigits = format.decimals;
  }
  if (format.compact === true) options.notation = 'compact';
  return options;
}

function fromField(
  style: FieldNumberStyle,
  aggregation: MetricAggregation | null,
): Intl.NumberFormatOptions {
  // An average has decimals even over whole numbers.
  const extra = aggregation === 'avg' ? 2 : 0;
  switch (style.type) {
    case 'plain': {
      const precision = Math.max(style.precision ?? 0, extra);
      return {
        style: style.percentage === true ? 'percent' : 'decimal',
        minimumFractionDigits: style.precision ?? 0,
        maximumFractionDigits: precision,
        // Totals are read from afar: digit groups always (the grid follows the field).
        useGrouping: true,
      };
    }
    case 'currency':
      return {
        style: 'currency',
        currency: style.currency_code,
        ...(style.precision === undefined
          ? {}
          : {
              minimumFractionDigits: style.precision,
              maximumFractionDigits: Math.max(style.precision, extra),
            }),
      };
    case 'progress':
      return {
        style: style.percentage === false ? 'decimal' : 'percent',
        maximumFractionDigits: 2,
      };
    case 'rating':
      return { maximumFractionDigits: 2 };
  }
}

/**
 * The formatter of one metric: widget format > field style (not for counts)
 * > plain number (whole for counts, ≤ 2 decimals else).
 */
export function metricFormatter(
  locale: string,
  widget: WidgetNumberFormat | null | undefined,
  field: FieldNumberStyle | null,
  aggregation: MetricAggregation | null,
): NumberFormatter {
  let options: Intl.NumberFormatOptions;
  if (widget !== null && widget !== undefined) options = fromWidget(widget);
  else if (aggregation === 'count' || aggregation === 'count_distinct') {
    options = { maximumFractionDigits: 0 };
  } else if (field !== null) options = fromField(field, aggregation);
  else options = { maximumFractionDigits: 2 };
  const format = numberFormat(locale, options);
  return (value) => format.format(value);
}

/** Percentages of a 100 % stacked chart (0–100, one decimal at most). */
export function percentFormatter(locale: string): NumberFormatter {
  const format = numberFormat(locale, { style: 'percent', maximumFractionDigits: 1 });
  return (value) => format.format(value / 100);
}

/** A signed relative change (`0.125` → "+12.5%"); used by the KPI comparison. */
export function changeFormatter(locale: string): NumberFormatter {
  const format = numberFormat(locale, {
    style: 'percent',
    maximumFractionDigits: 1,
    signDisplay: 'exceptZero',
  });
  return (value) => format.format(value);
}
