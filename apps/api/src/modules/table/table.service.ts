import {
  AuditLogsRepository,
  FieldsRepository,
  SchemaService,
  TablesRepository,
  type Db,
} from '@cellhive/server-core';
import { Inject, Injectable } from '@nestjs/common';

import { notFound, permissionDenied, type BaseAccess } from '../../common/access/access.service.js';
import { mutationContextOf } from '../../common/access/change-log.js';
import { SchemaAccess } from '../../common/schema/schema-access.js';
import { pageOf, tableDtoOf } from '../../common/schema/schema-dto.js';
import { DB } from '../../common/tokens.js';
import { computedDependentsOf } from '../field/computed-fields.js';

import { listTableTrash } from './table-trash.js';

import type { Principal } from '../../common/auth/principal.js';
import type { RequestMeta } from '../../common/auth/request-meta.js';
import type {
  CreateTableRequest,
  DeletePreview,
  Id,
  OffsetQuery,
  PurgedTableResponse,
  PurgeTableRequest,
  TableDto,
  TableList,
  TrashedTableList,
  UpdateTableRequest,
} from '@cellhive/contracts';

/** Name of the primary field when the request leaves it out. */
export const DEFAULT_PRIMARY_FIELD_NAME = 'Name';

/**
 * Tables (SPEC §5.3–5.5, §13.1; BACKLOG T103). Base admins create and
 * restore tables; base admins and roles with `manage` on a table change or
 * delete it. Every DDL and meta change goes through `SchemaService`, which
 * writes the `table.*` event and audit entry, bumps the base
 * `permission_version` when the set of tables changes and publishes
 * `schema.changed` after commit.
 */
@Injectable()
export class TableService {
  constructor(
    @Inject(SchemaService) private readonly schema: SchemaService,
    @Inject(SchemaAccess) private readonly schemaAccess: SchemaAccess,
    @Inject(TablesRepository) private readonly tables: TablesRepository,
    @Inject(DB) private readonly db: Db,
    @Inject(FieldsRepository) private readonly fields: FieldsRepository,
    @Inject(AuditLogsRepository) private readonly auditLogs: AuditLogsRepository,
  ) {}

  /**
   * `GET /bases/:baseId/tables/trash` (T469, CONTRACTS §13): base admins
   * only — tables in the trash are theirs to restore or purge; others who
   * read the base get `403`.
   */
  async listTrash(base: BaseAccess): Promise<TrashedTableList> {
    if (!base.access.is_admin) {
      throw permissionDenied('Only base admins can see the tables in the trash.');
    }
    return listTableTrash(
      { db: this.db, tables: this.tables, fields: this.fields, auditLogs: this.auditLogs },
      base,
    );
  }

  /** Tables of the base the caller can see (`no_perm` tables are left out). */
  async list(base: BaseAccess, query: OffsetQuery): Promise<TableList> {
    const rows = await this.tables.listByBase(base.org.scope, base.base.id);
    const visible = rows.filter((table) => base.access.tables[table.id] !== undefined);
    return pageOf(visible, query, tableDtoOf);
  }

  async create(
    principal: Principal,
    base: BaseAccess,
    input: CreateTableRequest,
    meta: RequestMeta,
  ): Promise<TableDto> {
    if (!base.access.is_admin) throw permissionDenied('Only base admins can create tables.');
    const { table } = await this.schema.createTable(
      base.org.scope,
      {
        baseId: base.base.id,
        name: input.name,
        primaryFieldName: input.primary_field_name ?? DEFAULT_PRIMARY_FIELD_NAME,
        description: input.description ?? null,
      },
      mutationContextOf(meta, principal.userId),
    );
    return tableDtoOf(table);
  }

  async get(principal: Principal, tableId: Id<'tbl'>): Promise<TableDto> {
    const { table } = await this.schemaAccess.requireTable(principal, tableId, 'read');
    return tableDtoOf(table);
  }

  async update(
    principal: Principal,
    tableId: Id<'tbl'>,
    input: UpdateTableRequest,
    meta: RequestMeta,
  ): Promise<TableDto> {
    const { base } = await this.schemaAccess.requireTable(principal, tableId, 'manage');
    const table = await this.schema.updateTable(
      base.org.scope,
      tableId,
      {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.position === undefined ? {} : { position: input.position }),
      },
      mutationContextOf(meta, principal.userId),
    );
    return tableDtoOf(table);
  }

  /**
   * `GET /tables/:id/delete-preview` (T460, CONTRACTS §13): who may delete
   * may look (base admins; others who see the table `403`); lists the
   * formula/lookup fields of other tables the caller reads that would be
   * `REF`. Changes nothing.
   */
  async deletePreview(principal: Principal, tableId: Id<'tbl'>): Promise<DeletePreview> {
    const { base } = await this.schemaAccess.requireTable(principal, tableId, 'manage');
    if (!base.access.is_admin) {
      throw permissionDenied('Only base admins can delete tables.');
    }
    return {
      dependents: await computedDependentsOf(this.db, base, { kind: 'delete_table', tableId }),
    };
  }

  async delete(principal: Principal, tableId: Id<'tbl'>, meta: RequestMeta): Promise<void> {
    const { base } = await this.schemaAccess.requireTable(principal, tableId, 'manage');
    // Deleting a whole table is reserved for base admins; `manage` only edits it.
    if (!base.access.is_admin) {
      throw permissionDenied('Only base admins can delete tables.');
    }
    await this.schema.deleteTable(
      base.org.scope,
      tableId,
      mutationContextOf(meta, principal.userId),
    );
  }

  async restore(principal: Principal, tableId: Id<'tbl'>, meta: RequestMeta): Promise<TableDto> {
    const { base } = await this.schemaAccess.requireTrashedTableAdmin(principal, tableId);
    const table = await this.schema.restoreTable(
      base.org.scope,
      tableId,
      mutationContextOf(meta, principal.userId),
    );
    return tableDtoOf(table);
  }

  /**
   * Deletes a table of the trash for good (T461, CONTRACTS §13): base admins
   * only (someone who sees the live table: `403`; anyone else, a purged or
   * missing table: `404`), confirmed by the table name. Link fields of other
   * tables pointing at it go to the trash for good (`LINK_TABLE_PURGED`).
   */
  async purge(
    principal: Principal,
    tableId: Id<'tbl'>,
    input: PurgeTableRequest,
    meta: RequestMeta,
  ): Promise<PurgedTableResponse> {
    const { base } = await this.schemaAccess.requireTrashedTableAdmin(
      principal,
      tableId,
      'Only base admins can delete tables permanently.',
    );
    const purged = await this.schema.purgeTable(
      base.org.scope,
      tableId,
      { reason: 'manual', confirmName: input.confirm_name },
      mutationContextOf(meta, principal.userId),
    );
    // A manual purge never answers `null` (only the retention job skips tables).
    if (purged === null) throw notFound();
    return {
      id: purged.table.id,
      name: purged.table.name,
      record_count: purged.recordCount,
      partner_field_ids: [...purged.partnerFieldIds],
    };
  }
}
