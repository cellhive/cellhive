import {
  DEFAULT_EMAIL_FREQUENCY,
  isMandatoryNotificationType,
  newId,
  NOTIFICATION_DEFAULTS,
  NOTIFICATION_TELEGRAM_BATCH_MS,
  type Id,
  type NotificationChannel,
  type NotificationEntityType,
  type NotificationType,
} from '@cellhive/contracts';

import { OrganizationsRepository } from '../db/repositories/organizations.repository.js';
import { orgScope } from '../db/repository.js';
import { publishRealtime } from '../realtime/bus.js';
import { REALTIME_ENVELOPE_VERSION } from '../realtime/envelope.js';

import { orgTelegramSettingsOf } from './channels/telegram/org-telegram-settings.js';
import { UserChannelsRepository } from './channels/user-channels.repository.js';
import { NOTIFICATION_EMAIL_BATCH_MS, scheduleImmediateEmail } from './delivery/email-delivery.js';
import { scheduleTelegramDelivery } from './delivery/telegram-delivery.js';
import {
  NotificationBaseMutesRepository,
  NotificationPreferencesRepository,
  NotificationSettingsRepository,
} from './notification-preferences.repository.js';
import {
  NotificationDeliveriesRepository,
  NotificationsRepository,
  type NewNotification,
} from './notifications.repository.js';

import type { Db, Tx } from '../db/create-db.js';
import type { ActorType, JsonObject } from '../db/schema.js';

/** One notification for one recipient whose access was already checked. */
export interface PreparedNotification {
  readonly userId: Id<'usr'>;
  readonly type: NotificationType;
  readonly baseId: Id<'bse'> | null;
  readonly tableId: Id<'tbl'> | null;
  readonly entityType: NotificationEntityType;
  readonly entityId: string;
  readonly actor: { readonly type: ActorType; readonly id: string } | null;
  readonly groupKey: string | null;
  /** Stored parameters (ids), or the content rendered for this recipient (`automation.message`). */
  readonly data: JsonObject;
}

/** What happened to one prepared notification. */
export interface WrittenNotification {
  readonly userId: Id<'usr'>;
  /** `null`: nothing recorded (every channel off, or the `group_key` already exists). */
  readonly id: Id<'ntf'> | null;
  readonly inApp: boolean;
  /** An email delivery was queued (T512 sends it). */
  readonly emailQueued: boolean;
  /** A Telegram delivery was queued (T550 sends it). */
  readonly telegramQueued: boolean;
}

export interface NotificationWriterOptions {
  /** The instance has SMTP (`SMTP_URL`): without it no email is queued. */
  readonly emailEnabled: boolean;
  /**
   * Wait before an `immediate` recipient's email is sent, gathering what
   * arrives meanwhile (T512; default 5 minutes, ADR-29 §1).
   */
  readonly emailBatchMs?: number;
  /**
   * Wait before a recipient's Telegram message is sent, gathering what
   * arrives meanwhile (T550; default {@link NOTIFICATION_TELEGRAM_BATCH_MS}).
   */
  readonly telegramBatchMs?: number;
}

interface ChannelPlan {
  readonly inApp: boolean;
  readonly email: boolean;
  readonly telegram: boolean;
}

/**
 * Records notifications (ADR-29 §1, ADR-32 §1, ADR-34 §3, BACKLOG T511,
 * T550) in the caller's transaction, applying each recipient's choices:
 *
 * - in-app: the user's preference (default of the type), always on for a
 *   mandatory type (`automation.disabled`, `approval.task_assigned`);
 * - email: queued (`meta.notification_deliveries`, `pending`) when SMTP is
 *   configured, the preference allows it, the email frequency is not `off`
 *   and the base is not muted — a mute never silences a mandatory type;
 * - telegram: queued when the organization has a notification bot, the
 *   recipient's channel is `linked` through that bot, the Telegram
 *   preference of the type allows it (default = the email default) and the
 *   base is not muted (same mandatory exception); the email frequency does
 *   not apply. One `notifications.deliver` Telegram job per recipient, 5
 *   seconds after the first queued delivery;
 * - nothing at all on every channel → no row.
 *
 * After commit, each in-app row is announced on `user:<id>` with a
 * `notification.created` envelope (nothing on rollback). Recipients' access
 * is the caller's business (`NotificationFanout` checks it at send time;
 * deliveries check it again when they are sent).
 */
export class NotificationWriter {
  readonly #notifications: NotificationsRepository;
  readonly #deliveries: NotificationDeliveriesRepository;
  readonly #preferences: NotificationPreferencesRepository;
  readonly #settings: NotificationSettingsRepository;
  readonly #mutes: NotificationBaseMutesRepository;
  readonly #channels: UserChannelsRepository;
  readonly #organizations: OrganizationsRepository;

  constructor(
    private readonly db: Db,
    private readonly options: NotificationWriterOptions,
  ) {
    this.#notifications = new NotificationsRepository(db);
    this.#deliveries = new NotificationDeliveriesRepository(db);
    this.#preferences = new NotificationPreferencesRepository(db);
    this.#settings = new NotificationSettingsRepository(db);
    this.#mutes = new NotificationBaseMutesRepository(db);
    this.#channels = new UserChannelsRepository(db);
    this.#organizations = new OrganizationsRepository(db);
  }

  async write(
    tx: Tx,
    organizationId: Id<'org'>,
    items: readonly PreparedNotification[],
  ): Promise<WrittenNotification[]> {
    if (items.length === 0) return [];
    const scope = orgScope(organizationId, tx);
    const userIds = [...new Set(items.map((item) => item.userId))];
    const [preferences, settings, telegramUsers] = await Promise.all([
      this.#preferences.listForUsers(scope, userIds),
      this.#settings.listForUsers(scope, userIds),
      this.telegramRecipients(tx, organizationId, userIds),
    ]);
    const preference = new Map(
      preferences.map((row) => [`${row.user_id}|${row.type}|${row.channel}`, row.enabled]),
    );
    const frequency = new Map(settings.map((row) => [row.user_id, row.email_frequency]));
    const muted = new Map<Id<'bse'>, Set<Id<'usr'>>>();
    for (const baseId of new Set(
      items.flatMap((item) => (item.baseId === null ? [] : [item.baseId])),
    )) {
      const users = items.filter((item) => item.baseId === baseId).map((item) => item.userId);
      muted.set(baseId, await this.#mutes.mutedUsers(scope, baseId, users));
    }
    const enabled = (item: PreparedNotification, channel: NotificationChannel): boolean =>
      preference.get(`${item.userId}|${item.type}|${channel}`) ??
      NOTIFICATION_DEFAULTS[item.type][channel];

    const rows: NewNotification[] = [];
    const plan = new Map<Id<'ntf'>, ChannelPlan>();
    const results: WrittenNotification[] = [];
    for (const item of items) {
      const mandatory = isMandatoryNotificationType(item.type);
      const inApp = mandatory || enabled(item, 'in_app');
      const isMuted =
        !mandatory && item.baseId !== null && (muted.get(item.baseId)?.has(item.userId) ?? false);
      const email =
        this.options.emailEnabled &&
        enabled(item, 'email') &&
        !isMuted &&
        (frequency.get(item.userId) ?? DEFAULT_EMAIL_FREQUENCY) !== 'off';
      const telegram = telegramUsers.has(item.userId) && enabled(item, 'telegram') && !isMuted;
      if (!inApp && !email && !telegram) {
        results.push({
          userId: item.userId,
          id: null,
          inApp: false,
          emailQueued: false,
          telegramQueued: false,
        });
        continue;
      }
      const id = newId('ntf');
      plan.set(id, { inApp, email, telegram });
      rows.push({
        id,
        userId: item.userId,
        type: item.type,
        baseId: item.baseId,
        tableId: item.tableId,
        entityType: item.entityType,
        entityId: item.entityId,
        actor: item.actor,
        groupKey: item.groupKey,
        payload: item.data,
        inApp,
      });
    }

    const inserted = new Set((await this.#notifications.insertMany(scope, rows)).map((r) => r.id));
    const queuedOn = (channel: 'email' | 'telegram') =>
      rows.filter((row) => inserted.has(row.id) && plan.get(row.id)?.[channel] === true);
    const emailRows = queuedOn('email');
    const telegramRows = queuedOn('telegram');
    await this.#deliveries.queue(
      scope,
      'email',
      emailRows.map((row) => row.id),
    );
    await this.#deliveries.queue(
      scope,
      'telegram',
      telegramRows.map((row) => row.id),
    );
    // T512: one `notifications.deliver` per `immediate` recipient, 5 minutes
    // after the first queued email (later ones join it); `daily` recipients
    // wait for `notifications.daily_digest`.
    const now = Date.now();
    const emailRunAt = new Date(now + (this.options.emailBatchMs ?? NOTIFICATION_EMAIL_BATCH_MS));
    for (const userId of [...new Set(emailRows.map((row) => row.userId))].sort()) {
      if ((frequency.get(userId) ?? DEFAULT_EMAIL_FREQUENCY) !== 'immediate') continue;
      await scheduleImmediateEmail(tx, { organizationId, userId, runAt: emailRunAt });
    }
    // T550: one Telegram run per recipient, 5 seconds after the first queued
    // delivery (later ones join it: one message).
    const telegramRunAt = new Date(
      now + (this.options.telegramBatchMs ?? NOTIFICATION_TELEGRAM_BATCH_MS),
    );
    for (const userId of [...new Set(telegramRows.map((row) => row.userId))].sort()) {
      await scheduleTelegramDelivery(tx, { organizationId, userId, runAt: telegramRunAt });
    }
    for (const row of rows) {
      const written = inserted.has(row.id);
      const channels = plan.get(row.id);
      results.push({
        userId: row.userId,
        id: written ? row.id : null,
        inApp: written && channels?.inApp === true,
        emailQueued: written && channels?.email === true,
        telegramQueued: written && channels?.telegram === true,
      });
      if (!written || channels?.inApp !== true) continue;
      await publishRealtime(this.db, tx, {
        v: REALTIME_ENVELOPE_VERSION,
        type: 'notification.created',
        organization_id: organizationId,
        user_id: row.userId,
        notification_id: row.id,
        notification_type: row.type,
        base_id: row.baseId,
      });
    }
    return results;
  }

  /**
   * Recipients who may get a Telegram delivery: the organization has a
   * notification bot and their channel is linked through it (ADR-34 §3).
   */
  private async telegramRecipients(
    tx: Tx,
    organizationId: Id<'org'>,
    userIds: readonly Id<'usr'>[],
  ): Promise<Set<Id<'usr'>>> {
    const organization = await this.#organizations.findById(organizationId, tx);
    const bot = orgTelegramSettingsOf(organization?.settings);
    if (bot.secretId === null) return new Set();
    return this.#channels.linkedUsers(
      orgScope(organizationId, tx),
      userIds,
      'telegram',
      bot.secretId,
    );
  }
}
