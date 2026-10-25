import { describe, expect, it } from 'vitest';

import { ApiError } from '../../api/client';
import { clickFailureOf, finishedVariant } from '../clicks';

describe('clickFailureOf (CONTRACTS §21 order: 404 → 403 → 422, 429)', () => {
  const error = (status: number, code: string, extra: Record<string, unknown> = {}) =>
    new ApiError({ status, code: code as never, ...extra });
  it.each([
    [error(429, 'RATE_LIMITED', { retry_after: 42 }), { kind: 'rate_limited', seconds: 42 }],
    [error(429, 'RATE_LIMITED', { retry_after: 0.2 }), { kind: 'rate_limited', seconds: 1 }],
    [error(429, 'RATE_LIMITED'), { kind: 'rate_limited', seconds: 60 }],
    [error(404, 'NOT_FOUND'), { kind: 'gone' }],
    [error(403, 'PERMISSION_DENIED'), { kind: 'permission' }],
    [
      error(422, 'VALIDATION_FAILED', {
        errors: [{ path: 'field_id', code: 'BUTTON_DISABLED', params: { reason: 'condition' } }],
      }),
      { kind: 'disabled', reason: 'condition' },
    ],
    [
      error(422, 'VALIDATION_FAILED', {
        errors: [
          { path: 'field_id', code: 'BUTTON_DISABLED', params: { reason: 'automation_disabled' } },
        ],
      }),
      { kind: 'disabled', reason: 'automation_disabled' },
    ],
    [error(422, 'VALIDATION_FAILED'), { kind: 'error' }],
    [error(500, 'INTERNAL'), { kind: 'error' }],
    [new Error('boom'), { kind: 'error' }],
  ])('%#', (failure, expected) => {
    expect(clickFailureOf(failure)).toEqual(expected);
  });
});

describe('finishedVariant', () => {
  it.each([
    ['succeeded', 'success'],
    ['failed', 'error'],
    ['skipped', 'info'],
    ['cancelled', 'info'],
  ] as const)('%s → %s', (status, variant) => {
    expect(finishedVariant(status)).toBe(variant);
  });
});
