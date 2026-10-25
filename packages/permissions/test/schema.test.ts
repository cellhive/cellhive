import { newId } from '@cellhive/contracts';
import { describe, expect, it } from 'vitest';

import {
  collectFieldIds,
  filterNodeSchema,
  maxTablePerm,
  orFilters,
  roleConfigSchema,
  systemRoleConfig,
  type FilterNode,
} from '../src/index.js';

import { buildFixture } from './fixture.js';

const fx = buildFixture();
const a = newId('fld');
const b = newId('fld');
const c = newId('fld');

describe('roleConfigSchema', () => {
  it('parses the CONTRACTS §5 Sales role (ID-keyed) and fills defaults', () => {
    const parsed = roleConfigSchema.parse(fx.salesConfigInput);
    expect(parsed.tables[fx.tbl.orders]?.record_rule.edit_filter).toEqual(fx.ownerIsCurrentUser);
  });

  it('applies deny-by-default values to an empty config', () => {
    expect(roleConfigSchema.parse({})).toEqual({
      base_rule: { copy: false, download: false, share_link: false },
      tables: {},
      dashboards: {},
    });
    expect(
      roleConfigSchema.parse({ tables: { [fx.tbl.orders]: { perm: 'no_perm' } } }).tables[
        fx.tbl.orders
      ],
    ).toEqual({
      perm: 'no_perm',
      view_rule: { allow_edit: false, visible_views: null },
      record_rule: { operations: [], edit_filter: null, read_scope: 'all', read_filter: null },
      field_rule: {
        mode: 'all_edit',
        fields: {},
        option_edit_fields: [],
        file_download_fields: [],
      },
    });
  });

  const invalid: { name: string; config: unknown }[] = [
    { name: 'table keyed by name', config: { tables: { Orders: { perm: 'edit' } } } },
    { name: 'unknown table perm', config: { tables: { [fx.tbl.orders]: { perm: 'owner' } } } },
    { name: 'unknown top-level key', config: { roles: {} } },
    {
      name: 'unknown key in table rule',
      config: { tables: { [fx.tbl.orders]: { perm: 'edit', extra: 1 } } },
    },
    {
      name: 'field keyed by name',
      config: {
        tables: { [fx.tbl.orders]: { perm: 'edit', field_rule: { fields: { cost: 'read' } } } },
      },
    },
    {
      name: 'read_scope filter without read_filter',
      config: {
        tables: { [fx.tbl.orders]: { perm: 'edit', record_rule: { read_scope: 'filter' } } },
      },
    },
    {
      name: 'unknown operation',
      config: {
        tables: { [fx.tbl.orders]: { perm: 'edit', record_rule: { operations: ['update'] } } },
      },
    },
    { name: 'dashboard edit perm', config: { dashboards: { [newId('dsh')]: 'edit' } } },
    {
      name: 'filter with a field name',
      config: {
        tables: {
          [fx.tbl.orders]: {
            perm: 'edit',
            record_rule: { edit_filter: { field: 'owner', operator: 'is' } },
          },
        },
      },
    },
  ];

  it.each(invalid)('rejects $name', ({ config }) => {
    expect(roleConfigSchema.safeParse(config).success).toBe(false);
  });
});

describe('filterNodeSchema and helpers', () => {
  const nested: FilterNode = {
    op: 'and',
    items: [
      { field: a, operator: 'is', value: 'x' },
      {
        op: 'not',
        item: {
          op: 'or',
          items: [
            { field: b, operator: 'is_empty' },
            { field: a, operator: 'eq', value: 1 },
          ],
        },
      },
      { field: c, operator: 'has_any_of', value: [{ $var: 'current_user_groups' }] },
    ],
  };

  it('accepts nested and/or/not trees', () => {
    expect(filterNodeSchema.parse(nested)).toEqual(nested);
  });

  it.each([
    { name: 'unknown group op', node: { op: 'xor', items: [] } },
    { name: 'not without item', node: { op: 'not', items: [] } },
    { name: 'empty operator', node: { field: a, operator: '' } },
    { name: 'extra key', node: { field: a, operator: 'is', foo: 1 } },
    // Since T104 the schema comes from @cellhive/filter-dsl and is stricter.
    { name: 'unknown operator', node: { field: a, operator: 'like', value: 'x' } },
    {
      name: 'unknown variable',
      node: { field: a, operator: 'has_any_of', value: [{ $var: 'me' }] },
    },
    {
      name: 'nesting deeper than 5 groups',
      node: [1, 2, 3, 4, 5, 6].reduce<unknown>((item) => ({ op: 'and', items: [item] }), {
        field: a,
        operator: 'is_empty',
      }),
    },
  ])('rejects $name', ({ node }) => {
    expect(filterNodeSchema.safeParse(node).success).toBe(false);
  });

  it.each([
    { name: 'nested tree', filter: nested, expected: [a, b, c] },
    {
      name: 'single condition',
      filter: { field: b, operator: 'is_empty' } as FilterNode,
      expected: [b],
    },
    { name: 'null', filter: null, expected: [] },
    { name: 'undefined', filter: undefined, expected: [] },
  ])('collectFieldIds: $name', ({ filter, expected }) => {
    expect(collectFieldIds(filter)).toEqual(expected);
  });

  it('orFilters: null wins, duplicates collapse, several filters become an or group', () => {
    const x: FilterNode = { field: a, operator: 'is_empty' };
    const y: FilterNode = { field: b, operator: 'is_empty' };
    expect(orFilters([x, null])).toBeNull();
    expect(orFilters([x, { ...x }])).toEqual(x);
    expect(orFilters([x, y])).toEqual({ op: 'or', items: [x, y] });
  });
});

describe('system role presets', () => {
  const dashboard = newId('dsh');
  const schema = { ...fx.schema, dashboards: [dashboard] };

  it.each([
    {
      preset: 'admin',
      perm: 'manage',
      operations: ['add', 'delete'],
      mode: 'all_edit',
      download: true,
      share: true,
      options: [fx.fld.status],
    },
    {
      preset: 'editor',
      perm: 'edit',
      operations: ['add', 'delete'],
      mode: 'all_edit',
      download: true,
      share: true,
      options: [],
    },
    {
      preset: 'reader',
      perm: 'read_only',
      operations: [],
      mode: 'all_read',
      download: true,
      share: false,
      options: [],
    },
    {
      preset: 'system_reader',
      perm: 'read_only',
      operations: [],
      mode: 'all_read',
      download: true,
      share: false,
      options: [],
    },
  ] as const)('$preset', ({ preset, perm, operations, mode, download, share, options }) => {
    const config = systemRoleConfig(preset, schema);
    expect(roleConfigSchema.parse(config)).toEqual(config);
    expect(Object.keys(config.tables).sort()).toEqual([fx.tbl.orders, fx.tbl.customers].sort());
    const table = config.tables[fx.tbl.orders];
    expect(table?.perm).toBe(perm);
    expect(table?.record_rule.operations).toEqual(operations);
    expect(table?.field_rule.mode).toBe(mode);
    expect(table?.field_rule.option_edit_fields).toEqual(options);
    expect(config.base_rule.download).toBe(download);
    expect(config.base_rule.share_link).toBe(share);
    expect(config.dashboards).toEqual({ [dashboard]: 'read_only' });
  });

  it('reader preset never edits, adds or deletes', () => {
    const config = systemRoleConfig('reader', schema);
    for (const table of Object.values(config.tables)) {
      expect(maxTablePerm(table.perm, 'read_only')).toBe('read_only');
      expect(table.record_rule.operations).toEqual([]);
      expect(table.view_rule.allow_edit).toBe(false);
    }
  });
});
