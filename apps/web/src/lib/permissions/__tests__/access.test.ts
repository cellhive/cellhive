import { effectiveAccessSchema, type EffectiveAccess } from '@cellhive/contracts';
import { describe, expect, it } from 'vitest';

import {
  canAddRecord,
  canCopy,
  canCreateSelectOption,
  canCreateShareLink,
  canDeleteRecord,
  canDownload,
  canEditField,
  canEditView,
  canEditViews,
  canLockViews,
  canSaveViewConfig,
  canManageSchema,
  canReadField,
  canRestoreRecords,
  canSeeView,
  isBaseAdmin,
  tableAccessOf,
} from '../access';

const ORDERS = 'tbl_Orders0000000001';
const MANAGED = 'tbl_Managed000000001';
const READONLY = 'tbl_ReadOnly00000001';
const HIDDEN = 'tbl_Hidden0000000001';
const AMOUNT = 'fld_Amount0000000001';
const STATUS = 'fld_Status0000000001';
const OWNER = 'fld_Owner00000000001';
const COST = 'fld_Cost000000000001';
const VIEW = 'viw_Sales00000000001';

/** A custom role like the example of CONTRACTS §5A (`u_sales1` of §9). */
const sales: EffectiveAccess = effectiveAccessSchema.parse({
  role: { id: 'rol_Sales00000000001', kind: 'custom', name: 'Sales' },
  is_admin: false,
  base_rule: { copy: false, download: false, share_link: false },
  tables: {
    [ORDERS]: {
      perm: 'edit',
      operations: ['add'],
      view_rule: { allow_edit: false, visible_views: [VIEW] },
      read_scope: 'editable',
      fields: { [AMOUNT]: 'edit', [STATUS]: 'read', [OWNER]: 'create' },
      option_edit_fields: [],
      file_download_fields: [],
    },
    [MANAGED]: {
      perm: 'manage',
      operations: ['add', 'delete'],
      view_rule: { allow_edit: true, visible_views: null },
      read_scope: 'all',
      fields: { [STATUS]: 'edit' },
      option_edit_fields: [STATUS],
      file_download_fields: [],
    },
    [READONLY]: {
      perm: 'read_only',
      operations: ['add', 'delete'],
      view_rule: { allow_edit: false, visible_views: null },
      read_scope: 'all',
      fields: { [AMOUNT]: 'read' },
      option_edit_fields: [],
      file_download_fields: [],
    },
  },
  dashboards: {},
});

const admin: EffectiveAccess = {
  ...sales,
  role: null,
  is_admin: true,
  base_rule: { copy: true, download: true, share_link: true },
};

const copier: EffectiveAccess = {
  ...sales,
  base_rule: { copy: true, download: true, share_link: true },
};

describe('access helpers (FRONTEND §7)', () => {
  it('admins edit fields created after the access was read, and add select options', () => {
    expect(canEditField(admin, ORDERS, 'fld_NewField00000001')).toBe(true);
    expect(canCreateSelectOption(admin, ORDERS, 'fld_NewField00000001')).toBe(true);
  });

  it('answers false while the access is unknown', () => {
    for (const access of [undefined, null]) {
      expect(isBaseAdmin(access)).toBe(false);
      expect(canManageSchema(access)).toBe(false);
      expect(canAddRecord(access, ORDERS)).toBe(false);
      expect(canDeleteRecord(access, ORDERS)).toBe(false);
      expect(canEditField(access, ORDERS, AMOUNT)).toBe(false);
      expect(canCopy(access)).toBe(false);
      expect(tableAccessOf(access, ORDERS)).toBeUndefined();
    }
  });

  it.each([
    ['sales, no table', sales, undefined, false],
    ['sales, edit table', sales, ORDERS, false],
    ['sales, manage table', sales, MANAGED, true],
    ['sales, invisible table', sales, HIDDEN, false],
    ['admin, no table', admin, undefined, true],
    ['admin, any table', admin, HIDDEN, true],
  ] as const)('canManageSchema: %s → %s', (_name, access, tableId, expected) => {
    expect(canManageSchema(access, tableId)).toBe(expected);
  });

  it.each([
    [ORDERS, true, false],
    [MANAGED, true, true],
    [READONLY, false, false],
    [HIDDEN, false, false],
  ])('record operations on %s: add %s, delete %s', (tableId, add, remove) => {
    expect(canAddRecord(sales, tableId)).toBe(add);
    expect(canDeleteRecord(sales, tableId)).toBe(remove);
    expect(canRestoreRecords(sales, tableId)).toBe(remove);
  });

  it.each([
    [ORDERS, AMOUNT, 'edit', true],
    [ORDERS, AMOUNT, 'create', true],
    [ORDERS, STATUS, 'edit', false],
    [ORDERS, STATUS, 'create', false],
    [ORDERS, OWNER, 'edit', false],
    [ORDERS, OWNER, 'create', true],
    [ORDERS, COST, 'edit', false],
    [READONLY, AMOUNT, 'edit', false],
    [HIDDEN, AMOUNT, 'edit', false],
  ] as const)('canEditField(%s, %s, %s) → %s', (tableId, fieldId, mode, expected) => {
    expect(canEditField(sales, tableId, fieldId, mode)).toBe(expected);
  });

  it('knows which fields are visible at all', () => {
    expect(canReadField(sales, ORDERS, STATUS)).toBe(true);
    expect(canReadField(sales, ORDERS, COST)).toBe(false);
    expect(canReadField(sales, HIDDEN, STATUS)).toBe(false);
  });

  it('follows the base rule for copy, download and share links; admins always may', () => {
    for (const check of [canCopy, canDownload, canCreateShareLink]) {
      expect(check(sales)).toBe(false);
      expect(check(copier)).toBe(true);
      expect(
        check({ ...admin, base_rule: { copy: false, download: false, share_link: false } }),
      ).toBe(true);
    }
  });

  it('follows the view rule', () => {
    expect(canEditViews(sales, ORDERS)).toBe(false);
    expect(canEditViews(sales, MANAGED)).toBe(true);
    expect(canEditViews(admin, ORDERS)).toBe(true);
    expect(canSeeView(sales, ORDERS, VIEW)).toBe(true);
    expect(canSeeView(sales, ORDERS, 'viw_Other00000000001')).toBe(false);
    expect(canSeeView(sales, MANAGED, 'viw_Other00000000001')).toBe(true);
    expect(canSeeView(sales, HIDDEN, VIEW)).toBe(false);
  });

  it.each([
    ['shared view, no view rights', ORDERS, false, false, false, false],
    ['shared view, table manage', MANAGED, false, false, true, true],
    ['locked shared view, table manage', MANAGED, false, true, true, false],
    ['personal view, no view rights', ORDERS, true, false, true, true],
    ['view of a table not visible', HIDDEN, true, false, false, false],
  ] as const)('%s: edit %s, save config %s', (_label, tableId, personal, locked, edit, save) => {
    const view = { is_personal: personal, locked };
    expect(canEditView(sales, tableId, view)).toBe(edit);
    expect(canSaveViewConfig(sales, tableId, view)).toBe(save);
  });

  it('locking views needs schema rights on the table', () => {
    expect(canLockViews(sales, ORDERS)).toBe(false);
    expect(canLockViews(sales, MANAGED)).toBe(true);
    expect(canLockViews(admin, ORDERS)).toBe(true);
  });

  it('offers new select options only for option_edit_fields', () => {
    expect(canCreateSelectOption(sales, MANAGED, STATUS)).toBe(true);
    expect(canCreateSelectOption(sales, ORDERS, STATUS)).toBe(false);
  });
});
