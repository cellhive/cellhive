import { describe, expect, it } from 'vitest';

import { monthStart, monthsToEnsure, retentionCutoff } from '../../src/db/partitions.js';
import { validateEnqueueOptions, type EnqueueOptions } from '../../src/jobs/enqueue.js';
import {
  ORG_SLOT_DEFER_BASE_MS,
  ORG_SLOT_DEFER_JITTER_MS,
  orgSlotDeferralMs,
  orgSlotLockKey,
  remainingMaxAttempts,
  validateOrgSlotOptions,
} from '../../src/jobs/org-slot.js';
import { sanitizeQueueLogMeta } from '../../src/jobs/queue-logger.js';

const ORG = 'org_SlotOrg000000001';

describe('validateEnqueueOptions', () => {
  it.each<[string, EnqueueOptions]>([
    ['no options', {}],
    ['schema queue', { queueName: 'schema:tbl_Table00000000001' }],
    ['debounce key', { jobKey: 'recompute:fld_x', jobKeyMode: 'preserve_run_at' }],
    ['limits', { maxAttempts: 32_767, priority: -32_768 }],
  ])('accepts %s', (_name, options) => {
    expect(() => {
      validateEnqueueOptions('events.dispatch', options);
    }).not.toThrow();
  });

  it.each<[string, string, EnqueueOptions]>([
    ['task name without namespace', 'dispatch', {}],
    ['task name with spaces', 'events. dispatch', {}],
    ['queue per organization (ADR-18)', 'events.dispatch', { queueName: `org:${ORG}` as never }],
    ['zero attempts', 'events.dispatch', { maxAttempts: 0 }],
    ['fractional priority', 'events.dispatch', { priority: 1.5 }],
    ['smallint overflow', 'events.dispatch', { maxAttempts: 40_000 }],
    ['mode without key', 'events.dispatch', { jobKeyMode: 'replace' }],
    ['empty key', 'events.dispatch', { jobKey: '' }],
    ['invalid date', 'events.dispatch', { runAt: new Date('nope') }],
  ])('rejects %s', (_name, task, options) => {
    expect(() => {
      validateEnqueueOptions(task, options);
    }).toThrow();
  });
});

describe('acquireOrgSlot helpers', () => {
  it('lock key is kind:org (ADR-18)', () => {
    expect(orgSlotLockKey('automation-org', ORG)).toBe(`automation-org:${ORG}`);
  });

  it.each([
    [0, ORG_SLOT_DEFER_BASE_MS],
    [0.5, ORG_SLOT_DEFER_BASE_MS + ORG_SLOT_DEFER_JITTER_MS / 2],
    [1, ORG_SLOT_DEFER_BASE_MS + ORG_SLOT_DEFER_JITTER_MS - 1],
    [-3, ORG_SLOT_DEFER_BASE_MS],
  ])('deferral with random %d is %d ms', (random, expected) => {
    expect(orgSlotDeferralMs(() => random)).toBe(expected);
  });

  it.each([
    [{ attempts: 1, max_attempts: 25 }, 25],
    [{ attempts: 3, max_attempts: 25 }, 23],
    [{ attempts: 5, max_attempts: 5 }, 1],
    [{ attempts: 0, max_attempts: 5 }, 5],
  ])('remaining attempts of %j is %d', (job, expected) => {
    expect(remainingMaxAttempts(job)).toBe(expected);
  });

  it.each([
    ['bad org', { orgId: 'usr_User000000000001', kind: 'export', cap: 1 }],
    ['bad kind', { orgId: ORG, kind: 'Export Jobs', cap: 1 }],
    ['zero cap', { orgId: ORG, kind: 'export', cap: 0 }],
  ])('rejects %s', (_name, options) => {
    expect(() => {
      validateOrgSlotOptions(options as never);
    }).toThrow();
  });
});

describe('partition helpers', () => {
  const now = new Date('2026-12-31T23:30:00.000Z');

  it('month starts are UTC', () => {
    expect(monthStart(now)).toBe('2026-12-01');
    expect(monthStart(now, 2)).toBe('2027-02-01');
    expect(monthStart(now, -12)).toBe('2025-12-01');
  });

  it('ensures the current month and the following ones', () => {
    expect(monthsToEnsure(now, 2)).toEqual(['2026-12-01', '2027-01-01', '2027-02-01']);
    expect(() => monthsToEnsure(now, -1)).toThrow(RangeError);
  });

  it('retention cutoff is now minus the days', () => {
    expect(retentionCutoff(now, 365).toISOString()).toBe('2025-12-31T23:30:00.000Z');
    expect(() => retentionCutoff(now, 0)).toThrow(RangeError);
  });
});

describe('sanitizeQueueLogMeta', () => {
  it('keeps identifiers and drops the job payload', () => {
    const error = new Error('boom');
    const fields = sanitizeQueueLogMeta(
      { label: 'worker', workerId: 'worker-1', taskIdentifier: 'events.dispatch' },
      {
        job: {
          id: '42',
          task_identifier: 'events.dispatch',
          attempts: 2,
          max_attempts: 25,
          payload: { secret_value: 'Nguyễn Văn Ánh' },
        },
        error,
        duration: 12,
      },
    );
    expect(fields).toEqual({
      queue_component: 'worker',
      worker_id: 'worker-1',
      task: 'events.dispatch',
      job_id: '42',
      attempts: 2,
      max_attempts: 25,
      err: error,
      duration_ms: 12,
    });
    expect(JSON.stringify(fields)).not.toContain('Nguyễn');
  });
});
