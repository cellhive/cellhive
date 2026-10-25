import { idOf } from '@cellhive/contracts';
import { isAppError, orgScope, type SchemaService } from '@cellhive/server-core';
import { z } from 'zod';

import type { Task } from 'graphile-worker';
import type { Logger } from 'pino';

const payloadSchema = z.object({
  organization_id: idOf('org'),
  table_id: idOf('tbl'),
});

export interface SchemaCompactTableDeps {
  readonly schema: Pick<SchemaService, 'compactTable'>;
  readonly logger: Logger;
}

/**
 * `schema.compact_table` (ADR-20), queue `schema:<tableId>`: enqueued by
 * `SchemaService` when a table reaches 1 400 column slots. The work — one
 * transaction that rebuilds the table under the same name — lives in
 * `SchemaService.compactTable`, the only place allowed to run DDL.
 *
 * A malformed payload or a table that no longer exists is logged and
 * completes the job; any other failure is thrown so graphile-worker retries
 * (compaction is idempotent: the table is only swapped on commit).
 */
export function createSchemaCompactTableTask(
  deps: SchemaCompactTableDeps,
): Task<'schema.compact_table'> {
  return async (payload, helpers) => {
    const parsed = payloadSchema.safeParse(payload);
    if (!parsed.success) {
      deps.logger.error(
        { job_id: helpers.job.id },
        'schema.compact_table: malformed payload, skipped',
      );
      return;
    }
    const { organization_id: orgId, table_id: tableId } = parsed.data;
    const started = Date.now();
    try {
      const result = await deps.schema.compactTable(orgScope(orgId), tableId);
      deps.logger.info(
        {
          job_id: helpers.job.id,
          org_id: orgId,
          table_id: tableId,
          slots_before: result.slotsBefore,
          slots_after: result.slotsAfter,
          rows: result.rows,
          purged_fields: result.purgedFieldIds.length,
          kept_deleted_fields: result.keptDeletedFieldIds.length,
          junction_foreign_keys: result.junctionForeignKeys.length,
          duration_ms: Date.now() - started,
        },
        'table compacted',
      );
      if (result.stillOverBudget) {
        deps.logger.warn(
          {
            job_id: helpers.job.id,
            org_id: orgId,
            table_id: tableId,
            slots_after: result.slotsAfter,
            kept_deleted_fields: result.keptDeletedFieldIds.length,
          },
          'table still over the column budget after compaction: restorable deleted fields keep their columns for 30 days',
        );
      }
    } catch (error) {
      if (isAppError(error) && error.code === 'NOT_FOUND') {
        deps.logger.warn(
          { job_id: helpers.job.id, org_id: orgId, table_id: tableId },
          'schema.compact_table: table not found, nothing to compact',
        );
        return;
      }
      throw error;
    }
  };
}
