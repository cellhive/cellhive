import { sql } from 'kysely';

import {
  TenantRepository,
  type OrgScope,
  type TenantRepositoryContract,
} from '../db/repository.js';

import type { Db } from '../db/create-db.js';
import type { TableRow, TableSchemaState } from '../db/schema.js';
import type { Id } from '@cellhive/contracts';

export interface InsertTableInput {
  readonly id: Id<'tbl'>;
  readonly baseId: Id<'bse'>;
  readonly name: string;
  readonly description: string | null;
  readonly dbTableName: string;
  readonly collation: string;
  readonly position: number;
}

export interface GetTableOptions {
  /**
   * Also return a table in the trash. Default `false`. A purged table
   * (T461) is never returned: its data table is gone.
   */
  readonly includeDeleted?: boolean;
}

export interface UpdateTableInput {
  readonly name?: string;
  readonly description?: string | null;
  readonly primaryFieldId?: Id<'fld'>;
  readonly position?: number;
  readonly deletedAt?: Date | null;
}

/** A table in the trash, for the `tables.purge` job (T461). */
export interface TrashedTable {
  readonly id: Id<'tbl'>;
  readonly deletedAt: Date;
}

/**
 * `meta.tables`. Written only through `SchemaService` (DDL and meta change
 * together). Every query is scoped by `organization_id`: a table of another
 * organization behaves exactly like a missing one.
 */
export class TablesRepository
  extends TenantRepository<'tables'>
  implements TenantRepositoryContract<TablesRepository>
{
  constructor(db: Db) {
    super(db, 'tables');
  }

  async insert(scope: OrgScope, input: InsertTableInput): Promise<TableRow> {
    return this.executor(scope)
      .insertInto('meta.tables')
      .values({
        id: input.id,
        organization_id: scope.organizationId,
        base_id: input.baseId,
        name: input.name,
        description: input.description,
        db_table_name: input.dbTableName,
        collation: input.collation,
        position: input.position,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async getById(
    scope: OrgScope,
    id: Id<'tbl'>,
    options: GetTableOptions = {},
  ): Promise<TableRow | undefined> {
    let query = this.executor(scope)
      .selectFrom('meta.tables')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id);
    query =
      options.includeDeleted === true
        ? query.where('purged_at', 'is', null)
        : query.where('deleted_at', 'is', null);
    return query.executeTakeFirst();
  }

  /**
   * Tables by id whatever their state (trash, purged included), in id
   * order: the objects a computed-field error names (T460). Ids of another
   * organization are simply not found.
   */
  async listByIds(scope: OrgScope, ids: readonly string[]): Promise<TableRow[]> {
    if (ids.length === 0) return [];
    return this.executor(scope)
      .selectFrom('meta.tables')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('id', 'in', [...new Set(ids)] as Id<'tbl'>[])
      .orderBy('id')
      .execute();
  }

  /** Tables of a base outside the trash, in display order. */
  async listByBase(scope: OrgScope, baseId: Id<'bse'>): Promise<TableRow[]> {
    return this.executor(scope)
      .selectFrom('meta.tables')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('base_id', '=', baseId)
      .where('deleted_at', 'is', null)
      .orderBy('position')
      .orderBy('id')
      .execute();
  }

  /**
   * Tables of a base in the trash and not purged yet, latest deletion first
   * (the base trash, T469).
   */
  async listTrashByBase(scope: OrgScope, baseId: Id<'bse'>): Promise<TableRow[]> {
    return this.executor(scope)
      .selectFrom('meta.tables')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('base_id', '=', baseId)
      .where('deleted_at', 'is not', null)
      .where('purged_at', 'is', null)
      .orderBy('deleted_at', 'desc')
      .orderBy('id')
      .execute();
  }

  /**
   * Ids of every table of the organization, trash included (purged tables
   * excluded), in id order (the `records.purge` job, T408).
   */
  async listIds(scope: OrgScope): Promise<Id<'tbl'>[]> {
    const rows = await this.executor(scope)
      .selectFrom('meta.tables')
      .select('id')
      .where('organization_id', '=', scope.organizationId)
      .where('purged_at', 'is', null)
      .orderBy('id')
      .execute();
    return rows.map((row) => row.id);
  }

  /**
   * Tables of the organization in the trash since before `before` and not
   * purged yet, oldest deletion first, at most `limit` (the `tables.purge`
   * job, T461).
   */
  async listExpiredTrash(
    scope: OrgScope,
    options: { readonly before: Date; readonly limit: number },
  ): Promise<TrashedTable[]> {
    const rows = await this.executor(scope)
      .selectFrom('meta.tables')
      .select(['id', 'deleted_at'])
      .where('organization_id', '=', scope.organizationId)
      .where('deleted_at', '<', options.before)
      .where('purged_at', 'is', null)
      .orderBy('deleted_at')
      .orderBy('id')
      .limit(options.limit)
      .execute();
    return rows.map((row) => ({ id: row.id, deletedAt: row.deleted_at as Date }));
  }

  /**
   * Marks a table of the trash purged (T461; `SchemaService` dropped its
   * data table in the same transaction). Returns the row, `undefined` when
   * it was not in the trash or already purged.
   */
  async markPurged(scope: OrgScope, id: Id<'tbl'>, at: Date): Promise<TableRow | undefined> {
    return this.executor(scope)
      .updateTable('meta.tables')
      .set({ purged_at: at })
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .where('deleted_at', 'is not', null)
      .where('purged_at', 'is', null)
      .returningAll()
      .executeTakeFirst();
  }

  /** Is `name` used by another table of the base outside the trash? */
  async nameTaken(
    scope: OrgScope,
    baseId: Id<'bse'>,
    name: string,
    exceptId?: Id<'tbl'>,
  ): Promise<boolean> {
    let query = this.executor(scope)
      .selectFrom('meta.tables')
      .select('id')
      .where('organization_id', '=', scope.organizationId)
      .where('base_id', '=', baseId)
      .where('name', '=', name)
      .where('deleted_at', 'is', null);
    if (exceptId !== undefined) query = query.where('id', '<>', exceptId);
    return (await query.executeTakeFirst()) !== undefined;
  }

  /** Position after the last table of the base (trash included, so positions never repeat). */
  async nextPosition(scope: OrgScope, baseId: Id<'bse'>): Promise<number> {
    const row = await this.executor(scope)
      .selectFrom('meta.tables')
      .select((eb) => eb.fn.max('position').as('max'))
      .where('organization_id', '=', scope.organizationId)
      .where('base_id', '=', baseId)
      .executeTakeFirst();
    return row?.max == null ? 0 : row.max + 1;
  }

  async update(
    scope: OrgScope,
    id: Id<'tbl'>,
    patch: UpdateTableInput,
  ): Promise<TableRow | undefined> {
    return this.executor(scope)
      .updateTable('meta.tables')
      .set({
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.description === undefined ? {} : { description: patch.description }),
        ...(patch.primaryFieldId === undefined ? {} : { primary_field_id: patch.primaryFieldId }),
        ...(patch.position === undefined ? {} : { position: patch.position }),
        ...(patch.deletedAt === undefined ? {} : { deleted_at: patch.deletedAt }),
      })
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
  }

  /**
   * Sets `position` of several tables of a base (display order). Rows of
   * other bases or organizations are left alone.
   */
  async setPositions(
    scope: OrgScope,
    baseId: Id<'bse'>,
    positions: readonly { readonly id: Id<'tbl'>; readonly position: number }[],
  ): Promise<void> {
    for (const { id, position } of positions) {
      await this.executor(scope)
        .updateTable('meta.tables')
        .set({ position })
        .where('organization_id', '=', scope.organizationId)
        .where('base_id', '=', baseId)
        .where('id', '=', id)
        .execute();
    }
  }

  async setSchemaState(
    scope: OrgScope,
    id: Id<'tbl'>,
    state: TableSchemaState,
  ): Promise<TableRow | undefined> {
    return this.executor(scope)
      .updateTable('meta.tables')
      .set({ schema_state: state })
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
  }

  /**
   * `data_version = data_version + 1` (SPEC §10.4): called by
   * `RecordMutationService` once per mutation, in its transaction, after the
   * record writes (the row lock is held only until commit). Returns the new
   * version, `undefined` when the table is not in the organization.
   */
  async bumpDataVersion(scope: OrgScope, id: Id<'tbl'>): Promise<bigint | undefined> {
    const row = await this.executor(scope)
      .updateTable('meta.tables')
      .set({ data_version: sql<bigint>`data_version + 1` })
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .returning('data_version')
      .executeTakeFirst();
    return row?.data_version;
  }

  /** Compaction finished (ADR-20 step 7): back to `ready`, `compacted_at = now()`. */
  async markCompacted(scope: OrgScope, id: Id<'tbl'>): Promise<TableRow | undefined> {
    return this.executor(scope)
      .updateTable('meta.tables')
      .set({ schema_state: 'ready', compacted_at: sql<Date>`now()` })
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
  }
}
