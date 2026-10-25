import { z } from 'zod';

import {
  automationActionIdSchema,
  automationFieldValuesSchema,
  automationFilterSchema,
  automationValueSchema,
} from '../automation-values.js';
import { idOf } from '../ids.js';

/**
 * Record actions (SPEC §11.5): `create_record`, `update_record`,
 * `delete_record`, `find_records`. Frame of BACKLOG T502 — what the saver's
 * permissions are checked against (ADR-25 §3); the run engine (T505) runs
 * them through `RecordQueryService`/`RecordMutationService` as `run_as`.
 */

/** Most records `find_records` returns (SPEC §11.5). */
export const MAX_FIND_RECORDS = 200;
export const DEFAULT_FIND_RECORDS = 50;
/** Most fields `find_records` reads and sort keys it takes. */
export const MAX_FIND_FIELDS = 100;
export const MAX_FIND_SORTS = 5;

export const createRecordActionSchema = z
  .strictObject({
    id: automationActionIdSchema,
    type: z.literal('create_record'),
    config: z.strictObject({
      table_id: idOf('tbl').meta({ description: 'A table of the same base' }),
      fields: automationFieldValuesSchema,
    }),
  })
  .meta({ id: 'CreateRecordAction', description: 'Output: `{ id }`' });

export const updateRecordActionSchema = z
  .strictObject({
    id: automationActionIdSchema,
    type: z.literal('update_record'),
    config: z.strictObject({
      table_id: idOf('tbl'),
      record_id: automationValueSchema
        .nullable()
        .default(null)
        .meta({
          description:
            'The record to change, e.g. `{ "step": "act_1", "path": "id" }`; `null` = the ' +
            'trigger record (then `table_id` is the trigger table)',
        }),
      fields: automationFieldValuesSchema,
    }),
  })
  .meta({ id: 'UpdateRecordAction' });

export const deleteRecordActionSchema = z
  .strictObject({
    id: automationActionIdSchema,
    type: z.literal('delete_record'),
    config: z.strictObject({}).default({}),
  })
  .meta({ id: 'DeleteRecordAction', description: 'Moves the trigger record to the trash' });

export const findRecordsActionSchema = z
  .strictObject({
    id: automationActionIdSchema,
    type: z.literal('find_records'),
    config: z.strictObject({
      table_id: idOf('tbl'),
      filter: automationFilterSchema.nullable().default(null),
      sort: z
        .array(
          z.strictObject({
            field: idOf('fld'),
            direction: z.enum(['asc', 'desc']).default('asc'),
          }),
        )
        .max(MAX_FIND_SORTS)
        .default([]),
      fields: z.array(idOf('fld')).max(MAX_FIND_FIELDS).default([]).meta({
        description: 'Fields to return (`[]` = the primary field only)',
      }),
      limit: z.int().min(1).max(MAX_FIND_RECORDS).default(DEFAULT_FIND_RECORDS),
    }),
  })
  .meta({ id: 'FindRecordsAction', description: 'Output: `{ records, count, truncated }`' });
