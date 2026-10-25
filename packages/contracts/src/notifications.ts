import { z } from 'zod';

import { booleanQueryParam, isoDateTimeSchema } from './common.js';
import { ACTOR_TYPES } from './events.js';
import { idOf } from './ids.js';
import {
  dateReminderDataSchema,
  importFinishedDataSchema,
  recordAssignedDataSchema,
  recordFollowedChangedDataSchema,
} from './notification-types/index.js';
import { cursorListSchema, cursorQuerySchema } from './pagination.js';

export * from './notification-types/index.js';

/**
 * In-app notifications (CONTRACTS §22; ADR-29 §1, ADR-32 §1; BACKLOG T511):
 * the closed catalogue of types, channels, per-user preferences, base mutes,
 * email frequency settings, and the `/orgs/:orgId/me/notifications…` API.
 */

/**
 * Every notification type (closed list: adding one means changing CONTRACTS
 * §22 and this enum together). Types of later sprints are declared now so
 * that stored preferences never need a migration; only
 * {@link ACTIVE_NOTIFICATION_TYPES} are produced in S5.
 */
export const NOTIFICATION_TYPES = [
  'automation.disabled',
  'automation.batch_overflow',
  'automation.message',
  // S5b
  'record.assigned',
  'record.followed_changed',
  'date.reminder',
  'import.finished',
  // S10
  'approval.task_assigned',
  'approval.reminder',
  'approval.completed',
  'approval.cc',
  // S11
  'comment.mentioned',
  'comment.replied',
] as const;
export const notificationTypeSchema = z.enum(NOTIFICATION_TYPES);
export type NotificationType = z.infer<typeof notificationTypeSchema>;

/** Types produced from S5 on (the others are reserved, ADR-29 §1). */
export const ACTIVE_NOTIFICATION_TYPES = [
  'automation.disabled',
  'automation.batch_overflow',
  'automation.message',
  // S5b, one line per producing task.
  'record.assigned',
  'date.reminder',
  'import.finished',
  'record.followed_changed',
] as const satisfies readonly NotificationType[];

/**
 * Types whose in-app notification cannot be turned off, and which a base
 * mute does not silence on any channel (ADR-29 §1, ADR-32 §1).
 */
export const MANDATORY_NOTIFICATION_TYPES = [
  'automation.disabled',
  'approval.task_assigned',
] as const satisfies readonly NotificationType[];

export function isMandatoryNotificationType(type: NotificationType): boolean {
  return (MANDATORY_NOTIFICATION_TYPES as readonly NotificationType[]).includes(type);
}

/**
 * Delivery channels. `in_app` always exists; `email` needs the instance SMTP
 * (sent by T512); `telegram` needs the organization's notification bot and a
 * linked personal channel (`meta.user_channels`, T549; sent by T550).
 */
export const NOTIFICATION_CHANNELS = ['in_app', 'email', 'telegram'] as const;
export const notificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);
export type NotificationChannel = z.infer<typeof notificationChannelSchema>;

/**
 * Channel defaults of each type, used when the user stored no preference.
 * `telegram` follows the email default of the type (CONTRACTS §22.1, T550).
 */
export const NOTIFICATION_DEFAULTS: Readonly<
  Record<NotificationType, Readonly<Record<NotificationChannel, boolean>>>
> = {
  'automation.disabled': { in_app: true, email: true, telegram: true },
  'automation.batch_overflow': { in_app: true, email: true, telegram: true },
  'automation.message': { in_app: true, email: true, telegram: true },
  'record.assigned': { in_app: true, email: true, telegram: true },
  'record.followed_changed': { in_app: true, email: false, telegram: false },
  'date.reminder': { in_app: true, email: true, telegram: true },
  'import.finished': { in_app: true, email: false, telegram: false },
  'approval.task_assigned': { in_app: true, email: true, telegram: true },
  'approval.reminder': { in_app: true, email: true, telegram: true },
  'approval.completed': { in_app: true, email: true, telegram: true },
  'approval.cc': { in_app: true, email: false, telegram: false },
  'comment.mentioned': { in_app: true, email: true, telegram: true },
  'comment.replied': { in_app: true, email: false, telegram: false },
};

// ---------------------------------------------------------------------------
// Telegram delivery (CONTRACTS §22.4, ADR-34 §3, BACKLOG T550)

/**
 * Wait before a recipient's pending Telegram notifications are sent, gathering
 * what arrives meanwhile into one message (`preserve_run_at` debounce).
 */
export const NOTIFICATION_TELEGRAM_BATCH_MS = 5_000;
/** Notifications shown in one Telegram message; the others are counted ("and N more"). */
export const NOTIFICATION_TELEGRAM_MAX_ITEMS = 10;
/** Longest Telegram message in characters (UTF-16 units of the visible text, Bot API). */
export const NOTIFICATION_TELEGRAM_MAX_CHARS = 4_096;
/** Attempts of a delivery that keeps failing temporarily (5xx, timeout) before it is `failed`. */
export const NOTIFICATION_TELEGRAM_MAX_ATTEMPTS = 5;
/**
 * Messages per sliding second per bot, **shared** by notification deliveries
 * and the `send_telegram` action (T516, T550).
 */
export const TELEGRAM_BOT_MESSAGES_PER_SECOND = 25;
/** Messages per sliding second to one personal chat. */
export const TELEGRAM_CHAT_MESSAGES_PER_SECOND = 1;

/**
 * Why a queued Telegram delivery was not sent (`error_code` of a `skipped`
 * row): the email reasons that apply (CONTRACTS §22.4), plus
 * `telegram_not_configured` (the organization has no notification bot any
 * more) and `channel_error` (the recipient's channel is not linked to the
 * current bot: removed, in `error`, or refused by Telegram earlier in the
 * same run).
 */
export const TELEGRAM_DELIVERY_SKIP_CODES = [
  'telegram_not_configured',
  'channel_error',
  'preference_off',
  'muted',
  'not_member',
  'cannot_read_base',
  'cannot_read_record',
  'cannot_read_field',
  'unsupported_type',
] as const;
export type TelegramDeliverySkipCode = (typeof TELEGRAM_DELIVERY_SKIP_CODES)[number];

/**
 * Why a queued Telegram delivery `failed` (`error_code`; never retried after):
 * `telegram_blocked` (`403`, or `400` "chat not found": the user blocked the
 * bot or the chat is gone — the channel goes to `error` `blocked`),
 * `telegram_rejected` (another 4xx), `telegram_invalid_token` (`401`/`404`,
 * or the bot token cannot be read), `telegram_unavailable` (5xx, timeout or
 * network on the 5th attempt).
 */
export const TELEGRAM_DELIVERY_FAILURE_CODES = [
  'telegram_blocked',
  'telegram_rejected',
  'telegram_invalid_token',
  'telegram_unavailable',
] as const;
export type TelegramDeliveryFailureCode = (typeof TELEGRAM_DELIVERY_FAILURE_CODES)[number];

/** What a notification is about (`entity_type`). */
export const NOTIFICATION_ENTITY_TYPES = ['automation', 'record', 'table', 'base', 'job'] as const;
export const notificationEntityTypeSchema = z.enum(NOTIFICATION_ENTITY_TYPES);
export type NotificationEntityType = z.infer<typeof notificationEntityTypeSchema>;

/** How often notification emails are sent (ADR-32 §1). */
export const EMAIL_FREQUENCIES = ['immediate', 'daily', 'off'] as const;
export const emailFrequencySchema = z.enum(EMAIL_FREQUENCIES);
export type EmailFrequency = z.infer<typeof emailFrequencySchema>;

export const DEFAULT_EMAIL_FREQUENCY: EmailFrequency = 'immediate';
/** Hour of the daily digest in the user's time zone (ADR-32 §1, design decision S5 #7). */
export const DEFAULT_DAILY_DIGEST_HOUR = 8;
/**
 * Following records automatically (CONTRACTS §22.5, T543): records the person
 * creates by hand (`auto_follow_created`) and records they are assigned to
 * through a `user` field with `notify_on_assign` (`auto_follow_assigned`,
 * T544). Both on unless the person turns them off.
 */
export const DEFAULT_AUTO_FOLLOW_CREATED = true;
export const DEFAULT_AUTO_FOLLOW_ASSIGNED = true;

/** `unread-count` stops counting here (the bell shows `999+`). */
export const NOTIFICATION_UNREAD_COUNT_CAP = 1000;
/** Most ids of one `POST …/notifications/read`. */
export const MAX_NOTIFICATION_READ_IDS = 200;
/** `automation.message` limits (ADR-32 §1). */
export const AUTOMATION_MESSAGE_TITLE_MAX = 200;
export const AUTOMATION_MESSAGE_BODY_MAX = 2000;

// ---------------------------------------------------------------------------
// Stored `data` of each produced type: ids and stored-form parameters only
// (ADR-29 §1), except the rendered content of `automation.message` (ADR-32 §1).

export const automationDisabledDataSchema = z.strictObject({
  automation_id: idOf('aut'),
  reason: z.enum(['circuit_breaker', 'run_as_lost_access']),
});
export type AutomationDisabledData = z.infer<typeof automationDisabledDataSchema>;

export const automationBatchOverflowDataSchema = z.strictObject({
  automation_id: idOf('aut'),
  run_id: idOf('run'),
  batch_id: z.string().min(1).max(64),
  limit: z.int().min(1),
});
export type AutomationBatchOverflowData = z.infer<typeof automationBatchOverflowDataSchema>;

export const automationMessageDataSchema = z.strictObject({
  automation_id: idOf('aut'),
  run_id: idOf('run'),
  /** Rendered for this recipient (checked when sent). */
  title: z.string().min(1).max(AUTOMATION_MESSAGE_TITLE_MAX),
  body: z.string().max(AUTOMATION_MESSAGE_BODY_MAX),
  /**
   * Present on the summary of a recipient past 100 messages per hour (T515):
   * how many messages of the automation it stands for (`title` says so in
   * the recipient's language; `run_id` is the latest run).
   */
  summary_count: z.int().min(1).optional(),
});
export type AutomationMessageData = z.infer<typeof automationMessageDataSchema>;

/**
 * Types of S5b whose `data` is defined (T542, CONTRACTS §22.1, ADR-34); each
 * joins {@link ACTIVE_NOTIFICATION_TYPES} with the task that produces it.
 */
export const S5B_NOTIFICATION_TYPES = [
  'record.assigned',
  'record.followed_changed',
  'date.reminder',
  'import.finished',
] as const satisfies readonly NotificationType[];

/**
 * `data` schema of each produced type and of the S5b types (whose data, email
 * and later Telegram rendering exist before their producer).
 */
export const NOTIFICATION_DATA_SCHEMAS = {
  'automation.disabled': automationDisabledDataSchema,
  'automation.batch_overflow': automationBatchOverflowDataSchema,
  'automation.message': automationMessageDataSchema,
  'record.assigned': recordAssignedDataSchema,
  'record.followed_changed': recordFollowedChangedDataSchema,
  'date.reminder': dateReminderDataSchema,
  'import.finished': importFinishedDataSchema,
} as const satisfies Record<
  (typeof ACTIVE_NOTIFICATION_TYPES)[number] | (typeof S5B_NOTIFICATION_TYPES)[number],
  z.ZodType
>;

/**
 * `data` of `automation.batch_overflow` **as read** (API §22.3, email, later
 * Telegram — QA S5 L6): `skipped` is computed when read from the stand-in
 * run `run_id` (the records of the batch that got no run); `null` when the
 * reader cannot see the automation any more or the run is gone. Never
 * stored on the notification.
 */
export const automationBatchOverflowViewDataSchema = automationBatchOverflowDataSchema.extend({
  skipped: z.int().min(0).nullable().optional(),
});
export type AutomationBatchOverflowViewData = z.infer<typeof automationBatchOverflowViewDataSchema>;

// ---------------------------------------------------------------------------
// Grouping buffer (ADR-34 §2, T542): bulk `record.assigned` and
// `record.followed_changed` are gathered in `meta.notification_buffer` and
// written by `notifications.flush`.

/** What a buffer row gathers: `assigned` per `batch.id`, `followed` per record. */
export const NOTIFICATION_BUFFER_KINDS = ['assigned', 'followed'] as const;
export type NotificationBufferKind = (typeof NOTIFICATION_BUFFER_KINDS)[number];

/** Wait of the flush after the first row of a group (`preserve_run_at` debounce). */
export const NOTIFICATION_BUFFER_FLUSH_DELAY_MS: Readonly<Record<NotificationBufferKind, number>> =
  { assigned: 10_000, followed: 60_000 };

/**
 * Window of the writes of an incoming webhook's runs (ADR-35 §6, T608):
 * `record.assigned` and `record.followed_changed` they cause are gathered per
 * (hook, table) and flushed this long after the first row (`from_first`).
 */
export const NOTIFICATION_WEBHOOK_WINDOW_MS = 60_000;

/** Rows older than this are flushed again by `notifications.cleanup` (their job was lost). */
export const NOTIFICATION_BUFFER_STALE_MS = 10 * 60_000;

// ---------------------------------------------------------------------------
// API

export const notificationSchema = z
  .object({
    id: idOf('ntf'),
    type: notificationTypeSchema,
    /** `null`: not tied to a base, or the caller cannot open the base any more. */
    base: z.object({ id: idOf('bse'), name: z.string() }).nullable(),
    table_id: idOf('tbl').nullable(),
    entity: z.object({
      type: notificationEntityTypeSchema,
      id: z.string().min(1).max(64),
      /**
       * Rendered when read, with the caller's current access (record:
       * primary field as text). `null` when the caller cannot read it any
       * more: show the item without a link.
       */
      title: z.string().nullable(),
    }),
    actor: z
      .object({
        type: z.enum(ACTOR_TYPES),
        id: z.string().min(1).max(64),
        /** Display name of a user actor still in the organization, else `null`. */
        name: z.string().nullable(),
      })
      .nullable(),
    /**
     * Stored parameters of the type (CONTRACTS §22.1). `automation.batch_overflow`
     * also has `skipped` (integer or `null`), computed when read
     * (`AutomationBatchOverflowViewData`).
     */
    data: z.record(z.string(), z.unknown()).meta({
      description:
        'Stored parameters of the type (CONTRACTS §22.1). `automation.batch_overflow` also has ' +
        '`skipped` (records of the batch the automation left out, or `null` when the caller ' +
        'cannot see the automation any more), computed when read, never stored. ' +
        '`record.assigned` and `record.followed_changed` gathered from the writes of an ' +
        'incoming webhook (one per hook, table and minute) have `source.incoming_webhook_id`; ' +
        '`record.followed_changed` then also has `record_ids` (at most 20) and `record_count`.',
    }),
    read_at: isoDateTimeSchema.nullable(),
    created_at: isoDateTimeSchema,
  })
  .meta({ id: 'Notification', description: 'An in-app notification (CONTRACTS §22)' });
export type NotificationDto = z.infer<typeof notificationSchema>;

export const notificationListQuerySchema = cursorQuerySchema.extend({
  unread: booleanQueryParam.optional().meta({ description: '`true`: unread only' }),
  base_id: idOf('bse').optional().meta({ description: 'Only notifications of this base' }),
});
export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>;

export const notificationListSchema = cursorListSchema(notificationSchema).meta({
  id: 'NotificationList',
});
export type NotificationListDto = z.infer<typeof notificationListSchema>;

export const notificationUnreadCountSchema = z
  .object({
    count: z
      .int()
      .min(0)
      .max(NOTIFICATION_UNREAD_COUNT_CAP)
      .meta({
        description: `Unread in-app notifications, at most ${String(NOTIFICATION_UNREAD_COUNT_CAP)}`,
      }),
  })
  .meta({ id: 'NotificationUnreadCount' });
export type NotificationUnreadCountDto = z.infer<typeof notificationUnreadCountSchema>;

export const markNotificationsReadSchema = z
  .union([
    z.strictObject({ ids: z.array(idOf('ntf')).min(1).max(MAX_NOTIFICATION_READ_IDS) }),
    z.strictObject({
      all: z.literal(true),
      base_id: idOf('bse').optional().meta({ description: 'Only this base' }),
    }),
  ])
  .meta({ id: 'MarkNotificationsRead' });
export type MarkNotificationsReadInput = z.infer<typeof markNotificationsReadSchema>;

export const markNotificationsReadResultSchema = z
  .object({ updated: z.int().min(0) })
  .meta({ id: 'MarkNotificationsReadResult' });
export type MarkNotificationsReadResult = z.infer<typeof markNotificationsReadResultSchema>;

export const notificationPreferenceSchema = z
  .object({
    type: notificationTypeSchema,
    channel: notificationChannelSchema.meta({
      description:
        '`telegram` is listed only while the organization has a notification bot (CONTRACTS ' +
        '§22.7); a stored Telegram preference applies once a channel is linked',
    }),
    enabled: z.boolean(),
    /** `true`: cannot be turned off (in-app of a mandatory type). */
    locked: z.boolean(),
  })
  .meta({ id: 'NotificationPreference' });
export type NotificationPreferenceDto = z.infer<typeof notificationPreferenceSchema>;

export const notificationPreferencesSchema = z
  .object({ items: z.array(notificationPreferenceSchema) })
  .meta({ id: 'NotificationPreferences' });
export type NotificationPreferencesDto = z.infer<typeof notificationPreferencesSchema>;

export const updateNotificationPreferencesSchema = z
  .strictObject({
    items: z
      .array(
        z.strictObject({
          type: notificationTypeSchema,
          channel: notificationChannelSchema,
          enabled: z.boolean(),
        }),
      )
      .min(1)
      .max(NOTIFICATION_TYPES.length * NOTIFICATION_CHANNELS.length),
  })
  .meta({ id: 'UpdateNotificationPreferences' });
export type UpdateNotificationPreferencesInput = z.infer<
  typeof updateNotificationPreferencesSchema
>;

export const dailyDigestHourSchema = z.int().min(0).max(23);

export const notificationSettingsSchema = z
  .object({
    email_frequency: emailFrequencySchema,
    /** Hour of the daily email (`daily`), 0–23 in the user's time zone. */
    daily_hour: dailyDigestHourSchema,
    /** Muted bases the caller can still open, by name. */
    muted_bases: z.array(z.object({ id: idOf('bse'), name: z.string() })),
    auto_follow_created: z.boolean().meta({
      description:
        'Follow the records I create by hand (one record at a time; not imports, forms, pastes ' +
        'or automations). Default `true` (T543).',
    }),
    auto_follow_assigned: z.boolean().meta({
      description:
        'Follow the records I am assigned to through a `user` field with `notify_on_assign`. ' +
        'Default `true` (T543, used by T544).',
    }),
  })
  .meta({ id: 'NotificationSettings' });
export type NotificationSettingsDto = z.infer<typeof notificationSettingsSchema>;

export const updateNotificationSettingsSchema = z
  .strictObject({
    email_frequency: emailFrequencySchema.optional(),
    daily_hour: dailyDigestHourSchema.optional(),
    auto_follow_created: z.boolean().optional(),
    auto_follow_assigned: z.boolean().optional(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: 'Nothing to update',
  })
  .meta({ id: 'UpdateNotificationSettings' });
export type UpdateNotificationSettingsInput = z.infer<typeof updateNotificationSettingsSchema>;
