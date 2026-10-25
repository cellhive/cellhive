import { loginRequestSchema, setupRequestSchema } from '@cellhive/contracts';
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../api/client';
import { applyServerErrors, decodeDetail, issueToDetail, zodResolver } from '../zod-form';

/** The resolver ignores react-hook-form's options. */
const options = {} as never;

function firstDetail(schema: { safeParse: (v: unknown, o: object) => unknown }, value: unknown) {
  const result = schema.safeParse(value, { reportInput: true }) as {
    success: boolean;
    error?: { issues: Parameters<typeof issueToDetail>[0][] };
  };
  const issue = result.error?.issues[0];
  return issue === undefined ? null : issueToDetail(issue);
}

describe('issueToDetail (same codes as the server)', () => {
  const password = setupRequestSchema.shape.password;
  const email = setupRequestSchema.shape.email;
  it.each([
    ['empty email', email, '', { code: 'REQUIRED' }],
    ['bad email', email, 'nope', { code: 'INVALID_FORMAT', params: { format: 'email' } }],
    ['empty password', password, '', { code: 'REQUIRED' }],
    [
      'short password',
      password,
      'short',
      { code: 'TOO_SMALL', params: { minimum: 10, origin: 'string' } },
    ],
    ['missing value', password, undefined, { code: 'REQUIRED' }],
    ['wrong type', password, 42, { code: 'EXPECTED_STRING' }],
  ])('%s', (_name, schema, value, expected) => {
    expect(firstDetail(schema, value)).toEqual(expected);
  });

  it('keeps detail codes of custom refinements', () => {
    expect(firstDetail(setupRequestSchema.shape.timezone, 'Mars/Olympus')).toEqual({
      code: 'INVALID_TIME_ZONE',
    });
  });
});

describe('zodResolver', () => {
  it('returns parsed values on success', async () => {
    const resolver = zodResolver(loginRequestSchema);
    const result = await resolver({ email: 'a@example.test', password: 'x' }, undefined, options);
    expect(result).toEqual({ values: { email: 'a@example.test', password: 'x' }, errors: {} });
  });

  it('returns one encoded detail per field', async () => {
    const resolver = zodResolver(loginRequestSchema);
    const result = await resolver({ email: 'bad', password: '' }, undefined, options);
    expect(decodeDetail(result.errors['email']?.message as string)).toEqual({
      code: 'INVALID_FORMAT',
      params: { format: 'email' },
    });
    expect(result.errors['password']?.type).toBe('REQUIRED');
  });
});

describe('applyServerErrors', () => {
  it('places VALIDATION_FAILED details on known fields only', () => {
    const setError = vi.fn();
    const error = new ApiError({
      status: 422,
      code: 'VALIDATION_FAILED',
      errors: [
        { path: 'password', code: 'PASSWORD_TOO_COMMON', message: 'x' },
        { path: 'password', code: 'TOO_SMALL', message: 'x' },
        { path: 'locale', code: 'INVALID_LOCALE', message: 'x' },
      ],
    });
    expect(applyServerErrors(error, ['password', 'email'], setError)).toEqual(['password']);
    expect(setError).toHaveBeenCalledTimes(1);
    expect(setError).toHaveBeenCalledWith('password', {
      type: 'server',
      message: JSON.stringify({ code: 'PASSWORD_TOO_COMMON' }),
    });
  });

  it('ignores other errors', () => {
    const setError = vi.fn();
    expect(
      applyServerErrors(new ApiError({ status: 409, code: 'NAME_CONFLICT' }), ['name'], setError),
    ).toEqual([]);
    expect(setError).not.toHaveBeenCalled();
  });
});
