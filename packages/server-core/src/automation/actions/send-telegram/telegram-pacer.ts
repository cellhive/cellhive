import {
  TELEGRAM_BOT_MESSAGES_PER_SECOND,
  TELEGRAM_CHAT_MESSAGES_PER_SECOND,
} from '@cellhive/contracts';

import {
  createValkeySendPacer,
  MemorySendPacer,
  type Clock,
  type QuotaClient,
  type SendPacer,
} from '../../../mail/limits.js';

/**
 * Telegram sending limits (BACKLOG T550, ADR-34 §3; helper of T541):
 *
 * - `bot`: at most {@link TELEGRAM_BOT_MESSAGES_PER_SECOND} messages within
 *   any sliding second **per bot**, shared by every sender of that bot —
 *   notification deliveries and the `send_telegram` action alike — and, with
 *   the Valkey pacer, by every worker process. The bucket key is the bot's
 *   numeric id (the prefix of its token, not a secret: CONTRACTS §22.7), so
 *   two secrets holding the same bot share one bucket;
 * - `chat`: at most {@link TELEGRAM_CHAT_MESSAGES_PER_SECOND} message per
 *   sliding second per personal chat (notification deliveries; the key is
 *   the channel id `uch_…`, never the chat id).
 *
 * Acquire the chat slot first, then the bot slot, so that a message waiting
 * for its chat does not hold a slot of the bot; release both once the call
 * ended (sent or failed).
 */
export interface TelegramSendPacers {
  readonly bot: SendPacer;
  readonly chat: SendPacer;
}

/** Longest wait for a slot of the shared (Valkey) pacers before giving up as temporary. */
export const TELEGRAM_PACER_MAX_WAIT_MS = 10_000;

/** Bucket key of the bot a token belongs to: `bot:<numeric id>`. */
export function telegramBotPacerKey(token: string): string {
  const colon = token.indexOf(':');
  const id = colon > 0 ? token.slice(0, colon) : '';
  // A token that does not match the Bot API shape never reaches Telegram; one bucket for all.
  return /^\d{1,20}$/u.test(id) ? `bot:${id}` : 'bot:invalid';
}

/** Bucket key of one personal channel. */
export function telegramChatPacerKey(channelId: string): string {
  return `chat:${channelId}`;
}

/** Pacers of this process only (tests, or a worker without Valkey). */
export function createMemoryTelegramPacers(clock?: Clock): TelegramSendPacers {
  return {
    bot: new MemorySendPacer({
      limit: TELEGRAM_BOT_MESSAGES_PER_SECOND,
      windowMs: 1000,
      ...(clock === undefined ? {} : { clock }),
    }),
    chat: new MemorySendPacer({
      limit: TELEGRAM_CHAT_MESSAGES_PER_SECOND,
      windowMs: 1000,
      ...(clock === undefined ? {} : { clock }),
    }),
  };
}

/**
 * Pacers shared by every process through Valkey (`ob:pace:telegram:bot:<id>`,
 * `ob:pace:telegram-chat:chat:<uch>`). A Valkey failure, or no slot within
 * `maxWaitMs`, throws `SendPacerUnavailableError` — temporary for callers.
 */
export function createValkeyTelegramPacers(
  client: QuotaClient,
  options: {
    readonly keyPrefix?: string;
    readonly maxWaitMs?: number;
    readonly clock?: Clock;
  } = {},
): TelegramSendPacers {
  const common = {
    windowMs: 1000,
    maxWaitMs: options.maxWaitMs ?? TELEGRAM_PACER_MAX_WAIT_MS,
    ...(options.keyPrefix === undefined ? {} : { keyPrefix: options.keyPrefix }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  };
  return {
    bot: createValkeySendPacer(client, {
      ...common,
      scope: 'telegram',
      limit: TELEGRAM_BOT_MESSAGES_PER_SECOND,
    }),
    chat: createValkeySendPacer(client, {
      ...common,
      scope: 'telegram-chat',
      limit: TELEGRAM_CHAT_MESSAGES_PER_SECOND,
    }),
  };
}
