import { newId, TELEGRAM_LINK_TOKEN_PATTERN, type Id } from '@cellhive/contracts';

import { hashToken } from '../../../auth/tokens.js';
import { OrganizationsRepository } from '../../../db/repositories/organizations.repository.js';
import { UsersRepository } from '../../../db/repositories/users.repository.js';
import { orgScope } from '../../../db/repository.js';
import { localeOf } from '../../delivery/recipient.js';
import { auditUserChannel, publishChannelChanged, telegramChatContext } from '../channel-events.js';
import { UserChannelLinkTokensRepository } from '../user-channel-link-tokens.repository.js';
import { UserChannelsRepository } from '../user-channels.repository.js';

import { TelegramChatAddress } from './chat-address.js';
import { replyLanguageOf, type TelegramLinkReply } from './telegram-link-messages.js';
import { enqueueTelegramReply } from './telegram-replies.js';

import type { TelegramUpdate } from '../../../automation/actions/send-telegram/telegram-bot-api.js';
import type { Db, Tx } from '../../../db/create-db.js';
import type { AccessDefaults } from '../../../import/member-access.js';
import type { Buffer } from 'node:buffer';

/**
 * What one Telegram update did (BACKLOG T549, T609): `linked` (a member's
 * channel), `relinked` (a used token from the very chat it linked — the
 * update came again; answered like a success, not audited twice),
 * `refused` (a `/start` answered "not valid"), `stopped` (`/stop` removed
 * channels), `ignored` (anything else: groups, other messages, `/stop` from
 * a chat that is not linked).
 */
export type TelegramUpdateOutcome = 'linked' | 'relinked' | 'refused' | 'stopped' | 'ignored';

/** The notification bot an update came to. */
export interface TelegramBotContext {
  readonly organizationId: Id<'org'>;
  readonly secretId: Id<'sec'>;
}

export interface TelegramUpdateHandlerOptions {
  /** `APP_MASTER_KEY`: the `user-channel*` keys are derived from it. */
  readonly masterKey: Buffer | string;
  readonly defaults: AccessDefaults;
  /** Clock of token expiry (tests inject it). */
  readonly now?: () => Date;
}

const START_COMMAND = /^\/start(?:@[A-Za-z0-9_]+)?(?:[ \t]+(\S+))?\s*$/u;
const STOP_COMMAND = /^\/stop(?:@[A-Za-z0-9_]+)?\s*$/u;

/**
 * Handles `/start <token>` and `/stop` sent to an organization's
 * notification bot — the same logic for the poller (`getUpdates`) and the
 * webhook route (BACKLOG T609, ADR-35 §7; CONTRACTS §22.7). One update is
 * one transaction: the channel change, its audit, `channel.changed` after
 * commit and the queued reply (`notifications.telegram_reply`, which goes
 * through the bot's pacers and the "not valid" cap) commit together.
 *
 * Only private chats count. `/start <token>`: a pending token of this
 * organization and bot (by SHA-256) links the member's channel (chat id
 * sealed), marks the token used, cancels the member's other pending links,
 * audits `user_channel.linked`; anything else (unknown, used, expired, of
 * another bot, inactive member) gets the same fixed "not valid" reply.
 * `/stop` from a linked chat removes its channels (audit, realtime, fixed
 * reply). Nothing is logged or returned but the outcome.
 */
export class TelegramUpdateHandler {
  readonly #db: Db;
  readonly #options: TelegramUpdateHandlerOptions;
  readonly #address: TelegramChatAddress;
  readonly #now: () => Date;
  readonly #tokens: UserChannelLinkTokensRepository;
  readonly #channels: UserChannelsRepository;
  readonly #organizations: OrganizationsRepository;
  readonly #users: UsersRepository;

  constructor(db: Db, options: TelegramUpdateHandlerOptions) {
    this.#db = db;
    this.#options = options;
    this.#address = new TelegramChatAddress(options.masterKey);
    this.#now = options.now ?? (() => new Date());
    this.#tokens = new UserChannelLinkTokensRepository(db);
    this.#channels = new UserChannelsRepository(db);
    this.#organizations = new OrganizationsRepository(db);
    this.#users = new UsersRepository(db);
  }

  async handle(bot: TelegramBotContext, update: TelegramUpdate): Promise<TelegramUpdateOutcome> {
    const message = update.message;
    if (message?.chatType !== 'private') return 'ignored';
    const start = START_COMMAND.exec(message.text);
    if (start !== null) {
      const payload = start[1] ?? '';
      return this.#db.withTx(async (tx) => {
        const linked = TELEGRAM_LINK_TOKEN_PATTERN.test(payload)
          ? await this.#link(tx, bot, message.chatId, payload)
          : null;
        if (linked === null) {
          const organization = await this.#organizations.findById(bot.organizationId, tx);
          const language = replyLanguageOf(
            message.languageCode ??
              localeOf({ locale: null }, organization, this.#options.defaults),
          );
          await this.#reply(tx, bot, message.chatId, 'invalid', language);
          return 'refused';
        }
        await this.#reply(
          tx,
          bot,
          message.chatId,
          'linked',
          await this.#languageOf(tx, bot, linked.userId),
        );
        return linked.fresh ? 'linked' : 'relinked';
      });
    }
    if (STOP_COMMAND.test(message.text)) {
      return this.#db.withTx(async (tx) => {
        const userId = await this.#stop(tx, bot, message.chatId);
        if (userId === null) return 'ignored';
        await this.#reply(
          tx,
          bot,
          message.chatId,
          'stopped',
          await this.#languageOf(tx, bot, userId),
        );
        return 'stopped';
      });
    }
    return 'ignored';
  }

  /**
   * Links the chat to the member who holds `token`; `null` when the token is
   * not a pending one of this organization and bot. A used token whose
   * member is already linked to this very chat answers like a success.
   */
  async #link(
    tx: Tx,
    bot: TelegramBotContext,
    chatId: string,
    token: string,
  ): Promise<{ userId: Id<'usr'>; fresh: boolean } | null> {
    const { organizationId, secretId } = bot;
    const addressHmac = this.#address.lookup(secretId, chatId);
    const scope = orgScope(organizationId, tx);
    const row = await this.#tokens.lockByHash(scope, hashToken(token));
    if (row?.secret_id !== secretId) return null;
    const now = this.#now();
    if (row.used_at !== null) {
      const same = await this.#channels.isLinkedTo(
        scope,
        row.user_id,
        'telegram',
        secretId,
        addressHmac,
      );
      return same ? { userId: row.user_id, fresh: false } : null;
    }
    if (row.expires_at.getTime() <= now.getTime()) return null;
    const user = await this.#users.findById(row.user_id, tx);
    if (user?.status !== 'active') return null;
    await this.#tokens.markUsed(scope, row.token_hash, now);
    // The other pending links of the member are spent too: one chat per member.
    await this.#tokens.cancelPending(scope, row.user_id, now);
    await this.#channels.upsertLinked(scope, {
      id: newId('uch'),
      userId: row.user_id,
      kind: 'telegram',
      secretId,
      addressEnc: this.#address.seal(chatId),
      addressHmac,
      linkedAt: now,
    });
    await auditUserChannel(tx, {
      action: 'user_channel.linked',
      organizationId,
      userId: row.user_id,
      kind: 'telegram',
      source: 'telegram_start',
      context: telegramChatContext(row.user_id),
    });
    await publishChannelChanged(this.#db, tx, {
      organizationId,
      userId: row.user_id,
      kind: 'telegram',
      status: 'linked',
    });
    return { userId: row.user_id, fresh: true };
  }

  /** Removes the channels linked to this chat of this bot; the first member, or `null`. */
  async #stop(tx: Tx, bot: TelegramBotContext, chatId: string): Promise<Id<'usr'> | null> {
    const { organizationId, secretId } = bot;
    const scope = orgScope(organizationId, tx);
    const rows = await this.#channels.deleteByAddress(
      scope,
      secretId,
      this.#address.lookup(secretId, chatId),
    );
    for (const row of rows) {
      await auditUserChannel(tx, {
        action: 'user_channel.unlinked',
        organizationId,
        userId: row.user_id,
        kind: 'telegram',
        source: 'telegram_stop',
        context: telegramChatContext(row.user_id),
      });
      await publishChannelChanged(this.#db, tx, {
        organizationId,
        userId: row.user_id,
        kind: 'telegram',
        status: 'unlinked',
      });
    }
    return rows[0]?.user_id ?? null;
  }

  async #languageOf(tx: Tx, bot: TelegramBotContext, userId: Id<'usr'>): Promise<'en' | 'vi'> {
    const [user, organization] = await Promise.all([
      this.#users.findById(userId, tx),
      this.#organizations.findById(bot.organizationId, tx),
    ]);
    return replyLanguageOf(
      localeOf(user ?? { locale: null }, organization, this.#options.defaults),
    );
  }

  async #reply(
    tx: Tx,
    bot: TelegramBotContext,
    chatId: string,
    reply: TelegramLinkReply,
    language: 'en' | 'vi',
  ): Promise<void> {
    await enqueueTelegramReply(tx, this.#address, {
      organizationId: bot.organizationId,
      secretId: bot.secretId,
      chatId,
      reply,
      language,
    });
  }
}
