/**
 * Injection tokens. Every constructor dependency is injected with an explicit
 * `@Inject(token)` because decorator metadata is not emitted (see tsconfig).
 */

/** `AppConfig` from `@cellhive/server-core` (validated environment). */
export const APP_CONFIG = Symbol('APP_CONFIG');
/** Root pino logger. Application code injects `AppLogger` instead. */
export const ROOT_LOGGER = Symbol('ROOT_LOGGER');
/** `Db` from `@cellhive/server-core/db`: Kysely on the `pg` pool, with `withTx`. */
export const DB = Symbol('DB');
/** ioredis client for Valkey. */
export const CACHE_CLIENT = Symbol('CACHE_CLIENT');
/** `StorageDriver` selected by STORAGE_DRIVER. */
export const STORAGE_DRIVER = Symbol('STORAGE_DRIVER');
/** `Mailer | null` from `@cellhive/server-core/mail`; `null` when SMTP_URL is unset. */
export const MAILER = Symbol('MAILER');
/** `EmailQuota` (Valkey): emails per organization per hour (`EMAIL_MAX_PER_HOUR_PER_ORG`, T513). */
export const EMAIL_QUOTA = Symbol('EMAIL_QUOTA');
/**
 * `Mailer` always present (T530): the instance SMTP when `SMTP_URL` is set,
 * plus the SMTP servers of sender identities (SSRF-guarded on each
 * connection, `EMAIL_MAX_PER_HOUR_PER_IDENTITY`). `MAILER` is the same
 * object, or `null` without `SMTP_URL`.
 */
export const MAIL_SERVICE = Symbol('MAIL_SERVICE');
/** `RealtimePublisher` from `@cellhive/server-core/realtime`: the Valkey pub/sub bus (SPEC §15). */
export const REALTIME_BUS = Symbol('REALTIME_BUS');
/**
 * `TelegramBotApi` from `@cellhive/server-core` (T549): `getMe` of the
 * notification bot. Fixed host `api.telegram.org`; only tests pass another
 * base URL (`CreateAppOptions.telegramClient`).
 */
export const TELEGRAM_BOT_API = Symbol('TELEGRAM_BOT_API');
