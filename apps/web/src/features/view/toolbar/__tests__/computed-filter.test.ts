import { describe, expect, it } from 'vitest';

import { operatorsFor, valueShapeOf } from '../filter-model';
import { directionLabels, sortableFields } from '../SortPanel';

import type { FieldDto } from '@cellhive/contracts';

const NOW = '2026-09-28T00:00:00.000Z';

function computed(resultType: FieldDto['result_type'], extra: Partial<FieldDto> = {}): FieldDto {
  return {
    id: 'fld_Total00000000001',
    table_id: 'tbl_Customers0000001',
    name: 'Total',
    type: 'lookup',
    options: { style: null },
    is_primary: false,
    required: false,
    unique_values: false,
    description: null,
    position: 1,
    created_at: NOW,
    updated_at: NOW,
    result_type: resultType,
    compute_state: 'ready',
    compute_error: null,
    ...extra,
  };
}

describe('filter, sort and group by the result type of formula/lookup fields (T468)', () => {
  it.each([
    [{ kind: 'number', list: false }, 'gt', true],
    [{ kind: 'text', list: false }, 'contains', true],
    [{ kind: 'boolean', list: false }, 'is', true],
    [{ kind: 'date', list: false }, 'before', true],
    [{ kind: 'text', list: true }, 'has_any_of', true],
    [{ kind: 'number', list: true }, 'gt', false],
    [{ kind: 'attachment', list: true }, 'is_empty', true],
  ] as const)('%j offers %s: %s', (resultType, operator, offered) => {
    expect(operatorsFor(computed(resultType)).includes(operator)).toBe(offered);
  });

  it('a list of texts takes a list of texts', () => {
    expect(valueShapeOf(computed({ kind: 'text', list: true }), 'has_any_of')).toEqual({
      shape: 'list',
      kind: 'text',
    });
  });

  it('locked fields, fields in error and unknown results are not offered', () => {
    const number = { kind: 'number', list: false } as const;
    expect(operatorsFor(computed(number, { locked: true }))).toEqual([]);
    expect(operatorsFor(computed(number, { compute_error: { code: 'REF', refs: [] } }))).toEqual(
      [],
    );
    expect(operatorsFor(computed(undefined))).toEqual([]);
  });

  it('sorts by value results only; the directions follow the result', () => {
    const fields = [
      computed({ kind: 'number', list: false }),
      computed({ kind: 'record', list: true }, { id: 'fld_Records000000001' }),
      computed({ kind: 'attachment', list: true }, { id: 'fld_Files00000000001' }),
      computed({ kind: 'text', list: false }, { id: 'fld_Locked0000000001', locked: true }),
    ];
    expect(sortableFields(fields).map((field) => field.id)).toEqual(['fld_Total00000000001']);
    expect(directionLabels(computed({ kind: 'number', list: false }))).toBe('number');
    expect(directionLabels(computed({ kind: 'datetime', list: false }))).toBe('date');
    expect(directionLabels(computed({ kind: 'boolean', list: false }))).toBe('checkbox');
  });
});
