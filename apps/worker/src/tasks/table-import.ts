import {
  IMPORT_JOB_TYPE,
  idOf,
  importNewColumnSchema,
  importMappingItemSchema,
} from '@cellhive/contracts';
import {
  abandonTableImport,
  acquireOrgSlot,
  countRunningJobsOf,
  deferrableJob,
  orgScope,
  runTableImport,
  settleCancelledImport,
  type Db,
  type JobsRepository,
  type TableImportDeps,
  type TableImportPayload,
} from '@cellhive/server-core';
import { z } from 'zod';

import type { Task } from 'graphile-worker';
import type { Logger } from 'pino';

/** Imports running at once per organization (ADR-18 `acquireOrgSlot`). */
export const TABLE_IMPORT_ORG_CAP = 1;

const payloadSchema = z.object({
  organization_id: idOf('org'),
  job_id: idOf('job'),
  import_id: idOf('imp'),
  base_id: idOf('bse'),
  user_id: idOf('usr'),
  api_token_id: idOf('tok').optional(),
  spec: z.discriminatedUnion('mode', [
    z.object({
      mode: z.literal('create_table'),
      table: z.object({ name: z.string().min(1), columns: z.array(importNewColumnSchema).min(1) }),
    }),
    z.object({
      mode: z.literal('append'),
      table_id: idOf('tbl'),
      mapping: z.array(importMappingItemSchema).min(1),
    }),
  ]),
});

export interface TableImportTaskDeps extends Omit<TableImportDeps, 'db' | 'jobs'> {
  readonly db: Db;
  readonly jobs: JobsRepository;
  readonly logger: Logger;
}

/**
 * `table.import` (CONTRACTS §12.2, §19): enqueued by `POST /bases/:id/imports`
 * together with its `meta.jobs` row. One import per organization runs at a
 * time; others are deferred (ADR-18), so a large import of one organization
 * never holds the workers of another. The work itself is
 * `runTableImport` (server-core).
 *
 * A malformed payload or a job that is gone or already final completes
 * without work. A job found `running` was interrupted (worker stopped): it
 * is failed instead of run twice. A job found `cancelled` after it had
 * started was cancelled while the worker that ran it stopped: it is settled
 * as its run would have (table to the trash, `import.finished`, T548).
 * Failures are recorded on the job, never retried by graphile-worker. Logs
 * carry ids and counters, never cell values.
 */
export function createTableImportTask(deps: TableImportTaskDeps): Task<'table.import'> {
  return async (payload, helpers) => {
    const parsed = payloadSchema.safeParse(payload);
    if (!parsed.success) {
      deps.logger.error({ job_id: helpers.job.id }, 'table.import: malformed payload, skipped');
      return;
    }
    const data = parsed.data as TableImportPayload;
    const context = {
      job_id: helpers.job.id,
      org_id: data.organization_id,
      import_job_id: data.job_id,
      mode: data.spec.mode,
    };
    const job = await deferrableJob(helpers);

    const state = await deps.db.withTx(async (tx) => {
      const txScope = orgScope(data.organization_id, tx);
      const current = await deps.jobs.getById(txScope, data.job_id);
      if (current?.status === 'cancelled' && current.started_at !== null) return 'cancelled';
      if (current === undefined || !['queued', 'running'].includes(current.status)) return 'skip';
      if (current.status === 'running') return 'interrupted';
      const slot = await acquireOrgSlot(tx, {
        orgId: data.organization_id,
        kind: IMPORT_JOB_TYPE,
        cap: TABLE_IMPORT_ORG_CAP,
        countRunning: countRunningJobsOf(deps.jobs, IMPORT_JOB_TYPE),
        job,
      });
      if (!slot.acquired) return 'deferred';
      return (await deps.jobs.markRunning(txScope, data.job_id)) === undefined ? 'skip' : 'run';
    });
    if (state === 'interrupted') {
      const { tableTrashed } = await abandonTableImport(deps, data);
      deps.logger.warn({ ...context, table_trashed: tableTrashed }, 'table.import interrupted');
      return;
    }
    if (state === 'cancelled') {
      const { settled, tableTrashed } = await settleCancelledImport(deps, data);
      deps.logger.info(
        { ...context, settled, table_trashed: tableTrashed },
        'table.import: cancelled while it ran, settled',
      );
      return;
    }
    if (state !== 'run') {
      deps.logger.info({ ...context, state }, 'table.import: not run now');
      return;
    }

    const started = Date.now();
    const outcome = await runTableImport(deps, data);
    const log = {
      ...context,
      status: outcome.status,
      rows: outcome.rows,
      imported: outcome.imported,
      failed: outcome.failed,
      batches: outcome.batches,
      duration_ms: Date.now() - started,
      ...(outcome.code === undefined ? {} : { code: outcome.code }),
      ...(outcome.tableTrashed === undefined ? {} : { table_trashed: outcome.tableTrashed }),
    };
    if (outcome.cause !== undefined) {
      deps.logger.error({ ...log, err: outcome.cause }, 'table.import failed');
    } else {
      deps.logger.info(log, 'table.import finished');
    }
  };
}
