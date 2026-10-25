import { sql } from 'kysely';

import type { TaskName, TaskPayload } from './tasks.js';
import type { Tx } from '../db/create-db.js';
import type { Id } from '@cellhive/contracts';

/**
 * Named queues run their jobs one at a time. ADR-18 allows them only for
 * work that must be serial with a low cardinality: `schema:<tableId>`.
 * Never a queue per organization.
 */
export type QueueName = `schema:${Id<'tbl'>}`;

const QUEUE_NAME_PATTERN = /^schema:tbl_[0-9A-Za-z]{16}$/;
const TASK_NAME_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
/** graphile-worker stores `max_attempts` and `priority` as `smallint`. */
const SMALLINT_MAX = 32_767;

export interface EnqueueOptions {
  /** When the job becomes runnable; default: now. */
  readonly runAt?: Date;
  /** Retry budget, 1…32767 (graphile-worker default: 25). */
  readonly maxAttempts?: number;
  /** Lower runs first, -32768…32767 (default 0). */
  readonly priority?: number;
  /**
   * Deduplication key. `replace` (default) updates a pending job with the
   * same key; `preserve_run_at` keeps its `run_at` (debounce, ADR-18 §5).
   */
  readonly jobKey?: string;
  readonly jobKeyMode?: 'replace' | 'preserve_run_at';
  readonly queueName?: QueueName;
  readonly flags?: readonly string[];
}

export interface EnqueuedJob {
  /** graphile-worker job id (`bigint` as text). */
  readonly id: string;
  readonly runAt: Date;
}

function assertSmallint(name: string, value: number, min: number): void {
  if (!Number.isInteger(value) || value < min || value > SMALLINT_MAX) {
    throw new RangeError(
      `enqueue: ${name} must be an integer between ${String(min)} and ${String(SMALLINT_MAX)}`,
    );
  }
}

/**
 * Rejects options that would break ADR-18 or graphile-worker's column types.
 * Invalid options are programming errors, hence `TypeError`/`RangeError`.
 */
export function validateEnqueueOptions(task: string, options: EnqueueOptions): void {
  if (!TASK_NAME_PATTERN.test(task)) {
    throw new TypeError(
      `enqueue: '${task}' is not a valid task name (expected e.g. events.dispatch)`,
    );
  }
  if (options.queueName !== undefined && !QUEUE_NAME_PATTERN.test(options.queueName)) {
    throw new TypeError(
      'enqueue: named queues are only allowed as schema:<tableId> (ADR-18); never per organization',
    );
  }
  if (options.maxAttempts !== undefined) assertSmallint('maxAttempts', options.maxAttempts, 1);
  if (options.priority !== undefined) assertSmallint('priority', options.priority, -32_768);
  if (
    options.jobKey !== undefined &&
    (options.jobKey.length === 0 || options.jobKey.length > 512)
  ) {
    throw new RangeError('enqueue: jobKey must be 1…512 characters');
  }
  if (options.jobKeyMode !== undefined && options.jobKey === undefined) {
    throw new TypeError('enqueue: jobKeyMode requires jobKey');
  }
  if (options.runAt !== undefined && Number.isNaN(options.runAt.getTime())) {
    throw new TypeError('enqueue: runAt is an invalid date');
  }
}

/** Where `run_at` comes from: an absolute time or a delay after `now()`. */
export type RunAtSpec = { readonly at: Date } | { readonly delayMs: number };

export interface AddJobSpec {
  readonly task: string;
  readonly payload: unknown;
  readonly runAt?: RunAtSpec;
  readonly maxAttempts?: number;
  readonly priority?: number;
  readonly jobKey?: string;
  readonly jobKeyMode?: 'replace' | 'preserve_run_at';
  readonly queueName?: string | null;
  readonly flags?: readonly string[] | null;
}

/**
 * Calls `graphile_worker.add_job(...)` on `tx`. Every value is a bound
 * parameter. Internal: callers use `enqueue` (typed task registry) or
 * `acquireOrgSlot` (re-enqueues the running job as it is).
 */
export async function addJob(tx: Tx, spec: AddJobSpec): Promise<EnqueuedJob> {
  const runAt =
    spec.runAt === undefined
      ? sql`NULL::timestamptz`
      : 'at' in spec.runAt
        ? sql`${spec.runAt.at.toISOString()}::timestamptz`
        : sql`now() + make_interval(secs => ${spec.runAt.delayMs / 1000})`;
  const { rows } = await sql<{ id: string; run_at: Date }>`
    SELECT j.id::text AS id, j.run_at
      FROM graphile_worker.add_job(
        identifier => ${spec.task}::text,
        payload => ${JSON.stringify(spec.payload ?? {})}::json,
        queue_name => ${spec.queueName ?? null}::text,
        run_at => ${runAt},
        max_attempts => ${spec.maxAttempts ?? null}::int,
        job_key => ${spec.jobKey ?? null}::text,
        priority => ${spec.priority ?? null}::int,
        flags => ${spec.flags === undefined || spec.flags === null ? null : [...spec.flags]}::text[],
        job_key_mode => ${spec.jobKeyMode ?? 'replace'}::text
      ) AS j
  `.execute(tx);
  const row = rows[0];
  if (row === undefined) throw new Error('graphile_worker.add_job returned no row');
  return { id: row.id, runAt: row.run_at };
}

/**
 * Adds a job in the caller's transaction (ADR-06): the job exists if and only
 * if the transaction commits, so there is no dual write. The worker is
 * notified on commit.
 *
 * Do not pass an organization as `queueName` (ADR-18): tenant fairness is
 * `acquireOrgSlot`'s job.
 */
export async function enqueue<T extends TaskName>(
  tx: Tx,
  task: T,
  payload: TaskPayload<T>,
  options: EnqueueOptions = {},
): Promise<EnqueuedJob> {
  validateEnqueueOptions(task, options);
  return addJob(tx, {
    task,
    payload,
    ...(options.runAt === undefined ? {} : { runAt: { at: options.runAt } }),
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    ...(options.priority === undefined ? {} : { priority: options.priority }),
    ...(options.jobKey === undefined ? {} : { jobKey: options.jobKey }),
    ...(options.jobKeyMode === undefined ? {} : { jobKeyMode: options.jobKeyMode }),
    ...(options.queueName === undefined ? {} : { queueName: options.queueName }),
    ...(options.flags === undefined ? {} : { flags: options.flags }),
  });
}
