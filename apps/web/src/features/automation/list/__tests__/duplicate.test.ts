import { describe, expect, it } from 'vitest';

import {
  duplicateFailureOf,
  type DuplicateFailure,
  type DuplicateProblem,
} from '../model/duplicate';

const problem = (
  status: number,
  code: string,
  errors: DuplicateProblem['errors'] = [],
): DuplicateProblem => ({ status, code, errors });

describe('duplicateFailureOf (T556)', () => {
  const cases: [string, DuplicateProblem, DuplicateFailure][] = [
    ['deleted meanwhile', problem(404, 'NOT_FOUND'), 'gone'],
    ['visible but not managed (P43 u_editor)', problem(403, 'PERMISSION_DENIED'), 'forbidden'],
    [
      'button trigger: the source keeps the button',
      problem(422, 'AUTOMATION_INVALID', [
        { code: 'BUTTON_IN_USE', params: { automation_id: 'aut_1', reason: 'duplicate' } },
      ]),
      'button',
    ],
    [
      'BUTTON_IN_USE without the duplicate reason is not the button case',
      problem(422, 'AUTOMATION_INVALID', [{ code: 'BUTTON_IN_USE', params: {} }]),
      'invalid',
    ],
    [
      'P43 u_sales1: a field outside the caller’s permissions',
      problem(422, 'AUTOMATION_INVALID', [
        { code: 'UNKNOWN_FIELD', params: { field_id: 'fld_1' } },
      ]),
      'permissions',
    ],
    [
      'P43 u_sales1: a table outside the caller’s permissions',
      problem(422, 'AUTOMATION_INVALID', [{ code: 'UNKNOWN_TABLE' }]),
      'permissions',
    ],
    [
      'a write the caller may not make',
      problem(422, 'AUTOMATION_INVALID', [{ code: 'PERMISSION_DENIED' }]),
      'permissions',
    ],
    [
      'a sender the caller may not use',
      problem(422, 'AUTOMATION_INVALID', [{ code: 'EMAIL_IDENTITY_NOT_USABLE' }]),
      'permissions',
    ],
    [
      'an email image of the source is gone',
      problem(422, 'AUTOMATION_INVALID', [
        { code: 'EMAIL_IMAGE_NOT_FOUND', params: { asset_id: 'att_1' } },
      ]),
      'invalid',
    ],
    [
      'a name refused by validation',
      problem(422, 'VALIDATION_FAILED', [{ code: 'TOO_BIG' }]),
      'invalid',
    ],
    ['rate limited', problem(429, 'RATE_LIMITED'), 'other'],
    ['server error', problem(500, 'INTERNAL_ERROR'), 'other'],
  ];
  it.each(cases)('%s', (_name, input, expected) => {
    expect(duplicateFailureOf(input)).toBe(expected);
  });
});
