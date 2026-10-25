import { describe, expect, it } from 'vitest';

import { compareIfValues, isEmptyValue } from '../../src/automation/actions/if/compare.js';

describe('compareIfValues (SPEC §11.3 value conditions)', () => {
  const cases: {
    value: unknown;
    operator: Parameters<typeof compareIfValues>[1];
    compare: unknown;
    expected: boolean;
  }[] = [
    { value: null, operator: 'is_empty', compare: null, expected: true },
    { value: '  ', operator: 'is_empty', compare: null, expected: true },
    { value: [], operator: 'is_empty', compare: null, expected: true },
    { value: [null], operator: 'is_empty', compare: null, expected: true },
    { value: 0, operator: 'is_empty', compare: null, expected: false },
    { value: false, operator: 'is_not_empty', compare: null, expected: true },
    { value: 'opt_done', operator: 'is', compare: 'opt_done', expected: true },
    { value: 'Done', operator: 'is', compare: 'done', expected: false },
    { value: '10', operator: 'is', compare: 10, expected: true },
    { value: 10.5, operator: 'is_not', compare: '10.50', expected: false },
    { value: [{ id: 'usr_a', name: 'A' }], operator: 'is', compare: 'usr_a', expected: true },
    { value: ['opt_a', 'opt_b'], operator: 'is', compare: ['opt_b', 'opt_a'], expected: true },
    { value: ['opt_a', 'opt_b'], operator: 'is', compare: 'opt_a', expected: false },
    { value: null, operator: 'is', compare: null, expected: true },
    { value: 'Hello World', operator: 'contains', compare: 'world', expected: true },
    { value: 'Hello', operator: 'contains', compare: 'bye', expected: false },
    {
      value: [{ id: 'rec_1', title: 'x' }, { id: 'rec_2' }],
      operator: 'contains',
      compare: 'rec_2',
      expected: true,
    },
    { value: ['opt_a'], operator: 'contains', compare: ['opt_a', 'opt_b'], expected: false },
    { value: 'x', operator: 'contains', compare: '', expected: true },
    { value: 1_500_000, operator: 'gt', compare: '1000000', expected: true },
    { value: 5, operator: 'gte', compare: 5, expected: true },
    { value: 5, operator: 'lt', compare: 5, expected: false },
    { value: '2026-10-05', operator: 'lt', compare: '2026-10-06', expected: true },
    {
      value: '2026-10-05T10:00:00.000Z',
      operator: 'lte',
      compare: '2026-10-05T09:00:00.000Z',
      expected: false,
    },
    { value: '2026-10-05', operator: 'gt', compare: '2026-10-04T00:00:00Z', expected: false },
    { value: 'b', operator: 'gt', compare: 'a', expected: false },
    { value: null, operator: 'gt', compare: 1, expected: false },
    { value: [1, 2], operator: 'gt', compare: 0, expected: false },
  ];

  it.each(cases)(
    '$value $operator $compare → $expected',
    ({ value, operator, compare, expected }) => {
      expect(compareIfValues(value, operator, compare)).toBe(expected);
    },
  );

  it('treats {} as empty and objects without id as no value', () => {
    expect(isEmptyValue({})).toBe(true);
    expect(compareIfValues({ a: 1 }, 'is', null)).toBe(true);
  });
});
