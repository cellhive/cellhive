/**
 * The HTTP step of a run read for display (BACKLOG T614; CONTRACTS §21,
 * §25.5; FRONTEND §13.3): where the delivery stands (`delivery` of the run
 * step — host only, attempts, last HTTP status and error, next attempt) and
 * the response the step returned once it succeeded, its body as the server
 * redacted it for the viewer. Pure: nothing is rebuilt, a body the server
 * hid stays hidden, and no URL, header or request body ever exists here.
 */

import type { AutomationRunStepDto, HttpDeliverySummary } from '@cellhive/contracts';

/**
 * Attempts of one delivery (`HTTP_DELIVERY_MAX_ATTEMPTS`, CONTRACTS §25.6 —
 * pinned equal by the unit test): a local copy, because importing the value
 * would add it to the shared contracts chunk of the app shell (FRONTEND §11.1).
 */
export const MAX_DELIVERY_ATTEMPTS = 6;

/** Actions that call out through the HTTP outbox (T606, T607). */
export const HTTP_STEP_TYPES: ReadonlySet<string> = new Set(['http_request', 'run_n8n_workflow']);

/** Whether a step is an HTTP step: by type, or because the server sent its delivery. */
export function isHttpStep(
  type: string | null,
  step: Pick<AutomationRunStepDto, 'delivery'> | undefined | null,
): boolean {
  if (step?.delivery !== undefined) return true;
  return type !== null && HTTP_STEP_TYPES.has(type);
}

/**
 * Where a delivery stands, as the screen words it:
 *
 * - `queued`: not tried yet (or held by the pacer — attempts are not counted then);
 * - `retry`: an attempt failed with a temporary error, the next one is planned;
 * - `paused`: the destination answered `429`/`503` — it asked to wait
 *   (`Retry-After` is honoured up to one hour, CONTRACTS §25.5);
 * - `sending`, `succeeded`, `failed`, `cancelled`: as the delivery status.
 */
export type DeliveryPhase =
  'queued' | 'retry' | 'paused' | 'sending' | 'succeeded' | 'failed' | 'cancelled';

const WAIT_STATUSES: ReadonlySet<number> = new Set([429, 503]);

export function deliveryPhaseOf(
  delivery: Pick<HttpDeliverySummary, 'status' | 'attempts' | 'last_status' | 'next_attempt_at'>,
): DeliveryPhase {
  if (delivery.status !== 'pending') return delivery.status;
  if (delivery.attempts === 0 || delivery.next_attempt_at === null) return 'queued';
  if (delivery.last_status !== null && WAIT_STATUSES.has(delivery.last_status)) return 'paused';
  return 'retry';
}

/** The body of a response: hidden from the viewer, empty, or text to show as is. */
export type HttpBodyView =
  | { readonly kind: 'hidden' }
  | { readonly kind: 'empty' }
  | { readonly kind: 'text'; readonly text: string };

export interface HttpResponseView {
  readonly status: number | null;
  readonly contentType: string | null;
  /** The server kept the first 10 KB only. */
  readonly truncated: boolean;
  readonly body: HttpBodyView;
}

type Json = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bodyOf(body: unknown, redacted: boolean): HttpBodyView {
  if (body === null || body === undefined) return redacted ? { kind: 'hidden' } : { kind: 'empty' };
  if (typeof body === 'string')
    return body === '' ? { kind: 'empty' } : { kind: 'text', text: body };
  // A JSON value the server parsed (body ≤ 10 KB): shown pretty-printed, never interpreted.
  return { kind: 'text', text: JSON.stringify(body, null, 2) };
}

/**
 * The response of an HTTP step (`{ status, headers: { content-type }, body,
 * body_truncated }`, CONTRACTS §25.5), or `null` when the step has none
 * (not succeeded yet). A `null` body with `redacted` is hidden (CONTRACTS §21:
 * shown only to a viewer who reads every value the step used — always hidden
 * when a value came from a previous HTTP step).
 */
export function httpResponseOf(
  step: Pick<AutomationRunStepDto, 'output' | 'redacted'>,
): HttpResponseView | null {
  const output = step.output;
  if (!isObject(output)) return null;
  const status = output['status'];
  const headers = isObject(output['headers']) ? output['headers'] : {};
  const contentType = headers['content-type'];
  return {
    status: typeof status === 'number' && Number.isInteger(status) ? status : null,
    contentType: typeof contentType === 'string' ? contentType : null,
    truncated: output['body_truncated'] === true,
    body: bodyOf(output['body'], step.redacted),
  };
}

/**
 * What to tell about an `ssrf_blocked` error (CONTRACTS §25.4): an owner or
 * admin may open a private address or another port in the organization's
 * HTTP allowlist (`allowlist`); cloud metadata, broadcast… never open
 * (`never`); a host name that does not resolve is checked by the author
 * (`host`); otherwise nothing more than the error sentence.
 */
export type AllowlistHint = 'allowlist' | 'never' | 'host';

export function allowlistHintOf(
  error: {
    readonly code: string;
    readonly params?: Readonly<Record<string, unknown>> | undefined;
  } | null,
): AllowlistHint | null {
  if (error === null || error.code !== 'ssrf_blocked') return null;
  switch (error.params?.['reason']) {
    case 'private_address':
    case 'port_not_allowed':
      return 'allowlist';
    case 'blocked_address':
      return 'never';
    case 'unresolvable':
      return 'host';
    default:
      return null;
  }
}
