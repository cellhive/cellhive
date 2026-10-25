import {
  TELEGRAM_BOT_TOKEN_PATTERN,
  TEMPLATE_OUTPUT_LIMITS,
  type SendTelegramStepOutput,
} from '@cellhive/contracts';

import { deriveSecretKey, unsealSecret } from '../../../auth/secret-box.js';
import { SendPacerUnavailableError, type SendPacer, type SendSlot } from '../../../mail/limits.js';
import { SecretsRepository } from '../../../secrets/secrets.repository.js';
import { AutomationStepError } from '../../engine/errors.js';

import { closeCutTelegramHtml } from './html.js';
import { TelegramClient, type TelegramClientOptions } from './telegram-client.js';
import { createMemoryTelegramPacers, telegramBotPacerKey } from './telegram-pacer.js';

import type { Db } from '../../../db/create-db.js';
import type { JsonObject, JsonValue } from '../../../db/schema.js';
import type {
  AutomationActionContext,
  AutomationActionHandler,
  AutomationActionResult,
} from '../../engine/action-registry.js';
import type { Buffer } from 'node:buffer';

/**
 * The `send_telegram` handler of the run engine (SPEC §11.5, BACKLOG T516).
 * One attempt:
 *
 * 1. The secret is looked up again **now**: a `telegram_bot` secret of the
 *    organization whose scope includes the base — deleted, or its scope
 *    changed to leave the base out → `secret_unavailable` (the automation
 *    stays on). The token is unsealed in memory only.
 * 2. The chat id is resolved as `run_as` (literal, field, step): a number
 *    or `@channel_username`, else `invalid_chat_id`.
 * 3. The text is rendered in the `telegram_html` context (values
 *    HTML-escaped, what the author typed kept), the `digest` lines first;
 *    cut at 4,096 characters with its open tags closed.
 * 4. A slot of the bot's limit (25 messages per sliding second, shared
 *    with notification deliveries through Valkey — T550); the limit not
 *    reachable → `telegram_unavailable`, retried in a second.
 * 5. `sendMessage` at `api.telegram.org` (10 s). `429` → retried after its
 *    `retry_after` (`telegram_rate_limited`); other 4xx → `failed` at once
 *    (`telegram_rejected`, `params.status`/`error_code`); 5xx, timeout,
 *    network → retried on the engine's schedule (`telegram_unavailable`).
 *
 * The Bot API has no idempotency key: a timeout after Telegram accepted the
 * message may send it twice on the retry. The output holds the message id,
 * the secret id and sizes — never the text or the chat id; nothing here
 * logs or throws the token (it is in the request path).
 */

export interface SendTelegramActionDeps {
  readonly db: Db;
  /** `APP_MASTER_KEY`: the `org-secret` key is derived from it. */
  readonly masterKey: Buffer | string;
  /** Tests only: the fake Bot API (base URL, fetch, timeout). Production uses the fixed host. */
  readonly client?: TelegramClientOptions;
  /**
   * The per-bot limit shared with notification deliveries (T550): the
   * worker passes its `TelegramSendPacers.bot` (Valkey). Default: a pacer of
   * this handler only.
   */
  readonly pacer?: SendPacer;
}

/** Chat id as the Bot API takes it, or `null` when the value is not one. */
export function telegramChatIdOf(value: unknown): string | null {
  let current = value;
  if (Array.isArray(current) && current.length === 1) current = current[0] as unknown;
  if (typeof current === 'number') {
    return Number.isSafeInteger(current) && current !== 0 ? String(current) : null;
  }
  if (typeof current !== 'string') return null;
  const text = current.trim();
  return /^(?:-?[1-9]\d{0,19}|@[A-Za-z][A-Za-z0-9_]{3,63})$/u.test(text) ? text : null;
}

export function createSendTelegramAction(deps: SendTelegramActionDeps): AutomationActionHandler {
  const secrets = new SecretsRepository(deps.db);
  const key = deriveSecretKey(deps.masterKey, 'org-secret');
  const client = new TelegramClient(deps.client);
  const pacer = deps.pacer ?? createMemoryTelegramPacers().bot;

  return {
    async execute(context: AutomationActionContext): Promise<AutomationActionResult> {
      const { action, scope, run, values } = context;
      if (action.type !== 'send_telegram') {
        throw new TypeError('send_telegram handler: wrong action');
      }
      const { config } = action;

      const secret = await secrets.findUsable(scope, config.secret_id, run.baseId, 'telegram_bot');
      if (secret === undefined) {
        throw new AutomationStepError(
          'secret_unavailable',
          'The bot of this step is gone or not shared with this base.',
          { params: { secret_id: config.secret_id } },
        );
      }
      let token: string;
      try {
        token = unsealSecret(key, secret.ciphertext);
      } catch {
        // Sealed under another master key: an admin has to enter the token again.
        throw new AutomationStepError('secret_unavailable', 'The bot token cannot be read.', {
          params: { secret_id: config.secret_id, reason: 'unreadable' },
        });
      }
      if (!TELEGRAM_BOT_TOKEN_PATTERN.test(token)) {
        throw new AutomationStepError('secret_unavailable', 'The bot token is not usable.', {
          params: { secret_id: config.secret_id, reason: 'unreadable' },
        });
      }

      const chat = await values.resolve(config.chat_id);
      const chatId = telegramChatIdOf(chat.value);
      if (chatId === null) {
        throw new AutomationStepError('invalid_chat_id', 'The chat id is empty or invalid.', {
          params: { source: 'literal' in config.chat_id ? 'literal' : 'value' },
        });
      }

      let digest: string | undefined;
      const warnings = [...chat.warnings];
      if (config.text.digest !== null) {
        const lines = await values.renderDigest(config.text.digest, { context: 'telegram_html' });
        warnings.push(...lines.warnings);
        digest = lines.text;
      }
      const rendered = await values.renderTemplate(config.text.template, {
        context: 'telegram_html',
        maxLength: TEMPLATE_OUTPUT_LIMITS.telegram_text,
        ...(digest === undefined ? {} : { digest }),
      });
      warnings.push(...rendered.warnings);
      const text = rendered.truncated ? closeCutTelegramHtml(rendered.text) : rendered.text;
      if (text.trim() === '') {
        throw new AutomationStepError('invalid_value', 'The message is empty.', {
          params: { field: 'text' },
        });
      }

      // T550: the bot's 25 messages per second are shared with notification deliveries.
      let slot: SendSlot;
      try {
        slot = await pacer.acquire(telegramBotPacerKey(token));
      } catch (error) {
        if (!(error instanceof SendPacerUnavailableError)) throw error;
        throw new AutomationStepError(
          'telegram_unavailable',
          'The Telegram sending limit cannot be checked right now.',
          {
            transient: 'rate_limited',
            retryAfterMs: 1_000,
            params: { cause: 'rate_limit_unavailable', status: null },
          },
        );
      }
      let sent: Awaited<ReturnType<TelegramClient['sendMessage']>>;
      try {
        sent = await client.sendMessage(token, { chatId, text });
      } finally {
        await slot.release();
      }
      if (!sent.ok) {
        switch (sent.kind) {
          case 'rate_limited':
            throw new AutomationStepError('telegram_rate_limited', 'Telegram asked to wait.', {
              transient: 'rate_limited',
              retryAfterMs: sent.retryAfterMs,
              params: { status: 429, retry_after_ms: sent.retryAfterMs },
            });
          case 'rejected':
            throw new AutomationStepError('telegram_rejected', 'Telegram refused the message.', {
              params: { status: sent.status, error_code: sent.errorCode },
            });
          case 'unavailable':
            throw new AutomationStepError('telegram_unavailable', 'Telegram did not answer.', {
              transient: sent.cause,
              params: { cause: sent.cause, status: sent.status },
            });
        }
      }
      const output: SendTelegramStepOutput = {
        message_id: sent.messageId,
        secret_id: config.secret_id,
        length: Array.from(text).length,
        truncated: rendered.truncated,
      };
      return {
        output: {
          ...(output as unknown as JsonObject),
          ...(warnings.length === 0 ? {} : { warnings: warnings as unknown as JsonValue }),
        },
        warnings,
      };
    },
  };
}
