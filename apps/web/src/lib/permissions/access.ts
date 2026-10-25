import type { EffectiveAccess, TableAccess } from '@cellhive/contracts';

/**
 * UX-only helpers over `access` of `GET /bases/:id` (CONTRACTS §5A,
 * FRONTEND §7): they hide or disable buttons. The server still decides every
 * action; screens must handle its `403`/`404` anyway (FRONTEND §4.1).
 *
 * Every helper accepts `undefined` (base not loaded yet) and then answers
 * `false`: nothing is offered before the access is known.
 */
type Access = EffectiveAccess | null | undefined;

/** Access to one table, or `undefined` when the table is not visible to the caller. */
export function tableAccessOf(access: Access, tableId: string): TableAccess | undefined {
  if (access === null || access === undefined) return undefined;
  return (access.tables as Readonly<Record<string, TableAccess | undefined>>)[tableId];
}

function canWriteRecords(table: TableAccess | undefined): table is TableAccess {
  return table !== undefined && (table.perm === 'edit' || table.perm === 'manage');
}

/** Base admin: every table, schema and setting (roles, members, share links). */
export function isBaseAdmin(access: Access): boolean {
  return access?.is_admin === true;
}

/**
 * Schema changes (CONTRACTS §13). Without `tableId`: creating, deleting or
 * restoring tables (base admin only). With `tableId`: editing that table and
 * adding, changing or deleting its fields (base admin or table `manage`).
 */
export function canManageSchema(access: Access, tableId?: string): boolean {
  if (isBaseAdmin(access)) return true;
  if (tableId === undefined) return false;
  return tableAccessOf(access, tableId)?.perm === 'manage';
}

/**
 * (T520) Managing automations (ADR-25 §3, CONTRACTS §21): base admins every
 * one; otherwise those triggered on a table the caller manages. Without
 * `tableId`: whether the caller manages any automation at all (the list
 * answers `403` otherwise), i.e. base admin or `manage` on some table.
 */
export function canManageAutomations(access: Access, tableId?: string): boolean {
  if (isBaseAdmin(access)) return true;
  if (access === null || access === undefined) return false;
  if (tableId !== undefined) return canManageSchema(access, tableId);
  return Object.values(access.tables as Readonly<Record<string, TableAccess | undefined>>).some(
    (table) => table?.perm === 'manage',
  );
}

/** "Add record" (operation `add` on a table the caller may write). */
export function canAddRecord(access: Access, tableId: string): boolean {
  const table = tableAccessOf(access, tableId);
  return canWriteRecords(table) && table.operations.includes('add');
}

/**
 * "Delete record" (operation `delete`). The trash of the table and its
 * "Restore" button need the same right (CONTRACTS §11.3).
 */
export function canDeleteRecord(access: Access, tableId: string): boolean {
  const table = tableAccessOf(access, tableId);
  return canWriteRecords(table) && table.operations.includes('delete');
}

/** Whether the caller may open the trash of a table and restore records. */
export const canRestoreRecords = canDeleteRecord;

/**
 * Whether a cell of `fieldId` is editable. `create` fields are writable only
 * while creating a record (`mode = 'create'`), `read` never; computed fields
 * are already `read` in the access. Record rules (`edit_filter`) are not
 * known to the client: a write may still be refused with
 * `403 RECORD_RULE_VIOLATION`. Base admins may edit every field; the
 * field type decides whether it is writable at all.
 */
export function canEditField(
  access: Access,
  tableId: string,
  fieldId: string,
  mode: 'edit' | 'create' = 'edit',
): boolean {
  // Admins edit every non-computed field, also one created after `access`
  // was read (the caller checks the field type: computed types stay read-only).
  if (isBaseAdmin(access)) return true;
  const table = tableAccessOf(access, tableId);
  if (!canWriteRecords(table)) return false;
  const perm = (table.fields as Readonly<Record<string, string | undefined>>)[fieldId];
  return perm === 'edit' || (perm === 'create' && mode === 'create');
}

/**
 * Whether the link picker of a link field may open (T413): the linked
 * table must be readable, else the candidates are `404` (CONTRACTS §2) and
 * the cell shows locked chips only (P20).
 */
export function canPickLinks(access: Access, linkTable: string): boolean {
  return isBaseAdmin(access) || tableAccessOf(access, linkTable) !== undefined;
}

/** Whether a field is visible at all (`no_perm` fields are absent from the payload). */
export function canReadField(access: Access, tableId: string, fieldId: string): boolean {
  const table = tableAccessOf(access, tableId);
  return table !== undefined && Object.hasOwn(table.fields, fieldId);
}

/** New select options typed into a cell (`typecast=true`, CONTRACTS §2). */
export function canCreateSelectOption(access: Access, tableId: string, fieldId: string): boolean {
  if (isBaseAdmin(access)) return true;
  const table = tableAccessOf(access, tableId);
  return table !== undefined && (table.option_edit_fields as readonly string[]).includes(fieldId);
}

/**
 * Files of an attachment field may be loaded — downloaded, and shown as
 * images (T418): the field is among the role's `file_download_fields`
 * (CONTRACTS §5A, §20; `GET /files/:id` answers `403` otherwise). Admins
 * also for a field created after `access` was read.
 */
export function canDownloadFile(access: Access, tableId: string, fieldId: string): boolean {
  if (isBaseAdmin(access)) return true;
  const table = tableAccessOf(access, tableId);
  return table !== undefined && (table.file_download_fields as readonly string[]).includes(fieldId);
}

/** Copy / cut from the grid (`base_rule.copy`, FRONTEND §6.3): a UX barrier, not security. */
export function canCopy(access: Access): boolean {
  return isBaseAdmin(access) || access?.base_rule.copy === true;
}

/** Export and attachment download (`base_rule.download`). */
export function canDownload(access: Access): boolean {
  return isBaseAdmin(access) || access?.base_rule.download === true;
}

/** Creating share links (`base_rule.share_link`). */
export function canCreateShareLink(access: Access): boolean {
  return isBaseAdmin(access) || access?.base_rule.share_link === true;
}

/**
 * Creating, renaming, reordering, duplicating as shared and deleting the
 * **shared** views of a table, and saving their config: `view_rule.allow_edit`
 * or schema rights on the table (CONTRACTS §5A). Personal views do not need it.
 */
export function canEditViews(access: Access, tableId: string): boolean {
  if (canManageSchema(access, tableId)) return true;
  return tableAccessOf(access, tableId)?.view_rule.allow_edit === true;
}

/** The parts of a view the permission helpers look at. */
export interface ViewRef {
  readonly is_personal: boolean;
  readonly locked: boolean;
}

/**
 * Renaming, reordering, duplicating and deleting one view: personal views
 * are only ever seen by their owner, who may do anything with them.
 */
export function canEditView(access: Access, tableId: string, view: ViewRef): boolean {
  if (tableAccessOf(access, tableId) === undefined && !isBaseAdmin(access)) return false;
  return view.is_personal || canEditViews(access, tableId);
}

/**
 * Saving the config of a view (column layout, later filter/sort/group):
 * as {@link canEditView}, and the view is not locked (`422 VIEW_LOCKED` for
 * everyone until unlocked, CONTRACTS §15). Otherwise changes stay temporary
 * on this device.
 */
export function canSaveViewConfig(access: Access, tableId: string, view: ViewRef): boolean {
  return !view.locked && canEditView(access, tableId, view);
}

/** Locking and unlocking shared views: schema rights on the table only. */
export function canLockViews(access: Access, tableId: string): boolean {
  return canManageSchema(access, tableId);
}

/** Whether a view is listed (`view_rule.visible_views`, `null` = every view). */
export function canSeeView(access: Access, tableId: string, viewId: string): boolean {
  const table = tableAccessOf(access, tableId);
  if (table === undefined) return false;
  const visible = table.view_rule.visible_views as readonly string[] | null;
  return visible === null || visible.includes(viewId);
}
