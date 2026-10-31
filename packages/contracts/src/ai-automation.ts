import { z } from 'zod';

import { automationDefinitionSchema, MAX_AUTOMATION_NAME_LENGTH } from './automations.js';
import { idOf } from './ids.js';

/**
 * "Create an automation with AI" (CONTRACTS §29.3, SPEC §12.2 #2, ADR-39;
 * BACKLOG T908): one sentence becomes a draft automation checked exactly
 * like `POST /bases/{baseId}/automations` would check it for the caller.
 * Nothing is stored and nothing is turned on.
 */

/** Longest sentence. */
export const AI_AUTOMATION_MAX_PROMPT_LENGTH = 1_000;
/** `max_output_tokens` of each call. */
export const AI_AUTOMATION_MAX_OUTPUT_TOKENS = 2_000;
/** Most actions of a draft. */
export const AI_AUTOMATION_MAX_ACTIONS = 5;
/** Longest explanation and warning message. */
export const AI_AUTOMATION_MAX_EXPLANATION_LENGTH = 1_000;
export const AI_AUTOMATION_MAX_WARNING_LENGTH = 500;
/** Most warnings of a draft. */
export const AI_AUTOMATION_MAX_WARNINGS = 10;

/**
 * What the draft could not do: a part of the sentence that needs an action
 * or a trigger drafts do not have (calling an outside API, deleting
 * records…), or a guess between several tables, fields or options.
 */
export const AI_AUTOMATION_WARNING_CODES = [
  'unsupported_action',
  'unsupported_trigger',
  'ambiguous',
] as const;
export type AiAutomationWarningCode = (typeof AI_AUTOMATION_WARNING_CODES)[number];

export const aiAutomationDraftRequestSchema = z
  .strictObject({
    prompt: z.string().trim().min(1).max(AI_AUTOMATION_MAX_PROMPT_LENGTH).meta({
      description: 'What the automation should do, in any language',
      example: 'Khi ticket chuyển DONE thì gửi Telegram cho người phụ trách',
    }),
    table_id: idOf('tbl')
      .nullable()
      .default(null)
      .meta({
        description:
          'The table the builder was opened from: preferred as the trigger table when the ' +
          'sentence names none. A table the caller reads but cannot manage is `403`',
      }),
  })
  .meta({ id: 'AiAutomationDraftRequest' });
export type AiAutomationDraftRequest = z.output<typeof aiAutomationDraftRequestSchema>;

export const aiAutomationWarningSchema = z
  .strictObject({
    code: z.enum(AI_AUTOMATION_WARNING_CODES),
    message: z.string().meta({ description: 'Written by the model: plain text' }),
  })
  .meta({ id: 'AiAutomationWarning' });
export type AiAutomationWarning = z.infer<typeof aiAutomationWarningSchema>;

export const aiAutomationDraftSchema = z
  .strictObject({
    name: z.string().max(MAX_AUTOMATION_NAME_LENGTH).meta({ description: 'Written by the model' }),
    description: z.string().meta({ description: 'The sentence, as sent' }),
    definition: automationDefinitionSchema.meta({
      description:
        'Checked like `POST /bases/{baseId}/automations` would check it for the caller ' +
        '(filters as DSL with ids, templates in stored form); not saved — create it with ' +
        '`enabled: false` after review',
    }),
    explanation: z.string().meta({ description: 'What the draft does, written by the model' }),
    warnings: z.array(aiAutomationWarningSchema).meta({
      description: 'Parts of the sentence the draft leaves out or had to guess',
    }),
  })
  .meta({ id: 'AiAutomationDraft' });
export type AiAutomationDraft = z.infer<typeof aiAutomationDraftSchema>;
