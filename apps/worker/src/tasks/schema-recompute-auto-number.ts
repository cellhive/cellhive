import { idOf, type Id } from '@cellhive/contracts';
import { isAppError, orgScope, type RecordMutationService } from '@cellhive/server-core';
import { z } from 'zod';

import type { Task } from 'graphile-worker';
import type { Logger } from 'pino';

const payloadSchema = z.object({
  organization_id: idOf('org'),
  table_id: idOf('tbl'),
  field_id: idOf('fld'),
});

export interface SchemaRecomputeAutoNumberDeps {
  readonly records: Pick<RecordMutationService, 'recomputeAutoNumber'>;
  readonly logger: Logger;
  /** Rows per transaction; default `AUTO_NUMBER_BATCH_SIZE` (5 000). */
  readonly batchSize?: number;
  /**
   * Called once numbers changed (T459): when the field is the table's
   * primary field, link cells of other tables show new titles
   * (`publishLinkTitlesChanged`). Default: nothing.
   */
  readonly onRenumbered?: (
    organizationId: Id<'org'>,
    tableId: Id<'tbl'>,
    fieldId: Id<'fld'>,
  ) => Promise<void>;
}

/**
 * `schema.recompute_auto_number` (SPEC §5.5), queue `schema:<tableId>`:
 * enqueued by `SchemaService` when an `auto_number` field is added or its
 * rules change. Renumbering is a record write, so it goes through
 * `RecordMutationService.recomputeAutoNumber` (AGENTS.md rule 1), in batches
 * of 5 000 rows per transaction.
 *
 * A malformed payload, a missing table or a field that is gone (or no longer
 * an `auto_number`) is logged and completes the job; any other failure is
 * thrown so graphile-worker retries (the work is idempotent). Logs carry
 * counters only, never record values.
 */
export function createSchemaRecomputeAutoNumberTask(
  deps: SchemaRecomputeAutoNumberDeps,
): Task<'schema.recompute_auto_number'> {
  return async (payload, helpers) => {
    const parsed = payloadSchema.safeParse(payload);
    if (!parsed.success) {
      deps.logger.error(
        { job_id: helpers.job.id },
        'schema.recompute_auto_number: malformed payload, skipped',
      );
      return;
    }
    const { organization_id: orgId, table_id: tableId, field_id: fieldId } = parsed.data;
    const context = { job_id: helpers.job.id, org_id: orgId, table_id: tableId, field_id: fieldId };
    const started = Date.now();
    try {
      const result = await deps.records.recomputeAutoNumber(
        orgScope(orgId),
        tableId,
        fieldId,
        deps.batchSize === undefined ? {} : { batchSize: deps.batchSize },
      );
      if (!result.fieldFound) {
        deps.logger.warn(context, 'schema.recompute_auto_number: field not found, nothing to do');
        return;
      }
      if (result.updated > 0) await deps.onRenumbered?.(orgId, tableId, fieldId);
      deps.logger.info(
        {
          ...context,
          rows: result.rows,
          updated: result.updated,
          duration_ms: Date.now() - started,
        },
        'auto numbers recomputed',
      );
    } catch (error) {
      if (isAppError(error) && error.code === 'NOT_FOUND') {
        deps.logger.warn(context, 'schema.recompute_auto_number: table not found, nothing to do');
        return;
      }
      throw error;
    }
  };
}
