import { describe, expect, it } from 'vitest';

import { createTestI18n } from '../../../../../../test/i18n';
import {
  canonical,
  configToSave,
  dashboardPermOf,
  draftIssues,
  draftOf,
  effectiveFieldPerm,
  emptyTableRule,
  fieldLevelBlock,
  hasNegativeLinkCondition,
  operationsBlock,
  placeAdjustments,
  sameConfig,
  tableLevelBlock,
  withAllFields,
  withDashboards,
  withFieldMode,
  withFieldPerm,
  type EditorTable,
} from '../model';
import { recordRuleSummary } from '../summary';

import type { FieldDto, RoleAdjustmentDto, RoleKind } from '@cellhive/contracts';
import type { FieldPerm, TablePerm, TableRule } from '@cellhive/permissions';

/** T713: the role editor's model (FRONTEND §17.4), table-driven. */

const ORDERS = 'tbl_Orders0000000001';
const CUSTOMERS = 'tbl_Customers0000001';
const F = {
  title: 'fld_Title00000000001',
  amount: 'fld_Amount0000000001',
  cost: 'fld_Cost000000000001',
  status: 'fld_Status0000000001',
  owner: 'fld_Owner00000000001',
  total: 'fld_Total00000000001',
  customer: 'fld_Customer00000001',
} as const;
const DONE = 'opt_Done000000000001';

function field(id: string, name: string, type: string, options: Record<string, unknown> = {}) {
  return {
    id: id as FieldDto['id'],
    name,
    type: type as FieldDto['type'],
    options,
    is_primary: id === F.title,
  };
}

const TABLES: EditorTable[] = [
  {
    id: ORDERS,
    name: 'Orders',
    fields: [
      field(F.title, 'Title', 'text'),
      field(F.amount, 'Amount', 'number'),
      field(F.cost, 'Cost', 'number'),
      field(F.status, 'Status', 'select', {
        multiple: false,
        options: [{ id: DONE, name: 'Done', color: 1 }],
      }),
      field(F.owner, 'Owner', 'user', { multiple: false }),
      field(F.total, 'Total', 'formula'),
      field(F.customer, 'Customer', 'link'),
    ],
  },
  { id: CUSTOMERS, name: 'Customers', fields: [field('fld_Name000000000001', 'Name', 'text')] },
];
const ORDERS_TABLE = TABLES[0] as EditorTable;

const OWNER_IS_ME = {
  op: 'and',
  items: [{ field: F.owner, operator: 'has_any_of', value: [{ $var: 'current_user' }] }],
} as const;

/** The Sales role of CONTRACTS §5 (by ids). */
const SALES = {
  base_rule: { copy: false, download: false, share_link: false },
  tables: {
    [ORDERS]: {
      perm: 'edit',
      view_rule: { allow_edit: false, visible_views: null },
      record_rule: {
        operations: ['add'],
        edit_filter: OWNER_IS_ME,
        read_scope: 'editable',
        read_filter: null,
      },
      field_rule: {
        mode: 'specify',
        fields: { [F.cost]: 'no_perm', [F.status]: 'read' },
        option_edit_fields: [],
        file_download_fields: [],
      },
    },
  },
  dashboards: {},
};

function rule(overrides: Partial<TableRule> = {}): TableRule {
  return { ...emptyTableRule(), perm: 'edit', ...overrides };
}

describe('draftOf / configToSave', () => {
  it('a custom role: every live table, unlisted ones are No access; saved without them', () => {
    const draft = draftOf(SALES, 'custom', TABLES);
    expect(Object.keys(draft.tables)).toEqual([ORDERS, CUSTOMERS]);
    expect(draft.tables[CUSTOMERS]?.perm).toBe('no_perm');
    expect(draft.tables[ORDERS]?.record_rule.read_scope).toBe('editable');
    const saved = configToSave(draft, 'custom');
    expect(Object.keys(saved.tables)).toEqual([ORDERS]);
    expect(canonical(saved)).toBe(canonical(SALES));
  });

  it('a system role: tables it does not list take the preset, and every table is saved', () => {
    const draft = draftOf(
      { base_rule: { copy: true, download: true, share_link: false }, tables: {} },
      'system_reader',
      TABLES,
    );
    expect(draft.tables[ORDERS]?.perm).toBe('read_only');
    expect(draft.tables[CUSTOMERS]?.field_rule.mode).toBe('all_read');
    expect(Object.keys(configToSave(draft, 'system_reader').tables)).toEqual([ORDERS, CUSTOMERS]);
  });

  it('drops tables and fields that are no longer live (they would be UNKNOWN_*)', () => {
    const stored = {
      tables: {
        tbl_Gone000000000001: { perm: 'edit' },
        [ORDERS]: {
          perm: 'read_only',
          field_rule: {
            mode: 'specify',
            fields: { [F.cost]: 'no_perm', fld_Gone000000000001: 'read' },
            option_edit_fields: ['fld_Gone000000000001'],
          },
        },
      },
    };
    const draft = draftOf(stored, 'custom', TABLES);
    expect(Object.keys(draft.tables)).toEqual([ORDERS, CUSTOMERS]);
    expect(draft.tables[ORDERS]?.field_rule.fields).toEqual({ [F.cost]: 'no_perm' });
    expect(draft.tables[ORDERS]?.field_rule.option_edit_fields).toEqual([]);
  });

  it('an unreadable config starts from deny-all', () => {
    const draft = draftOf({ tables: 'nope' }, 'custom', TABLES);
    expect(draft.tables[ORDERS]?.perm).toBe('no_perm');
  });

  it('sameConfig ignores key order and the No access tables of a custom role', () => {
    const a = draftOf(SALES, 'custom', TABLES);
    const b = draftOf(
      JSON.parse(JSON.stringify(SALES)) as unknown,
      'custom',
      [...TABLES].reverse(),
    );
    expect(sameConfig(a, b, 'custom')).toBe(true);
    const changed = { ...a, base_rule: { ...a.base_rule, copy: true } };
    expect(sameConfig(a, changed, 'custom')).toBe(false);
  });
});

describe('ceilings', () => {
  it.each<[RoleKind, TablePerm, string | null]>([
    ['custom', 'manage', null],
    ['system_editor', 'manage', 'editor_ceiling'],
    ['system_editor', 'edit', null],
    ['system_reader', 'edit', 'reader_ceiling'],
    ['system_reader', 'read_only', null],
    ['system_admin', 'read_only', 'admin_read_only'],
  ])('table level %s / %s → %s', (kind, level, expected) => {
    expect(tableLevelBlock(kind, level)).toBe(expected);
  });

  it.each<[RoleKind, TablePerm, string | null]>([
    ['custom', 'edit', null],
    ['custom', 'manage', null],
    ['custom', 'read_only', 'table_read_only'],
    ['custom', 'no_perm', 'table_no_access'],
    ['system_reader', 'read_only', 'reader_ceiling'],
    ['system_admin', 'manage', 'admin_read_only'],
  ])('operations %s / %s → %s', (kind, perm, expected) => {
    expect(operationsBlock(kind, perm)).toBe(expected);
  });

  it.each<[RoleKind, TablePerm, FieldPerm, string | null]>([
    ['custom', 'edit', 'edit', null],
    ['custom', 'read_only', 'edit', 'table_read_only'],
    ['custom', 'read_only', 'read', null],
    ['system_reader', 'read_only', 'create', 'reader_ceiling'],
    ['system_editor', 'edit', 'edit', null],
  ])('field level %s / %s / %s → %s', (kind, perm, level, expected) => {
    expect(fieldLevelBlock(kind, perm, level)).toBe(expected);
  });
});

describe('effectiveFieldPerm', () => {
  const amount = { id: F.amount, type: 'number' } as const;
  const total = { id: F.total, type: 'formula' } as const;
  it.each<[string, TableRule, { id: string; type: string }, FieldPerm]>([
    ['mode default', rule(), amount, 'edit'],
    [
      'all_read',
      rule({ field_rule: { ...emptyTableRule().field_rule, mode: 'all_read' } }),
      amount,
      'read',
    ],
    ['computed is at most read', rule(), total, 'read'],
    ['read-only table', rule({ perm: 'read_only' }), amount, 'read'],
    ['no access', rule({ perm: 'no_perm' }), amount, 'no_perm'],
    ['create without add reads', withFieldPerm(rule(), F.amount, 'create'), amount, 'read'],
  ])('%s', (_, tableRule, target, expected) => {
    expect(effectiveFieldPerm(tableRule, target as never)).toBe(expected);
  });
});

describe('field rule edits', () => {
  it('"Choose per field" starts from what each field shows; leaving it drops the choices', () => {
    const allRead = rule({ field_rule: { ...emptyTableRule().field_rule, mode: 'all_read' } });
    const specify = withFieldMode(allRead, 'specify', ORDERS_TABLE);
    expect(specify.field_rule.fields[F.amount as never]).toBe('read');
    expect(Object.keys(specify.field_rule.fields)).toHaveLength(ORDERS_TABLE.fields.length);
    expect(withFieldMode(specify, 'all_edit', ORDERS_TABLE).field_rule.fields).toEqual({});
  });

  it('"Every field" sets every field, computed ones at most Read', () => {
    const all = withAllFields(rule(), ORDERS_TABLE, 'edit');
    expect(all.field_rule.mode).toBe('specify');
    expect(all.field_rule.fields[F.amount as never]).toBe('edit');
    expect(all.field_rule.fields[F.total as never]).toBe('read');
    expect(withAllFields(rule(), ORDERS_TABLE, 'no_perm').field_rule.fields[F.total as never]).toBe(
      'no_perm',
    );
  });

  it('"Choose per field" keeps computed fields at Read', () => {
    const specify = withFieldMode(rule(), 'specify', ORDERS_TABLE);
    expect(specify.field_rule.fields[F.total as never]).toBe('read');
    expect(specify.field_rule.fields[F.amount as never]).toBe('edit');
  });
});

describe('record conditions', () => {
  it.each<[string, unknown, boolean]>([
    [
      'has_none_of on a link',
      { field: F.customer, operator: 'has_none_of', value: ['rec_00000000000000a1'] },
      true,
    ],
    [
      'is_empty on a link, nested',
      { op: 'or', items: [{ field: F.customer, operator: 'is_empty' }] },
      true,
    ],
    [
      'has_any_of on a link',
      { field: F.customer, operator: 'has_any_of', value: ['rec_00000000000000a1'] },
      false,
    ],
    ['is_empty on another field', { field: F.amount, operator: 'is_empty' }, false],
    ['no filter', null, false],
  ])('%s → warning %s', (_, filter, expected) => {
    expect(hasNegativeLinkCondition(filter as never, ORDERS_TABLE.fields)).toBe(expected);
  });

  it('draftIssues: invalid or incomplete filters, read_scope filter without one', () => {
    const draft = draftOf(SALES, 'custom', TABLES);
    const orders = draft.tables[ORDERS] as TableRule;
    const withFilterScope = {
      ...draft,
      tables: {
        ...draft.tables,
        [ORDERS]: {
          ...orders,
          record_rule: { ...orders.record_rule, read_scope: 'filter' as const },
        },
      },
    };
    expect(draftIssues(draft, new Map()).size).toBe(0);
    expect(draftIssues(withFilterScope, new Map()).get(ORDERS)).toEqual(['read_filter_missing']);
    expect(
      draftIssues(draft, new Map([[`${ORDERS}:edit_filter`, { valid: false, incomplete: 0 }]])).get(
        ORDERS,
      ),
    ).toEqual(['filter_invalid']);
    expect(
      draftIssues(draft, new Map([[`${ORDERS}:edit_filter`, { valid: true, incomplete: 1 }]])).get(
        ORDERS,
      ),
    ).toEqual(['filter_incomplete']);
  });
});

describe('placeAdjustments', () => {
  it('puts table adjustments by table and field adjustments by field', () => {
    const adjustments: RoleAdjustmentDto[] = [
      {
        table_id: ORDERS,
        field_id: F.status,
        from: 'no_perm',
        to: 'create',
        reason: 'filter_field_min_create',
      },
      {
        table_id: ORDERS,
        field_id: F.total,
        from: 'edit',
        to: 'read',
        reason: 'computed_field_max_read',
      },
      { table_id: CUSTOMERS, field_id: null, from: 'manage', to: 'edit', reason: 'editor_ceiling' },
    ] as RoleAdjustmentDto[];
    const placed = placeAdjustments(adjustments);
    expect(placed.fields.get(`${ORDERS}:${F.status}`)?.[0]?.reason).toBe('filter_field_min_create');
    expect(placed.fieldCounts.get(ORDERS)).toBe(2);
    expect(placed.tables.get(CUSTOMERS)?.[0]?.reason).toBe('editor_ceiling');
    expect(placed.tables.has(ORDERS)).toBe(false);
  });
});

describe('recordRuleSummary', () => {
  it.each([
    [
      'en',
      'Edits records where Owner has any of Current user (whoever views). Reads only the records it can edit. Can add records, not delete them.',
    ],
    ['vi', 'Sửa được bản ghi có Owner'],
  ] as const)('the Sales rule in words (%s)', async (language, expected) => {
    const i18n = await createTestI18n(language);
    const t = i18n.getFixedT(language, ['baseSettings', 'toolbar']);
    const draft = draftOf(SALES, 'custom', TABLES);
    const text = recordRuleSummary(draft.tables[ORDERS] as TableRule, {
      t: t,
      fields: new Map(ORDERS_TABLE.fields.map((item) => [item.id as string, item])),
      users: new Map(),
    }).join(' ');
    expect(text).toContain(expected);
  });

  it('names options, users and counts linked records', async () => {
    const i18n = await createTestI18n('en');
    const t = i18n.getFixedT('en', ['baseSettings', 'toolbar']);
    const tableRule = rule({
      record_rule: {
        operations: [],
        edit_filter: null,
        read_scope: 'filter',
        read_filter: {
          op: 'or',
          items: [
            { field: F.status, operator: 'is', value: DONE },
            { field: F.owner, operator: 'has_any_of', value: ['usr_0123456789ABCDEF'] },
            {
              field: F.customer,
              operator: 'has_any_of',
              value: ['rec_00000000000000a1', 'rec_00000000000000a2'],
            },
          ],
        } as never,
      },
    });
    const text = recordRuleSummary(tableRule, {
      t: t,
      fields: new Map(ORDERS_TABLE.fields.map((item) => [item.id as string, item])),
      users: new Map([['usr_0123456789ABCDEF', 'An Nguyen']]),
    }).join(' ');
    expect(text).toContain(
      'Status is Done or Owner has any of An Nguyen or Customer has any of 2 records',
    );
    expect(text).toContain('Cannot add or delete records.');
  });
});

describe('dashboards (T815)', () => {
  const D1 = 'dsh_Sales00000000001';
  const D2 = 'dsh_Ops0000000000001';
  const TRASHED = 'dsh_Trashed000000001';
  const config = (dashboards: Record<string, string>) =>
    draftOf({ tables: {}, dashboards }, 'custom', []);

  it.each<[RoleKind, Record<string, string>, string, string]>([
    ['custom', {}, D1, 'no_perm'],
    ['custom', { [D1]: 'read_only' }, D1, 'read_only'],
    ['custom', { [D1]: 'no_perm' }, D1, 'no_perm'],
    ['system_editor', {}, D1, 'read_only'],
    ['system_reader', {}, D1, 'read_only'],
    ['system_reader', { [D1]: 'no_perm' }, D1, 'no_perm'],
    ['system_admin', { [D1]: 'no_perm' }, D1, 'read_only'],
  ])('%s with %j reads %s: %s', (kind, dashboards, id, expected) => {
    expect(dashboardPermOf(config(dashboards), kind, id)).toBe(expected);
  });

  it('sets one or every dashboard; a custom role saves only what it reads', () => {
    const start = config({ [TRASHED]: 'read_only' });
    const all = withDashboards(start, [D1, D2], 'read_only');
    expect(configToSave(all, 'custom').dashboards).toEqual({
      [D1]: 'read_only',
      [D2]: 'read_only',
      // A dashboard in the trash keeps its grant (restoring it keeps it).
      [TRASHED]: 'read_only',
    });
    const one = withDashboards(all, [D2], 'no_perm');
    expect(configToSave(one, 'custom').dashboards).toEqual({
      [D1]: 'read_only',
      [TRASHED]: 'read_only',
    });
    expect(sameConfig(withDashboards(start, [D1], 'no_perm'), start, 'custom')).toBe(true);
    expect(sameConfig(all, start, 'custom')).toBe(false);
  });

  it('a system role keeps its explicit entries', () => {
    const start = draftOf({ tables: {}, dashboards: { [D1]: 'no_perm' } }, 'system_reader', []);
    expect(configToSave(start, 'system_reader').dashboards).toEqual({ [D1]: 'no_perm' });
  });
});
