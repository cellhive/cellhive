import { describe, expect, it } from 'vitest';

import {
  analyzeAppend,
  appendRequest,
  autoMapping,
  canAppendTo,
  canImportNewTable,
  canStartAppend,
  importTargets,
  initialNewColumns,
  isLinkRowCode,
  linkErrorCounts,
  newTableRequest,
  titleColumns,
  unsupportedFields,
  validateNewTable,
  type NewColumnDraft,
} from '../mapping';

import type { EffectiveAccess, FieldDto, ImportColumn, ImportPreview } from '@cellhive/contracts';

const TABLE = 'tbl_Orders0000000001';
const NOW = '2026-09-24T00:00:00.000Z';

function field(id: `fld_${string}`, overrides: Partial<FieldDto> = {}): FieldDto {
  return {
    id,
    table_id: TABLE,
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
    ...overrides,
  };
}

const TITLE = field('fld_Title00000000001', { name: 'Tên', is_primary: true });
const AMOUNT = field('fld_Amount0000000001', { name: 'Số tiền', type: 'number' });
const STATUS = field('fld_Status0000000001', { name: 'Trạng thái', type: 'select' });
const CODE = field('fld_Code000000000001', { name: 'Mã', type: 'auto_number' });
const CREATED = field('fld_Created000000001', { name: 'Ngày tạo', type: 'created_at' });
const OWNER = field('fld_Owner00000000001', { name: 'Phụ trách', type: 'user', required: true });
const FIELDS = [TITLE, AMOUNT, STATUS, CODE, CREATED, OWNER];

function access(kind: 'admin' | 'sales' | 'reader'): EffectiveAccess {
  return {
    role: null,
    is_admin: kind === 'admin',
    base_rule: { copy: true, download: true, share_link: false },
    tables:
      kind === 'admin'
        ? {}
        : {
            [TABLE]: {
              perm: kind === 'reader' ? 'read_only' : 'edit',
              operations: kind === 'reader' ? [] : ['add'],
              view_rule: { allow_edit: false, visible_views: null },
              read_scope: 'all',
              fields: {
                [TITLE.id]: 'edit',
                [AMOUNT.id]: 'create',
                [STATUS.id]: 'read',
                [CODE.id]: 'read',
                [CREATED.id]: 'read',
                [OWNER.id]: 'edit',
              },
              option_edit_fields: [],
              file_download_fields: [],
            },
          },
    dashboards: {},
  } as unknown as EffectiveAccess;
}

function column(
  index: number,
  name: string,
  type: ImportColumn['type'] = 'text',
  options = {},
): ImportColumn {
  return { index, name, type, options };
}

describe('import permissions', () => {
  it.each([
    ['admin', true, true],
    ['sales', false, true],
    ['reader', false, false],
  ] as const)('%s: new table %s, append %s', (kind, create, append) => {
    expect(canImportNewTable(access(kind))).toBe(create);
    expect(canAppendTo(access(kind), TABLE, FIELDS)).toBe(append);
  });

  it('offers only fields writable on create, never computed or system ones', () => {
    expect(importTargets(access('admin'), TABLE, FIELDS).map((item) => item.name)).toEqual([
      'Tên',
      'Số tiền',
      'Trạng thái',
      'Phụ trách',
    ]);
    // `create` counts (the import creates records); `read` does not.
    expect(importTargets(access('sales'), TABLE, FIELDS).map((item) => item.name)).toEqual([
      'Tên',
      'Số tiền',
      'Phụ trách',
    ]);
    expect(importTargets(undefined, TABLE, FIELDS)).toEqual([]);
  });
});

describe('new table columns', () => {
  const preview = {
    columns: [
      column(0, 'Số', 'number', { style: { type: 'plain' } }),
      column(1, 'Tên'),
      column(2, 'Trạng thái', 'select', { options: [{ id: 'opt_x', name: 'Mới' }] }),
      column(3, 'Ngày', 'datetime', { style: { format: 'dd/MM/yyyy' } }),
    ],
  } as unknown as ImportPreview;

  it('starts from the guesses, every column imported', () => {
    expect(initialNewColumns(preview)).toEqual([
      { column: 0, include: true, name: 'Số', type: 'number' },
      { column: 1, include: true, name: 'Tên', type: 'text' },
      { column: 2, include: true, name: 'Trạng thái', type: 'select' },
      { column: 3, include: true, name: 'Ngày', type: 'datetime' },
    ]);
  });

  it('makes the first imported column the text primary field and keeps guessed options', () => {
    const drafts: NewColumnDraft[] = initialNewColumns(preview).map((draft) =>
      draft.column === 3 ? { ...draft, type: 'text' } : draft,
    );
    expect(
      newTableRequest('imp_0123456789ABCDEF', ' Khách hàng ', drafts, preview.columns),
    ).toEqual({
      upload_id: 'imp_0123456789ABCDEF',
      mode: 'create_table',
      table: {
        name: 'Khách hàng',
        columns: [
          // Guessed number, but the primary field is text: no number options.
          { column: 0, name: 'Số', type: 'text' },
          { column: 1, name: 'Tên', type: 'text' },
          { column: 2, name: 'Trạng thái', type: 'select', options: preview.columns[2]?.options },
          // Changed from the guess: no guessed options.
          { column: 3, name: 'Ngày', type: 'text' },
        ],
      },
    });
    const skipFirst = drafts.map((draft) =>
      draft.column === 0 ? { ...draft, include: false } : draft,
    );
    const request = newTableRequest('imp_0123456789ABCDEF', 'T', skipFirst, preview.columns);
    expect(
      request.mode === 'create_table' && request.table.columns.map((item) => item.column),
    ).toEqual([1, 2, 3]);
  });

  it.each([
    ['', [], 'required'],
    ['  ', [], 'required'],
    ['orders', ['Orders'], 'taken'],
    ['Khách hàng', ['Orders'], undefined],
  ] as const)('table name %j among %j → %s', (name, existing, issue) => {
    expect(validateNewTable(name, initialNewColumns(preview), existing).tableName).toBe(issue);
  });

  it('flags empty and duplicate field names among imported columns only', () => {
    const drafts: NewColumnDraft[] = [
      { column: 0, include: true, name: 'Tên', type: 'text' },
      { column: 1, include: true, name: ' tên ', type: 'text' },
      { column: 2, include: true, name: '', type: 'text' },
      { column: 3, include: false, name: 'Tên', type: 'text' },
    ];
    const issues = validateNewTable('T', drafts, []);
    expect([...issues.columns]).toEqual([
      [1, 'nameDuplicate'],
      [2, 'nameRequired'],
    ]);
    expect(
      validateNewTable(
        'T',
        drafts.map((draft) => ({ ...draft, include: false })),
        [],
      ).noColumns,
    ).toBe(true);
  });
});

describe('append mapping', () => {
  const columns = [
    column(0, 'tên'),
    column(1, 'Số tiền', 'number'),
    column(2, 'Mã'),
    column(3, 'Ghi chú'),
    column(4, 'Trạng thái'),
  ];

  it('maps columns to writable fields of the same name, ignoring case', () => {
    const targets = importTargets(access('sales'), TABLE, FIELDS);
    expect([...autoMapping(columns, targets)]).toEqual([
      [0, TITLE.id],
      [1, AMOUNT.id],
      [2, null],
      [3, null],
      [4, null],
    ]);
  });

  it('explains every column left out and blocks on required fields and duplicates', () => {
    const targets = importTargets(access('sales'), TABLE, FIELDS);
    const mapping = autoMapping(columns, targets);
    const analysis = analyzeAppend(columns, mapping, targets, FIELDS);
    expect([...analysis.statuses]).toEqual([
      [0, { kind: 'mapped', fieldId: TITLE.id }],
      [1, { kind: 'mapped', fieldId: AMOUNT.id }],
      [2, { kind: 'readOnly', fieldName: 'Mã' }],
      [3, { kind: 'noMatch' }],
      [4, { kind: 'readOnly', fieldName: 'Trạng thái' }],
    ]);
    expect(analysis.missingRequired.map((item) => item.name)).toEqual(['Phụ trách']);
    expect(canStartAppend(analysis)).toBe(false);

    const withOwner = new Map(mapping).set(3, OWNER.id);
    const ready = analyzeAppend(columns, withOwner, targets, FIELDS);
    expect(ready.missingRequired).toEqual([]);
    expect(canStartAppend(ready)).toBe(true);
    expect(appendRequest('imp_0123456789ABCDEF', TABLE, withOwner)).toEqual({
      upload_id: 'imp_0123456789ABCDEF',
      mode: 'append',
      table_id: TABLE,
      mapping: [
        { column: 0, field_id: TITLE.id },
        { column: 1, field_id: AMOUNT.id },
        { column: 3, field_id: OWNER.id },
      ],
    });

    const twice = new Map(withOwner).set(4, AMOUNT.id);
    const duplicate = analyzeAppend(columns, twice, targets, FIELDS);
    expect([...duplicate.duplicates]).toEqual([AMOUNT.id]);
    expect(canStartAppend(duplicate)).toBe(false);

    const skipped = new Map(withOwner).set(0, null);
    expect(analyzeAppend(columns, skipped, targets, FIELDS).statuses.get(0)).toEqual({
      kind: 'skipped',
    });
  });

  it('does not require a field that has a default value', () => {
    const owner = { ...OWNER, options: { default_value: 'current_user' } };
    const fields = [TITLE, owner];
    const analysis = analyzeAppend([column(0, 'Tên')], new Map([[0, TITLE.id]]), fields, fields);
    expect(analysis.missingRequired).toEqual([]);
  });

  it('needs at least one mapped column', () => {
    const targets = importTargets(access('admin'), TABLE, FIELDS);
    const analysis = analyzeAppend(columns, new Map(), targets, [TITLE]);
    expect(analysis.mappedCount).toBe(0);
    expect(canStartAppend(analysis)).toBe(false);
  });
});

describe('formula and lookup fields (T462)', () => {
  const TOTAL = field('fld_Total00000000001', { name: 'Tổng', type: 'formula' });
  const PHONE = field('fld_Phone00000000001', { name: 'SĐT khách', type: 'lookup' });
  const COMPUTED = [TITLE, TOTAL, PHONE];

  it('never offers them, and says why a column of that name is not imported', () => {
    const targets = importTargets(access('admin'), TABLE, COMPUTED);
    expect(targets.map((item) => item.name)).toEqual(['Tên']);
    const columns = [column(0, 'Tên'), column(1, 'tổng'), column(2, 'SĐT khách')];
    const analysis = analyzeAppend(columns, autoMapping(columns, targets), targets, COMPUTED);
    expect([...analysis.statuses]).toEqual([
      [0, { kind: 'mapped', fieldId: TITLE.id }],
      [1, { kind: 'computed', fieldName: 'Tổng' }],
      [2, { kind: 'computed', fieldName: 'SĐT khách' }],
    ]);
    expect(canStartAppend(analysis)).toBe(true);
  });
});

describe('link, parent and attachment fields (T411)', () => {
  const LINK = field('fld_Link000000000001', { name: 'Khách hàng', type: 'link' });
  const PARENT = field('fld_Parent0000000001', { name: 'Cha', type: 'parent' });
  const FILES = field('fld_Files00000000001', { name: 'Tệp', type: 'attachment' });
  const RELATIONS = [TITLE, LINK, PARENT, FILES];

  function withPerms(perm: 'edit' | 'read'): EffectiveAccess {
    const base = access('sales');
    const table = base.tables[TABLE];
    if (table === undefined) throw new Error('no table');
    return {
      ...base,
      tables: {
        [TABLE]: {
          ...table,
          fields: { [TITLE.id]: 'edit', [LINK.id]: perm, [PARENT.id]: perm, [FILES.id]: 'edit' },
        },
      },
    };
  }

  it('offers link and parent fields the caller writes, never attachment fields', () => {
    expect(importTargets(access('admin'), TABLE, RELATIONS).map((item) => item.name)).toEqual([
      'Tên',
      'Khách hàng',
      'Cha',
    ]);
    expect(importTargets(withPerms('edit'), TABLE, RELATIONS).map((item) => item.name)).toEqual([
      'Tên',
      'Khách hàng',
      'Cha',
    ]);
    expect(importTargets(withPerms('read'), TABLE, RELATIONS).map((item) => item.name)).toEqual([
      'Tên',
    ]);
  });

  it('maps link columns by name and flags attachment columns as unsupported', () => {
    const targets = importTargets(access('admin'), TABLE, RELATIONS);
    const columns = [column(0, 'Tên'), column(1, 'khách hàng'), column(2, 'Tệp')];
    const mapping = autoMapping(columns, targets);
    expect([...mapping]).toEqual([
      [0, TITLE.id],
      [1, LINK.id],
      [2, null],
    ]);
    const analysis = analyzeAppend(columns, mapping, targets, RELATIONS);
    expect(analysis.statuses.get(1)).toEqual({ kind: 'mapped', fieldId: LINK.id });
    expect(analysis.statuses.get(2)).toEqual({ kind: 'unsupported', fieldName: 'Tệp' });
    expect(canStartAppend(analysis)).toBe(true);
  });

  it('lists the columns filled by titles with the table they name (T419)', () => {
    const linked = field('fld_Link000000000002', {
      name: 'Sản phẩm',
      type: 'link',
      options: { link_table: 'tbl_Products00000001' },
    });
    const fields = new Map([...RELATIONS, linked].map((item) => [item.id, item]));
    const columns = [column(0, 'Tên'), column(1, 'Sản phẩm'), column(2, 'Cha'), column(3, 'Tệp')];
    const mapping = new Map<number, string | null>([
      [0, TITLE.id],
      [1, linked.id],
      [2, PARENT.id],
      [3, null],
    ]);
    expect(
      titleColumns(columns, mapping, fields, TABLE).map((item) => [
        item.column.name,
        item.field.name,
        item.tableId,
      ]),
    ).toEqual([
      ['Sản phẩm', 'Sản phẩm', 'tbl_Products00000001'],
      ['Cha', 'Cha', TABLE],
    ]);
    expect(unsupportedFields(RELATIONS).map((item) => item.name)).toEqual(['Tệp']);
  });

  it('counts unmatched titles among the listed row errors (T419)', () => {
    expect(
      linkErrorCounts([
        { code: 'LINK_TARGET_NOT_FOUND' },
        { code: 'LINK_TARGET_AMBIGUOUS' },
        { code: 'LINK_TARGET_NOT_FOUND' },
        { code: 'EXPECTED_NUMBER' },
      ]),
    ).toEqual({ notFound: 2, ambiguous: 1 });
    expect(isLinkRowCode('LINK_TARGET_AMBIGUOUS')).toBe(true);
    expect(isLinkRowCode('TOO_MANY_VALUES')).toBe(false);
  });
});
