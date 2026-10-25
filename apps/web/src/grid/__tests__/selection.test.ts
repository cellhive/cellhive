import { CompactSelection } from '@glideapps/glide-data-grid';
import { describe, expect, it } from 'vitest';

import { primaryRange, selectionRanges } from '../GridView';
import { toGridField } from '../types';

import type { GridRowKind, GridRowModel } from '../rows';
import type { FieldDto } from '@cellhive/contracts';

const NOW = '2026-09-24T00:00:00.000Z';

function field(id: string): FieldDto {
  return {
    id: id as FieldDto['id'],
    table_id: 'tbl_Tickets000000001',
    name: id,
    type: 'text',
    options: {},
    is_primary: false,
    required: false,
    unique_values: false,
    description: null,
    position: 0,
    created_at: NOW,
    updated_at: NOW,
  };
}

const FIELDS = ['fld_A000000000000001', 'fld_B000000000000001', 'fld_C000000000000001'].map((id) =>
  toGridField(field(id)),
);

describe('selectionRanges', () => {
  it('lists whole selected rows (row markers) and cell ranges in field ids', () => {
    const rows = CompactSelection.empty().add([2, 5]).add(9);
    const ranges = selectionRanges(
      {
        columns: CompactSelection.empty(),
        rows,
        current: {
          cell: [1, 12],
          range: { x: 1, y: 12, width: 2, height: 3 },
          rangeStack: [],
        },
      },
      FIELDS,
    );
    const all = FIELDS.map((item) => item.field.id);
    expect(ranges).toEqual([
      { firstRow: 2, lastRow: 4, fieldIds: all, wholeRows: true },
      { firstRow: 9, lastRow: 9, fieldIds: all, wholeRows: true },
      { firstRow: 12, lastRow: 14, fieldIds: all.slice(1) },
    ]);
  });

  describe('with group headers, "+" rows and spacers (T312, T320a)', () => {
    // Display rows: 0 spacer, 1 header, 2–3 data 0–1, 4 "+", 5 spacer, 6 header (collapsed),
    // 7 spacer, 8 header, 9–10 data 2–3, 11 "+", 12 spacer.
    const kinds = new Map<number, 'gap' | 'group' | 'add'>([
      [0, 'gap'],
      [1, 'group'],
      [4, 'add'],
      [5, 'gap'],
      [6, 'group'],
      [7, 'gap'],
      [8, 'group'],
      [11, 'add'],
      [12, 'gap'],
    ]);
    const toData = new Map([
      [2, 0],
      [3, 1],
      [9, 2],
      [10, 3],
    ]);
    const frame = { depth: 1, top: false, bottom: false };
    const group = {
      key: 'g',
      level: 0,
      field: undefined,
      value: null,
      count: 1,
      collapsed: false,
      rest: false,
      nested: false,
    };
    const model: GridRowModel = {
      displayCount: 13,
      dataCount: 4,
      depth: 1,
      rowAt: (display): GridRowKind => {
        const kind = kinds.get(display);
        if (kind === 'gap') return { kind, frame };
        if (kind !== undefined) return { kind, group, frame };
        const row = toData.get(display) ?? 0;
        return { kind: 'data', row, number: row + 1, frame };
      },
      gapDepth: (display) => (kinds.get(display) === 'gap' ? 0 : -1),
      displayOf: (row) => [...toData].find(([, data]) => data === row)?.[0] ?? 13,
      dataAtOrAfter: (display) => [...toData].find(([at]) => at >= display)?.[1],
      dataAtOrBefore: (display) => [...toData].reverse().find(([at]) => at <= display)?.[1],
      pathAt: () => [],
      headerDisplay: () => undefined,
    };
    const select = (y: number, height: number, rows = CompactSelection.empty()) =>
      selectionRanges(
        {
          columns: CompactSelection.empty(),
          rows,
          current: { cell: [0, y], range: { x: 0, y, width: 1, height }, rangeStack: [] },
        },
        FIELDS,
        model,
      );

    it('a range across a "+" row, spacers and headers covers the data rows only', () => {
      expect(select(3, 7)).toEqual([{ firstRow: 1, lastRow: 2, fieldIds: [FIELDS[0]?.field.id] }]);
    });

    it('headers, "+" rows and spacers only: no range', () => {
      expect(select(4, 5)).toEqual([]);
      expect(select(11, 2)).toEqual([]);
    });

    it('selected header, "+" and spacer rows are no rows', () => {
      const all = FIELDS.map((item) => item.field.id);
      expect(select(2, 1, CompactSelection.empty().add(1).add([9, 12]))).toEqual([
        { firstRow: 2, lastRow: 3, fieldIds: all, wholeRows: true },
        { firstRow: 0, lastRow: 0, fieldIds: [FIELDS[0]?.field.id] },
      ]);
    });

    it('the paste / fill range starts at the first data row', () => {
      expect(
        primaryRange(
          {
            columns: CompactSelection.empty(),
            rows: CompactSelection.empty(),
            current: { cell: [0, 3], range: { x: 0, y: 3, width: 1, height: 7 }, rangeStack: [] },
          },
          FIELDS,
          model,
        ),
      ).toEqual({ firstRow: 1, lastRow: 2, fieldIds: [FIELDS[0]?.field.id] });
    });
  });

  it('is empty without a selection', () => {
    expect(
      selectionRanges(
        { columns: CompactSelection.empty(), rows: CompactSelection.empty() },
        FIELDS,
      ),
    ).toEqual([]);
  });
});
