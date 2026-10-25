import {
  ERROR_STATUS,
  problemTitle,
  problemTypeUri,
  type ErrorCode,
  type ErrorStatus,
  type ProblemDetails,
  type ProblemErrorItem,
} from '@cellhive/contracts';

export interface AppErrorOptions {
  /** English explanation for this occurrence; returned to the client as `detail`. */
  readonly detail?: string;
  /** Per-location problems (`errors[]` of CONTRACTS §6). */
  readonly errors?: readonly ProblemErrorItem[];
  /**
   * Structured values describing the problem, for logs and for callers that
   * inspect the error. Never serialised to the client (translation parameters
   * belong in `errors[].params`).
   */
  readonly params?: Readonly<Record<string, unknown>>;
  /** Underlying error, logged server-side only. */
  readonly cause?: unknown;
  /**
   * Seconds after which the client may retry; sent as the `Retry-After`
   * header (`429 RATE_LIMITED`, `423 ACCOUNT_LOCKED`). Rounded up, at least 1.
   */
  readonly retryAfterSeconds?: number;
}

/**
 * The only error type services and controllers throw (AGENTS.md). The HTTP
 * status is derived from `code` through the CONTRACTS §6 catalogue, so a code
 * can never be sent with the wrong status.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: ErrorStatus;
  readonly detail: string | undefined;
  readonly errors: readonly ProblemErrorItem[] | undefined;
  readonly params: Readonly<Record<string, unknown>> | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    super(options.detail ?? problemTitle(code), { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.detail = options.detail;
    this.errors = options.errors;
    this.params = options.params;
    this.retryAfterSeconds =
      options.retryAfterSeconds === undefined
        ? undefined
        : Math.max(1, Math.ceil(options.retryAfterSeconds));
  }

  /** The RFC 9457 document sent to the client for this error. */
  toProblem(requestId: ProblemDetails['request_id']): ProblemDetails {
    return buildProblem(this.code, requestId, { detail: this.detail, errors: this.errors });
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/**
 * Builds a problem document for `code` (CONTRACTS §6). `type`, `title` and
 * `status` always agree with the code.
 */
export function buildProblem(
  code: ErrorCode,
  requestId: ProblemDetails['request_id'],
  extra: {
    readonly detail?: string | undefined;
    readonly errors?: readonly ProblemErrorItem[] | undefined;
  } = {},
): ProblemDetails {
  const problem: ProblemDetails = {
    type: problemTypeUri(code),
    title: problemTitle(code),
    status: ERROR_STATUS[code],
    code,
    request_id: requestId,
  };
  if (extra.detail !== undefined) problem.detail = extra.detail;
  if (extra.errors !== undefined && extra.errors.length > 0) {
    problem.errors = extra.errors.map((item) => ({ ...item }));
  }
  return problem;
}
