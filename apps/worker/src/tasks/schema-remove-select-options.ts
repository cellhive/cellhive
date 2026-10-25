import { idOf } from '@cellhive/contracts';
import {
  isAppError,
  orgScope,
  systemAuditContext,
  type JobsRepository,
  type RecordMutationService,
} from '@cellhive/server-core';
import { z } from 'zod';

import type { Task } from 'graphile-worker';
import type { Logger } from 'pino';

const payloadSchema = z.object({
  organization_id: idOf('org'),
  table_id: idOf('tbl'),
  field_id: idOf('fld'),
  option_ids: z.array(idOf('opt')).min(1).max(1000),
  batch_id: idOf('job'),
});

export interface SchemaRemoveSelectOptionsDeps {
  readonly records: Pick<RecordMutationService, 'removeSelectOptionValues'>;
  /** The job's `meta.jobs` row (id = `batch_id`), followed by `GET /jobs/:id`. */
  readonly jobs: Pick<JobsRepository, 'markRunning' | 'markSucceeded' | 'markFailed'>;
  readonly logger: Logger;
  /** Records per transaction; default `OPTION_REMOVAL_BATCH_SIZE` (5 000). */
  readonly batchSize?: number;
}

/**
 * `schema.remove_select_options` (T103), queue `schema:<tableId>`: enqueued
 * by `SchemaService` when select options are deleted from a field. Removing
 * their ids from records is a record write, so it goes through
 * `RecordMutationService.removeSelectOptionValues` (AGENTS.md rule 1), in
 * batches of 5 000 records per transaction. Every changed record is audited
 * with actor `system` and the payload's `batch_id` (ADR-23), which is also
 * the id of the job's `meta.jobs` row: `running` while it works,
 * `succeeded` with `{ updated }`, `failed` once the last attempt fails.
 * (Jobs queued before that row existed simply have none to update.)
 *
 * A malformed payload, a missing table or a field that is gone (or no longer
 * a select) is logged and completes the job; any other failure is thrown so
 * graphile-worker retries (the work is idempotent). Logs carry counters
 * only, never record values.
 */
export function createSchemaRemoveSelectOptionsTask(
  deps: SchemaRemoveSelectOptionsDeps,
): Task<'schema.remove_select_options'> {
  return async (payload, helpers) => {
    const parsed = payloadSchema.safeParse(payload);
    if (!parsed.success) {
      deps.logger.error(
        { job_id: helpers.job.id },
        'schema.remove_select_options: malformed payload, skipped',
      );
      return;
    }
    const {
      organization_id: orgId,
      table_id: tableId,
      field_id: fieldId,
      option_ids: optionIds,
      batch_id: batchId,
    } = parsed.data;
    const context = {
      job_id: helpers.job.id,
      org_id: orgId,
      table_id: tableId,
      field_id: fieldId,
      batch_id: batchId,
    };
    const started = Date.now();
    const scope = orgScope(orgId);
    // A retry finds its row running already.
    await deps.jobs.markRunning(scope, batchId);
    try {
      const result = await deps.records.removeSelectOptionValues(
        orgScope(orgId),
        tableId,
        fieldId,
        optionIds,
        systemAuditContext(batchId),
        deps.batchSize === undefined ? {} : { batchSize: deps.batchSize },
      );
      await deps.jobs.markSucceeded(scope, batchId, { updated: result.updated });
      if (!result.fieldFound) {
        deps.logger.warn(context, 'schema.remove_select_options: field not found, nothing to do');
        return;
      }
      deps.logger.info(
        {
          ...context,
          options: optionIds.length,
          updated: result.updated,
          duration_ms: Date.now() - started,
        },
        'select options removed from records',
      );
    } catch (error) {
      if (isAppError(error) && error.code === 'NOT_FOUND') {
        await deps.jobs.markSucceeded(scope, batchId, { updated: 0 });
        deps.logger.warn(context, 'schema.remove_select_options: table not found, nothing to do');
        return;
      }
      if (helpers.job.attempts >= helpers.job.max_attempts) {
        await deps.jobs.markFailed(scope, batchId, {
          type: 'https://cellhive.io/errors/INTERNAL',
          title: 'Internal error',
          status: 500,
          code: 'INTERNAL',
          detail: 'Removing the deleted options from records failed.',
        });
      }
      throw error;
    }
  };
}
