import { describe, expect, it } from 'vitest';

import {
  controlFilterOf,
  controlValueIssue,
  relativeDateRange,
  type RelativeDateRange,
} from '../../src/records/index.js';

import type { FilterControlKind, FilterControlValue, Id } from '@cellhive/contracts';
import type { FilterFieldMeta } from '@cellhive/filter-dsl';

describe('relativeDateRange (T808): control defaults with an injected clock and zone', () => {
  // 2026-10-25 (a Sunday) 20:30 UTC = 2026-10-26 (Monday) 03:30 in Ho Chi Minh City.
  const sundayEvening = Date.parse('2026-10-25T20:30:00Z');
  const cases: {
    relative: RelativeDateRange;
    now: number;
    zone: string;
    from: string;
    to: string;
  }[] = [
    { relative: 'today', now: sundayEvening, zone: 'UTC', from: '2026-10-25', to: '2026-10-25' },
    {
      relative: 'today',
      now: sundayEvening,
      zone: 'Asia/Ho_Chi_Minh',
      from: '2026-10-26',
      to: '2026-10-26',
    },
    {
      relative: 'today',
      now: sundayEvening,
      zone: 'America/Los_Angeles',
      from: '2026-10-25',
      to: '2026-10-25',
    },
    {
      relative: 'yesterday',
      now: sundayEvening,
      zone: 'UTC',
      from: '2026-10-24',
      to: '2026-10-24',
    },
    {
      relative: 'yesterday',
      now: sundayEvening,
      zone: 'Asia/Ho_Chi_Minh',
      from: '2026-10-25',
      to: '2026-10-25',
    },
    {
      relative: 'last_7_days',
      now: sundayEvening,
      zone: 'UTC',
      from: '2026-10-19',
      to: '2026-10-25',
    },
    {
      relative: 'last_30_days',
      now: sundayEvening,
      zone: 'UTC',
      from: '2026-09-26',
      to: '2026-10-25',
    },
    {
      relative: 'last_30_days',
      now: sundayEvening,
      zone: 'Asia/Ho_Chi_Minh',
      from: '2026-09-27',
      to: '2026-10-26',
    },
    // A Sunday belongs to the ISO week that started on the Monday before.
    {
      relative: 'this_week',
      now: sundayEvening,
      zone: 'UTC',
      from: '2026-10-19',
      to: '2026-10-25',
    },
    // Already Monday in Ho Chi Minh City: a new week.
    {
      relative: 'this_week',
      now: sundayEvening,
      zone: 'Asia/Ho_Chi_Minh',
      from: '2026-10-26',
      to: '2026-11-01',
    },
    {
      relative: 'last_week',
      now: sundayEvening,
      zone: 'UTC',
      from: '2026-10-12',
      to: '2026-10-18',
    },
    {
      relative: 'last_week',
      now: sundayEvening,
      zone: 'Asia/Ho_Chi_Minh',
      from: '2026-10-19',
      to: '2026-10-25',
    },
    {
      relative: 'this_month',
      now: sundayEvening,
      zone: 'UTC',
      from: '2026-10-01',
      to: '2026-10-31',
    },
    // 31 Oct 20:00 UTC is already November in Ho Chi Minh City.
    {
      relative: 'this_month',
      now: Date.parse('2026-10-31T20:00:00Z'),
      zone: 'Asia/Ho_Chi_Minh',
      from: '2026-11-01',
      to: '2026-11-30',
    },
    {
      relative: 'this_month',
      now: Date.parse('2028-02-10T00:00:00Z'),
      zone: 'UTC',
      from: '2028-02-01',
      to: '2028-02-29',
    },
    {
      relative: 'last_month',
      now: sundayEvening,
      zone: 'UTC',
      from: '2026-09-01',
      to: '2026-09-30',
    },
    // January: last month is December of the year before.
    {
      relative: 'last_month',
      now: Date.parse('2027-01-15T12:00:00Z'),
      zone: 'UTC',
      from: '2026-12-01',
      to: '2026-12-31',
    },
    {
      relative: 'last_month',
      now: Date.parse('2026-03-31T12:00:00Z'),
      zone: 'UTC',
      from: '2026-02-01',
      to: '2026-02-28',
    },
    {
      relative: 'this_quarter',
      now: sundayEvening,
      zone: 'UTC',
      from: '2026-10-01',
      to: '2026-12-31',
    },
    {
      relative: 'this_quarter',
      now: Date.parse('2026-02-14T00:00:00Z'),
      zone: 'UTC',
      from: '2026-01-01',
      to: '2026-03-31',
    },
    {
      relative: 'this_quarter',
      now: Date.parse('2026-06-30T23:30:00Z'),
      zone: 'Asia/Ho_Chi_Minh',
      from: '2026-07-01',
      to: '2026-09-30',
    },
    {
      relative: 'this_year',
      now: sundayEvening,
      zone: 'UTC',
      from: '2026-01-01',
      to: '2026-12-31',
    },
    // New Year's Eve 18:00 UTC is already 2027 in Ho Chi Minh City, still 2026 in Los Angeles.
    {
      relative: 'this_year',
      now: Date.parse('2026-12-31T18:00:00Z'),
      zone: 'Asia/Ho_Chi_Minh',
      from: '2027-01-01',
      to: '2027-12-31',
    },
    {
      relative: 'last_year',
      now: Date.parse('2026-12-31T18:00:00Z'),
      zone: 'America/Los_Angeles',
      from: '2025-01-01',
      to: '2025-12-31',
    },
    {
      relative: 'last_year',
      now: Date.parse('2026-12-31T18:00:00Z'),
      zone: 'Asia/Ho_Chi_Minh',
      from: '2026-01-01',
      to: '2026-12-31',
    },
    // Across a daylight-saving change (Los Angeles, 2026-11-01).
    {
      relative: 'last_7_days',
      now: Date.parse('2026-11-03T07:30:00Z'),
      zone: 'America/Los_Angeles',
      from: '2026-10-27',
      to: '2026-11-02',
    },
  ];

  it.each(cases)('$relative at $now in $zone', ({ relative, now, zone, from, to }) => {
    expect(relativeDateRange(relative, now, zone)).toEqual({ from, to });
    expect(relativeDateRange(relative, new Date(now), zone)).toEqual({ from, to });
  });

  it('has at least 20 cases', () => {
    expect(cases.length).toBeGreaterThanOrEqual(20);
  });
});

describe('controlValueIssue (T808)', () => {
  const cases: { kind: FilterControlKind; value: FilterControlValue; ok: boolean }[] = [
    { kind: 'select', value: { values: ['opt_a'] }, ok: true },
    { kind: 'select', value: { values: [] }, ok: true },
    { kind: 'select', value: { values: [1] }, ok: false },
    { kind: 'select', value: { relative: 'today' }, ok: false },
    { kind: 'user', value: { values: ['usr_a', 'usr_b'] }, ok: true },
    { kind: 'user', value: { range: { from: 1, to: 2 } }, ok: false },
    { kind: 'text', value: { values: ['Hà Nội'] }, ok: true },
    { kind: 'text', value: { values: [true] }, ok: false },
    { kind: 'number_range', value: { range: { from: 0, to: 1000 } }, ok: true },
    { kind: 'number_range', value: { range: { from: null, to: 5 } }, ok: true },
    { kind: 'number_range', value: { range: { from: 5, to: 1 } }, ok: false },
    { kind: 'number_range', value: { range: { from: '1', to: null } }, ok: false },
    { kind: 'number_range', value: { values: [1] }, ok: false },
    { kind: 'date_range', value: { relative: 'last_30_days' }, ok: true },
    { kind: 'date_range', value: { range: { from: '2026-01-01', to: '2026-01-31' } }, ok: true },
    { kind: 'date_range', value: { range: { from: '2026-02-30', to: null } }, ok: false },
    { kind: 'date_range', value: { range: { from: '2026-01-01T10:00', to: null } }, ok: false },
    { kind: 'date_range', value: { range: { from: '2026-02-01', to: '2026-01-01' } }, ok: false },
    { kind: 'date_range', value: { range: { from: 1, to: null } }, ok: false },
    { kind: 'date_range', value: { values: ['2026-01-01'] }, ok: false },
  ];
  it.each(cases)('$kind $value → ok=$ok', ({ kind, value, ok }) => {
    expect(controlValueIssue(kind, value) === null).toBe(ok);
  });
});

describe('controlFilterOf (T808)', () => {
  const id = 'fld_LiveFilterField1' as Id<'fld'>;
  const now = Date.parse('2026-10-25T20:30:00Z');
  const meta = (type: string, options: unknown = {}): FilterFieldMeta =>
    ({ id, name: 'f', type, options }) as FilterFieldMeta;
  const select = meta('select', { options: [{ id: 'opt_SelectOption0001', name: 'A' }] });
  const multi = meta('select', {
    multiple: true,
    options: [{ id: 'opt_SelectOption0001', name: 'A' }],
  });
  const cases: {
    name: string;
    control: FilterControlKind;
    field: FilterFieldMeta;
    value: FilterControlValue;
    expected: unknown;
  }[] = [
    {
      name: 'single select',
      control: 'select',
      field: select,
      value: { values: ['opt_SelectOption0001'] },
      expected: { field: id, operator: 'is_any_of', value: ['opt_SelectOption0001'] },
    },
    {
      name: 'multiple select',
      control: 'select',
      field: multi,
      value: { values: ['opt_SelectOption0001'] },
      expected: { field: id, operator: 'has_any_of', value: ['opt_SelectOption0001'] },
    },
    { name: 'no value', control: 'select', field: select, value: { values: [] }, expected: null },
    {
      name: 'users',
      control: 'user',
      field: meta('user'),
      value: { values: ['usr_a'] },
      expected: { field: id, operator: 'has_any_of', value: ['usr_a'] },
    },
    {
      name: 'created by',
      control: 'user',
      field: meta('created_by'),
      value: { values: ['usr_a'] },
      expected: { field: id, operator: 'has_any_of', value: ['usr_a'] },
    },
    {
      name: 'one text',
      control: 'text',
      field: meta('text'),
      value: { values: ['Hà'] },
      expected: { field: id, operator: 'contains', value: 'Hà' },
    },
    {
      name: 'several texts',
      control: 'text',
      field: meta('text'),
      value: { values: ['a', ' ', 'b'] },
      expected: {
        op: 'or',
        items: [
          { field: id, operator: 'contains', value: 'a' },
          { field: id, operator: 'contains', value: 'b' },
        ],
      },
    },
    {
      name: 'blank texts',
      control: 'text',
      field: meta('text'),
      value: { values: ['  '] },
      expected: null,
    },
    {
      name: 'number range',
      control: 'number_range',
      field: meta('number'),
      value: { range: { from: 0, to: 1000 } },
      expected: { field: id, operator: 'between', value: [0, 1000] },
    },
    {
      name: 'number lower bound',
      control: 'number_range',
      field: meta('number'),
      value: { range: { from: 5, to: null } },
      expected: { field: id, operator: 'gte', value: 5 },
    },
    {
      name: 'number upper bound',
      control: 'number_range',
      field: meta('number'),
      value: { range: { from: null, to: 5 } },
      expected: { field: id, operator: 'lte', value: 5 },
    },
    {
      name: 'number without bounds',
      control: 'number_range',
      field: meta('number'),
      value: { range: { from: null, to: null } },
      expected: null,
    },
    {
      name: 'relative dates in the zone',
      control: 'date_range',
      field: meta('datetime'),
      value: { relative: 'today' },
      expected: {
        field: id,
        operator: 'between',
        value: [{ $date: { exact: '2026-10-26' } }, { $date: { exact: '2026-10-26' } }],
      },
    },
    {
      name: 'dates from',
      control: 'date_range',
      field: meta('created_at'),
      value: { range: { from: '2026-01-01', to: null } },
      expected: { field: id, operator: 'on_or_after', value: { $date: { exact: '2026-01-01' } } },
    },
    {
      name: 'dates to',
      control: 'date_range',
      field: meta('datetime'),
      value: { range: { from: null, to: '2026-01-31' } },
      expected: {
        field: id,
        operator: 'on_or_before',
        value: { $date: { exact: '2026-01-31' } },
      },
    },
    {
      name: 'a field converted since',
      control: 'number_range',
      field: meta('text'),
      value: { range: { from: 1, to: 2 } },
      expected: 'unfit',
    },
    {
      name: 'a select control on a user field',
      control: 'select',
      field: meta('user'),
      value: { values: ['usr_a'] },
      expected: 'unfit',
    },
    {
      name: 'a user control on a select field',
      control: 'user',
      field: multi,
      value: { values: ['usr_a'] },
      expected: 'unfit',
    },
    {
      name: 'a date control on a number',
      control: 'date_range',
      field: meta('number'),
      value: { relative: 'today' },
      expected: 'unfit',
    },
    {
      name: 'a text control on a number',
      control: 'text',
      field: meta('number'),
      value: { values: ['1'] },
      expected: 'unfit',
    },
  ];
  it.each(cases)('$name', ({ control, field, value, expected }) => {
    expect(controlFilterOf({ control, field: id, value }, field, now, 'Asia/Ho_Chi_Minh')).toEqual(
      expected,
    );
  });
});
