import { z } from 'zod';

import { isoDateTimeSchema } from './common.js';
import { idOf } from './ids.js';

/**
 * Personal delivery channels of notifications (CONTRACTS §22.7; ADR-34 §3;
 * BACKLOG T549): a member links their own Telegram chat to the
 * organization's **notification bot** — one `telegram_bot` secret of the
 * organization chosen by an owner/admin (`GET|PATCH
 * /orgs/:orgId/notification-channels`) — with a one-time deep link
 * `https://t.me/<bot>?start=<token>`. The chat id is sealed at rest and never
 * leaves the server: neither the API, the logs, the audit log nor realtime
 * messages carry it, nor the Telegram name of the user.
 */

/** Kinds of personal channel (`meta.user_channels.kind`). */
export const USER_CHANNEL_KINDS = ['telegram'] as const;
export type UserChannelKind = (typeof USER_CHANNEL_KINDS)[number];
export const userChannelKindSchema = z.enum(USER_CHANNEL_KINDS);

/**
 * State of a channel as `GET …/me/channels` shows it: `linked` (notifications
 * may go there), `error` (linked once, unusable now: see `error_reason`),
 * `pending` (a link was created and not opened yet, nothing linked).
 */
export const USER_CHANNEL_STATUSES = ['linked', 'error', 'pending'] as const;
export type UserChannelStatus = (typeof USER_CHANNEL_STATUSES)[number];

/**
 * Why a channel is `error`: the organization changed or removed its
 * notification bot (`bot_changed`, T549 — link again), or Telegram refused to
 * deliver because the user blocked the bot or the chat is gone (`blocked`,
 * set by the delivery of T550).
 */
export const USER_CHANNEL_ERROR_REASONS = ['bot_changed', 'blocked'] as const;
export type UserChannelErrorReason = (typeof USER_CHANNEL_ERROR_REASONS)[number];

/**
 * State of the organization's notification bot as the poller last saw it:
 * `ok` (`getMe` and `getUpdates` answer), `webhook_conflict` (`getUpdates`
 * answered `409`: the bot has a webhook set elsewhere — remove it or use a
 * bot dedicated to Cellhive), `invalid_token` (`401`: the token was revoked).
 */
export const TELEGRAM_BOT_STATUSES = ['ok', 'webhook_conflict', 'invalid_token'] as const;
export type TelegramBotStatus = (typeof TELEGRAM_BOT_STATUSES)[number];

// --- Limits (CONTRACTS §22.7; "Quy ước S5b" limits) --------------------------------------

/** Characters of a link token (`[A-Za-z0-9_-]`, 192 bits from a CSPRNG). */
export const TELEGRAM_LINK_TOKEN_LENGTH = 32;
/** What a `/start` payload must look like to be looked up at all. */
export const TELEGRAM_LINK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/u;
/** A link token is valid this long after it was created (one use). */
export const TELEGRAM_LINK_TOKEN_TTL_MS = 10 * 60_000;
/** Most tokens waiting (not used, not expired) per user and organization. */
export const TELEGRAM_LINK_TOKENS_MAX_PENDING = 5;
/** Most links a user may create per organization in a sliding hour (`429` beyond). */
export const TELEGRAM_LINK_CREATIONS_PER_HOUR = 5;
/** Long-poll wait of one `getUpdates` call, in seconds. */
export const TELEGRAM_POLL_TIMEOUT_SECONDS = 25;
/** A `notifications.telegram_poll` job stops polling after about this long. */
export const TELEGRAM_POLL_JOB_MAX_MS = 55_000;

// --- Delivery mode: polling (default) or webhook (T609, ADR-35 §7) -----------------------

/**
 * How the notification bot receives `/start` and `/stop`: `polling`
 * (default — `getUpdates` while links wait, plus a sparse poll every 15
 * minutes for bots with linked channels) or `webhook` (Telegram calls
 * `POST /api/v1/telegram/webhook/<path token>`; only with an `https`
 * `PUBLIC_URL` on a port Telegram accepts).
 */
export const TELEGRAM_DELIVERY_MODES = ['polling', 'webhook'] as const;
export type TelegramDeliveryMode = (typeof TELEGRAM_DELIVERY_MODES)[number];

/**
 * What the hourly check last saw of the webhook (`webhook` mode only): `ok`,
 * or `error` — Telegram reported a delivery error since the last check, the
 * webhook now points elsewhere, or the token was refused.
 */
export const TELEGRAM_WEBHOOK_STATUSES = ['ok', 'error'] as const;
export type TelegramWebhookStatus = (typeof TELEGRAM_WEBHOOK_STATUSES)[number];

/**
 * Why the webhook is `error` (stored, not returned): Telegram reported a
 * delivery error (`delivery_failed` — its message is never kept), the bot's
 * webhook points to another URL (`webhook_conflict`), or Telegram refused
 * the token (`invalid_token`).
 */
export const TELEGRAM_WEBHOOK_ERROR_CODES = [
  'delivery_failed',
  'webhook_conflict',
  'invalid_token',
] as const;
export type TelegramWebhookErrorCode = (typeof TELEGRAM_WEBHOOK_ERROR_CODES)[number];

/** Ports Telegram delivers webhooks to (Bot API `setWebhook`). */
export const TELEGRAM_WEBHOOK_PORTS = [443, 80, 88, 8443] as const;
/** `max_connections` of `setWebhook`: the route answers fast, replies go through jobs. */
export const TELEGRAM_WEBHOOK_MAX_CONNECTIONS = 10;
/** Largest update body the webhook route accepts (`413` beyond). */
export const TELEGRAM_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
/** `secret_token` of `setWebhook`: 64 characters of `[A-Za-z0-9_-]` (48 random bytes). */
export const TELEGRAM_WEBHOOK_SECRET_TOKEN_PATTERN = /^[A-Za-z0-9_-]{64}$/u;
/** Path token of the webhook URL: 32 characters of `[A-Za-z0-9_-]` (24 random bytes). */
export const TELEGRAM_WEBHOOK_PATH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/u;
/** Path of the webhook route under `PUBLIC_URL`, before the path token. */
export const TELEGRAM_WEBHOOK_PATH_PREFIX = '/api/v1/telegram/webhook/';
/** Most "link not valid" replies per chat in a sliding hour; then silence (QA S5b M5). */
export const TELEGRAM_INVALID_REPLIES_PER_HOUR = 3;
/** Sparse poll (`polling` mode, QA S5b M4): `/stop` is handled within this period. */
export const TELEGRAM_SPARSE_POLL_INTERVAL_MS = 15 * 60_000;

// --- Organization settings: the notification bot (owner/admin) ---------------------------

export const orgNotificationChannelsSchema = z
  .object({
    telegram: z.object({
      secret_id: idOf('sec')
        .nullable()
        .meta({ description: 'The `telegram_bot` secret used as notification bot, or `null`' }),
      bot_username: z
        .string()
        .nullable()
        .meta({ description: 'Username of the bot (`getMe`, without `@`), `null` without bot' }),
      status: z
        .enum(TELEGRAM_BOT_STATUSES)
        .nullable()
        .meta({
          description:
            '`null` without bot; `webhook_conflict`: the bot has a webhook elsewhere; ' +
            '`invalid_token`: Telegram refused the token',
        }),
      delivery_mode: z
        .enum(TELEGRAM_DELIVERY_MODES)
        .nullable()
        .meta({
          description:
            '`null` without bot; `polling` (default) or `webhook` (Telegram calls Cellhive; ' +
            'needs an `https` `PUBLIC_URL`)',
        }),
      webhook_status: z
        .enum(TELEGRAM_WEBHOOK_STATUSES)
        .nullable()
        .meta({
          description:
            '`null` unless `delivery_mode` is `webhook`; `error`: Telegram reported a delivery ' +
            'error since the last hourly check, or the webhook no longer points to Cellhive',
        }),
      webhook_available: z.boolean().meta({
        description:
          'Whether this instance can use the webhook mode: `PUBLIC_URL` is `https` on a port ' +
          'Telegram accepts (443, 80, 88, 8443). `false` → `PATCH { telegram_delivery_mode: ' +
          'webhook }` answers `422` / `PUBLIC_URL_NOT_HTTPS` (T616)',
      }),
    }),
  })
  .meta({
    id: 'OrgNotificationChannels',
    description: 'Notification channels of an organization (CONTRACTS §22.7)',
  });
export type OrgNotificationChannelsDto = z.infer<typeof orgNotificationChannelsSchema>;

export const updateOrgNotificationChannelsSchema = z
  .strictObject({
    telegram_secret_id: idOf('sec')
      .nullable()
      .optional()
      .meta({
        description:
          'A `telegram_bot` secret of the organization (its base scope does not apply), or ' +
          '`null` to stop sending notifications to Telegram. Changing or removing the bot puts ' +
          'every linked channel of the organization in `error` (`bot_changed`)',
      }),
    telegram_delivery_mode: z
      .enum(TELEGRAM_DELIVERY_MODES)
      .optional()
      .meta({
        description:
          '`webhook`: Telegram calls Cellhive (needs an `https` `PUBLIC_URL` on port ' +
          '443/80/88/8443 and no webhook of the bot pointing elsewhere); `polling` removes ' +
          'the webhook',
      }),
  })
  .refine(
    (body) => body.telegram_secret_id !== undefined || body.telegram_delivery_mode !== undefined,
    { message: 'Give telegram_secret_id, telegram_delivery_mode or both.' },
  )
  .meta({ id: 'UpdateOrgNotificationChannels' });
export type UpdateOrgNotificationChannelsInput = z.infer<
  typeof updateOrgNotificationChannelsSchema
>;

// --- The caller's own channels (any member) ----------------------------------------------

export const userChannelSchema = z
  .object({
    kind: userChannelKindSchema,
    status: z.enum(USER_CHANNEL_STATUSES),
    error_reason: z.enum(USER_CHANNEL_ERROR_REASONS).nullable(),
    linked_at: isoDateTimeSchema
      .nullable()
      .meta({ description: 'When the chat was linked; `null` while `pending`' }),
    bot_username: z.string().nullable().meta({
      description: "Username of the organization's current notification bot (without `@`)",
    }),
  })
  .meta({
    id: 'UserChannel',
    description: 'A personal notification channel of the caller (never the chat id or name)',
  });
export type UserChannelDto = z.infer<typeof userChannelSchema>;

export const userChannelListSchema = z
  .object({
    items: z.array(userChannelSchema),
    available_kinds: z.array(userChannelKindSchema).meta({
      description:
        'Kinds the caller can link now (`telegram`: the organization has a notification bot)',
    }),
  })
  .meta({ id: 'UserChannelList' });
export type UserChannelListDto = z.infer<typeof userChannelListSchema>;

export const telegramLinkSchema = z
  .object({
    link: z.url().meta({
      description:
        '`https://t.me/<bot>?start=<token>`: open it in Telegram and press Start (one use)',
    }),
    expires_at: isoDateTimeSchema,
  })
  .meta({ id: 'TelegramLink' });
export type TelegramLinkDto = z.infer<typeof telegramLinkSchema>;

/** `t.me` deep link opening the bot with `/start <token>`. */
export function telegramStartLink(botUsername: string, token: string): string {
  return `https://t.me/${encodeURIComponent(botUsername)}?start=${encodeURIComponent(token)}`;
}

// --- Errors (CONTRACTS §6) ---------------------------------------------------------------

/**
 * `422 VALIDATION_FAILED` detail of `PATCH …/notification-channels`: the
 * secret does not exist, is of another organization or is not a
 * `telegram_bot` — one code (no existence leak).
 */
export const UNKNOWN_SECRET = 'UNKNOWN_SECRET';

/**
 * `422 VALIDATION_FAILED` detail of `PATCH …/notification-channels` (path
 * `telegram_secret_id`) and of `PATCH /secrets/:id` (path `value`, a new
 * token of the notification bot): the bot is already the notification bot
 * of another organization (QA S5b M3). Telegram serves one `getUpdates`
 * consumer per bot, so two organizations cannot share one notification bot
 * without swallowing each other's `/start`. Nothing names that organization.
 */
export const BOT_IN_USE = 'BOT_IN_USE';

/**
 * `422 VALIDATION_FAILED` detail of `PATCH …/notification-channels` (path
 * `telegram_delivery_mode`, T609): `webhook` needs `PUBLIC_URL` to be
 * `https` on a port Telegram delivers to (443, 80, 88, 8443).
 */
export const PUBLIC_URL_NOT_HTTPS = 'PUBLIC_URL_NOT_HTTPS';

/**
 * `422 VALIDATION_FAILED` detail of `PATCH …/notification-channels` (path
 * `telegram_delivery_mode`, T609): the bot already has a webhook pointing
 * to another URL (another integration) — Cellhive never overwrites it.
 */
export const TELEGRAM_WEBHOOK_CONFLICT = 'TELEGRAM_WEBHOOK_CONFLICT';
