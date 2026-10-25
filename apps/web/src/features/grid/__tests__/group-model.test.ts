import { describe, expect, it } from 'vitest';

import { RECORD_BLOCK_SIZE } from '../../../lib/query/queries';
import {
  collapseAll,
  isCollapsed,
  parseCollapse,
  serializeCollapse,
  setGroupsCollapsed,
  toggleGroup,
} from '../groups/collapse';
import { groupKey, GroupRowModel, REST_GROUP_KEY, type GroupCount } from '../groups/group-model';

import type { GridField } from '../../../grid';

const STATUS = 'fld_Status0000000001';
const OWNER = 'fld_Owner00000000001';

const field = (id: string, name: string): GridField => ({
  field: {
    id,
    table_id: 'tbl_Tickets000000001',
    name,
    type: 'text',
    options: {},
    is_primary: false,
    required: false,
    unique_values: false,
    description: null,
    position: 1,
    created_at: '2026-09-24T00:00:00.000Z',
    updated_at: '2026-09-24T00:00:00.000Z',
    deleted_at: null,
  } as unknown as GridField['field'],
  config: null,
});
const FIELDS = new Map([
  [STATUS, field(STATUS, 'Status')],
  [OWNER, field(OWNER, 'Owner')],
]);

function model(
  groups: GroupCount[],
  levels: string[] = [STATUS],
  collapsed: string[] = [],
  extra: { truncated?: boolean; total?: number; addRows?: boolean } = {},
) {
  return new GroupRowModel({
    levels: levels.map((fieldId) => ({ fieldId, direction: 'asc' })),
    groups,
    fields: FIELDS,
    isCollapsed: (key) => collapsed.includes(key),
    ...extra,
  });
}

/**
 * Display rows as short labels: `H0:value(count)` for headers (`+` when
 * collapsed), `r<data>@<offset>` for rows, `+<level>:value` for "+" rows,
 * `_<depth>` for spacers (`b` when it is the bottom of its card).
 */
function layout(rows: GroupRowModel): string[] {
  return Array.from({ length: rows.displayCount }, (_, display) => {
    const kind = rows.rowAt(display);
    switch (kind.kind) {
      case 'group': {
        const { level, value, count, collapsed } = kind.group;
        return `H${String(level)}:${String(value)}(${String(count)})${collapsed ? '+' : ''}`;
      }
      case 'add':
        return `+${String(kind.group.level)}:${String(kind.group.value)}`;
      case 'gap':
        return `_${String(kind.frame.depth)}${kind.frame.bottom ? 'b' : ''}`;
      case 'data':
        return `r${String(kind.row)}@${String(rows.offsetOf(kind.row))}`;
    }
  });
}

const TWO_LEVELS: GroupCount[] = [
  { values: ['New', 'An'], count: 2 },
  { values: ['New', null], count: 1 },
  { values: ['Done', 'An'], count: 1 },
];

describe('GroupRowModel: cards', () => {
  it.each([
    {
      name: 'one level, with an empty group last: a spacer before, between and after the cards',
      groups: [
        { values: ['New'], count: 2 },
        { values: ['Done'], count: 1 },
        { values: [null], count: 1 },
      ],
      levels: [STATUS],
      expected: [
        '_0',
        'H0:New(2)',
        'r0@0',
        'r1@1',
        '_0',
        'H0:Done(1)',
        'r2@2',
        '_0',
        'H0:null(1)',
        'r3@3',
        '_0',
      ],
    },
    {
      name: 'empty values ("" and []) count as empty',
      groups: [
        { values: [''], count: 1 },
        { values: [[]], count: 1 },
      ],
      levels: [STATUS],
      // Both are the empty group: the server never returns two, but contiguous ones merge.
      expected: ['_0', 'H0:null(2)', 'r0@0', 'r1@1', '_0'],
    },
    {
      name: 'two levels: nested cards with spacers between them and padding under the last',
      groups: TWO_LEVELS,
      levels: [STATUS, OWNER],
      expected: [
        '_0',
        'H0:New(3)',
        'H1:An(2)',
        'r0@0',
        'r1@1',
        '_1',
        'H1:null(1)',
        'r2@2',
        '_1b',
        '_0',
        'H0:Done(1)',
        'H1:An(1)',
        'r3@3',
        '_1b',
        '_0',
      ],
    },
    {
      name: 'groups without rows are left out; no group, no rows at all',
      groups: [
        { values: ['New'], count: 0 },
        { values: ['Done'], count: 1 },
      ],
      levels: [STATUS],
      expected: ['_0', 'H0:Done(1)', 'r0@0', '_0'],
    },
    {
      name: 'nothing counted',
      groups: [],
      levels: [STATUS],
      expected: [],
    },
  ])('$name', ({ groups, levels, expected }) => {
    expect(layout(model(groups, levels))).toEqual(expected);
  });

  it('a "+" row ends every expanded innermost group (not the outer cards)', () => {
    expect(layout(model(TWO_LEVELS, [STATUS, OWNER], [], { addRows: true }))).toEqual([
      '_0',
      'H0:New(3)',
      'H1:An(2)',
      'r0@0',
      'r1@1',
      '+1:An',
      '_1',
      'H1:null(1)',
      'r2@2',
      '+1:null',
      '_1b',
      '_0',
      'H0:Done(1)',
      'H1:An(1)',
      'r3@3',
      '+1:An',
      '_1b',
      '_0',
    ]);
  });

  it('frames: cards around each row, their top (header) and bottom rows', () => {
    const rows = model(TWO_LEVELS, [STATUS, OWNER], [], { addRows: true });
    const frames = Array.from({ length: 12 }, (_, display) => {
      const { depth, top, bottom } = rows.rowAt(display).frame;
      return `${String(depth)}${top ? 't' : ''}${bottom ? 'b' : ''}`;
    });
    expect(frames).toEqual(['0', '1t', '2t', '2', '2', '2b', '1', '2t', '2', '2b', '1b', '0']);
    // Without "+" rows the last data row closes the card; a collapsed header is a whole card.
    const plain = model(TWO_LEVELS, [STATUS, OWNER], [groupKey([STATUS, OWNER], ['New', null])]);
    expect(plain.rowAt(4).frame).toEqual({ depth: 2, top: false, bottom: true });
    expect(plain.rowAt(6).frame).toEqual({ depth: 2, top: true, bottom: true });
  });

  it('row numbers restart at 1 in every group', () => {
    const rows = model(TWO_LEVELS, [STATUS, OWNER], [], { addRows: true });
    const numbers = [3, 4, 8, 14].map((display) => {
      const kind = rows.rowAt(display);
      return kind.kind === 'data' ? kind.number : null;
    });
    expect(numbers).toEqual([1, 2, 1, 1]);
  });

  it('spacer depths (row heights) without allocating, in order or not', () => {
    const rows = model(TWO_LEVELS, [STATUS, OWNER], [], { addRows: true });
    const expected = [0, -1, -1, -1, -1, -1, 1, -1, -1, -1, 1, 0];
    expect(expected.map((_, display) => rows.gapDepth(display))).toEqual(expected);
    // Random order (the cursor is only a shortcut).
    for (const display of [10, 0, 6, 11, 1, 6, 3, 10]) {
      expect(rows.gapDepth(display)).toBe(expected[display]);
    }
    expect(layout(rows)).toEqual(layout(model(TWO_LEVELS, [STATUS, OWNER], [], { addRows: true })));
  });

  it('the group path of a row, outermost first', () => {
    const rows = model(TWO_LEVELS, [STATUS, OWNER], [], { addRows: true });
    const keys = (display: number) => rows.pathAt(display).map((header) => String(header.value));
    expect(keys(0)).toEqual([]);
    expect(keys(1)).toEqual(['New']);
    expect(keys(2)).toEqual(['New', 'An']);
    expect(keys(4)).toEqual(['New', 'An']);
    expect(keys(5)).toEqual(['New', 'An']);
    expect(keys(6)).toEqual(['New']);
    expect(keys(8)).toEqual(['New', 'null']);
    expect(rows.headerDisplay(groupKey([STATUS, OWNER], ['New', null]))).toBe(7);
    expect(rows.addAt(5)?.value).toBe('An');
    expect(rows.addAt(4)).toBeUndefined();
  });

  it('nested groups of a group, collapsed or not; top-level group count', () => {
    const newKey = groupKey([STATUS], ['New']);
    const rows = model(TWO_LEVELS, [STATUS, OWNER], [newKey]);
    expect(rows.descendants(newKey)).toEqual([
      groupKey([STATUS, OWNER], ['New', 'An']),
      groupKey([STATUS, OWNER], ['New', null]),
    ]);
    expect(rows.header(newKey)?.nested).toBe(true);
    expect(rows.header(groupKey([STATUS, OWNER], ['New', 'An']))?.nested).toBe(false);
    expect(rows.groupCount).toBe(2);
    expect(rows.depth).toBe(2);
  });

  it('a truncated count ends with the rest group of the rows not counted (no "+" row)', () => {
    const rows = model([{ values: ['New'], count: 2 }], [STATUS], [], {
      truncated: true,
      total: 5,
      addRows: true,
    });
    expect(layout(rows)).toEqual([
      '_0',
      'H0:New(2)',
      'r0@0',
      'r1@1',
      '+0:New',
      '_0',
      'H0:null(3)',
      'r2@2',
      'r3@3',
      'r4@4',
      '_0',
    ]);
    expect(rows.headerAt(6)?.rest).toBe(true);
    expect(rows.headerAt(6)?.key).toBe(REST_GROUP_KEY);
    expect(rows.rowAt(9).frame.bottom).toBe(true);
    expect(rows.total).toBe(5);
  });

  it('header keys carry field ids and values; values of the levels above are kept', () => {
    const rows = model([{ values: ['New', 'An'], count: 1 }], [STATUS, OWNER]);
    const inner = rows.headerAt(2);
    expect(inner?.key).toBe(groupKey([STATUS, OWNER], ['New', 'An']));
    expect(inner?.values).toEqual(['New', 'An']);
    expect(inner?.fieldIds).toEqual([STATUS, OWNER]);
    expect(inner?.field?.field.name).toBe('Owner');
    expect(groupKey([STATUS], [''])).toBe(groupKey([STATUS], [null]));
    expect(groupKey([STATUS], ['New'])).not.toBe(groupKey([OWNER], ['New']));
  });
});

describe('GroupRowModel: rows ↔ offsets with collapsed groups', () => {
  const groups: GroupCount[] = [
    { values: ['A'], count: 3 },
    { values: ['B'], count: 500 },
    { values: ['C'], count: 2 },
  ];
  const b = groupKey([STATUS], ['B']);
  const rows = model(groups, [STATUS], [b], { addRows: true });

  it('a collapsed group shows its header only; its rows are no data rows', () => {
    expect(layout(rows)).toEqual([
      '_0',
      'H0:A(3)',
      'r0@0',
      'r1@1',
      'r2@2',
      '+0:A',
      '_0',
      'H0:B(500)+',
      '_0',
      'H0:C(2)',
      'r3@503',
      'r4@504',
      '+0:C',
      '_0',
    ]);
    expect(rows.dataCount).toBe(5);
    expect(rows.displayCount).toBe(14);
  });

  it.each([
    { data: 0, display: 2, offset: 0, number: 1 },
    { data: 2, display: 4, offset: 2, number: 3 },
    { data: 3, display: 10, offset: 503, number: 1 },
    { data: 4, display: 11, offset: 504, number: 2 },
  ])('data row $data ↔ display $display ↔ offset $offset', ({ data, display, offset, number }) => {
    expect(rows.displayOf(data)).toBe(display);
    expect(rows.offsetOf(data)).toBe(offset);
    expect(rows.dataRowOf(offset)).toBe(data);
    expect(rows.rowAt(display)).toMatchObject({ kind: 'data', row: data, number });
  });

  it('an offset inside a collapsed group has no data row', () => {
    expect(rows.dataRowOf(3)).toBeUndefined();
    expect(rows.dataRowOf(502)).toBeUndefined();
    expect(rows.dataRowOf(505)).toBeUndefined();
  });

  it.each([
    { display: 0, after: 0, before: undefined, what: 'the first spacer' },
    { display: 1, after: 0, before: undefined, what: 'the first header' },
    { display: 5, after: 3, before: 2, what: 'a "+" row' },
    { display: 6, after: 3, before: 2, what: 'a spacer' },
    { display: 7, after: 3, before: 2, what: 'a collapsed header' },
    { display: 12, after: undefined, before: 4, what: 'the last "+" row' },
    { display: 99, after: undefined, before: 4, what: 'past the end' },
  ])('$what (display $display) is skipped: next $after, previous $before', (row) => {
    expect(rows.dataAtOrAfter(row.display)).toBe(row.after);
    expect(rows.dataAtOrBefore(row.display)).toBe(row.before);
  });

  it('server ranges of data rows skip the collapsed group (never fetched)', () => {
    expect(rows.offsetRanges(0, 4)).toEqual([
      { firstRow: 0, lastRow: 2 },
      { firstRow: 503, lastRow: 504 },
    ]);
    expect(rows.offsetRanges(-10, 1)).toEqual([{ firstRow: 0, lastRow: 1 }]);
    expect(rows.offsetRanges(3, 100)).toEqual([{ firstRow: 503, lastRow: 504 }]);
    expect(rows.offsetRanges(3, 2)).toEqual([]);
  });

  it('with a header at a block boundary, rows keep their server offset', () => {
    // Group A ends exactly at the end of block 0: B's header sits between two blocks.
    const boundary = model([
      { values: ['A'], count: RECORD_BLOCK_SIZE },
      { values: ['B'], count: 10 },
    ]);
    // Spacer, A's header, A's rows, spacer, B's header.
    const bHeader = RECORD_BLOCK_SIZE + 3;
    expect(boundary.headerAt(bHeader)?.value).toBe('B');
    expect(boundary.rowAt(bHeader + 1)).toMatchObject({ kind: 'data', row: RECORD_BLOCK_SIZE });
    expect(boundary.offsetOf(RECORD_BLOCK_SIZE)).toBe(RECORD_BLOCK_SIZE);
    expect(boundary.offsetRanges(RECORD_BLOCK_SIZE - 1, RECORD_BLOCK_SIZE)).toEqual([
      { firstRow: RECORD_BLOCK_SIZE - 1, lastRow: RECORD_BLOCK_SIZE },
    ]);
  });

  it('the group of a data row is its innermost header (values pre-filled on add)', () => {
    const nested = model(
      [
        { values: ['New', 'An'], count: 1 },
        { values: ['New', 'Bình'], count: 1 },
      ],
      [STATUS, OWNER],
    );
    expect(nested.groupOf(1)?.values).toEqual(['New', 'Bình']);
  });

  it('collapsing an outer level hides the nested cards too', () => {
    const nested = model(
      [
        { values: ['New', 'An'], count: 2 },
        { values: ['Done', 'An'], count: 1 },
      ],
      [STATUS, OWNER],
      [groupKey([STATUS], ['New'])],
    );
    expect(layout(nested)).toEqual([
      '_0',
      'H0:New(2)+',
      '_0',
      'H0:Done(1)',
      'H1:An(1)',
      'r0@2',
      '_1b',
      '_0',
    ]);
  });
});

describe('collapse state', () => {
  it('toggles against the mode; collapse all makes every group collapsed', () => {
    let state = parseCollapse(null);
    expect(isCollapsed(state, 'a')).toBe(false);
    state = toggleGroup(state, 'a');
    expect(isCollapsed(state, 'a')).toBe(true);
    state = collapseAll();
    expect(isCollapsed(state, 'b')).toBe(true);
    state = toggleGroup(state, 'b');
    expect(isCollapsed(state, 'b')).toBe(false);
    expect(parseCollapse(serializeCollapse(state))).toEqual(state);
  });

  it('sets several groups at once (collapse / expand the subgroups of a group)', () => {
    let state = parseCollapse(null);
    state = setGroupsCollapsed(state, ['a', 'b'], true);
    expect(['a', 'b', 'c'].map((key) => isCollapsed(state, key))).toEqual([true, true, false]);
    state = setGroupsCollapsed(state, ['a', 'c'], false);
    expect(['a', 'b', 'c'].map((key) => isCollapsed(state, key))).toEqual([false, true, false]);
    // Nothing to change: the same state.
    expect(setGroupsCollapsed(state, ['b'], true)).toBe(state);
  });

  it.each(['not json', '{"mode":1,"except":"x"}', '[]'])(
    'an invalid stored state %j is all expanded',
    (raw) => {
      expect(parseCollapse(raw)).toEqual({ mode: 'expanded', except: [] });
    },
  );
});
