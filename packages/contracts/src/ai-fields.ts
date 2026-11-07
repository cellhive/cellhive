import { z } from 'zod';

import { isoDateTimeSchema } from './common.js';
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
/**
 * The organization's queued rows wait this long after a `429` without
 * `Retry-After`, or after {@link AI_FIELD_BREAKER_ERRORS} temporary errors
 * in a row; a `Retry-After` is followed up to {@link AI_FIELD_MAX_BACKOFF_MS}.
 */
export const AI_FIELD_BACKOFF_MS = 60_000;
export const AI_FIELD_MAX_BACKOFF_MS = 3_600_000;
/** Temporary errors (5xx, network, timeout) in a row within a batch that back the organization off. */
export const AI_FIELD_BREAKER_ERRORS = 5;
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

/**
 * Why rows of an AI field are `paused` (`ai_state.paused_reason`): the
 * quota of the day is used up, AI or record data is turned off, or the
 * provider rejects the configuration (`provider_error`, with
 * `paused_detail`).
 */
export const AI_PAUSE_REASONS = [
  'quota',
  'ai_disabled',
  'record_data_disabled',
  'provider_error',
] as const;
export type AiPauseReason = (typeof AI_PAUSE_REASONS)[number];

/**
 * What the provider rejected when rows are `paused provider_error`
 * (`ai_state.paused_detail`): the key (`unauthorized` = HTTP 401,
 * `forbidden` = 403), the URL or model (`not_found` = 404), an address that
 * may not be called (`ssrf_blocked`), a key that may not go to the host of
 * the URL (`secret_host_not_allowed`) or a key that is gone or unreadable
 * (`secret_unavailable`). Saving the AI settings or replacing the key's
 * value resumes them.
 */
export const AI_PROVIDER_PAUSE_DETAILS = [
  'unauthorized',
  'forbidden',
  'not_found',
  'ssrf_blocked',
  'secret_host_not_allowed',
  'secret_unavailable',
] as const;
export type AiProviderPauseDetail = (typeof AI_PROVIDER_PAUSE_DETAILS)[number];

/**
 * `reason` of a `failed` row: an error code, never a value — `refused`
 * (the model refused to answer) and `truncated` (the answer reached its
 * length limit) apart from other provider errors.
 */
export const AI_FAILURE_REASONS = [
  'invalid_output',
  'provider_error',
  'timeout',
  'render_error',
  'refused',
  'truncated',
] as const;
export type AiFailureReason = (typeof AI_FAILURE_REASONS)[number];

/** Counts of the queue of an AI field (field DTO, `schema.changed`), never record ids. */
export const aiFieldStateSchema = z
  .strictObject({
    queued: z.int().min(0).meta({ description: 'Rows waiting or being generated' }),
    failed: z.int().min(0),
    paused: z.int().min(0),
    paused_reason: z.enum(AI_PAUSE_REASONS).nullable(),
    paused_detail: z.enum(AI_PROVIDER_PAUSE_DETAILS).nullable().meta({
      description: 'What the provider rejected, with `paused_reason: provider_error` only',
    }),
    retry_at: isoDateTimeSchema.nullable().meta({
      description:
        'The organization waits for the provider until then (a `429`, or temporary errors in ' +
        'a row): queued rows stay `queued`',
    }),
  })
  .meta({ id: 'AiFieldState' });
export type AiFieldStateDto = z.infer<typeof aiFieldStateSchema>;

/** Every `reason` a cell may carry (`record.meta.ai`), each code once. */
export const AI_CELL_REASONS = [...new Set([...AI_FAILURE_REASONS, ...AI_PAUSE_REASONS])] as [
  AiFailureReason | AiPauseReason,
  ...(AiFailureReason | AiPauseReason)[],
];
export type AiCellReason = AiFailureReason | AiPauseReason;

/** The state of one AI cell (`record.meta.ai.<fld>`): `reason` with `failed` and `paused`. */
export const aiCellMetaSchema = z
  .strictObject({
    state: z.enum(AI_CELL_STATES),
    reason: z
      .enum(AI_CELL_REASONS)
      .optional()
      .meta({
        description:
          '`failed`: one of `AI_FAILURE_REASONS`; `paused`: one of `AI_PAUSE_REASONS` (an error ' +
          'code, never a value)',
      }),
  })
  .meta({ id: 'AiCellMeta' });
export type AiCellMetaDto = z.infer<typeof aiCellMetaSchema>;

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

export const AI_FIELD_GENERATE_SCOPES = ['empty', 'failed', 'all', 'records', 'paused'] as const;

export const aiFieldGenerateRequestSchema = z
  .strictObject({
    scope: z.enum(AI_FIELD_GENERATE_SCOPES).meta({
      description:
        '`empty` cells, `failed` cells, `all` (overwrites; old values stay in the record ' +
        'history), the `records` listed, or the `paused` cells (resume: never a cell that ' +
        'was not queued)',
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
