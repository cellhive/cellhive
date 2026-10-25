import {
  createMonthlyPartition,
  dropMonthlyPartitionsBefore,
  JOB_STATEMENT_TIMEOUT_MS,
  monthsToEnsure,
  PARTITIONED_TABLES,
  retentionCutoff,
  type Db,
  type PartitionedTable,
} from '@cellhive/server-core';
import { sql } from 'kysely';

import type { Task } from 'graphile-worker';
import type { Logger } from 'pino';

/**
 * Events feed automations (dispatched within seconds) and are not the audit
 * trail (ADR-23), so they are kept for a fixed 90 days. No environment
 * variable on purpose: SPEC §20 is the closed list of variables.
 */
export const EVENT_RETENTION_DAYS = 90;
/** Partitions exist for the current month and this many months ahead. */
export const PARTITION_MONTHS_AHEAD = 2;
/** DROP needs an exclusive lock on the parent table; do not queue behind writers for long. */
const DROP_LOCK_TIMEOUT = '5s';

export interface PartitionMaintenanceOptions {
  readonly now: Date;
  /** `AUDIT_RETENTION_DAYS`; `0` keeps audit partitions forever. */
  readonly auditRetentionDays: number;
  readonly eventRetentionDays?: number;
  readonly monthsAhead?: number;
}

export interface PartitionMaintenanceResult {
  /** Every partition ensured (created now or already there). */
  readonly ensured: readonly string[];
  readonly dropped: readonly string[];
  /** Events partitions past retention kept because they hold undispatched events. */
  readonly kept: readonly string[];
}

/**
 * Creates the partitions of `meta.events` / `meta.audit_logs` for the current
 * month and the next `monthsAhead` months, then drops the partitions whose
 * whole month is past retention (audit: `AUDIT_RETENTION_DAYS`, 0 = never;
 * events: 90 days). Idempotent; each statement runs in its own transaction.
 */
export async function maintainPartitions(
  db: Db,
  options: PartitionMaintenanceOptions,
): Promise<PartitionMaintenanceResult> {
  const months = monthsToEnsure(options.now, options.monthsAhead ?? PARTITION_MONTHS_AHEAD);
  const ensured: string[] = [];
  for (const table of PARTITIONED_TABLES) {
    for (const month of months) {
      ensured.push(
        await db.withTx((tx) => createMonthlyPartition(tx, table, month), {
          timeoutMs: JOB_STATEMENT_TIMEOUT_MS,
        }),
      );
    }
  }

  const cutoffs: [PartitionedTable, Date][] = [
    ['events', retentionCutoff(options.now, options.eventRetentionDays ?? EVENT_RETENTION_DAYS)],
  ];
  if (options.auditRetentionDays > 0) {
    cutoffs.push(['audit_logs', retentionCutoff(options.now, options.auditRetentionDays)]);
  }
  const dropped: string[] = [];
  const kept: string[] = [];
  for (const [table, cutoff] of cutoffs) {
    const results = await db.withTx(
      async (tx) => {
        await sql`SELECT set_config('lock_timeout', ${DROP_LOCK_TIMEOUT}, true)`.execute(tx);
        return dropMonthlyPartitionsBefore(tx, table, cutoff);
      },
      { timeoutMs: JOB_STATEMENT_TIMEOUT_MS },
    );
    for (const result of results) (result.dropped ? dropped : kept).push(result.partition);
  }
  return { ensured, dropped, kept };
}

export interface PartitionsMaintainDeps {
  readonly db: Db;
  readonly logger: Logger;
  readonly auditRetentionDays: number;
  readonly now?: () => Date;
}

/** `partitions.maintain`: daily cron (and once at worker start). */
export function createPartitionsMaintainTask(
  deps: PartitionsMaintainDeps,
): Task<'partitions.maintain'> {
  return async () => {
    const result = await maintainPartitions(deps.db, {
      now: deps.now?.() ?? new Date(),
      auditRetentionDays: deps.auditRetentionDays,
    });
    for (const partition of result.dropped) {
      deps.logger.info({ partition }, 'partition past retention dropped');
    }
    for (const partition of result.kept) {
      deps.logger.warn(
        { partition },
        'events partition past retention kept: it still has undispatched events',
      );
    }
    deps.logger.info(
      { ensured: result.ensured.length, dropped: result.dropped.length, kept: result.kept.length },
      'partitions maintained',
    );
  };
}
