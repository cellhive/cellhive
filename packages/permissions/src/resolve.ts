import { orFilters, type FilterNode } from './filter.js';
import { modeDefaultFieldPerm, normalizeTableRule } from './normalize.js';
import { systemTableRule } from './presets.js';
import {
  maxFieldPerm,
  maxTablePerm,
  minFieldPerm,
  RECORD_OPERATIONS,
  tablePermAtLeast,
  type BaseRule,
  type FieldPerm,
  type ReadScope,
  type RoleConfig,
  type RoleKind,
  type TablePerm,
} from './role-config.js';
import { isComputedField, type FieldMeta, type SchemaMeta, type TableMeta } from './schema-meta.js';

import type { EffectiveAccess, TableAccess } from './access.js';
import type { Id } from '@cellhive/contracts';

export type OrgRole = 'owner' | 'admin' | 'member';
export type WorkspaceRole = 'admin' | 'member';

/** Who is asking. Membership facts are loaded by the caller. */
export interface Principal {
  userId: Id<'usr'>;
  /** Groups (of this org) the user belongs to. */
  groupIds: readonly Id<'grp'>[];
  /** Role in the base's organization; `null` = not a member of the org. */
  orgRole: OrgRole | null;
  /** Role in the workspace that contains the base; `null` = not a member. */
  workspaceRole: WorkspaceRole | null;
  /** True when the user is `meta.bases.owner_id`. */
  isBaseOwner: boolean;
}

/** A row of `meta.base_roles` with its config already parsed by `roleConfigSchema`. */
export interface BaseRoleDef {
  id: Id<'rol'>;
  kind: RoleKind;
  name: string;
  config: RoleConfig;
}

/** A row of `meta.base_role_members`. */
export type RoleAssignment =
  | { roleId: Id<'rol'>; principalType: 'user'; principalId: Id<'usr'> }
  | { roleId: Id<'rol'>; principalType: 'group'; principalId: Id<'grp'> };

export interface ResolveBaseAccessInput {
  principal: Principal;
  roles: readonly BaseRoleDef[];
  assignments: readonly RoleAssignment[];
  schema: SchemaMeta;
}

/**
 * Server-only part of the effective access. Keys are the visible tables;
 * `null` means "no record restriction". Never serialize this to clients
 * (CONTRACTS §5A).
 */
export interface InternalAccess {
  /**
   * Records the principal may edit (and delete, with `delete`). Only tables
   * with `edit`/`manage`. Callers AND this with `readFilters` of the same
   * table: a record outside the read scope does not exist for the principal.
   */
  editFilters: Record<Id<'tbl'>, FilterNode | null>;
  /** Records the principal may read. Every visible table. */
  readFilters: Record<Id<'tbl'>, FilterNode | null>;
}

export interface ResolvedBaseAccess {
  access: EffectiveAccess;
  internal: InternalAccess;
}

interface RoleTableGrant {
  access: TableAccess;
  editFilter: FilterNode | null | undefined;
  readFilter: FilterNode | null;
}

const FULL_BASE_RULE: BaseRule = { copy: true, download: true, share_link: true };

function isFileField(field: FieldMeta): boolean {
  return field.type === 'attachment';
}

function isSelectField(field: FieldMeta): boolean {
  return field.type === 'select';
}

function fullAccess(schema: SchemaMeta, role: EffectiveAccess['role']): ResolvedBaseAccess {
  const tables: EffectiveAccess['tables'] = {};
  const editFilters: InternalAccess['editFilters'] = {};
  const readFilters: InternalAccess['readFilters'] = {};
  for (const table of schema.tables) {
    const fields: TableAccess['fields'] = {};
    for (const field of table.fields) {
      fields[field.id] = isComputedField(field) ? 'read' : 'edit';
    }
    tables[table.id] = {
      perm: 'manage',
      operations: [...RECORD_OPERATIONS],
      view_rule: { allow_edit: true, visible_views: null },
      read_scope: 'all',
      fields,
      option_edit_fields: table.fields
        .filter((field) => isSelectField(field) && !isComputedField(field))
        .map((field) => field.id),
      file_download_fields: table.fields.filter(isFileField).map((field) => field.id),
    };
    editFilters[table.id] = null;
    readFilters[table.id] = null;
  }
  const dashboards: EffectiveAccess['dashboards'] = {};
  for (const dashboardId of schema.dashboards ?? []) dashboards[dashboardId] = 'read_only';
  return {
    access: { role, is_admin: true, base_rule: { ...FULL_BASE_RULE }, tables, dashboards },
    internal: { editFilters, readFilters },
  };
}

/** Effective grant of one role on one table, or `undefined` when the table is invisible. */
function roleTableGrant(role: BaseRoleDef, table: TableMeta): RoleTableGrant | undefined {
  const stored = role.config.tables[table.id];
  let source = stored;
  if (source === undefined && (role.kind === 'system_editor' || role.kind === 'system_reader')) {
    // System roles cover tables created after the role was stored.
    source = systemTableRule(role.kind, table);
  }
  // Custom roles: a table missing from the config is `no_perm` (deny by default).
  if (source === undefined) return undefined;

  const rule = {
    perm: source.perm,
    view_rule: source.view_rule,
    record_rule: { ...source.record_rule, operations: [...source.record_rule.operations] },
    field_rule: { ...source.field_rule, fields: { ...source.field_rule.fields } },
  };
  normalizeTableRule(table.id, rule, table, role.kind, []);
  if (rule.perm === 'no_perm') return undefined;
  const perm: Exclude<TablePerm, 'no_perm'> = rule.perm;

  const operations = rule.record_rule.operations;
  const canAdd = operations.includes('add');
  const fieldRule = rule.field_rule;
  const fields: TableAccess['fields'] = {};
  for (const field of table.fields) {
    let fieldPerm: FieldPerm = fieldRule.fields[field.id] ?? modeDefaultFieldPerm(fieldRule.mode);
    if (isComputedField(field) || perm === 'read_only') fieldPerm = minFieldPerm(fieldPerm, 'read');
    if (fieldPerm === 'create' && !canAdd) fieldPerm = 'read';
    if (fieldPerm !== 'no_perm') fields[field.id] = fieldPerm;
  }

  const writable = (field: FieldMeta): boolean => {
    const fieldPerm = fields[field.id];
    return fieldPerm === 'edit' || fieldPerm === 'create';
  };
  const optionEdit = new Set(fieldRule.option_edit_fields);
  const downloadable = new Set(fieldRule.file_download_fields);
  const option_edit_fields = table.fields
    .filter((field) => isSelectField(field) && writable(field) && optionEdit.has(field.id))
    .map((field) => field.id);
  const file_download_fields = table.fields
    .filter(
      (field) =>
        isFileField(field) &&
        fields[field.id] !== undefined &&
        (fieldRule.mode !== 'specify' || downloadable.has(field.id)),
    )
    .map((field) => field.id);

  const recordRule = rule.record_rule;
  const readFilter =
    recordRule.read_scope === 'all'
      ? null
      : recordRule.read_scope === 'editable'
        ? recordRule.edit_filter
        : recordRule.read_filter;

  return {
    access: {
      perm,
      operations: [...operations],
      view_rule: {
        allow_edit: rule.view_rule.allow_edit,
        visible_views:
          rule.view_rule.visible_views === null ? null : [...rule.view_rule.visible_views],
      },
      read_scope: recordRule.read_scope,
      fields,
      option_edit_fields,
      file_download_fields,
    },
    editFilter: tablePermAtLeast(perm, 'edit') ? recordRule.edit_filter : undefined,
    readFilter,
  };
}

function unionIds<T extends string>(lists: readonly (readonly T[])[]): T[] {
  return [...new Set(lists.flat())];
}

/** Union of several roles' grants on one table (SPEC §14.1 step 3). */
function unionTableGrants(grants: readonly RoleTableGrant[]): {
  access: TableAccess;
  editFilter: FilterNode | null | undefined;
  readFilter: FilterNode | null;
} {
  const [first, ...rest] = grants as [RoleTableGrant, ...RoleTableGrant[]];
  if (rest.length === 0) return first;

  let perm = first.access.perm;
  const fields: TableAccess['fields'] = { ...first.access.fields };
  for (const grant of rest) {
    perm = maxTablePerm(perm, grant.access.perm) as typeof perm;
    for (const [fieldId, fieldPerm] of Object.entries(grant.access.fields) as [
      Id<'fld'>,
      Exclude<FieldPerm, 'no_perm'>,
    ][]) {
      const current = fields[fieldId];
      fields[fieldId] =
        current === undefined
          ? fieldPerm
          : (maxFieldPerm(current, fieldPerm) as Exclude<FieldPerm, 'no_perm'>);
    }
  }
  const operationSet = new Set(grants.flatMap((grant) => grant.access.operations));
  const views = grants.map((grant) => grant.access.view_rule.visible_views);
  const editGrants = grants.filter((grant) => grant.editFilter !== undefined);
  const editFilter =
    editGrants.length === 0
      ? undefined
      : orFilters(editGrants.map((grant) => grant.editFilter ?? null));
  const readFilter = orFilters(grants.map((grant) => grant.readFilter));
  const scopes = new Set(grants.map((grant) => grant.access.read_scope));
  let read_scope: ReadScope;
  if (readFilter === null) read_scope = 'all';
  else if (scopes.size === 1) read_scope = first.access.read_scope;
  else read_scope = 'filter';

  return {
    access: {
      perm,
      operations: RECORD_OPERATIONS.filter((operation) => operationSet.has(operation)),
      view_rule: {
        allow_edit: grants.some((grant) => grant.access.view_rule.allow_edit),
        visible_views: views.includes(null) ? null : unionIds(views as Id<'viw'>[][]),
      },
      read_scope,
      fields,
      option_edit_fields: unionIds(grants.map((grant) => grant.access.option_edit_fields)),
      file_download_fields: unionIds(grants.map((grant) => grant.access.file_download_fields)),
    },
    editFilter,
    readFilter,
  };
}

function roleDashboards(role: BaseRoleDef, schema: SchemaMeta): Id<'dsh'>[] {
  const isSystem = role.kind === 'system_editor' || role.kind === 'system_reader';
  const known = schema.dashboards ?? (Object.keys(role.config.dashboards) as Id<'dsh'>[]);
  return known.filter((dashboardId) => {
    const perm = role.config.dashboards[dashboardId];
    return perm === 'read_only' || (perm === undefined && isSystem);
  });
}

function rolesResolved(roles: readonly BaseRoleDef[], schema: SchemaMeta): ResolvedBaseAccess {
  const tables: EffectiveAccess['tables'] = {};
  const editFilters: InternalAccess['editFilters'] = {};
  const readFilters: InternalAccess['readFilters'] = {};
  for (const table of schema.tables) {
    const grants = roles
      .map((role) => roleTableGrant(role, table))
      .filter((grant): grant is RoleTableGrant => grant !== undefined);
    if (grants.length === 0) continue;
    const merged = unionTableGrants(grants);
    tables[table.id] = merged.access;
    readFilters[table.id] = merged.readFilter;
    if (merged.editFilter !== undefined) editFilters[table.id] = merged.editFilter;
  }

  const dashboards: EffectiveAccess['dashboards'] = {};
  for (const role of roles) {
    for (const dashboardId of roleDashboards(role, schema)) dashboards[dashboardId] = 'read_only';
  }

  const base_rule: BaseRule = {
    copy: roles.some((role) => role.config.base_rule.copy),
    download: roles.some((role) => role.config.base_rule.download),
    share_link: roles.some((role) => role.config.base_rule.share_link),
  };

  const [only] = roles;
  const role =
    roles.length === 1 && only !== undefined
      ? { id: only.id, kind: only.kind, name: only.name }
      : null;

  return {
    access: { role, is_admin: false, base_rule, tables, dashboards },
    internal: { editFilters, readFilters },
  };
}

/**
 * Resolves what a principal may do in one base (SPEC §14.1 resolution order):
 *
 * 1. Org owner/admin, base owner, admin of the base's workspace, or the
 *    `admin` system role → full access.
 * 2. A role assigned directly to the user wins over group roles.
 * 3. Otherwise the union of the user's group roles.
 * 4. No role → `null`; the caller answers `404` (being a workspace member
 *    grants nothing on its own).
 *
 * The user must be a member of the base's organization.
 */
export function resolveBaseAccess(input: ResolveBaseAccessInput): ResolvedBaseAccess | null {
  const { principal, roles, assignments, schema } = input;
  if (principal.orgRole === null) return null;
  if (
    principal.orgRole === 'owner' ||
    principal.orgRole === 'admin' ||
    principal.isBaseOwner ||
    principal.workspaceRole === 'admin'
  ) {
    return fullAccess(schema, null);
  }

  const groupIds = new Set<string>(principal.groupIds);
  const directRoleIds = new Set<string>();
  const groupRoleIds = new Set<string>();
  for (const assignment of assignments) {
    if (assignment.principalType === 'user') {
      if (assignment.principalId === principal.userId) directRoleIds.add(assignment.roleId);
    } else if (groupIds.has(assignment.principalId)) {
      groupRoleIds.add(assignment.roleId);
    }
  }
  const applicableIds = directRoleIds.size > 0 ? directRoleIds : groupRoleIds;
  // Keep the order of `roles` (their position) so results are deterministic.
  const applicable = roles.filter((role) => applicableIds.has(role.id));
  if (applicable.length === 0) return null;

  const adminRole = applicable.find((role) => role.kind === 'system_admin');
  if (adminRole !== undefined) {
    return fullAccess(schema, { id: adminRole.id, kind: adminRole.kind, name: adminRole.name });
  }
  return rolesResolved(applicable, schema);
}
