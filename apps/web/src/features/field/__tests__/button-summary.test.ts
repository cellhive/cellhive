import { describe, expect, it } from 'vitest';

import { summarizeCondition } from '../button/summary';

import type { FieldDto } from '@cellhive/contracts';

const NOW = '2026-10-06T00:00:00.000Z';

function field(id: string, name: string, type: string, options: object = {}): FieldDto {
  return {
    id,
    table_id: 'tbl_Orders0000000001',
    name,
    type,
    options,
    is_primary: false,
    required: false,
    unique_values: false,
    description: null,
    position: 0,
    created_at: NOW,
    updated_at: NOW,
  } as FieldDto;
}

const STATUS = field('fld_Status0000000001', 'Status', 'select', {
  options: [
    { id: 'opt_new', name: 'New', color: 0 },
    { id: 'opt_done', name: 'Done', color: 1 },
  ],
});
const TOTAL = field('fld_Total00000000001', 'Total', 'number');
const FIELDS = [STATUS, TOTAL];

describe('summarizeCondition (T525)', () => {
  it.each([
    ['no filter', null, null],
    ['an empty object', {}, null],
    ['an empty group', { op: 'and', items: [] }, null],
  ])('%s: always enabled', (_name, filter, expected) => {
    expect(summarizeCondition(filter, FIELDS)).toEqual(expected);
  });

  it.each([
    [
      'options by name, numbers as text',
      {
        op: 'and',
        items: [
          { field: STATUS.id, operator: 'is', value: 'opt_new' },
          { field: TOTAL.id, operator: 'gte', value: 5_000_000 },
        ],
      },
      {
        op: 'and',
        parts: [
          { field: 'Status', operator: 'is', value: 'New' },
          { field: 'Total', operator: 'gte', value: '5000000' },
        ],
        more: 0,
      },
    ],
    [
      'a bare condition, without value; lists joined',
      { field: STATUS.id, operator: 'is_any_of', value: ['opt_new', 'opt_done'] },
      {
        op: 'and',
        parts: [{ field: 'Status', operator: 'is_any_of', value: 'New, Done' }],
        more: 0,
      },
    ],
    [
      'unknown fields have no name; nested groups and extra items are counted',
      {
        op: 'or',
        items: [
          { field: 'fld_Gone000000000001', operator: 'is_empty' },
          { op: 'and', items: [] },
        ],
      },
      { op: 'or', parts: [{ field: null, operator: 'is_empty', value: null }], more: 1 },
    ],
  ])('%s', (_name, filter, expected) => {
    expect(summarizeCondition(filter, FIELDS)).toEqual(expected);
  });

  it('spells out at most `max` conditions', () => {
    const items = Array.from({ length: 5 }, () => ({
      field: TOTAL.id,
      operator: 'gt',
      value: 1,
    }));
    const summary = summarizeCondition({ op: 'and', items }, FIELDS, 3);
    expect(summary?.parts).toHaveLength(3);
    expect(summary?.more).toBe(2);
  });
});
