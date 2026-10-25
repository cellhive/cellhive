import { describe, expect, it } from 'vitest';

import { toGridField } from '../../../grid';
import {
  densityOf,
  frozenCount,
  layoutOf,
  legacyLayoutPatch,
  moveInOrder,
  orderFields,
  rowHeightOf,
  visibleColumns,
} from '../layout/column-layout';

import type { EffectiveViewConfig } from '../../../lib/views/config';
import type { FieldDto } from '@cellhive/contracts';

const NOW = '2026-09-24T00:00:00.000Z';

function field(id: `fld_${string}`, position: number, primary = false): FieldDto {
  return {
    id,
    table_id: 'tbl_Tickets000000001',
    name: id,
    type: 'text',
    options: {},
    is_primary: primary,
    required: false,
    unique_values: false,
    description: null,
    position,
    created_at: NOW,
    updated_at: NOW,
  };
}

const A = 'fld_A000000000000001';
const B = 'fld_B000000000000001';
const C = 'fld_C000000000000001';
const D = 'fld_D000000000000001';

const E = 'fld_E000000000000001';

const CONFIG: EffectiveViewConfig = {
  filter: null,
  sort: [],
  group: [],
  hidden_fields: [],
  field_order: [],
  column_widths: {},
  frozen_count: 1,
  row_height: 'short',
  tree: { enabled: false, show_ancestors: true },
};

describe('legacyLayoutPatch (T207 device layout → view config)', () => {
  it.each<[string, string | null, ReturnType<typeof legacyLayoutPatch>]>([
    ['nothing stored', null, null],
    ['not JSON', '{oops', null],
    ['not an object', '42', null],
    ['only defaults', JSON.stringify({ hidden: [], frozen: 1, widths: {}, sort: null }), null],
    [
      'a full layout',
      JSON.stringify({
        hidden: [B],
        frozen: 2,
        widths: { [A]: 300.4 },
        sort: { field: B, direction: 'desc' },
      }),
      {
        hidden_fields: [B],
        frozen_count: 2,
        column_widths: { [A]: 300 },
        sort: [{ field: B, direction: 'desc' }],
      },
    ],
    [
      'bad parts are dropped one by one',
      JSON.stringify({
        hidden: [B, 'not-an-id'],
        frozen: 0,
        widths: { [A]: 9999 },
        sort: { field: B, direction: 'up' },
      }),
      null,
    ],
    [
      'frozen is capped at the contract limit',
      JSON.stringify({ frozen: 999 }),
      { frozen_count: 50 },
    ],
  ])('%s', (_label, raw, expected) => {
    expect(legacyLayoutPatch(raw)).toEqual(expected);
  });
});

describe('layoutOf', () => {
  it('keeps only fields that exist and clamps widths for the grid', () => {
    const layout = layoutOf(
      {
        ...CONFIG,
        hidden_fields: [B, D],
        field_order: [C, D, B],
        column_widths: { [A]: 100, [D]: 200, [B]: 1500, [C]: 40 },
        sort: [
          { field: D, direction: 'asc' },
          { field: B, direction: 'desc' },
        ],
        frozen_count: 2,
        row_height: 'tall',
      },
      new Set([A, B, C]),
    );
    expect(layout).toEqual({
      hidden: [B],
      order: [C, B],
      frozen: 2,
      widths: { [A]: 100, [B]: 500, [C]: 50 },
      sort: [{ field: B, direction: 'desc' }],
      rowHeight: 'tall',
    });
  });
});

describe('orderFields', () => {
  const fields = [field(A, 0, true), field(B, 1), field(C, 2), field(D, 3), field(E, 4)].map(
    toGridField,
  );
  const ids = (order: readonly string[]) =>
    orderFields(fields, order).map((column) => column.field.id);

  it.each<[string, string[], string[]]>([
    ['no view order: server order', [], [A, B, C, D, E]],
    ['full view order', [E, D, C, B], [A, E, D, C, B]],
    ['the primary field stays first', [C, A, B], [A, C, D, E, B]],
    // D was never moved: it follows C, the field before it on the server.
    ['unlisted fields follow their server neighbour', [C, B, E], [A, C, D, B, E]],
    ['unlisted field without listed neighbour goes first', [E, D], [A, B, C, E, D]],
    ['unknown and repeated ids are ignored', [D, 'fld_X000000000000001', D], [A, B, C, D, E]],
  ])('%s', (_label, order, expected) => {
    expect(ids(order)).toEqual(expected);
  });
});

describe('moveInOrder', () => {
  it.each<[string, string, string, string[]]>([
    ['right', B, D, [C, D, B, E]],
    ['left', E, C, [B, E, C, D]],
    ['onto itself', B, B, [B, C, D, E]],
    ['unknown field', 'fld_X000000000000001', B, [B, C, D, E]],
  ])('%s', (_label, fieldId, target, expected) => {
    expect(moveInOrder([B, C, D, E], fieldId, target)).toEqual(expected);
  });
});

describe('visibleColumns / frozenCount / density', () => {
  const fields = [field(A, 0, true), field(B, 1), field(C, 2)].map(toGridField);

  it.each<[string, readonly string[], string[]]>([
    ['nothing hidden', [], [A, B, C]],
    ['one hidden', [B], [A, C]],
    ['the primary field is never hidden', [A, B, C], [A]],
  ])('%s', (_label, hidden, expected) => {
    const columns = visibleColumns(fields, hidden);
    expect(columns.map((column) => column.field.id)).toEqual(expected);
  });

  it.each<[number, number, number]>([
    [1, 3, 1],
    [3, 3, 3],
    [5, 2, 2],
    [0, 3, 1],
    [1, 0, 0],
  ])('frozen %i of %i visible → %i', (frozen, visible, expected) => {
    expect(frozenCount({ frozen }, visible)).toBe(expected);
  });

  it('maps row heights to the two grid densities and back', () => {
    expect(densityOf('short')).toBe('compact');
    expect(densityOf('medium')).toBe('comfortable');
    expect(densityOf('extra_tall')).toBe('comfortable');
    expect(rowHeightOf('compact')).toBe('short');
    expect(rowHeightOf('comfortable')).toBe('medium');
  });
});
