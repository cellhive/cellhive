import { purgeExpiredAutomationRuns, type Db } from '@cellhive/server-core';

import type { Task } from 'graphile-worker';
import type { Logger } from 'pino';

export interface AutomationRunsCleanupDeps {
  readonly db: Db;
  readonly logger: Logger;
  /** `AUTOMATION_RUN_RETENTION_DAYS` (BACKLOG T518, default 90). */
  readonly retentionDays: number;
  readonly now?: () => Date;
}

/**
 * `automation.runs_cleanup` (daily cron, BACKLOG T518): deletes finished
 * automation runs older than `AUTOMATION_RUN_RETENTION_DAYS`, with their
 * steps, organization by organization in batches. Idempotent; logs counts
 * only.
 */
export function createAutomationRunsCleanupTask(
  deps: AutomationRunsCleanupDeps,
): Task<'automation.runs_cleanup'> {
  return async () => {
    const started = Date.now();
    const result = await purgeExpiredAutomationRuns(deps.db, {
      now: deps.now?.() ?? new Date(),
      retentionDays: deps.retentionDays,
    });
    deps.logger.info(
      {
        organizations: result.organizations,
        runs: result.runs,
        duration_ms: Date.now() - started,
      },
      'expired automation runs purged',
    );
  };
}
