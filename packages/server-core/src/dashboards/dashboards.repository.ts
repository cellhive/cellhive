import { sql } from 'kysely';

import {
  TenantRepository,
  type OrgScope,
  type TenantRepositoryContract,
} from '../db/repository.js';

import type { Db } from '../db/create-db.js';
import type { DashboardRow, JsonbInput } from '../db/schema.js';
import type { Id } from '@cellhive/contracts';

export interface InsertDashboardInput {
  readonly id: Id<'dsh'>;
  readonly baseId: Id<'bse'>;
  readonly name: string;
  readonly icon: string | null;
  readonly description: string | null;
  readonly theme: JsonbInput;
  readonly globalFilters: JsonbInput;
  readonly position: number;
  readonly createdBy: Id<'usr'>;
}

export interface UpdateDashboardInput {
  readonly name?: string;
  readonly icon?: string | null;
  readonly description?: string | null;
  readonly theme?: JsonbInput;
  readonly globalFilters?: JsonbInput;
}

/** A dashboard with the number of its widgets. */
export type DashboardWithCount = DashboardRow & { readonly widget_count: number };

/** A dashboard of the trash, with who deleted it. */
export type TrashedDashboardRow = DashboardWithCount & {
  readonly deleted_by_name: string | null;
};

/**
 * `meta.dashboards` (SPEC §5.10, §10; T805). Every query is scoped by
 * `organization_id`: a dashboard of another organization behaves exactly
 * like a missing one. Reads skip the trash unless they say otherwise;
 * permission checks belong to the callers.
 */
export class DashboardsRepository
  extends TenantRepository<'dashboards'>
  implements TenantRepositoryContract<DashboardsRepository>
{
  constructor(db: Db) {
    super(db, 'dashboards');
  }

  async insert(scope: OrgScope, input: InsertDashboardInput): Promise<DashboardRow> {
    return this.executor(scope)
      .insertInto('meta.dashboards')
      .values({
        id: input.id,
        organization_id: scope.organizationId,
        base_id: input.baseId,
        name: input.name,
        icon: input.icon,
        description: input.description,
        theme: input.theme,
        global_filters: input.globalFilters,
        position: input.position,
        created_by: input.createdBy,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * Serialises changes of the dashboard list of a base (names, count,
   * order) until the transaction of `scope` ends.
   */
  async lockBase(scope: OrgScope, baseId: Id<'bse'>): Promise<void> {
    if (scope.tx === undefined) throw new TypeError('lockBase needs a transaction scope');
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`dashboards:${scope.organizationId}:${baseId}`}, 0))`.execute(
      this.executor(scope),
    );
  }

  /** A dashboard outside the trash (or in it with `includeDeleted`). */
  async getById(
    scope: OrgScope,
    id: Id<'dsh'>,
    options: { readonly includeDeleted?: boolean } = {},
  ): Promise<DashboardRow | undefined> {
    let query = this.executor(scope)
      .selectFrom('meta.dashboards')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id);
    if (options.includeDeleted !== true) query = query.where('deleted_at', 'is', null);
    return query.executeTakeFirst();
  }

  /** The row locked `FOR UPDATE` (trash included) until the transaction of `scope` ends. */
  async lockById(scope: OrgScope, id: Id<'dsh'>): Promise<DashboardRow | undefined> {
    return this.executor(scope)
      .selectFrom('meta.dashboards')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
  }

  /** Dashboards of a base outside the trash, by position, with their widget counts. */
  async listByBase(scope: OrgScope, baseId: Id<'bse'>): Promise<DashboardWithCount[]> {
    return this.executor(scope)
      .selectFrom('meta.dashboards as d')
      .selectAll('d')
      .select((eb) =>
        eb
          .selectFrom('meta.dashboard_widgets as w')
          .select(sql<number>`count(*)::int`.as('count'))
          .whereRef('w.organization_id', '=', 'd.organization_id')
          .whereRef('w.dashboard_id', '=', 'd.id')
          .as('widget_count'),
      )
      .where('d.organization_id', '=', scope.organizationId)
      .where('d.base_id', '=', baseId)
      .where('d.deleted_at', 'is', null)
      .orderBy('d.position')
      .orderBy('d.id')
      .$castTo<DashboardWithCount>()
      .execute();
  }

  /** Ids of the dashboards of a base outside the trash (permission resolution). */
  async activeIdsByBase(scope: OrgScope, baseId: Id<'bse'>): Promise<Id<'dsh'>[]> {
    const rows = await this.executor(scope)
      .selectFrom('meta.dashboards')
      .select('id')
      .where('organization_id', '=', scope.organizationId)
      .where('base_id', '=', baseId)
      .where('deleted_at', 'is', null)
      .orderBy('position')
      .orderBy('id')
      .execute();
    return rows.map((row) => row.id);
  }

  /** Dashboards of a base in the trash, most recently deleted first. */
  async listTrash(scope: OrgScope, baseId: Id<'bse'>): Promise<TrashedDashboardRow[]> {
    return this.executor(scope)
      .selectFrom('meta.dashboards as d')
      .leftJoin('meta.users as u', 'u.id', 'd.deleted_by')
      .selectAll('d')
      .select('u.display_name as deleted_by_name')
      .select((eb) =>
        eb
          .selectFrom('meta.dashboard_widgets as w')
          .select(sql<number>`count(*)::int`.as('count'))
          .whereRef('w.organization_id', '=', 'd.organization_id')
          .whereRef('w.dashboard_id', '=', 'd.id')
          .as('widget_count'),
      )
      .where('d.organization_id', '=', scope.organizationId)
      .where('d.base_id', '=', baseId)
      .where('d.deleted_at', 'is not', null)
      .orderBy('d.deleted_at', 'desc')
      .orderBy('d.id')
      .$castTo<TrashedDashboardRow>()
      .execute();
  }

  /** Dashboards of a base outside the trash. */
  async countActive(scope: OrgScope, baseId: Id<'bse'>): Promise<number> {
    const row = await this.executor(scope)
      .selectFrom('meta.dashboards')
      .select(sql<number>`count(*)::int`.as('count'))
      .where('organization_id', '=', scope.organizationId)
      .where('base_id', '=', baseId)
      .where('deleted_at', 'is', null)
      .executeTakeFirstOrThrow();
    return row.count;
  }

  /** Is `name` used (ignoring case) by another dashboard of the base outside the trash? */
  async nameTaken(
    scope: OrgScope,
    baseId: Id<'bse'>,
    name: string,
    exceptId?: Id<'dsh'>,
  ): Promise<boolean> {
    let query = this.executor(scope)
      .selectFrom('meta.dashboards')
      .select('id')
      .where('organization_id', '=', scope.organizationId)
      .where('base_id', '=', baseId)
      .where('deleted_at', 'is', null)
      .where(sql<string>`lower(name)`, '=', sql<string>`lower(${name})`);
    if (exceptId !== undefined) query = query.where('id', '<>', exceptId);
    return (await query.executeTakeFirst()) !== undefined;
  }

  /** Position after the last dashboard of the base outside the trash. */
  async nextPosition(scope: OrgScope, baseId: Id<'bse'>): Promise<number> {
    const row = await this.executor(scope)
      .selectFrom('meta.dashboards')
      .select((eb) => eb.fn.max('position').as('max'))
      .where('organization_id', '=', scope.organizationId)
      .where('base_id', '=', baseId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return row?.max == null ? 0 : row.max + 1;
  }

  /**
   * Changes settings and bumps `version` (also with an empty patch: a change
   * of its layout or widgets). `undefined` when not found or in the trash.
   */
  async update(
    scope: OrgScope,
    id: Id<'dsh'>,
    patch: UpdateDashboardInput,
  ): Promise<DashboardRow | undefined> {
    return this.executor(scope)
      .updateTable('meta.dashboards')
      .set({
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.icon === undefined ? {} : { icon: patch.icon }),
        ...(patch.description === undefined ? {} : { description: patch.description }),
        ...(patch.theme === undefined ? {} : { theme: patch.theme }),
        ...(patch.globalFilters === undefined ? {} : { global_filters: patch.globalFilters }),
        version: sql<number>`version + 1`,
      })
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .returningAll()
      .executeTakeFirst();
  }

  /** Sets `position` of dashboards of a base; rows of other bases or organizations are left alone. */
  async setPositions(
    scope: OrgScope,
    baseId: Id<'bse'>,
    positions: readonly { readonly id: Id<'dsh'>; readonly position: number }[],
  ): Promise<void> {
    for (const { id, position } of positions) {
      await this.executor(scope)
        .updateTable('meta.dashboards')
        .set({ position })
        .where('organization_id', '=', scope.organizationId)
        .where('base_id', '=', baseId)
        .where('id', '=', id)
        .where('position', '<>', position)
        .execute();
    }
  }

  /** Moves a dashboard to the trash (bumps `version`); `undefined` when not found or already there. */
  async softDelete(
    scope: OrgScope,
    id: Id<'dsh'>,
    deletedBy: Id<'usr'>,
  ): Promise<DashboardRow | undefined> {
    return this.executor(scope)
      .updateTable('meta.dashboards')
      .set({
        deleted_at: sql<Date>`now()`,
        deleted_by: deletedBy,
        version: sql<number>`version + 1`,
      })
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .returningAll()
      .executeTakeFirst();
  }

  /**
   * Takes a dashboard out of the trash at `position` (bumps `version`);
   * `undefined` when not found or not in the trash.
   */
  async restore(
    scope: OrgScope,
    id: Id<'dsh'>,
    position: number,
  ): Promise<DashboardRow | undefined> {
    return this.executor(scope)
      .updateTable('meta.dashboards')
      .set({
        deleted_at: null,
        deleted_by: null,
        position,
        version: sql<number>`version + 1`,
      })
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .where('deleted_at', 'is not', null)
      .returningAll()
      .executeTakeFirst();
  }
}
