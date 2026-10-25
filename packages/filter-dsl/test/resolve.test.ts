import { describe, expect, it } from 'vitest';

import {
  isDateRange,
  resolveVariables,
  type DateSpec,
  type FilterNode,
  type FilterOperand,
  type ResolveContext,
} from '../src/index.js';

import { fld, usr } from './fixture.js';

const HCM = 'Asia/Ho_Chi_Minh';
const NY = 'America/New_York';

const ctx = (timeZone: string, now: string, userId: string | null = usr.an): ResolveContext => ({
  userId,
  // Members of the acting user's groups (sales: an, binh; ops: an, chi), expanded by the caller.
  groupMemberUserIds: [usr.an, usr.binh, usr.an, usr.chi],
  timeZone,
  now: new Date(now),
});

const range = (start: string, end: string, startDate: string, endDate: string) => ({
  $range: { start, end, start_date: startDate, end_date: endDate },
});

/** Resolves one date operand in a `datetime is <operand>` condition. */
const resolveDate = (operand: FilterOperand, context: ResolveContext) => {
  const resolved = resolveVariables({ field: fld.due, operator: 'is', value: operand }, context);
  return 'value' in resolved ? resolved.value : undefined;
};

const rel = (relative: string, amount?: number): FilterOperand =>
  ({ $date: amount === undefined ? { relative } : { relative, amount } }) as { $date: DateSpec };

describe('resolveVariables: dates (Wednesday 2026-09-23T10:00Z)', () => {
  const now = '2026-09-23T10:00:00.000Z';
  const cases: { name: string; tz: string; operand: FilterOperand; expected: unknown }[] = [
    // Asia/Ho_Chi_Minh, UTC+7, no DST: local time 17:00 on the 23rd.
    {
      name: 'HCM $var today',
      tz: HCM,
      operand: { $var: 'today' },
      expected: range(
        '2026-09-22T17:00:00.000Z',
        '2026-09-23T17:00:00.000Z',
        '2026-09-23',
        '2026-09-24',
      ),
    },
    {
      name: 'HCM today',
      tz: HCM,
      operand: rel('today'),
      expected: range(
        '2026-09-22T17:00:00.000Z',
        '2026-09-23T17:00:00.000Z',
        '2026-09-23',
        '2026-09-24',
      ),
    },
    {
      name: 'HCM tomorrow',
      tz: HCM,
      operand: rel('tomorrow'),
      expected: range(
        '2026-09-23T17:00:00.000Z',
        '2026-09-24T17:00:00.000Z',
        '2026-09-24',
        '2026-09-25',
      ),
    },
    {
      name: 'HCM yesterday',
      tz: HCM,
      operand: rel('yesterday'),
      expected: range(
        '2026-09-21T17:00:00.000Z',
        '2026-09-22T17:00:00.000Z',
        '2026-09-22',
        '2026-09-23',
      ),
    },
    {
      name: 'HCM days_ago 7',
      tz: HCM,
      operand: rel('days_ago', 7),
      expected: range(
        '2026-09-15T17:00:00.000Z',
        '2026-09-16T17:00:00.000Z',
        '2026-09-16',
        '2026-09-17',
      ),
    },
    {
      name: 'HCM days_ago 0 = today',
      tz: HCM,
      operand: rel('days_ago', 0),
      expected: range(
        '2026-09-22T17:00:00.000Z',
        '2026-09-23T17:00:00.000Z',
        '2026-09-23',
        '2026-09-24',
      ),
    },
    {
      name: 'HCM days_from_now 10 (across a month)',
      tz: HCM,
      operand: rel('days_from_now', 10),
      expected: range(
        '2026-10-02T17:00:00.000Z',
        '2026-10-03T17:00:00.000Z',
        '2026-10-03',
        '2026-10-04',
      ),
    },
    {
      name: 'HCM this_week (Monday start)',
      tz: HCM,
      operand: rel('this_week'),
      expected: range(
        '2026-09-20T17:00:00.000Z',
        '2026-09-27T17:00:00.000Z',
        '2026-09-21',
        '2026-09-28',
      ),
    },
    {
      name: 'HCM this_month',
      tz: HCM,
      operand: rel('this_month'),
      expected: range(
        '2026-08-31T17:00:00.000Z',
        '2026-09-30T17:00:00.000Z',
        '2026-09-01',
        '2026-10-01',
      ),
    },
    {
      name: 'HCM last_month',
      tz: HCM,
      operand: rel('last_month'),
      expected: range(
        '2026-07-31T17:00:00.000Z',
        '2026-08-31T17:00:00.000Z',
        '2026-08-01',
        '2026-09-01',
      ),
    },
    {
      name: 'HCM this_year',
      tz: HCM,
      operand: rel('this_year'),
      expected: range(
        '2025-12-31T17:00:00.000Z',
        '2026-12-31T17:00:00.000Z',
        '2026-01-01',
        '2027-01-01',
      ),
    },
    {
      name: 'HCM exact date',
      tz: HCM,
      operand: { $date: { exact: '2026-09-25' } },
      expected: range(
        '2026-09-24T17:00:00.000Z',
        '2026-09-25T17:00:00.000Z',
        '2026-09-25',
        '2026-09-26',
      ),
    },
    {
      name: 'HCM exact date-time (one minute)',
      tz: HCM,
      operand: { $date: { exact: '2026-09-25T09:30' } },
      expected: range(
        '2026-09-25T02:30:00.000Z',
        '2026-09-25T02:31:00.000Z',
        '2026-09-25',
        '2026-09-26',
      ),
    },
    {
      name: 'HCM now (one millisecond)',
      tz: HCM,
      operand: { $var: 'now' },
      expected: range(
        '2026-09-23T10:00:00.000Z',
        '2026-09-23T10:00:00.001Z',
        '2026-09-23',
        '2026-09-24',
      ),
    },
    // America/New_York, EDT (UTC−4): local time 06:00 on the 23rd.
    {
      name: 'NY today',
      tz: NY,
      operand: { $var: 'today' },
      expected: range(
        '2026-09-23T04:00:00.000Z',
        '2026-09-24T04:00:00.000Z',
        '2026-09-23',
        '2026-09-24',
      ),
    },
    {
      name: 'NY tomorrow',
      tz: NY,
      operand: rel('tomorrow'),
      expected: range(
        '2026-09-24T04:00:00.000Z',
        '2026-09-25T04:00:00.000Z',
        '2026-09-24',
        '2026-09-25',
      ),
    },
    {
      name: 'NY yesterday',
      tz: NY,
      operand: rel('yesterday'),
      expected: range(
        '2026-09-22T04:00:00.000Z',
        '2026-09-23T04:00:00.000Z',
        '2026-09-22',
        '2026-09-23',
      ),
    },
    {
      name: 'NY days_ago 30',
      tz: NY,
      operand: rel('days_ago', 30),
      expected: range(
        '2026-08-24T04:00:00.000Z',
        '2026-08-25T04:00:00.000Z',
        '2026-08-24',
        '2026-08-25',
      ),
    },
    {
      name: 'NY days_from_now 1',
      tz: NY,
      operand: rel('days_from_now', 1),
      expected: range(
        '2026-09-24T04:00:00.000Z',
        '2026-09-25T04:00:00.000Z',
        '2026-09-24',
        '2026-09-25',
      ),
    },
    {
      name: 'NY this_week',
      tz: NY,
      operand: rel('this_week'),
      expected: range(
        '2026-09-21T04:00:00.000Z',
        '2026-09-28T04:00:00.000Z',
        '2026-09-21',
        '2026-09-28',
      ),
    },
    {
      name: 'NY this_month',
      tz: NY,
      operand: rel('this_month'),
      expected: range(
        '2026-09-01T04:00:00.000Z',
        '2026-10-01T04:00:00.000Z',
        '2026-09-01',
        '2026-10-01',
      ),
    },
    {
      name: 'NY last_month',
      tz: NY,
      operand: rel('last_month'),
      expected: range(
        '2026-08-01T04:00:00.000Z',
        '2026-09-01T04:00:00.000Z',
        '2026-08-01',
        '2026-09-01',
      ),
    },
    {
      name: 'NY this_year (starts in EST)',
      tz: NY,
      operand: rel('this_year'),
      expected: range(
        '2026-01-01T05:00:00.000Z',
        '2027-01-01T05:00:00.000Z',
        '2026-01-01',
        '2027-01-01',
      ),
    },
    {
      name: 'NY exact date-time',
      tz: NY,
      operand: { $date: { exact: '2026-09-25T09:30' } },
      expected: range(
        '2026-09-25T13:30:00.000Z',
        '2026-09-25T13:31:00.000Z',
        '2026-09-25',
        '2026-09-26',
      ),
    },
    {
      name: 'NY now',
      tz: NY,
      operand: { $var: 'now' },
      expected: range(
        '2026-09-23T10:00:00.000Z',
        '2026-09-23T10:00:00.001Z',
        '2026-09-23',
        '2026-09-24',
      ),
    },
  ];

  it.each(cases)('$name', ({ tz, operand, expected }) => {
    expect(resolveDate(operand, ctx(tz, now))).toEqual(expected);
  });
});

describe('resolveVariables: time zone and calendar boundaries', () => {
  const cases: {
    name: string;
    tz: string;
    now: string;
    operand: FilterOperand;
    expected: unknown;
  }[] = [
    {
      name: 'the same instant is a different local day in HCM and NY (HCM)',
      tz: HCM,
      now: '2026-09-23T20:00:00.000Z',
      operand: { $var: 'today' },
      expected: range(
        '2026-09-23T17:00:00.000Z',
        '2026-09-24T17:00:00.000Z',
        '2026-09-24',
        '2026-09-25',
      ),
    },
    {
      name: 'the same instant is a different local day in HCM and NY (NY)',
      tz: NY,
      now: '2026-09-23T20:00:00.000Z',
      operand: { $var: 'today' },
      expected: range(
        '2026-09-23T04:00:00.000Z',
        '2026-09-24T04:00:00.000Z',
        '2026-09-23',
        '2026-09-24',
      ),
    },
    {
      name: 'NY DST start: today is 23 hours long',
      tz: NY,
      now: '2026-03-08T12:00:00.000Z',
      operand: rel('today'),
      expected: range(
        '2026-03-08T05:00:00.000Z',
        '2026-03-09T04:00:00.000Z',
        '2026-03-08',
        '2026-03-09',
      ),
    },
    {
      name: 'NY DST start: yesterday is still EST',
      tz: NY,
      now: '2026-03-08T12:00:00.000Z',
      operand: rel('yesterday'),
      expected: range(
        '2026-03-07T05:00:00.000Z',
        '2026-03-08T05:00:00.000Z',
        '2026-03-07',
        '2026-03-08',
      ),
    },
    {
      name: 'NY DST start: this_month spans the change',
      tz: NY,
      now: '2026-03-08T12:00:00.000Z',
      operand: rel('this_month'),
      expected: range(
        '2026-03-01T05:00:00.000Z',
        '2026-04-01T04:00:00.000Z',
        '2026-03-01',
        '2026-04-01',
      ),
    },
    {
      name: 'NY DST start: skipped 02:30 moves forward to 03:30 EDT',
      tz: NY,
      now: '2026-03-08T12:00:00.000Z',
      operand: { $date: { exact: '2026-03-08T02:30' } },
      expected: range(
        '2026-03-08T07:30:00.000Z',
        '2026-03-08T07:31:00.000Z',
        '2026-03-08',
        '2026-03-09',
      ),
    },
    {
      name: 'NY DST end: today is 25 hours long',
      tz: NY,
      now: '2026-11-01T15:00:00.000Z',
      operand: { $var: 'today' },
      expected: range(
        '2026-11-01T04:00:00.000Z',
        '2026-11-02T05:00:00.000Z',
        '2026-11-01',
        '2026-11-02',
      ),
    },
    {
      name: 'NY DST end: repeated 01:30 resolves to the earlier (EDT) instant',
      tz: NY,
      now: '2026-11-01T15:00:00.000Z',
      operand: { $date: { exact: '2026-11-01T01:30' } },
      expected: range(
        '2026-11-01T05:30:00.000Z',
        '2026-11-01T05:31:00.000Z',
        '2026-11-01',
        '2026-11-02',
      ),
    },
    {
      name: 'NY DST end: this_week (Sunday belongs to the week starting Monday 26 Oct)',
      tz: NY,
      now: '2026-11-01T15:00:00.000Z',
      operand: rel('this_week'),
      expected: range(
        '2026-10-26T04:00:00.000Z',
        '2026-11-02T05:00:00.000Z',
        '2026-10-26',
        '2026-11-02',
      ),
    },
    {
      name: 'HCM Sunday: this_week still starts on the previous Monday',
      tz: HCM,
      now: '2026-09-27T05:00:00.000Z',
      operand: rel('this_week'),
      expected: range(
        '2026-09-20T17:00:00.000Z',
        '2026-09-27T17:00:00.000Z',
        '2026-09-21',
        '2026-09-28',
      ),
    },
    {
      name: 'HCM Monday: this_week starts today',
      tz: HCM,
      now: '2026-09-20T17:30:00.000Z',
      operand: rel('this_week'),
      expected: range(
        '2026-09-20T17:00:00.000Z',
        '2026-09-27T17:00:00.000Z',
        '2026-09-21',
        '2026-09-28',
      ),
    },
    {
      name: 'HCM January: last_month is December of the previous year',
      tz: HCM,
      now: '2026-01-15T00:00:00.000Z',
      operand: rel('last_month'),
      expected: range(
        '2025-11-30T17:00:00.000Z',
        '2025-12-31T17:00:00.000Z',
        '2025-12-01',
        '2026-01-01',
      ),
    },
    {
      name: 'NY New Year’s Eve evening is still the old year (HCM already new year)',
      tz: NY,
      now: '2026-12-31T23:30:00.000Z',
      operand: rel('this_year'),
      expected: range(
        '2026-01-01T05:00:00.000Z',
        '2027-01-01T05:00:00.000Z',
        '2026-01-01',
        '2027-01-01',
      ),
    },
    {
      name: 'HCM New Year: this_year is the new year',
      tz: HCM,
      now: '2026-12-31T23:30:00.000Z',
      operand: rel('this_year'),
      expected: range(
        '2026-12-31T17:00:00.000Z',
        '2027-12-31T17:00:00.000Z',
        '2027-01-01',
        '2028-01-01',
      ),
    },
    {
      name: 'HCM leap day: days_ago across February',
      tz: HCM,
      now: '2028-03-01T03:00:00.000Z',
      operand: rel('days_ago', 1),
      expected: range(
        '2028-02-28T17:00:00.000Z',
        '2028-02-29T17:00:00.000Z',
        '2028-02-29',
        '2028-03-01',
      ),
    },
  ];

  it.each(cases)('$name', ({ tz, now, operand, expected }) => {
    expect(resolveDate(operand, ctx(tz, now))).toEqual(expected);
  });

  it('accepts epoch milliseconds for now', () => {
    const fromDate = resolveDate(rel('today'), ctx(HCM, '2026-09-23T10:00:00.000Z'));
    const fromMs = resolveDate(rel('today'), {
      ...ctx(HCM, '2026-09-23T10:00:00.000Z'),
      now: Date.parse('2026-09-23T10:00:00.000Z'),
    });
    expect(fromMs).toEqual(fromDate);
  });
});

describe('resolveVariables: users, groups and tree shape', () => {
  const now = '2026-09-23T10:00:00.000Z';

  it('resolves current_user and spreads current_user_groups (member user ids) inside lists', () => {
    const ast: FilterNode = {
      op: 'or',
      items: [
        { field: fld.owner, operator: 'has_any_of', value: [{ $var: 'current_user' }, usr.binh] },
        { field: fld.owner, operator: 'has_any_of', value: [{ $var: 'current_user_groups' }] },
        { op: 'not', item: { field: fld.title, operator: 'is_empty' } },
        { field: fld.title, operator: 'eq', value: { field_ref: fld.code } },
        { field: fld.amount, operator: 'between', value: [1, 2] },
      ],
    };
    expect(resolveVariables(ast, ctx(HCM, now))).toEqual({
      op: 'or',
      items: [
        { field: fld.owner, operator: 'has_any_of', value: [usr.an, usr.binh] },
        { field: fld.owner, operator: 'has_any_of', value: [usr.an, usr.binh, usr.chi] },
        { op: 'not', item: { field: fld.title, operator: 'is_empty' } },
        { field: fld.title, operator: 'eq', value: { field_ref: fld.code } },
        { field: fld.amount, operator: 'between', value: [1, 2] },
      ],
    });
  });

  it('without a user, current_user drops out of lists and is null as a scalar', () => {
    const ast: FilterNode = {
      op: 'and',
      items: [
        { field: fld.owner, operator: 'has_any_of', value: [{ $var: 'current_user' }] },
        { field: fld.owner, operator: 'changed_to', value: { $var: 'current_user' } },
        { field: fld.owner, operator: 'has_any_of', value: { $var: 'current_user_groups' } },
      ],
    };
    expect(resolveVariables(ast, { ...ctx(HCM, now, null), groupMemberUserIds: [] })).toEqual({
      op: 'and',
      items: [
        { field: fld.owner, operator: 'has_any_of', value: [] },
        { field: fld.owner, operator: 'changed_to', value: null },
        { field: fld.owner, operator: 'has_any_of', value: [] },
      ],
    });
  });

  it('current_user_groups as a scalar operand resolves to the member list', () => {
    const resolved = resolveVariables(
      { field: fld.creator, operator: 'has_none_of', value: { $var: 'current_user_groups' } },
      { ...ctx(HCM, now), groupMemberUserIds: [usr.binh, usr.binh] },
    );
    expect(resolved).toEqual({ field: fld.creator, operator: 'has_none_of', value: [usr.binh] });
  });

  it('resolves both ends of a date between', () => {
    const resolved = resolveVariables(
      { field: fld.due, operator: 'between', value: [rel('yesterday'), { $var: 'today' }] },
      ctx(HCM, now),
    );
    expect(resolved).toEqual({
      field: fld.due,
      operator: 'between',
      value: [
        range('2026-09-21T17:00:00.000Z', '2026-09-22T17:00:00.000Z', '2026-09-22', '2026-09-23'),
        range('2026-09-22T17:00:00.000Z', '2026-09-23T17:00:00.000Z', '2026-09-23', '2026-09-24'),
      ],
    });
  });

  it('is pure: same input and now give the same output, input untouched', () => {
    const ast: FilterNode = { field: fld.due, operator: 'is', value: { $var: 'today' } };
    const snapshot = structuredClone(ast);
    expect(resolveVariables(ast, ctx(NY, now))).toEqual(resolveVariables(ast, ctx(NY, now)));
    expect(ast).toEqual(snapshot);
  });

  it('isDateRange recognises resolved ranges only', () => {
    expect(isDateRange(resolveDate({ $var: 'today' }, ctx(HCM, now)))).toBe(true);
    expect(isDateRange('2026-01-01')).toBe(false);
    expect(isDateRange(null)).toBe(false);
  });

  it.each([
    { name: 'unknown time zone', context: { ...ctx(HCM, now), timeZone: 'Mars/Olympus' } },
    { name: 'invalid now', context: { ...ctx(HCM, now), now: Number.NaN } },
  ])('throws on $name', ({ context }) => {
    expect(() =>
      resolveVariables({ field: fld.due, operator: 'is', value: { $var: 'today' } }, context),
    ).toThrow(RangeError);
  });

  it('throws on an unvalidated malformed exact date', () => {
    expect(() => resolveDate({ $date: { exact: '2026-13-01' } }, ctx(HCM, now))).toThrow(
      RangeError,
    );
  });
});
