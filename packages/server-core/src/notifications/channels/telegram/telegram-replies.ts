import { randomUUID } from 'node:crypto';

import {
  TELEGRAM_BOT_TOKEN_PATTERN,
  TELEGRAM_INVALID_REPLIES_PER_HOUR,
  type Id,
} from '@cellhive/contracts';

import { deriveSecretKey, unsealSecret } from '../../../auth/secret-box.js';
import { TelegramClient } from '../../../automation/actions/send-telegram/telegram-client.js';
import {
  telegramBotPacerKey,
  telegramChatPacerKey,
  type TelegramSendPacers,
} from '../../../automation/actions/send-telegram/telegram-pacer.js';
import { OrganizationsRepository } from '../../../db/repositories/organizations.repository.js';
import { orgScope } from '../../../db/repository.js';
import { enqueue } from '../../../jobs/enqueue.js';
import {
  SendPacerUnavailableError,
  type QuotaClient,
  type SendSlot,
} from '../../../mail/limits.js';
import { SecretsRepository } from '../../../secrets/secrets.repository.js';

import { TelegramChatAddress } from './chat-address.js';
import { orgTelegramSettingsOf } from './org-telegram-settings.js';
import { telegramLinkReply, type TelegramLinkReply } from './telegram-link-messages.js';

import type { TelegramClientOptions } from '../../../automation/actions/send-telegram/telegram-client.js';
import type { Db, Tx } from '../../../db/create-db.js';
import type { Buffer } from 'node:buffer';

/**
 * Replies of the notification bot to `/start` and `/stop` (BACKLOG T609,
 * ADR-35 §7, QA S5b M5): the poller and the webhook route never call
 * `sendMessage` themselves — they queue `notifications.telegram_reply` in
 * the transaction that handled the update, and the job sends it through
 * the bot's `TelegramSendPacers` (25 per second per bot, shared with
 * `send_telegram` and notification deliveries; 1 per second per chat). A
 * "link not valid" reply goes out at most
 * {@link TELEGRAM_INVALID_REPLIES_PER_HOUR} times per chat in a sliding hour
 * (Valkey), then the bot stays silent.
 *
 * The job payload carries the chat id **sealed** (same key as
 * `meta.user_channels.address_enc`), never in clear; nothing here logs or
 * returns a token, a chat id or a message.
 */

/** Payload of `notifications.telegram_reply` (CONTRACTS §12.2). */
export interface NotificationsTelegramReplyPayload {
  readonly organization_id: Id<'org'>;
  readonly secret_id: Id<'sec'>;
  /** Chat id sealed with `TelegramChatAddress.seal`. */
  readonly chat: string;
  readonly reply: TelegramLinkReply;
  /** Language of the reply (`en` or `vi`), resolved when the update was handled. */
  readonly language: 'en' | 'vi';
}

/** Attempts of a reply: a temporary failure (pacer, 5xx, timeout) is tried again twice. */
export const TELEGRAM_REPLY_MAX_ATTEMPTS = 3;

/** Queues one reply in the caller's transaction (the one that handled the update). */
export async function enqueueTelegramReply(
  tx: Tx,
  address: TelegramChatAddress,
  reply: {
    readonly organizationId: Id<'org'>;
    readonly secretId: Id<'sec'>;
    readonly chatId: string;
    readonly reply: TelegramLinkReply;
    readonly language: 'en' | 'vi';
  },
): Promise<void> {
  const payload: NotificationsTelegramReplyPayload = {
    organization_id: reply.organizationId,
    secret_id: reply.secretId,
    chat: address.seal(reply.chatId),
    reply: reply.reply,
    language: reply.language,
  };
  await enqueue(tx, 'notifications.telegram_reply', payload, {
    maxAttempts: TELEGRAM_REPLY_MAX_ATTEMPTS,
  });
}

// --- "Link not valid" cap per chat ----------------------------------------------------------

/** At most `limit` takes per key in any sliding `windowMs`. */
export interface TelegramReplyLimiter {
  /** Counts one reply for `key` when the window has room; `false` → stay silent. */
  take(key: string, now: Date): Promise<boolean>;
}

const HOUR_MS = 3_600_000;

/** The limiter of this process only (tests, or a worker without Valkey). */
export class MemoryTelegramReplyLimiter implements TelegramReplyLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #takes = new Map<string, number[]>();

  constructor(limit: number = TELEGRAM_INVALID_REPLIES_PER_HOUR, windowMs: number = HOUR_MS) {
    this.#limit = limit;
    this.#windowMs = windowMs;
  }

  take(key: string, now: Date): Promise<boolean> {
    const at = now.getTime();
    const recent = (this.#takes.get(key) ?? []).filter((time) => time > at - this.#windowMs);
    const allowed = recent.length < this.#limit;
    if (allowed) recent.push(at);
    if (recent.length === 0) this.#takes.delete(key);
    else this.#takes.set(key, recent);
    return Promise.resolve(allowed);
  }
}

/** Sliding log in a sorted set: trim, count, add — one atomic script. */
const TAKE_REPLY_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', tonumber(ARGV[1]) - tonumber(ARGV[2]))
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then return 0 end
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[4])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1
`;

/**
 * The limiter shared by every worker process (`ob:telegram:invalid-reply:<key>`).
 * Fails closed: when Valkey cannot be reached the reply is not sent (a lost
 * "not valid" answer is harmless; a spam burst is not).
 */
export function createValkeyTelegramReplyLimiter(
  client: QuotaClient,
  options: { readonly keyPrefix?: string; readonly limit?: number } = {},
): TelegramReplyLimiter {
  const prefix = options.keyPrefix ?? 'ob:';
  const limit = options.limit ?? TELEGRAM_INVALID_REPLIES_PER_HOUR;
  return {
    async take(key, now) {
      try {
        await client.ready?.();
        const result = await client.eval(
          TAKE_REPLY_SCRIPT,
          1,
          `${prefix}telegram:invalid-reply:${key}`,
          now.getTime(),
          HOUR_MS,
          limit,
          `${String(now.getTime())}:${randomUUID()}`,
        );
        return Number(result) === 1;
      } catch {
        return false;
      }
    },
  };
}

// --- Sending ---------------------------------------------------------------------------------

export type TelegramReplyOutcome =
  | 'sent'
  /** The secret is no longer the organization's notification bot (or its token is unusable). */
  | 'not_notification_bot'
  /** The sealed chat cannot be opened (another master key, altered payload). */
  | 'malformed'
  /** A "not valid" reply over the hourly cap of the chat: silence. */
  | 'capped'
  /** Telegram answered `429`: the reply is dropped, the bucket slows the next ones. */
  | 'rate_limited'
  /** Telegram refused it (blocked bot, chat gone…): not retried. */
  | 'rejected'
  /** No slot of the shared pacers, or Telegram did not answer: the job is retried. */
  | 'retry';

export interface TelegramReplySenderOptions {
  readonly masterKey: Buffer | string;
  readonly pacers: TelegramSendPacers;
  readonly limiter: TelegramReplyLimiter;
  readonly client?: TelegramClientOptions;
  readonly now?: () => Date;
}

/** Sends one queued reply (see the module comment). */
export class TelegramReplySender {
  readonly #options: TelegramReplySenderOptions;
  readonly #client: TelegramClient;
  readonly #secretKey: Buffer;
  readonly #address: TelegramChatAddress;
  readonly #organizations: OrganizationsRepository;
  readonly #secrets: SecretsRepository;
  readonly #now: () => Date;

  constructor(db: Db, options: TelegramReplySenderOptions) {
    this.#options = options;
    this.#client = new TelegramClient(options.client);
    this.#secretKey = deriveSecretKey(options.masterKey, 'org-secret');
    this.#address = new TelegramChatAddress(options.masterKey);
    this.#organizations = new OrganizationsRepository(db);
    this.#secrets = new SecretsRepository(db);
    this.#now = options.now ?? (() => new Date());
  }

  async send(payload: NotificationsTelegramReplyPayload): Promise<TelegramReplyOutcome> {
    const organization = await this.#organizations.findById(payload.organization_id);
    if (organization === undefined) return 'not_notification_bot';
    const bot = orgTelegramSettingsOf(organization.settings);
    if (bot.secretId !== payload.secret_id) return 'not_notification_bot';
    const secret = await this.#secrets.findById(
      orgScope(payload.organization_id),
      payload.secret_id,
    );
    if (secret?.kind !== 'telegram_bot') return 'not_notification_bot';
    let token: string;
    let chatId: string;
    try {
      token = unsealSecret(this.#secretKey, secret.ciphertext);
    } catch {
      return 'not_notification_bot';
    }
    if (!TELEGRAM_BOT_TOKEN_PATTERN.test(token)) return 'not_notification_bot';
    try {
      chatId = this.#address.unseal(payload.chat);
    } catch {
      return 'malformed';
    }
    // Pacer and cap key of the chat: its lookup HMAC under this bot, never the chat id.
    const chatKey = `reply:${this.#address.lookup(payload.secret_id, chatId)}`;
    const botKey = telegramBotPacerKey(token);
    if (
      payload.reply === 'invalid' &&
      !(await this.#options.limiter.take(`${botKey}:${chatKey}`, this.#now()))
    ) {
      return 'capped';
    }
    const slots: SendSlot[] = [];
    try {
      try {
        slots.push(await this.#options.pacers.chat.acquire(telegramChatPacerKey(chatKey)));
        slots.push(await this.#options.pacers.bot.acquire(botKey));
      } catch (error) {
        if (!(error instanceof SendPacerUnavailableError)) throw error;
        return 'retry';
      }
      const sent = await this.#client.sendMessage(token, {
        chatId,
        text: telegramLinkReply(payload.reply, payload.language),
      });
      if (sent.ok) return 'sent';
      if (sent.kind === 'rate_limited') return 'rate_limited';
      if (sent.kind === 'rejected') return 'rejected';
      return 'retry';
    } finally {
      for (const slot of slots.reverse()) await slot.release();
    }
  }
}
