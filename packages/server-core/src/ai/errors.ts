import { AppError } from '../errors/app-error.js';

import type { AiProviderErrorReason } from '@cellhive/contracts';

/**
 * Errors of the AI core (CONTRACTS §29.7, ADR-39). `params` are for logs and
 * callers (`temporary`: a worker may try again — 429, 5xx, timeout,
 * network); `errors[0].params` is what the client translates. Nothing here
 * carries a prompt, a body, a key or a full URL: the provider is named by its
 * host only.
 */

/** HTTP statuses worth trying again later: rate limited or a server-side failure. */
function temporaryStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

const PROVIDER_MESSAGES: Record<AiProviderErrorReason, string> = {
  http_status: 'The AI provider answered with an error status.',
  network: 'The connection to the AI provider failed.',
  ssrf_blocked: 'The address of the AI provider may not be called.',
  secret_host_not_allowed: 'The API key may not be sent to the host of the provider URL.',
  secret_unavailable: 'The API key of the AI provider is missing or cannot be read.',
  invalid_response: 'The answer of the AI provider could not be read.',
  response_too_large: 'The answer of the AI provider is too large.',
  refused: 'The model refused to answer.',
  truncated: 'The answer of the model was cut off at its length limit.',
};

export interface AiProviderErrorExtra {
  /** Host (and port) of the provider — safe to log. */
  readonly host?: string;
  /** HTTP status, for `http_status`. */
  readonly status?: number;
  /** Underlying error, logged server-side only (never carries a URL or body). */
  readonly cause?: unknown;
  /** More log-only values (e.g. the SSRF block reason). */
  readonly params?: Readonly<Record<string, string | number>>;
}

/** `502 AI_PROVIDER_ERROR` with `params.reason` (and `status` for `http_status`). */
export function aiProviderError(
  reason: AiProviderErrorReason,
  extra: AiProviderErrorExtra = {},
): AppError {
  const message =
    reason === 'http_status' && extra.status !== undefined
      ? `The AI provider answered with HTTP status ${String(extra.status)}.`
      : PROVIDER_MESSAGES[reason];
  const clientParams = {
    reason,
    ...(extra.status === undefined ? {} : { status: extra.status }),
  };
  return new AppError('AI_PROVIDER_ERROR', {
    detail: message,
    errors: [{ path: '', code: 'AI_PROVIDER_ERROR', message, params: clientParams }],
    params: {
      ...extra.params,
      ...clientParams,
      ...(extra.host === undefined ? {} : { host: extra.host }),
      temporary:
        reason === 'network' ||
        (reason === 'http_status' && extra.status !== undefined && temporaryStatus(extra.status)),
    },
    ...(extra.cause === undefined ? {} : { cause: extra.cause }),
  });
}

/** `504 AI_TIMEOUT`: the time budget of the request (or one call) ran out. */
export function aiTimeout(host?: string): AppError {
  return new AppError('AI_TIMEOUT', {
    detail: 'The AI provider did not answer in time.',
    params: { temporary: true, ...(host === undefined ? {} : { host }) },
  });
}

/** `422 AI_INVALID_OUTPUT`: still invalid after the repair rounds. */
export function aiInvalidOutput(attempts: number): AppError {
  const message = `The answer was still not valid after ${String(attempts)} tries.`;
  return new AppError('AI_INVALID_OUTPUT', {
    detail: message,
    errors: [{ path: '', code: 'AI_INVALID_OUTPUT', message, params: { attempts } }],
    params: { attempts, temporary: false },
  });
}

/** Whether a failed AI call may succeed when tried again later (worker retry). */
export function isTemporaryAiError(error: unknown): boolean {
  return error instanceof AppError && error.params?.['temporary'] === true;
}
