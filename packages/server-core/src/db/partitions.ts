/**
 * Pure helpers of the monthly partitions; the DDL functions live in
 * `cross-tenant-lookups.ts` (instance-wide maintenance).
 */

/** Tables partitioned by month on `created_at` (SPEC §5.10). */
export const PARTITIONED_TABLES = ['events', 'audit_logs'] as const;
export type PartitionedTable = (typeof PARTITIONED_TABLES)[number];

const DAY_MS = 86_400_000;

/** `YYYY-MM-01` of the UTC month `offset` months after the month of `now`. */
export function monthStart(now: Date, offset = 0): string {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  return date.toISOString().slice(0, 10);
}

/** First days of the current month and the `ahead` following months (UTC). */
export function monthsToEnsure(now: Date, ahead: number): string[] {
  if (!Number.isSafeInteger(ahead) || ahead < 0) {
    throw new RangeError('monthsToEnsure: ahead must be a non-negative integer');
  }
  return Array.from({ length: ahead + 1 }, (_, offset) => monthStart(now, offset));
}

/** `now - days`; rows created before it are past retention. */
export function retentionCutoff(now: Date, days: number): Date {
  if (!Number.isSafeInteger(days) || days < 1) {
    throw new RangeError('retentionCutoff: days must be a positive integer');
  }
  return new Date(now.getTime() - days * DAY_MS);
}
