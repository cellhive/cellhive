import { z } from 'zod';

import {
  automationActionIdSchema,
  automationValueSchema,
  digestValueSchema,
  fieldValueSchema,
  literalValueSchema,
  stepValueSchema,
  templateValueSchema,
  triggerValueSchema,
} from '../automation-values.js';
import { idOf } from '../ids.js';

/**
 * `http_request` (SPEC §11.5, CONTRACTS §21, §25.5; ADR-35 §4, §5, §8;
 * BACKLOG T606): an HTTP call to a URL the author configures, rendered as
 * `run_as` when the step runs and sent through the two-phase outbox — the
 * step waits, the job `http.deliver` calls the destination through the
 * SSRF guard (CONTRACTS §25.4) and retries (§25.5). Secrets are referenced
 * by id (`meta.secrets`, CONTRACTS §24): `http_header` for an auth header,
 * `webhook_signing` for a Standard Webhooks signature; their values are
 * never in the definition, the step output or the run log.
 */

export const HTTP_REQUEST_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type HttpRequestMethod = (typeof HTTP_REQUEST_METHODS)[number];

/** Most query parameters, headers and form fields of one action (CONTRACTS §25.6). */
export const HTTP_REQUEST_MAX_QUERY_PARAMS = 20;
export const HTTP_REQUEST_MAX_HEADERS = 20;
export const HTTP_REQUEST_MAX_FORM_FIELDS = 50;
/** Longest header or parameter name. */
export const HTTP_REQUEST_MAX_NAME_LENGTH = 100;
/** Longest rendered header value (longer is cut with `…`). */
export const HTTP_REQUEST_MAX_HEADER_VALUE_LENGTH = 8_192;
/** "Send a test" of an `http_request` step per person per minute (`429` beyond). */
export const HTTP_TEST_SENDS_PER_MIN = 10;

/** An HTTP header name (RFC 9110 token). */
export const HTTP_HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;

/**
 * Header names the outbox sets itself or that belong to the connection
 * (ADR-35 §5, plus `expect`, `keep-alive`, `trailer`): an action may not
 * set them (`HEADER_NOT_ALLOWED`), nor any `proxy-*` header. Lower case.
 */
export const HTTP_REQUEST_FORBIDDEN_HEADERS = [
  'webhook-id',
  'webhook-timestamp',
  'webhook-signature',
  'idempotency-key',
  'x-cellhive-causation',
  'user-agent',
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'te',
  'upgrade',
  'expect',
  'keep-alive',
  'trailer',
] as const;

/** Whether an action may set the header `name` (case-insensitive). */
export function isAllowedHttpRequestHeader(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith('proxy-')) return false;
  return !(HTTP_REQUEST_FORBIDDEN_HEADERS as readonly string[]).includes(lower);
}

/** `422 AUTOMATION_INVALID` detail codes of `http_request` (CONTRACTS §6, §21). */
export const HEADER_NOT_ALLOWED = 'HEADER_NOT_ALLOWED';
export const INVALID_URL = 'INVALID_URL';

const headerNameSchema = z
  .string()
  .min(1)
  .max(HTTP_REQUEST_MAX_NAME_LENGTH)
  .regex(HTTP_HEADER_NAME_PATTERN, { message: 'Expected an HTTP header name' });

/**
 * A value of a URL, query parameter, header or form field: any value of
 * SPEC §11.4 but a `digest` (only a `text` body takes one).
 */
export const httpRequestValueSchema = z
  .union([
    literalValueSchema,
    fieldValueSchema,
    stepValueSchema,
    triggerValueSchema,
    templateValueSchema,
  ])
  .meta({
    id: 'HttpRequestValue',
    description:
      'A value of SPEC §11.4 other than `digest`. Rendered as text: a template as text (in ' +
      'the URL each placeholder value is percent-encoded), a JSON string as is, any other ' +
      'JSON value as JSON text, `null` as ""',
  });
export type HttpRequestValue = z.infer<typeof httpRequestValueSchema>;

export const httpRequestPairSchema = z
  .strictObject({
    name: z.string().min(1).max(HTTP_REQUEST_MAX_NAME_LENGTH),
    value: httpRequestValueSchema,
  })
  .meta({ id: 'HttpRequestPair' });

export const httpRequestHeaderSchema = z
  .strictObject({ name: headerNameSchema, value: httpRequestValueSchema })
  .meta({ id: 'HttpRequestHeader' });

export const httpRequestAuthSchema = z
  .strictObject({
    header_name: headerNameSchema.meta({
      description: 'Header that carries the secret value (`Authorization`, `X-Api-Key`…)',
    }),
    secret_id: idOf('sec').meta({
      description: 'An `http_header` secret of the organization whose scope includes the base',
    }),
  })
  .meta({ id: 'HttpRequestAuth' });

export const httpRequestBodySchema = z
  .discriminatedUnion('type', [
    z.strictObject({ type: z.literal('json'), value: httpRequestValueSchema }).meta({
      id: 'HttpRequestJsonBody',
      description:
        '`application/json`: a literal is sent as its JSON; a template is rendered with each ' +
        'placeholder value escaped as JSON string content (write `"{{ [fld_…] }}"` for a ' +
        'string) and must then parse as JSON (`invalid_value`); a field, step or trigger ' +
        'value is sent as its JSON',
    }),
    z
      .strictObject({
        type: z.literal('form'),
        fields: z.array(httpRequestPairSchema).max(HTTP_REQUEST_MAX_FORM_FIELDS),
      })
      .meta({
        id: 'HttpRequestFormBody',
        description: '`application/x-www-form-urlencoded`, one pair per field (values as text)',
      }),
    z
      .strictObject({
        type: z.literal('text'),
        value: z.union([httpRequestValueSchema, digestValueSchema]),
      })
      .meta({ id: 'HttpRequestTextBody', description: '`text/plain; charset=utf-8`' }),
  ])
  .meta({ id: 'HttpRequestBody' });
export type HttpRequestBody = z.infer<typeof httpRequestBodySchema>;

export const httpRequestConfigSchema = z
  .strictObject({
    method: z.enum(HTTP_REQUEST_METHODS),
    url: httpRequestValueSchema.meta({
      description:
        'The URL (`http`/`https`, ≤ 2,048 characters with the query); a literal is checked ' +
        'when saved (`INVALID_URL`), the address when called (CONTRACTS §25.4)',
    }),
    query: z
      .array(httpRequestPairSchema)
      .max(HTTP_REQUEST_MAX_QUERY_PARAMS)
      .default([])
      .meta({ description: 'Parameters appended to the query of the URL (encoded)' }),
    headers: z
      .array(httpRequestHeaderSchema)
      .max(HTTP_REQUEST_MAX_HEADERS)
      .default([])
      .meta({
        description:
          'Header values are one line (line breaks become spaces), cut at 8,192 characters; ' +
          'names the outbox sets or that belong to the connection are `HEADER_NOT_ALLOWED`, ' +
          'like a name given twice',
      }),
    auth: httpRequestAuthSchema.nullable().default(null),
    body: httpRequestBodySchema
      .nullable()
      .default(null)
      .meta({ description: 'Not with `GET`. A `Content-Type` header replaces the default type' }),
    signing_secret_id: idOf('sec')
      .nullable()
      .default(null)
      .meta({
        description:
          'A `webhook_signing` secret: the request carries `webhook-signature` (Standard ' +
          'Webhooks; two signatures for 24 hours after the secret is replaced)',
      }),
    fail_on_http_error: z
      .boolean()
      .default(true)
      .meta({
        description:
          '`false`: a final `3xx`/`4xx`/`5xx` ends the step `succeeded` with its `status` in ' +
          'the output (temporary statuses are still retried first)',
      }),
  })
  .refine((config) => config.method !== 'GET' || config.body === null, {
    message: 'A GET request has no body',
    path: ['body'],
  })
  .meta({ id: 'HttpRequestConfig' });
export type HttpRequestConfig = z.infer<typeof httpRequestConfigSchema>;
export type HttpRequestConfigInput = z.input<typeof httpRequestConfigSchema>;

export const httpRequestActionSchema = z
  .strictObject({
    id: automationActionIdSchema,
    type: z.literal('http_request'),
    config: httpRequestConfigSchema,
  })
  .meta({
    id: 'HttpRequestAction',
    description:
      'Output once delivered: `{ delivery_id, status, headers: { content-type }, body, ' +
      'body_truncated }` (`HttpStepOutput`; usable later as `{ "step": "act_…", "path": ' +
      '"body.id" }`); while waiting `{ delivery_id }`',
  });

// --- Run step -------------------------------------------------------------------------

/**
 * `error.code` of a failed `http_request` step besides the delivery codes
 * (`HTTP_DELIVERY_STEP_ERROR_CODES`, `secret_unavailable`) and
 * `invalid_value` (a URL value that is not text, a JSON body template that
 * does not parse — `params.field`, `params.reason`):
 * - `http_request_too_large` — the rendered body is larger than 1 MiB
 *   (`params.limit_bytes`).
 */
export const HTTP_REQUEST_STEP_ERROR_CODES = ['http_request_too_large'] as const;
export type HttpRequestStepErrorCode = (typeof HTTP_REQUEST_STEP_ERROR_CODES)[number];

/** All values of a config, in order (save checks, run-log visibility). */
export function httpRequestValuesOf(
  config: Pick<HttpRequestConfig, 'url' | 'query' | 'headers' | 'body'>,
): z.infer<typeof automationValueSchema>[] {
  const values: z.infer<typeof automationValueSchema>[] = [config.url];
  for (const item of config.query) values.push(item.value);
  for (const item of config.headers) values.push(item.value);
  const body = config.body;
  if (body !== null) {
    if (body.type === 'form') for (const item of body.fields) values.push(item.value);
    else values.push(body.value);
  }
  return values;
}
