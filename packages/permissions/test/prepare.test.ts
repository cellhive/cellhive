import { newId, ROLE_ADJUSTMENT_REASONS } from '@cellhive/contracts';
import { describe, expect, it } from 'vitest';

import {
  ADJUSTMENT_REASONS,
  isViewVisible,
  prepareRoleConfig,
  type RoleSchemaMeta,
} from '../src/index.js';

const tbl = { orders: newId('tbl'), customers: newId('tbl') };
const fld = {
  title: newId('fld'),
  amount: newId('fld'),
  status: newId('fld'),
  owner: newId('fld'),
  number: newId('fld'),
  name: newId('fld'),
  customer: newId('fld'),
};
const opt = { new: newId('opt'), done: newId('opt') };
const viw = { orders: newId('viw'), customers: newId('viw') };

const schema: RoleSchemaMeta = {
  tables: [
    {
      id: tbl.orders,
      fields: [
        { id: fld.title, name: 'title', type: 'text' },
        { id: fld.amount, name: 'amount', type: 'number' },
        {
          id: fld.status,
          name: 'status',
          type: 'select',
          options: {
            multiple: false,
            options: [
              { id: opt.new, name: 'Mới' },
              { id: opt.done, name: 'Xong' },
            ],
          },
        },
        { id: fld.owner, name: 'owner', type: 'user' },
        { id: fld.number, name: 'number', type: 'auto_number' },
        { id: fld.customer, name: 'customer', type: 'link', options: { link_table: newId('tbl') } },
      ],
      views: [viw.orders],
    },
    {
      id: tbl.customers,
      fields: [{ id: fld.name, name: 'name', type: 'text' }],
      views: [viw.customers],
    },
  ],
  dashboards: [],
};

const ownerIsMe = {
  op: 'and',
  items: [{ field: fld.owner, operator: 'has_any_of', value: [{ $var: 'current_user' }] }],
};

describe('prepareRoleConfig', () => {
  it('defaults, normalises filters (option names → ids) and returns adjustments (P26/P27)', () => {
    const result = prepareRoleConfig(
      {
        tables: {
          [tbl.orders]: {
            perm: 'edit',
            record_rule: {
              operations: ['add'],
              edit_filter: {
                op: 'and',
                items: [...ownerIsMe.items, { field: fld.status, operator: 'is', value: 'Xong' }],
              },
              read_scope: 'editable',
            },
            field_rule: {
              mode: 'specify',
              fields: { [fld.status]: 'no_perm', [fld.number]: 'edit' },
            },
          },
        },
      },
      schema,
      { kind: 'custom' },
    );
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    const rule = result.config.tables[tbl.orders];
    expect(rule?.record_rule.edit_filter).toEqual({
      op: 'and',
      items: [
        { field: fld.owner, operator: 'has_any_of', value: [{ $var: 'current_user' }] },
        { field: fld.status, operator: 'is', value: opt.done },
      ],
    });
    expect(rule?.field_rule.fields).toEqual({ [fld.status]: 'create', [fld.number]: 'read' });
    expect(result.config.base_rule).toEqual({ copy: false, download: false, share_link: false });
    expect(result.adjustments).toEqual(
      expect.arrayContaining([
        {
          table_id: tbl.orders,
          field_id: fld.status,
          from: 'no_perm',
          to: 'create',
          reason: 'filter_field_min_create',
        },
        {
          table_id: tbl.orders,
          field_id: fld.number,
          from: 'edit',
          to: 'read',
          reason: 'computed_field_max_read',
        },
      ]),
    );
    expect(result.adjustments).toHaveLength(2);
  });

  // T710 (S6 decision #13): until S6 a link field in a record rule was refused
  // (`INVALID_FILTER` / `UNKNOWN_FIELD`, T402); it is now a filter field like the others.
  it('accepts record rules on link fields by record id (T710), with the field floor (P62)', () => {
    const rec = newId('rec');
    const result = prepareRoleConfig(
      {
        tables: {
          [tbl.orders]: {
            perm: 'edit',
            record_rule: {
              operations: ['add'],
              edit_filter: { field: fld.customer, operator: 'has_any_of', value: rec },
              read_scope: 'filter',
              read_filter: { field: fld.customer, operator: 'is_not_empty' },
            },
            field_rule: { mode: 'specify', fields: { [fld.customer]: 'no_perm' } },
          },
        },
      },
      schema,
      { kind: 'custom' },
    );
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    const rule = result.config.tables[tbl.orders]?.record_rule;
    expect(rule?.edit_filter).toEqual({
      field: fld.customer,
      operator: 'has_any_of',
      value: [rec],
    });
    expect(result.adjustments).toEqual([
      {
        table_id: tbl.orders,
        field_id: fld.customer,
        from: 'no_perm',
        to: 'create',
        reason: 'filter_field_min_create',
      },
    ]);
  });

  it.each([
    {
      name: 'text operator on a link',
      condition: { field: fld.customer, operator: 'contains', value: 'abc' },
      code: 'OPERATOR_NOT_ALLOWED',
    },
    {
      name: '$var on a link',
      condition: { field: fld.customer, operator: 'has_any_of', value: [{ $var: 'current_user' }] },
      code: 'INVALID_VALUE',
    },
    {
      name: 'a title instead of a record id',
      condition: { field: fld.customer, operator: 'has_any_of', value: ['An Phát'] },
      code: 'INVALID_VALUE',
    },
  ])('refuses $name in a record rule: INVALID_FILTER / $code (T710)', ({ condition, code }) => {
    const result = prepareRoleConfig(
      {
        tables: {
          [tbl.orders]: {
            perm: 'edit',
            record_rule: { read_scope: 'filter', read_filter: condition },
          },
        },
      },
      schema,
      { kind: 'custom' },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('filter');
    expect(result.issues.map((issue) => issue.code)).toEqual([code]);
  });

  it('applies system role ceilings', () => {
    const reader = prepareRoleConfig(
      { tables: { [tbl.orders]: { perm: 'manage', record_rule: { operations: ['add'] } } } },
      schema,
      { kind: 'system_reader' },
    );
    expect(reader.ok && reader.config.tables[tbl.orders]).toMatchObject({
      perm: 'read_only',
      record_rule: { operations: [] },
    });
    expect(reader.ok && reader.adjustments.map((item) => item.reason)).toEqual([
      'reader_ceiling',
      'operations_require_edit',
    ]);
    const editor = prepareRoleConfig({ tables: { [tbl.orders]: { perm: 'manage' } } }, schema, {
      kind: 'system_editor',
    });
    expect(editor.ok && editor.config.tables[tbl.orders]?.perm).toBe('edit');
  });

  const failures: {
    name: string;
    input: unknown;
    error: 'schema' | 'reference' | 'filter';
    issues: { path: string; code?: string }[];
  }[] = [
    {
      name: 'unknown key',
      input: { tables: {}, extra: true },
      error: 'schema',
      issues: [{ path: 'config' }],
    },
    {
      name: 'bad table perm',
      input: { tables: { [tbl.orders]: { perm: 'owner' } } },
      error: 'schema',
      issues: [{ path: `config.tables.${tbl.orders}.perm` }],
    },
    {
      name: 'table of another base',
      input: { tables: { [newId('tbl')]: { perm: 'read_only' } } },
      error: 'reference',
      issues: [{ code: 'UNKNOWN_TABLE', path: 'config.tables.' }],
    },
    {
      name: 'field of another table',
      input: {
        tables: {
          [tbl.orders]: {
            perm: 'edit',
            field_rule: { mode: 'specify', fields: { [fld.name]: 'read' } },
          },
        },
      },
      error: 'reference',
      issues: [
        {
          code: 'UNKNOWN_FIELD',
          path: `config.tables.${tbl.orders}.field_rule.fields.${fld.name}`,
        },
      ],
    },
    {
      name: 'option_edit_fields with an unknown field',
      input: {
        tables: {
          [tbl.orders]: { perm: 'edit', field_rule: { option_edit_fields: [newId('fld')] } },
        },
      },
      error: 'reference',
      issues: [
        {
          code: 'UNKNOWN_FIELD',
          path: `config.tables.${tbl.orders}.field_rule.option_edit_fields[0]`,
        },
      ],
    },
    {
      name: 'visible_views with a view of another table or no view at all',
      input: {
        tables: {
          [tbl.orders]: {
            perm: 'read_only',
            view_rule: { visible_views: [viw.orders, viw.customers, newId('viw')] },
          },
        },
      },
      error: 'reference',
      issues: [
        { code: 'UNKNOWN_VIEW', path: `config.tables.${tbl.orders}.view_rule.visible_views[1]` },
        { code: 'UNKNOWN_VIEW', path: `config.tables.${tbl.orders}.view_rule.visible_views[2]` },
      ],
    },
    {
      name: 'filter on a field of another table',
      input: {
        tables: {
          [tbl.orders]: {
            perm: 'edit',
            record_rule: {
              edit_filter: { field: fld.name, operator: 'is', value: 'x' },
            },
          },
        },
      },
      error: 'filter',
      issues: [
        {
          code: 'UNKNOWN_FIELD',
          path: `config.tables.${tbl.orders}.record_rule.edit_filter.field`,
        },
      ],
    },
    {
      name: 'read_filter with an unknown select option',
      input: {
        tables: {
          [tbl.orders]: {
            perm: 'read_only',
            record_rule: {
              read_scope: 'filter',
              read_filter: { field: fld.status, operator: 'is', value: 'Nope' },
            },
          },
        },
      },
      error: 'filter',
      issues: [
        {
          code: 'INVALID_SELECT_OPTION',
          path: `config.tables.${tbl.orders}.record_rule.read_filter.value`,
        },
      ],
    },
  ];

  it.each(failures)('rejects: $name', ({ input, error, issues }) => {
    const result = prepareRoleConfig(input, schema, { kind: 'custom' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(error);
    const actual = result.issues.map((issue) => ({
      path: Array.isArray(issue.path) ? issue.path.join('.') : issue.path,
      code: issue.code,
    }));
    expect(actual).toHaveLength(issues.length);
    issues.forEach((expected, index) => {
      expect(actual[index]?.path.startsWith(expected.path)).toBe(true);
      if (expected.code !== undefined) expect(actual[index]?.code).toBe(expected.code);
    });
  });
});

describe('prepareRoleConfig: visible_views naming deleted views', () => {
  const personal = newId('viw');
  const deleted = newId('viw');
  const withExisting: RoleSchemaMeta = {
    ...schema,
    // Existing views among the entries: shared views of both tables and a personal view.
    existingViews: new Set([viw.orders, viw.customers, personal]),
  };
  const input = (visible: string[]) => ({
    tables: { [tbl.orders]: { perm: 'read_only', view_rule: { visible_views: visible } } },
  });

  it.each([
    { name: 'a deleted view is dropped', visible: [deleted, viw.orders], kept: [viw.orders] },
    { name: 'only deleted views → []', visible: [deleted], kept: [] },
    { name: 'valid entries stay', visible: [viw.orders], kept: [viw.orders] },
  ])('$name', ({ visible, kept }) => {
    const result = prepareRoleConfig(input(visible), withExisting, { kind: 'custom' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.tables[tbl.orders]?.view_rule.visible_views).toEqual(kept);
  });

  it.each([
    { name: 'a view of another table', viewId: viw.customers },
    { name: 'a personal view', viewId: personal },
  ])('still rejects $name with UNKNOWN_VIEW', ({ viewId }) => {
    const result = prepareRoleConfig(input([deleted, viewId]), withExisting, { kind: 'custom' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: 'UNKNOWN_VIEW',
        path: `config.tables.${tbl.orders}.view_rule.visible_views[1]`,
      }),
    ]);
  });
});

describe('isViewVisible', () => {
  const viewA = newId('viw');
  const viewB = newId('viw');
  it.each([
    { visible: null, view: viewA, expected: true },
    { visible: [viewA], view: viewA, expected: true },
    { visible: [viewA], view: viewB, expected: false },
    { visible: [], view: viewA, expected: false },
  ])('visible_views $visible, view $view → $expected', ({ visible, view, expected }) => {
    expect(isViewVisible({ view_rule: { allow_edit: false, visible_views: visible } }, view)).toBe(
      expected,
    );
  });
});

describe('adjustment reasons', () => {
  it('match the API contract', () => {
    expect([...ADJUSTMENT_REASONS]).toEqual([...ROLE_ADJUSTMENT_REASONS]);
  });
});
