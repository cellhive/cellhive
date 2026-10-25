import { idOf } from '@cellhive/contracts';
import { queueTelegramSparsePolls, type Db, type TelegramLinkPoller } from '@cellhive/server-core';
import { z } from 'zod';

import type { Task } from 'graphile-worker';
import type { Logger } from 'pino';

const payloadSchema = z.object({
  organization_id: idOf('org'),
  secret_id: idOf('sec'),
});

export interface NotificationsTelegramSparsePollDeps {
  readonly db: Db;
  readonly poller: Pick<TelegramLinkPoller, 'poll'>;
  readonly logger: Logger;
  /** Clock of the log lines (tests inject it, with the poller's own clock). */
  readonly now?: () => Date;
}

/**
 * `notifications.telegram_sparse_poll` (BACKLOG T609, ADR-35 §7, QA S5b M4;
 * CONTRACTS §12.2):
 *
 * - every 15 minutes (cron, no payload): queues one job per notification
 *   bot in `polling` mode with at least one `linked` channel
 *   (cross-tenant lookup `listTelegramBotsForSparsePoll`, ids only; job key
 *   `telegram_sparse_poll:<secret_id>`);
 * - with `{ organization_id, secret_id }`: one `getUpdates` of that bot
 *   that does not wait (`TelegramLinkPoller.poll(…, { sparse: true })`), so
 *   a `/stop` sent while no link waits is handled within 15 minutes. A long
 *   poll of the bot already running → `busy`, nothing to do.
 *
 * Never retried (`max_attempts = 1`): the next sweep comes in 15 minutes.
 * Logs ids, outcome and counts only.
 */
export function createNotificationsTelegramSparsePollTask(
  deps: NotificationsTelegramSparsePollDeps,
): Task<'notifications.telegram_sparse_poll'> {
  const now = deps.now ?? (() => new Date());
  return async (payload, helpers) => {
    const started = now().getTime();
    if (payload.organization_id === undefined && payload.secret_id === undefined) {
      const bots = await queueTelegramSparsePolls(deps.db);
      deps.logger.info(
        { bots, duration_ms: now().getTime() - started },
        'telegram sparse polls queued',
      );
      return;
    }
    const parsed = payloadSchema.safeParse(payload);
    if (!parsed.success) {
      deps.logger.error(
        { job_id: helpers.job.id },
        'notifications.telegram_sparse_poll: malformed payload, skipped',
      );
      return;
    }
    const { organization_id: organizationId, secret_id: secretId } = parsed.data;
    const result = await deps.poller.poll(organizationId, secretId, { sparse: true });
    const log = {
      job_id: helpers.job.id,
      org_id: organizationId,
      secret_id: secretId,
      ...result,
      duration_ms: now().getTime() - started,
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
    deps.logger.info(log, 'telegram notification bot sparse poll');
  };
}
