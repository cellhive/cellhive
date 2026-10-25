import { idOf } from '@cellhive/contracts';
import { NotificationTelegramRetryError } from '@cellhive/server-core';
import { z } from 'zod';

import type {
  NotificationEmailDelivery,
  NotificationTelegramDelivery,
  NotificationsDeliverPayload,
} from '@cellhive/server-core';
import type { JobHelpers, Task } from 'graphile-worker';
import type { Logger } from 'pino';

const payloadSchema = z.object({
  organization_id: idOf('org'),
  user_id: idOf('usr'),
  reason: z.enum(['immediate', 'daily']),
  // Absent on jobs queued before T550: email.
  channel: z.enum(['email', 'telegram']).optional(),
});

export interface NotificationsDeliverDeps {
  readonly delivery: NotificationEmailDelivery;
  /** The Telegram channel (T550). */
  readonly telegram: NotificationTelegramDelivery;
  readonly logger: Logger;
}

/**
 * `notifications.deliver` (BACKLOG T512, T550): sends the pending
 * notifications of one recipient on one channel.
 *
 * - `email` (or no `channel`): queued 5 minutes after the first email of an
 *   `immediate` recipient (job key per recipient, later ones join), or by
 *   `notifications.daily_digest` when a daily summary is due. A temporary
 *   SMTP failure throws so graphile-worker retries (each delivery counts
 *   its attempts and fails after 5); a rejection fails the deliveries at
 *   once; a reached hourly quota re-schedules the run at the next hour.
 * - `telegram`: queued 5 seconds after the first Telegram delivery of the
 *   recipient (its own job key). `429` re-schedules the run after
 *   `retry_after`; a temporary failure throws (attempts counted, `failed`
 *   after 5); a refused chat fails the deliveries and puts the channel in
 *   `error`.
 *
 * Logs ids, counts and failure codes only: never an address, a chat id, a
 * token, a subject or content.
 */
export function createNotificationsDeliverTask(
  deps: NotificationsDeliverDeps,
): Task<'notifications.deliver'> {
  return async (payload, helpers) => {
    const parsed = payloadSchema.safeParse(payload);
    if (!parsed.success) {
      deps.logger.error(
        { job_id: helpers.job.id },
        'notifications.deliver: malformed payload, skipped',
      );
      return;
    }
    const input = parsed.data as NotificationsDeliverPayload;
    if (input.channel === 'telegram') {
      await deliverTelegram(deps, input, helpers);
      return;
    }
    const started = Date.now();
    const outcome = await deps.delivery.deliver(input);
    const base = {
      job_id: helpers.job.id,
      org_id: input.organization_id,
      user_id: input.user_id,
      reason: input.reason,
      status: outcome.status,
      duration_ms: Date.now() - started,
    };
    switch (outcome.status) {
      case 'retry':
        deps.logger.warn(
          { ...base, attempts: outcome.attempts, ...outcome.error.toLog() },
          'notification email failed temporarily; retrying',
        );
        throw outcome.error;
      case 'failed':
        deps.logger.warn(
          { ...base, failed: outcome.failed, ...outcome.error.toLog() },
          'notification email not sent',
        );
        return;
      case 'deferred':
        deps.logger.info(
          { ...base, pending: outcome.pending, retry_at: outcome.retryAt.toISOString() },
          'notification email deferred: hourly email limit reached',
        );
        return;
      case 'sent':
        deps.logger.info(
          { ...base, sent: outcome.sent, skipped: outcome.skipped, more: outcome.more },
          'notification email sent',
        );
        return;
      case 'skipped':
        deps.logger.info(
          { ...base, skipped: outcome.skipped, more: outcome.more },
          'notification emails skipped',
        );
        return;
      case 'waiting_for_digest':
        deps.logger.debug({ ...base, pending: outcome.pending }, 'waiting for the daily summary');
        return;
      case 'nothing':
        deps.logger.debug(base, 'no notification email pending');
        return;
    }
  };
}

async function deliverTelegram(
  deps: NotificationsDeliverDeps,
  input: NotificationsDeliverPayload,
  helpers: JobHelpers,
): Promise<void> {
  const started = Date.now();
  const outcome = await deps.telegram.deliver(input);
  const base = {
    job_id: helpers.job.id,
    org_id: input.organization_id,
    user_id: input.user_id,
    channel: 'telegram',
    status: outcome.status,
    duration_ms: Date.now() - started,
  };
  switch (outcome.status) {
    case 'retry':
      deps.logger.warn(
        { ...base, attempts: outcome.attempts, cause: outcome.cause },
        'notification Telegram message failed temporarily; retrying',
      );
      throw new NotificationTelegramRetryError(outcome.cause);
    case 'failed':
      deps.logger.warn(
        {
          ...base,
          failed: outcome.failed,
          code: outcome.code,
          skipped: outcome.skipped,
          channel_error: outcome.channelError,
          more: outcome.more,
        },
        'notification Telegram message not sent',
      );
      return;
    case 'deferred':
      deps.logger.info(
        {
          ...base,
          pending: outcome.pending,
          reason: outcome.reason,
          retry_at: outcome.retryAt.toISOString(),
        },
        'notification Telegram message deferred',
      );
      return;
    case 'sent':
      deps.logger.info(
        {
          ...base,
          sent: outcome.sent,
          shown: outcome.shown,
          skipped: outcome.skipped,
          more: outcome.more,
        },
        'notification Telegram message sent',
      );
      return;
    case 'skipped':
      deps.logger.info(
        { ...base, skipped: outcome.skipped, more: outcome.more },
        'notification Telegram deliveries skipped',
      );
      return;
    case 'nothing':
      deps.logger.debug(base, 'no notification Telegram delivery pending');
      return;
  }
}
