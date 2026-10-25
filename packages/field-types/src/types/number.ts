import { z } from 'zod';

import {
  cast,
  describe,
  invalid,
  issue,
  OK,
  assertValid,
  plainSpaces,
} from '../internal/results.js';
import { parseLocaleNumber } from '../number-parse.js';
import { NUMBER_OPERATORS } from '../operators.js';

import type { FieldTypeDefinition } from '../core.js';

export const RATING_ICONS = [
  'star',
  'heart',
  'thumbs_up',
  'fire',
  'smile',
  'flash',
  'flower',
] as const;

const precisionSchema = z.int().min(0).max(4);

const supportedCurrencies = new Set(Intl.supportedValuesOf('currency'));

/** ISO 4217 code known to the runtime's Intl data. */
export const currencyCodeSchema = z
  .string()
  .regex(/^[A-Z]{3}$/, { message: 'Expected an ISO 4217 currency code' })
  .refine((code) => supportedCurrencies.has(code), { message: 'Unknown ISO 4217 currency code' });

const plainStyleSchema = z.strictObject({
  type: z.literal('plain'),
  precision: precisionSchema.default(0),
  percentage: z.boolean().default(false),
  thousands_separator: z.boolean().default(false),
});

const currencyStyleSchema = z.strictObject({
  type: z.literal('currency'),
  /** Defaults to the currency's ISO 4217 minor units (VND 0, USD 2). */
  precision: precisionSchema.optional(),
  currency_code: currencyCodeSchema,
});

const progressStyleSchema = z.strictObject({
  type: z.literal('progress'),
  percentage: z.boolean().default(true),
  color: z.string().min(1).max(32).optional(),
});

const ratingStyleSchema = z.strictObject({
  type: z.literal('rating'),
  icon: z.enum(RATING_ICONS).default('star'),
  min: z.union([z.literal(0), z.literal(1)]).default(1),
  max: z.int().min(1).max(10).default(5),
});

export const numberStyleSchema = z.discriminatedUnion('type', [
  plainStyleSchema,
  currencyStyleSchema,
  progressStyleSchema,
  ratingStyleSchema,
]);

export const numberOptionsSchema = z.strictObject({
  style: numberStyleSchema.default({
    type: 'plain',
    precision: 0,
    percentage: false,
    thousands_separator: false,
  }),
  default_value: z.number().nullable().optional(),
});

export type NumberStyle = z.output<typeof numberStyleSchema>;
export type NumberOptions = z.output<typeof numberOptionsSchema>;

const formatCache = new Map<string, Intl.NumberFormat>();

function numberFormat(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let format = formatCache.get(key);
  if (format === undefined) {
    format = new Intl.NumberFormat(locale, options);
    formatCache.set(key, format);
  }
  return format;
}

function formatNumber(value: number, style: NumberStyle, locale: string): string {
  switch (style.type) {
    case 'plain':
      return numberFormat(locale, {
        style: style.percentage ? 'percent' : 'decimal',
        minimumFractionDigits: style.precision,
        maximumFractionDigits: style.precision,
        useGrouping: style.thousands_separator,
      }).format(value);
    case 'currency':
      return numberFormat(locale, {
        style: 'currency',
        currency: style.currency_code,
        ...(style.precision === undefined
          ? {}
          : { minimumFractionDigits: style.precision, maximumFractionDigits: style.precision }),
      }).format(value);
    case 'progress':
      return numberFormat(locale, {
        style: style.percentage ? 'percent' : 'decimal',
        maximumFractionDigits: 2,
      }).format(value);
    case 'rating': {
      const filled = Math.min(Math.max(Math.round(value), 0), style.max);
      return '★'.repeat(filled) + '☆'.repeat(style.max - filled);
    }
  }
}

function validateNumber(value: unknown) {
  if (value === null || (typeof value === 'number' && Number.isFinite(value))) return OK;
  return invalid(
    issue('EXPECTED_NUMBER', `Expected a finite number, got ${describe(value)}`, {
      received: describe(value),
    }),
  );
}

/**
 * `number` (SPEC §5.5): PostgreSQL `numeric`. Percentages are stored as
 * fractions (20% = 0.2); `style` only changes display.
 */
export const numberFieldType: FieldTypeDefinition<
  NumberOptions,
  number | null,
  number | null,
  number | null
> = {
  type: 'number',
  readOnly: false,
  supportsDefaultValue: true,
  systemColumn: null,
  optionsSchema: numberOptionsSchema,
  pgType: () => 'numeric',
  validate: validateNumber,
  typecast(input, _options, ctx) {
    if (input === null || input === undefined) return cast(null);
    if (typeof input === 'number' && Number.isFinite(input)) return cast(input);
    if (typeof input === 'string') {
      if (input.trim() === '') return cast(null);
      const parsed = parseLocaleNumber(input, ctx.locale);
      if (parsed !== null) return cast(parsed);
    }
    return invalid(
      issue('EXPECTED_NUMBER', `Cannot read a number for locale ${ctx.locale}`, {
        locale: ctx.locale,
      }),
    );
  },
  toStorage(value) {
    assertValid(validateNumber(value));
    const number = value as number | null;
    // Normalise -0 so it never reaches storage or events.
    return number === null ? null : number + 0;
  },
  fromStorage(stored) {
    if (typeof stored === 'number') return stored;
    if (typeof stored === 'string') {
      const parsed = Number(stored);
      return stored.trim() !== '' && Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  },
  formatText(value, options, ctx) {
    return value === null ? '' : plainSpaces(formatNumber(value, options.style, ctx.locale));
  },
  filterOperators: () => NUMBER_OPERATORS,
};
