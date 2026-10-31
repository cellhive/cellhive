import { describe, expect, it } from 'vitest';

import {
  ERROR_CODES,
  ERROR_STATUS,
  errorCodeSchema,
  errorStatus,
  isErrorCode,
  problemDetailsSchema,
  problemTitle,
  problemTypeUri,
  type ErrorCode,
} from '../src/errors.js';

/** The table in CONTRACTS §6, one row per code. */
const CONTRACT_ERRORS: readonly [ErrorCode, number][] = [
  ['MALFORMED_JSON', 400],
  ['UNAUTHENTICATED', 401],
  ['TOKEN_EXPIRED', 401],
  ['TOKEN_REVOKED', 401],
  ['PERMISSION_DENIED', 403],
  ['INSUFFICIENT_SCOPE', 403],
  ['RECORD_RULE_VIOLATION', 403],
  ['FIELD_READ_ONLY', 403],
  ['PUBLIC_SHARING_DISABLED', 403],
  ['API_TOKENS_DISABLED', 403],
  ['MCP_DISABLED', 403],
  ['CSRF_INVALID', 403],
  ['SHARE_PASSWORD_REQUIRED', 403],
  ['SHARE_PASSWORD_INVALID', 403],
  ['NOT_FOUND', 404],
  ['VERSION_CONFLICT', 409],
  ['NAME_CONFLICT', 409],
  ['IDEMPOTENCY_KEY_REUSED', 409],
  ['SETUP_COMPLETED', 409],
  ['SCHEMA_LOCKED', 409],
  ['SUBMISSION_LIMIT_REACHED', 409],
  ['RUN_STATE_CONFLICT', 409],
  ['SECRET_IN_USE', 409],
  ['WEBHOOK_IN_USE', 409],
  ['SHARE_LINK_GONE', 410],
  ['INVITATION_INVALID', 410],
  ['PAYLOAD_TOO_LARGE', 413],
  ['UNSUPPORTED_MEDIA_TYPE', 415],
  ['VALIDATION_FAILED', 422],
  ['INVALID_CELL_VALUE', 422],
  ['REQUIRED_FIELD_MISSING', 422],
  ['UNIQUE_VIOLATION', 422],
  ['INVALID_SELECT_OPTION', 422],
  ['LINK_TARGET_NOT_FOUND', 422],
  ['SUBRECORD_CYCLE', 422],
  ['SUBRECORD_TOO_DEEP', 422],
  ['INVALID_FILTER', 422],
  ['INVALID_SORT', 422],
  ['FORMULA_SYNTAX_ERROR', 422],
  ['FORMULA_TYPE_ERROR', 422],
  ['FORMULA_CYCLE', 422],
  ['FORMULA_LIMIT_EXCEEDED', 422],
  ['CONVERSION_NOT_ALLOWED', 422],
  ['CONVERSION_REQUIRES_CONFIRM', 422],
  ['TOO_MANY_OPTIONS', 422],
  ['FIELD_LIMIT_EXCEEDED', 422],
  ['UPSERT_AMBIGUOUS', 422],
  ['AUTOMATION_INVALID', 422],
  ['RESET_TOKEN_INVALID', 410],
  ['INVALID_PACKAGE', 422],
  ['SMTP_NOT_CONFIGURED', 422],
  ['TELEGRAM_NOT_CONFIGURED', 422],
  ['EMAIL_VERIFICATION_INVALID', 422],
  ['AI_INVALID_OUTPUT', 422],
  ['AI_NOT_CONFIGURED', 422],
  ['AI_RECORD_DATA_DISABLED', 422],
  ['ACCOUNT_LOCKED', 423],
  ['RATE_LIMITED', 429],
  ['AI_QUOTA_EXCEEDED', 429],
  ['INTERNAL', 500],
  ['AI_PROVIDER_ERROR', 502],
  ['DEPENDENCY_UNAVAILABLE', 503],
  ['QUERY_TIMEOUT', 504],
  ['AI_TIMEOUT', 504],
];

const REQUEST_ID = 'req_9fK2mQ1xZp0aB7cD';

/** The example document from CONTRACTS §6, with a well-formed request ID. */
const CONTRACT_EXAMPLE = {
  type: 'https://cellhive.io/errors/INVALID_CELL_VALUE',
  title: 'Invalid cell value',
  status: 422,
  code: 'INVALID_CELL_VALUE',
  detail: "Field 'Số tiền' expects a number.",
  errors: [
    {
      path: 'records[0].fields.Số tiền',
      code: 'EXPECTED_NUMBER',
      message: 'Expected number, got string',
    },
  ],
  request_id: REQUEST_ID,
};

describe('error catalogue', () => {
  it.each(CONTRACT_ERRORS)('%s → %i', (code, status) => {
    expect(ERROR_STATUS[code]).toBe(status);
    expect(errorStatus(code)).toBe(status);
    expect(isErrorCode(code)).toBe(true);
    expect(errorCodeSchema.safeParse(code).success).toBe(true);
  });

  it('has exactly the codes of CONTRACTS §6', () => {
    expect([...ERROR_CODES].sort()).toEqual(CONTRACT_ERRORS.map(([code]) => code).sort());
  });

  it('gives every code a valid HTTP error status', () => {
    for (const code of ERROR_CODES) {
      expect(ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
      expect(ERROR_STATUS[code]).toBeLessThan(600);
    }
  });

  it.each(['not_found', 'EXPECTED_NUMBER', 'toString', '', 404])(
    'rejects %j as a code',
    (value) => {
      expect(isErrorCode(value)).toBe(false);
      expect(errorCodeSchema.safeParse(value).success).toBe(false);
    },
  );

  it.each([
    ['INVALID_CELL_VALUE', 'Invalid cell value'],
    ['NOT_FOUND', 'Not found'],
    ['INTERNAL', 'Internal'],
  ] as const)('problemTitle(%s) = %s', (code, title) => {
    expect(problemTitle(code)).toBe(title);
  });

  it('builds the problem type URI', () => {
    expect(problemTypeUri('NOT_FOUND')).toBe('https://cellhive.io/errors/NOT_FOUND');
  });
});

describe('problemDetailsSchema', () => {
  it('accepts the CONTRACTS §6 example', () => {
    expect(problemDetailsSchema.parse(CONTRACT_EXAMPLE)).toEqual(CONTRACT_EXAMPLE);
  });

  it('accepts a minimal problem and errors[].params', () => {
    const minimal = {
      type: problemTypeUri('FORMULA_SYNTAX_ERROR'),
      title: problemTitle('FORMULA_SYNTAX_ERROR'),
      status: 422,
      code: 'FORMULA_SYNTAX_ERROR',
      errors: [
        {
          path: 'formula',
          code: 'UNEXPECTED_TOKEN',
          message: 'Unexpected )',
          params: { position: 7 },
        },
      ],
      request_id: REQUEST_ID,
    };
    expect(problemDetailsSchema.safeParse(minimal).success).toBe(true);
  });

  const invalid: { name: string; patch: Record<string, unknown>; path: string }[] = [
    { name: 'status disagrees with code', patch: { status: 400 }, path: 'status' },
    {
      name: 'type disagrees with code',
      patch: { type: problemTypeUri('NOT_FOUND') },
      path: 'type',
    },
    { name: 'unknown code', patch: { code: 'NOPE' }, path: 'code' },
    {
      name: 'request_id with wrong prefix',
      patch: { request_id: 'evt_9fK2mQ1xZp0aB7cD' },
      path: 'request_id',
    },
    { name: 'placeholder request_id', patch: { request_id: 'req_…' }, path: 'request_id' },
    { name: 'missing title', patch: { title: undefined }, path: 'title' },
    {
      name: 'errors item without message',
      patch: { errors: [{ path: 'x', code: 'Y' }] },
      path: 'errors',
    },
  ];

  it.each(invalid)('rejects when $name', ({ patch, path }) => {
    const result = problemDetailsSchema.safeParse({ ...CONTRACT_EXAMPLE, ...patch });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => String(issue.path[0]))).toContain(path);
  });
});
