import { idOf } from '@cellhive/contracts';
import { z } from 'zod';

import { formatComputedText } from './formula.js';

/**
 * Aggregations of a lookup field (SPEC §5.8). Same list as
 * `LOOKUP_AGGREGATES` of `@cellhive/formula-engine` (its tests check it).
 */
export const LOOKUP_FIELD_AGGREGATES = [
  'raw_value',
  'unique',
  'sum',
  'average',
  'max',
  'min',
  'counta',
  'unique_counta',
] as const;
export type LookupFieldAggregate = (typeof LOOKUP_FIELD_AGGREGATES)[number];

/**
 * Options of a `lookup` field (SPEC §5.8), the four parts of Lark Base:
 * `from` (source table of the same base), `select` (its field whose values
 * are taken), `where` (Filter DSL on source fields, `field_ref` compares
 * with the current record; at least one condition — validated by the server
 * against the tables), `aggregate` (default `raw_value`), plus the `style`
 * of the result (numbers, dates).
 */
export const lookupOptionsSchema = z.strictObject({
  from: idOf('tbl'),
  select: idOf('fld'),
  where: z.record(z.string(), z.unknown()),
  aggregate: z.enum(LOOKUP_FIELD_AGGREGATES).default('raw_value'),
  style: z.record(z.string(), z.unknown()).nullable().default(null),
});
export type LookupFieldOptions = z.output<typeof lookupOptionsSchema>;

/** Pure parts of the `lookup` type (the server computes its values). */
export const lookupFieldType = {
  type: 'lookup',
  readOnly: true,
  supportsDefaultValue: false,
  optionsSchema: lookupOptionsSchema,
  formatText: formatComputedText,
} as const;
