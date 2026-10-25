import { TELEGRAM_BOT_TOKEN_PATTERN } from '@cellhive/contracts';

import {
  isObject,
  retryAfterOf,
  TelegramClient,
  type TelegramRawResponse,
} from './telegram-client.js';

/**
 * The Bot API calls of the notification bot (BACKLOG T549, ADR-34 §3) on
 * top of `sendMessage` (T516): `getMe` (the token is valid, the bot's
 * username) and `getUpdates` (long polling of `/start <token>` and `/stop`);
 * T609 (ADR-35 §7) adds `setWebhook`, `deleteWebhook` and `getWebhookInfo`
 * for the webhook mode — the webhook URL (it holds the path token), the
 * `secret_token` and Telegram's error text are never returned in a failure,
 * logged or thrown.
 * Same fixed host and same rule as {@link TelegramClient}: the token is in
 * the request path, so no URL, body or underlying error is ever returned,
 * thrown or logged — callers only see the classified results below.
 */

/** Failures shared by every call. */
export type TelegramCallFailure =
  /** `401` (revoked or unknown token) or `404` (malformed token path). */
  | { readonly ok: false; readonly kind: 'unauthorized' }
  /** `429`: try again after `retryAfterMs`. */
  | { readonly ok: false; readonly kind: 'rate_limited'; readonly retryAfterMs: number }
  /** Another 4xx. */
  | { readonly ok: false; readonly kind: 'rejected'; readonly status: number }
  /** 5xx, timeout, network, or an answer that is not the Bot API's. */
  | {
      readonly ok: false;
      readonly kind: 'unavailable';
      readonly cause: 'timeout' | 'network' | 'server_error';
    };

export type TelegramGetMeResult =
  { readonly ok: true; readonly botId: number; readonly username: string } | TelegramCallFailure;

/** The parts of an update the poller reads (everything else is ignored). */
export interface TelegramUpdate {
  readonly updateId: number;
  /** `message` of the update, when it is a text message. */
  readonly message: {
    readonly chatId: string;
    readonly chatType: string;
    readonly text: string;
    /** `from.language_code` (IETF tag), when Telegram sent one. */
    readonly languageCode: string | null;
  } | null;
}

export type TelegramGetUpdatesResult =
  | { readonly ok: true; readonly updates: readonly TelegramUpdate[] }
  /**
   * `409`: another consumer gets the updates — a webhook is set
   * (`webhook`), or another `getUpdates` runs on the same bot (`poller`).
   */
  | { readonly ok: false; readonly kind: 'conflict'; readonly reason: 'webhook' | 'poller' }
  | TelegramCallFailure;

export interface GetUpdatesOptions {
  /** First update id to return; confirms every update below it. */
  readonly offset: number | null;
  /** Long-poll wait in seconds (0 = answer at once). */
  readonly timeoutSeconds: number;
  readonly limit?: number;
}

/** What `getWebhookInfo` tells (the fields the webhook mode reads). */
export type TelegramWebhookInfoResult =
  | {
      readonly ok: true;
      /** The webhook URL, `''` when none is set. Holds a path token: never log it. */
      readonly url: string;
      /** `last_error_date` (when Telegram last failed to deliver), the message itself dropped. */
      readonly lastErrorAt: Date | null;
      readonly pendingUpdateCount: number;
    }
  | TelegramCallFailure;

/** `setWebhook` / `deleteWebhook`: done, or a classified failure. */
export type TelegramWebhookCallResult = { readonly ok: true } | TelegramCallFailure;

export interface SetWebhookOptions {
  /** HTTPS URL Telegram posts updates to. */
  readonly url: string;
  /** Sent back in `X-Telegram-Bot-Api-Secret-Token` (1–256 of `[A-Za-z0-9_-]`). */
  readonly secretToken: string;
  readonly allowedUpdates: readonly string[];
  readonly maxConnections: number;
}

/** Extra wait over a long poll before the request is abandoned. */
const LONG_POLL_GRACE_MS = 10_000;

function failureOf(status: number, body: unknown, retryAfterHeader: string | null) {
  if (status === 401 || status === 404) return { ok: false, kind: 'unauthorized' } as const;
  if (status === 429) {
    return {
      ok: false,
      kind: 'rate_limited',
      retryAfterMs: retryAfterOf(body, retryAfterHeader),
    } as const;
  }
  if (status >= 400 && status < 500) return { ok: false, kind: 'rejected', status } as const;
  return { ok: false, kind: 'unavailable', cause: 'server_error' } as const;
}

function chatIdOf(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value !== 0) return String(value);
  if (typeof value === 'string' && /^-?[1-9]\d{0,19}$/u.test(value)) return value;
  return null;
}

/**
 * Reads one update defensively: unknown shapes become `message: null`, a
 * value that is not an update at all `null` (poller and webhook route alike).
 */
export function parseTelegramUpdate(value: unknown): TelegramUpdate | null {
  if (!isObject(value)) return null;
  const updateId = value['update_id'];
  if (typeof updateId !== 'number' || !Number.isSafeInteger(updateId) || updateId < 0) return null;
  const message = value['message'];
  if (!isObject(message)) return { updateId, message: null };
  const chat = message['chat'];
  const text = message['text'];
  const chatId = isObject(chat) ? chatIdOf(chat['id']) : null;
  const chatType = isObject(chat) ? chat['type'] : undefined;
  if (chatId === null || typeof chatType !== 'string' || typeof text !== 'string') {
    return { updateId, message: null };
  }
  const from = message['from'];
  const languageCode = isObject(from) ? from['language_code'] : undefined;
  return {
    updateId,
    message: {
      chatId,
      chatType,
      text,
      languageCode: typeof languageCode === 'string' ? languageCode : null,
    },
  };
}

export class TelegramBotApi extends TelegramClient {
  async getMe(token: string): Promise<TelegramGetMeResult> {
    if (!TELEGRAM_BOT_TOKEN_PATTERN.test(token)) return { ok: false, kind: 'unauthorized' };
    const response = await this.call(token, 'getMe', {});
    if (!response.ok) return { ok: false, kind: 'unavailable', cause: response.cause };
    const { status, body } = response;
    if (status >= 200 && status < 300 && isObject(body) && body['ok'] === true) {
      const result = body['result'];
      const botId = isObject(result) ? result['id'] : undefined;
      const username = isObject(result) ? result['username'] : undefined;
      if (
        typeof botId === 'number' &&
        Number.isSafeInteger(botId) &&
        typeof username === 'string' &&
        /^[A-Za-z][A-Za-z0-9_]{3,63}$/u.test(username)
      ) {
        return { ok: true, botId, username };
      }
      return { ok: false, kind: 'unavailable', cause: 'server_error' };
    }
    return failureOf(status, body, response.retryAfterHeader);
  }

  async getUpdates(token: string, options: GetUpdatesOptions): Promise<TelegramGetUpdatesResult> {
    if (!TELEGRAM_BOT_TOKEN_PATTERN.test(token)) return { ok: false, kind: 'unauthorized' };
    const timeoutSeconds = Math.max(0, Math.floor(options.timeoutSeconds));
    const response = await this.call(
      token,
      'getUpdates',
      {
        ...(options.offset === null ? {} : { offset: options.offset }),
        timeout: timeoutSeconds,
        limit: options.limit ?? 100,
        allowed_updates: ['message'],
      },
      timeoutSeconds * 1000 + LONG_POLL_GRACE_MS,
    );
    if (!response.ok) return { ok: false, kind: 'unavailable', cause: response.cause };
    const { status, body } = response;
    if (status >= 200 && status < 300 && isObject(body) && body['ok'] === true) {
      const result = body['result'];
      if (!Array.isArray(result)) return { ok: false, kind: 'unavailable', cause: 'server_error' };
      const updates: TelegramUpdate[] = [];
      for (const item of result) {
        const update = parseTelegramUpdate(item);
        if (update !== null) updates.push(update);
      }
      return { ok: true, updates };
    }
    if (status === 409) {
      // Only the kind of conflict is kept; the description itself is never stored or logged.
      const description = isObject(body) ? body['description'] : undefined;
      const webhook = typeof description === 'string' && /webhook/iu.test(description);
      return { ok: false, kind: 'conflict', reason: webhook ? 'webhook' : 'poller' };
    }
    return failureOf(status, body, response.retryAfterHeader);
  }

  /** `setWebhook` (T609): Telegram checks the URL is HTTPS on an accepted port. */
  async setWebhook(token: string, options: SetWebhookOptions): Promise<TelegramWebhookCallResult> {
    if (!TELEGRAM_BOT_TOKEN_PATTERN.test(token)) return { ok: false, kind: 'unauthorized' };
    return this.#done(
      await this.call(token, 'setWebhook', {
        url: options.url,
        secret_token: options.secretToken,
        allowed_updates: options.allowedUpdates,
        max_connections: options.maxConnections,
      }),
    );
  }

  /** `deleteWebhook` (T609), pending updates kept: the poller reads them afterwards. */
  async deleteWebhook(token: string): Promise<TelegramWebhookCallResult> {
    if (!TELEGRAM_BOT_TOKEN_PATTERN.test(token)) return { ok: false, kind: 'unauthorized' };
    return this.#done(await this.call(token, 'deleteWebhook', { drop_pending_updates: false }));
  }

  /** `getWebhookInfo` (T609): the current URL and when delivery last failed. */
  async getWebhookInfo(token: string): Promise<TelegramWebhookInfoResult> {
    if (!TELEGRAM_BOT_TOKEN_PATTERN.test(token)) return { ok: false, kind: 'unauthorized' };
    const response = await this.call(token, 'getWebhookInfo', {});
    if (!response.ok) return { ok: false, kind: 'unavailable', cause: response.cause };
    const { status, body } = response;
    if (status >= 200 && status < 300 && isObject(body) && body['ok'] === true) {
      const result = body['result'];
      if (!isObject(result) || typeof result['url'] !== 'string') {
        return { ok: false, kind: 'unavailable', cause: 'server_error' };
      }
      const errorDate = result['last_error_date'];
      const pending = result['pending_update_count'];
      return {
        ok: true,
        url: result['url'],
        lastErrorAt:
          typeof errorDate === 'number' && Number.isFinite(errorDate) && errorDate > 0
            ? new Date(errorDate * 1000)
            : null,
        pendingUpdateCount:
          typeof pending === 'number' && Number.isSafeInteger(pending) && pending >= 0
            ? pending
            : 0,
      };
    }
    return failureOf(status, body, response.retryAfterHeader);
  }

  /** A call answered `{ ok: true }`, or its classified failure. */
  #done(response: TelegramRawResponse): TelegramWebhookCallResult {
    if (!response.ok) return { ok: false, kind: 'unavailable', cause: response.cause };
    const { status, body } = response;
    if (status >= 200 && status < 300 && isObject(body) && body['ok'] === true) return { ok: true };
    if (status >= 200 && status < 300)
      return { ok: false, kind: 'unavailable', cause: 'server_error' };
    return failureOf(status, body, response.retryAfterHeader);
  }
}
