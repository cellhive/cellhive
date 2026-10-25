import { describe, expect, it } from 'vitest';

import {
  WidgetResultCache,
  widgetCacheKey,
  type WidgetCacheObserver,
  type WidgetCacheOutcome,
  type WidgetCacheStore,
} from '../../src/records/dashboard-aggregate/cache.js';

/** An in-memory Valkey: `SET … PX`, `SET … NX`; `fail` makes every command throw. */
class MemoryStore implements WidgetCacheStore {
  readonly values = new Map<string, { value: string; ttlMs: number }>();
  fail = false;
  sets = 0;

  private check(): void {
    if (this.fail) throw new Error('valkey down');
  }

  get(key: string): Promise<string | null> {
    this.check();
    return Promise.resolve(this.values.get(key)?.value ?? null);
  }

  set(key: string, value: string, ttlMs: number): Promise<void> {
    this.check();
    this.sets += 1;
    this.values.set(key, { value, ttlMs });
    return Promise.resolve();
  }

  lock(key: string, token: string, ttlMs: number): Promise<boolean> {
    this.check();
    if (this.values.has(key)) return Promise.resolve(false);
    this.values.set(key, { value: token, ttlMs });
    return Promise.resolve(true);
  }

  unlock(key: string, token: string): Promise<void> {
    this.check();
    if (this.values.get(key)?.value === token) this.values.delete(key);
    return Promise.resolve();
  }
}

class Counts implements WidgetCacheObserver {
  readonly outcomes: WidgetCacheOutcome[] = [];
  coalescedCount = 0;
  errors: string[] = [];
  outcome(result: WidgetCacheOutcome): void {
    this.outcomes.push(result);
  }
  coalesced(): void {
    this.coalescedCount += 1;
  }
  error(_error: unknown, operation: string): void {
    this.errors.push(operation);
  }
}

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('widgetCacheKey (T807)', () => {
  const parts = {
    widgetId: 'wgt_1',
    effectiveQuery: { b: 1, a: [1, 2] },
    permissionMaterial: '{"tables":[]}',
    dataVersions: [3n, 7n],
  };

  it('is dash:<widget>:<sha256>:<sha256>:<versions>, hashes only', () => {
    const key = widgetCacheKey(parts);
    expect(key).toMatch(/^dash:wgt_1:[0-9a-f]{64}:[0-9a-f]{64}:3\.7$/);
    expect(key).not.toContain('tables');
  });

  it('ignores key order of the query, but nothing else', () => {
    const base = widgetCacheKey(parts);
    expect(widgetCacheKey({ ...parts, effectiveQuery: { a: [1, 2], b: 1 } })).toBe(base);
    expect(widgetCacheKey({ ...parts, effectiveQuery: { a: [2, 1], b: 1 } })).not.toBe(base);
    expect(widgetCacheKey({ ...parts, permissionMaterial: '{"tables":[1]}' })).not.toBe(base);
    expect(widgetCacheKey({ ...parts, dataVersions: [4n, 7n] })).not.toBe(base);
    expect(widgetCacheKey({ ...parts, widgetId: 'wgt_2' })).not.toBe(base);
  });
});

describe('WidgetResultCache (T807)', () => {
  const setup = (options: ConstructorParameters<typeof WidgetResultCache>[2] = {}) => {
    const store = new MemoryStore();
    const counts = new Counts();
    const cache = new WidgetResultCache<{ n: number }>(store, counts, {
      waitMs: 300,
      pollMs: 5,
      random: () => 0.5,
      ...options,
    });
    return { store, counts, cache };
  };

  it('computes a cold key once, then answers from the cache', async () => {
    const { store, counts, cache } = setup();
    let runs = 0;
    const compute = () => Promise.resolve({ n: ++runs });
    const first = await cache.read('dash:k', compute);
    const second = await cache.read('dash:k', compute);
    expect(first).toMatchObject({ value: { n: 1 }, cache: 'miss' });
    expect(second).toEqual({ ...first, cache: 'hit' });
    expect(runs).toBe(1);
    expect(counts.outcomes).toEqual(['miss', 'hit']);
    // TTL 5 min ± 10 % (here exactly the middle) and the lock is released.
    expect(store.values.get('dash:k')?.ttlMs).toBe(300_000);
    expect(store.values.has('dashlock:dash:k')).toBe(false);
  });

  it('applies the TTL jitter', async () => {
    const low = setup({ random: () => 0 });
    await low.cache.read('k', () => Promise.resolve({ n: 1 }));
    expect(low.store.values.get('k')?.ttlMs).toBe(270_000);
    const high = setup({ random: () => 1 });
    await high.cache.read('k', () => Promise.resolve({ n: 1 }));
    expect(high.store.values.get('k')?.ttlMs).toBe(330_000);
  });

  it('never caches without a key (bypass)', async () => {
    const { store, counts, cache } = setup();
    let runs = 0;
    await cache.read(null, () => Promise.resolve({ n: ++runs }));
    await cache.read(null, () => Promise.resolve({ n: ++runs }));
    expect(runs).toBe(2);
    expect(store.sets).toBe(0);
    expect(counts.outcomes).toEqual(['bypass', 'bypass']);
  });

  it('shares one computation among concurrent requests of the process', async () => {
    const { counts, cache } = setup();
    const gate = deferred<undefined>();
    let runs = 0;
    const compute = async () => {
      runs += 1;
      await gate.promise;
      return { n: runs };
    };
    const reads = Array.from({ length: 20 }, () => cache.read('k', compute));
    gate.resolve(undefined);
    const results = await Promise.all(reads);
    expect(runs).toBe(1);
    expect(results.filter((result) => result.cache === 'miss')).toHaveLength(1);
    expect(counts.coalescedCount).toBe(19);
    expect(cache.inflight).toBe(0);
  });

  it('waits for the entry another instance computes (lock taken), then reads it', async () => {
    const { store, counts, cache } = setup();
    // Another instance holds the lock and stores the entry a bit later.
    store.values.set('dashlock:k', { value: 'other', ttlMs: 10_000 });
    setTimeout(() => {
      store.values.set('k', {
        value: JSON.stringify({ v: 1, computed_at: '2026-10-25T00:00:00.000Z', value: { n: 9 } }),
        ttlMs: 1,
      });
    }, 30);
    let runs = 0;
    const result = await cache.read('k', () => Promise.resolve({ n: ++runs }));
    expect(runs).toBe(0);
    expect(result).toEqual({
      value: { n: 9 },
      computedAt: '2026-10-25T00:00:00.000Z',
      cache: 'hit',
    });
    expect(counts.coalescedCount).toBe(1);
  });

  it('computes itself when the other request takes longer than the wait', async () => {
    const { store, counts, cache } = setup({ waitMs: 40 });
    store.values.set('dashlock:k', { value: 'other', ttlMs: 10_000 });
    const result = await cache.read('k', () => Promise.resolve({ n: 1 }));
    expect(result.cache).toBe('miss');
    expect(counts.outcomes).toEqual(['miss']);
    // Its lock is not ours: left alone.
    expect(store.values.get('dashlock:k')?.value).toBe('other');
  });

  it('answers without the cache when Valkey fails (no error)', async () => {
    const { store, counts, cache } = setup();
    store.fail = true;
    const result = await cache.read('k', () => Promise.resolve({ n: 1 }));
    expect(result).toMatchObject({ value: { n: 1 }, cache: 'miss' });
    expect(counts.outcomes).toEqual(['bypass']);
    expect(counts.errors).toEqual(['get']);
  });

  it('does not cache results larger than the limit, nor errors', async () => {
    const { store, cache } = setup({ maxBytes: 64 });
    await cache.read('big', () => Promise.resolve({ n: 1, pad: 'x'.repeat(100) } as never));
    expect(store.values.has('big')).toBe(false);
    await expect(cache.read('err', () => Promise.reject(new Error('timeout')))).rejects.toThrow(
      'timeout',
    );
    expect(store.values.has('err')).toBe(false);
    expect(store.values.has('dashlock:err')).toBe(false);
  });

  it('ignores entries it cannot read', async () => {
    const { store, cache } = setup();
    store.values.set('k', { value: 'not json', ttlMs: 1 });
    const result = await cache.read('k', () => Promise.resolve({ n: 2 }));
    expect(result).toMatchObject({ value: { n: 2 }, cache: 'miss' });
  });
});
