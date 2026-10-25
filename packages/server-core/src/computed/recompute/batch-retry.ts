import { isStatementTimeout, sqlStateOf } from '../../db/pg-errors.js';
import { AppError } from '../../errors/app-error.js';

/**
 * How a failed batch of `computed.backfill` / `computed.recompute` is
 * handled (BACKLOG T474):
 * - `lock`: the batch waited for a lock longer than `lock_timeout`
 *   (`55P03`, also `SCHEMA_LOCKED`), hit a deadlock (`40P01`) or a
 *   serialization failure (`40001`) — another transaction held its rows;
 *   the batch is tried again after a backoff, the field keeps its state.
 * - `timeout`: `statement_timeout` (`57014`, `QUERY_TIMEOUT`) — the batch
 *   itself was too slow; tried once more with half the rows, twice in a
 *   row makes the field `TIMEOUT` (SPEC §9.5).
 * - `other`: anything else (the job fails, graphile-worker retries it).
 */
export type ComputedBatchErrorKind = 'lock' | 'timeout' | 'other';

/** SQLSTATEs of a batch that only waited for another transaction. */
const LOCK_SQLSTATES: ReadonlySet<string> = new Set([
  '55P03', // lock_not_available (lock_timeout)
  '40P01', // deadlock_detected
  '40001', // serialization_failure
]);

/** Attempts of one batch that keeps waiting for locks before the job fails (graphile retries it). */
export const COMPUTED_BATCH_LOCK_ATTEMPTS = 8;
/** Consecutive statement timeouts of one batch (the second with half the rows) that make the field `TIMEOUT`. */
export const COMPUTED_BATCH_TIMEOUT_ATTEMPTS = 2;
/** First backoff after a lock wait; doubled each attempt up to {@link COMPUTED_BATCH_LOCK_BACKOFF_MAX_MS}. */
export const COMPUTED_BATCH_LOCK_BACKOFF_MS = 250;
export const COMPUTED_BATCH_LOCK_BACKOFF_MAX_MS = 5_000;
/** Random part added to each backoff, so concurrent jobs do not retry in step. */
export const COMPUTED_BATCH_LOCK_JITTER_MS = 250;

function causeOf(error: unknown): unknown {
  return error instanceof Error ? error.cause : undefined;
}

/** The kind of a batch failure (see {@link ComputedBatchErrorKind}). */
export function computedBatchErrorKind(error: unknown): ComputedBatchErrorKind {
  if (
    isStatementTimeout(error) ||
    isStatementTimeout(causeOf(error)) ||
    (error instanceof AppError && error.code === 'QUERY_TIMEOUT')
  ) {
    return 'timeout';
  }
  if (error instanceof AppError && error.code === 'SCHEMA_LOCKED') return 'lock';
  const state = sqlStateOf(error) ?? sqlStateOf(causeOf(error));
  return state !== undefined && LOCK_SQLSTATES.has(state) ? 'lock' : 'other';
}

/**
 * What a log line may say about a batch failure: the application error code
 * and the SQLSTATE — never the message (it can quote values).
 */
export function computedBatchErrorCodes(error: unknown): {
  readonly error_code: string;
  readonly sqlstate: string | null;
} {
  const sqlstate = sqlStateOf(error) ?? sqlStateOf(causeOf(error)) ?? null;
  return {
    error_code: error instanceof AppError ? error.code : (sqlstate ?? 'INTERNAL'),
    sqlstate,
  };
}

/** Backoff before lock attempt `attempt + 1` (`attempt` counts from 1). */
export function computedLockRetryDelayMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  const exponent = Math.min(Math.max(attempt, 1) - 1, 16);
  const base = Math.min(
    COMPUTED_BATCH_LOCK_BACKOFF_MS * 2 ** exponent,
    COMPUTED_BATCH_LOCK_BACKOFF_MAX_MS,
  );
  const r = Math.min(Math.max(random(), 0), 0.999_999);
  return base + Math.floor(r * COMPUTED_BATCH_LOCK_JITTER_MS);
}

/** A retry of a batch, for the job's log (codes and counters only). */
export interface ComputedBatchRetry {
  readonly kind: 'lock' | 'timeout';
  /** Failed attempts of this kind so far for the batch. */
  readonly attempt: number;
  /** Rows the next attempt takes. */
  readonly size: number;
  readonly delayMs: number;
  readonly error_code: string;
  readonly sqlstate: string | null;
}

export interface RunComputedBatchOptions<T> {
  /** Rows of the batch (≥ 1). */
  readonly size: number;
  /** Runs the batch (its own transaction) with `size` rows. */
  readonly run: (size: number) => Promise<T>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly onRetry?: (retry: ComputedBatchRetry) => void;
  readonly random?: () => number;
  /** Default {@link COMPUTED_BATCH_LOCK_ATTEMPTS}. */
  readonly lockAttempts?: number;
}

export type ComputedBatchOutcome<T> =
  /** The batch ran; `size` is the rows it took (halved after a timeout — keep it for the next batches). */
  | { readonly status: 'ok'; readonly value: T; readonly size: number }
  /** Two statement timeouts in a row: the field is `TIMEOUT`. */
  | { readonly status: 'timeout'; readonly error: unknown }
  /** Still waiting for locks after every attempt: the job fails and graphile-worker retries it. */
  | { readonly status: 'locked'; readonly error: unknown };

/**
 * Runs one batch of a computed-field job with the T474 policy: lock waits
 * and deadlocks are retried with an exponential backoff (nothing else
 * changes), a statement timeout is retried once with half the rows, and only
 * a second consecutive timeout reports `timeout`. Other errors are thrown.
 */
export async function runComputedBatch<T>(
  options: RunComputedBatchOptions<T>,
): Promise<ComputedBatchOutcome<T>> {
  const lockAttempts = options.lockAttempts ?? COMPUTED_BATCH_LOCK_ATTEMPTS;
  let size = Math.max(1, Math.floor(options.size));
  let locks = 0;
  let timeouts = 0;
  for (;;) {
    try {
      return { status: 'ok', value: await options.run(size), size };
    } catch (error) {
      const kind = computedBatchErrorKind(error);
      if (kind === 'other') throw error;
      const codes = computedBatchErrorCodes(error);
      if (kind === 'timeout') {
        timeouts += 1;
        if (timeouts >= COMPUTED_BATCH_TIMEOUT_ATTEMPTS) return { status: 'timeout', error };
        size = Math.max(1, Math.floor(size / 2));
        options.onRetry?.({ kind, attempt: timeouts, size, delayMs: 0, ...codes });
        continue;
      }
      locks += 1;
      if (locks >= lockAttempts) return { status: 'locked', error };
      const delayMs = computedLockRetryDelayMs(locks, options.random);
      options.onRetry?.({ kind, attempt: locks, size, delayMs, ...codes });
      await options.sleep(delayMs);
    }
  }
}
