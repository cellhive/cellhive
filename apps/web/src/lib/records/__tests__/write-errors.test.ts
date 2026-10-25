import { describe, expect, it } from 'vitest';

import { ApiError, type ApiErrorInit } from '../../api/client';
import { classifyWriteError } from '../write-errors';

const FIELD = 'fld_Amount0000000001';

function apiError(init: Partial<ApiErrorInit> & Pick<ApiErrorInit, 'status' | 'code'>) {
  return new ApiError({ request_id: 'req_0123456789ABCDEF', ...init });
}

describe('classifyWriteError (FRONTEND §4.1 error table)', () => {
  it.each([
    ['network', apiError({ status: 0, code: 'NETWORK_ERROR' }), 'transient'],
    ['500', apiError({ status: 500, code: 'INTERNAL' }), 'transient'],
    ['503', apiError({ status: 503, code: 'DEPENDENCY_UNAVAILABLE' }), 'transient'],
    ['429', apiError({ status: 429, code: 'RATE_LIMITED' }), 'transient'],
    ['schema locked', apiError({ status: 409, code: 'SCHEMA_LOCKED' }), 'schema_locked'],
    ['not found', apiError({ status: 404, code: 'NOT_FOUND' }), 'not_found'],
    ['field read only', apiError({ status: 403, code: 'FIELD_READ_ONLY' }), 'denied'],
    ['record rule', apiError({ status: 403, code: 'RECORD_RULE_VIOLATION' }), 'denied'],
    ['permission', apiError({ status: 403, code: 'PERMISSION_DENIED' }), 'denied'],
    ['unique', apiError({ status: 422, code: 'UNIQUE_VIOLATION' }), 'cell'],
    ['required', apiError({ status: 422, code: 'REQUIRED_FIELD_MISSING' }), 'cell'],
    ['option', apiError({ status: 422, code: 'INVALID_SELECT_OPTION' }), 'cell'],
    ['link', apiError({ status: 422, code: 'LINK_TARGET_NOT_FOUND' }), 'cell'],
    ['bad request', apiError({ status: 422, code: 'VALIDATION_FAILED' }), 'fatal'],
    ['not an ApiError', new TypeError('boom'), 'fatal'],
  ])('%s → %s', (_name, error, kind) => {
    expect(classifyWriteError(error, FIELD).kind).toBe(kind);
  });

  it('reads who wrote the record from VERSION_CONFLICT params', () => {
    const error = apiError({
      status: 409,
      code: 'VERSION_CONFLICT',
      errors: [
        {
          path: 'records[0].version',
          code: 'VERSION_CONFLICT',
          message: 'changed',
          params: {
            current_version: 5,
            version: 4,
            updated_at: '2026-09-24T01:00:00.000Z',
            updated_by: { id: 'usr_0123456789ABCDEF', name: 'Nguyễn Minh Anh' },
          },
        },
      ],
    });
    expect(classifyWriteError(error, FIELD)).toEqual({
      kind: 'conflict',
      currentVersion: 5,
      updatedBy: { id: 'usr_0123456789ABCDEF', name: 'Nguyễn Minh Anh' },
      updatedAt: '2026-09-24T01:00:00.000Z',
    });
    expect(classifyWriteError(apiError({ status: 409, code: 'VERSION_CONFLICT' }), FIELD)).toEqual({
      kind: 'conflict',
      currentVersion: null,
      updatedBy: null,
      updatedAt: null,
    });
  });

  it('keeps the detail about the edited cell for the tooltip', () => {
    const error = apiError({
      status: 422,
      code: 'INVALID_CELL_VALUE',
      errors: [
        { path: 'records[0].fields.fld_Other00000000001', code: 'EXPECTED_STRING', message: 'x' },
        {
          path: `records[0].fields.${FIELD}`,
          code: 'EXPECTED_NUMBER',
          message: 'Expected number',
          params: { received: 'string' },
        },
      ],
    });
    expect(classifyWriteError(error, FIELD)).toMatchObject({
      kind: 'cell',
      detail: {
        code: 'EXPECTED_NUMBER',
        message: 'Expected number',
        params: { received: 'string' },
      },
    });
    // Without items the top-level code explains (UNIQUE_VIOLATION).
    expect(
      classifyWriteError(apiError({ status: 422, code: 'UNIQUE_VIOLATION' }), FIELD),
    ).toMatchObject({ kind: 'cell', detail: { code: 'UNIQUE_VIOLATION' } });
  });
});
