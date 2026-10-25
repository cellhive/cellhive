import { ME, ORG } from './app-harness';

/**
 * Fixtures of a table with several field types for the record panel and
 * history tests (T206). Ids are valid public ids (CONTRACTS §1.2).
 */

export const BASE_ID = 'bse_Orders0000000001';
export const TABLE_ID = 'tbl_Orders0000000001';
export const NOW = '2026-09-24T00:00:00.000Z';

export const FIELD = {
  title: 'fld_Title00000000001',
  status: 'fld_Status0000000001',
  amount: 'fld_Amount0000000001',
  owner: 'fld_Owner00000000001',
  code: 'fld_Code000000000001',
  notes: 'fld_Notes00000000001',
} as const;

export const OPTION = { new: 'opt_New0000000000001', done: 'opt_Done000000000001' } as const;

export type AccessKind = 'admin' | 'editor' | 'reader';

function field(
  id: string,
  name: string,
  type: string,
  position: number,
  options: Record<string, unknown> = {},
) {
  return {
    id,
    table_id: TABLE_ID,
    name,
    type,
    options,
    is_primary: id === FIELD.title,
    required: false,
    unique_values: false,
    description: null,
    position,
    created_at: NOW,
    updated_at: NOW,
  };
}

/** Title (primary), Status (select), Amount (number), Owner (user), Code (auto number), Notes. */
export function fieldList(extra: ReturnType<typeof field>[] = []) {
  const items = [
    field(FIELD.title, 'Title', 'text', 0),
    field(FIELD.status, 'Status', 'select', 1, {
      multiple: false,
      options: [
        { id: OPTION.new, name: 'New', color: 1 },
        { id: OPTION.done, name: 'Done', color: 2 },
      ],
    }),
    field(FIELD.amount, 'Amount', 'number', 2),
    field(FIELD.owner, 'Owner', 'user', 3, { multiple: false }),
    field(FIELD.code, 'Code', 'auto_number', 4, {
      style: { rules: [{ type: 'incremental_number', length: 4 }] },
    }),
    field(FIELD.notes, 'Notes', 'text', 5),
    ...extra,
  ];
  return { items, total: items.length, offset: 0, limit: 1000 };
}

/** Plain text fields `Note 1` … `Note n` (a paste into many cells). */
export function noteFields(count: number) {
  return Array.from({ length: count }, (_, index) =>
    field(
      `fld_Note${String(index + 1).padStart(12, '0')}`,
      `Note ${String(index + 1)}`,
      'text',
      10 + index,
    ),
  );
}

export function tableAccess(kind: AccessKind) {
  const fieldPerm = kind === 'reader' ? 'read' : 'edit';
  return {
    perm: kind === 'reader' ? 'read_only' : kind === 'admin' ? 'manage' : 'edit',
    operations: kind === 'reader' ? [] : ['add', 'delete'],
    view_rule: { allow_edit: kind === 'admin', visible_views: null },
    read_scope: 'all',
    fields: {
      [FIELD.title]: fieldPerm,
      [FIELD.status]: kind === 'editor' ? 'read' : fieldPerm,
      [FIELD.amount]: fieldPerm,
      [FIELD.owner]: fieldPerm,
      [FIELD.code]: 'read',
      [FIELD.notes]: fieldPerm,
    },
    option_edit_fields: [],
    file_download_fields: [],
  };
}

export function baseDetail(kind: AccessKind) {
  return {
    id: BASE_ID,
    organization_id: ORG.id,
    workspace_id: 'wsp_Orders0000000001',
    owner_id: ME.user.id,
    name: 'Sales',
    icon: null,
    description: null,
    permission_version: 3,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    access: {
      role: null,
      is_admin: kind === 'admin',
      base_rule: { copy: true, download: true, share_link: true },
      tables: { [TABLE_ID]: tableAccess(kind) },
      dashboards: {},
    },
  };
}

export const TABLE = {
  id: TABLE_ID,
  base_id: BASE_ID,
  name: 'Orders',
  description: null,
  primary_field_id: FIELD.title,
  position: 0,
  schema_state: 'ready',
  created_at: NOW,
  updated_at: NOW,
};

export function recordId(index: number): string {
  return `rec_${String(index).padStart(16, '0')}`;
}

export function record(index: number, fields: Record<string, unknown> = {}, version = 1) {
  return {
    id: recordId(index),
    created_at: NOW,
    updated_at: NOW,
    version,
    fields: {
      [FIELD.title]: `Order ${String(index)}`,
      [FIELD.status]: 'New',
      [FIELD.amount]: 1500,
      [FIELD.owner]: [{ id: ME.user.id, name: ME.user.display_name, email: ME.user.email }],
      [FIELD.code]: `OR-${String(index).padStart(4, '0')}`,
      [FIELD.notes]: null,
      ...fields,
    },
  };
}
