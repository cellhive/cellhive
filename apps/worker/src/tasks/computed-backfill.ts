import {
  COMPUTED_BACKFILL_BATCH_SIZE,
  COMPUTED_BACKFILL_JOB_TYPE,
  idOf,
  type Id,
} from '@cellhive/contracts';
import {
  acquireOrgSlot,
  AppError,
  COMPUTED_BATCH_LOCK_ATTEMPTS,
  computedBatchErrorCodes,
  computedFingerprint,
  countRunningJobsOf,
  deferrableJob,
  dependentsInOrder,
  FieldDependenciesRepository,
  FieldsRepository,
  isComputedRow,
  loadBaseSchemaRows,
  orgScope,
  runComputedBatch,
  TablesRepository,
  type Db,
  type JobsRepository,
  type RecordMutationService,
  type SchemaService,
} from '@cellhive/server-core';
import { z } from 'zod';

import type { Task } from 'graphile-worker';
import type { Logger } from 'pino';

/** Backfills running at once per organization (ADR-18 `acquireOrgSlot`). */
export const COMPUTED_BACKFILL_ORG_CAP = 2;
/** `statement_timeout` of one batch (SPEC §9.5): past it twice in a row the field is `TIMEOUT`. */
export const COMPUTED_BACKFILL_STATEMENT_TIMEOUT_MS = 30_000;
/** A job that wrote at least this many rows of a table runs `ANALYZE` on it. */
export const COMPUTED_ANALYZE_THRESHOLD = 10_000;
/**
 * Attempts of one batch after a lock timeout, serialization failure or
 * deadlock, with an exponential backoff (T474); past them the job fails and
 * graphile-worker retries it from the same batch.
 */
export const COMPUTED_BACKFILL_BATCH_ATTEMPTS = COMPUTED_BATCH_LOCK_ATTEMPTS;

const payloadSchema = z.object({
  organization_id: idOf('org'),
  table_id: idOf('tbl'),
  field_id: idOf('fld'),
  job_id: idOf('job'),
  fingerprint: z.string().min(1),
});

/** Progress of a backfill, for the realtime `computed.recomputing` of T459. */
export interface ComputedBackfillProgress {
  readonly organizationId: Id<'org'>;
  readonly tableId: Id<'tbl'>;
  readonly fieldId: Id<'fld'>;
  readonly jobId: Id<'job'>;
  readonly progress: number;
  readonly status: 'running' | 'succeeded' | 'failed';
}

export interface ComputedBackfillDeps {
  readonly db: Db;
  readonly schema: Pick<SchemaService, 'finishComputedBackfill' | 'analyzeComputedTable'>;
  readonly records: Pick<RecordMutationService, 'backfillComputedBatch'>;
  readonly jobs: JobsRepository;
  readonly logger: Logger;
  /** Rows per batch; default 5 000 (SPEC §5.9). */
  readonly batchSize?: number;
  readonly statementTimeoutMs?: number;
  /**
   * Hook for the realtime `computed.recomputing` message (CONTRACTS §7),
   * wired by T459; default: nothing. Called at the start, after each batch
   * and at the end.
   */
  readonly onProgress?: (progress: ComputedBackfillProgress) => void | Promise<void>;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Jitter of the lock backoff; default `Math.random`. */
  readonly random?: () => number;
}

/**
 * Where a run stopped (T474): a job that failed before its last attempt is
 * retried by graphile-worker (`meta.jobs` stays `running`) and goes on from
 * the field and batch it was on — committed batches are not redone. Kept by
 * the worker process: a retry in another process starts again from the
 * first field (writing the same values).
 */
interface BackfillCheckpoint {
  readonly fingerprint: string;
  readonly order: readonly string[];
  index: number;
  cursor: bigint;
  total: number;
  done: number;
  /** Rows per batch: halved after a statement timeout, for the rest of the field. */
  size: number;
  batches: number;
  timeouts: number;
  readonly written: Map<Id<'tbl'>, number>;
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * `computed.backfill` (BACKLOG T456, SPEC §5.9; CONTRACTS §12.2): queue
 * `schema:<tableId>`, enqueued with its `meta.jobs` row when a stored
 * formula/lookup field is created or its definition changes. At most
 * `COMPUTED_BACKFILL_ORG_CAP` backfills of one organization run at a time
 * (ADR-18). It computes the field, then every stored computed field reading
 * it (directly or not, in topological order — T456 graph), in batches of
 * 5 000 rows, each its own transaction through
 * `RecordMutationService.backfillComputedBatch` with a 30 s statement
 * timeout (T474):
 * - a batch that waited for another transaction's locks (`lock_timeout`,
 *   deadlock) is tried again with an exponential backoff, nothing else
 *   changing; still blocked after `COMPUTED_BACKFILL_BATCH_ATTEMPTS`, the
 *   job fails and graphile-worker retries it from that batch (only its last
 *   attempt marks `meta.jobs` `failed`);
 * - a batch past its statement timeout is tried once more with half the
 *   rows; a second timeout in a row marks that field `error` / `TIMEOUT`
 *   (SPEC §9.5) and the job goes on with the next.
 *
 * Each field ends `ready` (`SchemaService.finishComputedBackfill`,
 * `schema.changed`); a table with ≥ 10 000 rows written is `ANALYZE`d. A
 * newer definition of the field (another fingerprint) stops the job: the
 * newer job computes it. Logs carry ids, counters and error codes, never
 * values.
 */
export function createComputedBackfillTask(deps: ComputedBackfillDeps): Task<'computed.backfill'> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const batchSize = deps.batchSize ?? COMPUTED_BACKFILL_BATCH_SIZE;
  const statementTimeoutMs = deps.statementTimeoutMs ?? COMPUTED_BACKFILL_STATEMENT_TIMEOUT_MS;
  const checkpoints = new Map<string, BackfillCheckpoint>();
  return async (payload, helpers) => {
    const parsed = payloadSchema.safeParse(payload);
    if (!parsed.success) {
      deps.logger.error(
        { job_id: helpers.job.id },
        'computed.backfill: malformed payload, skipped',
      );
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
        kind: COMPUTED_BACKFILL_JOB_TYPE,
        cap: COMPUTED_BACKFILL_ORG_CAP,
        countRunning: countRunningJobsOf(deps.jobs, COMPUTED_BACKFILL_JOB_TYPE),
        job,
      });
      if (!slot.acquired) return 'deferred';
      return (await deps.jobs.markRunning(txScope, data.job_id)) === undefined ? 'skip' : 'run';
    });
    if (state === 'skip' || state === 'deferred') {
      checkpoints.delete(data.job_id);
      deps.logger.info({ ...context, state }, 'computed.backfill: not run now');
      return;
    }

    const progress = async (value: number, status: ComputedBackfillProgress['status']) => {
      await deps.onProgress?.({
        organizationId: data.organization_id,
        tableId: data.table_id,
        fieldId: data.field_id,
        jobId: data.job_id,
        progress: Math.min(Math.max(value, 0), 1),
        status,
      });
    };

    // The fields to compute: this one, then the stored fields reading it.
    const start = await new FieldsRepository(deps.db).getById(scope, data.field_id);
    if (start === undefined || computedFingerprint(start) !== data.fingerprint) {
      checkpoints.delete(data.job_id);
      await deps.jobs.markCancelled(scope, data.job_id);
      deps.logger.info(context, 'computed.backfill: superseded before it started');
      return;
    }
    const table = await new TablesRepository(deps.db).getById(scope, start.table_id);
    if (table === undefined) {
      checkpoints.delete(data.job_id);
      await deps.jobs.markCancelled(scope, data.job_id);
      return;
    }
    const rows = await loadBaseSchemaRows(deps.db, scope, table.base_id);
    const edges = await new FieldDependenciesRepository(deps.db).listByBase(scope, table.base_id);
    const active = new Set<string>(rows.fields.filter(isComputedRow).map((row) => row.id));
    const stored = new Set<string>(
      rows.fields
        .filter((row) => isComputedRow(row) && row.compute_mode === 'stored')
        .map((row) => row.id),
    );
    const order = dependentsInOrder(start.id, edges, active).filter((id) => stored.has(id));

    const started = Date.now();
    const previous = state === 'resume' ? checkpoints.get(data.job_id) : undefined;
    const checkpoint: BackfillCheckpoint =
      previous?.fingerprint === data.fingerprint && sameOrder(previous.order, order)
        ? previous
        : {
            fingerprint: data.fingerprint,
            order,
            index: 0,
            cursor: 0n,
            total: 0,
            done: 0,
            size: batchSize,
            batches: 0,
            timeouts: 0,
            written: new Map(),
          };
    checkpoints.set(data.job_id, checkpoint);
    const { written } = checkpoint;
    const resumedFrom = checkpoint === previous ? checkpoint.index : null;
    const current = () =>
      order.length === 0
        ? 0
        : (checkpoint.index +
            (checkpoint.total === 0 ? 0 : Math.min(checkpoint.done / checkpoint.total, 1))) /
          order.length;
    await progress(Math.min(current(), 0.99), 'running');

    /** A failed run: its last attempt ends the job `failed`; earlier ones leave it to graphile's retry. */
    const fail = async (error: unknown, fieldId: string): Promise<never> => {
      const final = !(helpers.job.attempts < helpers.job.max_attempts);
      if (final) {
        checkpoints.delete(data.job_id);
        await deps.jobs.markFailed(scope, data.job_id, {
          code: error instanceof AppError ? error.code : 'INTERNAL',
          title: 'Computed field backfill failed',
          status: 500,
        });
      }
      await progress(Math.min(current(), 0.99), 'failed');
      deps.logger.error(
        {
          ...context,
          ...computedBatchErrorCodes(error),
          current_field_id: fieldId,
          batches: checkpoint.batches,
          attempt: helpers.job.attempts,
          retried: !final,
        },
        'computed.backfill failed',
      );
      throw error;
    };

    for (; checkpoint.index < order.length; checkpoint.index += 1) {
      const index = checkpoint.index;
      const fieldId = order[index] as Id<'fld'>;
      let outcome: 'ready' | 'timeout' | 'skipped' | 'superseded' = 'ready';
      for (;;) {
        let ran;
        try {
          ran = await runComputedBatch({
            size: checkpoint.size,
            run: (limit) =>
              deps.records.backfillComputedBatch(scope, {
                fieldId,
                afterAuto: checkpoint.cursor,
                limit,
                statementTimeoutMs,
                expected: { fieldId: data.field_id, fingerprint: data.fingerprint },
              }),
            sleep,
            lockAttempts: COMPUTED_BACKFILL_BATCH_ATTEMPTS,
            ...(deps.random === undefined ? {} : { random: deps.random }),
            onRetry: (retry) => {
              deps.logger.warn(
                {
                  ...context,
                  current_field_id: fieldId,
                  batches: checkpoint.batches,
                  attempt: retry.attempt,
                  batch_size: retry.size,
                  delay_ms: retry.delayMs,
                  error_code: retry.error_code,
                  sqlstate: retry.sqlstate,
                },
                retry.kind === 'lock'
                  ? 'computed.backfill: batch waited for locks, retrying'
                  : 'computed.backfill: batch past its statement timeout, retrying with half the rows',
              );
            },
          });
        } catch (error) {
          return fail(error, fieldId);
        }
        if (ran.status === 'locked') return fail(ran.error, fieldId);
        if (ran.status === 'timeout') {
          outcome = 'timeout';
          deps.logger.warn(
            {
              ...context,
              ...computedBatchErrorCodes(ran.error),
              current_field_id: fieldId,
              batches: checkpoint.batches,
            },
            'computed.backfill: batch past its statement timeout twice, field marked TIMEOUT',
          );
          break;
        }
        const result = ran.value;
        checkpoint.size = ran.size;
        if (result.status === 'superseded' || result.status === 'skipped') {
          outcome = result.status;
          break;
        }
        checkpoint.batches += 1;
        if (result.total !== undefined) checkpoint.total = result.total;
        checkpoint.done += result.rows;
        checkpoint.cursor = result.cursor;
        written.set(result.tableId, (written.get(result.tableId) ?? 0) + result.rows);
        const value = Math.min(current(), 0.99);
        await deps.jobs.setProgress(scope, data.job_id, value);
        await progress(value, 'running');
        if (result.status === 'done') break;
      }
      if (outcome === 'superseded') {
        checkpoints.delete(data.job_id);
        await deps.jobs.markCancelled(scope, data.job_id);
        deps.logger.info(
          { ...context, batches: checkpoint.batches },
          'computed.backfill: superseded by a newer job',
        );
        return;
      }
      if (outcome === 'timeout') {
        checkpoint.timeouts += 1;
        await deps.schema.finishComputedBackfill(scope, fieldId, {
          status: 'error',
          code: 'TIMEOUT',
        });
      } else if (outcome === 'ready') {
        await deps.schema.finishComputedBackfill(scope, fieldId, { status: 'ready' });
      }
      // The next field starts from its first row, with full batches.
      checkpoint.cursor = 0n;
      checkpoint.total = 0;
      checkpoint.done = 0;
      checkpoint.size = batchSize;
    }
    checkpoints.delete(data.job_id);
    const { batches, timeouts } = checkpoint;
    for (const [tableId, count] of written) {
      if (count >= COMPUTED_ANALYZE_THRESHOLD)
        await deps.schema.analyzeComputedTable(scope, tableId);
    }
    await deps.jobs.markSucceeded(scope, data.job_id, {
      fields: order.length,
      rows: [...written.values()].reduce((sum, count) => sum + count, 0),
      timeouts,
    });
    await progress(1, 'succeeded');
    deps.logger.info(
      {
        ...context,
        resumed: state === 'resume',
        resumed_from_field: resumedFrom,
        fields: order.length,
        batches,
        timeouts,
        duration_ms: Date.now() - started,
      },
      'computed.backfill finished',
    );
  };
}
