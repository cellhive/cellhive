/**
 * Failure codes of an outbound HTTP call (ADR-35 §3; step error codes of
 * CONTRACTS §21 once an action uses them, T605/T606):
 *
 * - `ssrf_blocked` — refused before any connection, `params.reason`:
 *   `private_address` (private/loopback address not opened by the
 *   allowlist), `blocked_address` (never reachable: metadata, unspecified,
 *   multicast, broadcast, reserved), `port_not_allowed` (not 80/443 and no
 *   allowlist entry names it), `invalid_url` (scheme, user info, zone id,
 *   length, host), `unresolvable` (no address, DNS failure or timeout;
 *   `params.cause` = `timeout` or `temporary` (`EAI_AGAIN`) when trying
 *   again later may work — QA S5c);
 * - `http_timeout` — connection (5 s) or whole call (10 s) took too long;
 * - `http_network` — refused, reset, TLS failure…;
 * - `http_response_too_large` — the body (after decompression) passed the cap.
 *
 * Messages never carry the URL, the resolved address, headers or bodies.
 */
export type OutboundErrorCode =
  'ssrf_blocked' | 'http_timeout' | 'http_network' | 'http_response_too_large';

export const SSRF_BLOCK_REASONS = [
  'private_address',
  'blocked_address',
  'port_not_allowed',
  'invalid_url',
  'unresolvable',
] as const;

export type SsrfBlockReason = (typeof SSRF_BLOCK_REASONS)[number];

const MESSAGES: Record<OutboundErrorCode, string> = {
  ssrf_blocked: 'The address of this URL may not be called.',
  http_timeout: 'The server did not answer in time.',
  http_network: 'The connection to the server failed.',
  http_response_too_large: 'The response is too large.',
};

export class OutboundHttpError extends Error {
  readonly code: OutboundErrorCode;
  /** `{ reason }` for `ssrf_blocked`; `{ limit_bytes }` for a response too large. */
  readonly params: Readonly<Record<string, string | number>>;

  constructor(code: OutboundErrorCode, params: Readonly<Record<string, string | number>> = {}) {
    super(MESSAGES[code]);
    this.name = 'OutboundHttpError';
    this.code = code;
    this.params = params;
  }
}

export function ssrfBlocked(
  reason: SsrfBlockReason,
  extra: Readonly<Record<string, string | number>> = {},
): OutboundHttpError {
  return new OutboundHttpError('ssrf_blocked', { ...extra, reason });
}

/** Why a name could not be resolved for now (`params.cause` of `unresolvable`). */
export const TEMPORARY_UNRESOLVABLE_CAUSES: ReadonlySet<string> = new Set(['timeout', 'temporary']);

export function isOutboundHttpError(error: unknown): error is OutboundHttpError {
  return error instanceof OutboundHttpError;
}
