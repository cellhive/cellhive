import { describe, expect, it } from 'vitest';

import {
  buildColumns,
  columnCondition,
  columnKeyOf,
  countsByColumn,
  defaultCardFields,
  EMPTY_COLUMN,
  groupKindOf,
  kanbanSettingsOf,
  mergeUsers,
  placeCards,
  shiftCount,
  userColumn,
  usersOfGroups,
} from '../board';

import type { FieldDto, RecordDto } from '@cellhive/contracts';

const NOW = '2026-09-24T00:00:00.000Z';
const TABLE = 'tbl_Tickets000000001';

function field(overrides: Partial<FieldDto> & Pick<FieldDto, 'id' | 'type'>): FieldDto {
  return {
    table_id: TABLE,
    name: overrides.id,
    options: {},
    is_primary: false,
    required: false,
    unique_values: false,
    description: null,
    position: 1,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

const STATUS = field({
  id: 'fld_Status0000000001',
  type: 'select',
  name: 'Status',
  options: {
    multiple: false,
    options: [
      { id: 'opt_New0000000000001', name: 'New', color: 1 },
      { id: 'opt_Doing00000000001', name: 'Doing' },
      { id: 'opt_Done000000000001', name: 'Done', color: 3 },
    ],
  },
});
const TAGS = field({
  id: 'fld_Tags000000000001',
  type: 'select',
  options: { multiple: true, options: [] },
});
const OWNER = field({ id: 'fld_Owner00000000001', type: 'user', options: { multiple: false } });
const OWNERS = field({ id: 'fld_Owners0000000001', type: 'user', options: {} });
const TITLE = field({ id: 'fld_Title00000000001', type: 'text', is_primary: true });

const NEW = 'opt_New0000000000001';
const DOING = 'opt_Doing00000000001';
const DONE = 'opt_Done000000000001';

function record(id: string, status: string | null, version = 1): RecordDto {
  return {
    id: id as RecordDto['id'],
    created_at: NOW,
    updated_at: NOW,
    version,
    fields: { [STATUS.id]: status },
  };
}

const statusOf = (item: RecordDto) => columnKeyOf(STATUS, 'select', item.fields[STATUS.id]);

describe('groupKindOf', () => {
  it.each([
    ['single select', STATUS, 'select'],
    ['multiple select', TAGS, null],
    ['single user', OWNER, 'user'],
    ['user field (multiple by default)', OWNERS, null],
    ['text', TITLE, null],
    ['no field', undefined, null],
  ] as const)('%s', (_name, input, kind) => {
    expect(groupKindOf(input)).toBe(kind);
  });
});

describe('columnKeyOf', () => {
  it.each([
    ['option name', 'Doing', DOING],
    ['option id', DONE, DONE],
    ['empty', null, EMPTY_COLUMN],
    ['empty string', '', EMPTY_COLUMN],
    ['removed option', 'Archived', EMPTY_COLUMN],
  ])('select: %s', (_name, value, key) => {
    expect(columnKeyOf(STATUS, 'select', value)).toBe(key);
  });

  it.each([
    ['user list', [{ id: 'usr_A000000000000001', name: 'An' }], 'usr_A000000000000001'],
    ['former member', [{ id: 'usr_B000000000000001' }], 'usr_B000000000000001'],
    ['empty list', [], EMPTY_COLUMN],
    ['null', null, EMPTY_COLUMN],
  ])('user: %s', (_name, value, key) => {
    expect(columnKeyOf(OWNER, 'user', value)).toBe(key);
  });
});

describe('buildColumns', () => {
  it('lists "Uncategorized" then the options in order, with their colours', () => {
    const columns = buildColumns(STATUS, 'select');
    expect(columns.map((column) => [column.key, column.name, column.color])).toEqual([
      [EMPTY_COLUMN, null, null],
      [NEW, 'New', 1],
      [DOING, 'Doing', 1],
      [DONE, 'Done', 3],
    ]);
    expect(columns[2]).toMatchObject({ writeValue: DOING, display: 'Doing' });
    expect(columns[0]).toMatchObject({ writeValue: null, display: null });
  });

  it('lists the members of a user board', () => {
    const columns = buildColumns(OWNER, 'user', [
      { id: 'usr_A000000000000001', name: 'An', email: 'an@x.vn' },
    ]);
    expect(columns.map((column) => column.key)).toEqual([EMPTY_COLUMN, 'usr_A000000000000001']);
    expect(columns[1]).toMatchObject({
      writeValue: [{ id: 'usr_A000000000000001' }],
      display: [{ id: 'usr_A000000000000001', name: 'An', email: 'an@x.vn' }],
    });
    expect(userColumn({ id: 'usr_B000000000000001' })).toMatchObject({
      name: null,
      display: [{ id: 'usr_B000000000000001' }],
    });
  });
});

describe('columnCondition', () => {
  it.each([
    ['select option', 'select', DOING, { field: STATUS.id, operator: 'is', value: DOING }],
    ['select empty', 'select', EMPTY_COLUMN, { field: STATUS.id, operator: 'is_empty' }],
    [
      'user',
      'user',
      'usr_A000000000000001',
      { field: STATUS.id, operator: 'has_any_of', value: ['usr_A000000000000001'] },
    ],
    ['user empty', 'user', EMPTY_COLUMN, { field: STATUS.id, operator: 'is_empty' }],
  ] as const)('%s', (_name, kind, column, condition) => {
    expect(columnCondition(STATUS.id, kind, column)).toEqual(condition);
  });
});

describe('counts', () => {
  it('adds up values of one column (empty and removed options)', () => {
    const counts = countsByColumn(STATUS, 'select', [
      { values: ['New'], count: 2 },
      { values: ['Archived'], count: 1 },
      { values: [null], count: 4 },
    ]);
    expect([...counts]).toEqual([
      [NEW, 2],
      [EMPTY_COLUMN, 5],
    ]);
  });

  it('moves a count between columns and adds a group for a column without one', () => {
    const data = {
      groups: [
        { values: ['New'], count: 2 },
        { values: [null], count: 1 },
      ],
      truncated: false,
    };
    const doing = buildColumns(STATUS, 'select')[2];
    if (doing === undefined) throw new Error('no column');
    expect(shiftCount(data, STATUS, 'select', { from: NEW, to: doing })).toEqual({
      groups: [
        { values: ['New'], count: 1 },
        { values: [null], count: 1 },
        { values: ['Doing'], count: 1 },
      ],
      truncated: false,
    });
    // A new record only adds.
    const empty = buildColumns(STATUS, 'select')[0];
    if (empty === undefined) throw new Error('no column');
    expect(shiftCount(data, STATUS, 'select', { from: null, to: empty }).groups).toEqual([
      { values: ['New'], count: 2 },
      { values: [null], count: 2 },
    ]);
  });

  it('keeps the members of a user board, learning names later', () => {
    const users = usersOfGroups([
      { values: [[{ id: 'usr_A000000000000001' }]] },
      { values: [null] },
      { values: [[{ id: 'usr_B000000000000001', name: 'Bình' }]] },
    ]);
    expect(users.map((user) => user.id)).toEqual(['usr_A000000000000001', 'usr_B000000000000001']);
    const merged = mergeUsers(users, [
      { id: 'usr_A000000000000001', name: 'An' },
      { id: 'usr_C000000000000001', name: 'Chi' },
    ]);
    expect(merged.map((user) => [user.id, user.name])).toEqual([
      ['usr_A000000000000001', 'An'],
      ['usr_B000000000000001', 'Bình'],
      ['usr_C000000000000001', 'Chi'],
    ]);
  });
});

describe('placeCards', () => {
  const columns = buildColumns(STATUS, 'select');
  const ids = (cards: Map<string, RecordDto[]>) =>
    Object.fromEntries([...cards].map(([key, list]) => [key, list.map((item) => item.id)]));

  it('shows each loaded card in its column, in server order', () => {
    const cards = placeCards(
      columns,
      new Map([
        [NEW, [record('rec_1', 'New'), record('rec_2', 'New')]],
        [DONE, [record('rec_3', 'Done')]],
      ]),
      [],
      statusOf,
    );
    expect(ids(cards)).toEqual({
      [EMPTY_COLUMN]: [],
      [NEW]: ['rec_1', 'rec_2'],
      [DOING]: [],
      [DONE]: ['rec_3'],
    });
  });

  it('moves a card whose newest copy changed column to the top of its new column', () => {
    const cards = placeCards(
      columns,
      new Map([
        [NEW, [record('rec_1', 'Doing', 2), record('rec_2', 'New')]],
        [DOING, [record('rec_4', 'Doing')]],
      ]),
      [],
      statusOf,
    );
    expect(ids(cards)).toMatchObject({ [NEW]: ['rec_2'], [DOING]: ['rec_1', 'rec_4'] });
  });

  it('puts arrivals first unless their column pages hold them, newest copy wins', () => {
    const cards = placeCards(
      columns,
      new Map([
        [NEW, [record('rec_1', 'New')]],
        [DOING, [record('rec_4', 'Doing'), record('rec_5', 'Doing')]],
      ]),
      [record('rec_9', 'Doing'), record('rec_5', 'Doing', 3), record('rec_1', 'Done', 2)],
      statusOf,
    );
    expect(ids(cards)).toEqual({
      [EMPTY_COLUMN]: [],
      [NEW]: [],
      [DOING]: ['rec_9', 'rec_4', 'rec_5'],
      [DONE]: ['rec_1'],
    });
    expect(cards.get(DOING)?.[2]?.version).toBe(3);
  });

  it('shows a record once even when loaded in two columns, in the newest column', () => {
    const cards = placeCards(
      columns,
      new Map([
        [NEW, [record('rec_1', 'New', 1)]],
        [DOING, [record('rec_1', 'Doing', 2)]],
      ]),
      [],
      statusOf,
    );
    expect(ids(cards)).toMatchObject({ [NEW]: [], [DOING]: ['rec_1'] });
  });

  it('fills missing board settings with their defaults', () => {
    expect(kanbanSettingsOf({ group_field: STATUS.id })).toEqual({
      group_field: STATUS.id,
      card_fields: [],
      cover_field: null,
      hide_empty_columns: false,
    });
    expect(kanbanSettingsOf(undefined).group_field).toBeNull();
  });
});

describe('defaultCardFields', () => {
  const candidate = (id: string, primary = false) => ({ field: { id, is_primary: primary } });
  it('takes the first three fields but the primary and the group field', () => {
    expect(
      defaultCardFields(
        [
          candidate('fld_title', true),
          candidate('fld_status'),
          candidate('fld_a'),
          candidate('fld_b'),
          candidate('fld_c'),
          candidate('fld_d'),
        ],
        'fld_status',
      ),
    ).toEqual(['fld_a', 'fld_b', 'fld_c']);
  });

  it('takes what there is on a small table', () => {
    expect(defaultCardFields([candidate('fld_status'), candidate('fld_a')], 'fld_status')).toEqual([
      'fld_a',
    ]);
  });
});
