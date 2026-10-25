import { randomBytes } from 'node:crypto';

import { newId, type Id } from '@cellhive/contracts';
import {
  createValkeyHostPacer,
  HOST_PACER_MAX_PAUSE_MS,
  valkeyQuotaClient,
  type HostPacer,
  type HostPacerTarget,
} from '@cellhive/server-core';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

/**
 * BACKLOG T600 (ADR-35 §4 "nhịp theo đích", S5b-review §11 #2): the
 * per-destination pacer of outbound HTTP against a real Valkey — token
 * bucket (organization, host) 10/s burst 20, at most 2 calls in flight per
 * organization, pause from `Retry-After` — answering "wait until …"
 * instead of sleeping.
 */
describe('HostPacer (T600)', () => {
  let client: Redis;
  let pacer: HostPacer;

  const target = (host = 'hooks.example.com', organizationId?: Id<'org'>): HostPacerTarget => ({
    organizationId: organizationId ?? newId('org'),
    host,
  });

  beforeAll(async () => {
    client = new Redis(inject('cacheUrl'), { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
    await new Promise<void>((resolve) => {
      client.once('ready', () => {
        resolve();
      });
    });
    pacer = createValkeyHostPacer(valkeyQuotaClient(client), {
      keyPrefix: `test:${randomBytes(4).toString('hex')}:`,
    });
  });

  afterAll(() => {
    client.disconnect();
  });

  it('40 calls to one host within a second: at most 20 + 10/s go, the rest wait', async () => {
    const t = target();
    const started = performance.now();
    let allowed = 0;
    const waits: number[] = [];
    for (let index = 0; index < 40; index += 1) {
      const decision = await pacer.acquire(t);
      if (decision.ok) {
        allowed += 1;
        await decision.lease.release();
      } else {
        expect(decision.reason).toBe('rate');
        waits.push(decision.waitUntil.getTime() - Date.now());
      }
    }
    const elapsedSeconds = (performance.now() - started) / 1000;
    expect(elapsedSeconds).toBeLessThan(1);
    expect(allowed).toBeGreaterThanOrEqual(20);
    expect(allowed).toBeLessThanOrEqual(20 + Math.ceil(10 * elapsedSeconds));
    expect(waits.length).toBe(40 - allowed);
    // "Wait until …" is about one token away (100 ms at 10/s), never a long sleep.
    for (const wait of waits) expect(wait).toBeLessThanOrEqual(250);
  });

  it('keeps buckets apart per organization and per host', async () => {
    const organizationId = newId('org');
    const drain = async (t: HostPacerTarget) => {
      let allowed = 0;
      for (let index = 0; index < 25; index += 1) {
        const decision = await pacer.acquire(t);
        if (decision.ok) {
          allowed += 1;
          await decision.lease.release();
        }
      }
      return allowed;
    };
    const first = await drain(target('a.example.com', organizationId));
    const otherHost = await drain(target('b.example.com', organizationId));
    const otherOrg = await drain(target('a.example.com'));
    for (const allowed of [first, otherHost, otherOrg]) {
      expect(allowed).toBeGreaterThanOrEqual(20);
      expect(allowed).toBeLessThan(25);
    }
  });

  it('allows at most 2 calls in flight per organization, any host', async () => {
    const organizationId = newId('org');
    const one = await pacer.acquire(target('a.example.com', organizationId));
    const two = await pacer.acquire(target('b.example.com', organizationId));
    const three = await pacer.acquire(target('c.example.com', organizationId));
    expect([one.ok, two.ok, three.ok]).toEqual([true, true, false]);
    if (three.ok) throw new Error('unreachable');
    expect(three.reason).toBe('in_flight');
    expect(three.waitUntil.getTime() - Date.now()).toBeLessThanOrEqual(1_100);
    // Another organization is not held back.
    expect((await pacer.acquire(target('c.example.com'))).ok).toBe(true);
    if (one.ok) {
      await one.lease.release();
      await one.lease.release();
    }
    const four = await pacer.acquire(target('c.example.com', organizationId));
    expect(four.ok).toBe(true);
    if (two.ok) await two.lease.release();
    if (four.ok) await four.lease.release();
  });

  it('pauses one (organization, host) until Retry-After, never shortening a pause', async () => {
    const t = target('slow.example.com');
    const until = new Date(Date.now() + 2_000);
    await pacer.pause(t, until);
    // A shorter pause does not replace the longer one.
    await pacer.pause(t, new Date(Date.now() + 500));
    const decision = await pacer.acquire(t);
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.reason).toBe('paused');
    expect(Math.abs(decision.waitUntil.getTime() - until.getTime())).toBeLessThanOrEqual(5);
    // Same host of another organization, other host of the same organization: not paused.
    expect((await pacer.acquire(target('slow.example.com'))).ok).toBe(true);
    const sibling = await pacer.acquire(target('fast.example.com', t.organizationId));
    expect(sibling.ok).toBe(true);
    if (sibling.ok) await sibling.lease.release();
  });

  it('clamps a pause to one hour', async () => {
    const t = target('far.example.com');
    await pacer.pause(t, new Date(Date.now() + 5 * HOST_PACER_MAX_PAUSE_MS));
    const decision = await pacer.acquire(t);
    if (decision.ok) throw new Error('expected a pause');
    expect(decision.waitUntil.getTime() - Date.now()).toBeLessThanOrEqual(HOST_PACER_MAX_PAUSE_MS);
    expect(decision.waitUntil.getTime() - Date.now()).toBeGreaterThan(
      HOST_PACER_MAX_PAUSE_MS - 5_000,
    );
  });

  it('answers "wait" (unavailable) when Valkey cannot be reached', async () => {
    const down = new Redis('redis://127.0.0.1:1', {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      lazyConnect: true,
      retryStrategy: () => null,
    });
    down.on('error', () => undefined);
    try {
      const unreachable = createValkeyHostPacer(valkeyQuotaClient(down, 200));
      const decision = await unreachable.acquire(target());
      expect(decision.ok).toBe(false);
      if (decision.ok) throw new Error('unreachable');
      expect(decision.reason).toBe('unavailable');
      expect(decision.waitUntil.getTime()).toBeGreaterThan(Date.now());
      await expect(
        unreachable.pause(target(), new Date(Date.now() + 1_000)),
      ).resolves.toBeUndefined();
    } finally {
      down.disconnect();
    }
  });
});
