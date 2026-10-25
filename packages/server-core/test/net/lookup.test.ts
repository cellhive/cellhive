import { describe, expect, it } from 'vitest';

import {
  createSystemLookupLimiter,
  isLookupQueueTimeout,
  limitHostLookup,
  LOOKUP_QUEUE_TIMEOUT,
  LookupQueueTimeoutError,
  SYSTEM_LOOKUP_QUEUE_WAIT_MS,
  withTimeout,
  type HostLookup,
} from '../../src/net/lookup.js';
import { resolveOutboundTarget } from '../../src/net/resolve-target.js';

import type { Id } from '@cellhive/contracts';

/** A lookup whose calls stay pending until the test settles them. */
function controlledLookup() {
  const pending: { host: string; resolve: (addresses: string[]) => void }[] = [];
  const lookup: HostLookup = (host) =>
    new Promise((resolve) => {
      pending.push({ host, resolve });
    });
  return { lookup, pending };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('limitHostLookup (QA S5c: a hung resolver never takes every thread)', () => {
  it('runs at most `max` lookups, the next ones in arrival order', async () => {
    const { lookup, pending } = controlledLookup();
    const limited = limitHostLookup(lookup, 2);
    const a = limited('a.test');
    const b = limited('b.test');
    const c = limited('c.test');
    const d = limited('d.test');
    await tick();
    expect(pending.map((call) => call.host)).toEqual(['a.test', 'b.test']);
    pending[1]?.resolve(['192.0.2.2']);
    expect(await b).toEqual(['192.0.2.2']);
    await tick();
    expect(pending.map((call) => call.host)).toEqual(['a.test', 'b.test', 'c.test']);
    pending[0]?.resolve(['192.0.2.1']);
    pending[2]?.resolve(['192.0.2.3']);
    await tick();
    pending[3]?.resolve(['192.0.2.4']);
    expect(await Promise.all([a, c, d])).toEqual([['192.0.2.1'], ['192.0.2.3'], ['192.0.2.4']]);
  });

  it('a caller giving up does not free the slot: the hung lookup keeps it', async () => {
    const { lookup, pending } = controlledLookup();
    const limited = limitHostLookup(lookup, 1);
    await expect(withTimeout(limited('hung.test'), 10, () => new Error('timeout'))).rejects.toThrow(
      'timeout',
    );
    // The hung call still holds the only slot: the next one waits (and times out too).
    await expect(withTimeout(limited('next.test'), 10, () => new Error('timeout'))).rejects.toThrow(
      'timeout',
    );
    expect(pending.map((call) => call.host)).toEqual(['hung.test']);
    // Once the resolver answers, the waiting call runs.
    pending[0]?.resolve([]);
    await tick();
    expect(pending.map((call) => call.host)).toEqual(['hung.test', 'next.test']);
  });

  it('a call waiting longer than maxWaitMs leaves the queue (no backlog)', async () => {
    const { lookup, pending } = controlledLookup();
    const limited = limitHostLookup(lookup, 1, 10);
    const hung = limited('hung.test');
    await expect(limited('late.test')).rejects.toMatchObject({ code: LOOKUP_QUEUE_TIMEOUT });
    pending[0]?.resolve(['192.0.2.1']);
    expect(await hung).toEqual(['192.0.2.1']);
    // The abandoned call never runs; the next one gets the free slot at once.
    const next = limited('next.test');
    await tick();
    expect(pending.map((call) => call.host)).toEqual(['hung.test', 'next.test']);
    pending[1]?.resolve([]);
    await next;
  });

  it('a failing lookup frees its slot', async () => {
    let calls = 0;
    const limited = limitHostLookup(() => {
      calls += 1;
      return Promise.reject(new Error('ENOTFOUND'));
    }, 1);
    await expect(limited('a.test')).rejects.toThrow('ENOTFOUND');
    await expect(limited('b.test')).rejects.toThrow('ENOTFOUND');
    expect(calls).toBe(2);
  });

  it.each([0, -1, 1.5])('refuses max = %s', (max) => {
    expect(() => limitHostLookup(() => Promise.resolve([]), max)).toThrow(RangeError);
  });
});

describe('per-organization slots (review fix: cross-organization DNS starvation)', () => {
  const orgA = 'org_a' as Id<'org'>;
  const orgB = 'org_b' as Id<'org'>;

  it('an organization whose name server never answers never takes the slots of another', async () => {
    const { lookup, pending } = controlledLookup();
    const limited = createSystemLookupLimiter(lookup);
    const resolveFor = (organizationId: Id<'org'>, host: string) =>
      resolveOutboundTarget(`https://${host}/`, {
        organizationId,
        allowlist: [],
        privateAllowlist: 'org',
        lookup: limited,
        lookupTimeoutMs: 20,
      });
    // Organization A calls a black-holed host again and again (pacer: two in flight; each
    // attempt times out and the next one starts while the old threads still hang).
    await expect(resolveFor(orgA, 'hole-1.test')).rejects.toMatchObject({
      params: { reason: 'unresolvable', cause: 'timeout' },
    });
    const queued = [resolveFor(orgA, 'hole-2.test'), resolveFor(orgA, 'hole-3.test')];
    for (const call of queued) call.catch(() => undefined);
    await tick();
    // A holds one thread only, whatever it asks for.
    expect(pending.map((call) => call.host)).toEqual(['hole-1.test']);
    // Organization B resolves at once.
    const b = resolveFor(orgB, 'ok.test');
    await tick();
    expect(pending.map((call) => call.host)).toEqual(['hole-1.test', 'ok.test']);
    pending[1]?.resolve(['93.184.216.34']);
    expect(await b).toMatchObject({ address: '93.184.216.34' });
  });

  it('a call that waited too long for a slot rejects with LookupQueueTimeoutError, not an SSRF block', async () => {
    const { lookup, pending } = controlledLookup();
    const limited = limitHostLookup(lookup, 1, 10, 1);
    void limited('hung.test', { key: 'org_a' }).catch(() => undefined);
    const late = resolveOutboundTarget('https://late.test/', {
      organizationId: orgB,
      allowlist: [],
      privateAllowlist: 'org',
      lookup: limited,
      lookupTimeoutMs: 1_000,
    });
    const error: unknown = await late.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LookupQueueTimeoutError);
    expect(isLookupQueueTimeout(error)).toBe(true);
    expect(pending.map((call) => call.host)).toEqual(['hung.test']);
  });

  it('a waiter whose key is at its cap lets the next keys pass, and runs once its key frees', async () => {
    const { lookup, pending } = controlledLookup();
    const limited = limitHostLookup(lookup, 3, Number.POSITIVE_INFINITY, 1);
    const a1 = limited('a1.test', { key: 'a' });
    const a2 = limited('a2.test', { key: 'a' });
    const b1 = limited('b1.test', { key: 'b' });
    const free = limited('free.test');
    await tick();
    expect(pending.map((call) => call.host)).toEqual(['a1.test', 'b1.test', 'free.test']);
    pending[0]?.resolve(['192.0.2.1']);
    await a1;
    await tick();
    expect(pending.map((call) => call.host)).toEqual([
      'a1.test',
      'b1.test',
      'free.test',
      'a2.test',
    ]);
    for (const call of pending.slice(1)) call.resolve([]);
    await Promise.all([a2, b1, free]);
  });

  it('the system queue wait is shorter than the lookup timeout (5 s)', () => {
    expect(SYSTEM_LOOKUP_QUEUE_WAIT_MS).toBeLessThan(5_000);
  });

  it.each([0, 1.5])('refuses maxPerKey = %s', (maxPerKey) => {
    expect(() => limitHostLookup(() => Promise.resolve([]), 2, 10, maxPerKey)).toThrow(RangeError);
  });
});
