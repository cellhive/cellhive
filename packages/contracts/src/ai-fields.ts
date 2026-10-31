import { z } from 'zod';

import { idOf } from './ids.js';

/**
 * AI fields (CONTRACTS §29.5, SPEC §12.2 #4, ADR-39 §7; BACKLOG T910): a
 * `text` or single `select` field with `options.ai` is filled per record by
 * the AI worker from a prompt template of fields of the same record. Its
 * cells are read-only; values are always "strict" (a reader who cannot read
 * every source field gets `null` and `locked`).
 */

/** What the prompt asks for (a preset of the UI; every task runs the same way). */
export const AI_FIELD_TASKS = ['summarize', 'classify', 'extract', 'translate', 'custom'] as const;
export type AiFieldTask = (typeof AI_FIELD_TASKS)[number];

/** Longest prompt template and instructions. */
export const AI_FIELD_MAX_PROMPT_LENGTH = 4_000;
export const AI_FIELD_MAX_INSTRUCTIONS_LENGTH = 2_000;
/** `max_output_tokens` of a field: range and default. */
export const AI_FIELD_MIN_OUTPUT_TOKENS = 16;
export const AI_FIELD_MAX_OUTPUT_TOKENS = 2_000;
export const AI_FIELD_DEFAULT_OUTPUT_TOKENS = 300;
/** The rendered prompt of one record is cut at this many characters. */
export const AI_FIELD_MAX_INPUT_LENGTH = 8_000;
/** Longest text an AI `text` field stores; longer answers are `invalid_output`. */
export const AI_FIELD_MAX_OUTPUT_LENGTH = 10_000;
/** Rows one `ai.generate` batch takes (one `ai.requested` audit entry per batch). */
export const AI_FIELD_BATCH_SIZE = 20;
/** A `running` row whose worker died goes back to `queued` after this lease. */
export const AI_FIELD_LEASE_MS = 5 * 60_000;
/** Waits before the 2nd, 3rd and 4th try of a row after a temporary error; then `failed`. */
export const AI_FIELD_RETRY_DELAYS_MS = [30_000, 120_000, 600_000] as const;
/** Records of a preview. */
export const AI_FIELD_PREVIEW_ROWS = 5;
/** Characters of the rendered input shown per previewed record. */
export const AI_FIELD_PREVIEW_INPUT_LENGTH = 300;
/** Most records of `POST /fields/{fieldId}/ai/generate` with `scope: records`. */
export const AI_FIELD_GENERATE_MAX_RECORDS = 1_000;
/** Default of `AI_CONCURRENCY`: `ai.*` jobs a worker process runs at once. */
export const AI_DEFAULT_CONCURRENCY = 2;

export const aiFieldOptionsSchema = z
  .strictObject({
    task: z.enum(AI_FIELD_TASKS).meta({ description: 'Preset the prompt was written from' }),
    prompt: z
      .string()
      .trim()
      .min(1)
      .max(AI_FIELD_MAX_PROMPT_LENGTH)
      .meta({
        description:
          'Template with `{{ [Field] }}` placeholders of fields of the same record. Sent and ' +
          'returned with names; stored with field ids, so renaming a field keeps it',
        example: 'Summarize in one sentence: {{ [Mô tả] }}',
      }),
    instructions: z
      .string()
      .trim()
      .max(AI_FIELD_MAX_INSTRUCTIONS_LENGTH)
      .nullable()
      .default(null)
      .meta({ description: 'Extra guidance for the model (tone, language, length)' }),
    auto_update: z.boolean().default(true).meta({
      description:
        'Generate again when the record is created or restored, or a source field changes',
    }),
    max_output_tokens: z
      .int()
      .min(AI_FIELD_MIN_OUTPUT_TOKENS)
      .max(AI_FIELD_MAX_OUTPUT_TOKENS)
      .default(AI_FIELD_DEFAULT_OUTPUT_TOKENS),
  })
  .meta({ id: 'AiFieldOptions' });
export type AiFieldOptions = z.output<typeof aiFieldOptionsSchema>;

/** Stored prompts name fields by id (`{{ [fld_…] }}`), longer than the names typed. */
export const AI_FIELD_MAX_STORED_PROMPT_LENGTH = 32_000;

/** `options.ai` as `meta.fields` stores it (field-types parses stored options with it). */
export const aiFieldStoredOptionsSchema = aiFieldOptionsSchema.extend({
  prompt: z.string().min(1).max(AI_FIELD_MAX_STORED_PROMPT_LENGTH),
});

/**
 * State of a cell of an AI field that is not simply its value (`record.meta.ai`):
 * waiting, being generated, failed (`reason` is a code) or paused (quota used
 * up, AI or record data turned off). No state = the value is current.
 */
export const AI_CELL_STATES = ['queued', 'running', 'failed', 'paused'] as const;
export type AiCellState = (typeof AI_CELL_STATES)[number];

/** Why rows of an AI field are `paused` (`ai_state.paused_reason`). */
export const AI_PAUSE_REASONS = ['quota', 'ai_disabled', 'record_data_disabled'] as const;
export type AiPauseReason = (typeof AI_PAUSE_REASONS)[number];

/** `reason` of a `failed` row: an error code, never a value. */
export const AI_FAILURE_REASONS = [
  'invalid_output',
  'provider_error',
  'timeout',
  'render_error',
] as const;
export type AiFailureReason = (typeof AI_FAILURE_REASONS)[number];

/** Counts of the queue of an AI field (field DTO, `schema.changed`), never record ids. */
export const aiFieldStateSchema = z
  .strictObject({
    queued: z.int().min(0).meta({ description: 'Rows waiting or being generated' }),
    failed: z.int().min(0),
    paused: z.int().min(0),
    paused_reason: z.enum(AI_PAUSE_REASONS).nullable(),
  })
  .meta({ id: 'AiFieldState' });
export type AiFieldStateDto = z.infer<typeof aiFieldStateSchema>;

export const aiFieldPreviewRequestSchema = z
  .strictObject({
    field_id: idOf('fld').nullable().default(null).meta({
      description:
        'The AI field being edited (its type and options are used), or `null` for a new field',
    }),
    type: z
      .enum(['text', 'select'])
      .default('text')
      .meta({ description: 'Type of a new field (`field_id: null`)' }),
    choices: z
      .array(z.string().trim().min(1).max(255))
      .max(1_000)
      .default([])
      .meta({ description: 'Option names of a new `select` field (`field_id: null`)' }),
    ai: aiFieldOptionsSchema,
    record_ids: z
      .array(idOf('rec'))
      .min(1)
      .max(AI_FIELD_PREVIEW_ROWS)
      .optional()
      .meta({ description: 'Records to preview (default: the first records of the table)' }),
  })
  .meta({ id: 'AiFieldPreviewRequest' });
export type AiFieldPreviewRequest = z.output<typeof aiFieldPreviewRequestSchema>;

export const aiFieldPreviewSchema = z
  .strictObject({
    items: z.array(
      z.strictObject({
        record_id: idOf('rec'),
        input_preview: z.string().meta({
          description: `The rendered prompt input, cut at ${String(AI_FIELD_PREVIEW_INPUT_LENGTH)} characters`,
        }),
        output: z
          .string()
          .nullable()
          .meta({ description: 'Text, or the option name of a `select` field' }),
        error: z.strictObject({ code: z.string(), reason: z.string().optional() }).nullable().meta({
          description: '`AI_INVALID_OUTPUT`, `AI_PROVIDER_ERROR` (`reason`), `AI_TIMEOUT`',
        }),
      }),
    ),
    estimate: z.strictObject({
      rows: z.int().min(0).meta({ description: 'Live records of the table' }),
      tokens: z.int().min(0).meta({ description: 'Tokens to generate every row, estimated' }),
    }),
  })
  .meta({ id: 'AiFieldPreview' });
export type AiFieldPreview = z.infer<typeof aiFieldPreviewSchema>;

export const AI_FIELD_GENERATE_SCOPES = ['empty', 'failed', 'all', 'records'] as const;

export const aiFieldGenerateRequestSchema = z
  .strictObject({
    scope: z.enum(AI_FIELD_GENERATE_SCOPES).meta({
      description:
        '`empty` cells, `failed` cells, `all` (overwrites; old values stay in the record ' +
        'history) or the `records` listed',
    }),
    record_ids: z
      .array(idOf('rec'))
      .min(1)
      .max(AI_FIELD_GENERATE_MAX_RECORDS)
      .optional()
      .meta({ description: 'With `scope: records` only' }),
  })
  .refine((body) => (body.scope === 'records') === (body.record_ids !== undefined), {
    message: '`record_ids` goes with `scope: records` only',
    path: ['record_ids'],
  })
  .meta({ id: 'AiFieldGenerateRequest' });
export type AiFieldGenerateRequest = z.output<typeof aiFieldGenerateRequestSchema>;

export const aiFieldGenerateSchema = z
  .strictObject({
    job_id: idOf('job').meta({
      description: 'Follow it with `GET /jobs/{jobId}` or `job.progress`',
    }),
    rows: z.int().min(0),
    estimated_tokens: z.int().min(0),
  })
  .meta({ id: 'AiFieldGenerate' });
export type AiFieldGenerate = z.infer<typeof aiFieldGenerateSchema>;
