import { randomBytes } from 'node:crypto';

import { newId } from '@cellhive/contracts';
import { createValkeyCallSlots, valkeyQuotaClient, type CallSlots } from '@cellhive/server-core';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

/**
 * BACKLOG T1004: the concurrency slots of AI requests against a real
 * Valkey — several counters taken in one script or none of them, a slot
 * released at once or freed by its lease, Valkey unreachable answered
 * `unavailable` (the API then fails closed with `503`).
 */
describe('Valkey call slots (T1004)', () => {
  let client: Redis;
  let slots: CallSlots;
  let prefix: string;

  beforeAll(async () => {
    client = new Redis(inject('cacheUrl'), { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
    await new Promise<void>((resolve) => {
      client.once('ready', () => {
        resolve();
      });
    });
    prefix = `test:${randomBytes(4).toString('hex')}:`;
    slots = createValkeyCallSlots(valkeyQuotaClient(client), {
      keyPrefix: prefix,
      leaseMs: 60_000,
    });
  });

  afterAll(() => {
    client.disconnect();
  });

  it('takes a slot in every counter or in none: a full counter names itself', async () => {
    const user = `user:${newId('usr')}`;
    const org = `org:${newId('org')}`;
    const pair = [
      { key: user, limit: 2 },
      { key: org, limit: 3 },
    ];
    const first = await slots.acquire(pair);
    const second = await slots.acquire(pair);
    expect([first.ok, second.ok]).toEqual([true, true]);
    expect(await slots.acquire(pair)).toEqual({ ok: false, reason: 'full', index: 0 });
    // The refused acquire took nothing: the organization still has one slot.
    const other = await slots.acquire([
      { key: `user:${newId('usr')}`, limit: 2 },
      { key: org, limit: 3 },
    ]);
    expect(other.ok).toBe(true);
    expect(
      await slots.acquire([
        { key: `user:${newId('usr')}`, limit: 2 },
        { key: org, limit: 3 },
      ]),
    ).toEqual({ ok: false, reason: 'full', index: 1 });
    expect(await client.zcard(`${prefix}${org}`)).toBe(3);

    if (first.ok) await first.lease.release();
    if (first.ok) await first.lease.release(); // idempotent
    expect(await client.zcard(`${prefix}${user}`)).toBe(1);
    expect(await client.zcard(`${prefix}${org}`)).toBe(2);
    expect((await slots.acquire(pair)).ok).toBe(true);
  });

  it('a slot never released frees itself after its lease', async () => {
    const short = createValkeyCallSlots(valkeyQuotaClient(client), {
      keyPrefix: prefix,
      leaseMs: 200,
    });
    const key = [{ key: `user:${newId('usr')}`, limit: 1 }];
    expect((await short.acquire(key)).ok).toBe(true);
    expect(await short.acquire(key)).toMatchObject({ ok: false, reason: 'full' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await short.acquire(key)).ok).toBe(true);
    expect(await client.pttl(`${prefix}${key[0]?.key ?? ''}`)).toBeLessThanOrEqual(1_200);
  });

  it('answers unavailable when Valkey cannot be reached', async () => {
    const down = new Redis('redis://127.0.0.1:1', {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      lazyConnect: true,
      retryStrategy: () => null,
    });
    down.on('error', () => undefined);
    try {
      const unreachable = createValkeyCallSlots(valkeyQuotaClient(down, 200), { leaseMs: 1_000 });
      expect(await unreachable.acquire([{ key: 'user:x', limit: 2 }])).toEqual({
        ok: false,
        reason: 'unavailable',
      });
    } finally {
      down.disconnect();
    }
  });
});
