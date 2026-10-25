import { z } from 'zod';

import { formatWallTime, parseIsoInstant } from '../internal/dates.js';
import { readOnlyWrites } from '../internal/results.js';
import { TEXT_OPERATORS } from '../operators.js';
import { toWallTime } from '../time-zone.js';

import { collateClause } from './text.js';

import type { FieldTypeDefinition } from '../core.js';

/** Date patterns for a `created_time` rule. */
export const AUTO_NUMBER_DATE_FORMATS = [
  'yyyyMMdd',
  'yyMMdd',
  'yyyyMM',
  'yyMM',
  'MMdd',
  'yyyy',
  'yy',
  'MM',
  'dd',
] as const;

export const autoNumberRuleSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), text: z.string().min(1).max(100) }),
  z.strictObject({ type: z.literal('incremental_number'), length: z.int().min(1).max(9) }),
  z.strictObject({
    type: z.literal('created_time'),
    date_format: z.enum(AUTO_NUMBER_DATE_FORMATS),
  }),
]);

export type AutoNumberRule = z.output<typeof autoNumberRuleSchema>;

/** SPEC §5.5 default: `NO.001`, `NO.002`, … */
export const DEFAULT_AUTO_NUMBER_RULES: readonly AutoNumberRule[] = [
  { type: 'text', text: 'NO.' },
  { type: 'incremental_number', length: 3 },
];

export const autoNumberOptionsSchema = z.strictObject({
  style: z
    .strictObject({ rules: z.array(autoNumberRuleSchema).min(1).max(9) })
    .default({ rules: [...DEFAULT_AUTO_NUMBER_RULES] }),
});

export type AutoNumberOptions = z.output<typeof autoNumberOptionsSchema>;

export interface AutoNumberInput {
  /** The record's `__auto` value (bigint columns arrive as strings from the driver). */
  readonly autoValue: number | bigint | string;
  readonly createdAt: Date | string | number;
  /** Zone for `created_time` rules (org zone). */
  readonly timeZone: string;
}

function sequenceText(value: number | bigint | string): string {
  const text = typeof value === 'string' ? value : String(value);
  if (!/^\d+$/.test(text)) {
    throw new TypeError('autoValue must be a non-negative integer');
  }
  return text;
}

function createdAtMs(value: Date | string | number): number {
  const epochMs =
    value instanceof Date
      ? value.getTime()
      : typeof value === 'number'
        ? value
        : parseIsoInstant(value);
  if (epochMs === null || Number.isNaN(epochMs)) {
    throw new TypeError('createdAt must be a valid instant');
  }
  return epochMs;
}

/**
 * Renders an auto number from its rules, e.g. `TK-` + `created_time(yyyyMMdd)`
 * + `-` + `incremental_number(4)` → `TK-20260920-0042`. Numbers longer than
 * `length` are printed in full, never truncated.
 */
export function formatAutoNumber(rules: readonly AutoNumberRule[], input: AutoNumberInput): string {
  const sequence = sequenceText(input.autoValue);
  const wall = toWallTime(createdAtMs(input.createdAt), input.timeZone);
  return rules
    .map((rule) => {
      switch (rule.type) {
        case 'text':
          return rule.text;
        case 'incremental_number':
          return sequence.padStart(rule.length, '0');
        case 'created_time':
          return formatWallTime(wall, rule.date_format);
      }
    })
    .join('');
}

/**
 * `auto_number` (SPEC §5.5): a `text` column holding the formatted value,
 * generated from `__auto` at insert (and recomputed by a job when rules change).
 * The column carries the base collation like `text`, so the filter compiler
 * and the trigram/unique indexes treat both alike.
 */
export const autoNumberFieldType: FieldTypeDefinition<
  AutoNumberOptions,
  never,
  never,
  string | null
> = {
  ...readOnlyWrites,
  type: 'auto_number',
  systemColumn: null,
  optionsSchema: autoNumberOptionsSchema,
  pgType: (_options, ctx) => `text ${collateClause(ctx)}`,
  fromStorage: (stored) => (typeof stored === 'string' ? stored : null),
  formatText: (value) => value ?? '',
  filterOperators: () => TEXT_OPERATORS,
};
