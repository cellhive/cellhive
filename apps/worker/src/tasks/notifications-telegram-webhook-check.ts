import {
  listTelegramWebhooksToCheck,
  type Db,
  type TelegramWebhookCheckOutcome,
  type TelegramWebhookRegistrar,
} from '@cellhive/server-core';

import type { Id } from '@cellhive/contracts';
import type { Task } from 'graphile-worker';
import type { Logger } from 'pino';

/** Organizations read per page of the hourly check. */
export const TELEGRAM_WEBHOOK_CHECK_PAGE = 200;

export interface NotificationsTelegramWebhookCheckDeps {
  readonly db: Db;
  readonly registrar: Pick<TelegramWebhookRegistrar, 'check'>;
  readonly logger: Logger;
}

/**
 * `notifications.telegram_webhook_check` (BACKLOG T609, ADR-35 §7, CONTRACTS
 * §12.2), hourly cron, no payload: for every organization with a
 * notification bot webhook (cross-tenant lookup
 * `listTelegramWebhooksToCheck`, ids only), `getWebhookInfo` — our webhook
 * under an old `PUBLIC_URL` (or removed) is registered again, a delivery
 * error since the last check or a webhook pointing elsewhere sets
 * `webhook_status = error` (shown in `GET …/notification-channels`). One
 * organization failing does not stop the others. Logs counts per outcome
 * only — never a URL, a token or Telegram's error text.
 */
export function createNotificationsTelegramWebhookCheckTask(
  deps: NotificationsTelegramWebhookCheckDeps,
): Task<'notifications.telegram_webhook_check'> {
  return async () => {
    const started = Date.now();
    const counts: Partial<Record<TelegramWebhookCheckOutcome | 'failed', number>> = {};
    let after: Id<'org'> | null = null;
    for (;;) {
      const page = await listTelegramWebhooksToCheck(deps.db.kysely, {
        after,
        limit: TELEGRAM_WEBHOOK_CHECK_PAGE,
      });
      for (const organizationId of page) {
        let outcome: TelegramWebhookCheckOutcome | 'failed';
        try {
          outcome = await deps.registrar.check(organizationId);
        } catch (err) {
          deps.logger.warn({ err, org_id: organizationId }, 'telegram webhook check failed');
          outcome = 'failed';
        }
        counts[outcome] = (counts[outcome] ?? 0) + 1;
      }
      after = page.at(-1) ?? null;
      if (page.length < TELEGRAM_WEBHOOK_CHECK_PAGE) break;
    }
    deps.logger.info({ ...counts, duration_ms: Date.now() - started }, 'telegram webhooks checked');
  };
}
