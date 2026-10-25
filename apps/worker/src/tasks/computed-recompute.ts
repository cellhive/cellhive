import { COMPUTED_RECOMPUTE_BATCH_SIZE, idOf, type Id } from '@cellhive/contracts';
import {
  COMPUTED_BATCH_LOCK_ATTEMPTS,
  computedBatchErrorCodes,
  orgScope,
  recomputeJobBatchId,
  runComputedBatch,
  type RecordMutationService,
  type SchemaService,
} from '@cellhive/server-core';
import { z } from 'zod';

import type { Task } from 'graphile-worker';
import type { Logger } from 'pino';

/** `statement_timeout` of one batch (SPEC §9.5). */
export const COMPUTED_RECOMPUTE_STATEMENT_TIMEOUT_MS = 30_000;
/** A run that wrote at least this many rows of a table runs `ANALYZE` on it (S4-review §6 #7). */
export const COMPUTED_RECOMPUTE_ANALYZE_THRESHOLD = 10_000;
/**
 * Attempts of one batch after a lock timeout, serialization failure or
 * deadlock, with an exponential backoff (T474); past them the job fails and
 * graphile-worker retries it — the records stay queued.
 */
export const COMPUTED_RECOMPUTE_BATCH_ATTEMPTS = COMPUTED_BATCH_LOCK_ATTEMPTS;

const payloadSchema = z.object({
  organization_id: idOf('org'),
  field_id: idOf('fld'),
});

/** Progress of a recompute run, for the realtime `computed.recomputing` (T459). */
export interface ComputedRecomputeProgress {
  readonly organizationId: Id<'org'>;
  readonly tableId: Id<'tbl'>;
  readonly fieldId: Id<'fld'>;
  readonly progress: number;
  readonly status: 'running' | 'succeeded' | 'failed';
}

export interface ComputedRecomputeDeps {
  readonly schema: Pick<SchemaService, 'analyzeComputedTable' | 'markComputedTimeout'>;
  readonly records: Pick<RecordMutationService, 'recomputeComputedBatch'>;
  readonly logger: Logger;
  /** Rows per batch; default 5 000 (SPEC §5.9). */
  readonly batchSize?: number;
  readonly statementTimeoutMs?: number;
  /**
   * Realtime `computed.recomputing` (CONTRACTS §7, T459): after each batch
   * (`running`, done / (done + still queued)), at the end (`succeeded`) or
   * on failure (`failed`). Default: nothing.
   */
  readonly onProgress?: (progress: ComputedRecomputeProgress) => void | Promise<void>;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Jitter of the lock backoff; default `Math.random`. */
  readonly random?: () => number;
}

/**
 * `computed.recompute` (BACKLOG T458, SPEC §5.9; CONTRACTS §12.2): enqueued
 * by `ComputedRecomputeService` in the transaction of a write that touched
 * more rows of a stored formula/lookup field than it could recompute itself
 * (`COMPUTED_SYNC_ROW_LIMIT`), or every row. Debounced per field (2 s,
 * `job_key` with `preserve_run_at`, ADR-18 §5), so a burst of writes runs
 * it once with every record they queued. Batches of 5 000 records, each its
 * own transaction through `RecordMutationService.recomputeComputedBatch`
 * (30 s statement timeout), recompute the field and the fields reading it
 * (those past the batch are queued for their own job); when nothing is
 * left the field is `ready` again. A batch that waited for another
 * transaction's locks (`lock_timeout`, deadlock) is tried again with an
 * exponential backoff, the field unchanged; still blocked after
 * `COMPUTED_RECOMPUTE_BATCH_ATTEMPTS`, the job fails and graphile-worker
 * retries it (the batch rolled back: its records are still queued). A batch
 * past its statement timeout is tried once more with half the records; a
 * second timeout in a row marks the field `error` / `TIMEOUT` and ends the
 * job (T460, T474). Tables with ≥ 10 000 rows written are `ANALYZE`d. No
 * event, audit, `__version` or `__updated_*` change (ADR-23 §2); no
 * `meta.jobs` row (the field's `compute_state` is the progress). Logs carry
 * ids, counters and error codes, never values. Values that changed become
 * `record.updated` events for automations watching them (T509): every
 * batch of the run, retries included, shares `batch.id = job_…` derived
 * from the graphile-worker job id (`recomputeJobBatchId`).
 */
export function createComputedRecomputeTask(
  deps: ComputedRecomputeDeps,
): Task<'computed.recompute'> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const batchSize = deps.batchSize ?? COMPUTED_RECOMPUTE_BATCH_SIZE;
  const statementTimeoutMs = deps.statementTimeoutMs ?? COMPUTED_RECOMPUTE_STATEMENT_TIMEOUT_MS;
  return async (payload, helpers) => {
    const parsed = payloadSchema.safeParse(payload);
    if (!parsed.success) {
      deps.logger.error(
        { job_id: helpers.job.id },
        'computed.recompute: malformed payload, skipped',
      );
      return;
    }
    const data = parsed.data;
    const scope = orgScope(data.organization_id);
    const jobId = recomputeJobBatchId(helpers.job.id);
    const context = { org_id: data.organization_id, field_id: data.field_id };
    const started = Date.now();
    const written = new Map<Id<'tbl'>, number>();
    let batches = 0;
    let rows = 0;
    let deferred = 0;
    let tableId: Id<'tbl'> | null = null;
    let last = 0;
    const progress = async (value: number, status: ComputedRecomputeProgress['status']) => {
      if (tableId === null || deps.onProgress === undefined) return;
      last = value;
      try {
        await deps.onProgress({
          organizationId: data.organization_id,
          tableId,
          fieldId: data.field_id,
          progress: Math.min(Math.max(value, 0), 1),
          status,
        });
      } catch (error) {
        deps.logger.warn({ ...context, err: error }, 'computed.recompute: progress not published');
      }
    };
    // Halved after a statement timeout, then kept for the rest of the run.
    let size = batchSize;
    for (;;) {
      let outcome;
      try {
        outcome = await runComputedBatch({
          size,
          run: (limit) =>
            deps.records.recomputeComputedBatch(scope, data.field_id, {
              statementTimeoutMs,
              batchSize: limit,
              jobId,
            }),
          sleep,
          lockAttempts: COMPUTED_RECOMPUTE_BATCH_ATTEMPTS,
          ...(deps.random === undefined ? {} : { random: deps.random }),
          onRetry: (retry) => {
            deps.logger.warn(
              {
                ...context,
                batches,
                attempt: retry.attempt,
                batch_size: retry.size,
                delay_ms: retry.delayMs,
                error_code: retry.error_code,
                sqlstate: retry.sqlstate,
              },
              retry.kind === 'lock'
                ? 'computed.recompute: batch waited for locks, retrying'
                : 'computed.recompute: batch past its statement timeout, retrying with half the rows',
            );
          },
        });
      } catch (error) {
        // The batch rolled back: its records stay queued for the retry of the job.
        deps.logger.error(
          { ...context, ...computedBatchErrorCodes(error), batches },
          'computed.recompute failed',
        );
        await progress(last, 'failed');
        throw error;
      }
      if (outcome.status === 'timeout') {
        // SPEC §9.5, T460: the field is `TIMEOUT` (cells empty, queue
        // dropped) instead of retrying a batch that cannot finish.
        await deps.schema.markComputedTimeout(scope, data.field_id);
        deps.logger.warn(
          { ...context, ...computedBatchErrorCodes(outcome.error), batches, batch_size: size },
          'computed.recompute: batch past its statement timeout twice, field marked TIMEOUT',
        );
        return;
      }
      if (outcome.status === 'locked') {
        // Nothing changed: the records stay queued and the field
        // `recomputing`; graphile-worker runs the job again later.
        deps.logger.warn(
          { ...context, ...computedBatchErrorCodes(outcome.error), batches },
          'computed.recompute: batch still waiting for locks, job retried later',
        );
        await progress(last, 'failed');
        throw outcome.error;
      }
      const batch = outcome.value;
      size = outcome.size;
      for (const item of batch.result.recomputed) {
        written.set(item.tableId, (written.get(item.tableId) ?? 0) + item.recordIds.length);
      }
      deferred += batch.result.deferred.length;
      if (batch.status === 'gone') break;
      if (batch.status === 'done') {
        tableId ??= batch.tableId;
        await progress(1, 'succeeded');
        break;
      }
      if (tableId === null) {
        tableId = batch.tableId;
        // The first batch of the run: tell clients it started.
        await progress(0, 'running');
      }
      batches += 1;
      rows += batch.rows;
      await progress(rows / Math.max(rows + batch.remaining, 1), 'running');
    }
    for (const [tableId, count] of written) {
      if (count >= COMPUTED_RECOMPUTE_ANALYZE_THRESHOLD) {
        await deps.schema.analyzeComputedTable(scope, tableId);
      }
    }
    deps.logger.info(
      {
        ...context,
        batches,
        rows,
        written: [...written.values()].reduce((sum, count) => sum + count, 0),
        deferred_fields: deferred,
        duration_ms: Date.now() - started,
      },
      'computed.recompute finished',
    );
  };
}
