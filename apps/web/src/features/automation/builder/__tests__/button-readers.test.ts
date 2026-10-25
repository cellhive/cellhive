import { describe, expect, it } from 'vitest';

import { fieldsHiddenFromReaders, filterFieldIds, type RoleLike } from '../model/button-readers';

describe('filterFieldIds (fields of enabled_when)', () => {
  it.each([
    [null, []],
    [{}, []],
    [
      {
        op: 'and',
        items: [
          { field: 'fld_Status0000000001', operator: 'is', value: 'opt_New' },
          { field: 'fld_Cost00000000001', operator: 'gt', value: 0 },
          { field: 'fld_Status0000000001', operator: 'is_not_empty' },
        ],
      },
      ['fld_Status0000000001', 'fld_Cost00000000001'],
    ],
    [['fld_Amount0000000001', 'gt', 3], ['fld_Amount0000000001']],
  ])('%j', (filter, ids) => {
    expect(filterFieldIds(filter)).toEqual(ids);
  });
});

describe('fieldsHiddenFromReaders (Câu hỏi mở S5 #5)', () => {
  const TABLE = 'tbl_Orders0000000001';
  const COST = 'fld_Cost00000000001';
  const STATUS = 'fld_Status0000000001';
  const role = (name: string, kind: string, rule: Record<string, unknown> | undefined) =>
    ({
      name,
      kind,
      config: rule === undefined ? { tables: {} } : { tables: { [TABLE]: rule } },
    }) satisfies RoleLike;
  it.each([
    ['system roles read every field', [role('Reader', 'system_reader', undefined)], []],
    [
      'a custom role without the table cannot read the record',
      [role('Out', 'custom', undefined)],
      [],
    ],
    ['a custom role with no_perm on the table', [role('Out', 'custom', { perm: 'no_perm' })], []],
    [
      'an override hides a field',
      [
        role('Sales', 'custom', {
          perm: 'read_only',
          field_rule: { mode: 'all_read', fields: { [COST]: 'no_perm' } },
        }),
      ],
      [[COST, ['Sales']]],
    ],
    [
      '`specify` hides unlisted fields',
      [
        role('Support', 'custom', {
          perm: 'edit',
          field_rule: { mode: 'specify', fields: { [STATUS]: 'read' } },
        }),
      ],
      [[COST, ['Support']]],
    ],
    ['default mode (all_edit) reads everything', [role('Edit', 'custom', { perm: 'edit' })], []],
  ])('%s', (_name, roles, expected) => {
    expect([...fieldsHiddenFromReaders(roles, TABLE, [STATUS, COST])]).toEqual(expected);
  });
});
