import { idOf } from '@cellhive/contracts';
import {
  enqueueTelegramPoll,
  listOrganizationsWithPendingTelegramLinks,
  type Db,
  type PendingTelegramLinkBot,
  type TelegramLinkPoller,
} from '@cellhive/server-core';
import { z } from 'zod';

import type { Task } from 'graphile-worker';
import type { Logger } from 'pino';

/** Bots read per page of the per-minute sweep. */
export const TELEGRAM_POLL_SWEEP_PAGE = 500;
/** A poll that found another one running for its bot tries again this much later. */
export const TELEGRAM_POLL_BUSY_RETRY_MS = 5_000;

const payloadSchema = z.object({
  organization_id: idOf('org'),
  secret_id: idOf('sec'),
});

export interface NotificationsTelegramPollDeps {
  readonly db: Db;
  readonly poller: Pick<TelegramLinkPoller, 'poll'>;
  readonly logger: Logger;
  /** Clock of the sweep (tests inject it). */
  readonly now?: () => Date;
}

/**
 * `notifications.telegram_poll` (BACKLOG T549, ADR-34 §3, CONTRACTS §12.2):
 *
 * - with `{ organization_id, secret_id }` (enqueued when a member creates a
 *   link, job key `telegram_poll:<secret_id>`): polls that notification bot
 *   for `/start <token>` and `/stop` (`TelegramLinkPoller`, ~55 s at most,
 *   one poller per bot). Links still pending when its time ran out → the
 *   next poll is queued at once; another poll of the bot running → this one
 *   comes back in 5 s while links are pending (the cron catches anything
 *   else within a minute);
 * - every minute (cron, no organization): queues a poll for every bot with
 *   pending links (cross-tenant lookup
 *   `listOrganizationsWithPendingTelegramLinks`, ids only).
 *
 * Never retried in a burst (`max_attempts = 1`). Logs ids, outcome and
 * counts only — never a token, a chat id, a Telegram name or a message.
 */
export function createNotificationsTelegramPollTask(
  deps: NotificationsTelegramPollDeps,
): Task<'notifications.telegram_poll'> {
  return async (payload, helpers) => {
    const started = Date.now();
    if (payload.organization_id === undefined && payload.secret_id === undefined) {
      const bots = await queuePendingBots(deps.db, deps.now?.() ?? new Date());
      deps.logger.info(
        { bots, duration_ms: Date.now() - started },
        'telegram polls queued for pending links',
      );
      return;
    }
    const parsed = payloadSchema.safeParse(payload);
    if (!parsed.success) {
      deps.logger.error(
        { job_id: helpers.job.id },
        'notifications.telegram_poll: malformed payload, skipped',
      );
      return;
    }
    const { organization_id: organizationId, secret_id: secretId } = parsed.data;
    const result = await deps.poller.poll(organizationId, secretId);
    if (result.outcome === 'continue') {
      await deps.db.withTx((tx) => enqueueTelegramPoll(tx, organizationId, secretId));
    } else if (result.outcome === 'busy') {
      await deps.db.withTx((tx) =>
        enqueueTelegramPoll(
          tx,
          organizationId,
          secretId,
          new Date(Date.now() + TELEGRAM_POLL_BUSY_RETRY_MS),
        ),
      );
    }
    const log = {
      job_id: helpers.job.id,
      org_id: organizationId,
      secret_id: secretId,
      ...result,
      duration_ms: Date.now() - started,
    };
    if (
      result.outcome === 'webhook_conflict' ||
      result.outcome === 'invalid_token' ||
      result.outcome === 'conflict' ||
      result.outcome === 'rejected'
    ) {
      deps.logger.warn(log, 'telegram notification bot cannot receive updates');
      return;
    }
    // Another poll of the bot is running: retried in 5 s while links wait (QA S5b I5: not news).
    // Webhook mode (T609): Telegram calls the webhook route, nothing to poll.
    if (result.outcome === 'busy' || result.outcome === 'webhook_mode') {
      deps.logger.debug(log, 'telegram notification bot busy, poll queued again');
      return;
    }
    deps.logger.info(log, 'telegram notification bot polled');
  };
}

/** Queues one poll per bot with pending links; returns how many. */
async function queuePendingBots(db: Db, now: Date): Promise<number> {
  let after: PendingTelegramLinkBot | null = null;
  let count = 0;
  for (;;) {
    const page = await listOrganizationsWithPendingTelegramLinks(db.kysely, {
      now,
      after,
      limit: TELEGRAM_POLL_SWEEP_PAGE,
    });
    if (page.length === 0) return count;
    await db.withTx(async (tx) => {
      for (const bot of page) {
        await enqueueTelegramPoll(tx, bot.organizationId, bot.secretId);
      }
    });
    count += page.length;
    after = page.at(-1) ?? null;
    if (page.length < TELEGRAM_POLL_SWEEP_PAGE) return count;
  }
}
