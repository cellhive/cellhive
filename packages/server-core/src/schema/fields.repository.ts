import { sql } from 'kysely';

import {
  TenantRepository,
  type OrgScope,
  type TenantRepositoryContract,
} from '../db/repository.js';

import type { Db } from '../db/create-db.js';
import type { ComputeMode, ComputeState, FieldRow, JsonbInput, LinkSide } from '../db/schema.js';
import type { Id } from '@cellhive/contracts';

export interface InsertFieldInput {
  readonly id: Id<'fld'>;
  readonly tableId: Id<'tbl'>;
  readonly name: string;
  readonly type: string;
  readonly dbColumnName: string | null;
  readonly options: JsonbInput;
  readonly isPrimary: boolean;
  readonly required: boolean;
  readonly uniqueValues: boolean;
  readonly description: string | null;
  readonly position: number;
  /** `link` fields: junction table name and side (SPEC §5.6, migration 0011). */
  readonly linkJunction?: string;
  readonly linkSide?: LinkSide;
  /** Formula/lookup fields (migration 0022, T456). */
  readonly computed?: ComputedColumnsInput;
}

/** The computed-field columns of `meta.fields` (migration 0022, T456). */
export interface ComputedColumnsInput {
  readonly computeMode: ComputeMode;
  readonly resultType: JsonbInput;
  readonly computeState: ComputeState;
  readonly computeError?: JsonbInput | null;
}

export interface GetFieldOptions {
  /** Also return a field in the trash. Default `false`. */
  readonly includeDeleted?: boolean;
}

export interface UpdateFieldInput {
  readonly name?: string;
  /** Type conversion only (T403), together with `options`. */
  readonly type?: string;
  /** Type conversion from/to a type without a column of its own (T403). */
  readonly dbColumnName?: string | null;
  readonly options?: JsonbInput;
  readonly required?: boolean;
  readonly uniqueValues?: boolean;
  readonly description?: string | null;
  readonly position?: number;
  /** Soft delete (`Date` + column name) or restore (`null` + `null`). */
  readonly deletedAt?: Date | null;
  readonly deletedColumnName?: string | null;
  /**
   * Formula/lookup fields (T456): mode, result type, state, error. `null`
   * clears them (a type conversion to or from a computed type, T463).
   */
  readonly computeMode?: ComputeMode | null;
  readonly resultType?: JsonbInput | null;
  readonly computeState?: ComputeState | null;
  readonly computeError?: JsonbInput | null;
}

/**
 * `meta.fields`. Written only through `SchemaService`. Every query is scoped
 * by `organization_id`.
 */
export class FieldsRepository
  extends TenantRepository<'fields'>
  implements TenantRepositoryContract<FieldsRepository>
{
  constructor(db: Db) {
    super(db, 'fields');
  }

  async insert(scope: OrgScope, input: InsertFieldInput): Promise<FieldRow> {
    return this.executor(scope)
      .insertInto('meta.fields')
      .values({
        id: input.id,
        organization_id: scope.organizationId,
        table_id: input.tableId,
        name: input.name,
        type: input.type,
        db_column_name: input.dbColumnName,
        options: input.options,
        is_primary: input.isPrimary,
        required: input.required,
        unique_values: input.uniqueValues,
        description: input.description,
        position: input.position,
        ...(input.linkJunction === undefined
          ? {}
          : { link_junction: input.linkJunction, link_side: input.linkSide ?? null }),
        ...(input.computed === undefined
          ? {}
          : {
              compute_mode: input.computed.computeMode,
              result_type: input.computed.resultType,
              compute_state: input.computed.computeState,
              compute_error: input.computed.computeError ?? null,
            }),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async getById(
    scope: OrgScope,
    id: Id<'fld'>,
    options: GetFieldOptions = {},
  ): Promise<FieldRow | undefined> {
    let query = this.executor(scope)
      .selectFrom('meta.fields')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id);
    if (options.includeDeleted !== true) query = query.where('deleted_at', 'is', null);
    return query.executeTakeFirst();
  }

  /** Fields of a table in display order; the trash only with `includeDeleted`. */
  async listByTable(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    options: GetFieldOptions = {},
  ): Promise<FieldRow[]> {
    let query = this.executor(scope)
      .selectFrom('meta.fields')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('table_id', '=', tableId);
    if (options.includeDeleted !== true) query = query.where('deleted_at', 'is', null);
    return query.orderBy('position').orderBy('id').execute();
  }

  /**
   * Fields by id whatever their state (trash, purged included), in id order:
   * the objects a computed-field error names (T460). Ids of another
   * organization are simply not found.
   */
  async listByIds(scope: OrgScope, ids: readonly string[]): Promise<FieldRow[]> {
    if (ids.length === 0) return [];
    return this.executor(scope)
      .selectFrom('meta.fields')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('id', 'in', [...new Set(ids)] as Id<'fld'>[])
      .orderBy('id')
      .execute();
  }

  /** Fields outside the trash of several tables, by table then display order (one query). */
  async listByTables(scope: OrgScope, tableIds: readonly Id<'tbl'>[]): Promise<FieldRow[]> {
    if (tableIds.length === 0) return [];
    return this.executor(scope)
      .selectFrom('meta.fields')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('table_id', 'in', [...tableIds])
      .where('deleted_at', 'is', null)
      .orderBy('table_id')
      .orderBy('position')
      .orderBy('id')
      .execute();
  }

  /**
   * Fields outside the trash of every table of a base outside the trash, in
   * display order per table (the schema the permission model needs).
   */
  /**
   * Active `link` fields (of active tables) whose linked table is `tableId`
   * (`options.link_table`), both sides of two-way links included (T402:
   * link cells that show records of `tableId`).
   */
  async listLinksTo(scope: OrgScope, tableId: Id<'tbl'>): Promise<FieldRow[]> {
    return this.executor(scope)
      .selectFrom('meta.fields as f')
      .innerJoin('meta.tables as t', (join) =>
        join.onRef('t.id', '=', 'f.table_id').onRef('t.organization_id', '=', 'f.organization_id'),
      )
      .selectAll('f')
      .where('f.organization_id', '=', scope.organizationId)
      .where('f.type', '=', 'link')
      .where(sql<string>`f.options ->> 'link_table'`, '=', tableId)
      .where('t.deleted_at', 'is', null)
      .where('f.deleted_at', 'is', null)
      .orderBy('f.table_id')
      .orderBy('f.id')
      .execute();
  }

  async listActiveByBase(scope: OrgScope, baseId: Id<'bse'>): Promise<FieldRow[]> {
    return this.executor(scope)
      .selectFrom('meta.fields as f')
      .innerJoin('meta.tables as t', (join) =>
        join.onRef('t.id', '=', 'f.table_id').onRef('t.organization_id', '=', 'f.organization_id'),
      )
      .selectAll('f')
      .where('f.organization_id', '=', scope.organizationId)
      .where('t.base_id', '=', baseId)
      .where('t.deleted_at', 'is', null)
      .where('f.deleted_at', 'is', null)
      .orderBy('f.table_id')
      .orderBy('f.position')
      .orderBy('f.id')
      .execute();
  }

  /**
   * The link fields reading the junction `junction` (at most one per side),
   * the trash included: the two sides of a two-way link (SPEC §5.6).
   */
  async listByJunction(scope: OrgScope, junction: string): Promise<FieldRow[]> {
    return this.executor(scope)
      .selectFrom('meta.fields')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('link_junction', '=', junction)
      .orderBy('link_side')
      .execute();
  }

  /**
   * Active formula/lookup fields of the active tables of a base (the
   * `COMPUTED_FIELDS_MAX_PER_BASE` count, SPEC §9.5).
   */
  async countComputedInBase(scope: OrgScope, baseId: Id<'bse'>): Promise<number> {
    const row = await this.executor(scope)
      .selectFrom('meta.fields as f')
      .innerJoin('meta.tables as t', (join) =>
        join.onRef('t.id', '=', 'f.table_id').onRef('t.organization_id', '=', 'f.organization_id'),
      )
      .select((eb) => eb.fn.countAll<bigint>().as('count'))
      .where('f.organization_id', '=', scope.organizationId)
      .where('t.base_id', '=', baseId)
      .where('t.deleted_at', 'is', null)
      .where('f.deleted_at', 'is', null)
      .where('f.type', 'in', ['formula', 'lookup'])
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  /**
   * Active fields of `tableIds` that may be AI fields (`text`/`select` with
   * an `ai` key in `options`, T910); callers check `options.ai` itself.
   */
  async listAiCandidatesByTables(
    scope: OrgScope,
    tableIds: readonly Id<'tbl'>[],
  ): Promise<FieldRow[]> {
    if (tableIds.length === 0) return [];
    return this.executor(scope)
      .selectFrom('meta.fields')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('table_id', 'in', [...tableIds])
      .where('deleted_at', 'is', null)
      .where('type', 'in', ['text', 'select'])
      .where(sql<boolean>`jsonb_typeof(options -> 'ai') = 'object'`)
      .orderBy('id')
      .execute();
  }

  /** Fields outside the trash (the `MAX_FIELDS_PER_TABLE` count). */
  async countActive(scope: OrgScope, tableId: Id<'tbl'>): Promise<number> {
    const row = await this.executor(scope)
      .selectFrom('meta.fields')
      .select((eb) => eb.fn.countAll<bigint>().as('count'))
      .where('organization_id', '=', scope.organizationId)
      .where('table_id', '=', tableId)
      .where('deleted_at', 'is', null)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  /** Is `name` used by another field of the table outside the trash? */
  async nameTaken(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    name: string,
    exceptId?: Id<'fld'>,
  ): Promise<boolean> {
    let query = this.executor(scope)
      .selectFrom('meta.fields')
      .select('id')
      .where('organization_id', '=', scope.organizationId)
      .where('table_id', '=', tableId)
      .where('name', '=', name)
      .where('deleted_at', 'is', null);
    if (exceptId !== undefined) query = query.where('id', '<>', exceptId);
    return (await query.executeTakeFirst()) !== undefined;
  }

  async nextPosition(scope: OrgScope, tableId: Id<'tbl'>): Promise<number> {
    const row = await this.executor(scope)
      .selectFrom('meta.fields')
      .select((eb) => eb.fn.max('position').as('max'))
      .where('organization_id', '=', scope.organizationId)
      .where('table_id', '=', tableId)
      .executeTakeFirst();
    return row?.max == null ? 0 : row.max + 1;
  }

  async update(
    scope: OrgScope,
    id: Id<'fld'>,
    patch: UpdateFieldInput,
  ): Promise<FieldRow | undefined> {
    return this.executor(scope)
      .updateTable('meta.fields')
      .set({
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.type === undefined ? {} : { type: patch.type }),
        ...(patch.dbColumnName === undefined ? {} : { db_column_name: patch.dbColumnName }),
        ...(patch.options === undefined ? {} : { options: patch.options }),
        ...(patch.required === undefined ? {} : { required: patch.required }),
        ...(patch.uniqueValues === undefined ? {} : { unique_values: patch.uniqueValues }),
        ...(patch.description === undefined ? {} : { description: patch.description }),
        ...(patch.position === undefined ? {} : { position: patch.position }),
        ...(patch.deletedAt === undefined ? {} : { deleted_at: patch.deletedAt }),
        ...(patch.deletedColumnName === undefined
          ? {}
          : { deleted_column_name: patch.deletedColumnName }),
        ...(patch.computeMode === undefined ? {} : { compute_mode: patch.computeMode }),
        ...(patch.resultType === undefined ? {} : { result_type: patch.resultType }),
        ...(patch.computeState === undefined ? {} : { compute_state: patch.computeState }),
        ...(patch.computeError === undefined ? {} : { compute_error: patch.computeError }),
      })
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
  }

  /**
   * Sets `position` of several fields of a table (display order). Rows of
   * other tables or organizations are left alone.
   */
  async setPositions(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    positions: readonly { readonly id: Id<'fld'>; readonly position: number }[],
  ): Promise<void> {
    for (const { id, position } of positions) {
      await this.executor(scope)
        .updateTable('meta.fields')
        .set({ position })
        .where('organization_id', '=', scope.organizationId)
        .where('table_id', '=', tableId)
        .where('id', '=', id)
        .execute();
    }
  }

  /**
   * Every `link` field touching `tableId`, whatever its state (trash and
   * purged included): the fields of the table itself and the fields of other
   * tables whose linked table it is (one-way links and reverse fields of
   * two-way links). The purge of the table (T461) drops their junctions.
   */
  async listLinksTouching(scope: OrgScope, tableId: Id<'tbl'>): Promise<FieldRow[]> {
    return this.executor(scope)
      .selectFrom('meta.fields')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('type', '=', 'link')
      .where((eb) =>
        eb.or([
          eb('table_id', '=', tableId),
          eb(sql<string>`options ->> 'link_table'`, '=', tableId),
        ]),
      )
      .orderBy('table_id')
      .orderBy('id')
      .execute();
  }

  /**
   * The purge of `tableId` (T461): its fields other than the primary one go
   * to the trash (if not there yet) and are marked purged. Returns the ids
   * marked.
   */
  async markTablePurged(scope: OrgScope, tableId: Id<'tbl'>, at: Date): Promise<Id<'fld'>[]> {
    const rows = await this.executor(scope)
      .updateTable('meta.fields')
      .set({ deleted_at: sql<Date>`coalesce(deleted_at, ${at})`, purged_at: at })
      .where('organization_id', '=', scope.organizationId)
      .where('table_id', '=', tableId)
      .where('is_primary', '=', false)
      .where('purged_at', 'is', null)
      .returning('id')
      .execute();
    return rows.map((row) => row.id);
  }

  /**
   * `link` fields of other tables pointing at a purged table (T461): put in
   * the trash (if not there yet) with `link_table_purged_at`, so they can no
   * longer be restored. Returns the rows as they are now.
   */
  async markLinkTablePurged(
    scope: OrgScope,
    fieldIds: readonly Id<'fld'>[],
    at: Date,
  ): Promise<FieldRow[]> {
    if (fieldIds.length === 0) return [];
    return this.executor(scope)
      .updateTable('meta.fields')
      .set({ deleted_at: sql<Date>`coalesce(deleted_at, ${at})`, link_table_purged_at: at })
      .where('organization_id', '=', scope.organizationId)
      .where('id', 'in', [...fieldIds])
      .where('type', '=', 'link')
      .where('purged_at', 'is', null)
      .where('link_table_purged_at', 'is', null)
      .returningAll()
      .execute();
  }

  /**
   * Marks deleted fields of the table as purged (compaction dropped their
   * columns); returns the ids actually marked.
   */
  async markPurged(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    fieldIds: readonly Id<'fld'>[],
  ): Promise<Id<'fld'>[]> {
    if (fieldIds.length === 0) return [];
    const rows = await this.executor(scope)
      .updateTable('meta.fields')
      .set({ purged_at: sql<Date>`now()` })
      .where('organization_id', '=', scope.organizationId)
      .where('table_id', '=', tableId)
      .where('id', 'in', fieldIds)
      .where('deleted_at', 'is not', null)
      .where('purged_at', 'is', null)
      .returning('id')
      .execute();
    return rows.map((row) => row.id);
  }
}
