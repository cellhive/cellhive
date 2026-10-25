import { z } from 'zod';

import { datetimeFieldType, DATETIME_FORMATS } from './datetime.js';
import { numberFieldType, numberStyleSchema } from './number.js';

import type { LocaleContext } from '../core.js';

/**
 * Computed fields (SPEC §5.8, §5.9, §9; BACKLOG T456): `formula` and
 * `lookup`. Their values are computed by the server (SQL compiler of
 * `@cellhive/server-core`, from the AST of `@cellhive/formula-engine`),
 * never written by clients; this module holds the pure parts shared by the
 * server and the web app: option schemas, the public result type and the
 * `style` of the result with its `cell_format=text` rendering.
 */

/** Scalar kinds of a computed result as the API shows them (`record`: a linked record). */
export const COMPUTED_RESULT_KINDS = [
  'text',
  'number',
  'boolean',
  'date',
  'datetime',
  'user',
  'attachment',
  'record',
  'null',
] as const;
export type ComputedResultKind = (typeof COMPUTED_RESULT_KINDS)[number];

/**
 * Type of a computed field's value (`result_type` of the field API): one
 * value of `kind`, or a list of them. A formula never results in a table or
 * a list of lists (typecheck, SPEC §9.2).
 */
export interface ComputedResultType {
  readonly kind: ComputedResultKind;
  readonly list: boolean;
}

/** Longest stored expression: the display form is ≤ 4 000 characters, IDs are longer than names. */
export const MAX_STORED_EXPRESSION_LENGTH = 32_000;

/** `style` of a date/datetime result: the formats of `datetime` fields (SPEC §5.5). */
export const computedDateStyleSchema = z.strictObject({
  format: z.enum(DATETIME_FORMATS),
});

/**
 * `style` of a computed result (SPEC §9.2): number styles for number
 * results, datetime formats for dates; any other result has none (`null`).
 * Checked against the result type by {@link parseComputedStyle}.
 */
const styleInputSchema = z.record(z.string(), z.unknown()).nullable().default(null);

/**
 * Options of a `formula` field as stored (`meta.fields.options`):
 * `expression` in the **stored form** (`[fld_…]`/`[tbl_…]`, SPEC §9.2) and
 * the `style` of the result. The API takes and returns the display form
 * (names); the server converts.
 */
export const formulaOptionsSchema = z.strictObject({
  expression: z.string().min(1).max(MAX_STORED_EXPRESSION_LENGTH),
  style: styleInputSchema,
});
export type FormulaOptions = z.output<typeof formulaOptionsSchema>;

export type ComputedStyle =
  z.output<typeof numberStyleSchema> | z.output<typeof computedDateStyleSchema>;

export type ComputedStyleResult =
  | { readonly ok: true; readonly style: ComputedStyle | null }
  | { readonly ok: false; readonly message: string };

/**
 * The `style` of a result of `type`, validated: a number style for numbers
 * (or lists of them), a datetime format for dates, `null` for everything
 * else (a style there is refused).
 */
export function parseComputedStyle(style: unknown, type: ComputedResultType): ComputedStyleResult {
  if (style === null || style === undefined) return { ok: true, style: null };
  switch (type.kind) {
    case 'number': {
      const parsed = numberStyleSchema.safeParse(style);
      return parsed.success
        ? { ok: true, style: parsed.data }
        : { ok: false, message: parsed.error.issues[0]?.message ?? 'Invalid number style' };
    }
    case 'date':
    case 'datetime': {
      const parsed = computedDateStyleSchema.safeParse(style);
      return parsed.success
        ? { ok: true, style: parsed.data }
        : { ok: false, message: parsed.error.issues[0]?.message ?? 'Invalid date format' };
    }
    default:
      return { ok: false, message: `A ${type.kind} result has no style` };
  }
}

function numberText(value: unknown, style: ComputedStyle | null, ctx: LocaleContext): string {
  const number =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(number)) return '';
  const parsed = numberStyleSchema.safeParse(style ?? { type: 'plain', precision: 0 });
  if (!parsed.success) return String(number);
  if (style === null) {
    // No style: the value as computed (no rounding to the plain style's 0 digits).
    return new Intl.NumberFormat(ctx.locale, {
      maximumFractionDigits: 20,
      useGrouping: false,
    }).format(number);
  }
  return numberFieldType.formatText(number, { style: parsed.data }, ctx);
}

function dateText(
  value: unknown,
  kind: 'date' | 'datetime',
  style: ComputedStyle | null,
  ctx: LocaleContext,
): string {
  if (typeof value !== 'string' || value === '') return '';
  const format =
    style !== null && 'format' in style
      ? style.format
      : kind === 'date'
        ? 'yyyy-MM-dd'
        : 'yyyy-MM-dd HH:mm';
  // A datetime style on a date result (or the reverse) keeps the value's own precision.
  const dateOnlyFormat = !format.includes('HH');
  const effective =
    kind === 'date' && !dateOnlyFormat
      ? (format.replace(' HH:mm', '') as (typeof DATETIME_FORMATS)[number])
      : kind === 'datetime' && dateOnlyFormat
        ? (`${format} HH:mm` as (typeof DATETIME_FORMATS)[number])
        : format;
  return datetimeFieldType.formatText(value, { style: { format: effective } }, ctx);
}

function scalarText(
  value: unknown,
  kind: ComputedResultKind,
  style: ComputedStyle | null,
  ctx: LocaleContext,
): string {
  if (value === null || value === undefined) return '';
  switch (kind) {
    case 'number':
      return numberText(value, style, ctx);
    case 'date':
    case 'datetime':
      return dateText(value, kind, style, ctx);
    case 'boolean':
      return value === true ? 'TRUE' : value === false ? 'FALSE' : '';
    case 'record':
    case 'attachment':
    case 'user': {
      if (typeof value === 'string') return value;
      if (typeof value === 'object' && !Array.isArray(value)) {
        const record = value as Record<string, unknown>;
        const label = record['title'] ?? record['name'] ?? record['display_name'] ?? record['id'];
        return typeof label === 'string' ? label : '';
      }
      return '';
    }
    default:
      return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  }
}

/**
 * `cell_format=text` of a computed value (CONTRACTS §2): numbers and dates
 * through the result `style` (a `sum` lookup with a VND currency style reads
 * `1.500.000 ₫` in `vi`), lists joined with `, `.
 */
export function formatComputedText(
  value: unknown,
  type: ComputedResultType,
  style: ComputedStyle | null,
  ctx: LocaleContext,
): string {
  if (type.list) {
    if (!Array.isArray(value)) return '';
    return value
      .map((item) => scalarText(item, type.kind, style, ctx))
      .filter((text) => text !== '')
      .join(', ');
  }
  return scalarText(value, type.kind, style, ctx);
}

/** Pure parts of the `formula` type (the server computes its values). */
export const formulaFieldType = {
  type: 'formula',
  readOnly: true,
  supportsDefaultValue: false,
  optionsSchema: formulaOptionsSchema,
  formatText: formatComputedText,
} as const;
