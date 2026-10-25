import {
  isId,
  TELEGRAM_BOT_STATUSES,
  type Id,
  type TelegramBotStatus,
  type TelegramDeliveryMode,
} from '@cellhive/contracts';

import type { JsonObject, JsonValue } from '../../../db/schema.js';

/**
 * `organizations.settings.notifications` (ADR-34 §3, BACKLOG T549): the
 * organization's notification bot — a `telegram_bot` secret chosen by an
 * owner/admin — its username (from `getMe`, not a secret) and the state the
 * poller last saw, and how it receives updates (`telegram_delivery_mode`,
 * T609: `polling` by default). Stored in the settings JSON (no table);
 * missing or malformed keys read as "no bot" (or `polling`).
 */
export interface OrgTelegramSettings {
  readonly secretId: Id<'sec'> | null;
  /** Telegram id of the bot (`getMe`; also the prefix of its token): a new token of another bot is a bot change. */
  readonly botId: number | null;
  readonly botUsername: string | null;
  readonly status: TelegramBotStatus | null;
  /**
   * `webhook` only while `meta.telegram_webhooks` has the organization's row
   * (T609). Always set when read; absent when written means `polling`.
   */
  readonly deliveryMode?: TelegramDeliveryMode;
}

export const NO_TELEGRAM_BOT: OrgTelegramSettings = {
  secretId: null,
  botId: null,
  botUsername: null,
  status: null,
  deliveryMode: 'polling',
};

function objectOf(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
}

/** The notification bot of an organization from its `settings` JSON. */
export function orgTelegramSettingsOf(settings: JsonValue | undefined): OrgTelegramSettings {
  const notifications = objectOf(objectOf(settings)?.['notifications']);
  const secretId = notifications?.['telegram_bot_secret_id'];
  if (!isId('sec', secretId)) return NO_TELEGRAM_BOT;
  const username = notifications?.['telegram_bot_username'];
  const status = notifications?.['telegram_status'];
  const botId = notifications?.['telegram_bot_id'];
  const mode = notifications?.['telegram_delivery_mode'];
  return {
    secretId,
    botId: typeof botId === 'number' && Number.isSafeInteger(botId) && botId > 0 ? botId : null,
    botUsername:
      typeof username === 'string' && /^[A-Za-z][A-Za-z0-9_]{3,63}$/u.test(username)
        ? username
        : null,
    status: (TELEGRAM_BOT_STATUSES as readonly unknown[]).includes(status)
      ? (status as TelegramBotStatus)
      : 'ok',
    deliveryMode: mode === 'webhook' ? 'webhook' : 'polling',
  };
}

/** The `notifications` settings object for `telegram` (other keys of it kept). */
export function orgTelegramSettingsJson(
  settings: JsonValue | undefined,
  telegram: OrgTelegramSettings,
): JsonObject {
  const current = objectOf(objectOf(settings)?.['notifications']) ?? {};
  const rest = Object.fromEntries(
    Object.entries(current).filter(
      ([key]) =>
        key !== 'telegram_bot_secret_id' &&
        key !== 'telegram_bot_id' &&
        key !== 'telegram_bot_username' &&
        key !== 'telegram_status' &&
        key !== 'telegram_delivery_mode',
    ),
  );
  if (telegram.secretId === null) return rest;
  return {
    ...rest,
    telegram_bot_secret_id: telegram.secretId,
    telegram_bot_id: telegram.botId,
    telegram_bot_username: telegram.botUsername,
    telegram_status: telegram.status ?? 'ok',
    telegram_delivery_mode: telegram.deliveryMode ?? 'polling',
  };
}

/** `settings` with its `notifications` replaced by {@link orgTelegramSettingsJson}. */
export function withOrgTelegramSettings(
  settings: JsonValue | undefined,
  telegram: OrgTelegramSettings,
): JsonObject {
  return {
    ...(objectOf(settings) ?? {}),
    notifications: orgTelegramSettingsJson(settings, telegram),
  };
}
