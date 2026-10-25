import {
  FieldsRepository,
  orgScope,
  TablesRepository,
  type FieldRow,
  type TableRow,
} from '@cellhive/server-core';
import { Inject, Injectable } from '@nestjs/common';

import {
  AccessService,
  notFound,
  permissionDenied,
  type BaseAccess,
} from '../access/access.service.js';

import type { Principal } from '../auth/principal.js';
import type { Id } from '@cellhive/contracts';
import type { EffectiveAccess } from '@cellhive/permissions';

/** `read`: see it; `manage`: change the schema (SPEC §14.1). */
export type SchemaAccessLevel = 'read' | 'manage';

export interface TableAccessResult {
  readonly base: BaseAccess;
  readonly table: TableRow;
}

export interface FieldAccessResult extends TableAccessResult {
  readonly field: FieldRow;
}

/**
 * Who may change the schema of a table (SPEC §14.1): base admins (owner,
 * workspace admin and organization owner/admin resolve to admin) and roles
 * with `perm = manage` on the table.
 */
export function canManageTable(access: EffectiveAccess, tableId: Id<'tbl'>): boolean {
  return access.is_admin || access.tables[tableId]?.perm === 'manage';
}

/**
 * Resolves tables and fields named in a route (`/tables/:tableId`,
 * `/fields/:fieldId`) together with the caller's access to their base.
 * Something the caller cannot see — missing, in the trash, in another
 * organization, in a base without access, a `no_perm` table or field — is
 * `404 NOT_FOUND`; something visible without schema rights for `manage` is
 * `403 PERMISSION_DENIED` (AGENTS.md rule 4).
 */
@Injectable()
export class SchemaAccess {
  constructor(
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(TablesRepository) private readonly tables: TablesRepository,
    @Inject(FieldsRepository) private readonly fields: FieldsRepository,
  ) {}

  /** A table of the caller's organizations (trash included on request), with its base access. */
  private async locateTable(
    principal: Principal,
    tableId: Id<'tbl'>,
    includeDeleted: boolean,
  ): Promise<TableAccessResult | undefined> {
    for (const membership of await this.access.memberships(principal)) {
      const table = await this.tables.getById(orgScope(membership.organizationId), tableId, {
        includeDeleted,
      });
      if (table === undefined) continue;
      const base = await this.access.findBase(principal, table.base_id);
      return base === undefined ? undefined : { base, table };
    }
    return undefined;
  }

  async requireTable(
    principal: Principal,
    tableId: Id<'tbl'>,
    level: SchemaAccessLevel,
  ): Promise<TableAccessResult> {
    const found = await this.locateTable(principal, tableId, false);
    if (found?.base.access.tables[tableId] === undefined) throw notFound();
    if (level === 'manage' && !canManageTable(found.base.access, tableId)) {
      throw permissionDenied('Changing this table needs schema rights on it.');
    }
    return found;
  }

  /**
   * A table in the trash (or live), for base admins only: nobody else sees
   * trashed tables, so they get `404`; someone who sees the live table gets
   * `403`. Purged tables are missing (`404`).
   */
  async requireTrashedTableAdmin(
    principal: Principal,
    tableId: Id<'tbl'>,
    denied = 'Only base admins can restore tables.',
  ): Promise<TableAccessResult> {
    const found = await this.locateTable(principal, tableId, true);
    if (found === undefined) throw notFound();
    const visible = found.base.access.tables[tableId] !== undefined;
    if (!found.base.access.is_admin) {
      if (visible) throw permissionDenied(denied);
      throw notFound();
    }
    return found;
  }

  /**
   * A field in the trash for someone with schema rights on its (live) table
   * (ADR-23 §3). Nobody else sees deleted fields, so they get `404`, as do
   * fields whose table is gone or not visible.
   */
  async requireDeletedFieldManager(
    principal: Principal,
    fieldId: Id<'fld'>,
  ): Promise<FieldAccessResult> {
    for (const membership of await this.access.memberships(principal)) {
      const field = await this.fields.getById(orgScope(membership.organizationId), fieldId, {
        includeDeleted: true,
      });
      if (field === undefined) continue;
      const found = await this.locateTable(principal, field.table_id, false);
      if (
        found?.base.access.tables[field.table_id] === undefined ||
        !canManageTable(found.base.access, field.table_id)
      ) {
        throw notFound();
      }
      return { ...found, field };
    }
    throw notFound();
  }

  async requireField(
    principal: Principal,
    fieldId: Id<'fld'>,
    level: SchemaAccessLevel,
  ): Promise<FieldAccessResult> {
    for (const membership of await this.access.memberships(principal)) {
      const field = await this.fields.getById(orgScope(membership.organizationId), fieldId);
      if (field === undefined) continue;
      const found = await this.locateTable(principal, field.table_id, false);
      const tableAccess = found?.base.access.tables[field.table_id];
      if (found === undefined || tableAccess?.fields[fieldId] === undefined) throw notFound();
      if (level === 'manage' && !canManageTable(found.base.access, field.table_id)) {
        throw permissionDenied('Changing this field needs schema rights on its table.');
      }
      return { ...found, field };
    }
    throw notFound();
  }
}
