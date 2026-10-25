import { describe, expect, it } from 'vitest';

import {
  dueAt,
  fireTimesBetween,
  firstTimeZone,
  latestFireTime,
  minIntervalMinutes,
  nextFireTime,
  parseCron,
  valueRangeOf,
  type CronSchedule,
  type DueRule,
} from '../../src/automation/index.js';
import { dueValueKindOf, dueValueText } from '../../src/records/index.js';

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

function schedule(expression: string): CronSchedule {
  const parsed = parseCron(expression);
  if (!parsed.ok) throw new Error(`${expression}: ${parsed.message}`);
  return parsed.schedule;
}

describe('parseCron (SPEC §11.2, BACKLOG T508)', () => {
  it.each([
    ['0 8 * * *', [0], [8]],
    ['*/15 9-17 * * MON-FRI', [0, 15, 30, 45], [9, 10, 11, 12, 13, 14, 15, 16, 17]],
    ['5,35 */6 * * *', [5, 35], [0, 6, 12, 18]],
    ['10-20/5 0 1 1 *', [10, 15, 20], [0]],
    ['30/10 1 * * *', [30, 40, 50], [1]],
  ])('%s', (expression, minutes, hours) => {
    const parsed = schedule(expression);
    expect(parsed.minutes).toEqual(minutes);
    expect(parsed.hours).toEqual(hours);
  });

  it('reads month and day names, Sunday as 0 or 7', () => {
    const parsed = schedule('0 0 * jan,Dec sun');
    expect([...parsed.months]).toEqual([1, 12]);
    expect([...parsed.daysOfWeek]).toEqual([0]);
    expect([...schedule('0 0 * * 7').daysOfWeek]).toEqual([0]);
    expect([...schedule('0 0 * * 5-7').daysOfWeek].sort()).toEqual([0, 5, 6]);
  });

  it.each([
    ['', 'fields'],
    ['0 8 * *', 'fields'],
    ['0 8 * * * *', 'fields'],
    ['60 8 * * *', 'minute'],
    ['0 24 * * *', 'hour'],
    ['0 8 0 * *', 'day_of_month'],
    ['0 8 * 13 *', 'month'],
    ['0 8 * * 8', 'day_of_week'],
    ['0 8 * * FOO', 'day_of_week'],
    ['*/0 * * * *', 'minute'],
    ['5-1 * * * *', 'minute'],
    ['1,,2 * * * *', 'minute'],
    ['@daily * * * *', 'minute'],
    ['L * * * *', 'minute'],
    ['0 8 ? * *', 'day_of_month'],
  ])('rejects %j (%s)', (expression, field) => {
    const parsed = parseCron(expression);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.field).toBe(field);
  });

  it.each([
    ['* * * * *', 1],
    ['*/1 * * * *', 1],
    ['*/4 * * * *', 4],
    ['*/5 * * * *', 5],
    ['0,3 * * * *', 3],
    ['0,58 * * * *', 2],
    ['58 * * * *', 60],
    ['0 8 * * *', Infinity],
    ['0 23,0 * * *', 60],
    ['59 23 * * *', Infinity],
  ])('minimum interval of %s is %s minutes', (expression, minutes) => {
    expect(minIntervalMinutes(schedule(expression))).toBe(minutes);
  });
});

describe('fire times in a time zone (ADR-21, DST)', () => {
  it('08:00 in Asia/Ho_Chi_Minh is 01:00 UTC', () => {
    const daily = schedule('0 8 * * *');
    const zone = 'Asia/Ho_Chi_Minh';
    expect(iso(latestFireTime(daily, zone, at('2026-10-05T00:00Z'), at('2026-10-05T01:00Z')))).toBe(
      '2026-10-05T01:00:00.000Z',
    );
    expect(latestFireTime(daily, zone, at('2026-10-05T00:00Z'), at('2026-10-05T00:59:59Z'))).toBe(
      null,
    );
    // The window is (after, atOrBefore]: a fire time at `after` is not in it.
    expect(latestFireTime(daily, zone, at('2026-10-05T01:00Z'), at('2026-10-05T02:00Z'))).toBe(
      null,
    );
    expect(iso(nextFireTime(daily, zone, at('2026-10-05T01:00Z')))).toBe(
      '2026-10-06T01:00:00.000Z',
    );
  });

  it('keeps 08:00 local across the DST changes of America/New_York', () => {
    const daily = schedule('0 8 * * *');
    const zone = 'America/New_York';
    const fires = fireTimesBetween(
      daily,
      zone,
      at('2026-03-06T00:00Z'),
      at('2026-03-10T00:00Z'),
      10,
    );
    expect(fires.map(iso)).toEqual([
      '2026-03-09T12:00:00.000Z', // EDT
      '2026-03-08T12:00:00.000Z', // EDT (clocks went forward at 02:00)
      '2026-03-07T13:00:00.000Z', // EST
      '2026-03-06T13:00:00.000Z',
    ]);
    const autumn = fireTimesBetween(
      daily,
      zone,
      at('2026-10-31T00:00Z'),
      at('2026-11-02T23:00Z'),
      10,
    );
    expect(autumn.map(iso)).toEqual([
      '2026-11-02T13:00:00.000Z',
      '2026-11-01T13:00:00.000Z', // EST again
      '2026-10-31T12:00:00.000Z',
    ]);
  });

  it('fires a skipped wall time at the shifted instant and a repeated one once', () => {
    const zone = 'America/New_York';
    // 02:30 does not exist on 2026-03-08: fires at 03:30 EDT.
    expect(
      fireTimesBetween(
        schedule('30 2 * * *'),
        zone,
        at('2026-03-08T00:00Z'),
        at('2026-03-09T00:00Z'),
        5,
      ).map(iso),
    ).toEqual(['2026-03-08T07:30:00.000Z']);
    // 01:30 happens twice on 2026-11-01: fires once, at the first (EDT).
    expect(
      fireTimesBetween(
        schedule('30 1 * * *'),
        zone,
        at('2026-11-01T00:00Z'),
        at('2026-11-02T00:00Z'),
        5,
      ).map(iso),
    ).toEqual(['2026-11-01T05:30:00.000Z']);
  });

  it.each(['30 1 * * *', '*/5 * * * *', '0 * * * *'])(
    'review check: %s fires each instant at most once when ticked minute by minute through the repeated hour (fall back)',
    (expression) => {
      // America/New_York repeats 01:00–01:59 on 2026-11-01 (05:00Z–06:59Z). The schedule
      // tick asks for the window (previous tick, now] (every minute; 5-minute steps keep the
      // test fast and still split the repeated hour); a wall time maps to one instant (the
      // earlier), so no window of the second 01:xx can fire it again.
      const zone = 'America/New_York';
      const daily = schedule(expression);
      const fired: number[] = [];
      const step = 5 * 60_000;
      for (let now = at('2026-11-01T04:00Z'); now < at('2026-11-01T08:00Z'); now += step) {
        fired.push(...fireTimesBetween(daily, zone, now, now + step, 100));
      }
      expect(new Set(fired).size).toBe(fired.length);
      // Same instants as one window over the whole night.
      expect([...fired].sort((a, b) => b - a)).toEqual(
        fireTimesBetween(daily, zone, at('2026-11-01T04:00Z'), at('2026-11-01T08:00Z'), 1_000),
      );
      // Every wall time of the repeated hour fires once, at its first (EDT) instant.
      const repeated = fired.filter(
        (instant) => instant >= at('2026-11-01T05:00Z') && instant < at('2026-11-01T07:00Z'),
      );
      expect(repeated.every((instant) => instant < at('2026-11-01T06:00Z'))).toBe(true);
    },
    30_000,
  );

  it('day of month OR day of week when both are restricted', () => {
    // Friday 2026-11-13 and every other Friday or 13th.
    const fires = fireTimesBetween(
      schedule('0 0 13 * FRI'),
      'UTC',
      at('2026-11-01T00:00Z'),
      at('2026-11-30T23:59Z'),
      10,
    );
    expect(fires.map(iso).reverse()).toEqual([
      '2026-11-06T00:00:00.000Z',
      '2026-11-13T00:00:00.000Z',
      '2026-11-20T00:00:00.000Z',
      '2026-11-27T00:00:00.000Z',
    ]);
    // Only day-of-week restricted: Fridays only.
    expect(
      fireTimesBetween(
        schedule('0 0 * * FRI'),
        'UTC',
        at('2026-11-12T00:00Z'),
        at('2026-11-14T00:00Z'),
        5,
      ),
    ).toEqual([at('2026-11-13T00:00Z')]);
  });

  it('counts the fire times a downtime missed, latest first', () => {
    const every5 = schedule('*/5 * * * *');
    const fires = fireTimesBetween(
      every5,
      'UTC',
      at('2026-10-05T08:00Z'),
      at('2026-10-05T08:12Z'),
      100,
    );
    expect(fires.map(iso)).toEqual(['2026-10-05T08:10:00.000Z', '2026-10-05T08:05:00.000Z']);
    expect(
      fireTimesBetween(every5, 'UTC', at('2026-10-05T00:00Z'), at('2026-10-06T00:00Z'), 1000),
    ).toHaveLength(288);
  });

  it('finds a rare fire time (29 February)', () => {
    expect(iso(nextFireTime(schedule('0 0 29 2 *'), 'UTC', at('2026-10-05T00:00Z')))).toBe(
      '2028-02-29T00:00:00.000Z',
    );
  });
});

describe('date values reached (record.date_reached, ADR-21)', () => {
  const instant: DueRule = { kind: 'instant', offsetMinutes: 0, timeOfDay: null, timeZone: 'UTC' };
  const date: DueRule = {
    kind: 'date',
    offsetMinutes: 0,
    timeOfDay: null,
    timeZone: 'Asia/Ho_Chi_Minh',
  };

  it.each([
    ['instant', instant, '2026-10-05T03:00:00.000Z', '2026-10-05T03:00:00.000Z'],
    [
      'instant − 1 day',
      { ...instant, offsetMinutes: -1440 },
      '2026-10-05T03:00:00.000Z',
      '2026-10-04T03:00:00.000Z',
    ],
    ['date at 09:00 (default)', date, '2026-10-05', '2026-10-05T02:00:00.000Z'],
    ['date at 17:30', { ...date, timeOfDay: '17:30' }, '2026-10-05', '2026-10-05T10:30:00.000Z'],
    ['date + 2 h', { ...date, offsetMinutes: 120 }, '2026-10-05', '2026-10-05T04:00:00.000Z'],
    [
      'date in New York, EDT',
      { ...date, timeZone: 'America/New_York' },
      '2026-10-05',
      '2026-10-05T13:00:00.000Z',
    ],
    [
      'date in New York, EST',
      { ...date, timeZone: 'America/New_York' },
      '2026-12-05',
      '2026-12-05T14:00:00.000Z',
    ],
    ['not a date', date, 'tomorrow', null],
    ['not an instant', instant, 'nope', null],
  ] as const)('%s', (_name, rule, value, expected) => {
    expect(iso(dueAt(rule, value))).toBe(expected);
  });

  it('the column range of a window holds every value reached in it', () => {
    expect(
      valueRangeOf(
        { ...instant, offsetMinutes: 60 },
        at('2026-10-05T10:00Z'),
        at('2026-10-05T10:01Z'),
      ),
    ).toEqual({
      lower: { value: '2026-10-05T09:00:00.000Z', inclusive: false },
      upper: '2026-10-05T09:01:00.000Z',
    });
    // Date values: a day wider on each side, the caller filters exactly.
    expect(valueRangeOf(date, at('2026-10-05T01:59Z'), at('2026-10-05T02:00Z'))).toEqual({
      lower: { value: '2026-10-04', inclusive: true },
      upper: '2026-10-06',
    });
  });

  it('kinds of date fields; virtual formulas and lists are not scanned', () => {
    expect(dueValueKindOf({ type: 'created_at', options: {} })).toBe('instant');
    expect(dueValueKindOf({ type: 'datetime', options: {} })).toBe('date');
    expect(dueValueKindOf({ type: 'datetime', options: { style: { format: 'dd/MM/yyyy' } } })).toBe(
      'date',
    );
    expect(
      dueValueKindOf({ type: 'datetime', options: { style: { format: 'yyyy-MM-dd HH:mm' } } }),
    ).toBe('instant');
    expect(dueValueKindOf({ type: 'text', options: {} })).toBe(null);
    const formula = (compute_mode: string, result_type: unknown) => ({
      type: 'formula',
      options: {},
      compute_mode,
      result_type,
    });
    expect(dueValueKindOf(formula('stored', { kind: 'date' }))).toBe('date');
    expect(dueValueKindOf(formula('stored', { kind: 'datetime' }))).toBe('instant');
    expect(dueValueKindOf(formula('virtual', { kind: 'datetime' }))).toBe(null);
    expect(dueValueKindOf(formula('stored', { kind: 'number' }))).toBe(null);
  });

  it('value text of scanned rows', () => {
    expect(dueValueText('instant', new Date('2026-10-05T03:00:00Z'))).toBe(
      '2026-10-05T03:00:00.000Z',
    );
    expect(dueValueText('date', '2026-10-05')).toBe('2026-10-05');
    expect(dueValueText('date', null)).toBe(null);
  });

  it('time zone fallback', () => {
    expect(firstTimeZone(undefined, 'Nope/Zone', 'Asia/Ho_Chi_Minh')).toBe('Asia/Ho_Chi_Minh');
    expect(firstTimeZone(null, null)).toBe('UTC');
  });
});
