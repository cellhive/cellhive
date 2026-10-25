import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';

import {
  computedCellValue,
  computedReferences,
  isComputedLocked,
  strictComputedPermissionsOf,
  type ComputedCellData,
  type ComputedField,
} from '../../src/records/computed/read/index.js';

import type { BaseSchemaRows } from '../../src/computed/index.js';
import type { FieldRow } from '../../src/db/schema.js';
import type { ComputedResultType } from '@cellhive/field-types';
import type { FormulaAnalysis, FormulaDependency } from '@cellhive/formula-engine';

/**
 * Pure parts of computed reads (BACKLOG T457): the cells by result type
 * (CONTRACTS §2, S4b open question #4) and the lock rule (S4b #1a, SPEC
 * §9.5 `strict_computed_permissions`).
 */

const locale = { locale: 'vi', timeZone: 'Asia/Ho_Chi_Minh' };
const data: ComputedCellData = {
  users: new Map([
    ['usr_an00000000000000', { id: 'usr_an00000000000000', name: 'An', email: 'a@x.vn' }],
  ]),
  titles: new Map([['tbl_cust000000000000', new Map([['rec_c100000000000000', 'An Phát']])]]),
};

function field(publicType: ComputedResultType, extra: Partial<ComputedField> = {}): ComputedField {
  return {
    computed: true,
    id: 'fld_x000000000000000',
    name: 'x',
    type: 'formula',
    row: {} as FieldRow,
    resultType: null,
    publicType,
    style: null,
    readable: true,
    locked: false,
    recordTableId: publicType.kind === 'record' ? 'tbl_cust000000000000' : null,
    value: () => sql`NULL`,
    filterMeta: { id: 'fld_x000000000000000', name: 'x', type: 'formula' },
    sortKind: 'value',
    ...extra,
  };
}

describe('computedCellValue', () => {
  it.each([
    ['number', { kind: 'number', list: false }, 1500000, 1500000],
    ['number from text', { kind: 'number', list: false }, '0.1', 0.1],
    ['text', { kind: 'text', list: false }, 'abc', 'abc'],
    ['boolean', { kind: 'boolean', list: false }, false, false],
    ['date', { kind: 'date', list: false }, '2026-09-25', '2026-09-25'],
    [
      'datetime',
      { kind: 'datetime', list: false },
      '2026-09-25T02:00:00+00:00',
      '2026-09-25T02:00:00.000Z',
    ],
    ['empty list', { kind: 'text', list: true }, [], null],
    ['text list', { kind: 'text', list: true }, ['a', null, 'b'], ['a', 'b']],
    [
      'user',
      { kind: 'user', list: true },
      ['usr_an00000000000000', 'usr_gone000000000000'],
      [{ id: 'usr_an00000000000000', name: 'An', email: 'a@x.vn' }, { id: 'usr_gone000000000000' }],
    ],
    [
      'record (P20: unknown title → null)',
      { kind: 'record', list: true },
      ['rec_c100000000000000', 'rec_c200000000000000'],
      [
        { id: 'rec_c100000000000000', title: 'An Phát' },
        { id: 'rec_c200000000000000', title: null },
      ],
    ],
    [
      'attachment',
      { kind: 'attachment', list: true },
      [{ id: 'att_a000000000000000', name: 'a.png', size: 10, mime: 'image/png' }],
      [
        {
          id: 'att_a000000000000000',
          name: 'a.png',
          size: 10,
          mime: 'image/png',
          thumbnail_url: '/api/v1/files/att_a000000000000000/thumbnail',
        },
      ],
    ],
    ['null', { kind: 'number', list: false }, null, null],
  ] as const)('%s', (_name, type, raw, expected) => {
    expect(computedCellValue(field(type), raw, data, 'json', locale, 'member')).toEqual(expected);
  });

  it('locked fields read null whatever the value', () => {
    const locked = field({ kind: 'number', list: false }, { locked: true });
    expect(computedCellValue(locked, 5, data, 'json', locale, 'member')).toBeNull();
    expect(computedCellValue(locked, 5, data, 'text', locale, 'member')).toBe('');
  });

  it('attachments never go through a share link (S4b #4)', () => {
    const files = field({ kind: 'attachment', list: true });
    const raw = [{ id: 'att_a000000000000000', name: 'a.png', size: 10, mime: 'image/png' }];
    expect(computedCellValue(files, raw, data, 'json', locale, 'share_link')).toBeNull();
  });

  it('cell_format=text follows the style: 1.500.000 ₫', () => {
    const money = field(
      { kind: 'number', list: false },
      { style: { type: 'currency', currency_code: 'VND', precision: 0 } as never },
    );
    expect(computedCellValue(money, 1500000, data, 'text', locale, 'member')).toMatch(
      /^1\.500\.000\s₫$/u,
    );
    const records = field({ kind: 'record', list: true });
    expect(
      computedCellValue(records, ['rec_c100000000000000'], data, 'text', locale, 'member'),
    ).toBe('An Phát');
  });
});

describe('lock rule', () => {
  const t1 = 'tbl_orders0000000000';
  const t2 = 'tbl_cust000000000000';
  const row = (id: string, tableId: string, type = 'number'): FieldRow =>
    ({ id, table_id: tableId, type, deleted_at: null }) as unknown as FieldRow;
  const amount = row('fld_amount0000000000', t1);
  const cost = row('fld_cost000000000000', t1);
  const phone = row('fld_phone00000000000', t2, 'text');
  const link = row('fld_link000000000000', t1, 'link');
  const same = row('fld_same000000000000', t1, 'formula');
  const cross = row('fld_cross00000000000', t1, 'lookup');
  const nested = row('fld_nested0000000000', t1, 'formula');
  const rows: BaseSchemaRows = {
    baseId: 'bse_b000000000000000',
    tables: [],
    fields: [amount, cost, phone, link, same, cross, nested],
  };
  const dep = (field_id: string, kind: FormulaDependency['kind']): FormulaDependency => ({
    field_id,
    kind,
    link_path: [],
    condition_refs: [],
  });
  const analyses = new Map<string, Pick<FormulaAnalysis, 'dependencies' | 'referenced_tables'>>([
    [
      same.id,
      {
        dependencies: [dep(amount.id, 'same_row'), dep(cost.id, 'same_row')],
        referenced_tables: [],
      },
    ],
    [
      cross.id,
      {
        dependencies: [dep(link.id, 'same_row'), dep(phone.id, 'via_link')],
        referenced_tables: [t2],
      },
    ],
    [nested.id, { dependencies: [dep(same.id, 'same_row')], referenced_tables: [] }],
  ]);
  const analysisOf = (f: FieldRow) => (analyses.get(f.id) ?? null) as FormulaAnalysis | null;
  const reader = (tables: string[], hidden: string[]) => ({
    table: (id: string) => tables.includes(id),
    field: (tableId: string, id: string) => tables.includes(tableId) && !hidden.includes(id),
  });

  it('follows computed fields read by a formula', () => {
    const refs = computedReferences(nested, rows, analysisOf);
    expect([...refs.sameRowFields].sort()).toEqual([amount.id, cost.id, same.id].sort());
    expect(refs.crossFields.size).toBe(0);
  });

  it.each([
    ['cross-table, source table readable', cross, [t1, t2], [], false, false],
    ['cross-table, source table unreadable (P34)', cross, [t1], [], false, true],
    ['cross-table, source field no_perm', cross, [t1, t2], [phone.id], false, true],
    ['same table, no_perm field (Lark: shown)', same, [t1], [cost.id], false, false],
    ['same table, no_perm field, strict (P36)', same, [t1], [cost.id], true, true],
    ['nested same-row formula, strict', nested, [t1], [cost.id], true, true],
    ['same table, readable fields, strict', same, [t1], [], true, false],
  ] as const)('%s', (_name, target, tables, hidden, strict, locked) => {
    const refs = computedReferences(target, rows, analysisOf);
    expect(isComputedLocked(refs, rows, reader([...tables], [...hidden]) as never, strict)).toBe(
      locked,
    );
  });

  it('reads the base setting', () => {
    expect(strictComputedPermissionsOf({ strict_computed_permissions: true })).toBe(true);
    expect(strictComputedPermissionsOf({ strict_computed_permissions: 'yes' })).toBe(false);
    expect(strictComputedPermissionsOf(null)).toBe(false);
  });
});
