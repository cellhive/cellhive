import { sql } from 'kysely';

import {
  TenantRepository,
  type OrgScope,
  type TenantRepositoryContract,
} from '../db/repository.js';

import type { Db } from '../db/create-db.js';
import type { JsonObject, ViewKind, ViewRow } from '../db/schema.js';
import type { Id } from '@cellhive/contracts';

export interface InsertViewInput {
  readonly id: Id<'viw'>;
  readonly tableId: Id<'tbl'>;
  readonly type: ViewKind;
  readonly name: string;
  readonly config: JsonObject;
  readonly position: number;
  /** Owner of a personal view; `null` for a shared view. */
  readonly ownerId: Id<'usr'> | null;
}

export interface UpdateViewInput {
  readonly name?: string;
  readonly config?: JsonObject;
  readonly position?: number;
  /** `null` makes the view shared, a user id makes it that user's personal view. */
  readonly ownerId?: Id<'usr'> | null;
  readonly locked?: boolean;
}

/**
 * Which views of a table a list covers: the shared ones (`ownerId: null`) or
 * the personal views of one user.
 */
export interface ViewGroup {
  readonly ownerId: Id<'usr'> | null;
}

/**
 * `meta.views` (SPEC §5.10, §8). Every query is scoped by `organization_id`:
 * a view of another organization behaves exactly like a missing one.
 * Permission checks (`visible_views`, personal views of others) belong to
 * the callers.
 */
export class ViewsRepository
  extends TenantRepository<'views'>
  implements TenantRepositoryContract<ViewsRepository>
{
  constructor(db: Db) {
    super(db, 'views');
  }

  async insert(scope: OrgScope, input: InsertViewInput): Promise<ViewRow> {
    return this.executor(scope)
      .insertInto('meta.views')
      .values({
        id: input.id,
        organization_id: scope.organizationId,
        table_id: input.tableId,
        type: input.type,
        name: input.name,
        config: input.config,
        position: input.position,
        is_personal: input.ownerId !== null,
        owner_id: input.ownerId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * Serialises changes of the views of a table (names, counts, order) until
   * the transaction of `scope` ends.
   */
  async lockTable(scope: OrgScope, tableId: Id<'tbl'>): Promise<void> {
    if (scope.tx === undefined) throw new TypeError('lockTable needs a transaction scope');
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`views:${scope.organizationId}:${tableId}`}, 0))`.execute(
      this.executor(scope),
    );
  }

  async getById(scope: OrgScope, id: Id<'viw'>): Promise<ViewRow | undefined> {
    return this.executor(scope)
      .selectFrom('meta.views')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
  }

  /** The view row locked `FOR UPDATE` until the transaction of `scope` ends. */
  async lockById(scope: OrgScope, id: Id<'viw'>): Promise<ViewRow | undefined> {
    return this.executor(scope)
      .selectFrom('meta.views')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
  }

  /**
   * Shared views of a table, then the personal views of `ownerId` (when
   * given), each in display order.
   */
  async listByTable(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    ownerId: Id<'usr'> | null,
  ): Promise<ViewRow[]> {
    let query = this.executor(scope)
      .selectFrom('meta.views')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('table_id', '=', tableId);
    query =
      ownerId === null
        ? query.where('is_personal', '=', false)
        : query.where((eb) => eb.or([eb('is_personal', '=', false), eb('owner_id', '=', ownerId)]));
    return query.orderBy('is_personal').orderBy('position').orderBy('id').execute();
  }

  /**
   * Saved filters (`config.filter`, stored DSL) of every view of a table,
   * shared and personal, and the filters of their color rules
   * (`config.color_rules[].filter`, T816), without the `null` ones: the
   * fields they name are captured in realtime record images (T313).
   */
  async filtersByTable(scope: OrgScope, tableId: Id<'tbl'>): Promise<unknown[]> {
    const rows = await this.executor(scope)
      .selectFrom('meta.views')
      .select([
        sql`config -> 'filter'`.as('filter'),
        sql`config -> 'color_rules'`.as('color_rules'),
      ])
      .where('organization_id', '=', scope.organizationId)
      .where('table_id', '=', tableId)
      .execute();
    const filters: unknown[] = [];
    for (const row of rows) {
      if (row.filter !== null) filters.push(row.filter);
      if (!Array.isArray(row.color_rules)) continue;
      for (const rule of row.color_rules as unknown[]) {
        const filter =
          typeof rule === 'object' && rule !== null ? (rule as { filter?: unknown }).filter : null;
        if (filter !== null && filter !== undefined) filters.push(filter);
      }
    }
    return filters;
  }

  /** Views of one group (shared, or one user's personal views) of a table, in display order. */
  async listGroup(scope: OrgScope, tableId: Id<'tbl'>, group: ViewGroup): Promise<ViewRow[]> {
    let query = this.executor(scope)
      .selectFrom('meta.views')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('table_id', '=', tableId);
    query =
      group.ownerId === null
        ? query.where('is_personal', '=', false)
        : query.where('owner_id', '=', group.ownerId);
    return query.orderBy('position').orderBy('id').execute();
  }

  /** Ids of the shared views of the tables of a base (role `visible_views` checks). */
  async sharedIdsByBase(scope: OrgScope, baseId: Id<'bse'>): Promise<Map<Id<'tbl'>, Id<'viw'>[]>> {
    const rows = await this.executor(scope)
      .selectFrom('meta.views as v')
      .innerJoin('meta.tables as t', (join) =>
        join.onRef('t.id', '=', 'v.table_id').onRef('t.organization_id', '=', 'v.organization_id'),
      )
      .select(['v.id', 'v.table_id'])
      .where('v.organization_id', '=', scope.organizationId)
      .where('t.base_id', '=', baseId)
      .where('v.is_personal', '=', false)
      .orderBy('v.id')
      .execute();
    const byTable = new Map<Id<'tbl'>, Id<'viw'>[]>();
    for (const row of rows) {
      const list = byTable.get(row.table_id) ?? [];
      list.push(row.id);
      byTable.set(row.table_id, list);
    }
    return byTable;
  }

  /** Those of `ids` that name a view (shared or personal, any table) of the organization. */
  async existingIds(scope: OrgScope, ids: readonly Id<'viw'>[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.executor(scope)
      .selectFrom('meta.views')
      .select('id')
      .where('organization_id', '=', scope.organizationId)
      .where('id', 'in', [...ids])
      .execute();
    return new Set(rows.map((row) => row.id));
  }

  /** Number of views of a table, and of `ownerId`'s personal views on it. */
  async counts(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    ownerId: Id<'usr'> | null,
  ): Promise<{ total: number; shared: number; personal: number }> {
    const row = await this.executor(scope)
      .selectFrom('meta.views')
      .select([
        sql<number>`count(*)::int`.as('total'),
        sql<number>`(count(*) FILTER (WHERE NOT is_personal))::int`.as('shared'),
        sql<number>`(count(*) FILTER (WHERE owner_id = ${ownerId}))::int`.as('personal'),
      ])
      .where('organization_id', '=', scope.organizationId)
      .where('table_id', '=', tableId)
      .executeTakeFirstOrThrow();
    return { total: row.total, shared: row.shared, personal: row.personal };
  }

  /**
   * Is `name` used (ignoring case) by another view of the same group
   * (shared views of the table, or `group.ownerId`'s personal views)?
   */
  async nameTaken(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    group: ViewGroup,
    name: string,
    exceptId?: Id<'viw'>,
  ): Promise<boolean> {
    let query = this.executor(scope)
      .selectFrom('meta.views')
      .select('id')
      .where('organization_id', '=', scope.organizationId)
      .where('table_id', '=', tableId)
      .where(sql<string>`lower(name)`, '=', sql<string>`lower(${name})`);
    query =
      group.ownerId === null
        ? query.where('is_personal', '=', false)
        : query.where('owner_id', '=', group.ownerId);
    if (exceptId !== undefined) query = query.where('id', '<>', exceptId);
    return (await query.executeTakeFirst()) !== undefined;
  }

  /** Position after the last view of the group. */
  async nextPosition(scope: OrgScope, tableId: Id<'tbl'>, group: ViewGroup): Promise<number> {
    let query = this.executor(scope)
      .selectFrom('meta.views')
      .select((eb) => eb.fn.max('position').as('max'))
      .where('organization_id', '=', scope.organizationId)
      .where('table_id', '=', tableId);
    query =
      group.ownerId === null
        ? query.where('is_personal', '=', false)
        : query.where('owner_id', '=', group.ownerId);
    const row = await query.executeTakeFirst();
    return row?.max == null ? 0 : row.max + 1;
  }

  async update(
    scope: OrgScope,
    id: Id<'viw'>,
    patch: UpdateViewInput,
  ): Promise<ViewRow | undefined> {
    const values = {
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.config === undefined ? {} : { config: patch.config }),
      ...(patch.position === undefined ? {} : { position: patch.position }),
      ...(patch.ownerId === undefined
        ? {}
        : { owner_id: patch.ownerId, is_personal: patch.ownerId !== null }),
      ...(patch.locked === undefined ? {} : { locked: patch.locked }),
    };
    if (Object.keys(values).length === 0) return this.getById(scope, id);
    return this.executor(scope)
      .updateTable('meta.views')
      .set(values)
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
  }

  /** Sets `position` of several views of a table; rows of other tables or organizations are left alone. */
  async setPositions(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    positions: readonly { readonly id: Id<'viw'>; readonly position: number }[],
  ): Promise<void> {
    for (const { id, position } of positions) {
      await this.executor(scope)
        .updateTable('meta.views')
        .set({ position })
        .where('organization_id', '=', scope.organizationId)
        .where('table_id', '=', tableId)
        .where('id', '=', id)
        .execute();
    }
  }

  /** Deletes a view; the deleted row, or `undefined` when not found. */
  async delete(scope: OrgScope, id: Id<'viw'>): Promise<ViewRow | undefined> {
    return this.executor(scope)
      .deleteFrom('meta.views')
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
  }

  /**
   * Deletes every view of a table (purge of the table, T461); returns the
   * ids deleted. Form submissions go with them (`ON DELETE CASCADE`); form
   * covers are left to `attachments.cleanup` (no view names them any more).
   */
  async deleteByTable(scope: OrgScope, tableId: Id<'tbl'>): Promise<Id<'viw'>[]> {
    const rows = await this.executor(scope)
      .deleteFrom('meta.views')
      .where('organization_id', '=', scope.organizationId)
      .where('table_id', '=', tableId)
      .returning('id')
      .execute();
    return rows.map((row) => row.id);
  }
}
