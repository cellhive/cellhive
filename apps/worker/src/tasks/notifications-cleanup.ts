import { NOTIFICATION_BUFFER_STALE_MS } from '@cellhive/contracts';
import {
  listStaleNotificationBuffers,
  purgeExpiredNotifications,
  scheduleNotificationFlush,
  type Db,
  type StaleNotificationBuffer,
} from '@cellhive/server-core';

import type { Task } from 'graphile-worker';
import type { Logger } from 'pino';

/** Stale groups read per page of the sweep. */
export const NOTIFICATION_BUFFER_SWEEP_PAGE = 500;

export interface NotificationsCleanupDeps {
  readonly db: Db;
  readonly logger: Logger;
  /** `NOTIFICATION_RETENTION_DAYS` (ADR-29 §1). */
  readonly retentionDays: number;
  readonly now?: () => Date;
}

/**
 * `notifications.cleanup` (BACKLOG T511, T542):
 *
 * - daily: deletes notifications older than `NOTIFICATION_RETENTION_DAYS`,
 *   with their queued deliveries, in every organization;
 * - daily and every 5 minutes (`buffers_only`): schedules a flush now for
 *   every group of `meta.notification_buffer` with a row older than
 *   `NOTIFICATION_BUFFER_STALE_MS` (its `notifications.flush` job was lost;
 *   cross-tenant lookup `listStaleNotificationBuffers`, ids only).
 *
 * Idempotent; logs counts only.
 */
export function createNotificationsCleanupTask(
  deps: NotificationsCleanupDeps,
): Task<'notifications.cleanup'> {
  return async (payload) => {
    const started = Date.now();
    const now = deps.now?.() ?? new Date();
    const buffers = await flushStaleBuffers(deps.db, now);
    if (payload.buffers_only === true) {
      deps.logger.info(
        { stale_buffer_groups: buffers, duration_ms: Date.now() - started },
        'stale notification buffers flushed',
      );
      return;
    }
    const deleted = await purgeExpiredNotifications(deps.db, {
      now,
      retentionDays: deps.retentionDays,
    });
    deps.logger.info(
      { notifications: deleted, stale_buffer_groups: buffers, duration_ms: Date.now() - started },
      'expired notifications purged',
    );
  };
}

/** Schedules a flush now for every stale group; returns how many. */
async function flushStaleBuffers(db: Db, now: Date): Promise<number> {
  const before = new Date(now.getTime() - NOTIFICATION_BUFFER_STALE_MS);
  let after: StaleNotificationBuffer | null = null;
  let count = 0;
  for (;;) {
    const page = await listStaleNotificationBuffers(db.kysely, {
      before,
      after,
      limit: NOTIFICATION_BUFFER_SWEEP_PAGE,
    });
    if (page.length === 0) return count;
    await db.withTx(async (tx) => {
      for (const group of page) {
        await scheduleNotificationFlush(
          tx,
          {
            organization_id: group.organizationId,
            kind: group.kind,
            group_key: group.groupKey,
          },
          now,
        );
      }
    });
    count += page.length;
    if (page.length < NOTIFICATION_BUFFER_SWEEP_PAGE) return count;
    after = page[page.length - 1] ?? null;
  }
}
