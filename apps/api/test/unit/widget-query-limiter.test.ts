import { AppError } from '@cellhive/server-core/errors';
import { describe, expect, it } from 'vitest';

import { WidgetQueryLimiter } from '../../src/modules/dashboard/widget-query-limiter.js';

/** A task that runs until `finish()` is called. */
function gate() {
  let finish: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return {
    done,
    finish: () => {
      finish();
    },
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('WidgetQueryLimiter (T806)', () => {
  it('runs at most 4 queries per user and 20 per instance, the rest in arrival order', async () => {
    const limiter = new WidgetQueryLimiter();
    const gates = Array.from({ length: 6 }, gate);
    const started: number[] = [];
    const runs = gates.map((item, index) =>
      limiter.run('usr_a', async () => {
        started.push(index);
        await item.done;
        return index;
      }),
    );
    await tick();
    expect(started).toEqual([0, 1, 2, 3]);
    expect(limiter.active).toBe(4);
    // Another user is not held back by user a.
    expect(await limiter.run('usr_b', () => Promise.resolve('b'))).toBe('b');
    gates[2]?.finish();
    await tick();
    expect(started).toEqual([0, 1, 2, 3, 4]);
    for (const item of gates) item.finish();
    expect(await Promise.all(runs)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(limiter.active).toBe(0);
  });

  it('caps the instance', async () => {
    const limiter = new WidgetQueryLimiter();
    limiter.total = 2;
    const hold = gate();
    const runs = ['u1', 'u2', 'u3'].map((key) => limiter.run(key, () => hold.done));
    await tick();
    expect(limiter.active).toBe(2);
    hold.finish();
    await Promise.all(runs);
    expect(limiter.active).toBe(0);
  });

  it('releases the slot when a query fails', async () => {
    const limiter = new WidgetQueryLimiter();
    limiter.perUser = 1;
    await expect(limiter.run('u', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await limiter.run('u', () => Promise.resolve(1))).toBe(1);
  });

  it('gives up after the wait limit with QUERY_TIMEOUT and Retry-After', async () => {
    const limiter = new WidgetQueryLimiter();
    limiter.perUser = 1;
    limiter.waitMs = 20;
    const hold = gate();
    const first = limiter.run('u', () => hold.done);
    const error: unknown = await limiter
      .run('u', () => Promise.resolve())
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'QUERY_TIMEOUT', retryAfterSeconds: 5 });
    hold.finish();
    await first;
    expect(limiter.active).toBe(0);
  });
});
