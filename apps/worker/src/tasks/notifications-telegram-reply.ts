import { idOf } from '@cellhive/contracts';
import { z } from 'zod';

import type { TelegramReplySender } from '@cellhive/server-core';
import type { Task } from 'graphile-worker';
import type { Logger } from 'pino';

const payloadSchema = z.object({
  organization_id: idOf('org'),
  secret_id: idOf('sec'),
  chat: z.string().min(1).max(512),
  reply: z.enum(['linked', 'invalid', 'stopped']),
  language: z.enum(['en', 'vi']),
});

export interface NotificationsTelegramReplyDeps {
  readonly sender: Pick<TelegramReplySender, 'send'>;
  readonly logger: Logger;
}

/**
 * A temporary failure of a reply (no slot of the shared pacers, Telegram did
 * not answer): thrown so graphile-worker tries again (3 attempts). Carries no
 * token, chat id or message.
 */
export class TelegramReplyRetryError extends Error {
  constructor() {
    super('Telegram reply failed temporarily.');
    this.name = 'TelegramReplyRetryError';
  }
}

/**
 * `notifications.telegram_reply` (BACKLOG T609, ADR-35 §7, CONTRACTS §12.2):
 * one fixed reply of the notification bot to `/start` or `/stop`, queued by
 * the poller or the webhook route in the transaction that handled the
 * update. Sent through the bot's `TelegramSendPacers` (25 per second per bot
 * shared with `send_telegram` and notification deliveries, 1 per second per
 * chat); a "not valid" reply at most 3 times per chat per hour, then
 * silence (QA S5b M5). `429` drops the reply (the bucket slows the next
 * ones); a temporary failure throws and is retried. Logs ids and the
 * outcome only — never a token, a chat id or a message.
 */
export function createNotificationsTelegramReplyTask(
  deps: NotificationsTelegramReplyDeps,
): Task<'notifications.telegram_reply'> {
  return async (payload, helpers) => {
    const parsed = payloadSchema.safeParse(payload);
    if (!parsed.success) {
      deps.logger.error(
        { job_id: helpers.job.id },
        'notifications.telegram_reply: malformed payload, skipped',
      );
      return;
    }
    const outcome = await deps.sender.send(parsed.data);
    const log = {
      job_id: helpers.job.id,
      org_id: parsed.data.organization_id,
      secret_id: parsed.data.secret_id,
      reply: parsed.data.reply,
      outcome,
    };
    if (outcome === 'retry') {
      deps.logger.warn(log, 'telegram reply failed temporarily; retrying');
      throw new TelegramReplyRetryError();
    }
    if (outcome === 'sent' || outcome === 'capped') {
      deps.logger.debug(log, 'telegram reply handled');
      return;
    }
    deps.logger.info(log, 'telegram reply not sent');
  };
}
