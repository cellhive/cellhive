import { sweepDailyDigests, type Db } from '@cellhive/server-core';

import type { Task } from 'graphile-worker';
import type { Logger } from 'pino';

export interface NotificationsDailyDigestDeps {
  readonly db: Db;
  /** `DEFAULT_TIMEZONE`, `DEFAULT_LOCALE`. */
  readonly defaults: { readonly timeZone: string; readonly locale: string };
  readonly logger: Logger;
  /** Injectable clock (tests). */
  readonly now?: () => Date;
}

/**
 * `notifications.daily_digest` (hourly cron at minute 0, BACKLOG T512):
 * queues `notifications.deliver` for every recipient whose daily summary
 * is due at this whole hour of their own time zone ("Quyết định S5 thiết
 * kế" #7), plus stragglers of the 5-minute batch. Idempotent (one job per
 * recipient); logs counts only.
 */
export function createNotificationsDailyDigestTask(
  deps: NotificationsDailyDigestDeps,
): Task<'notifications.daily_digest'> {
  return async () => {
    const started = Date.now();
    const result = await sweepDailyDigests(deps.db, {
      now: deps.now?.() ?? new Date(),
      defaults: deps.defaults,
    });
    deps.logger.info(
      { ...result, duration_ms: Date.now() - started },
      'notification email runs queued',
    );
  };
}
