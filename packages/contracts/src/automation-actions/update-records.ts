import { z } from 'zod';

import {
  automationActionIdSchema,
  automationFieldValuesSchema,
  automationFilterSchema,
} from '../automation-values.js';
import { idOf } from '../ids.js';

/** Default and greatest `limit` of `update_records` (SPEC §11.5, ADR-26 §6). */
export const DEFAULT_UPDATE_RECORDS_LIMIT = 1_000;
export const MAX_UPDATE_RECORDS_LIMIT = 10_000;

/** Records written per transaction of `update_records` (ADR-26 §6). */
export const UPDATE_RECORDS_BATCH_SIZE = 1_000;
/** Records written by one step from which the table is `ANALYZE`d (S4b-review §6 #5). */
export const UPDATE_RECORDS_ANALYZE_AFTER = 10_000;

/**
 * `update_records` (SPEC §11.5, ADR-26 §6; BACKLOG T506): bulk change by
 * filter as `run_as` — the live records of `table_id` matching `filter`
 * and both its read and edit rules. Counted first (more than `limit` →
 * step `failed` `too_many_records`, nothing written), then written in
 * `__id` order, ≤ 1 000 per transaction, `batch_id = run_…` (events of a
 * batch of 2+ are bulk, ADR-26 §2); progress is saved with each batch so a
 * retry resumes after the last committed one.
 */
export const updateRecordsActionSchema = z
  .strictObject({
    id: automationActionIdSchema,
    type: z.literal('update_records'),
    config: z.strictObject({
      table_id: idOf('tbl'),
      filter: automationFilterSchema,
      fields: automationFieldValuesSchema,
      limit: z
        .int()
        .min(1)
        .max(MAX_UPDATE_RECORDS_LIMIT)
        .default(DEFAULT_UPDATE_RECORDS_LIMIT)
        .meta({ description: 'More matching records than this → the step fails, nothing written' }),
    }),
  })
  .meta({
    id: 'UpdateRecordsAction',
    description:
      'A `filter` condition `value` may be a value of SPEC §11.4 (`{ "field" }`, ' +
      '`{ "step" }`, `{ "template" }`…), resolved when the step runs. Output: ' +
      '`{ matched, updated, batches, last_record_id, skipped_not_editable, done }` (+ ' +
      '`analyzed`, `warnings`); `skipped_not_editable` = matching records `run_as` reads ' +
      'but may not edit (left alone)',
  });
export type UpdateRecordsAction = z.infer<typeof updateRecordsActionSchema>;
