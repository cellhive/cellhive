import {
  isIndexRowTooLarge,
  isStatementTimeout,
  uniqueValueTooLongError,
} from '@cellhive/server-core/db';
import { isAppError } from '@cellhive/server-core/errors';
import { HttpException } from '@nestjs/common';

import type { ErrorCode, ProblemErrorItem } from '@cellhive/contracts';

export interface ResolvedProblem {
  readonly code: ErrorCode;
  readonly detail?: string;
  readonly errors?: readonly ProblemErrorItem[];
  /** True when the failure is ours (5xx): log with the stack. */
  readonly unexpected: boolean;
  /** `Retry-After` header value in seconds. */
  readonly retryAfterSeconds?: number;
  /**
   * The client went away mid-request (a cancelled upload): nothing failed on
   * our side, so it is logged at `info` without a stack, never as `INTERNAL`.
   */
  readonly clientAborted?: true;
}

/** Error codes of a connection the peer closed while its body was being read. */
const ABORT_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
  'ERR_STREAM_PREMATURE_CLOSE',
]);

/**
 * Whether `error` is a read of the request body cut short by the client
 * (`ECONNRESET` "aborted" of Node's `IncomingMessage`, premature close). Only
 * meaningful together with the state of the request's socket (`clientGone`
 * of `resolveProblem`): the same codes from an outgoing connection (object
 * storage, database) are failures of ours.
 */
export function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && ABORT_CODES.has(code)) return true;
  return error instanceof Error && error.message === 'aborted';
}

/** HTTP status → catalogue code for framework errors that carry only a status. */
const STATUS_CODES: Readonly<Record<number, ErrorCode>> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  403: 'PERMISSION_DENIED',
  404: 'NOT_FOUND',
  405: 'NOT_FOUND',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'VALIDATION_FAILED',
  429: 'RATE_LIMITED',
  503: 'DEPENDENCY_UNAVAILABLE',
};

/** Fastify body-parsing errors (`FST_ERR_CTP_*`). */
const FASTIFY_CODES: Readonly<Record<string, { code: ErrorCode; detail: string }>> = {
  FST_ERR_CTP_INVALID_JSON_BODY: {
    code: 'MALFORMED_JSON',
    detail: 'The request body is not valid JSON.',
  },
  FST_ERR_CTP_EMPTY_JSON_BODY: {
    code: 'MALFORMED_JSON',
    detail: 'The request body is empty but Content-Type is application/json.',
  },
  FST_ERR_CTP_INVALID_MEDIA_TYPE: {
    code: 'UNSUPPORTED_MEDIA_TYPE',
    detail: 'Unsupported Content-Type; send application/json.',
  },
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: {
    code: 'MALFORMED_JSON',
    detail: 'The request body does not match its Content-Length.',
  },
  FST_ERR_CTP_BODY_TOO_LARGE: {
    code: 'PAYLOAD_TOO_LARGE',
    detail: 'The request body exceeds the size limit.',
  },
};

function statusOf(error: unknown): number | undefined {
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === 'number' && Number.isInteger(status) ? status : undefined;
}

function fastifyCodeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.startsWith('FST_') ? code : undefined;
}

/**
 * Decides which CONTRACTS §6 problem an exception becomes. Only `AppError`
 * contributes its own `detail`/`errors`; other errors get fixed English
 * texts, so messages and stacks of unexpected errors never reach the client.
 */
export function resolveProblem(
  error: unknown,
  request: { readonly clientGone?: boolean } = {},
): ResolvedProblem {
  if (request.clientGone === true && isAbortError(error)) {
    return {
      code: 'VALIDATION_FAILED',
      detail: 'The request was cancelled by the client.',
      unexpected: false,
      clientAborted: true,
    };
  }
  // A long text written to a unique field (its B-tree index cannot hold it).
  if (isIndexRowTooLarge(error)) return resolveProblem(uniqueValueTooLongError(error), request);
  if (isAppError(error)) {
    return {
      code: error.code,
      ...(error.detail === undefined ? {} : { detail: error.detail }),
      ...(error.errors === undefined ? {} : { errors: error.errors }),
      ...(error.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: error.retryAfterSeconds }),
      unexpected: error.status >= 500,
    };
  }

  if (error instanceof HttpException) {
    const code = STATUS_CODES[error.getStatus()];
    return code === undefined
      ? { code: 'INTERNAL', unexpected: true }
      : { code, unexpected: false };
  }

  // A query outside `db.withTx` cancelled by the session statement_timeout.
  if (isStatementTimeout(error)) return { code: 'QUERY_TIMEOUT', unexpected: true };

  const fastifyCode = fastifyCodeOf(error);
  if (fastifyCode !== undefined) {
    const known = FASTIFY_CODES[fastifyCode];
    if (known !== undefined) return { ...known, unexpected: false };
  }

  // Errors raised while reading the body (aborted uploads, bad chunking).
  const status = statusOf(error);
  if (status === 400 && fastifyCode === undefined) {
    return {
      code: 'MALFORMED_JSON',
      detail: 'The request body could not be read.',
      unexpected: false,
    };
  }
  if (status !== undefined && status >= 400 && status < 500) {
    const code = STATUS_CODES[status];
    if (code !== undefined) return { code, unexpected: false };
  }

  return { code: 'INTERNAL', unexpected: true };
}
