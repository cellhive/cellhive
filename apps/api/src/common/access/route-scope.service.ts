import { isId, type Id } from '@cellhive/contracts';
import {
  AutomationRunsRepository,
  AutomationsRepository,
  DashboardWidgetsRepository,
  DashboardsRepository,
  EmailIdentitiesRepository,
  FieldsRepository,
  HttpAllowlistRepository,
  IncomingWebhooksRepository,
  orgScope,
  SecretsRepository,
  ShareLinksRepository,
  TablesRepository,
  ViewsRepository,
} from '@cellhive/server-core';
import { Inject, Injectable } from '@nestjs/common';

import { AccessService, type OrgAccess } from './access.service.js';

import type { Principal } from '../auth/principal.js';

/**
 * Route parameters that name a resource of an organization, most specific
 * first: the first one present decides the scope of the request.
 */
export const SCOPE_PARAMS = [
  // Runs of an automation (T518): scoped by their automation.
  'runId',
  'automationId',
  // Widgets of a dashboard and dashboards (T805): scoped by their base, and
  // only for callers who may read the dashboard.
  'widgetId',
  'dashboardId',
  'shareLinkId',
  // Incoming webhooks (T602): scoped by their base.
  'incomingWebhookId',
  'viewId',
  'fieldId',
  'tableId',
  'baseId',
  'workspaceId',
  'groupId',
  // Sender identities (T530), secrets (T516) and HTTP allowlist entries (T600):
  // organization resources outside any base.
  'identityId',
  'secretId',
  'allowlistEntryId',
  'orgId',
] as const;
export type ScopeParam = (typeof SCOPE_PARAMS)[number];

/** Parameters whose resource lives in a base. */
export const BASE_SCOPE_PARAMS: ReadonlySet<ScopeParam> = new Set([
  'runId',
  'automationId',
  'widgetId',
  'dashboardId',
  'shareLinkId',
  'incomingWebhookId',
  'viewId',
  'fieldId',
  'tableId',
  'baseId',
]);

/** The organization (and base, when the route has one) a request acts on. */
export interface RouteScope {
  readonly org: OrgAccess;
  readonly baseId: Id<'bse'> | undefined;
}

/** The scope parameter of a route pattern (`/tables/:tableId/…` → `tableId`). */
export function scopeParamOf(path: string): ScopeParam | undefined {
  const params = new Set(
    path
      .split('/')
      .filter((segment) => segment.startsWith(':'))
      .map((segment) => segment.slice(1)),
  );
  return SCOPE_PARAMS.find((param) => params.has(param));
}

/**
 * Resolves the organization and base a request acts on from its route
 * parameters, for the cross-cutting request policies (`Idempotency-Key`,
 * rate limits). Every lookup starts from the caller's own organizations
 * (`AccessService`), and base-bound resources need access to their base: a
 * resource the caller cannot reach resolves to `undefined`, and the handler
 * then answers `404` itself. Tables and fields in the trash resolve too
 * (restore routes).
 *
 * This is not a permission check: the handler still checks what the caller
 * may do.
 */
@Injectable()
export class RouteScopeService {
  constructor(
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(TablesRepository) private readonly tables: TablesRepository,
    @Inject(FieldsRepository) private readonly fields: FieldsRepository,
    @Inject(ViewsRepository) private readonly views: ViewsRepository,
    @Inject(ShareLinksRepository) private readonly shareLinks: ShareLinksRepository,
    @Inject(AutomationsRepository) private readonly automations: AutomationsRepository,
    @Inject(AutomationRunsRepository) private readonly runs: AutomationRunsRepository,
    @Inject(EmailIdentitiesRepository) private readonly identities: EmailIdentitiesRepository,
    @Inject(SecretsRepository) private readonly secrets: SecretsRepository,
    @Inject(HttpAllowlistRepository) private readonly allowlist: HttpAllowlistRepository,
    @Inject(IncomingWebhooksRepository) private readonly hooks: IncomingWebhooksRepository,
    @Inject(DashboardsRepository) private readonly dashboards: DashboardsRepository,
    @Inject(DashboardWidgetsRepository) private readonly widgets: DashboardWidgetsRepository,
  ) {}

  /**
   * The scope of a request with these route parameters, or `undefined`
   * when the route names no organization resource or the caller cannot
   * reach it.
   */
  async resolve(
    principal: Principal,
    params: Readonly<Record<string, unknown>>,
  ): Promise<RouteScope | undefined> {
    const param = SCOPE_PARAMS.find((name) => typeof params[name] === 'string');
    if (param === undefined) return undefined;
    const value = params[param] as string;
    switch (param) {
      case 'runId':
        return isId('run', value) ? this.ofRun(principal, value) : undefined;
      case 'automationId':
        return isId('aut', value) ? this.ofAutomation(principal, value) : undefined;
      case 'widgetId':
        return isId('wgt', value) ? this.ofWidget(principal, value) : undefined;
      case 'dashboardId':
        return isId('dsh', value) ? this.ofDashboard(principal, value) : undefined;
      case 'shareLinkId':
        return isId('shl', value) ? this.ofShareLink(principal, value) : undefined;
      case 'incomingWebhookId':
        return isId('hok', value) ? this.ofIncomingWebhook(principal, value) : undefined;
      case 'viewId':
        return isId('viw', value) ? this.ofView(principal, value) : undefined;
      case 'fieldId':
        return isId('fld', value) ? this.ofField(principal, value) : undefined;
      case 'tableId':
        return isId('tbl', value) ? this.ofTable(principal, value) : undefined;
      case 'baseId':
        return isId('bse', value) ? this.ofBase(principal, value) : undefined;
      case 'workspaceId': {
        if (!isId('wsp', value)) return undefined;
        const workspace = await this.access.findWorkspace(principal, value);
        return workspace === undefined ? undefined : { org: workspace.org, baseId: undefined };
      }
      case 'groupId': {
        if (!isId('grp', value)) return undefined;
        const group = await this.access.findGroup(principal, value);
        return group === undefined ? undefined : { org: group.org, baseId: undefined };
      }
      case 'identityId':
        return isId('eid', value) ? this.ofIdentity(principal, value) : undefined;
      case 'secretId':
        return isId('sec', value) ? this.ofSecret(principal, value) : undefined;
      case 'allowlistEntryId':
        return isId('hal', value) ? this.ofAllowlistEntry(principal, value) : undefined;
      case 'orgId': {
        if (!isId('org', value)) return undefined;
        const org = await this.access.findOrg(principal, value);
        return org === undefined ? undefined : { org, baseId: undefined };
      }
    }
  }

  /**
   * The caller's oldest organization: the scope of requests that act on no
   * existing organization (`POST /orgs`). `undefined` without any.
   */
  async home(principal: Principal): Promise<RouteScope | undefined> {
    const [first] = await this.access.memberships(principal);
    if (first === undefined) return undefined;
    const org = await this.access.findOrg(principal, first.organizationId);
    return org === undefined ? undefined : { org, baseId: undefined };
  }

  private async ofBase(principal: Principal, baseId: Id<'bse'>): Promise<RouteScope | undefined> {
    const base = await this.access.findBase(principal, baseId);
    return base === undefined ? undefined : { org: base.org, baseId: base.base.id };
  }

  private async ofTable(principal: Principal, tableId: Id<'tbl'>): Promise<RouteScope | undefined> {
    for (const membership of await this.access.memberships(principal)) {
      const table = await this.tables.getById(orgScope(membership.organizationId), tableId, {
        includeDeleted: true,
      });
      if (table !== undefined) return this.ofBase(principal, table.base_id);
    }
    return undefined;
  }

  private async ofView(principal: Principal, viewId: Id<'viw'>): Promise<RouteScope | undefined> {
    for (const membership of await this.access.memberships(principal)) {
      const view = await this.views.getById(orgScope(membership.organizationId), viewId);
      if (view !== undefined) return this.ofTable(principal, view.table_id);
    }
    return undefined;
  }

  /**
   * A dashboard (trash included) the caller may read: base admins read
   * every one, others only those of their access outside the trash
   * (SPEC §10).
   */
  private async ofDashboard(
    principal: Principal,
    dashboardId: Id<'dsh'>,
  ): Promise<RouteScope | undefined> {
    for (const membership of await this.access.memberships(principal)) {
      const dashboard = await this.dashboards.getById(
        orgScope(membership.organizationId),
        dashboardId,
        { includeDeleted: true },
      );
      if (dashboard === undefined) continue;
      const base = await this.access.findBase(principal, dashboard.base_id);
      if (base === undefined) return undefined;
      const readable =
        base.access.is_admin ||
        (dashboard.deleted_at === null && base.access.dashboards[dashboardId] === 'read_only');
      return readable ? { org: base.org, baseId: base.base.id } : undefined;
    }
    return undefined;
  }

  private async ofWidget(
    principal: Principal,
    widgetId: Id<'wgt'>,
  ): Promise<RouteScope | undefined> {
    for (const membership of await this.access.memberships(principal)) {
      const dashboardId = await this.widgets.dashboardIdOf(
        orgScope(membership.organizationId),
        widgetId,
      );
      if (dashboardId !== undefined) return this.ofDashboard(principal, dashboardId);
    }
    return undefined;
  }

  private async ofShareLink(
    principal: Principal,
    shareLinkId: Id<'shl'>,
  ): Promise<RouteScope | undefined> {
    for (const membership of await this.access.memberships(principal)) {
      const link = await this.shareLinks.getById(orgScope(membership.organizationId), shareLinkId);
      if (link !== undefined) return this.ofBase(principal, link.base_id);
    }
    return undefined;
  }

  private async ofIncomingWebhook(
    principal: Principal,
    hookId: Id<'hok'>,
  ): Promise<RouteScope | undefined> {
    for (const membership of await this.access.memberships(principal)) {
      const hook = await this.hooks.findById(orgScope(membership.organizationId), hookId);
      if (hook !== undefined) return this.ofBase(principal, hook.base_id);
    }
    return undefined;
  }

  private async ofIdentity(
    principal: Principal,
    identityId: Id<'eid'>,
  ): Promise<RouteScope | undefined> {
    for (const membership of await this.access.memberships(principal)) {
      const scope = orgScope(membership.organizationId);
      if ((await this.identities.findById(scope, identityId)) === undefined) continue;
      const org = await this.access.findOrg(principal, membership.organizationId);
      return org === undefined ? undefined : { org, baseId: undefined };
    }
    return undefined;
  }

  private async ofSecret(
    principal: Principal,
    secretId: Id<'sec'>,
  ): Promise<RouteScope | undefined> {
    for (const membership of await this.access.memberships(principal)) {
      const scope = orgScope(membership.organizationId);
      if ((await this.secrets.findById(scope, secretId)) === undefined) continue;
      const org = await this.access.findOrg(principal, membership.organizationId);
      return org === undefined ? undefined : { org, baseId: undefined };
    }
    return undefined;
  }

  private async ofAllowlistEntry(
    principal: Principal,
    entryId: Id<'hal'>,
  ): Promise<RouteScope | undefined> {
    for (const membership of await this.access.memberships(principal)) {
      const scope = orgScope(membership.organizationId);
      if ((await this.allowlist.findById(scope, entryId)) === undefined) continue;
      const org = await this.access.findOrg(principal, membership.organizationId);
      return org === undefined ? undefined : { org, baseId: undefined };
    }
    return undefined;
  }

  private async ofAutomation(
    principal: Principal,
    automationId: Id<'aut'>,
  ): Promise<RouteScope | undefined> {
    for (const membership of await this.access.memberships(principal)) {
      const baseId = await this.automations.baseIdOf(
        orgScope(membership.organizationId),
        automationId,
      );
      if (baseId !== undefined) return this.ofBase(principal, baseId);
    }
    return undefined;
  }

  private async ofRun(principal: Principal, runId: Id<'run'>): Promise<RouteScope | undefined> {
    for (const membership of await this.access.memberships(principal)) {
      const automationId = await this.runs.automationIdOf(
        orgScope(membership.organizationId),
        runId,
      );
      if (automationId !== undefined) return this.ofAutomation(principal, automationId);
    }
    return undefined;
  }

  private async ofField(principal: Principal, fieldId: Id<'fld'>): Promise<RouteScope | undefined> {
    for (const membership of await this.access.memberships(principal)) {
      const field = await this.fields.getById(orgScope(membership.organizationId), fieldId, {
        includeDeleted: true,
      });
      if (field !== undefined) return this.ofTable(principal, field.table_id);
    }
    return undefined;
  }
}
