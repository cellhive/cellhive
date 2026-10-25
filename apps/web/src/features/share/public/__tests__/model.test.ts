import { describe, expect, it } from 'vitest';

import { toGridField, type GridField } from '../../../../grid';
import { boardColumns, columnKeyOf, NO_VALUE, placeCards } from '../board';
import { sharedColumns } from '../fields';
import { shareRowModel } from '../group-rows';
import { initialChoices, shareRecordQuery } from '../query';

import type { FieldDto, RecordDto, ShareMeta } from '@cellhive/contracts';

const NOW = '2026-09-25T00:00:00.000Z';

function field(
  id: string,
  type: FieldDto['type'],
  options: Record<string, unknown> = {},
  primary = false,
): FieldDto {
  return {
    id: id as FieldDto['id'],
    table_id: 'tbl_Orders0000000001',
    name: id.slice(4),
    type,
    options,
    is_primary: primary,
    required: false,
    unique_values: false,
    description: null,
    position: 0,
    created_at: NOW,
    updated_at: NOW,
  };
}

function record(id: string, fields: Record<string, unknown>): RecordDto {
  return { id: id as RecordDto['id'], created_at: NOW, updated_at: NOW, version: 1, fields };
}

function meta(overrides: Partial<ShareMeta['settings']> = {}, config: object = {}): ShareMeta {
  return {
    target_type: 'view',
    table: {
      id: 'tbl_Orders0000000001',
      name: 'Orders',
      primary_field_id: 'fld_Name000000000001',
    },
    view: {
      id: 'viw_Sales00000000001',
      name: 'Sales',
      type: 'grid',
      config: {
        sort: [{ field: 'fld_Amount0000000001', direction: 'desc' }],
        group: [],
        hidden_fields: [],
        field_order: [],
        column_widths: {},
        frozen_count: 1,
        row_height: 'short',
        tree: { enabled: false, show_ancestors: false },
        ...config,
      },
    },
    fields: [
      {
        id: 'fld_Name000000000001',
        name: 'Name',
        type: 'text',
        options: {},
        is_primary: true,
        description: null,
      },
      {
        id: 'fld_Amount0000000001',
        name: 'Amount',
        type: 'number',
        options: {},
        is_primary: false,
        description: null,
      },
      {
        id: 'fld_Note000000000001',
        name: 'Note',
        type: 'text',
        options: {},
        is_primary: false,
        description: null,
      },
    ],
    settings: {
      allow_copy: false,
      allow_download: false,
      allow_export: false,
      allow_search: true,
      allow_viewer_filter_sort: true,
      show_record_detail: true,
      ...overrides,
    },
    download_fields: [],
    expires_at: null,
    csrf_token: null,
  };
}

describe('shareRowModel', () => {
  const status = toGridField(field('fld_Status', 'select'));
  const owner = toGridField(field('fld_Owner', 'text'));

  it('puts a header before each group and maps display rows to data rows', () => {
    const model = shareRowModel(
      [status],
      [
        { values: ['New'], count: 2 },
        { values: [null], count: 1 },
      ],
      3,
    );
    expect(model.displayCount).toBe(5);
    expect(model.dataCount).toBe(3);
    const kinds = Array.from({ length: 5 }, (_, row) => model.rowAt(row));
    expect(
      kinds.map((kind) =>
        kind.kind === 'group'
          ? `h:${String(kind.group.count)}`
          : kind.kind === 'data'
            ? kind.row
            : '?',
      ),
    ).toEqual(['h:2', 0, 1, 'h:1', 2]);
    expect([0, 1, 2].map((row) => model.displayOf(row))).toEqual([1, 2, 4]);
    expect(model.dataAtOrAfter(0)).toBe(0);
    expect(model.dataAtOrAfter(3)).toBe(2);
    expect(model.dataAtOrBefore(3)).toBe(1);
    expect(model.dataAtOrBefore(0)).toBeUndefined();
  });

  it('opens nested headers only where a level changes; counts sum the levels below', () => {
    const model = shareRowModel(
      [status, owner],
      [
        { values: ['New', 'A'], count: 2 },
        { values: ['New', 'B'], count: 1 },
        { values: ['Done', 'A'], count: 4 },
      ],
      7,
    );
    const headers = Array.from({ length: model.displayCount }, (_, row) =>
      model.rowAt(row),
    ).flatMap((kind) =>
      kind.kind === 'group' ? [[kind.group.level, kind.group.value, kind.group.count]] : [],
    );
    expect(headers).toEqual([
      [0, 'New', 3],
      [1, 'A', 2],
      [1, 'B', 1],
      [0, 'Done', 4],
      [1, 'A', 4],
    ]);
    expect(model.displayCount).toBe(12);
    // Every data row maps back to itself.
    for (let row = 0; row < 7; row += 1) {
      const kind = model.rowAt(model.displayOf(row));
      expect(kind).toMatchObject({ kind: 'data', row });
    }
  });

  it('leaves rows past the counted groups without a header; no levels = plain rows', () => {
    const model = shareRowModel([status], [{ values: ['New'], count: 1 }], 3);
    expect(model.rowAt(3)).toMatchObject({ kind: 'data', row: 2, number: 3 });
    const plain = shareRowModel([], [], 4);
    expect(plain.displayCount).toBe(4);
    expect(plain.rowAt(2)).toMatchObject({ kind: 'data', row: 2 });
  });

  it('cards (canvas grid, T320a): spacers around the cards, numbers restart per group', () => {
    const model = shareRowModel(
      [status, owner],
      [
        { values: ['New', 'A'], count: 2 },
        { values: ['New', 'B'], count: 1 },
        { values: ['Done', 'A'], count: 1 },
      ],
      4,
      { cards: true },
    );
    const labels = Array.from({ length: model.displayCount }, (_, row) => {
      const kind = model.rowAt(row);
      if (kind.kind === 'group') return `H${String(kind.group.level)}`;
      if (kind.kind === 'gap') return `_${String(kind.frame.depth)}${kind.frame.bottom ? 'b' : ''}`;
      if (kind.kind === 'data') return `${String(kind.row)}#${String(kind.number)}`;
      return '+';
    });
    expect(labels).toEqual([
      '_0',
      'H0',
      'H1',
      '0#1',
      '1#2',
      '_1',
      'H1',
      '2#1',
      '_1b',
      '_0',
      'H0',
      'H1',
      '3#1',
      '_1b',
      '_0',
    ]);
    expect([0, 1, 2, 3].map((row) => model.displayOf(row))).toEqual([3, 4, 7, 12]);
    expect(model.dataAtOrAfter(5)).toBe(2);
    expect(model.dataAtOrBefore(5)).toBe(1);
    expect(model.gapDepth(8)).toBe(1);
    expect(model.gapDepth(7)).toBe(-1);
    expect(model.pathAt(7).map((group) => group.value)).toEqual(['New', 'B']);
    expect(model.rowAt(4).frame.bottom).toBe(true);
  });
});

describe('board', () => {
  const select: GridField = toGridField(
    field('fld_Status', 'select', {
      multiple: false,
      options: [
        { id: 'opt_New0000000000001', name: 'New', color: 1 },
        { id: 'opt_Done000000000001', name: 'Done', color: 2 },
      ],
    }),
  );
  const user: GridField = toGridField(field('fld_Owner', 'user', { multiple: false }));

  it('keys cards by option name or user id; unknown options have no value', () => {
    expect(columnKeyOf(select, 'New')).toBe('New');
    expect(columnKeyOf(select, 'Gone')).toBe(NO_VALUE);
    expect(columnKeyOf(select, null)).toBe(NO_VALUE);
    expect(columnKeyOf(user, [{ id: 'usr_1', name: 'A' }])).toBe('usr_1');
    expect(columnKeyOf(user, [])).toBe(NO_VALUE);
  });

  it('lists "no value" then the options with their counts; hides empty ones on request', () => {
    const placed = placeCards(select, [record('rec_1', { fld_Status: 'Done' })]);
    const counts = [
      { values: [null], count: 0 },
      { values: ['Done'], count: 5 },
    ];
    expect(boardColumns(select, counts, false, placed).map((c) => [c.key, c.count])).toEqual([
      [NO_VALUE, 0],
      ['New', 0],
      ['Done', 5],
    ]);
    expect(boardColumns(select, counts, true, placed).map((c) => c.key)).toEqual(['Done']);
    expect(boardColumns(select, undefined, false, placed).map((c) => c.count)).toEqual([
      null,
      null,
      null,
    ]);
  });

  it('gives people columns from the counts and from loaded cards', () => {
    const placed = placeCards(user, [record('rec_1', { fld_Owner: [{ id: 'usr_2', name: 'B' }] })]);
    const columns = boardColumns(
      user,
      [{ values: [[{ id: 'usr_1', name: 'A' }]], count: 3 }],
      false,
      placed,
    );
    expect(columns.map((c) => [c.key, c.count])).toEqual([
      [NO_VALUE, 0],
      ['usr_1', 3],
      ['usr_2', 0],
    ]);
  });
});

describe('shareRecordQuery', () => {
  it('sends only what differs from the view, as the link allows', () => {
    const shared = meta();
    expect(shareRecordQuery(shared, initialChoices(shared))).toEqual({});
    const filter = { op: 'and', items: [] };
    expect(
      shareRecordQuery(shared, {
        filter,
        sort: [{ field: 'fld_Amount0000000001', direction: 'asc' }],
        search: '  r1 ',
      }),
    ).toEqual({
      filter,
      sort: [{ field: 'fld_Amount0000000001', direction: 'asc' }],
      sort_mode: 'replace',
      search: 'r1',
    });
  });

  it('never sends a viewer filter, sort or search the link does not allow (else 403)', () => {
    const closed = meta({ allow_viewer_filter_sort: false, allow_search: false });
    expect(
      shareRecordQuery(closed, {
        filter: { op: 'and', items: [] },
        sort: [],
        search: 'x',
      }),
    ).toEqual({});
  });
});

describe('sharedColumns', () => {
  it('puts the primary field first, follows field_order and drops hidden fields', () => {
    const shared = meta(
      {},
      {
        field_order: ['fld_Note000000000001', 'fld_Amount0000000001'],
        hidden_fields: ['fld_Amount0000000001'],
      },
    );
    expect(sharedColumns(shared).map((column) => column.field.name)).toEqual(['Name', 'Note']);
  });
});
