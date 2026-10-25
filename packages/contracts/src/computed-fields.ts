import { z } from 'zod';

import { idOf } from './ids.js';

/**
 * Computed fields — `formula` and `lookup` (SPEC §5.8, §5.9, §9; CONTRACTS
 * §13; BACKLOG T456–T460): options, the computed state of a field and the
 * preview endpoint `POST /tables/:tableId/computed-preview`. The function
 * catalogue is data of `@cellhive/formula-engine`, not a contract.
 */

/** `meta.jobs.type` of the job filling a stored computed column (CONTRACTS §12.2). */
export const COMPUTED_BACKFILL_JOB_TYPE = 'computed.backfill';
/** Rows computed per transaction by `computed.backfill` (SPEC §5.9). */
export const COMPUTED_BACKFILL_BATCH_SIZE = 5000;
/**
 * Name of the job catching up an incremental recompute that a write could
 * not do in its own transaction (SPEC §5.9, BACKLOG T458; CONTRACTS §12.2).
 * It has no `meta.jobs` row: its progress is the field's `compute_state`.
 */
export const COMPUTED_RECOMPUTE_JOB_TYPE = 'computed.recompute';
/**
 * Rows a write recomputes in its own transaction at most, all computed
 * fields together (SPEC §5.9); a field past it goes to `computed.recompute`
 * and reads `compute_state = recomputing` until the job caught up.
 */
export const COMPUTED_SYNC_ROW_LIMIT = 1000;
/** Rows `computed.recompute` computes per transaction (SPEC §5.9). */
export const COMPUTED_RECOMPUTE_BATCH_SIZE = 5000;
/** Debounce of `computed.recompute` per field (SPEC §5.9, ADR-18 §5). */
export const COMPUTED_RECOMPUTE_DEBOUNCE_MS = 2000;
/** Records a preview computes at most (SPEC §9.6: the first 5 rows). */
export const COMPUTED_PREVIEW_LIMIT = 5;
/** Default of `COMPUTED_FIELDS_MAX_PER_BASE` (SPEC §9.5, §20). */
export const DEFAULT_COMPUTED_FIELDS_MAX_PER_BASE = 200;

/** How a computed field is kept (SPEC §5.9); chosen by the server, read-only. */
export const COMPUTE_MODES = ['stored', 'virtual'] as const;
export type ComputeModeName = (typeof COMPUTE_MODES)[number];

/**
 * State of a computed field's values (CONTRACTS §13):
 * - `ready`: values are up to date;
 * - `backfilling`: a new or changed definition is being computed for every
 *   record (`computed.backfill`): a new field reads empty meanwhile, a
 *   changed one its previous values;
 * - `recomputing`: a write touched more than `COMPUTED_SYNC_ROW_LIMIT` rows
 *   (or every row: a condition without key, a schema change): the job
 *   `computed.recompute` catches up; rows not recomputed yet keep their
 *   previous values (T458, BACKLOG S4b open question #2);
 * - `error`: see `compute_error`.
 */
export const COMPUTE_STATES = ['ready', 'backfilling', 'recomputing', 'error'] as const;
export type ComputeStateName = (typeof COMPUTE_STATES)[number];

/**
 * Field-level errors (SPEC §9.4, BACKLOG T460, S4b additional decision #2):
 * - `REF` — a field or table the definition names (directly, through a
 *   link, `from`/`select`/`where` of a lookup, the table of a link it walks)
 *   is in the trash or purged, or a computed field it reads is in error
 *   (`refs` = those fields); a restore clears it;
 * - `CIRCLE` — a restore (field, table, link direction, conversion undo)
 *   closed a reference cycle: every field of the cycle, `refs` = the cycle;
 * - `INVALID_CONFIG` — everything named exists but a type conversion made
 *   the definition fail its typecheck (expression, lookup `select`/`where`);
 *   fixed by configuring the field again;
 * - `TIMEOUT` — a batch of the backfill or of the recompute exceeded its
 *   30 s `statement_timeout` (SPEC §9.5); saving the field again retries.
 *
 * Cells of a field in error read empty.
 */
export const COMPUTE_ERROR_CODES = ['REF', 'CIRCLE', 'TIMEOUT', 'INVALID_CONFIG'] as const;
export type ComputeErrorCode = (typeof COMPUTE_ERROR_CODES)[number];

/** `perf_warning` of an analysis (BACKLOG S4b open question #11). */
export const COMPUTED_PERF_WARNINGS = ['cross_table_scan'] as const;
export type ComputedPerfWarning = (typeof COMPUTED_PERF_WARNINGS)[number];

/** Kinds of a computed result (`record`: a linked record, shown as `{ id, title }`). */
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

export const computedResultTypeSchema = z
  .strictObject({
    kind: z.enum(COMPUTED_RESULT_KINDS),
    list: z.boolean().meta({ description: '`true`: a list of `kind` values' }),
  })
  .meta({
    id: 'ComputedResultType',
    description:
      'Type of the value of a computed field (SPEC §9.2): one value of `kind`, or a list of them',
  });
export type ComputedResultTypeDto = z.infer<typeof computedResultTypeSchema>;

export const computeErrorSchema = z
  .strictObject({
    code: z.enum(COMPUTE_ERROR_CODES),
    refs: z
      .array(
        z.strictObject({
          kind: z.enum(['field', 'table']),
          id: z.string().nullable(),
          name: z.string().nullable(),
        }),
      )
      .meta({
        description:
          'What the error is about (`REF`: the missing field/table, or the computed field in ' +
          'error it reads; `CIRCLE`: the fields of the cycle; `INVALID_CONFIG`: the converted ' +
          'field, when known). `id`/`name` are `null` for what the reader cannot see: a field ' +
          'or table without read access, a field in the trash without schema rights on its ' +
          'table, a table in the trash for non-admins, anything purged',
      }),
  })
  .meta({ id: 'ComputeError' });
export type ComputeErrorDto = z.infer<typeof computeErrorSchema>;

const styleSchema = z
  .record(z.string(), z.unknown())
  .nullable()
  .meta({
    description:
      'Format of the result: a `number` style (`plain`, `currency`, …) for number results, ' +
      '`{ "format" }` of `datetime` fields for dates, `null` for anything else. Omitted on ' +
      'create: the style of the field the result carries (`[Số tiền] * 0.1` keeps a currency)',
  });

/** Options of a `formula` field in requests and responses (CONTRACTS §13). */
export const formulaFieldOptionsSchema = z
  .strictObject({
    expression: z
      .string()
      .min(1)
      .meta({
        description:
          'The formula as written (SPEC §9.2): field and table **names** in `[…]`, stored with ' +
          'their IDs so renames never break it. Responses render the current names; a ' +
          'reference that no longer exists shows as `#REF[fld_…]`. Only given to readers ' +
          'with schema rights on the table who can read every table and field it references',
      }),
    style: styleSchema.optional(),
  })
  .meta({ id: 'FormulaFieldOptions' });
export type FormulaFieldOptions = z.infer<typeof formulaFieldOptionsSchema>;

/** Options of a `lookup` field (SPEC §5.8, CONTRACTS §13). */
export const lookupFieldOptionsSchema = z
  .strictObject({
    from: idOf('tbl').meta({ description: 'Source table (same base, readable by the saver)' }),
    select: idOf('fld').meta({ description: 'Field of the source table whose values are taken' }),
    where: z.record(z.string(), z.unknown()).meta({
      description:
        'Filter DSL (SPEC §6.1) on source fields, lookup mode: `intersects`/`disjoint` and ' +
        '`{ "field_ref": "<field of this table>" | "__id" }` values; at least one condition. ' +
        '`{ "field": "__id", "operator": "is_any_of" | "is_none_of", "value": { "field_ref": ' +
        '"<link field of this table to from>" } }`: the source record is (not) one of the ' +
        'records this record links to (one-way links included)',
    }),
    aggregate: z
      .enum(['raw_value', 'unique', 'sum', 'average', 'max', 'min', 'counta', 'unique_counta'])
      .optional()
      .meta({ description: 'Default `raw_value` (the list of values)' }),
    style: styleSchema.optional(),
  })
  .meta({ id: 'LookupFieldOptions' });
export type LookupFieldOptions = z.infer<typeof lookupFieldOptionsSchema>;

/** `POST /tables/:tableId/computed-preview`. */
export const computedPreviewRequestSchema = z
  .strictObject({
    type: z.enum(['formula', 'lookup']),
    options: z.record(z.string(), z.unknown()).meta({
      description: 'Options as `POST /tables/:tableId/fields` takes them (formula or lookup)',
    }),
    field_id: idOf('fld')
      .optional()
      .meta({
        description:
          'The field being edited, if any: references to itself and cycles through it are ' +
          'checked as if it had this definition',
      }),
    record_ids: z
      .array(idOf('rec'))
      .min(1)
      .max(5)
      .optional()
      .meta({
        description:
          'Records to compute (at most 5, those the caller reads); default: the first 5 ' +
          'records the caller reads',
      }),
  })
  .meta({ id: 'ComputedPreviewRequest' });
export type ComputedPreviewRequest = z.infer<typeof computedPreviewRequestSchema>;

export const computedPreviewResponseSchema = z
  .strictObject({
    result_type: computedResultTypeSchema,
    compute_mode: z.enum(COMPUTE_MODES),
    style: z.record(z.string(), z.unknown()).nullable().meta({
      description: 'The style the field would get (the one given, else the default)',
    }),
    perf_warning: z
      .enum(COMPUTED_PERF_WARNINGS)
      .nullable()
      .meta({
        description:
          '`cross_table_scan`: a `virtual` formula (volatile function) querying another table ' +
          'without a link; every read of it scans that table (BACKLOG S4b #11)',
      }),
    records: z
      .array(
        z.strictObject({
          id: idOf('rec'),
          value: z.unknown().meta({
            description:
              'Computed value (`cell_format=json`): numbers, texts, booleans, `YYYY-MM-DD` ' +
              'dates, ISO date-times, lists as arrays, records as `{ id }`; `null` when empty ' +
              'or when the row computes to an error (division by 0…)',
          }),
        }),
      )
      .meta({ description: 'The records computed, in record order' }),
  })
  .meta({ id: 'ComputedPreview' });
export type ComputedPreview = z.infer<typeof computedPreviewResponseSchema>;
