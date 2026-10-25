import { describe, expect, it } from 'vitest';

import { withFilterValues } from '../../src/automation/actions/update-records/filter-values.js';
import {
  filterOperandOf,
  filterValueSlots,
  parseUntil,
  untilOf,
  type AutomationFieldMeta,
} from '../../src/automation/index.js';

/** Pure helpers of BACKLOG T506: `delay.until`, values inside an `update_records` filter. */

const ZONE = 'Asia/Ho_Chi_Minh';

describe('parseUntil (delay.until)', () => {
  it.each([
    ['an ISO instant', '2026-10-05T03:00:00.000Z', '2026-10-05T03:00:00.000Z'],
    ['an instant with offset', '2026-10-05T10:00+07:00', '2026-10-05T03:00:00.000Z'],
    ['a date (midnight in the zone)', '2026-10-05', '2026-10-04T17:00:00.000Z'],
    ['a wall time in the zone', '2026-10-05T09:30', '2026-10-05T02:30:00.000Z'],
    ['a wall time with seconds', '2026-10-05 09:30:15', '2026-10-05T02:30:15.000Z'],
    ['a one-item list', ['2026-10-05'], '2026-10-04T17:00:00.000Z'],
  ])('reads %s', (_label, value, expected) => {
    expect(parseUntil(value, ZONE)?.toISOString()).toBe(expected);
  });

  it.each([
    ['null', null],
    ['an empty text', ''],
    ['a number', 1_700_000_000_000],
    ['an impossible day', '2026-06-31'],
    ['an impossible hour', '2026-06-30T25:00'],
    ['free text', 'next monday'],
    ['a list of two', ['2026-10-05', '2026-10-06']],
  ])('refuses %s', (_label, value) => {
    expect(parseUntil(value, ZONE)).toBeNull();
  });
});

describe('untilOf (delay step output)', () => {
  it.each([
    [{ until: '2026-10-05T03:00:00.000Z' }, '2026-10-05T03:00:00.000Z'],
    [{ until: 'nope' }, null],
    [{ other: 1 }, null],
    [null, null],
    [['2026-10-05T03:00:00.000Z'], null],
  ])('%j → %s', (output, expected) => {
    expect(untilOf(output)?.toISOString() ?? null).toBe(expected);
  });
});

describe('filterValueSlots / withFilterValues', () => {
  const filter = {
    op: 'and',
    items: [
      { field: 'fld_a', operator: 'eq', value: { field: 'fld_FieldB0000000001' } },
      { op: 'not', item: { field: 'fld_c', operator: 'eq', value: { template: '{{ 1 }}' } } },
      { field: 'fld_d', operator: 'is', value: 'opt_x' },
      { field: 'fld_e', operator: 'eq', value: { other: 1 } },
      {
        op: 'or',
        items: [{ field: 'fld_f', operator: 'gt', value: { step: 'act_1', path: 'n' } }],
      },
    ],
  };

  it('finds the values of SPEC §11.4 at condition values only', () => {
    expect(filterValueSlots(filter).map(({ path, value }) => ({ path, value }))).toEqual([
      { path: 'items[0].value', value: { field: 'fld_FieldB0000000001' } },
      { path: 'items[1].item.value', value: { template: '{{ 1 }}' } },
      { path: 'items[4].items[0].value', value: { step: 'act_1', path: 'n' } },
    ]);
    expect(filterValueSlots({ field: 'fld_a', operator: 'eq', value: { literal: 1 } })).toEqual([
      { segments: ['value'], path: 'value', value: { literal: 1 } },
    ]);
    // Tuple form, plain values, nothing: no slot.
    expect(filterValueSlots({ logic: 'and', conditions: [['fld_a', '==', 1]] })).toEqual([]);
    expect(filterValueSlots(null)).toEqual([]);
  });

  it('replaces (or removes) them in a copy', () => {
    const slots = filterValueSlots(filter);
    const replaced = withFilterValues(filter, slots, ['B', 'C', 7]) as typeof filter;
    expect(replaced.items[0]).toEqual({ field: 'fld_a', operator: 'eq', value: 'B' });
    expect(replaced.items[4]).toEqual({
      op: 'or',
      items: [{ field: 'fld_f', operator: 'gt', value: 7 }],
    });
    const probe = withFilterValues(filter, slots, [
      undefined,
      undefined,
      undefined,
    ]) as typeof filter;
    expect(probe.items[0]).toEqual({ field: 'fld_a', operator: 'eq' });
    // The original is untouched.
    expect(filter.items[0]).toEqual({
      field: 'fld_a',
      operator: 'eq',
      value: { field: 'fld_FieldB0000000001' },
    });
  });
});

describe('filterOperandOf', () => {
  const field = (type: string, options: unknown = {}): AutomationFieldMeta => ({
    id: 'fld_x',
    table_id: 'tbl_x',
    name: 'x',
    type,
    options,
  });

  it.each([
    ['an option cell', field('select'), { id: 'opt_a', name: 'A' }, 'opt_a'],
    [
      'a user list',
      field('user'),
      [{ id: 'usr_1', name: 'A' }, { id: 'usr_2' }],
      ['usr_1', 'usr_2'],
    ],
    ['a number text', field('number'), ' 12.5 ', 12.5],
    ['a non-number text', field('number'), 'abc', 'abc'],
    [
      'an instant on a datetime',
      field('datetime', { style: { format: 'dd/MM/yyyy HH:mm' } }),
      '2026-10-05T03:00:00.000Z',
      '2026-10-05T10:00',
    ],
    [
      'an instant on a date-only field',
      field('datetime', { style: { format: 'dd/MM/yyyy' } }),
      '2026-10-04T18:00:00.000Z',
      '2026-10-05',
    ],
    ['a date text', field('datetime'), '2026-10-05', '2026-10-05'],
    ['a text', field('text'), 'hello', 'hello'],
    ['a boolean', field('checkbox'), true, true],
    ['without field meta', undefined, '2026-10-05T03:00:00.000Z', '2026-10-05T03:00:00.000Z'],
  ])('maps %s', (_label, meta, value, expected) => {
    expect(filterOperandOf(value, meta, ZONE)).toEqual(expected);
  });

  it.each([null, undefined, '', [], [null, '']])('treats %j as empty', (value) => {
    expect(filterOperandOf(value, field('text'), ZONE)).toBeUndefined();
  });
});
