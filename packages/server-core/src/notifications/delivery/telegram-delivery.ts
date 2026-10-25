import {
  NOTIFICATION_TELEGRAM_MAX_ATTEMPTS,
  TELEGRAM_BOT_TOKEN_PATTERN,
  type Id,
  type TelegramDeliveryFailureCode,
  type TelegramDeliverySkipCode,
} from '@cellhive/contracts';

import { deriveSecretKey, unsealSecret } from '../../auth/secret-box.js';
import {
  TelegramClient,
  type TelegramClientOptions,
  type TelegramSendResult,
} from '../../automation/actions/send-telegram/telegram-client.js';
import {
  telegramBotPacerKey,
  telegramChatPacerKey,
  type TelegramSendPacers,
} from '../../automation/actions/send-telegram/telegram-pacer.js';
import { OrgMembersRepository } from '../../db/repositories/org-members.repository.js';
import { OrganizationsRepository } from '../../db/repositories/organizations.repository.js';
import { UsersRepository } from '../../db/repositories/users.repository.js';
import { orgScope, type OrgScope } from '../../db/repository.js';
import { enqueue } from '../../jobs/enqueue.js';
import { SendPacerUnavailableError, type SendSlot } from '../../mail/limits.js';
import { SecretsRepository } from '../../secrets/secrets.repository.js';
import { publishChannelChanged } from '../channels/channel-events.js';
import { TelegramChatAddress } from '../channels/telegram/chat-address.js';
import { setNotificationBotStatus } from '../channels/telegram/notification-bot.js';
import { orgTelegramSettingsOf } from '../channels/telegram/org-telegram-settings.js';
import { UserChannelsRepository } from '../channels/user-channels.repository.js';

import { NotificationDeliveryChecker, type CheckedDelivery } from './delivery-check.js';
import {
  NotificationOutboxRepository,
  type PendingDelivery,
} from './notification-outbox.repository.js';
import { localeOf, timeZoneOf } from './recipient.js';
import { renderNotificationTelegram } from './telegram-templates.js';

import type { NotificationsDeliverPayload } from './email-delivery.js';
import type { Db, Tx } from '../../db/create-db.js';
import type { Organization, User } from '../../db/schema.js';
import type { AccessDefaults } from '../../import/member-access.js';
import type { RecordQueryService } from '../../records/record-query.service.js';
import type { Buffer } from 'node:buffer';

/** Pending Telegram deliveries read (and checked) per run; more → another run right after. */
export const NOTIFICATION_TELEGRAM_MAX_PENDING = 200;
/** Wait before trying again when the bot's sending limit stayed full (no attempt counted). */
export const NOTIFICATION_TELEGRAM_BUSY_RETRY_MS = 1_000;

/** One Telegram delivery job per recipient and organization (apart from the email one). */
export function notificationTelegramDeliverJobKey(
  organizationId: Id<'org'>,
  userId: Id<'usr'>,
): string {
  return `notifications.deliver:telegram:${organizationId}:${userId}`;
}

/** Payload of the Telegram run of `notifications.deliver`. */
export function telegramDeliverPayload(
  organizationId: Id<'org'>,
  userId: Id<'usr'>,
): NotificationsDeliverPayload {
  return {
    organization_id: organizationId,
    user_id: userId,
    reason: 'immediate',
    channel: 'telegram',
  };
}

/**
 * Schedules the Telegram delivery of `userId` in the caller's transaction
 * (ADR-34 §3): the first queued delivery sets the time
 * (`NOTIFICATION_TELEGRAM_BATCH_MS` later), later ones within that
 * window join the same job (`preserve_run_at`) — one message for them all.
 */
export async function scheduleTelegramDelivery(
  tx: Tx,
  input: {
    readonly organizationId: Id<'org'>;
    readonly userId: Id<'usr'>;
    readonly runAt: Date;
  },
): Promise<void> {
  await enqueue(
    tx,
    'notifications.deliver',
    telegramDeliverPayload(input.organizationId, input.userId),
    {
      runAt: input.runAt,
      jobKey: notificationTelegramDeliverJobKey(input.organizationId, input.userId),
      jobKeyMode: 'preserve_run_at',
    },
  );
}

export interface NotificationTelegramDeliveryOptions {
  /** `PUBLIC_URL`: links of the message. */
  readonly publicUrl: string;
  readonly defaults: AccessDefaults;
  /** `APP_MASTER_KEY`: the bot token (`org-secret`) and the chat id (`user-channel`) are sealed with keys derived from it. */
  readonly masterKey: Buffer | string;
  /** Per-bot (shared with `send_telegram`) and per-chat limits. */
  readonly pacers: TelegramSendPacers;
  /** Tests only: the fake Bot API. Production uses the fixed host. */
  readonly client?: TelegramClientOptions;
  readonly now?: () => Date;
}

type SkipCounts = Readonly<Partial<Record<TelegramDeliverySkipCode, number>>>;

/** What one run did (ids, counts and codes only: logged by the job). */
export type NotificationTelegramOutcome =
  | { readonly status: 'nothing' }
  | {
      readonly status: 'sent';
      /** Deliveries marked `sent` (the counted ones included). */
      readonly sent: number;
      /** Items shown in full in the message. */
      readonly shown: number;
      readonly skipped: SkipCounts;
      readonly more: boolean;
    }
  | { readonly status: 'skipped'; readonly skipped: SkipCounts; readonly more: boolean }
  | {
      readonly status: 'failed';
      readonly failed: number;
      readonly code: TelegramDeliveryFailureCode;
      readonly skipped: SkipCounts;
      /** Telegram refused the chat: the channel went to `error` (`blocked`). */
      readonly channelError: boolean;
      readonly more: boolean;
    }
  /** Telegram (`429`) or the shared limit asked to wait: a run is scheduled at `retryAt`. */
  | {
      readonly status: 'deferred';
      readonly pending: number;
      readonly retryAt: Date;
      readonly reason: 'rate_limited' | 'busy';
    }
  /** Temporary failure (5xx, timeout, limit unreachable): the job must throw so it is retried. */
  | {
      readonly status: 'retry';
      readonly attempts: number;
      readonly cause: 'timeout' | 'network' | 'server_error' | 'rate_limit_unavailable';
    };

/**
 * A temporary failure of a Telegram delivery, thrown by the job (after the
 * attempt was recorded) so that graphile-worker retries. Carries the cause
 * only: never the token, the chat id or the message.
 */
export class NotificationTelegramRetryError extends Error {
  constructor(readonly reason: string) {
    super(`Telegram notification delivery failed temporarily (${reason}).`);
    this.name = 'NotificationTelegramRetryError';
  }
}

/**
 * Sends the pending Telegram notifications of one recipient (BACKLOG T550;
 * ADR-34 §3, ADR-29 §1, ADR-32 §1) — the Telegram run of
 * `notifications.deliver`:
 *
 * 1. locks the recipient's `pending` Telegram deliveries (one run per
 *    recipient at a time; `ntf_id:telegram` leaves `pending` once);
 * 2. the organization must still have its notification bot (else
 *    `telegram_not_configured`), the recipient must be an active member
 *    (`not_member`) whose channel is `linked` through that very bot
 *    (`channel_error`);
 * 3. checks each delivery **now** like the email (T512): Telegram
 *    preference of the type, base mute (never for a mandatory type), reads
 *    the base, the record, the fields of the type — the rest is left out
 *    without a trace in the message. The email frequency does not apply;
 * 4. renders one message (≤ 10 items in full, ≤ 4,096 characters, the
 *    rest counted with a link to the organization) in the recipient's
 *    language, takes a slot of the chat (1 per second) and of the bot (25
 *    per second, shared with `send_telegram`) and calls `sendMessage`;
 * 5. `429` → the deliveries stay `pending`, a run is scheduled after
 *    `retry_after`; 5xx/timeout → `attempts + 1` and retried, `failed`
 *    (`telegram_unavailable`) on the 5th; `403`/`400 chat not found` →
 *    `failed` (`telegram_blocked`), the channel goes to `error` (`blocked`,
 *    `channel.changed` after commit) and the recipient's other pending
 *    deliveries are `skipped` (`channel_error`) — not retried; other 4xx →
 *    `failed` (`telegram_rejected`); `401` → `failed`
 *    (`telegram_invalid_token`) and the bot's status `invalid_token`.
 *
 * The bot token and the chat id are unsealed in memory only; nothing here
 * returns, throws or logs them, nor the text of the message.
 */
export class NotificationTelegramDelivery {
  readonly #outbox: NotificationOutboxRepository;
  readonly #checker: NotificationDeliveryChecker;
  readonly #client: TelegramClient;
  readonly #secretKey: Buffer;
  readonly #address: TelegramChatAddress;
  readonly #now: () => Date;

  constructor(
    private readonly db: Db,
    query: RecordQueryService,
    private readonly options: NotificationTelegramDeliveryOptions,
  ) {
    this.#outbox = new NotificationOutboxRepository(db, 'telegram');
    this.#now = options.now ?? (() => new Date());
    this.#checker = new NotificationDeliveryChecker(db, query, {
      publicUrl: options.publicUrl,
      defaults: options.defaults,
      now: this.#now,
    });
    this.#client = new TelegramClient(options.client);
    this.#secretKey = deriveSecretKey(options.masterKey, 'org-secret');
    this.#address = new TelegramChatAddress(options.masterKey);
  }

  deliver(payload: NotificationsDeliverPayload): Promise<NotificationTelegramOutcome> {
    return this.db.withTx((tx) => this.deliverIn(tx, payload));
  }

  private async deliverIn(
    tx: Tx,
    payload: NotificationsDeliverPayload,
  ): Promise<NotificationTelegramOutcome> {
    const organizationId = payload.organization_id;
    const userId = payload.user_id;
    const scope = orgScope(organizationId, tx);

    const rows = await this.#outbox.lockPending(
      scope,
      userId,
      NOTIFICATION_TELEGRAM_MAX_PENDING + 1,
    );
    if (rows.length === 0) return { status: 'nothing' };
    const more = rows.length > NOTIFICATION_TELEGRAM_MAX_PENDING;
    const batch = rows.slice(0, NOTIFICATION_TELEGRAM_MAX_PENDING);

    const skipped: Partial<Record<TelegramDeliverySkipCode, number>> = {};
    const skip = async (items: readonly PendingDelivery[], code: TelegramDeliverySkipCode) => {
      if (items.length === 0) return;
      const count = await this.#outbox.markSkipped(
        scope,
        items.map((row) => row.notification_id),
        code,
      );
      skipped[code] = (skipped[code] ?? 0) + count;
    };
    const finishSkipped = async (): Promise<NotificationTelegramOutcome> => {
      if (more) await this.scheduleNext(tx, organizationId, userId);
      return { status: 'skipped', skipped, more };
    };

    const organization = await new OrganizationsRepository(this.db).findById(organizationId);
    const bot = orgTelegramSettingsOf(organization?.settings);
    if (organization === undefined || bot.secretId === null) {
      await skip(batch, 'telegram_not_configured');
      return finishSkipped();
    }
    const [user, member] = await Promise.all([
      new UsersRepository(this.db).findById(userId),
      new OrgMembersRepository(this.db).get(scope, userId),
    ]);
    if (user?.status !== 'active' || member === undefined) {
      await skip(batch, 'not_member');
      return finishSkipped();
    }
    const channels = new UserChannelsRepository(this.db);
    const channel = await channels.findLinked(scope, userId, 'telegram');
    if (channel === undefined || channel.secret_id !== bot.secretId) {
      await skip(batch, 'channel_error');
      return finishSkipped();
    }

    const { kept, dropped } = await this.#checker.check(scope, user, batch, 'telegram');
    for (const [code, items] of dropped) await skip(items, code);
    if (kept.length === 0) return finishSkipped();
    const ids = kept.map((entry) => entry.row.notification_id);

    // The bot token and the chat, in memory only.
    const secret = await new SecretsRepository(this.db).findById(scope, bot.secretId);
    if (secret?.kind !== 'telegram_bot') {
      await skip(
        kept.map((entry) => entry.row),
        'telegram_not_configured',
      );
      return finishSkipped();
    }
    let token: string;
    try {
      token = unsealSecret(this.#secretKey, secret.ciphertext);
    } catch {
      token = '';
    }
    if (!TELEGRAM_BOT_TOKEN_PATTERN.test(token)) {
      return this.fail(tx, scope, payload, ids, 'telegram_invalid_token', skipped, more);
    }
    let chatId: string;
    try {
      chatId = this.#address.unseal(channel.address_enc);
    } catch {
      // Sealed under another master key: the member links again.
      await skip(
        kept.map((entry) => entry.row),
        'channel_error',
      );
      return finishSkipped();
    }

    const text = this.render(organization, user, kept);
    const sent = await this.send(token, channel.id, chatId, text);
    if (sent === 'busy') {
      const retryAt = new Date(this.#now().getTime() + NOTIFICATION_TELEGRAM_BUSY_RETRY_MS);
      await this.reschedule(tx, organizationId, userId, retryAt);
      return { status: 'deferred', pending: ids.length, retryAt, reason: 'busy' };
    }
    if (sent === 'pacer_unavailable') {
      return this.onTemporary(tx, scope, payload, ids, 'rate_limit_unavailable', skipped, more);
    }
    if (sent.ok) {
      const count = await this.#outbox.markSent(scope, ids, this.#now());
      if (more) await this.scheduleNext(tx, organizationId, userId);
      return {
        status: 'sent',
        sent: count,
        shown: Math.min(text.shown, kept.length),
        skipped,
        more,
      };
    }
    switch (sent.kind) {
      case 'rate_limited': {
        const retryAt = new Date(this.#now().getTime() + sent.retryAfterMs);
        await this.reschedule(tx, organizationId, userId, retryAt);
        return { status: 'deferred', pending: ids.length, retryAt, reason: 'rate_limited' };
      }
      case 'unavailable':
        return this.onTemporary(tx, scope, payload, ids, sent.cause, skipped, more);
      case 'rejected':
        return this.onRejected(tx, scope, payload, ids, sent, skipped, more, bot.secretId);
    }
  }

  /** The message in the recipient's language and time zone. */
  private render(
    organization: Organization,
    user: User,
    kept: readonly CheckedDelivery[],
  ): { text: string; shown: number } {
    const root = this.options.publicUrl.replace(/\/+$/, '');
    const orgUrl = `${root}/o/${encodeURIComponent(organization.slug)}`;
    const rendered = renderNotificationTelegram({
      locale: localeOf(user, organization, this.options.defaults),
      timeZone: timeZoneOf(user, organization, this.options.defaults),
      organizationName: organization.name,
      items: kept.map((entry) => entry.item),
      moreUrl: orgUrl,
      manageUrl: `${orgUrl}/settings/notifications`,
    });
    return { text: rendered.text, shown: rendered.shown };
  }

  /**
   * One `sendMessage` within the chat's and the bot's limits; `busy` when no
   * slot of the shared limit became free in time, `pacer_unavailable` when
   * the limit cannot be reached (Valkey).
   */
  private async send(
    token: string,
    channelId: string,
    chatId: string,
    message: { readonly text: string },
  ): Promise<TelegramSendResult | 'busy' | 'pacer_unavailable'> {
    const slots: SendSlot[] = [];
    try {
      try {
        slots.push(await this.options.pacers.chat.acquire(telegramChatPacerKey(channelId)));
        slots.push(await this.options.pacers.bot.acquire(telegramBotPacerKey(token)));
      } catch (error) {
        if (!(error instanceof SendPacerUnavailableError)) throw error;
        return error.reason === 'timeout' ? 'busy' : 'pacer_unavailable';
      }
      return await this.#client.sendMessage(token, { chatId, text: message.text });
    } finally {
      for (const slot of slots.reverse()) await slot.release();
    }
  }

  private async onTemporary(
    tx: Tx,
    scope: OrgScope,
    payload: NotificationsDeliverPayload,
    ids: readonly Id<'ntf'>[],
    cause: 'timeout' | 'network' | 'server_error' | 'rate_limit_unavailable',
    skipped: SkipCounts,
    more: boolean,
  ): Promise<NotificationTelegramOutcome> {
    const attempts = await this.#outbox.recordAttempt(scope, ids, 'telegram_unavailable');
    if (attempts < NOTIFICATION_TELEGRAM_MAX_ATTEMPTS) return { status: 'retry', attempts, cause };
    return this.fail(tx, scope, payload, ids, 'telegram_unavailable', skipped, more);
  }

  private async onRejected(
    tx: Tx,
    scope: OrgScope,
    payload: NotificationsDeliverPayload,
    ids: readonly Id<'ntf'>[],
    sent: Extract<TelegramSendResult, { kind: 'rejected' }>,
    skipped: Partial<Record<TelegramDeliverySkipCode, number>>,
    more: boolean,
    secretId: Id<'sec'>,
  ): Promise<NotificationTelegramOutcome> {
    if (sent.refusal !== null) {
      // The user blocked the bot or the chat is gone: nothing more goes there.
      const failed = await this.#outbox.markFailed(scope, ids, 'telegram_blocked');
      const rest = await this.#outbox.skipAllPending(scope, payload.user_id, 'channel_error');
      if (rest > 0) skipped.channel_error = (skipped.channel_error ?? 0) + rest;
      const changed = await new UserChannelsRepository(this.db).markError(
        scope,
        payload.user_id,
        'telegram',
        'blocked',
      );
      if (changed) {
        await publishChannelChanged(this.db, tx, {
          organizationId: payload.organization_id,
          userId: payload.user_id,
          kind: 'telegram',
          status: 'error',
        });
      }
      return {
        status: 'failed',
        failed,
        code: 'telegram_blocked',
        skipped,
        channelError: true,
        more: false,
      };
    }
    if (sent.status === 401 || sent.status === 404) {
      await setNotificationBotStatus(this.db, payload.organization_id, secretId, 'invalid_token');
      return this.fail(tx, scope, payload, ids, 'telegram_invalid_token', skipped, more);
    }
    return this.fail(tx, scope, payload, ids, 'telegram_rejected', skipped, more);
  }

  private async fail(
    tx: Tx,
    scope: OrgScope,
    payload: NotificationsDeliverPayload,
    ids: readonly Id<'ntf'>[],
    code: TelegramDeliveryFailureCode,
    skipped: SkipCounts,
    more: boolean,
  ): Promise<NotificationTelegramOutcome> {
    const failed = await this.#outbox.markFailed(scope, ids, code);
    if (more) await this.scheduleNext(tx, payload.organization_id, payload.user_id);
    return { status: 'failed', failed, code, skipped, channelError: false, more };
  }

  /** A run at `runAt` replacing the waiting one (Telegram or the limit asked to wait). */
  private async reschedule(
    tx: Tx,
    organizationId: Id<'org'>,
    userId: Id<'usr'>,
    runAt: Date,
  ): Promise<void> {
    await enqueue(tx, 'notifications.deliver', telegramDeliverPayload(organizationId, userId), {
      runAt,
      jobKey: notificationTelegramDeliverJobKey(organizationId, userId),
    });
  }

  /** More pending deliveries than one run reads: another run right away. */
  private async scheduleNext(tx: Tx, organizationId: Id<'org'>, userId: Id<'usr'>): Promise<void> {
    await enqueue(tx, 'notifications.deliver', telegramDeliverPayload(organizationId, userId), {
      jobKey: notificationTelegramDeliverJobKey(organizationId, userId),
    });
  }
}
