import { z } from 'zod';

import {
  automationActionIdSchema,
  digestValueSchema,
  fieldValueSchema,
  MAX_TEMPLATE_LENGTH,
  stepValueSchema,
  TEMPLATE_OUTPUT_LIMITS,
} from '../automation-values.js';
import { idOf } from '../ids.js';

/**
 * `send_telegram` (SPEC §11.5, CONTRACTS §21; BACKLOG T516): a message from
 * an organization bot (token in `meta.secrets`, chosen by name; the base
 * must be in the secret's scope) to a chat, through the Bot API at the
 * fixed host `api.telegram.org` — never a host taken from input. The text
 * is a template sent with `parse_mode=HTML`: what the author typed is kept
 * (`<b>`, `<i>`, `<a href>`…), every value is HTML-escaped, so a `<b>` in a
 * record shows as text.
 */

/** Reference of the text template where the `digest` lines go: `{{ [@digest] }}`. */
export const TELEGRAM_TEXT_DIGEST_REFERENCE = '@digest';

/** Longest chat id literal (`-1001234567890`, `@channel_name`). */
export const MAX_TELEGRAM_CHAT_ID_LENGTH = 64;

/** Timeout of one Bot API call (BACKLOG T516). */
export const TELEGRAM_REQUEST_TIMEOUT_MS = 10_000;

/** A chat id literal: a number (`-100…`) or `@channel_username`. */
export const telegramChatLiteralSchema = z
  .strictObject({
    literal: z.union([
      z.int(),
      z
        .string()
        .trim()
        .regex(/^(?:-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{3,63})$/u, {
          message: 'Expected a chat id (-1001234567890) or @channel_username',
        }),
    ]),
  })
  .meta({ id: 'TelegramChatLiteral', description: 'A chat id or `@channel_username`' });

/** Where the message goes: a literal, a field of the trigger record, or an earlier step. */
export const telegramChatValueSchema = z
  .union([telegramChatLiteralSchema, fieldValueSchema, stepValueSchema])
  .meta({ id: 'TelegramChatValue' });
export type TelegramChatValue = z.infer<typeof telegramChatValueSchema>;

export const sendTelegramTextSchema = z
  .strictObject({
    template: z
      .string()
      .min(1)
      .max(MAX_TEMPLATE_LENGTH)
      .meta({
        description:
          'Telegram HTML with `{{ formula }}` placeholders (stored form). Values are ' +
          `HTML-escaped; the rendered text is cut at ${String(TEMPLATE_OUTPUT_LIMITS.telegram_text)} ` +
          'characters (open tags closed)',
      }),
    digest: digestValueSchema.shape.digest
      .nullable()
      .default(null)
      .meta({
        description:
          'Lines of an earlier `find_records` step, placed where the template says ' +
          '`{{ [@digest] }}` (the row template is Telegram HTML too, its values escaped)',
      }),
  })
  .meta({ id: 'SendTelegramText' });

export const sendTelegramConfigSchema = z
  .strictObject({
    secret_id: idOf('sec').meta({
      description: 'A `telegram_bot` secret of the organization whose scope includes the base',
    }),
    chat_id: telegramChatValueSchema,
    text: sendTelegramTextSchema,
  })
  .meta({ id: 'SendTelegramConfig' });
export type SendTelegramConfig = z.infer<typeof sendTelegramConfigSchema>;
export type SendTelegramConfigInput = z.input<typeof sendTelegramConfigSchema>;

export const sendTelegramActionSchema = z
  .strictObject({
    id: automationActionIdSchema,
    type: z.literal('send_telegram'),
    config: sendTelegramConfigSchema,
  })
  .meta({
    id: 'SendTelegramAction',
    description:
      'Output: `{ message_id, secret_id, length, truncated }` — never the text or the chat id',
  });

// --- Run step -------------------------------------------------------------------------

/**
 * `error.code` of a failed `send_telegram` step:
 * - `secret_unavailable` — the secret was deleted, or its scope no longer
 *   includes the base (the automation stays on);
 * - `invalid_chat_id` — the chat id value is empty or not a chat id;
 * - `telegram_rejected` — the Bot API refused the message with a 4xx other
 *   than 429 (`params.status`, `params.error_code`: bad token, chat not
 *   found, bot blocked, HTML that does not parse…); not retried;
 * - `telegram_rate_limited` — 429 still after the retries (each retry waits
 *   `retry_after`);
 * - `telegram_unavailable` — 5xx, timeout (10 s) or network error still
 *   after the retries.
 */
export const SEND_TELEGRAM_STEP_ERROR_CODES = [
  'secret_unavailable',
  'invalid_chat_id',
  'telegram_rejected',
  'telegram_rate_limited',
  'telegram_unavailable',
] as const;
export type SendTelegramStepErrorCode = (typeof SEND_TELEGRAM_STEP_ERROR_CODES)[number];

/** Output of a `send_telegram` step (no text, no chat id). */
export const sendTelegramStepOutputSchema = z
  .object({
    message_id: z.int().meta({ description: 'Id of the message in its chat (Bot API)' }),
    secret_id: idOf('sec'),
    length: z.int().min(0).meta({ description: 'Characters sent (after the cut)' }),
    truncated: z.boolean().meta({ description: 'The text was cut at 4,096 characters' }),
  })
  .meta({ id: 'SendTelegramStepOutput' });
export type SendTelegramStepOutput = z.infer<typeof sendTelegramStepOutputSchema>;
