import { z } from 'zod';

import { isoDateTimeSchema } from './common.js';
import { idOf } from './ids.js';
import { cursorListSchema, cursorQuerySchema } from './pagination.js';

/**
 * Incoming webhooks — management (SPEC §5.10 `meta.incoming_webhooks`,
 * `meta.incoming_webhook_requests`, §13.2; CONTRACTS §25.1; ADR-35 §1;
 * BACKLOG T602).
 *
 * A hook belongs to a base and is managed by **base admins only** (it is
 * not bound to a table: through automations its payload can write to any
 * table of the base). Its URL `PUBLIC_URL/api/v1/hooks/<token>` carries a
 * 32-byte random token: the server keeps its SHA-256 to find the hook and
 * an encrypted copy so base admins can read the URL again. The signing
 * secret (`whsec_…`, Standard Webhooks) and the Bearer token are shown
 * **once**, in the response that creates them, and never again.
 *
 * `auth` says which checks the public route makes: `signature` (Standard
 * Webhooks), `bearer` (`Authorization: Bearer …`), `both`, or `none`. It is
 * chosen explicitly on create. Later, a check is added only through the
 * endpoint that issues its credential (`POST …/rotate-secret`,
 * `PUT …/bearer`) and removed with `PATCH { auth }` or `DELETE …/bearer`.
 */

/** Most hooks per base, deleted ones excluded (CONTRACTS §25.6). */
export const INCOMING_WEBHOOKS_MAX_PER_BASE = 50;
/** `rate_limit_per_sec` when the create request leaves it out. */
export const INCOMING_WEBHOOK_DEFAULT_RATE_PER_SEC = 5;
/**
 * Highest value the schema accepts; the instance caps it lower with
 * `WEBHOOK_MAX_RATE_PER_SEC` (SPEC §20; `RATE_LIMIT_TOO_HIGH`).
 */
export const INCOMING_WEBHOOK_RATE_SCHEMA_MAX = 1000;
/** Bucket burst = `rate_limit_per_sec` × this (ADR-35 §1). */
export const INCOMING_WEBHOOK_BURST_FACTOR = 4;
/** Longest hook name. */
export const MAX_INCOMING_WEBHOOK_NAME_LENGTH = 100;
/** The previous signing secret stays valid this long after a rotation (ADR-22 §3). */
export const SIGNING_SECRET_ROTATION_HOURS = 24;
/** Raw requests (body, headers, query) are kept this long (BACKLOG "Quyết định S5c" #10). */
export const INCOMING_WEBHOOK_REQUEST_RETENTION_DAYS = 7;

/**
 * The token of a hook URL: 32 random bytes, base64url without padding.
 * Anything else is `404` on the public route before any lookup.
 */
export const INCOMING_WEBHOOK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const incomingWebhookIdSchema = idOf('hok');
export const incomingWebhookRequestIdSchema = idOf('whr');

export const INCOMING_WEBHOOK_AUTH_MODES = ['signature', 'bearer', 'both', 'none'] as const;
export type IncomingWebhookAuth = (typeof INCOMING_WEBHOOK_AUTH_MODES)[number];

export const incomingWebhookAuthSchema = z.enum(INCOMING_WEBHOOK_AUTH_MODES).meta({
  id: 'IncomingWebhookAuth',
  description:
    '`signature`: Standard Webhooks signature (CONTRACTS §10); `bearer`: ' +
    '`Authorization: Bearer <token>`; `both`: both checks; `none`: anyone with the URL',
});

/** Whether `auth` checks a Standard Webhooks signature. */
export function authUsesSignature(auth: IncomingWebhookAuth): boolean {
  return auth === 'signature' || auth === 'both';
}

/** Whether `auth` checks a Bearer token. */
export function authUsesBearer(auth: IncomingWebhookAuth): boolean {
  return auth === 'bearer' || auth === 'both';
}

/** The `auth` value of a hook with these credentials. */
export function authOf(signature: boolean, bearer: boolean): IncomingWebhookAuth {
  if (signature) return bearer ? 'both' : 'signature';
  return bearer ? 'bearer' : 'none';
}

const nameSchema = z.string().trim().min(1).max(MAX_INCOMING_WEBHOOK_NAME_LENGTH).meta({
  description: 'Unique in the base, case-insensitive (`WEBHOOK_NAME_TAKEN`)',
  example: 'Shop orders',
});

const rateSchema = z
  .int()
  .min(1)
  .max(INCOMING_WEBHOOK_RATE_SCHEMA_MAX)
  .meta({
    description:
      'Requests per second accepted by the hook (burst 4×); at most `WEBHOOK_MAX_RATE_PER_SEC` ' +
      'of the instance (`RATE_LIMIT_TOO_HIGH`)',
    example: 5,
  });

export const createIncomingWebhookRequestSchema = z
  .strictObject({
    name: nameSchema,
    auth: incomingWebhookAuthSchema,
    rate_limit_per_sec: rateSchema.optional(),
  })
  .meta({ id: 'CreateIncomingWebhookRequest' });
export type CreateIncomingWebhookRequest = z.infer<typeof createIncomingWebhookRequestSchema>;

export const updateIncomingWebhookRequestSchema = z
  .strictObject({
    name: nameSchema.optional(),
    enabled: z.boolean().optional(),
    rate_limit_per_sec: rateSchema.optional(),
    auth: incomingWebhookAuthSchema.optional().meta({
      description:
        'Only removes checks (`both` → `bearer` drops the signing secret, `signature` → ' +
        '`none`…). Adding one needs its credential: `POST …/rotate-secret` or `PUT …/bearer` ' +
        '(`CREDENTIAL_REQUIRED`)',
    }),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' })
  .meta({ id: 'UpdateIncomingWebhookRequest' });
export type UpdateIncomingWebhookRequest = z.infer<typeof updateIncomingWebhookRequestSchema>;

export const incomingWebhookUsageSchema = z
  .object({
    automation_id: idOf('aut'),
    name: z
      .string()
      .nullable()
      .meta({ description: '`null` when the caller cannot see that automation' }),
  })
  .meta({ id: 'IncomingWebhookUsage' });
export type IncomingWebhookUsage = z.infer<typeof incomingWebhookUsageSchema>;

export const incomingWebhookSchema = z
  .object({
    id: incomingWebhookIdSchema,
    base_id: idOf('bse'),
    name: z.string(),
    url: z.string().meta({
      description: '`PUBLIC_URL/api/v1/hooks/<token>` (base admins only, like every field here)',
      example:
        'https://cellhive.example.com/api/v1/hooks/3q2-7wEwX1oF3vT0b9nB2mC4dE5fG6hI7jK8lM9nO0p',
    }),
    auth: incomingWebhookAuthSchema,
    enabled: z.boolean(),
    rate_limit_per_sec: z.int().min(1),
    signing_secret_rotating_until: isoDateTimeSchema.nullable().meta({
      description: 'Until then the previous signing secret is accepted too (24 h after a rotation)',
    }),
    listen_until: isoDateTimeSchema
      .nullable()
      .meta({ description: 'End of the "listen for a sample request" window, if open' }),
    sample_captured_at: isoDateTimeSchema.nullable(),
    last_received_at: isoDateTimeSchema.nullable().meta({
      description:
        'When the newest request still stored arrived (kept 7 days, replays included); `null` ' +
        'without one (T616)',
    }),
    usages: z.array(incomingWebhookUsageSchema).meta({
      description: 'Automations (not deleted) triggered by this hook, by name',
    }),
    created_by: z
      .object({ id: idOf('usr'), name: z.string() })
      .nullable()
      .meta({ description: '`null` when that member left' }),
    created_at: isoDateTimeSchema,
    updated_at: isoDateTimeSchema,
  })
  .meta({ id: 'IncomingWebhook', description: 'An incoming webhook of a base' });
export type IncomingWebhookDto = z.infer<typeof incomingWebhookSchema>;

/**
 * Responses that issue credentials (create, `rotate-secret`, `PUT …/bearer`):
 * the hook plus the secret(s) issued by **this** call — shown once, never
 * readable again; `null` when the call issued none.
 */
export const incomingWebhookWithSecretsSchema = incomingWebhookSchema
  .extend({
    signing_secret: z.string().nullable().meta({
      description: '`whsec_<base64 32 bytes>`, shown once',
      example: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
    }),
    bearer_token: z
      .string()
      .nullable()
      .meta({ description: '32 bytes base64url, shown once', example: null }),
  })
  .meta({ id: 'IncomingWebhookWithSecrets' });
export type IncomingWebhookWithSecretsDto = z.infer<typeof incomingWebhookWithSecretsSchema>;

export const incomingWebhookListSchema = z
  .object({ items: z.array(incomingWebhookSchema) })
  .meta({ id: 'IncomingWebhookList' });
export type IncomingWebhookList = z.infer<typeof incomingWebhookListSchema>;

/** One received request in the log: metadata only, never body or headers. */
export const incomingWebhookRequestSchema = z
  .object({
    id: incomingWebhookRequestIdSchema,
    received_at: isoDateTimeSchema,
    size_bytes: z.int().min(0),
    duplicate: z
      .boolean()
      .meta({ description: 'Same `webhook-id` as an earlier request: accepted, no event' }),
    causation_accepted: z
      .boolean()
      .meta({ description: 'A valid `X-Cellhive-Causation` header continued a chain' }),
    event_id: idOf('evt').nullable().meta({ description: 'The `webhook.received` event' }),
  })
  .meta({ id: 'IncomingWebhookRequest' });
export type IncomingWebhookRequestDto = z.infer<typeof incomingWebhookRequestSchema>;

export const incomingWebhookRequestListQuerySchema = cursorQuerySchema;
export type IncomingWebhookRequestListQuery = z.infer<typeof incomingWebhookRequestListQuerySchema>;

export const incomingWebhookRequestListSchema = cursorListSchema(incomingWebhookRequestSchema).meta(
  { id: 'IncomingWebhookRequestList' },
);
export type IncomingWebhookRequestList = z.infer<typeof incomingWebhookRequestListSchema>;

// --- Public route `POST /api/v1/hooks/:token` (T603, CONTRACTS §25.2) -------------------

/** Largest request body; one byte more is `413` and reading stops (ADR-35 §1). */
export const INCOMING_WEBHOOK_MAX_BODY_BYTES = 1_048_576;
/** Requests per second and client IP on the public route (SPEC §13.1). */
export const INCOMING_WEBHOOK_IP_RATE_PER_SEC = 20;
/** Requests per second over every hook of one base (ADR-35 §1). */
export const INCOMING_WEBHOOK_BASE_RATE_PER_SEC = 50;
/** Headers kept per request (the first ones, in arrival order). */
export const INCOMING_WEBHOOK_MAX_STORED_HEADERS = 50;
/** Longest kept header value, in UTF-16 code units; longer values are cut. */
export const INCOMING_WEBHOOK_MAX_HEADER_VALUE_LENGTH = 8192;
/**
 * Deepest nesting of objects and arrays in a JSON body (QA S5c): deeper is
 * `400 MALFORMED_JSON`. Far beyond any real webhook; keeps every later
 * step (storage, sample, `[@body]`, the builder's sample tree) clear of
 * recursion limits.
 */
export const INCOMING_WEBHOOK_MAX_JSON_DEPTH = 64;
/** Longest `webhook-id` stored as is; a longer one is stored as `sha256:<hex>`. */
export const INCOMING_WEBHOOK_MAX_MESSAGE_ID_LENGTH = 256;

/**
 * Request headers never stored, never shown in a sample and never readable
 * by an automation (ADR-35 §1; `proxy-authorization` added by T603).
 * Lower case.
 */
export const INCOMING_WEBHOOK_SENSITIVE_HEADERS = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'webhook-signature',
  'x-cellhive-causation',
  'x-telegram-bot-api-secret-token',
] as const;

/** Whether header `name` (any case) is one of {@link INCOMING_WEBHOOK_SENSITIVE_HEADERS}. */
export function isSensitiveWebhookHeader(name: string): boolean {
  return (INCOMING_WEBHOOK_SENSITIVE_HEADERS as readonly string[]).includes(name.toLowerCase());
}

export const hookReceiveResponseSchema = z
  .object({
    request_id: incomingWebhookRequestIdSchema.meta({
      description:
        'The stored request (`whr_…`). A replayed `webhook-id` gets the id of the duplicate ' +
        'entry of the log: no new event',
    }),
  })
  .meta({ id: 'HookReceiveResponse' });
export type HookReceiveResponse = z.infer<typeof hookReceiveResponseSchema>;

// --- Listen for a sample request (T603, CONTRACTS §25.3) ---------------------------------

/** How long a listening window stays open. */
export const INCOMING_WEBHOOK_LISTEN_SECONDS = 180;
/** Largest sample body kept (the serialised JSON); larger ones are cut (`truncated`). */
export const INCOMING_WEBHOOK_SAMPLE_MAX_BODY_BYTES = 65_536;

export const incomingWebhookListenResponseSchema = z
  .object({
    listen_until: isoDateTimeSchema.meta({
      description: 'The first valid request before this time becomes the sample (180 s)',
    }),
  })
  .meta({ id: 'IncomingWebhookListenResponse' });
export type IncomingWebhookListenResponse = z.infer<typeof incomingWebhookListenResponseSchema>;

const sampleJsonSchema = z.unknown().meta({
  description:
    'The body: JSON value, form fields as an object (repeated keys as arrays), `null` when ' +
    'empty; when `truncated`, the first 64 KB of the body as a string',
});

export const incomingWebhookSampleSchema = z
  .object({
    body: sampleJsonSchema,
    headers: z.record(z.string(), z.string()).meta({
      description:
        'Lower-case names; `authorization`, `proxy-authorization`, `cookie`, ' +
        '`webhook-signature`, `x-cellhive-causation`, `x-telegram-bot-api-secret-token` removed',
    }),
    query: z
      .record(z.string(), z.union([z.string(), z.array(z.string())]))
      .meta({ description: 'Query string; repeated keys as arrays' }),
    truncated: z.boolean().meta({ description: 'The body was over 64 KB' }),
    received_at: isoDateTimeSchema,
  })
  .meta({ id: 'IncomingWebhookSample' });
export type IncomingWebhookSample = z.infer<typeof incomingWebhookSampleSchema>;

export const incomingWebhookSampleResponseSchema = z
  .object({
    sample: incomingWebhookSampleSchema
      .nullable()
      .meta({ description: '`null` until a request was captured' }),
    listen_until: isoDateTimeSchema
      .nullable()
      .meta({ description: 'End of the open window; `null` when not listening' }),
  })
  .meta({ id: 'IncomingWebhookSampleResponse' });
export type IncomingWebhookSampleResponse = z.infer<typeof incomingWebhookSampleResponseSchema>;

// --- Errors ------------------------------------------------------------------------------

/** `VALIDATION_FAILED` detail (path `name`): another hook of the base has this name. */
export const WEBHOOK_NAME_TAKEN = 'WEBHOOK_NAME_TAKEN';
/** `VALIDATION_FAILED` detail: the base has 50 hooks. */
export const TOO_MANY_WEBHOOKS = 'TOO_MANY_WEBHOOKS';
/** `VALIDATION_FAILED` detail (path `rate_limit_per_sec`): above `WEBHOOK_MAX_RATE_PER_SEC`. */
export const RATE_LIMIT_TOO_HIGH = 'RATE_LIMIT_TOO_HIGH';
/** `VALIDATION_FAILED` detail (path `auth`): `PATCH` would add a check without its credential. */
export const CREDENTIAL_REQUIRED = 'CREDENTIAL_REQUIRED';
/**
 * `409 WEBHOOK_IN_USE` (delete): `errors[0].code = WEBHOOK_IN_USE`,
 * `params = { usages: IncomingWebhookUsage[], total }`.
 */
export const WEBHOOK_IN_USE = 'WEBHOOK_IN_USE';
