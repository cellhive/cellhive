import { FIELD_TYPE_REGISTRY } from '../registry.js';
import { computedDateStyleSchema, formatComputedText } from '../types/formula.js';
import { numberStyleSchema } from '../types/number.js';

import {
  planFieldConversion,
  convertCell,
  type CellConversion,
  type ConversionContext,
  type FieldConversionPlan,
} from './value.js';

import type { ConversionSettings, FieldDefinitionRef } from './classify.js';
import type { S1FieldType } from '../core.js';
import type { ComputedResultType, ComputedStyle } from '../types/formula.js';

/**
 * "Convert to static values" (CONTRACTS §4.1, BACKLOG T463): a formula or
 * lookup field becomes a type that stores its own values. The current value
 * of each cell (`cell_format=json` of the computed field: numbers, texts,
 * booleans, `YYYY-MM-DD` dates, ISO date-times, users, records
 * `{ id, title }`, attachments; a list is an array) converts **as if the
 * field were of its result type**: the pure functions here pick that type
 * (the "source type") and hand the value to `convertCell` like any other
 * conversion, so previews and the job decide the same way.
 */

/** A formula/lookup field as a conversion source: its result type and `style`. */
export interface ComputedSource {
  readonly result: ComputedResultType;
  readonly style: ComputedStyle | null;
}

/** Type whose rules apply to one element of a result (`record`/`attachment` read as text). */
function elementType(kind: ComputedResultType['kind']): S1FieldType {
  switch (kind) {
    case 'number':
      return 'number';
    case 'boolean':
      return 'checkbox';
    case 'date':
    case 'datetime':
      return 'datetime';
    case 'user':
      return 'user';
    default:
      return 'text';
  }
}

/**
 * The source type of a computed field for a target (CONTRACTS §4.1): a
 * `text` or `select` target reads the display text of the value (lists
 * joined with `, `, records by title, numbers and dates with the result's
 * style, like `cell_format=text`); any other target reads the result as its
 * own type (`boolean` → `checkbox`, `date`/`datetime` → `datetime`,
 * `record`/`attachment` → `text`).
 */
export function computedSourceType(source: ComputedSource, target: string): S1FieldType {
  if (target === 'text' || target === 'select') return 'text';
  return elementType(source.result.kind);
}

/** The source definition (its options carry the result's number style or date format). */
export function computedSourceDefinition(
  source: ComputedSource,
  target: string,
): FieldDefinitionRef {
  const type = computedSourceType(source, target);
  let options: unknown = {};
  if (type === 'number') {
    const style = numberStyleSchema.safeParse(source.style);
    options = style.success ? { style: style.data } : {};
  } else if (type === 'datetime') {
    const style = computedDateStyleSchema.safeParse(source.style);
    options = {
      style: style.success
        ? style.data
        : { format: source.result.kind === 'date' ? 'yyyy-MM-dd' : 'yyyy-MM-dd HH:mm' },
    };
  } else if (type === 'user') {
    options = { multiple: true };
  }
  return { type, options: FIELD_TYPE_REGISTRY[type].optionsSchema.parse(options) };
}

/**
 * The plan of a computed → stored conversion: the kind of the source type
 * to the target (CONTRACTS §4.1–§4.3), never `none` (values always change
 * hands: the column now holds them).
 */
export function planComputedConversion(
  source: ComputedSource,
  to: FieldDefinitionRef,
  settings: ConversionSettings = {},
): FieldConversionPlan {
  const plan = planFieldConversion(computedSourceDefinition(source, to.type), to, settings);
  return plan.kind === 'none' ? { ...plan, kind: 'keep' } : plan;
}

const EMPTY: CellConversion = { outcome: 'empty' };

/**
 * The value `convertCell` reads for a computed cell: the display text for a
 * `text` source; a whole list of users; the first element of any other
 * list (`cut` when there were more — counted as `truncated`).
 */
function sourceValueOf(
  plan: FieldConversionPlan,
  source: ComputedSource,
  value: unknown,
  ctx: ConversionContext,
): { readonly value: unknown; readonly cut: boolean } {
  if (value === null || value === undefined) return { value: null, cut: false };
  if (plan.from.type === 'text') {
    const text = formatComputedText(value, source.result, source.style, ctx);
    return { value: text === '' ? null : text, cut: false };
  }
  if (plan.from.type === 'user') {
    return { value: Array.isArray(value) ? value : [value], cut: false };
  }
  if (!Array.isArray(value)) return { value, cut: false };
  const items = value as unknown[];
  return { value: items.length === 0 ? null : items[0], cut: items.length > 1 };
}

/**
 * Converts one computed cell (its `cell_format=json` value) with a plan of
 * {@link planComputedConversion}. Same source and target type keeps the
 * value (a number stays the number, `true` stays checked, `false` is an
 * empty checkbox); everything else goes through `convertCell`.
 */
export function convertComputedCell(
  plan: FieldConversionPlan,
  source: ComputedSource,
  value: unknown,
  ctx: ConversionContext,
): CellConversion {
  const read = sourceValueOf(plan, source, value, ctx);
  if (read.value === null || read.value === undefined) return EMPTY;
  let result: CellConversion;
  if (plan.kind !== 'blacklist' && plan.from.type === 'number' && plan.to.type === 'number') {
    const number = typeof read.value === 'number' ? read.value : Number(read.value);
    result = Number.isFinite(number) ? { outcome: 'kept', value: number } : { outcome: 'lost' };
  } else if (
    plan.kind !== 'blacklist' &&
    plan.from.type === 'checkbox' &&
    plan.to.type === 'checkbox'
  ) {
    result = read.value === true ? { outcome: 'kept', value: true } : EMPTY;
  } else {
    result = convertCell(plan, read.value, ctx);
  }
  return read.cut && result.outcome === 'kept'
    ? { outcome: 'truncated', value: result.value }
    : result;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Options of the target of "convert to static values" with the result's
 * format carried over when the request gives no `style` (a currency formula
 * becomes a currency number; a date result a datetime with its format).
 */
export function inheritComputedStyle(
  source: ComputedSource,
  target: string,
  requested: unknown,
): Record<string, unknown> {
  const options: Record<string, unknown> = isRecord(requested) ? { ...requested } : {};
  if (Object.hasOwn(options, 'style')) return options;
  const from = computedSourceDefinition(source, target);
  if (from.type !== target || (target !== 'number' && target !== 'datetime')) return options;
  const style = (from.options as { readonly style?: unknown }).style;
  return style === undefined ? options : { ...options, style };
}
