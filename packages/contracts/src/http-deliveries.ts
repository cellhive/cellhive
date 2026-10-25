import { z } from 'zod';

import { httpRequestConfigSchema } from './automation-actions/http-request.js';
import { runN8nWorkflowConfigSchema } from './automation-actions/run-n8n-workflow.js';
import { isoDateTimeSchema } from './common.js';
import { idOf } from './ids.js';

/**
 * Outbound HTTP through the two-phase outbox (SPEC §5.10
 * `meta.http_deliveries`, §11.7; CONTRACTS §25.5; ADR-35 §4; BACKLOG
 * T605). An HTTP step of an automation (`http_request`, `run_n8n_workflow`
 * — T606/T607) never calls the network inside its transaction: it inserts
 * a delivery row (`pending`, request encrypted) and the run waits; the job
 * `http.deliver` leases the row, commits, calls the destination through
 * the SSRF guard (§25.4), then records the result and wakes the run.
 */

export const httpDeliveryIdSchema = idOf('hdl');

/** `action`: a step of a run; `test`: "send a test" of an action (T606, kept 24 hours). */
export const HTTP_DELIVERY_KINDS = ['action', 'test'] as const;
export type HttpDeliveryKind = (typeof HTTP_DELIVERY_KINDS)[number];

/**
 * `pending` (waiting for its next attempt), `sending` (leased by a worker
 * until `lease_until`), then `succeeded` | `failed` | `cancelled` (final:
 * the encrypted request is erased).
 */
export const HTTP_DELIVERY_STATUSES = [
  'pending',
  'sending',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type HttpDeliveryStatus = (typeof HTTP_DELIVERY_STATUSES)[number];
export const httpDeliveryStatusSchema = z.enum(HTTP_DELIVERY_STATUSES);

/** Attempts of one delivery, the first included (CONTRACTS §25.6). */
export const HTTP_DELIVERY_MAX_ATTEMPTS = 6;
/**
 * Base delay before attempts 2…6 (the first one is immediate): 10 s, 1 min,
 * 5 min, 15 min, 30 min — "Quyết định S5c" #3, ADR-35 §4.
 */
export const HTTP_DELIVERY_RETRY_DELAYS_MS = [10_000, 60_000, 300_000, 900_000, 1_800_000] as const;
/** Random jitter of each delay: ± 20 %. */
export const HTTP_DELIVERY_RETRY_JITTER = 0.2;
/** A `Retry-After` longer than this fails the delivery with `rate_limited`. */
export const HTTP_DELIVERY_MAX_RETRY_AFTER_MS = 60 * 60 * 1000;
/** How long a worker owns a `sending` row; a dead worker's row is taken again after it. */
export const HTTP_DELIVERY_LEASE_MS = 30_000;
/** Bytes of the response body kept in the step output and the delivery row. */
export const HTTP_DELIVERY_OUTPUT_BODY_MAX_BYTES = 10_240;
/** Largest rendered request body (CONTRACTS §25.6). */
export const HTTP_DELIVERY_REQUEST_BODY_MAX_BYTES = 1_048_576;
/** `test` deliveries are deleted after this (`maintenance.cleanup`). */
export const HTTP_TEST_DELIVERY_RETENTION_HOURS = 24;

/**
 * Temporary response statuses (retried): `408`, `425`, `429` and every
 * `5xx` but `501`. Anything else that is not `2xx` is permanent.
 */
export function isTemporaryHttpStatus(status: number): boolean {
  if (status === 408 || status === 425 || status === 429) return true;
  return status >= 500 && status <= 599 && status !== 501;
}

/**
 * `error.code` of an HTTP step (and of its run) — CONTRACTS §21, §25.5:
 *
 * - `ssrf_blocked` (`params.reason`: `invalid_url`, `port_not_allowed`,
 *   `private_address`, `blocked_address`, `unresolvable`) — permanent,
 *   except `unresolvable` with `params.cause` `timeout` / `temporary`
 *   (the resolver did not answer for now — retried, T616);
 * - `http_timeout`, `http_network` — temporary, retried; final after six
 *   attempts (`params.attempts`);
 * - `http_response_too_large` (`params.limit_bytes`) — permanent;
 * - `http_status` (`params.status`): a `3xx` (redirects are never followed),
 *   a `4xx` or `501` at once; `408`/`425`/`429`/`5xx` after six attempts;
 * - `rate_limited` (`params.retry_after_s`): the destination asked to wait
 *   more than one hour (`Retry-After`);
 * - `secret_host_not_allowed` (T701, ADR-36 §4; `params.purpose`: `auth` |
 *   `signing`, `params.secret_id`, `params.reason`: `not_listed` |
 *   `legacy_expired`): the host of the rendered URL is not in the
 *   `allowed_hosts` of the secret (or the transition period of a secret
 *   without a list is over) — permanent, checked before the secret is
 *   unsealed and before any DNS lookup or connection.
 *
 * `secret_unavailable` (the auth or signing secret was deleted or is no
 * longer usable in the base) is shared with `send_telegram`.
 */
export const HTTP_DELIVERY_STEP_ERROR_CODES = [
  'ssrf_blocked',
  'http_timeout',
  'http_network',
  'http_response_too_large',
  'http_status',
  'rate_limited',
  'secret_host_not_allowed',
] as const;
export type HttpDeliveryStepErrorCode = (typeof HTTP_DELIVERY_STEP_ERROR_CODES)[number];

/** `last_error` of a delivery: a code and its params, never a URL, header or body. */
export const httpDeliveryErrorSchema = z
  .strictObject({
    code: z.string().meta({ description: 'Step error code (`ssrf_blocked`, `http_status`…)' }),
    params: z
      .record(z.string(), z.union([z.string(), z.number()]))
      .optional()
      .meta({ description: '`reason`, `status`, `limit_bytes`, `retry_after_s`, `attempts`…' }),
  })
  .meta({ id: 'HttpDeliveryError' });
export type HttpDeliveryError = z.infer<typeof httpDeliveryErrorSchema>;

/**
 * `delivery` of an HTTP step in the run detail (`GET /automation-runs/:id`):
 * where it goes (host only) and how its attempts went — never the full
 * URL, headers, bodies or secret values.
 */
export const httpDeliverySummarySchema = z
  .strictObject({
    id: httpDeliveryIdSchema,
    target_host: z.string().meta({ description: 'Host of the URL (ASCII lower case), no port' }),
    attempts: z.int().min(0),
    status: httpDeliveryStatusSchema,
    last_status: z
      .int()
      .nullable()
      .meta({ description: 'HTTP status of the last response; `null` before one' }),
    last_error: httpDeliveryErrorSchema.nullable(),
    next_attempt_at: isoDateTimeSchema
      .nullable()
      .meta({ description: 'When a `pending` delivery is tried again; `null` once final' }),
  })
  .meta({ id: 'HttpDeliverySummary' });
export type HttpDeliverySummary = z.infer<typeof httpDeliverySummarySchema>;

/**
 * Output of an HTTP step that succeeded (`2xx`, or any final status of an
 * `http_request` with `fail_on_http_error: false` — T606): the status, the
 * response `content-type` and the body — parsed when it is JSON and fits,
 * else text — cut at 10 KB (`body_truncated`). In the run log the body is
 * shown only to a viewer who reads every field the step's values use
 * (CONTRACTS §21 "http_request"), else `null` with `redacted: true`.
 */
export const httpStepOutputSchema = z
  .strictObject({
    delivery_id: httpDeliveryIdSchema,
    status: z.int().min(100).max(599),
    headers: z.strictObject({ 'content-type': z.string().nullable() }),
    body: z.unknown().meta({ description: 'JSON value, text, or `null` for an empty body' }),
    body_truncated: z.boolean(),
  })
  .meta({ id: 'HttpStepOutput' });
export type HttpStepOutput = z.infer<typeof httpStepOutputSchema>;

// --- "Send a test" (T606, CONTRACTS §25.5) ---------------------------------------------

/**
 * `POST /automations/:automationId/actions/:actionId/http-test`: the step
 * — `http_request` or `run_n8n_workflow` (T616) — or the builder's `draft`
 * of it, rendered with the **caller's** permissions on `record_id` (a
 * record of the trigger table they read; `null`/absent = no record) and
 * sent through the outbox as a `test` delivery — no causation, kept 24
 * hours. With a `webhook.received` trigger the hook's captured sample is
 * the request the values read (T616).
 */
export const httpTestRequestSchema = z
  .strictObject({
    record_id: idOf('rec')
      .nullable()
      .default(null)
      .meta({
        description:
          'A record of the trigger table the caller reads (`null` = no record); through an API ' +
          'token it also needs `records:read`',
      }),
    draft: z
      .union([httpRequestConfigSchema, runN8nWorkflowConfigSchema])
      .optional()
      .meta({
        description:
          "The builder's unsaved configuration of the step (default: the saved one): an " +
          '`HttpRequestConfig` (has `method`) or a `RunN8nWorkflowConfig`, of the type of ' +
          'the saved step when it exists (another type → `404`)',
      }),
  })
  .meta({ id: 'HttpTestRequest' });
export type HttpTestRequest = z.infer<typeof httpTestRequestSchema>;

/**
 * Codes of the warnings of a test send (T616): `no_sample` — the trigger is
 * `webhook.received` and the hook has no captured sample, so values and
 * placeholders of the request (`{ "trigger": "body" }`, `[@body.…]`) were
 * empty.
 */
export const HTTP_TEST_WARNING_CODES = ['no_sample'] as const;
export type HttpTestWarningCode = (typeof HTTP_TEST_WARNING_CODES)[number];

export const httpTestWarningSchema = z
  .strictObject({ code: z.enum(HTTP_TEST_WARNING_CODES) })
  .meta({ id: 'HttpTestWarning' });
export type HttpTestWarning = z.infer<typeof httpTestWarningSchema>;

export const httpTestAcceptedSchema = z
  .object({
    delivery_id: httpDeliveryIdSchema,
    warnings: z.array(httpTestWarningSchema).meta({
      description:
        '`no_sample`: `webhook.received` trigger without a captured sample — the request ' +
        'values were empty (T616)',
    }),
  })
  .meta({ id: 'HttpTestAccepted', description: 'Read the result with `GET /http-deliveries/:id`' });
export type HttpTestAccepted = z.infer<typeof httpTestAcceptedSchema>;

/** The response a delivery kept: status, `content-type`, body cut at 10 KB. */
export const httpDeliveryResponseSchema = z
  .strictObject({
    status: z.int().min(100).max(599),
    headers: z.strictObject({ 'content-type': z.string().nullable() }),
    body: z.unknown().meta({ description: 'JSON value, text, or `null` for an empty body' }),
    body_truncated: z.boolean(),
  })
  .meta({ id: 'HttpDeliveryResponse' });
export type HttpDeliveryResponse = z.infer<typeof httpDeliveryResponseSchema>;

/**
 * `GET /http-deliveries/:id` — a `test` delivery, for the person who sent
 * it only (rendered with their permissions): where it stands, the response once
 * there is one (also the last one of a failed delivery) and the error code.
 * Never the URL, request headers, request body or secret values.
 */
export const httpDeliveryResultSchema = z
  .object({
    id: httpDeliveryIdSchema,
    kind: z.enum(HTTP_DELIVERY_KINDS),
    status: httpDeliveryStatusSchema,
    target_host: z.string(),
    attempts: z.int().min(0),
    response: httpDeliveryResponseSchema.nullable(),
    error: httpDeliveryErrorSchema.nullable(),
    created_at: isoDateTimeSchema,
    completed_at: isoDateTimeSchema.nullable(),
  })
  .meta({ id: 'HttpDeliveryResult' });
export type HttpDeliveryResult = z.infer<typeof httpDeliveryResultSchema>;
