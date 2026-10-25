import { ERROR_CODES, newId, problemDetailsSchema } from '@cellhive/contracts';
import { describe, expect, it } from 'vitest';

import { AppError, buildProblem, isAppError } from '../../src/errors/index.js';

describe('AppError', () => {
  it.each(ERROR_CODES)('%s produces a problem document valid against the contract', (code) => {
    const error = new AppError(code, { detail: 'Something happened.' });
    const problem = error.toProblem(newId('req'));
    expect(problemDetailsSchema.safeParse(problem).success).toBe(true);
    expect(problem.status).toBe(error.status);
  });

  it('keeps detail and errors, never params', () => {
    const error = new AppError('VALIDATION_FAILED', {
      detail: 'Bad input.',
      errors: [{ path: 'name', code: 'REQUIRED', message: 'Required' }],
      params: { internal: 'value' },
    });
    expect(error.status).toBe(422);
    expect(isAppError(error)).toBe(true);
    const problem = error.toProblem('req_A1b2C3d4E5f6G7h8');
    expect(problem).toEqual({
      type: 'https://cellhive.io/errors/VALIDATION_FAILED',
      title: 'Validation failed',
      status: 422,
      code: 'VALIDATION_FAILED',
      detail: 'Bad input.',
      errors: [{ path: 'name', code: 'REQUIRED', message: 'Required' }],
      request_id: 'req_A1b2C3d4E5f6G7h8',
    });
    expect(JSON.stringify(problem)).not.toContain('internal');
  });

  it('uses the title as message when there is no detail and keeps the cause', () => {
    const cause = new Error('socket hang up');
    const error = new AppError('DEPENDENCY_UNAVAILABLE', { cause });
    expect(error.message).toBe('Dependency unavailable');
    expect(error.cause).toBe(cause);
    expect(error.toProblem('req_A1b2C3d4E5f6G7h8')).not.toHaveProperty('detail');
  });

  it('rounds retryAfterSeconds up to whole seconds, at least 1, outside the body', () => {
    expect(new AppError('RATE_LIMITED', { retryAfterSeconds: 12.2 }).retryAfterSeconds).toBe(13);
    expect(new AppError('ACCOUNT_LOCKED', { retryAfterSeconds: 0 }).retryAfterSeconds).toBe(1);
    expect(new AppError('RATE_LIMITED').retryAfterSeconds).toBeUndefined();
    const problem = new AppError('RATE_LIMITED', { retryAfterSeconds: 5 }).toProblem(
      'req_A1b2C3d4E5f6G7h8',
    );
    expect(JSON.stringify(problem)).not.toContain('retry');
  });

  it('omits an empty errors array', () => {
    expect(buildProblem('NOT_FOUND', 'req_A1b2C3d4E5f6G7h8', { errors: [] })).not.toHaveProperty(
      'errors',
    );
  });
});
