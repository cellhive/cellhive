import { purgeExpiredOperationalRows, SessionsRepository, type Db } from '@cellhive/server-core';

import type { Task } from 'graphile-worker';
import type { Logger } from 'pino';

export interface MaintenanceCleanupDeps {
  readonly db: Db;
  readonly logger: Logger;
  readonly now?: () => Date;
}

/**
 * `maintenance.cleanup` (hourly cron, BACKLOG T108): deletes idempotency
 * keys older than 24 hours (CONTRACTS §1.1), `meta.jobs` rows that
 * finished more than 30 days ago, automation fan-out counters older than
 * 24 hours (ADR-26 §4), raw incoming webhook requests older than 7 days
 * (ADR-35 §1), API tokens revoked or expired more than 90 days ago (T703),
 * dashboards in the trash for more than 30 days (T805) and expired
 * sessions (they no longer authenticate; SPEC §14.2).
 * Idempotent; logs counts only.
 */
export function createMaintenanceCleanupTask(
  deps: MaintenanceCleanupDeps,
): Task<'maintenance.cleanup'> {
  const sessions = new SessionsRepository(deps.db);
  return async () => {
    const started = Date.now();
    const now = deps.now?.() ?? new Date();
    const result = await purgeExpiredOperationalRows(deps.db, { now });
    const expiredSessions = await sessions.deleteExpired(now);
    deps.logger.info(
      {
        idempotency_keys: result.idempotencyKeys,
        jobs: result.jobs,
        automation_batch_counters: result.automationBatchCounters,
        incoming_webhook_requests: result.incomingWebhookRequests,
        http_test_deliveries: result.httpTestDeliveries,
        api_tokens: result.apiTokens,
        dashboards: result.dashboards,
        sessions: expiredSessions,
        duration_ms: Date.now() - started,
      },
      'expired operational rows purged',
    );
  };
}
