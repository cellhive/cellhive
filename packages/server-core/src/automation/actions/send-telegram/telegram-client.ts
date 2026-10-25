import { TELEGRAM_BOT_TOKEN_PATTERN, TELEGRAM_REQUEST_TIMEOUT_MS } from '@cellhive/contracts';

/**
 * The one Bot API call of `send_telegram` (BACKLOG T516): `sendMessage`
 * with `parse_mode=HTML` at the fixed host {@link TELEGRAM_API_BASE_URL}.
 * The host never comes from input — only tests pass another base URL (a
 * fake server). The token is part of the URL path (Bot API), so neither
 * the URL nor the underlying error is ever returned, thrown or logged:
 * callers only see the classified {@link TelegramSendResult}.
 */

export const TELEGRAM_API_BASE_URL = 'https://api.telegram.org';

/** Wait used when a `429` gives no `retry_after`. */
const DEFAULT_RETRY_AFTER_MS = 30_000;
/** Bounds of the wait a `429` may ask for. */
const MIN_RETRY_AFTER_MS = 1_000;
const MAX_RETRY_AFTER_MS = 60 * 60_000;

export type TelegramSendResult =
  | { readonly ok: true; readonly messageId: number }
  /** `429`: try again after `retryAfterMs`. */
  | { readonly ok: false; readonly kind: 'rate_limited'; readonly retryAfterMs: number }
  /** Another 4xx: retrying will not help (bad token, chat not found, HTML refused…). */
  | {
      readonly ok: false;
      readonly kind: 'rejected';
      readonly status: number;
      /** Bot API `error_code` when the body had one. */
      readonly errorCode: number | null;
      /**
       * What the refusal says about the chat (T550), the description itself
       * never kept: `blocked` — `403` (the user blocked the bot, the user is
       * deactivated, the bot cannot start the conversation); `chat_not_found`
       * — `400` "chat not found"; `null` — anything else.
       */
      readonly refusal: TelegramChatRefusal | null;
    }
  /** 5xx, timeout, network: may work later. */
  | {
      readonly ok: false;
      readonly kind: 'unavailable';
      readonly cause: 'timeout' | 'network' | 'server_error';
      readonly status: number | null;
    };

export interface TelegramClientOptions {
  /** Tests only: the base URL of a fake Bot API. Default {@link TELEGRAM_API_BASE_URL}. */
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

export interface TelegramMessage {
  /** Chat id (`-100…`) or `@channel_username`. */
  readonly chatId: string;
  /** Telegram HTML. */
  readonly text: string;
}

export const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function clampRetryAfter(ms: number): number {
  return Math.min(Math.max(Math.round(ms), MIN_RETRY_AFTER_MS), MAX_RETRY_AFTER_MS);
}

/** `parameters.retry_after` (seconds) of a `429` body, else the `Retry-After` header. */
export function retryAfterOf(body: unknown, header: string | null): number {
  const parameters = isObject(body) ? body['parameters'] : undefined;
  const seconds = isObject(parameters) ? parameters['retry_after'] : undefined;
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) {
    return clampRetryAfter(seconds * 1000);
  }
  if (header !== null && /^\d{1,6}$/u.test(header.trim())) {
    return clampRetryAfter(Number(header.trim()) * 1000);
  }
  return DEFAULT_RETRY_AFTER_MS;
}

/** What a refused `sendMessage` says about the chat (see `TelegramSendResult`). */
export type TelegramChatRefusal = 'blocked' | 'chat_not_found';

/**
 * Classifies a 4xx of `sendMessage` (T550): `403` → `blocked`; `400` whose
 * description says the chat is not found → `chat_not_found`. Only the class
 * is kept — the description is never stored, returned or logged.
 */
export function chatRefusalOf(status: number, body: unknown): TelegramChatRefusal | null {
  if (status === 403) return 'blocked';
  const description = isObject(body) ? body['description'] : undefined;
  if (status === 400 && typeof description === 'string' && /chat not found/iu.test(description)) {
    return 'chat_not_found';
  }
  return null;
}

/** Raw answer of one Bot API call: the HTTP status, the parsed JSON body (or `null`), headers. */
export type TelegramRawResponse =
  | {
      readonly ok: true;
      readonly status: number;
      readonly body: unknown;
      readonly retryAfterHeader: string | null;
    }
  | { readonly ok: false; readonly cause: 'timeout' | 'network' };

export class TelegramClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetch: typeof fetch;

  constructor(options: TelegramClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? TELEGRAM_API_BASE_URL).replace(/\/+$/u, '');
    this.timeoutMs = options.timeoutMs ?? TELEGRAM_REQUEST_TIMEOUT_MS;
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * `POST <base>/bot<token>/<method>` with a JSON body. The token must
   * already match `TELEGRAM_BOT_TOKEN_PATTERN` (callers check it). Neither
   * the URL nor the underlying error leaves this function.
   */
  protected async call(
    token: string,
    method: string,
    payload: Readonly<Record<string, unknown>>,
    timeoutMs: number = this.timeoutMs,
  ): Promise<TelegramRawResponse> {
    let response: Response;
    try {
      response = await this.fetch(`${this.baseUrl}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      return {
        ok: false,
        cause: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network',
      };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return {
      ok: true,
      status: response.status,
      body,
      retryAfterHeader: response.headers.get('retry-after'),
    };
  }

  async sendMessage(token: string, message: TelegramMessage): Promise<TelegramSendResult> {
    // The token goes into the path: only its exact Bot API shape may (no `/`, `?`, `#`).
    if (!TELEGRAM_BOT_TOKEN_PATTERN.test(token)) {
      return { ok: false, kind: 'rejected', status: 401, errorCode: null, refusal: null };
    }
    const response = await this.call(token, 'sendMessage', {
      chat_id: message.chatId,
      text: message.text,
      parse_mode: 'HTML',
    });
    if (!response.ok) {
      return { ok: false, kind: 'unavailable', cause: response.cause, status: null };
    }
    const { status, body } = response;
    if (
      status >= 200 &&
      status < 300 &&
      isObject(body) &&
      body['ok'] === true &&
      isObject(body['result'])
    ) {
      const messageId = body['result']['message_id'];
      if (typeof messageId === 'number' && Number.isInteger(messageId)) {
        return { ok: true, messageId };
      }
    }
    if (status === 429) {
      return {
        ok: false,
        kind: 'rate_limited',
        retryAfterMs: retryAfterOf(body, response.retryAfterHeader),
      };
    }
    if (status >= 400 && status < 500) {
      const errorCode = isObject(body) ? body['error_code'] : undefined;
      return {
        ok: false,
        kind: 'rejected',
        status,
        errorCode: typeof errorCode === 'number' ? errorCode : null,
        refusal: chatRefusalOf(status, body),
      };
    }
    // 5xx, or a 2xx without a message: the Bot API is not answering as it should.
    return { ok: false, kind: 'unavailable', cause: 'server_error', status };
  }
}
