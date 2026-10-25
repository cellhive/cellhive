import { describe, expect, it } from 'vitest';

import {
  COMPUTED_BATCH_LOCK_ATTEMPTS,
  COMPUTED_BATCH_LOCK_BACKOFF_MAX_MS,
  computedBatchErrorCodes,
  computedBatchErrorKind,
  computedLockRetryDelayMs,
  runComputedBatch,
  type ComputedBatchRetry,
} from '../../src/computed/recompute/batch-retry.js';
import { AppError } from '../../src/errors/app-error.js';

/** A `pg` error as the driver raises it. */
function pgError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

const statementTimeout = () => pgError('57014', 'canceling statement due to statement timeout');
const lockTimeout = () => pgError('55P03', 'canceling statement due to lock timeout');
const deadlock = () => pgError('40P01', 'deadlock detected');
const queryTimeout = () =>
  new AppError('QUERY_TIMEOUT', { detail: 'too long', cause: statementTimeout() });
const schemaLocked = (cause: unknown) => new AppError('SCHEMA_LOCKED', { detail: 'locked', cause });

/**
 * T474: how a failed batch of `computed.backfill` / `computed.recompute` is
 * handled — lock waits and deadlocks are retried with a backoff and never
 * change the field; only two statement timeouts in a row (the second with
 * half the rows) are a `TIMEOUT`.
 */
describe('computedBatchErrorKind (T474)', () => {
  const cases: [string, unknown, 'lock' | 'timeout' | 'other'][] = [
    ['statement timeout (57014)', statementTimeout(), 'timeout'],
    ['QUERY_TIMEOUT wrapping 57014', queryTimeout(), 'timeout'],
    ['an Error caused by 57014', new Error('x', { cause: statementTimeout() }), 'timeout'],
    [
      'cancel requested by the client (57014, other message)',
      pgError('57014', 'user request'),
      'other',
    ],
    ['lock timeout (55P03)', lockTimeout(), 'lock'],
    ['deadlock (40P01)', deadlock(), 'lock'],
    ['serialization failure (40001)', pgError('40001', 'could not serialize'), 'lock'],
    ['SCHEMA_LOCKED wrapping 55P03', schemaLocked(lockTimeout()), 'lock'],
    ['SCHEMA_LOCKED wrapping 40P01', schemaLocked(deadlock()), 'lock'],
    ['an Error caused by 55P03', new Error('x', { cause: lockTimeout() }), 'lock'],
    ['unique violation', pgError('23505', 'duplicate key value (x)=(secret)'), 'other'],
    ['another AppError', new AppError('INTERNAL', { detail: 'boom' }), 'other'],
    ['a plain Error', new Error('boom'), 'other'],
    ['not an error', 'boom', 'other'],
  ];
  it.each(cases)('%s → %s', (_label, error, kind) => {
    expect(computedBatchErrorKind(error)).toBe(kind);
  });
});

describe('computedBatchErrorCodes (T474): codes only, never the message', () => {
  const cases: [string, unknown, { error_code: string; sqlstate: string | null }][] = [
    ['pg error', lockTimeout(), { error_code: '55P03', sqlstate: '55P03' }],
    [
      'AppError with a pg cause',
      queryTimeout(),
      { error_code: 'QUERY_TIMEOUT', sqlstate: '57014' },
    ],
    [
      'AppError without cause',
      new AppError('INTERNAL', { detail: 'x' }),
      { error_code: 'INTERNAL', sqlstate: null },
    ],
    ['a plain Error', new Error('value 42'), { error_code: 'INTERNAL', sqlstate: null }],
  ];
  it.each(cases)('%s', (_label, error, codes) => {
    expect(computedBatchErrorCodes(error)).toEqual(codes);
  });
});

describe('computedLockRetryDelayMs (T474)', () => {
  const cases: [number, number, number][] = [
    // attempt, random, delay
    [1, 0, 250],
    [2, 0, 500],
    [3, 0, 1_000],
    [4, 0, 2_000],
    [5, 0, 4_000],
    [6, 0, 5_000],
    [20, 0, 5_000],
    [1, 0.5, 375],
    [6, 0.999_999_9, 5_249],
    [0, 0, 250],
  ];
  it.each(cases)('attempt %i, random %f → %i ms', (attempt, random, delay) => {
    expect(computedLockRetryDelayMs(attempt, () => random)).toBe(delay);
  });
  it('never exceeds the cap plus the jitter', () => {
    for (let attempt = 1; attempt <= 40; attempt += 1) {
      expect(computedLockRetryDelayMs(attempt)).toBeLessThan(
        COMPUTED_BATCH_LOCK_BACKOFF_MAX_MS + 250,
      );
    }
  });
});

describe('runComputedBatch (T474)', () => {
  interface Scenario {
    readonly label: string;
    /** What each attempt does: an error to throw, or `ok`. */
    readonly attempts: readonly (Error | 'ok')[];
    readonly size?: number;
    readonly expected:
      | { status: 'ok'; size: number }
      | { status: 'timeout' }
      | { status: 'locked' }
      | { status: 'throws' };
    /** Sizes each attempt ran with. */
    readonly sizes: readonly number[];
    readonly sleeps: readonly number[];
    readonly retries: readonly Pick<ComputedBatchRetry, 'kind' | 'attempt' | 'size'>[];
  }
  const locks = Array.from({ length: COMPUTED_BATCH_LOCK_ATTEMPTS }, lockTimeout);
  const scenarios: Scenario[] = [
    {
      label: 'first attempt ok',
      attempts: ['ok'],
      expected: { status: 'ok', size: 100 },
      sizes: [100],
      sleeps: [],
      retries: [],
    },
    {
      label: 'lock wait then ok: same size, backoff, no state change',
      attempts: [lockTimeout(), schemaLocked(deadlock()), 'ok'],
      expected: { status: 'ok', size: 100 },
      sizes: [100, 100, 100],
      sleeps: [250, 500],
      retries: [
        { kind: 'lock', attempt: 1, size: 100 },
        { kind: 'lock', attempt: 2, size: 100 },
      ],
    },
    {
      label: 'one statement timeout then ok with half the rows',
      attempts: [statementTimeout(), 'ok'],
      expected: { status: 'ok', size: 50 },
      sizes: [100, 50],
      sleeps: [],
      retries: [{ kind: 'timeout', attempt: 1, size: 50 }],
    },
    {
      label: 'two statement timeouts in a row → timeout',
      attempts: [statementTimeout(), queryTimeout(), 'ok'],
      expected: { status: 'timeout' },
      sizes: [100, 50],
      sleeps: [],
      retries: [{ kind: 'timeout', attempt: 1, size: 50 }],
    },
    {
      label: 'timeout, lock wait, timeout → timeout (locks do not reset the count)',
      attempts: [statementTimeout(), lockTimeout(), statementTimeout()],
      expected: { status: 'timeout' },
      sizes: [100, 50, 50],
      sleeps: [250],
      retries: [
        { kind: 'timeout', attempt: 1, size: 50 },
        { kind: 'lock', attempt: 1, size: 50 },
      ],
    },
    {
      label: 'a batch of one row still gets its second attempt',
      attempts: [statementTimeout(), statementTimeout()],
      size: 1,
      expected: { status: 'timeout' },
      sizes: [1, 1],
      sleeps: [],
      retries: [{ kind: 'timeout', attempt: 1, size: 1 }],
    },
    {
      label: 'locks on every attempt → locked (the job fails, graphile retries)',
      attempts: locks,
      expected: { status: 'locked' },
      sizes: locks.map(() => 100),
      sleeps: [250, 500, 1_000, 2_000, 4_000, 5_000, 5_000],
      retries: locks.slice(1).map((_, index) => ({ kind: 'lock', attempt: index + 1, size: 100 })),
    },
    {
      label: 'another error is thrown at once',
      attempts: [new Error('boom'), 'ok'],
      expected: { status: 'throws' },
      sizes: [100],
      sleeps: [],
      retries: [],
    },
  ];

  it.each(scenarios)('$label', async (scenario) => {
    const sizes: number[] = [];
    const sleeps: number[] = [];
    const retries: ComputedBatchRetry[] = [];
    let call = 0;
    const running = runComputedBatch({
      size: scenario.size ?? 100,
      run: (size) => {
        sizes.push(size);
        const step = scenario.attempts[call];
        call += 1;
        return step instanceof Error
          ? Promise.reject(step)
          : Promise.resolve(`rows:${String(size)}`);
      },
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      random: () => 0,
      onRetry: (retry) => retries.push(retry),
    });
    if (scenario.expected.status === 'throws') {
      await expect(running).rejects.toThrow('boom');
    } else {
      const outcome = await running;
      expect(outcome.status).toBe(scenario.expected.status);
      if (outcome.status === 'ok' && scenario.expected.status === 'ok') {
        expect(outcome).toEqual({
          status: 'ok',
          value: `rows:${String(scenario.expected.size)}`,
          size: scenario.expected.size,
        });
      }
    }
    expect(sizes).toEqual(scenario.sizes);
    expect(sleeps).toEqual(scenario.sleeps);
    expect(retries.map(({ kind, attempt, size }) => ({ kind, attempt, size }))).toEqual(
      scenario.retries,
    );
    // Logs get codes only.
    for (const retry of retries) {
      expect(Object.keys(retry).sort()).toEqual(
        ['attempt', 'delayMs', 'error_code', 'kind', 'size', 'sqlstate'].sort(),
      );
    }
  });
});
