import { enqueue } from '../../../jobs/enqueue.js';

import type { Tx } from '../../../db/create-db.js';
import type { Id } from '@cellhive/contracts';

/**
 * Payload of `notifications.telegram_poll` (CONTRACTS §12.2, BACKLOG T549):
 * with `organization_id` + `secret_id`, polls that notification bot; without
 * them (the per-minute cron, `_cron`), finds the bots with pending links
 * (`listOrganizationsWithPendingTelegramLinks`) and enqueues one job each.
 */
export interface NotificationsTelegramPollPayload {
  readonly organization_id?: Id<'org'>;
  readonly secret_id?: Id<'sec'>;
  readonly _cron?: { readonly ts: string; readonly backfilled?: boolean };
}

/** One queued poll per bot: a second enqueue updates the waiting job. */
export function telegramPollJobKey(secretId: Id<'sec'>): string {
  return `telegram_poll:${secretId}`;
}

/**
 * Queues a poll of the bot in `tx` (a link was just created, the cron found
 * pending links, or a poll ran out of time). `runAt` delays it (a poll that
 * found another one running).
 */
export async function enqueueTelegramPoll(
  tx: Tx,
  organizationId: Id<'org'>,
  secretId: Id<'sec'>,
  runAt?: Date,
): Promise<void> {
  await enqueue(
    tx,
    'notifications.telegram_poll',
    { organization_id: organizationId, secret_id: secretId },
    {
      jobKey: telegramPollJobKey(secretId),
      // Polling is never retried in a burst: the cron tries again in a minute.
      maxAttempts: 1,
      ...(runAt === undefined ? {} : { runAt }),
    },
  );
}
