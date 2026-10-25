import { listTelegramBotsForSparsePoll } from '../../../db/cross-tenant-lookups.js';
import { enqueue } from '../../../jobs/enqueue.js';

import type { Db, Tx } from '../../../db/create-db.js';
import type { Id } from '@cellhive/contracts';

/**
 * Sparse poll of the notification bots in `polling` mode (BACKLOG T609,
 * ADR-35 §7, QA S5b M4): the long poll only runs while links wait, so a
 * `/stop` sent at another time used to wait for the next link. Every 15
 * minutes (cron `notifications.telegram_sparse_poll`, no payload) one job
 * per bot with at least one `linked` channel is queued; each makes one
 * `getUpdates` that does not wait (`TelegramLinkPoller.poll(…, { sparse:
 * true })`), so `/stop` is handled within 15 minutes. In `webhook` mode
 * `/stop` is handled at once and no sparse poll runs.
 */

/** Payload of `notifications.telegram_sparse_poll` (CONTRACTS §12.2). */
export interface NotificationsTelegramSparsePollPayload {
  readonly organization_id?: Id<'org'>;
  readonly secret_id?: Id<'sec'>;
  readonly _cron?: { readonly ts: string; readonly backfilled?: boolean };
}

/** Bots read per page of the 15-minute sweep. */
export const TELEGRAM_SPARSE_POLL_PAGE = 500;

/** One queued sparse poll per bot. */
export function telegramSparsePollJobKey(secretId: Id<'sec'>): string {
  return `telegram_sparse_poll:${secretId}`;
}

export async function enqueueTelegramSparsePoll(
  tx: Tx,
  organizationId: Id<'org'>,
  secretId: Id<'sec'>,
): Promise<void> {
  await enqueue(
    tx,
    'notifications.telegram_sparse_poll',
    { organization_id: organizationId, secret_id: secretId },
    // Never retried: the next sweep comes in 15 minutes.
    { jobKey: telegramSparsePollJobKey(secretId), maxAttempts: 1 },
  );
}

/** The sweep: one sparse poll per bot with linked channels; returns how many were queued. */
export async function queueTelegramSparsePolls(db: Db): Promise<number> {
  let after: { organizationId: Id<'org'>; secretId: Id<'sec'> } | null = null;
  let count = 0;
  for (;;) {
    const page = await listTelegramBotsForSparsePoll(db.kysely, {
      after,
      limit: TELEGRAM_SPARSE_POLL_PAGE,
    });
    if (page.length === 0) return count;
    await db.withTx(async (tx) => {
      for (const bot of page) await enqueueTelegramSparsePoll(tx, bot.organizationId, bot.secretId);
    });
    count += page.length;
    after = page.at(-1) ?? null;
    if (page.length < TELEGRAM_SPARSE_POLL_PAGE) return count;
  }
}

/** Payload of `notifications.telegram_webhook_check` (hourly cron, no input; CONTRACTS §12.2). */
export interface NotificationsTelegramWebhookCheckPayload {
  readonly _cron?: { readonly ts: string; readonly backfilled?: boolean };
}
