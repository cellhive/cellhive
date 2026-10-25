import {
  AUTOMATION_STEP_RETRY_DELAYS_MS,
  AUTOMATION_STEP_RETRY_JITTER,
  type AutomationStepErrorCode,
  type AutomationTemporaryCause,
} from '@cellhive/contracts';

import { sqlStateOf } from '../../db/pg-errors.js';
import { AppError } from '../../errors/app-error.js';
import { AutomationValueError } from '../values/evaluator.js';

/**
 * Step errors of the run engine (SPEC §11.7, BACKLOG T505): what failed,
 * and whether trying again later can help. Only temporary problems are
 * retried — network, timeouts, `429`/`5xx`, lock waits and deadlocks
 * (`55P03`/`40P01`); anything else fails the step at once.
 */

/** Where a permission was missing (`params.scope` of `permission_denied`). */
export type PermissionScope = 'record' | 'table' | 'base';

/** An error an action reports on purpose (handlers of T506, T514–T516 throw it too). */
export class AutomationStepError extends Error {
  override readonly name = 'AutomationStepError';

  constructor(
    readonly code: AutomationStepErrorCode,
    message: string,
    readonly options: {
      readonly transient?: AutomationTemporaryCause;
      readonly params?: Readonly<Record<string, unknown>>;
      /** Wait until then and try again, without using a retry (e.g. an hourly email quota). */
      readonly wait?: StepWait;
      /**
       * With `transient`: wait this long before the retry instead of the
       * schedule's delay (a `429` with `Retry-After`/`retry_after`, T516). The
       * retry still counts.
       */
      readonly retryAfterMs?: number;
    } = {},
  ) {
    super(message);
  }
}

/**
 * A step that cannot proceed before `until` (T514: the hourly email quota
 * is used up). The engine schedules the run again at `until` without using
 * one of the retries of temporary errors, and fails the step with its code
 * once it has been waiting for more than `maxWaitMs`.
 */
export interface StepWait {
  readonly until: Date;
  readonly maxWaitMs: number;
}

/** A step failure as the engine stores it (codes and ids only, never record values). */
export interface StepFailure {
  readonly code: AutomationStepErrorCode;
  /** Set when trying again later may succeed. */
  readonly transient: AutomationTemporaryCause | null;
  readonly params: Readonly<Record<string, unknown>>;
  /** Set when the step waits (not a retry). */
  readonly wait?: StepWait;
  /** Delay the server asked for before the next retry (see `AutomationStepError`). */
  readonly retryAfterMs?: number;
}

/** Record-level refusals of the record services: the record is outside `run_as`'s rules (P29). */
const RECORD_REFUSALS: ReadonlySet<string> = new Set([
  'NOT_FOUND',
  'PERMISSION_DENIED',
  'RECORD_RULE_VIOLATION',
]);

/** SQLSTATEs worth a retry: lock wait, deadlock, serialization, statement timeout. */
const BUSY_STATES: ReadonlySet<string> = new Set(['55P03', '40P01', '40001']);
const NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNABORTED',
]);

function transientCauseOf(error: unknown): AutomationTemporaryCause | null {
  if (error instanceof AppError) {
    if (error.code === 'SCHEMA_LOCKED') return 'database_busy';
    if (error.status === 429) return 'rate_limited';
    if (error.status >= 500) return 'server_error';
    return null;
  }
  const state = sqlStateOf(error);
  if (state !== undefined) {
    if (BUSY_STATES.has(state)) return 'database_busy';
    if (state === '57014') return 'timeout';
    if (state.startsWith('08') || state === '57P01') return 'network';
    return null;
  }
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && NETWORK_CODES.has(code)) return 'network';
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'timeout';
  }
  return null;
}

/** What went wrong in a step, and whether to retry (see the module comment). */
export function classifyStepError(error: unknown): StepFailure {
  if (error instanceof AutomationStepError) {
    return {
      code: error.code,
      transient: error.options.transient ?? null,
      params: error.options.params ?? {},
      ...(error.options.wait === undefined ? {} : { wait: error.options.wait }),
      ...(error.options.retryAfterMs === undefined
        ? {}
        : { retryAfterMs: error.options.retryAfterMs }),
    };
  }
  if (error instanceof AutomationValueError) {
    return { code: error.code, transient: null, params: { ...error.params } };
  }
  const cause = transientCauseOf(error);
  if (cause !== null) return { code: 'temporary_error', transient: cause, params: { cause } };
  if (error instanceof AppError) {
    if (RECORD_REFUSALS.has(error.code)) {
      return {
        code: 'permission_denied',
        transient: null,
        params: { scope: 'record', error: error.code },
      };
    }
    if (error.status === 422 || error.status === 409 || error.status === 413) {
      return { code: 'invalid_value', transient: null, params: { error: error.code } };
    }
  }
  return { code: 'internal_error', transient: null, params: {} };
}

/**
 * Delay before retry number `attempt` (1-based: the first retry follows
 * the first failure): 10 s, 30 s, 2 min, 10 min, 30 min, plus up to 20 %
 * random jitter. `null` once the retries are used up.
 */
export function retryDelayMs(attempt: number, random: () => number = Math.random): number | null {
  const base = AUTOMATION_STEP_RETRY_DELAYS_MS[attempt - 1];
  if (base === undefined) return null;
  const r = Math.min(Math.max(random(), 0), 0.999_999);
  return base + Math.floor(base * AUTOMATION_STEP_RETRY_JITTER * r);
}
