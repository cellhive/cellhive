import { sqlStateOf } from '../db/pg-errors.js';

/**
 * Limits and retry policy of schema changes (SPEC §5.1, §5.4, ADR-20).
 */

/** PostgreSQL's hard limit of columns per table (`MaxHeapAttributeNumber`), dropped ones included. */
export const PG_MAX_COLUMNS = 1600;
/** `used_slots >= 1400` → enqueue `schema.compact_table` (ADR-20 §2). */
export const COMPACTION_SLOT_THRESHOLD = 1400;
/** `used_slots >= 1550` → refuse slot-consuming DDL with `409 SCHEMA_LOCKED` (ADR-20 §2). */
export const LOCKED_SLOT_THRESHOLD = 1550;
/** Ceiling of `MAX_FIELDS_PER_TABLE` whatever the environment says (SPEC §5.4). */
export const HARD_MAX_FIELDS_PER_TABLE = 1000;

/** `SET LOCAL lock_timeout` of every DDL transaction (SPEC §5.1). */
export const DDL_LOCK_TIMEOUT_MS = 3000;
/** Attempts of a DDL transaction that failed on a lock timeout, serialization failure or deadlock. */
export const DDL_MAX_ATTEMPTS = 3;
/** Retry delay: `BASE * attempt + jitter`, jitter in `[0, JITTER)`. */
export const DDL_RETRY_BASE_MS = 50;
export const DDL_RETRY_JITTER_MS = 100;
/** `statement_timeout` of the compaction transaction (ADR-20 §3: default 30 minutes). */
export const COMPACTION_STATEMENT_TIMEOUT_MS = 30 * 60 * 1000;

export interface SlotThresholds {
  readonly compact: number;
  readonly lock: number;
}

export const DEFAULT_SLOT_THRESHOLDS: SlotThresholds = {
  compact: COMPACTION_SLOT_THRESHOLD,
  lock: LOCKED_SLOT_THRESHOLD,
};

export type SlotDecision = 'ok' | 'compact' | 'locked';

/**
 * What to do before a DDL that consumes `consumed` column slots on a table
 * already using `usedSlots` (dropped columns included):
 * - `locked`: `usedSlots >= lock` → refuse (and make sure compaction is queued);
 * - `compact`: proceed, and enqueue compaction because `usedSlots + consumed >= compact`;
 * - `ok`: proceed.
 */
export function slotDecision(
  usedSlots: number,
  consumed: number,
  thresholds: SlotThresholds = DEFAULT_SLOT_THRESHOLDS,
): SlotDecision {
  if (usedSlots >= thresholds.lock || usedSlots + consumed > PG_MAX_COLUMNS) return 'locked';
  if (usedSlots + consumed >= thresholds.compact) return 'compact';
  return 'ok';
}

/** `MAX_FIELDS_PER_TABLE` capped at the hard ceiling of 1 000. */
export function effectiveMaxFields(configured: number): number {
  if (!Number.isSafeInteger(configured) || configured < 1) {
    throw new RangeError('maxFieldsPerTable must be a positive integer');
  }
  return Math.min(configured, HARD_MAX_FIELDS_PER_TABLE);
}

/** SQLSTATEs after which the whole DDL transaction may simply be tried again. */
export const RETRYABLE_DDL_SQLSTATES: ReadonlySet<string> = new Set([
  '55P03', // lock_not_available (lock_timeout)
  '40001', // serialization_failure
  '40P01', // deadlock_detected
]);

export function isRetryableDdlError(error: unknown): boolean {
  const state = sqlStateOf(error);
  return state !== undefined && RETRYABLE_DDL_SQLSTATES.has(state);
}

/** Delay before attempt `attempt + 1` (attempt counts from 1). */
export function ddlRetryDelayMs(attempt: number, random: () => number = Math.random): number {
  const r = Math.min(Math.max(random(), 0), 0.999_999);
  return DDL_RETRY_BASE_MS * attempt + Math.floor(r * DDL_RETRY_JITTER_MS);
}

/** Text hashed into the transaction advisory lock of one table's schema. */
export function schemaLockKey(tableId: string): string {
  return `schema:${tableId}`;
}
