import { FIELD_CONVERT_JOB_TYPE, idOf } from '@cellhive/contracts';
import {
  acquireOrgSlot,
  AppError,
  countRunningJobsOf,
  countsOf,
  deferrableJob,
  FieldConversionsRepository,
  isRetryableDdlError,
  orgScope,
  type ConversionCountsJson,
  type Db,
  type JobsRepository,
  type RecordMutationService,
  type SchemaService,
} from '@cellhive/server-core';
import { z } from 'zod';

import type { Task } from 'graphile-worker';
import type { Logger } from 'pino';

/** Conversions running at once per organization (ADR-18 `acquireOrgSlot`). */
export const FIELD_CONVERT_ORG_CAP = 2;
/** Attempts of one batch after a lock timeout, serialization failure or deadlock. */
export const FIELD_CONVERT_BATCH_ATTEMPTS = 3;

const payloadSchema = z.object({
  organization_id: idOf('org'),
  table_id: idOf('tbl'),
  field_id: idOf('fld'),
  job_id: idOf('job'),
});

export interface FieldConvertDeps {
  readonly db: Db;
  readonly schema: Pick<SchemaService, 'finishConversion'>;
  readonly records: Pick<RecordMutationService, 'convertFieldBatch'>;
  readonly jobs: JobsRepository;
  readonly logger: Logger;
  /** Rows per batch; default 5 000 (SPEC §5.5). */
  readonly batchSize?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

function retryable(error: unknown): boolean {
  return (
    (error instanceof AppError && error.code === 'SCHEMA_LOCKED') || isRetryableDdlError(error)
  );
}

/**
 * `field.convert` (T403, SPEC §5.5 step 2; CONTRACTS §12.2): queue
 * `schema:<tableId>`, enqueued by `PUT /fields/:id` with its `meta.jobs`
 * row. At most `FIELD_CONVERT_ORG_CAP` conversions of one organization run
 * at a time (ADR-18: others are deferred). Batches of 5 000 rows, each its
 * own transaction through `RecordMutationService.convertFieldBatch`
 * (position and counters committed with the values, `job.progress` after
 * each) fills the conversion's shadow column while the field keeps showing
 * its old values; a job found `running` (worker restarted) resumes where it
 * stopped. The end goes through `SchemaService.finishConversion` (the
 * column swap, `field.converted`, `schema.changed` `converted`; in the same
 * transaction the formula/lookup fields reading the field follow: `REF` when
 * a link's other side is deleted (ADR-28 §2), `INVALID_CONFIG` when the new
 * type breaks their typecheck, healed otherwise — T460). A batch
 * that keeps failing ends the conversion as `failed` (the shadow column is
 * dropped, the field unchanged). Logs carry ids and counters, never cell
 * values.
 */
export function createFieldConvertTask(deps: FieldConvertDeps): Task<'field.convert'> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return async (payload, helpers) => {
    const parsed = payloadSchema.safeParse(payload);
    if (!parsed.success) {
      deps.logger.error({ job_id: helpers.job.id }, 'field.convert: malformed payload, skipped');
      return;
    }
    const data = parsed.data;
    const scope = orgScope(data.organization_id);
    const context = {
      job_id: data.job_id,
      org_id: data.organization_id,
      table_id: data.table_id,
      field_id: data.field_id,
    };
    const job = await deferrableJob(helpers);
    const state = await deps.db.withTx(async (tx) => {
      const txScope = orgScope(data.organization_id, tx);
      const current = await deps.jobs.getById(txScope, data.job_id);
      if (current === undefined || !['queued', 'running'].includes(current.status)) return 'skip';
      if (current.status === 'running') return 'resume';
      const slot = await acquireOrgSlot(tx, {
        orgId: data.organization_id,
        kind: FIELD_CONVERT_JOB_TYPE,
        cap: FIELD_CONVERT_ORG_CAP,
        countRunning: countRunningJobsOf(deps.jobs, FIELD_CONVERT_JOB_TYPE),
        job,
      });
      if (!slot.acquired) return 'deferred';
      return (await deps.jobs.markRunning(txScope, data.job_id)) === undefined ? 'skip' : 'run';
    });
    if (state === 'skip' || state === 'deferred') {
      deps.logger.info({ ...context, state }, 'field.convert: not run now');
      return;
    }

    const started = Date.now();
    let counts: ConversionCountsJson | undefined;
    let batches = 0;
    for (;;) {
      let result;
      for (let attempt = 1; ; attempt += 1) {
        try {
          result = await deps.records.convertFieldBatch(scope, data.job_id, deps.batchSize);
          break;
        } catch (error) {
          if (retryable(error) && attempt < FIELD_CONVERT_BATCH_ATTEMPTS) {
            await sleep(200 * attempt);
            continue;
          }
          const conversion = await new FieldConversionsRepository(deps.db).getByJob(
            scope,
            data.job_id,
          );
          const code = error instanceof AppError ? error.code : 'INTERNAL';
          await deps.schema.finishConversion(scope, data.job_id, {
            status: 'failed',
            counts: { ...countsOf(conversion?.counts ?? {}) },
            error: { code, title: 'Field conversion failed', status: 500 },
          });
          deps.logger.error(
            { ...context, err: error, batches, duration_ms: Date.now() - started },
            'field.convert failed',
          );
          return;
        }
      }
      if (result === undefined) {
        deps.logger.info({ ...context, batches }, 'field.convert: conversion no longer running');
        return;
      }
      batches += 1;
      counts = result.counts;
      if (!result.done) continue;
      // The swap re-checks under the schema lock: rows created meanwhile
      // (default values) are converted first.
      const end = await deps.schema.finishConversion(scope, data.job_id, {
        status: 'succeeded',
        counts: { ...counts },
      });
      if (end === 'pending') continue;
      if (end === 'not_running') {
        deps.logger.info({ ...context, batches }, 'field.convert: conversion no longer running');
        return;
      }
      break;
    }
    deps.logger.info(
      {
        ...context,
        resumed: state === 'resume',
        batches,
        rows: counts.processed,
        affected: counts.affected,
        lost: counts.lost,
        truncated: counts.truncated,
        duration_ms: Date.now() - started,
      },
      'field.convert finished',
    );
  };
}
