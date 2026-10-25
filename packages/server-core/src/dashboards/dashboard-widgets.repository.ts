import { sql } from 'kysely';

import {
  TenantRepository,
  type OrgScope,
  type TenantRepositoryContract,
} from '../db/repository.js';

import type { Db } from '../db/create-db.js';
import type { DashboardWidgetKind, DashboardWidgetRow, JsonObject } from '../db/schema.js';
import type { Id } from '@cellhive/contracts';

export interface InsertWidgetInput {
  readonly id: Id<'wgt'>;
  readonly dashboardId: Id<'dsh'>;
  readonly type: DashboardWidgetKind;
  readonly title: string;
  readonly config: JsonObject;
  readonly layout: JsonObject;
}

export interface UpdateWidgetInput {
  readonly title?: string;
  readonly config?: JsonObject;
  readonly layout?: JsonObject;
}

/**
 * `meta.dashboard_widgets` (SPEC §5.10, §10; T805). Every query is scoped by
 * `organization_id`. Widgets go with their dashboard (`ON DELETE CASCADE`);
 * whether the dashboard is in the trash is the callers' check.
 */
export class DashboardWidgetsRepository
  extends TenantRepository<'dashboard_widgets'>
  implements TenantRepositoryContract<DashboardWidgetsRepository>
{
  constructor(db: Db) {
    super(db, 'dashboard_widgets');
  }

  async insert(scope: OrgScope, input: InsertWidgetInput): Promise<DashboardWidgetRow> {
    return this.executor(scope)
      .insertInto('meta.dashboard_widgets')
      .values({
        id: input.id,
        organization_id: scope.organizationId,
        dashboard_id: input.dashboardId,
        type: input.type,
        title: input.title,
        config: input.config,
        layout: input.layout,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async getById(scope: OrgScope, id: Id<'wgt'>): Promise<DashboardWidgetRow | undefined> {
    return this.executor(scope)
      .selectFrom('meta.dashboard_widgets')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
  }

  /** The dashboard of a widget (to resolve route scopes and permissions). */
  async dashboardIdOf(scope: OrgScope, id: Id<'wgt'>): Promise<Id<'dsh'> | undefined> {
    const row = await this.executor(scope)
      .selectFrom('meta.dashboard_widgets')
      .select('dashboard_id')
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
    return row?.dashboard_id;
  }

  /** Widgets of a dashboard in reading order (row, column, id). */
  async listByDashboard(scope: OrgScope, dashboardId: Id<'dsh'>): Promise<DashboardWidgetRow[]> {
    return this.executor(scope)
      .selectFrom('meta.dashboard_widgets')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('dashboard_id', '=', dashboardId)
      .orderBy(sql`(layout ->> 'y')::int`)
      .orderBy(sql`(layout ->> 'x')::int`)
      .orderBy('id')
      .execute();
  }

  async countByDashboard(scope: OrgScope, dashboardId: Id<'dsh'>): Promise<number> {
    const row = await this.executor(scope)
      .selectFrom('meta.dashboard_widgets')
      .select(sql<number>`count(*)::int`.as('count'))
      .where('organization_id', '=', scope.organizationId)
      .where('dashboard_id', '=', dashboardId)
      .executeTakeFirstOrThrow();
    return row.count;
  }

  async update(
    scope: OrgScope,
    id: Id<'wgt'>,
    patch: UpdateWidgetInput,
  ): Promise<DashboardWidgetRow | undefined> {
    const values = {
      ...(patch.title === undefined ? {} : { title: patch.title }),
      ...(patch.config === undefined ? {} : { config: patch.config }),
      ...(patch.layout === undefined ? {} : { layout: patch.layout }),
    };
    if (Object.keys(values).length === 0) return this.getById(scope, id);
    return this.executor(scope)
      .updateTable('meta.dashboard_widgets')
      .set(values)
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
  }

  /** Deletes a widget; the deleted row, or `undefined` when not found. */
  async delete(scope: OrgScope, id: Id<'wgt'>): Promise<DashboardWidgetRow | undefined> {
    return this.executor(scope)
      .deleteFrom('meta.dashboard_widgets')
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
  }
}
