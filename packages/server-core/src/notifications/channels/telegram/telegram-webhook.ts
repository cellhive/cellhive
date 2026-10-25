import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import {
  TELEGRAM_BOT_TOKEN_PATTERN,
  TELEGRAM_WEBHOOK_MAX_CONNECTIONS,
  TELEGRAM_WEBHOOK_PATH_PREFIX,
  TELEGRAM_WEBHOOK_PATH_TOKEN_PATTERN,
  TELEGRAM_WEBHOOK_PORTS,
  TELEGRAM_WEBHOOK_SECRET_TOKEN_PATTERN,
  type Id,
  type TelegramWebhookErrorCode,
} from '@cellhive/contracts';

import { deriveSecretKey, sealSecret, unsealSecret } from '../../../auth/secret-box.js';
import { hashToken } from '../../../auth/tokens.js';
import {
  parseTelegramUpdate,
  TelegramBotApi,
} from '../../../automation/actions/send-telegram/telegram-bot-api.js';
import { findTelegramWebhookByPathHash } from '../../../db/cross-tenant-lookups.js';
import { OrganizationsRepository } from '../../../db/repositories/organizations.repository.js';
import { orgScope } from '../../../db/repository.js';
import { SecretsRepository } from '../../../secrets/secrets.repository.js';

import { orgTelegramSettingsOf } from './org-telegram-settings.js';
import { TelegramUpdateHandler, type TelegramUpdateOutcome } from './telegram-update-handler.js';
import {
  TelegramWebhooksRepository,
  type RegisteredTelegramWebhook,
} from './telegram-webhooks.repository.js';

import type { TelegramClientOptions } from '../../../automation/actions/send-telegram/telegram-client.js';
import type { Db } from '../../../db/create-db.js';
import type { TelegramWebhookRow } from '../../../db/schema.js';
import type { AccessDefaults } from '../../../import/member-access.js';
import type { Buffer } from 'node:buffer';

/**
 * Webhook mode of the notification bot (BACKLOG T609, ADR-35 §7,
 * CONTRACTS §22.7): Telegram posts updates to
 * `PUBLIC_URL/api/v1/telegram/webhook/<path token>` with the
 * `X-Telegram-Bot-Api-Secret-Token` header.
 *
 * - The path token (24 random bytes) is only stored as its SHA-256; the
 *   `secret_token` (48 random bytes) is sealed (HKDF
 *   `telegram-webhook:v1`) and compared in constant time. Neither, nor
 *   the full URL, is ever returned, logged, audited or put in a job payload.
 * - Registering never overwrites a webhook of the bot that points elsewhere
 *   (`getWebhookInfo` first): only an empty URL or one carrying our own path
 *   token (the `PUBLIC_URL` changed) is replaced.
 */

/** The webhook URL prefix for `publicUrl` (no path token), or `null` when Telegram cannot reach it. */
export function telegramWebhookPrefix(publicUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(publicUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const port = url.port === '' ? 443 : Number(url.port);
  if (!(TELEGRAM_WEBHOOK_PORTS as readonly number[]).includes(port)) return null;
  return `${publicUrl.replace(/\/+$/u, '')}${TELEGRAM_WEBHOOK_PATH_PREFIX}`;
}

/** Whether `given` is `expected`, in time independent of where they differ (and of their lengths). */
export function telegramSecretTokenMatches(expected: string, given: string | undefined): boolean {
  if (given === undefined || !TELEGRAM_WEBHOOK_SECRET_TOKEN_PATTERN.test(expected)) return false;
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(expected), digest(given));
}

/** The path token at the end of a webhook URL, or `null`. */
function pathTokenOf(url: string): string | null {
  const index = url.lastIndexOf(TELEGRAM_WEBHOOK_PATH_PREFIX);
  if (index < 0) return null;
  const token = url.slice(index + TELEGRAM_WEBHOOK_PATH_PREFIX.length);
  return TELEGRAM_WEBHOOK_PATH_TOKEN_PATTERN.test(token) ? token : null;
}

/** Whether `url` (from `getWebhookInfo`) is the webhook registered as `current`, whatever its host. */
function isOurWebhook(url: string, current: TelegramWebhookRow | undefined): boolean {
  if (current === undefined) return false;
  const token = pathTokenOf(url);
  return token !== null && hashToken(token) === current.path_token_hash;
}

export type TelegramWebhookRegistration =
  /** `setWebhook` done (or already registered as is: `unchanged`). */
  | { readonly ok: true; readonly webhook: RegisteredTelegramWebhook; readonly unchanged: boolean }
  | {
      readonly ok: false;
      readonly reason: 'public_url_not_https' | 'conflict' | 'unauthorized' | 'unavailable';
      readonly retryAfterMs?: number;
    };

export type TelegramWebhookCheckOutcome =
  | 'ok'
  | 'error'
  /** The `PUBLIC_URL` changed (or the webhook was removed): registered again. */
  | 'reregistered'
  /** Telegram did not answer: tried again next hour. */
  | 'unavailable'
  /** Not (or no longer) in webhook mode with this bot: nothing to check. */
  | 'skipped';

export interface TelegramWebhookOptions {
  readonly masterKey: Buffer | string;
  readonly publicUrl: string;
  /** A Bot API client to share (the API's); else one is built from `client`. */
  readonly api?: TelegramBotApi;
  /** Tests only: the fake Bot API. */
  readonly client?: TelegramClientOptions;
  readonly now?: () => Date;
}

/**
 * Registers, removes and checks the webhook of a notification bot. Network
 * calls only happen outside transactions; the API service (`PATCH
 * …/notification-channels`) and the hourly `notifications.telegram_webhook_check`
 * write the row.
 */
export class TelegramWebhookRegistrar {
  readonly #db: Db;
  readonly #options: TelegramWebhookOptions;
  readonly #client: TelegramBotApi;
  readonly #webhookKey: Buffer;
  readonly #secretKey: Buffer;
  readonly #now: () => Date;
  readonly #webhooks: TelegramWebhooksRepository;
  readonly #organizations: OrganizationsRepository;
  readonly #secrets: SecretsRepository;

  constructor(db: Db, options: TelegramWebhookOptions) {
    this.#db = db;
    this.#options = options;
    this.#client = options.api ?? new TelegramBotApi(options.client);
    this.#webhookKey = deriveSecretKey(options.masterKey, 'telegram-webhook');
    this.#secretKey = deriveSecretKey(options.masterKey, 'org-secret');
    this.#now = options.now ?? (() => new Date());
    this.#webhooks = new TelegramWebhooksRepository(db);
    this.#organizations = new OrganizationsRepository(db);
    this.#secrets = new SecretsRepository(db);
  }

  /** The URL prefix Telegram would call now, or `null` (`PUBLIC_URL` not https / port). */
  prefix(): string | null {
    return telegramWebhookPrefix(this.#options.publicUrl);
  }

  /**
   * Points the bot `token` (secret `secretId`) at Cellhive: `getWebhookInfo`
   * — a webhook elsewhere → `conflict`; ours with the current prefix →
   * `unchanged`; otherwise new tokens and `setWebhook`. `current` is the
   * organization's row, if any. Writes nothing to the database.
   */
  async register(
    secretId: Id<'sec'>,
    token: string,
    current: TelegramWebhookRow | undefined,
  ): Promise<TelegramWebhookRegistration> {
    const prefix = this.prefix();
    if (prefix === null) return { ok: false, reason: 'public_url_not_https' };
    const info = await this.#client.getWebhookInfo(token);
    if (!info.ok) return this.#failure(info);
    const ours = current?.secret_id === secretId && isOurWebhook(info.url, current);
    if (info.url !== '' && !ours) return { ok: false, reason: 'conflict' };
    if (ours && info.url.startsWith(prefix)) {
      return {
        ok: true,
        unchanged: true,
        webhook: {
          secretId,
          pathTokenHash: current.path_token_hash,
          secretTokenEnc: current.secret_token_enc,
          registeredUrl: current.registered_url,
          checkedAt: this.#now(),
        },
      };
    }
    const pathToken = randomBytes(24).toString('base64url');
    const secretToken = randomBytes(48).toString('base64url');
    const set = await this.#client.setWebhook(token, {
      url: `${prefix}${pathToken}`,
      secretToken,
      allowedUpdates: ['message'],
      maxConnections: TELEGRAM_WEBHOOK_MAX_CONNECTIONS,
    });
    if (!set.ok) return this.#failure(set);
    return {
      ok: true,
      unchanged: false,
      webhook: {
        secretId,
        pathTokenHash: hashToken(pathToken),
        secretTokenEnc: sealSecret(this.#webhookKey, secretToken),
        registeredUrl: prefix,
        checkedAt: this.#now(),
      },
    };
  }

  /**
   * `deleteWebhook` on the bot `token`. A token Telegram refuses has no
   * webhook Cellhive could remove: done.
   */
  async unregister(token: string): Promise<{ ok: true } | { ok: false; retryAfterMs?: number }> {
    const result = await this.#client.deleteWebhook(token);
    if (result.ok || result.kind === 'unauthorized') return { ok: true };
    return result.kind === 'rate_limited'
      ? { ok: false, retryAfterMs: result.retryAfterMs }
      : { ok: false };
  }

  /**
   * The hourly check of one organization's webhook: Telegram still points
   * at us with the current `PUBLIC_URL` → `ok`, or `error`
   * (`delivery_failed`) when it reported a delivery error since the last
   * check; our webhook with another prefix, or none at all → registered
   * again; a webhook elsewhere → `error` (`webhook_conflict`), never
   * overwritten; a refused token → `error` (`invalid_token`). Telegram's
   * error text is never kept or logged.
   */
  async check(organizationId: Id<'org'>): Promise<TelegramWebhookCheckOutcome> {
    const scope = orgScope(organizationId);
    const row = await this.#webhooks.find(scope);
    if (row === undefined) return 'skipped';
    const organization = await this.#organizations.findById(organizationId);
    const bot = orgTelegramSettingsOf(organization?.settings);
    if (bot.deliveryMode !== 'webhook' || bot.secretId !== row.secret_id) return 'skipped';
    const now = this.#now();
    const token = await this.#tokenOf(organizationId, row.secret_id);
    if (token === null) return this.#setError(organizationId, 'invalid_token', now);
    const info = await this.#client.getWebhookInfo(token);
    if (!info.ok) {
      return info.kind === 'unauthorized'
        ? this.#setError(organizationId, 'invalid_token', now)
        : 'unavailable';
    }
    const prefix = this.prefix();
    const ours = isOurWebhook(info.url, row);
    if (ours && prefix !== null && info.url.startsWith(prefix)) {
      const since = row.last_checked_at ?? row.created_at;
      if (info.lastErrorAt !== null && info.lastErrorAt.getTime() > since.getTime()) {
        return this.#setError(organizationId, 'delivery_failed', now);
      }
      await this.#webhooks.setStatus(scope, 'ok', null, now);
      return 'ok';
    }
    if (info.url !== '' && !ours) return this.#setError(organizationId, 'webhook_conflict', now);
    // Ours under an old PUBLIC_URL, or removed: register again.
    const registration = await this.register(row.secret_id, token, row);
    if (!registration.ok) {
      if (registration.reason === 'unavailable') return 'unavailable';
      return this.#setError(
        organizationId,
        registration.reason === 'conflict'
          ? 'webhook_conflict'
          : registration.reason === 'unauthorized'
            ? 'invalid_token'
            : 'delivery_failed',
        now,
      );
    }
    const saved = await this.#db.withTx(async (tx) => {
      const locked = await this.#organizations.lockById(organizationId, tx);
      const settings = orgTelegramSettingsOf(locked?.settings);
      if (settings.deliveryMode !== 'webhook' || settings.secretId !== row.secret_id) return false;
      await this.#webhooks.upsert(orgScope(organizationId, tx), registration.webhook);
      return true;
    });
    return saved ? 'reregistered' : 'skipped';
  }

  async #setError(
    organizationId: Id<'org'>,
    code: TelegramWebhookErrorCode,
    now: Date,
  ): Promise<TelegramWebhookCheckOutcome> {
    await this.#webhooks.setStatus(orgScope(organizationId), 'error', code, now);
    return 'error';
  }

  /** The bot token of the secret, unsealed in memory; `null` when unusable. */
  async #tokenOf(organizationId: Id<'org'>, secretId: Id<'sec'>): Promise<string | null> {
    const secret = await this.#secrets.findById(orgScope(organizationId), secretId);
    if (secret?.kind !== 'telegram_bot') return null;
    try {
      const token = unsealSecret(this.#secretKey, secret.ciphertext);
      return TELEGRAM_BOT_TOKEN_PATTERN.test(token) ? token : null;
    } catch {
      return null;
    }
  }

  #failure(result: {
    readonly kind: 'unauthorized' | 'rate_limited' | 'rejected' | 'unavailable';
    readonly retryAfterMs?: number;
  }): TelegramWebhookRegistration {
    if (result.kind === 'unauthorized') return { ok: false, reason: 'unauthorized' };
    return result.kind === 'rate_limited' && result.retryAfterMs !== undefined
      ? { ok: false, reason: 'unavailable', retryAfterMs: result.retryAfterMs }
      : { ok: false, reason: 'unavailable' };
  }
}

export type TelegramWebhookReceipt =
  /** Unknown path token, or the organization is no longer in webhook mode with that bot. */
  | 'not_found'
  /** Wrong (or missing) `X-Telegram-Bot-Api-Secret-Token`. */
  | 'unauthorized'
  | TelegramUpdateOutcome;

export interface TelegramWebhookReceiverOptions {
  readonly masterKey: Buffer | string;
  readonly defaults: AccessDefaults;
  readonly now?: () => Date;
}

/**
 * The work of `POST /api/v1/telegram/webhook/:pathToken`: path token →
 * organization (cross-tenant lookup by hash), the secret header compared in
 * constant time, then the update through `TelegramUpdateHandler` in one
 * transaction. Database errors propagate (the route answers `503`, Telegram
 * sends again).
 */
export class TelegramWebhookReceiver {
  readonly #db: Db;
  readonly #handler: TelegramUpdateHandler;
  readonly #webhookKey: Buffer;
  readonly #webhooks: TelegramWebhooksRepository;
  readonly #organizations: OrganizationsRepository;

  constructor(db: Db, options: TelegramWebhookReceiverOptions) {
    this.#db = db;
    this.#handler = new TelegramUpdateHandler(db, {
      masterKey: options.masterKey,
      defaults: options.defaults,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    this.#webhookKey = deriveSecretKey(options.masterKey, 'telegram-webhook');
    this.#webhooks = new TelegramWebhooksRepository(db);
    this.#organizations = new OrganizationsRepository(db);
  }

  /**
   * `readBody` is called only once the request is known to come from
   * Telegram (it may throw, e.g. a body over the limit: path → secret →
   * body, ADR-35 §7).
   */
  async receive(
    pathToken: string,
    secretHeader: string | undefined,
    readBody: () => unknown,
  ): Promise<TelegramWebhookReceipt> {
    if (!TELEGRAM_WEBHOOK_PATH_TOKEN_PATTERN.test(pathToken)) return 'not_found';
    const match = await findTelegramWebhookByPathHash(this.#db.kysely, hashToken(pathToken));
    if (match === undefined) return 'not_found';
    const scope = orgScope(match.organization_id);
    const row = await this.#webhooks.find(scope);
    if (row === undefined) return 'not_found';
    const organization = await this.#organizations.findById(match.organization_id);
    const bot = orgTelegramSettingsOf(organization?.settings);
    if (bot.deliveryMode !== 'webhook' || bot.secretId !== row.secret_id) return 'not_found';
    let expected: string;
    try {
      expected = unsealSecret(this.#webhookKey, row.secret_token_enc);
    } catch {
      expected = '';
    }
    if (!telegramSecretTokenMatches(expected, secretHeader)) return 'unauthorized';
    const update = parseTelegramUpdate(readBody());
    if (update === null) return 'ignored';
    return this.#handler.handle(
      { organizationId: match.organization_id, secretId: row.secret_id },
      update,
    );
  }
}
