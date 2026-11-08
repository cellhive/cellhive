import {
  BASE_EXPORT_JOB_TYPE,
  BASE_EXPORT_REQUEST_SCOPES,
  type BaseExportRequest,
  type Id,
  type JobAccepted,
} from '@cellhive/contracts';
import {
  AuditWriter,
  AutomationsRepository,
  BaseRolesRepository,
  DashboardsRepository,
  enqueue,
  FieldsRepository,
  JobsRepository,
  TablesRepository,
  ViewsRepository,
  withTxScope,
  type AuditContext,
  type Db,
  type OrgScope,
} from '@cellhive/server-core';
import { Inject, Injectable } from '@nestjs/common';

import { AccessService, notFound, permissionDenied } from '../../common/access/access.service.js';
import { auditContextOf, type RequestMeta } from '../../common/auth/request-meta.js';
import { requireTokenScopes } from '../../common/auth/scope.guard.js';
import { DB } from '../../common/tokens.js';

import type { Principal } from '../../common/auth/principal.js';

const auditWriter = new AuditWriter();

/** What the base holds when its export starts (the `base.exported` audit entry: counts only). */
export interface BaseExportStartCounts {
  readonly tables: number;
  readonly fields: number;
  readonly views: number;
  readonly dashboards: number;
  readonly automations: number;
  readonly roles: number;
}

async function startCounts(
  db: Db,
  scope: OrgScope,
  baseId: Id<'bse'>,
): Promise<BaseExportStartCounts> {
  const tables = await new TablesRepository(db).listByBase(scope, baseId);
  const live = new Set<string>(tables.map((table) => table.id));
  const [fields, views, dashboards, automations, roles] = await Promise.all([
    new FieldsRepository(db).listActiveByBase(scope, baseId),
    new ViewsRepository(db).sharedIdsByBase(scope, baseId),
    new DashboardsRepository(db).countActive(scope, baseId),
    new AutomationsRepository(db).listPage(scope, baseId, {}, { offset: 0, limit: 1 }),
    new BaseRolesRepository(db).listByBase(scope, baseId),
  ]);
  return {
    tables: tables.length,
    fields: fields.length,
    views: [...views].reduce(
      (sum, [tableId, ids]) => sum + (live.has(tableId) ? ids.length : 0),
      0,
    ),
    dashboards,
    automations: automations.total,
    roles: roles.filter((role) => role.kind === 'custom').length,
  };
}

/**
 * Starts the export of a base (CONTRACTS §12.2): its `base.export` job row,
 * the job and `base.exported` (the counts of the base when it starts, never
 * a value) in one transaction. Shared by the route and the CLI
 * (`cellhive base export`, `createdBy` = `null`). The caller checked the
 * base and the permission.
 */
export async function startBaseExport(
  db: Db,
  input: {
    readonly scope: OrgScope;
    readonly baseId: Id<'bse'>;
    readonly createdBy: Id<'usr'> | null;
    readonly context: AuditContext;
  },
): Promise<Id<'job'>> {
  const counts = await startCounts(db, input.scope, input.baseId);
  const jobs = new JobsRepository(db);
  return db.withTx(async (tx) => {
    const job = await jobs.create(withTxScope(input.scope, tx), {
      type: BASE_EXPORT_JOB_TYPE,
      createdBy: input.createdBy,
    });
    await enqueue(tx, 'base.export', {
      organization_id: input.scope.organizationId,
      job_id: job.id,
      base_id: input.baseId,
    });
    await auditWriter.write(tx, {
      action: 'base.exported',
      organizationId: input.scope.organizationId,
      baseId: input.baseId,
      entityType: 'job',
      entityId: job.id,
      after: { counts: { ...counts } },
      context: input.context,
    });
    return job.id;
  });
}

/**
 * `POST /bases/:id/export` (CONTRACTS §12.2, ADR-24 §3): a package holds
 * every field of every table, so only base owners/admins and organization
 * owners/admins export. A base the caller cannot open (not a member,
 * another organization, an unknown id, outside the token's `base_ids`) is
 * `404` before anything else; an API token also needs `schema:read` and
 * `automations:read` besides the route's `records:read` (`403
 * INSUFFICIENT_SCOPE` listing those it lacks); a member who is not an
 * admin of the base gets `403 PERMISSION_DENIED`.
 */
@Injectable()
export class BaseExportService {
  constructor(
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(DB) private readonly db: Db,
  ) {}

  async start(
    principal: Principal,
    baseId: Id<'bse'>,
    _body: BaseExportRequest,
    meta: RequestMeta,
  ): Promise<JobAccepted> {
    const base = await this.access.findBase(principal, baseId);
    if (base === undefined) throw notFound();
    requireTokenScopes(principal, BASE_EXPORT_REQUEST_SCOPES);
    if (!base.access.is_admin) {
      throw permissionDenied('Only base owners and admins can export a base.');
    }
    const jobId = await startBaseExport(this.db, {
      scope: base.org.scope,
      baseId,
      createdBy: principal.userId,
      context: auditContextOf(meta, { type: 'user', id: principal.userId }),
    });
    return { job_id: jobId };
  }
}
