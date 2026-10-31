import { z } from 'zod';

import { isoDateSchema, isoDateTimeSchema } from './common.js';
import { AI_PROVIDER_ERROR_REASONS } from './error-details.js';
import { idOf } from './ids.js';
import { MAX_SECRET_VALUE_LENGTH } from './secrets.js';

/**
 * AI settings of an organization, its daily token quota and usage ledger
 * (CONTRACTS §29.1, SPEC §12.1, ADR-39; BACKLOG T906). One row per
 * organization (`meta.ai_settings`); the API key is a secret of kind
 * `ai_api_key` (§24) bound to the host of the provider URL, never returned.
 */

/** What an AI call is for: the usage ledger (`meta.ai_usage_daily`) and `ai.requested` audits. */
export const AI_FEATURES = [
  'formula',
  'automation_draft',
  'ask',
  'field',
  'action',
  'test',
] as const;
export type AiFeature = (typeof AI_FEATURES)[number];

/** Rungs of the structured-output ladder (§29.7), best first. */
export const AI_OUTPUT_RUNGS = ['json_schema', 'json_object', 'prompt'] as const;
export type AiOutputRung = (typeof AI_OUTPUT_RUNGS)[number];

/** `structured_output` setting: `auto` starts at the rung "Test connection" detected. */
export const AI_STRUCTURED_OUTPUTS = ['auto', ...AI_OUTPUT_RUNGS] as const;
export type AiStructuredOutput = (typeof AI_STRUCTURED_OUTPUTS)[number];

/** Name of the output-token limit in the Chat Completions body. */
export const AI_TOKEN_PARAMS = ['max_tokens', 'max_completion_tokens'] as const;
export type AiTokenParam = (typeof AI_TOKEN_PARAMS)[number];

export const AI_DEFAULT_DAILY_TOKEN_LIMIT = 1_000_000;
export const AI_MIN_DAILY_TOKEN_LIMIT = 10_000;
export const AI_MAX_DAILY_TOKEN_LIMIT = 1_000_000_000;
export const AI_MAX_BASE_URL_LENGTH = 2_048;
export const AI_MAX_MODEL_LENGTH = 200;
export const AI_MIN_REQUEST_TIMEOUT_SECONDS = 10;
export const AI_MAX_REQUEST_TIMEOUT_SECONDS = 120;
export const AI_DEFAULT_REQUEST_TIMEOUT_SECONDS = 60;
/** Days `meta.ai_usage_daily` keeps (cron `maintenance.cleanup`). */
export const AI_USAGE_RETENTION_DAYS = 400;
/** Longest range of `GET …/ai-usage`. */
export const AI_USAGE_MAX_DAYS = 90;
/** Model ids returned by "Test connection". */
export const AI_TEST_MAX_MODELS = 200;
/** `max_output_tokens` of the "Test connection" call. */
export const AI_TEST_MAX_OUTPUT_TOKENS = 50;
/** Interactive AI requests per user per minute (`429 RATE_LIMITED`). */
export const AI_REQUESTS_PER_MINUTE = 10;
/** Interactive AI requests in flight per user, and per API instance. */
export const AI_CONCURRENT_PER_USER = 2;
export const AI_CONCURRENT_PER_INSTANCE = 8;
/** `input` / `output` of an `ai.requested` audit entry when `log_prompts` (UTF-8 bytes each). */
export const AI_AUDIT_TEXT_MAX_BYTES = 4_096;

const providerBaseUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(AI_MAX_BASE_URL_LENGTH)
  .meta({
    description:
      'OpenAI-compatible base URL (`http`/`https`, no user info), e.g. ' +
      '`https://api.openai.com/v1` or `http://ollama:11434/v1`; `/chat/completions` and ' +
      '`/models` are appended. A loopback or private host needs an HTTP allowlist entry ' +
      '(CONTRACTS §25.4)',
    example: 'https://api.openai.com/v1',
  });

const modelSchema = z.string().trim().min(1).max(AI_MAX_MODEL_LENGTH);

/**
 * The key: a new value (stored as an `ai_api_key` secret bound to the host
 * of the provider URL), an existing `ai_api_key` secret, or `null` for a
 * provider without a key (a local Ollama).
 */
export const aiApiKeyInputSchema = z
  .union([
    z.strictObject({
      value: z
        .string()
        .trim()
        .min(1)
        .max(MAX_SECRET_VALUE_LENGTH)
        .meta({ description: 'Write-only: never returned, logged or audited', writeOnly: true }),
    }),
    z.strictObject({ secret_id: idOf('sec') }),
  ])
  .nullable()
  .meta({
    id: 'AiApiKeyInput',
    description:
      '`{ value }` stores the key as an `ai_api_key` secret (replacing the value of the ' +
      'current one) with `allowed_hosts` = the host (and port) of the provider URL; ' +
      '`{ secret_id }` uses an `ai_api_key` secret of the organization; `null`: no key',
  });
export type AiApiKeyInput = z.infer<typeof aiApiKeyInputSchema>;

const tokenParamSchema = z.enum(AI_TOKEN_PARAMS);

/** Provider part of the settings: what "Test connection" may try without saving. */
const providerFields = {
  provider_base_url: providerBaseUrlSchema.nullable().optional(),
  model: modelSchema.nullable().optional(),
  api_key: aiApiKeyInputSchema.optional(),
  structured_output: z.enum(AI_STRUCTURED_OUTPUTS).optional(),
  token_param: tokenParamSchema
    .nullable()
    .optional()
    .meta({
      description:
        '`null`: the default for the host — `max_completion_tokens` for `api.openai.com`, ' +
        '`max_tokens` elsewhere',
    }),
  request_timeout_seconds: z
    .int()
    .min(AI_MIN_REQUEST_TIMEOUT_SECONDS)
    .max(AI_MAX_REQUEST_TIMEOUT_SECONDS)
    .optional(),
};

const dailyTokenLimitSchema = z
  .int()
  .min(AI_MIN_DAILY_TOKEN_LIMIT)
  .max(AI_MAX_DAILY_TOKEN_LIMIT)
  .nullable()
  .meta({
    description:
      'Tokens (prompt + completion) per day in the organization time zone; `null`: no limit',
  });

export const updateAiSettingsRequestSchema = z
  .strictObject({
    enabled: z.boolean().optional(),
    ...providerFields,
    allow_record_data: z.boolean().optional().meta({
      description: 'Turning it on needs `confirm: true` (`RECORD_DATA_NOT_CONFIRMED`)',
    }),
    confirm: z.literal(true).optional(),
    log_prompts: z.boolean().optional(),
    daily_token_limit: dailyTokenLimitSchema.optional(),
  })
  .meta({
    id: 'UpdateAiSettingsRequest',
    description: 'Keys left out keep their value (the default when never set)',
  });
export type UpdateAiSettingsRequest = z.infer<typeof updateAiSettingsRequestSchema>;

/** The key as owners/admins see it: the secret, never its value. */
export const aiApiKeySchema = z
  .object({
    secret_id: idOf('sec'),
    name: z.string(),
    allowed_hosts: z.array(z.string()),
  })
  .meta({ id: 'AiApiKey' });

export const aiSettingsSchema = z
  .object({
    enabled: z.boolean(),
    provider_base_url: z.string().nullable(),
    model: z.string().nullable(),
    api_key: aiApiKeySchema.nullable(),
    allow_record_data: z.boolean(),
    log_prompts: z.boolean(),
    daily_token_limit: z.int().nullable(),
    structured_output: z.enum(AI_STRUCTURED_OUTPUTS),
    detected_output: z.enum(AI_OUTPUT_RUNGS).nullable().meta({
      description:
        'Rung the last "Test connection" of these provider settings found; `auto` starts there',
    }),
    token_param: tokenParamSchema,
    request_timeout_seconds: z.int(),
    available: z.boolean().meta({ description: '`enabled` with a provider URL and a model' }),
    updated_at: isoDateTimeSchema.nullable().meta({ description: '`null` until first saved' }),
  })
  .meta({ id: 'AiSettings', description: 'AI settings of an organization (never the key)' });
export type AiSettingsDto = z.infer<typeof aiSettingsSchema>;

export const testAiSettingsRequestSchema = z
  .strictObject({
    settings: z.strictObject(providerFields).optional().meta({
      description: 'Unsaved provider settings to try; keys left out are the saved ones',
    }),
  })
  .meta({ id: 'TestAiSettingsRequest' });
export type TestAiSettingsRequest = z.infer<typeof testAiSettingsRequestSchema>;

/** Codes of a failed test (the call's error, as a result rather than an HTTP error). */
export const AI_TEST_ERROR_CODES = [
  'AI_PROVIDER_ERROR',
  'AI_TIMEOUT',
  'AI_INVALID_OUTPUT',
] as const;

export const aiSettingsTestResultSchema = z
  .object({
    ok: z.boolean(),
    models: z
      .array(z.string())
      .nullable()
      .meta({
        description: `Model ids of \`GET /models\` (at most ${String(AI_TEST_MAX_MODELS)}); \`null\` when the provider has none`,
      }),
    structured_output: z.enum(AI_OUTPUT_RUNGS).nullable().meta({
      description: 'Best rung the provider answered correctly; `null` when none did',
    }),
    token_param: tokenParamSchema,
    latency_ms: z.int().min(0),
    error: z
      .object({
        code: z.enum(AI_TEST_ERROR_CODES),
        reason: z.enum(AI_PROVIDER_ERROR_REASONS).nullable(),
        status: z.int().nullable(),
      })
      .nullable(),
  })
  .meta({ id: 'AiSettingsTestResult' });
export type AiSettingsTestResult = z.infer<typeof aiSettingsTestResultSchema>;

export const aiUsageQuerySchema = z.object({
  from: isoDateSchema.optional().meta({ description: 'First day (default: 29 days before `to`)' }),
  to: isoDateSchema
    .optional()
    .meta({ description: 'Last day (default: today in the organization time zone)' }),
});
export type AiUsageQuery = z.infer<typeof aiUsageQuerySchema>;

export const aiUsageItemSchema = z
  .object({
    day: isoDateSchema,
    feature: z.enum(AI_FEATURES),
    requests: z.int(),
    prompt_tokens: z.int(),
    completion_tokens: z.int(),
    estimated_requests: z
      .int()
      .meta({ description: 'Calls without `usage` from the provider (tokens estimated)' }),
  })
  .meta({ id: 'AiUsageItem' });

export const aiUsageSchema = z
  .object({
    from: isoDateSchema,
    to: isoDateSchema,
    time_zone: z.string(),
    items: z
      .array(aiUsageItemSchema)
      .meta({ description: 'Days with usage, newest first, by feature' }),
    quota: z.object({
      daily_token_limit: z.int().nullable(),
      used_today: z.int(),
      reset_at: isoDateTimeSchema.meta({
        description: 'Next midnight in the organization time zone',
      }),
    }),
  })
  .meta({ id: 'AiUsage' });
export type AiUsageDto = z.infer<typeof aiUsageSchema>;

/** `GET /orgs/:id` → `ai`, for every member (no URL, model or key). */
export const organizationAiSchema = z
  .object({
    available: z.boolean().meta({ description: 'AI is on: show AI entry points' }),
    record_data: z
      .boolean()
      .meta({ description: 'AI may see record values (`allow_record_data`)' }),
  })
  .meta({ id: 'OrganizationAi' });
export type OrganizationAi = z.infer<typeof organizationAiSchema>;

/** `VALIDATION_FAILED` detail (path `confirm`): `allow_record_data` turned on without `confirm: true`. */
export const RECORD_DATA_NOT_CONFIRMED = 'RECORD_DATA_NOT_CONFIRMED';
