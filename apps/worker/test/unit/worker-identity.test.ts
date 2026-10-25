import { createHash } from 'node:crypto';
import process from 'node:process';

import { parseCronItems } from 'graphile-worker';
import { describe, expect, it } from 'vitest';

import { CRON_ITEMS, HTTP_DELIVERIES_RESCUE_CRON } from '../../src/job-runner.js';
import {
  createWorkerId,
  WORKER_ID_PREFIX,
  workerHost,
  workerIdPidOnHost,
  workerIdPrefix,
} from '../../src/worker-identity.js';
import { workerLivenessKey } from '../../src/worker-liveness.js';

describe('worker identity (T702, ADR-36 §5)', () => {
  it.each([
    ['a1b2c3d4e5f6', 'a1b2c3d4e5f6'],
    ['cellhive-worker-7d9f8-xk2p9', 'cellhive-worker-7d9f8-xk2p9'],
    ['Mac.local', 'Mac.local'],
    ['  host-a  ', 'host-a'],
    ['host_with space/and:colon', 'host-with-space-and-colon'],
    ['', 'unknown'],
    ['   ', 'unknown'],
    ['x'.repeat(80), 'x'.repeat(63)],
  ])('workerHost(%j) = %j', (input, expected) => {
    expect(workerHost(input)).toBe(expected);
  });

  it('defaults to the machine hostname', () => {
    expect(workerHost()).toMatch(/^[A-Za-z0-9.-]{1,63}$/u);
  });

  it('ids are ob-<host>-<pid>-<8 base62> and differ per runner', () => {
    const ids = new Set(Array.from({ length: 200 }, () => createWorkerId('host-a')));
    expect(ids.size).toBe(200);
    const pattern = new RegExp(`^ob-host-a-${String(process.pid)}-[0-9A-Za-z]{8}$`, 'u');
    for (const id of ids) expect(id).toMatch(pattern);
    expect(createWorkerId('h', { pid: 1, random: () => 61 })).toBe('ob-h-1-zzzzzzzz');
    expect(createWorkerId('h', { pid: 4242, random: () => 0 })).toBe('ob-h-4242-00000000');
  });

  it('prefix is ob-<host>-', () => {
    expect(WORKER_ID_PREFIX).toBe('ob-');
    expect(workerIdPrefix('host-a')).toBe('ob-host-a-');
  });

  it.each([
    ['ob-host-a-1-Ab3dE5g7', 'host-a', 1],
    ['ob-host-a-4242-00000000', 'host-a', 4242],
    // Another host whose name extends ours (or ours extends): never ours.
    ['ob-host-a-b-12-Ab3dE5g7', 'host-a', null],
    ['ob-host-a-1-12-Ab3dE5g7', 'host-a', null],
    ['ob-host-ab-12-Ab3dE5g7', 'host-a', null],
    ['ob-host-a-12-Ab3dE5g7', 'host-a-12', null],
    // Malformed: no pid, pid 0 or leading zero, wrong random part.
    ['ob-host-a-Ab3dE5g7', 'host-a', null],
    ['ob-host-a-0-Ab3dE5g7', 'host-a', null],
    ['ob-host-a-012-Ab3dE5g7', 'host-a', null],
    ['ob-host-a-12-Ab3dE5g', 'host-a', null],
    ['ob-host-a-12-Ab3dE5g78', 'host-a', null],
    ['ob-host-a-12-Ab3d-5g7', 'host-a', null],
    ['ob-host-b-12-Ab3dE5g7', 'host-a', null],
    // graphile-worker's own ids (before T702) are left to its 4-hour timeout.
    ['pool-0123456789abcdef01', 'host-a', null],
    ['ob-host-a-b-12-Ab3dE5g7', 'host-a-b', 12],
  ])('workerIdPidOnHost(%j, %j) = %j', (id, host, expected) => {
    expect(workerIdPidOnHost(id, host)).toBe(expected);
  });

  it('every created id is recognised as its host with its pid', () => {
    for (const host of ['host-a', 'a1b2c3d4e5f6', 'x.y-z', 'a-1']) {
      expect(workerIdPidOnHost(createWorkerId(host, { pid: 77 }), host)).toBe(77);
    }
  });

  it('liveness key: first 8 bytes of SHA-256 as a signed 64-bit integer, stable per id', () => {
    const id = 'ob-host-a-1-Ab3dE5g7';
    const expected = createHash('sha256').update(id).digest().readBigInt64BE(0);
    expect(workerLivenessKey(id)).toBe(expected.toString());
    expect(workerLivenessKey(id)).toBe(workerLivenessKey(id));
    const keys = new Set(
      Array.from({ length: 500 }, () => workerLivenessKey(createWorkerId('host-a'))),
    );
    expect(keys.size).toBe(500);
    for (const key of keys) {
      const value = BigInt(key);
      expect(value >= -(2n ** 63n) && value < 2n ** 63n).toBe(true);
    }
  });
});

describe('http.deliveries_rescue cron (T702)', () => {
  it('runs every minute, once, without backfill', () => {
    const item = parseCronItems([...CRON_ITEMS]).find(
      (cron) => cron.identifier === 'http.deliveries_rescue',
    );
    expect(HTTP_DELIVERIES_RESCUE_CRON).toBe('* * * * *');
    expect(item).toMatchObject({
      task: 'http.deliveries_rescue',
      options: { backfillPeriod: 0, maxAttempts: 1 },
    });
  });
});
