import { describe, expect, it } from 'vitest';

import { submissionPeriod } from '../../src/forms/submission-period.js';

import type { SubmissionLimit } from '@cellhive/contracts';

/**
 * Per-person submission limits count calendar periods in the base time zone
 * (BACKLOG S3 decision 9): the boundaries are local midnights, not UTC ones.
 */
describe('submissionPeriod', () => {
  const cases: readonly {
    readonly name: string;
    readonly limit: SubmissionLimit;
    readonly now: string;
    readonly zone: string;
    readonly start: string;
    readonly next: string | null;
  }[] = [
    {
      name: 'daily in Ho Chi Minh: 23:30 UTC is already the next local day',
      limit: 'daily',
      now: '2026-09-24T23:30:00.000Z',
      zone: 'Asia/Ho_Chi_Minh',
      start: '2026-09-24T17:00:00.000Z',
      next: '2026-09-25T17:00:00.000Z',
    },
    {
      name: 'daily in Ho Chi Minh: 16:59 UTC is still the local day before',
      limit: 'daily',
      now: '2026-09-24T16:59:59.999Z',
      zone: 'Asia/Ho_Chi_Minh',
      start: '2026-09-23T17:00:00.000Z',
      next: '2026-09-24T17:00:00.000Z',
    },
    {
      name: 'daily in UTC',
      limit: 'daily',
      now: '2026-09-24T23:30:00.000Z',
      zone: 'UTC',
      start: '2026-09-24T00:00:00.000Z',
      next: '2026-09-25T00:00:00.000Z',
    },
    {
      name: 'weekly: ISO week from Monday (Thursday 24 Sep 2026)',
      limit: 'weekly',
      now: '2026-09-24T10:00:00.000Z',
      zone: 'Asia/Ho_Chi_Minh',
      start: '2026-09-20T17:00:00.000Z',
      next: '2026-09-27T17:00:00.000Z',
    },
    {
      name: 'weekly: Sunday belongs to the week that started on Monday',
      limit: 'weekly',
      now: '2026-09-27T16:00:00.000Z',
      zone: 'Asia/Ho_Chi_Minh',
      start: '2026-09-20T17:00:00.000Z',
      next: '2026-09-27T17:00:00.000Z',
    },
    {
      name: 'weekly: Monday 00:30 local starts a new week',
      limit: 'weekly',
      now: '2026-09-27T17:30:00.000Z',
      zone: 'Asia/Ho_Chi_Minh',
      start: '2026-09-27T17:00:00.000Z',
      next: '2026-10-04T17:00:00.000Z',
    },
    {
      name: 'monthly across the year end',
      limit: 'monthly',
      now: '2026-12-31T18:00:00.000Z',
      zone: 'Asia/Ho_Chi_Minh',
      start: '2026-12-31T17:00:00.000Z',
      next: '2027-01-31T17:00:00.000Z',
    },
    {
      name: 'monthly in December',
      limit: 'monthly',
      now: '2026-12-15T00:00:00.000Z',
      zone: 'UTC',
      start: '2026-12-01T00:00:00.000Z',
      next: '2027-01-01T00:00:00.000Z',
    },
    {
      name: 'daily over a DST change (New York, 8 Mar 2026: the day has 23 hours)',
      limit: 'daily',
      now: '2026-03-08T15:00:00.000Z',
      zone: 'America/New_York',
      start: '2026-03-08T05:00:00.000Z',
      next: '2026-03-09T04:00:00.000Z',
    },
    {
      name: 'once covers all time',
      limit: 'once',
      now: '2026-09-24T10:00:00.000Z',
      zone: 'Asia/Ho_Chi_Minh',
      start: '1970-01-01T00:00:00.000Z',
      next: null,
    },
  ];

  it.each(cases)('$name', ({ limit, now, zone, start, next }) => {
    const period = submissionPeriod(limit, new Date(now), zone);
    expect(period?.start.toISOString()).toBe(start);
    expect(period?.next === null ? null : period?.next.toISOString()).toBe(next);
  });

  it('has no period without a limit', () => {
    expect(submissionPeriod('none', new Date(), 'UTC')).toBeNull();
  });
});
