import { listOrganizationsWithExpiredAutomationRuns } from '../../db/cross-tenant-lookups.js';
import { orgScope } from '../../db/repository.js';
import { AutomationRunsRepository } from '../repository/automation-runs.repository.js';

import type { Db } from '../../db/create-db.js';
import type { Id } from '@cellhive/contracts';

/** Runs deleted per statement by the retention cleanup. */
export const AUTOMATION_RUNS_CLEANUP_BATCH = 1_000;
/** Organizations looked up per page by the retention cleanup. */
export const AUTOMATION_RUNS_CLEANUP_ORG_PAGE = 100;

export interface AutomationRunsCleanupResult {
  /** Organizations that had runs to delete. */
  readonly organizations: number;
  /** Runs deleted (their steps go with them). */
  readonly runs: number;
}

/**
 * Deletes finished automation runs created more than `retentionDays` before
 * `now`, with their steps (cascade), organization by organization in
 * batches of `batchSize` (each its own statement) — BACKLOG T518,
 * `AUTOMATION_RUN_RETENTION_DAYS`. Runs still `queued`, `running` or
 * `waiting` are kept whatever their age. A re-run whose original is
 * deleted keeps running and only loses the link (`rerun_of_run_id`
 * becomes `NULL`). Idempotent; returns counts only.
 */
export async function purgeExpiredAutomationRuns(
  db: Db,
  options: {
    readonly now: Date;
    readonly retentionDays: number;
    readonly batchSize?: number;
    readonly orgPageSize?: number;
  },
): Promise<AutomationRunsCleanupResult> {
  const batchSize = options.batchSize ?? AUTOMATION_RUNS_CLEANUP_BATCH;
  const orgPageSize = options.orgPageSize ?? AUTOMATION_RUNS_CLEANUP_ORG_PAGE;
  for (const [name, value] of [
    ['batchSize', batchSize],
    ['orgPageSize', orgPageSize],
    ['retentionDays', options.retentionDays],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`${name} must be a positive integer`);
    }
  }
  const cutoff = new Date(options.now.getTime() - options.retentionDays * 86_400_000);
  const runs = new AutomationRunsRepository(db);
  let organizations = 0;
  let deleted = 0;
  let after: Id<'org'> | null = null;
  for (;;) {
    const page = await listOrganizationsWithExpiredAutomationRuns(db.kysely, {
      before: cutoff,
      after,
      limit: orgPageSize,
    });
    for (const organizationId of page) {
      organizations += 1;
      const scope = orgScope(organizationId);
      for (;;) {
        const count = await runs.deleteFinishedBefore(scope, cutoff, batchSize);
        deleted += count;
        if (count < batchSize) break;
      }
    }
    if (page.length < orgPageSize) return { organizations, runs: deleted };
    after = page[page.length - 1] ?? null;
  }
}
