import { idOf, type Id } from '@cellhive/contracts';
import { sql } from 'kysely';

import { addJob, type EnqueuedJob } from './enqueue.js';

import type { Tx } from '../db/create-db.js';
import type { Job, JobHelpers } from 'graphile-worker';

/** Base delay before a deferred job runs again (ADR-18: `now() + 5s + jitter`). */
export const ORG_SLOT_DEFER_BASE_MS = 5_000;
/** Upper bound of the random jitter added to the base delay. */
export const ORG_SLOT_DEFER_JITTER_MS = 2_000;

const KIND_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
const organizationIdSchema = idOf('org');

/** The parts of the running graphile-worker job needed to re-enqueue it unchanged. */
export interface DeferrableJob {
  readonly task_identifier: string;
  readonly payload: unknown;
  readonly priority: number;
  /** Attempts so far, including the one in progress (graphile-worker semantics). */
  readonly attempts: number;
  readonly max_attempts: number;
  readonly key: string | null;
  readonly flags: Readonly<Record<string, true>> | null;
  readonly queue_name: string | null;
}

/** Builds a `DeferrableJob` from the helpers graphile-worker passes to a task. */
export async function deferrableJob(
  helpers: Pick<JobHelpers, 'job' | 'getQueueName'>,
): Promise<DeferrableJob> {
  const job: Job = helpers.job;
  return {
    task_identifier: job.task_identifier,
    payload: job.payload,
    priority: job.priority,
    attempts: job.attempts,
    max_attempts: job.max_attempts,
    key: job.key,
    flags: job.flags,
    queue_name: job.job_queue_id === null ? null : await helpers.getQueueName(),
  };
}

export interface AcquireOrgSlotOptions {
  readonly orgId: Id<'org'>;
  /**
   * What is being limited, e.g. `automation-org` or `base.export`. The lock
   * key is `hashtext(kind || ':' || org_id)` (ADR-18).
   */
  readonly kind: string;
  /** Maximum number of runs of this kind running at once for the organization. */
  readonly cap: number;
  /**
   * Counts the runs of this kind currently running for the organization, in
   * `tx` (e.g. `meta.jobs` or `automation_runs` with `status = 'running'`).
   */
  readonly countRunning: (tx: Tx, orgId: Id<'org'>) => Promise<number>;
  /** The job being executed; it is re-enqueued unchanged when the cap is reached. */
  readonly job: DeferrableJob;
  /** Source of randomness for the jitter (tests pass a constant). */
  readonly random?: () => number;
}

export type OrgSlot =
  | { readonly acquired: true; readonly running: number }
  | {
      readonly acquired: false;
      readonly running: number;
      /** The copy of the job scheduled to try again. */
      readonly rescheduled: EnqueuedJob;
      readonly delayMs: number;
    };

/** Lock key text: `<kind>:<orgId>`, hashed with `hashtext` in SQL. */
export function orgSlotLockKey(kind: string, orgId: Id<'org'>): string {
  return `${kind}:${orgId}`;
}

/** Delay before a deferred job runs again: base + jitter in [0, JITTER). */
export function orgSlotDeferralMs(random: () => number = Math.random): number {
  const r = Math.min(Math.max(random(), 0), 0.999_999);
  return ORG_SLOT_DEFER_BASE_MS + Math.floor(r * ORG_SLOT_DEFER_JITTER_MS);
}

/**
 * Retry budget of the re-enqueued copy. graphile-worker counts the attempt
 * in progress; a deferral must not use it up, so the copy keeps the same
 * number of attempts left, including a fresh one.
 */
export function remainingMaxAttempts(
  job: Pick<DeferrableJob, 'attempts' | 'max_attempts'>,
): number {
  return Math.max(1, job.max_attempts - Math.max(job.attempts - 1, 0));
}

export function validateOrgSlotOptions(
  options: Pick<AcquireOrgSlotOptions, 'orgId' | 'kind' | 'cap'>,
): void {
  if (!organizationIdSchema.safeParse(options.orgId).success) {
    throw new TypeError('acquireOrgSlot: orgId is not an organization ID');
  }
  if (!KIND_PATTERN.test(options.kind)) {
    throw new TypeError('acquireOrgSlot: kind must match [a-z][a-z0-9_.-]{0,63}');
  }
  if (!Number.isSafeInteger(options.cap) || options.cap < 1) {
    throw new RangeError('acquireOrgSlot: cap must be a positive integer');
  }
}

/**
 * Per-organization concurrency cap for background work (ADR-18), used at the
 * start of a job instead of a named queue per organization:
 *
 * 1. `pg_advisory_xact_lock(hashtext(kind || ':' || org_id))` serialises the
 *    check for this organization and kind until `tx` ends;
 * 2. `countRunning` counts what is already running;
 * 3. below the cap → `{ acquired: true }`: the caller marks its own run as
 *    running **in the same `tx`** and does the work after committing;
 * 4. at or over the cap → the same job (task, payload, key, priority, flags,
 *    queue) is added again with `run_at = now() + 5s + jitter` and a retry
 *    budget that ignores the current attempt; the caller must commit and
 *    return successfully, so graphile-worker completes the current job
 *    without counting a failure.
 */
export async function acquireOrgSlot(tx: Tx, options: AcquireOrgSlotOptions): Promise<OrgSlot> {
  validateOrgSlotOptions(options);
  await sql`SELECT pg_advisory_xact_lock(hashtext(${orgSlotLockKey(options.kind, options.orgId)}))`.execute(
    tx,
  );
  const running = await options.countRunning(tx, options.orgId);
  if (running < options.cap) return { acquired: true, running };

  const { job } = options;
  const delayMs = orgSlotDeferralMs(options.random);
  const rescheduled = await addJob(tx, {
    task: job.task_identifier,
    payload: job.payload,
    runAt: { delayMs },
    priority: job.priority,
    maxAttempts: remainingMaxAttempts(job),
    queueName: job.queue_name,
    flags: job.flags === null ? null : Object.keys(job.flags),
    // While the current job is locked, `replace` moves the key to the new job.
    ...(job.key === null ? {} : { jobKey: job.key, jobKeyMode: 'replace' as const }),
  });
  return { acquired: false, running, rescheduled, delayMs };
}
