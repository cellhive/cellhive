/**
 * The error catalogue (CONTRACTS §6) without zod: the web client's first
 * load (API client of `/login`, `/s/:token`, `/verify-sender`) needs
 * `isErrorCode`, and importing `errors.ts` would pull its zod schemas into
 * those pages (FRONTEND §11.1, like `client-constants.ts`). `errors.ts`
 * re-exports everything here.
 */

/**
 * Error catalogue (CONTRACTS §6): every `code` with its HTTP status. This map
 * is the single source of truth; adding a code means updating CONTRACTS §6 in
 * the same change.
 */
export const ERROR_STATUS = {
  MALFORMED_JSON: 400,
  UNAUTHENTICATED: 401,
  TOKEN_EXPIRED: 401,
  TOKEN_REVOKED: 401,
  PERMISSION_DENIED: 403,
  INSUFFICIENT_SCOPE: 403,
  RECORD_RULE_VIOLATION: 403,
  FIELD_READ_ONLY: 403,
  PUBLIC_SHARING_DISABLED: 403,
  API_TOKENS_DISABLED: 403,
  CSRF_INVALID: 403,
  SHARE_PASSWORD_REQUIRED: 403,
  SHARE_PASSWORD_INVALID: 403,
  NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  NAME_CONFLICT: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  SETUP_COMPLETED: 409,
  SCHEMA_LOCKED: 409,
  SUBMISSION_LIMIT_REACHED: 409,
  RUN_STATE_CONFLICT: 409,
  SECRET_IN_USE: 409,
  WEBHOOK_IN_USE: 409,
  SHARE_LINK_GONE: 410,
  INVITATION_INVALID: 410,
  RESET_TOKEN_INVALID: 410,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  VALIDATION_FAILED: 422,
  INVALID_CELL_VALUE: 422,
  REQUIRED_FIELD_MISSING: 422,
  UNIQUE_VIOLATION: 422,
  INVALID_SELECT_OPTION: 422,
  LINK_TARGET_NOT_FOUND: 422,
  SUBRECORD_CYCLE: 422,
  SUBRECORD_TOO_DEEP: 422,
  INVALID_FILTER: 422,
  INVALID_SORT: 422,
  FORMULA_SYNTAX_ERROR: 422,
  FORMULA_TYPE_ERROR: 422,
  FORMULA_CYCLE: 422,
  FORMULA_LIMIT_EXCEEDED: 422,
  CONVERSION_NOT_ALLOWED: 422,
  CONVERSION_REQUIRES_CONFIRM: 422,
  TOO_MANY_OPTIONS: 422,
  FIELD_LIMIT_EXCEEDED: 422,
  UPSERT_AMBIGUOUS: 422,
  AUTOMATION_INVALID: 422,
  INVALID_PACKAGE: 422,
  SMTP_NOT_CONFIGURED: 422,
  TELEGRAM_NOT_CONFIGURED: 422,
  EMAIL_VERIFICATION_INVALID: 422,
  ACCOUNT_LOCKED: 423,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  DEPENDENCY_UNAVAILABLE: 503,
  QUERY_TIMEOUT: 504,
} as const satisfies Record<string, number>;

export type ErrorCode = keyof typeof ERROR_STATUS;
export type ErrorStatus = (typeof ERROR_STATUS)[ErrorCode];

export const ERROR_CODES = Object.keys(ERROR_STATUS) as readonly ErrorCode[];

/** Base of the RFC 9457 `type` URI; the code is appended. */
export const PROBLEM_TYPE_BASE = 'https://cellhive.io/errors/';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.hasOwn(ERROR_STATUS, value);
}

export function errorStatus(code: ErrorCode): ErrorStatus {
  return ERROR_STATUS[code];
}

/** `type` URI of a problem document, e.g. `https://cellhive.io/errors/NOT_FOUND`. */
export function problemTypeUri(code: ErrorCode): string {
  return `${PROBLEM_TYPE_BASE}${code}`;
}

/** Default English `title`: the code in sentence case (`INVALID_CELL_VALUE` → `Invalid cell value`). */
export function problemTitle(code: ErrorCode): string {
  const words = code.toLowerCase().replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
