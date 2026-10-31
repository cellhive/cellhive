import { z } from 'zod';

import {
  AI_FIELD_DEFAULT_OUTPUT_TOKENS,
  AI_FIELD_MAX_INSTRUCTIONS_LENGTH,
  AI_FIELD_MAX_OUTPUT_TOKENS,
  AI_FIELD_MAX_PROMPT_LENGTH,
  AI_FIELD_MIN_OUTPUT_TOKENS,
} from '../ai-fields.js';
import { automationActionIdSchema } from '../automation-values.js';
import { idOf } from '../ids.js';

/**
 * AI actions (SPEC §11.5, §12.2 #5, CONTRACTS §29.6; BACKLOG T911):
 * `ai_generate_text` (with `target_field_id`, the `ai_fill_field` of SPEC
 * §12.2 — Quyết định S8 #10) and `ai_classify`. Both need AI and
 * `allow_record_data` when saved and when run; their prompt is a template
 * of fields of the trigger record only (the AI field's rule, §29.5), read
 * as `run_as`, each value in an untrusted data block (§29.7). The model's
 * text is plain text: written to a field as is, and escaped like any record
 * value where a later step places it (`[act_…]` in a template).
 */

/** Action types whose step a later template references as text: `{{ [act_…] }}` (T911). */
export const TEMPLATE_TEXT_STEP_ACTION_TYPES = ['ai_generate_text'] as const;

const promptSchema = z
  .string()
  .trim()
  .min(1)
  .max(AI_FIELD_MAX_PROMPT_LENGTH)
  .meta({
    description:
      'Template (stored form, `{{ [fld_…] }}`) of fields of the trigger record only: no link, ' +
      'lookup or formula reading another record, no attachment, button or AI field, no ' +
      '`[@…]`/`[act_…]` reference. Each value reaches the model in an untrusted data block',
  });

const instructionsSchema = z
  .string()
  .trim()
  .max(AI_FIELD_MAX_INSTRUCTIONS_LENGTH)
  .nullable()
  .default(null)
  .meta({ description: 'Extra guidance for the model (tone, language, length)' });

export const aiGenerateTextConfigSchema = z
  .strictObject({
    prompt: promptSchema,
    instructions: instructionsSchema,
    max_output_tokens: z
      .int()
      .min(AI_FIELD_MIN_OUTPUT_TOKENS)
      .max(AI_FIELD_MAX_OUTPUT_TOKENS)
      .default(AI_FIELD_DEFAULT_OUTPUT_TOKENS),
    target_field_id: idOf('fld')
      .nullable()
      .default(null)
      .meta({
        description:
          'A plain `text` field of the trigger table (not an AI field) the text is written to ' +
          '(`ai_fill_field`); `null` = output only',
      }),
  })
  .meta({ id: 'AiGenerateTextConfig' });
export type AiGenerateTextConfig = z.infer<typeof aiGenerateTextConfigSchema>;

export const aiGenerateTextActionSchema = z
  .strictObject({
    id: automationActionIdSchema,
    type: z.literal('ai_generate_text'),
    config: aiGenerateTextConfigSchema,
  })
  .meta({
    id: 'AiGenerateTextAction',
    description:
      'Output: `{ text, prompt_tokens, completion_tokens }` (+ `skipped_not_editable` with a ' +
      'target): later steps use `{ "step": "act_…", "path": "text" }` or `{{ [act_…] }}`',
  });

export const aiClassifyConfigSchema = z
  .strictObject({
    input: promptSchema,
    instructions: instructionsSchema,
    target_field_id: idOf('fld').meta({
      description: 'A single select field of the trigger table (not an AI field)',
    }),
  })
  .meta({ id: 'AiClassifyConfig' });
export type AiClassifyConfig = z.infer<typeof aiClassifyConfigSchema>;

export const aiClassifyActionSchema = z
  .strictObject({
    id: automationActionIdSchema,
    type: z.literal('ai_classify'),
    config: aiClassifyConfigSchema,
  })
  .meta({
    id: 'AiClassifyAction',
    description:
      'The model answers one option name of the target field (an `enum`); output ' +
      '`{ option_id, option_name }` (+ `skipped_not_editable`)',
  });

/** `max_output_tokens` of an `ai_classify` call (the answer is one option name). */
export const AI_CLASSIFY_MAX_OUTPUT_TOKENS = AI_FIELD_DEFAULT_OUTPUT_TOKENS;

// --- Run step -------------------------------------------------------------------------

/**
 * `error.code` of a failed AI step (none is retried; `429`, `5xx`, timeouts
 * and network errors of the provider are `temporary_error`, retried by the
 * engine):
 * - `ai_unavailable` — AI is off or not set up, or `allow_record_data` is
 *   off (`params.reason`: `ai_disabled` | `record_data_disabled`);
 * - `ai_quota_exceeded` — the organization's daily tokens are used up
 *   (`params.reset_at`); not retried (Quyết định S8 #11);
 * - `ai_invalid_output` — still no valid answer after the repair rounds (an
 *   option outside the field's, a text over 10,000 characters;
 *   `params.attempts`); the field is unchanged;
 * - `ai_provider_error` — the provider refused for good (`params.reason` of
 *   `AI_PROVIDER_ERROR`: `http_status` with `params.status`, `ssrf_blocked`,
 *   `secret_host_not_allowed`, `secret_unavailable`, `refused`, `truncated`…).
 */
export const AI_ACTION_STEP_ERROR_CODES = [
  'ai_unavailable',
  'ai_quota_exceeded',
  'ai_invalid_output',
  'ai_provider_error',
] as const;
export type AiActionStepErrorCode = (typeof AI_ACTION_STEP_ERROR_CODES)[number];

const skippedSchema = z
  .boolean()
  .optional()
  .meta({
    description:
      '`true`: the trigger record is outside the edit rule of `run_as`; nothing was written ' +
      '(the step still succeeds, like `update_records`)',
  });

export const aiGenerateTextStepOutputSchema = z
  .object({
    text: z.string().meta({ description: 'The model text, trimmed (≤ 10,000 characters)' }),
    prompt_tokens: z.int().min(0),
    completion_tokens: z.int().min(0),
    skipped_not_editable: skippedSchema,
  })
  .meta({ id: 'AiGenerateTextStepOutput' });
export type AiGenerateTextStepOutput = z.infer<typeof aiGenerateTextStepOutputSchema>;

export const aiClassifyStepOutputSchema = z
  .object({
    option_id: idOf('opt'),
    option_name: z.string(),
    skipped_not_editable: skippedSchema,
  })
  .meta({ id: 'AiClassifyStepOutput' });
export type AiClassifyStepOutput = z.infer<typeof aiClassifyStepOutputSchema>;
