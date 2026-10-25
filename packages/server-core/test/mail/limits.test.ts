import { describe, expect, it } from 'vitest';

import {
  createValkeyEmailQuota,
  EmailSendError,
  MemorySendPacer,
  SendRateLimiter,
  valkeyReady,
  type Clock,
  type QuotaClient,
  type SendSlot,
  type ValkeyConnection,
} from '../../src/mail/index.js';

/**
 * A clock whose time only moves when every pending task waits on it:
 * `sleep` registers a timer, `run` fires timers in time order after letting
 * the promise jobs settle. Lets tests run many concurrent senders through
 * the pacer in virtual time.
 */
function virtualClock(): Clock & { run(work: Promise<unknown>): Promise<void>; time(): number } {
  let now = 0;
  let sequence = 0;
  const timers: { at: number; seq: number; resolve: () => void }[] = [];
  const settle = () =>
    new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  return {
    now: () => now,
    time: () => now,
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        timers.push({ at: now + Math.max(0, ms), seq: sequence++, resolve });
      }),
    async run(work) {
      const state = { finished: false };
      void work.finally(() => {
        state.finished = true;
      });
      for (;;) {
        await settle();
        if (state.finished) return;
        timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
        const next = timers.shift();
        if (next === undefined) throw new Error('deadlock: nothing waits on the clock');
        now = Math.max(now, next.at);
        next.resolve();
      }
    },
  };
}

/** Most instants of `times` within any half-open window of `windowMs`. */
function maxWithin(times: readonly number[], windowMs = 1000): number {
  const sorted = [...times].sort((a, b) => a - b);
  let best = 0;
  let start = 0;
  for (let end = 0; end < sorted.length; end += 1) {
    while ((sorted[end] ?? 0) - (sorted[start] ?? 0) >= windowMs) start += 1;
    best = Math.max(best, end - start + 1);
  }
  return best;
}

interface SendTrace {
  readonly starts: number[];
  /** When the server would have the message: the end of the SMTP transaction. */
  readonly arrivals: number[];
}

/** `durations.length` concurrent sends through one limiter, each holding its slot for its duration. */
async function sendAll(
  limit: number,
  durations: readonly number[],
): Promise<SendTrace & { total: number }> {
  const clock = virtualClock();
  const limiter = new SendRateLimiter(limit, clock);
  const trace: SendTrace = { starts: [], arrivals: [] };
  const work = Promise.all(
    durations.map(async (duration) => {
      const slot = await limiter.acquire();
      trace.starts.push(clock.now());
      await clock.sleep(duration);
      trace.arrivals.push(clock.now());
      await slot.release();
    }),
  );
  await clock.run(work);
  await work;
  return { ...trace, total: clock.time() };
}

describe('SendRateLimiter (sliding window over whole sends, S5-review §4 #15)', () => {
  it.each([
    ['instant sends', 5, Array.from({ length: 50 }, () => 0)],
    ['5 ms round trips (local SMTP)', 5, Array.from({ length: 50 }, () => 5)],
    // The T528 bench case: one slow slot then fast ones — a fixed count of
    // starts let 2 × N messages reach the server within one second.
    [
      'slow then fast round trips',
      5,
      Array.from({ length: 30 }, (_, index) => (Math.floor(index / 5) % 2 === 0 ? 990 : 5)),
    ],
    ['mixed durations', 3, [700, 10, 400, 950, 20, 1, 600, 300, 999, 0, 50, 800, 5, 5, 5]],
    ['one per second', 1, [100, 900, 0, 450, 30]],
    ['long sends (> 1 s)', 2, [2500, 10, 1800, 10, 10, 3000, 10]],
  ] as const)('%s: no sliding second sees more than N starts or arrivals', async (_, limit, d) => {
    const trace = await sendAll(limit, d);
    expect(trace.starts).toHaveLength(d.length);
    expect(maxWithin(trace.starts)).toBeLessThanOrEqual(limit);
    expect(maxWithin(trace.arrivals)).toBeLessThanOrEqual(limit);
  });

  it('allows a burst of N at once (no 2 × N), then one window per round', async () => {
    const trace = await sendAll(
      5,
      Array.from({ length: 50 }, () => 0),
    );
    expect(trace.starts.slice(0, 5)).toEqual([0, 0, 0, 0, 0]);
    expect(trace.starts[5]).toBe(1000);
    // 50 instant messages at 5 per second: rounds at 0 … 9 s.
    expect(trace.total).toBe(9000);
    expect(maxWithin(trace.arrivals)).toBe(5);
  });

  it('counts a send until one window after it ends', async () => {
    const trace = await sendAll(
      5,
      Array.from({ length: 50 }, () => 5),
    );
    // Each round: 5 ms of sending + 1 s → 10 rounds ≈ 9.05 s.
    expect(trace.total).toBe(9 * 1005 + 5);
    expect(trace.starts.slice(5, 10)).toEqual([1005, 1005, 1005, 1005, 1005]);
  });

  it('starts in order of acquire (FIFO)', async () => {
    const clock = virtualClock();
    const limiter = new SendRateLimiter(1, clock);
    const order: number[] = [];
    const work = Promise.all(
      [0, 1, 2, 3].map(async (index) => {
        const slot = await limiter.acquire();
        order.push(index);
        await slot.release();
      }),
    );
    await clock.run(work);
    expect(order).toEqual([0, 1, 2, 3]);
  });

  it('a slot that is never released stops counting after its lease', async () => {
    const clock = virtualClock();
    const pacer = new MemorySendPacer({ limit: 1, windowMs: 1000, leaseMs: 5000, clock });
    let second = -1;
    const work = (async () => {
      await pacer.acquire('smtp'); // lost: never released
      await (await pacer.acquire('smtp')).release();
      second = clock.now();
    })();
    await clock.run(work);
    expect(second).toBe(6000);
  });

  it('release is idempotent and never extends the hold', async () => {
    const clock = virtualClock();
    const pacer = new MemorySendPacer({ limit: 1, windowMs: 1000, clock });
    const times: number[] = [];
    const work = (async () => {
      const slot: SendSlot = await pacer.acquire('k');
      await slot.release();
      await clock.sleep(400);
      await slot.release(); // again, later: still counted from the first release
      await (await pacer.acquire('k')).release();
      times.push(clock.now());
    })();
    await clock.run(work);
    expect(times).toEqual([1000]);
  });

  it('keys have their own window (bucket per bot)', async () => {
    const clock = virtualClock();
    const pacer = new MemorySendPacer({ limit: 2, windowMs: 1000, clock });
    const seen: Record<string, number[]> = { a: [], b: [] };
    const work = Promise.all(
      ['a', 'a', 'a', 'b', 'b'].map(async (key) => {
        const slot = await pacer.acquire(key);
        seen[key]?.push(clock.now());
        await slot.release();
      }),
    );
    await clock.run(work);
    expect(seen).toEqual({ a: [0, 0, 1000], b: [0, 0] });
  });

  it('wakes a waiter as soon as an in-flight slot is released', async () => {
    const clock = virtualClock();
    const pacer = new MemorySendPacer({ limit: 1, windowMs: 1000, leaseMs: 60_000, clock });
    let started = -1;
    const work = (async () => {
      const first = await pacer.acquire('k');
      const waiting = pacer.acquire('k').then(async (slot) => {
        started = clock.now();
        await slot.release();
      });
      await clock.sleep(300);
      await first.release();
      await waiting;
    })();
    await clock.run(work);
    // Released at 300 ms → counted until 1 300 ms, not until the 60 s lease.
    expect(started).toBe(1300);
  });

  it('rejects limits outside 1 … 1 000 000', () => {
    expect(() => new MemorySendPacer({ limit: 0 })).toThrow(RangeError);
    expect(() => new MemorySendPacer({ limit: 1.5 })).toThrow(RangeError);
    expect(() => new MemorySendPacer({ limit: 1, windowMs: 0 })).toThrow(RangeError);
  });
});

/** A Valkey client state machine: `status` and the `ready` / `end` events of ioredis. */
function fakeConnection(status: string): ValkeyConnection & { emit(event: 'ready' | 'end'): void } {
  const listeners = new Map<string, Set<() => void>>();
  const connection = {
    status,
    once(event: 'ready' | 'end', listener: () => void) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return connection;
    },
    removeListener(event: 'ready' | 'end', listener: () => void) {
      listeners.get(event)?.delete(listener);
      return connection;
    },
    emit(event: 'ready' | 'end') {
      if (event === 'ready') connection.status = 'ready';
      if (event === 'end') connection.status = 'end';
      const set = listeners.get(event);
      listeners.delete(event);
      for (const listener of set ?? []) listener();
    },
    listenerCount: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
  };
  return connection;
}

describe('valkeyReady (S5-review §4 #14)', () => {
  it('resolves at once when ready', async () => {
    await expect(valkeyReady(fakeConnection('ready'))).resolves.toBeUndefined();
  });

  it.each(['connecting', 'connect', 'reconnecting', 'close', 'wait'])(
    'waits while %s, then resolves on ready',
    async (status) => {
      const connection = fakeConnection(status);
      const ready = valkeyReady(connection, 1000);
      setTimeout(() => {
        connection.emit('ready');
      }, 10);
      await expect(ready).resolves.toBeUndefined();
    },
  );

  it('gives up after the timeout and leaves no listener behind', async () => {
    const connection = fakeConnection('connecting');
    await expect(valkeyReady(connection, 20)).rejects.toThrow(/not ready/);
    expect((connection as unknown as { listenerCount(): number }).listenerCount()).toBe(0);
  });

  it('fails at once when the connection was ended (quit)', async () => {
    await expect(valkeyReady(fakeConnection('end'), 10_000)).rejects.toThrow(/closed/);
  });

  it('fails when the connection ends while waiting', async () => {
    const connection = fakeConnection('connecting');
    const ready = valkeyReady(connection, 10_000);
    connection.emit('end');
    await expect(ready).rejects.toThrow(/closed/);
  });
});

describe('createValkeyEmailQuota before Valkey is ready (S5-review §4 #14)', () => {
  function client(overrides: Partial<QuotaClient> = {}): QuotaClient & { evals: number } {
    const state = { evals: 0 };
    return {
      get evals() {
        return state.evals;
      },
      eval: () => {
        state.evals += 1;
        return Promise.resolve([1, 1]);
      },
      get: () => Promise.resolve('1'),
      ...overrides,
    };
  }

  it('waits for the connection before the first command', async () => {
    let ready!: () => void;
    const gate = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const valkey = client({ ready: () => gate });
    const quota = createValkeyEmailQuota(valkey, { limit: 5, scope: 'org' });
    const taken = quota.take('org_a');
    await new Promise((resolve) => setImmediate(resolve));
    expect(valkey.evals).toBe(0);
    ready();
    await expect(taken).resolves.toEqual({ allowed: true, used: 1 });
  });

  const streamNotWriteable = () =>
    Promise.reject(new Error("Stream isn't writeable and enableOfflineQueue options is false"));

  it.each([
    ['the connection never becomes ready', { ready: () => Promise.reject(new Error('timeout')) }],
    ['a command fails (offline, no queue)', { eval: streamNotWriteable, get: streamNotWriteable }],
  ] as const)('%s → a temporary, classified email error', async (_, overrides) => {
    const quota = createValkeyEmailQuota(client(overrides), { limit: 5, scope: 'org' });
    for (const call of [
      () => quota.take('org_a'),
      () => quota.release('org_a', new Date()),
      () => quota.used('org_a'),
    ]) {
      const error: unknown = await call().then(
        () => null,
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(EmailSendError);
      expect(error).toMatchObject({ code: 'smtp_temporary', retryable: true, reason: 'temporary' });
      // Safe to log: no Valkey text.
      expect((error as EmailSendError).message).not.toMatch(/Stream|timeout/);
    }
  });
});
