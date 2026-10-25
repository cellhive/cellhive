import {
  checkLayout,
  compactLayout,
  DASHBOARD_LIMIT_EXCEEDED,
  DASHBOARD_TRASH_RETENTION_DAYS,
  DEFAULT_WIDGET_HEIGHT,
  DEFAULT_WIDGET_WIDTH,
  LAYOUT_INCOMPLETE,
  MAX_DASHBOARDS_PER_BASE,
  MAX_WIDGETS_PER_DASHBOARD,
  newId,
  placeAtBottom,
  UNKNOWN_WIDGET,
  WIDGET_LIMIT_EXCEEDED,
  type CreateDashboardRequest,
  type CreateWidgetRequest,
  type DashboardDto,
  type DashboardList,
  type DashboardSummaryDto,
  type DashboardTrash,
  type DuplicateDashboardRequest,
  type GridItem,
  type Id,
  type ProblemErrorItem,
  type UpdateDashboardLayoutRequest,
  type UpdateDashboardRequest,
  type UpdateWidgetRequest,
  type WidgetDto,
  type WidgetLayout,
} from '@cellhive/contracts';
import {
  buildWidgetConfig,
  checkGlobalFilters,
  DashboardsRepository,
  DashboardWidgetsRepository,
  duplicateDashboardName,
  FieldsRepository,
  jsonb,
  orgScope,
  publishRealtime,
  REALTIME_ENVELOPE_VERSION,
  remapWidgetIds,
  TablesRepository,
  widgetQueryOf,
  UsersRepository,
  widgetBrokenReasonOf,
  withTxScope,
  type AppConfig,
  type AuditContext,
  type DashboardRow,
  type DashboardWidgetRow,
  type Db,
  type JsonObject,
  type JsonValue,
  type OrgScope,
  type SiblingWidget,
  type Tx,
  type WidgetTableMeta,
} from '@cellhive/server-core';
import { AppError } from '@cellhive/server-core/errors';
import { Inject, Injectable } from '@nestjs/common';

import {
  AccessService,
  notFound,
  permissionDenied,
  type BaseAccess,
} from '../../common/access/access.service.js';
import { diffOf, mutationContextOf, recordChange } from '../../common/access/change-log.js';
import { settingOf } from '../../common/access/time-zone.js';
import { iso, validationFailed } from '../../common/dto.js';
import { APP_CONFIG, DB } from '../../common/tokens.js';
import { expectedVersionOf } from '../automation/automation.service.js';

import type { Principal } from '../../common/auth/principal.js';
import type { RequestMeta } from '../../common/auth/request-meta.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A dashboard the caller may act on, and the caller's access to its base. */
interface Located {
  readonly base: BaseAccess;
  readonly row: DashboardRow;
}

/** Who may do what with a dashboard (SPEC §10): `read` or base `admin`. */
type DashboardLevel = 'read' | 'admin';

function canReadDashboard(base: BaseAccess, row: DashboardRow): boolean {
  if (base.access.is_admin) return true;
  return row.deleted_at === null && base.access.dashboards[row.id] === 'read_only';
}

function cannotManage(): AppError {
  return permissionDenied('Only base owners and admins can change dashboards.');
}

function nameConflict(): AppError {
  return new AppError('NAME_CONFLICT', {
    detail: 'A dashboard with this name already exists in the base.',
    errors: [
      { path: 'name', code: 'NAME_CONFLICT', message: 'The dashboard name is already used' },
    ],
    params: { kind: 'dashboard' },
  });
}

function dashboardLimitExceeded(): AppError {
  return validationFailed(
    `A base can have at most ${String(MAX_DASHBOARDS_PER_BASE)} dashboards.`,
    { path: '', code: DASHBOARD_LIMIT_EXCEEDED, params: { limit: MAX_DASHBOARDS_PER_BASE } },
  );
}

function widgetLimitExceeded(): AppError {
  return validationFailed(
    `A dashboard can have at most ${String(MAX_WIDGETS_PER_DASHBOARD)} widgets.`,
    { path: '', code: WIDGET_LIMIT_EXCEEDED, params: { limit: MAX_WIDGETS_PER_DASHBOARD } },
  );
}

function layoutOf(row: DashboardWidgetRow): WidgetLayout {
  return row.layout as unknown as WidgetLayout;
}

function configOf(row: DashboardWidgetRow): Record<string, unknown> {
  const config = row.config;
  return typeof config === 'object' && config !== null && !Array.isArray(config) ? config : {};
}

function gridItemOf(row: DashboardWidgetRow): GridItem {
  return { id: row.id, ...layoutOf(row) };
}

/** `422` for the layout problems of `items` (`path` prefix per item), or nothing. */
function throwLayoutIssues(items: readonly GridItem[], pathOf: (id: string) => string): void {
  const issues = checkLayout(items);
  if (issues.length === 0) return;
  throw new AppError('VALIDATION_FAILED', {
    detail: 'The layout does not fit the 12-column grid or widgets overlap.',
    errors: issues.map((issue): ProblemErrorItem => ({
      path: pathOf(issue.id),
      code: issue.code,
      message:
        issue.other === undefined
          ? 'The widget does not fit the grid'
          : 'The widget overlaps another widget',
      ...(issue.other === undefined ? {} : { params: { other: issue.other } }),
    })),
  });
}

/** Settings of a dashboard as audited (never record data). */
function dashboardSnapshotOf(row: DashboardRow): JsonObject {
  return {
    name: row.name,
    icon: row.icon,
    description: row.description,
    theme: row.theme,
    global_filters: row.global_filters,
    position: row.position,
  };
}

/** A widget as audited: its configuration only. */
function widgetSnapshotOf(row: DashboardWidgetRow): JsonObject {
  return { type: row.type, title: row.title, config: row.config, layout: row.layout };
}

/**
 * Dashboards and their widgets (SPEC §10, CONTRACTS §28; BACKLOG T805).
 *
 * - Reading needs base admin, or a system editor/reader role, or a custom
 *   role with `dashboards.<id> = read_only` (resolved into
 *   `BaseAccess.access.dashboards`); anyone else gets `404`. Changing needs
 *   base admin: a reader who may see the dashboard gets `403`. The trash is
 *   for base admins only.
 * - Every change of a dashboard, its layout or its widgets runs in one
 *   transaction that locks the dashboard row, checks the expected `version`
 *   (`If-Match` or body `version`, `409 VERSION_CONFLICT`) and bumps it, and
 *   writes the event and audit entry (`dashboard.*`; before/after are
 *   configurations, never record data). Changes of the dashboard list of a
 *   base (names, count, order) also take the base's dashboard lock.
 * - Widget configs are checked against the base when saved
 *   (`buildWidgetConfig`); a widget whose table or field is deleted later
 *   keeps its config and reads as `broken`.
 */
@Injectable()
export class DashboardService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(DashboardsRepository) private readonly dashboards: DashboardsRepository,
    @Inject(DashboardWidgetsRepository) private readonly widgets: DashboardWidgetsRepository,
    @Inject(TablesRepository) private readonly tables: TablesRepository,
    @Inject(FieldsRepository) private readonly fields: FieldsRepository,
    @Inject(UsersRepository) private readonly users: UsersRepository,
  ) {}

  // --- Dashboards -------------------------------------------------------------------------

  async list(principal: Principal, baseId: Id<'bse'>): Promise<DashboardList> {
    const base = await this.access.requireBase(principal, baseId, 'read');
    const rows = await this.dashboards.listByBase(base.org.scope, baseId);
    return {
      items: rows.filter((row) => canReadDashboard(base, row)).map((row) => summaryOf(row)),
    };
  }

  async trash(principal: Principal, baseId: Id<'bse'>): Promise<DashboardTrash> {
    const base = await this.access.requireBase(principal, baseId, 'admin');
    const rows = await this.dashboards.listTrash(base.org.scope, baseId);
    return {
      items: rows.map((row) => {
        const deletedAt = row.deleted_at ?? row.updated_at;
        return {
          id: row.id,
          base_id: row.base_id,
          name: row.name,
          icon: row.icon,
          widget_count: row.widget_count,
          deleted_at: iso(deletedAt),
          deleted_by:
            row.deleted_by === null
              ? null
              : { id: row.deleted_by, name: row.deleted_by_name ?? row.deleted_by },
          purge_at: iso(new Date(deletedAt.getTime() + DASHBOARD_TRASH_RETENTION_DAYS * DAY_MS)),
        };
      }),
    };
  }

  async get(principal: Principal, dashboardId: Id<'dsh'>): Promise<DashboardDto> {
    const { base, row } = await this.locate(principal, dashboardId, 'read');
    return this.dtoOf(base, row);
  }

  async create(
    principal: Principal,
    baseId: Id<'bse'>,
    input: CreateDashboardRequest,
    meta: RequestMeta,
  ): Promise<DashboardDto> {
    const base = await this.access.requireBase(principal, baseId, 'admin');
    const globalFilters = checkGlobalFilters(input.global_filters, await this.tableMeta(base));
    const context = mutationContextOf(meta, principal.userId);
    const row = await this.db.withTx(async (tx) => {
      const scope = withTxScope(base.org.scope, tx);
      await this.dashboards.lockBase(scope, baseId);
      if ((await this.dashboards.countActive(scope, baseId)) >= MAX_DASHBOARDS_PER_BASE) {
        throw dashboardLimitExceeded();
      }
      if (await this.dashboards.nameTaken(scope, baseId, input.name)) throw nameConflict();
      const created = await this.dashboards.insert(scope, {
        id: newId('dsh'),
        baseId,
        name: input.name,
        icon: input.icon,
        description: input.description,
        theme: input.theme as JsonObject,
        globalFilters: jsonb(globalFilters as unknown as JsonValue),
        position: await this.dashboards.nextPosition(scope, baseId),
        createdBy: principal.userId,
      });
      await this.recordDashboard(tx, base, created, 'dashboard.created', context, {
        before: null,
        after: dashboardSnapshotOf(created),
      });
      return created;
    });
    return this.dtoOf(base, row);
  }

  async update(
    principal: Principal,
    dashboardId: Id<'dsh'>,
    input: UpdateDashboardRequest,
    ifMatch: string | undefined,
    meta: RequestMeta,
  ): Promise<DashboardDto> {
    const { base } = await this.locate(principal, dashboardId, 'admin');
    const globalFilters =
      input.global_filters === undefined
        ? undefined
        : checkGlobalFilters(input.global_filters, await this.tableMeta(base));
    const expected = expectedVersionOf(ifMatch, input.version);
    const context = mutationContextOf(meta, principal.userId);
    const row = await this.db.withTx(async (tx) => {
      const scope = withTxScope(base.org.scope, tx);
      const listChange = input.name !== undefined || input.position !== undefined;
      if (listChange) await this.dashboards.lockBase(scope, base.base.id);
      const before = await this.lockAt(scope, dashboardId, expected);
      if (
        input.name !== undefined &&
        (await this.dashboards.nameTaken(scope, base.base.id, input.name, dashboardId))
      ) {
        throw nameConflict();
      }
      if (input.position !== undefined) {
        await this.move(scope, base.base.id, dashboardId, input.position);
      }
      const updated = await this.dashboards.update(scope, dashboardId, {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.icon === undefined ? {} : { icon: input.icon }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.theme === undefined ? {} : { theme: input.theme as JsonObject }),
        ...(globalFilters === undefined
          ? {}
          : { globalFilters: jsonb(globalFilters as unknown as JsonValue) }),
      });
      if (updated === undefined) throw notFound();
      const beforeSnapshot = dashboardSnapshotOf(before);
      const afterSnapshot = dashboardSnapshotOf(updated);
      await this.recordDashboard(tx, base, updated, 'dashboard.updated', context, {
        before: beforeSnapshot,
        after: afterSnapshot,
        changes: diffOf(beforeSnapshot, afterSnapshot),
      });
      return updated;
    });
    return this.dtoOf(base, row);
  }

  async remove(
    principal: Principal,
    dashboardId: Id<'dsh'>,
    ifMatch: string | undefined,
    meta: RequestMeta,
  ): Promise<void> {
    const { base } = await this.locate(principal, dashboardId, 'admin');
    const expected = expectedVersionOf(ifMatch, undefined);
    const context = mutationContextOf(meta, principal.userId);
    await this.db.withTx(async (tx) => {
      const scope = withTxScope(base.org.scope, tx);
      await this.dashboards.lockBase(scope, base.base.id);
      const before = await this.lockAt(scope, dashboardId, expected);
      const deleted = await this.dashboards.softDelete(scope, dashboardId, principal.userId);
      if (deleted === undefined) throw notFound();
      await this.recordDashboard(tx, base, deleted, 'dashboard.deleted', context, {
        before: dashboardSnapshotOf(before),
        after: null,
      });
    });
  }

  async restore(
    principal: Principal,
    dashboardId: Id<'dsh'>,
    meta: RequestMeta,
  ): Promise<DashboardDto> {
    const { base } = await this.locate(principal, dashboardId, 'admin', { inTrash: true });
    const context = mutationContextOf(meta, principal.userId);
    const row = await this.db.withTx(async (tx) => {
      const scope = withTxScope(base.org.scope, tx);
      await this.dashboards.lockBase(scope, base.base.id);
      const current = await this.dashboards.lockById(scope, dashboardId);
      if (current?.deleted_at == null) throw notFound();
      if ((await this.dashboards.countActive(scope, base.base.id)) >= MAX_DASHBOARDS_PER_BASE) {
        throw dashboardLimitExceeded();
      }
      if (await this.dashboards.nameTaken(scope, base.base.id, current.name)) {
        throw nameConflict();
      }
      const restored = await this.dashboards.restore(
        scope,
        dashboardId,
        await this.dashboards.nextPosition(scope, base.base.id),
      );
      if (restored === undefined) throw notFound();
      await this.recordDashboard(tx, base, restored, 'dashboard.restored', context, {
        before: null,
        after: dashboardSnapshotOf(restored),
      });
      return restored;
    });
    return this.dtoOf(base, row);
  }

  async duplicate(
    principal: Principal,
    dashboardId: Id<'dsh'>,
    input: DuplicateDashboardRequest,
    meta: RequestMeta,
  ): Promise<DashboardDto> {
    const { base, row: source } = await this.locate(principal, dashboardId, 'admin');
    const locale = this.localeOf(principal, base);
    const context = mutationContextOf(meta, principal.userId);
    const row = await this.db.withTx(async (tx) => {
      const scope = withTxScope(base.org.scope, tx);
      await this.dashboards.lockBase(scope, base.base.id);
      if ((await this.dashboards.countActive(scope, base.base.id)) >= MAX_DASHBOARDS_PER_BASE) {
        throw dashboardLimitExceeded();
      }
      const taken = new Set(
        (await this.dashboards.listByBase(scope, base.base.id)).map((item) =>
          item.name.toLowerCase(),
        ),
      );
      let name: string;
      if (input.name === undefined) {
        name = duplicateDashboardName(source.name, locale, (candidate) =>
          taken.has(candidate.toLowerCase()),
        );
      } else {
        if (taken.has(input.name.toLowerCase())) throw nameConflict();
        name = input.name;
      }
      const created = await this.dashboards.insert(scope, {
        id: newId('dsh'),
        baseId: base.base.id,
        name,
        icon: source.icon,
        description: source.description,
        theme: source.theme as JsonObject,
        globalFilters: jsonb(source.global_filters),
        position: await this.dashboards.nextPosition(scope, base.base.id),
        createdBy: principal.userId,
      });
      const widgets = await this.widgets.listByDashboard(scope, source.id);
      const mapping = new Map<string, Id<'wgt'>>(widgets.map((item) => [item.id, newId('wgt')]));
      for (const widget of widgets) {
        await this.widgets.insert(scope, {
          id: mapping.get(widget.id) as Id<'wgt'>,
          dashboardId: created.id,
          type: widget.type,
          title: widget.title,
          config: remapWidgetIds(widget.type, configOf(widget), mapping) as JsonObject,
          layout: { ...layoutOf(widget) },
        });
      }
      await this.recordDashboard(tx, base, created, 'dashboard.duplicated', context, {
        before: null,
        after: { ...dashboardSnapshotOf(created), widget_count: widgets.length },
        data: { duplicated_from: source.id },
      });
      return created;
    });
    return this.dtoOf(base, row);
  }

  async updateLayout(
    principal: Principal,
    dashboardId: Id<'dsh'>,
    input: UpdateDashboardLayoutRequest,
    ifMatch: string | undefined,
    meta: RequestMeta,
  ): Promise<DashboardDto> {
    const { base } = await this.locate(principal, dashboardId, 'admin');
    const expected = expectedVersionOf(ifMatch, input.version);
    const context = mutationContextOf(meta, principal.userId);
    const row = await this.db.withTx(async (tx) => {
      const scope = withTxScope(base.org.scope, tx);
      await this.lockAt(scope, dashboardId, expected);
      const widgets = await this.widgets.listByDashboard(scope, dashboardId);
      const known = new Set<string>(widgets.map((widget) => widget.id));
      const errors: ProblemErrorItem[] = [];
      for (const id of Object.keys(input.layout)) {
        if (!known.has(id)) {
          errors.push({
            path: `layout.${id}`,
            code: UNKNOWN_WIDGET,
            message: 'Not a widget of this dashboard',
          });
        }
      }
      const missing = widgets.map((widget) => widget.id).filter((id) => !(id in input.layout));
      if (missing.length > 0) {
        errors.push({
          path: 'layout',
          code: LAYOUT_INCOMPLETE,
          message: 'Every widget of the dashboard needs a place',
          params: { missing },
        });
      }
      if (errors.length > 0) {
        throw new AppError('VALIDATION_FAILED', { detail: 'The layout is incomplete.', errors });
      }
      const items: GridItem[] = widgets.map((widget) => ({
        id: widget.id,
        ...(input.layout[widget.id] as WidgetLayout),
      }));
      throwLayoutIssues(items, (id) => `layout.${id}`);
      const compacted = new Map(compactLayout(items).map((item) => [item.id, item]));
      const before: JsonObject = {};
      const after: JsonObject = {};
      for (const widget of widgets) {
        const next = compacted.get(widget.id) as GridItem;
        const layout = { x: next.x, y: next.y, w: next.w, h: next.h };
        before[widget.id] = widget.layout;
        after[widget.id] = layout;
        if (JSON.stringify(layoutOf(widget)) !== JSON.stringify(layout)) {
          await this.widgets.update(scope, widget.id, { layout });
        }
      }
      const updated = await this.dashboards.update(scope, dashboardId, {});
      if (updated === undefined) throw notFound();
      await this.recordDashboard(tx, base, updated, 'dashboard.updated', context, {
        before: { layout: before },
        after: { layout: after },
        changes: diffOf({ layout: before }, { layout: after }),
      });
      return updated;
    });
    return this.dtoOf(base, row);
  }

  // --- Widgets ----------------------------------------------------------------------------

  async createWidget(
    principal: Principal,
    dashboardId: Id<'dsh'>,
    input: CreateWidgetRequest,
    ifMatch: string | undefined,
    meta: RequestMeta,
  ): Promise<WidgetDto> {
    const { base } = await this.locate(principal, dashboardId, 'admin');
    const tables = await this.tableMeta(base);
    const expected = expectedVersionOf(ifMatch, input.version);
    const context = mutationContextOf(meta, principal.userId);
    const widget = await this.db.withTx(async (tx) => {
      const scope = withTxScope(base.org.scope, tx);
      await this.lockAt(scope, dashboardId, expected);
      const others = await this.widgets.listByDashboard(scope, dashboardId);
      if (others.length >= MAX_WIDGETS_PER_DASHBOARD) throw widgetLimitExceeded();
      const id = newId('wgt');
      const config = buildWidgetConfig(input.type, input.config, {
        tables,
        siblings: siblingsOf(others),
        widgetId: id,
      });
      const layout =
        input.layout ??
        placeAtBottom(others.map(layoutOf), DEFAULT_WIDGET_WIDTH, DEFAULT_WIDGET_HEIGHT);
      throwLayoutIssues([...others.map(gridItemOf), { id, ...layout }], () => 'layout');
      const created = await this.widgets.insert(scope, {
        id,
        dashboardId,
        type: input.type,
        title: input.title,
        config: config as unknown as JsonObject,
        layout: { ...layout },
      });
      await this.bump(scope, base, dashboardId, tx);
      await this.recordWidget(tx, base, created, 'dashboard.widget_created', context, {
        before: null,
        after: widgetSnapshotOf(created),
      });
      return created;
    });
    return widgetDtoOf(base, widget, tables);
  }

  async updateWidget(
    principal: Principal,
    widgetId: Id<'wgt'>,
    input: UpdateWidgetRequest,
    ifMatch: string | undefined,
    meta: RequestMeta,
  ): Promise<WidgetDto> {
    const { base, row: dashboard } = await this.locateWidget(principal, widgetId);
    const tables = await this.tableMeta(base);
    const expected = expectedVersionOf(ifMatch, input.version);
    const context = mutationContextOf(meta, principal.userId);
    const widget = await this.db.withTx(async (tx) => {
      const scope = withTxScope(base.org.scope, tx);
      await this.lockAt(scope, dashboard.id, expected);
      const all = await this.widgets.listByDashboard(scope, dashboard.id);
      const before = all.find((item) => item.id === widgetId);
      if (before === undefined) throw notFound();
      const others = all.filter((item) => item.id !== widgetId);
      const config =
        input.config === undefined
          ? undefined
          : buildWidgetConfig(before.type, input.config, {
              tables,
              siblings: siblingsOf(others),
              widgetId,
            });
      if (input.layout !== undefined) {
        throwLayoutIssues(
          [...others.map(gridItemOf), { id: widgetId, ...input.layout }],
          () => 'layout',
        );
      }
      const updated = await this.widgets.update(scope, widgetId, {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(config === undefined ? {} : { config: config as unknown as JsonObject }),
        ...(input.layout === undefined ? {} : { layout: { ...input.layout } }),
      });
      if (updated === undefined) throw notFound();
      await this.bump(scope, base, dashboard.id, tx);
      const beforeSnapshot = widgetSnapshotOf(before);
      const afterSnapshot = widgetSnapshotOf(updated);
      await this.recordWidget(tx, base, updated, 'dashboard.widget_updated', context, {
        before: beforeSnapshot,
        after: afterSnapshot,
        changes: diffOf(beforeSnapshot, afterSnapshot),
      });
      return updated;
    });
    return widgetDtoOf(base, widget, tables);
  }

  async removeWidget(
    principal: Principal,
    widgetId: Id<'wgt'>,
    ifMatch: string | undefined,
    meta: RequestMeta,
  ): Promise<void> {
    const { base, row: dashboard } = await this.locateWidget(principal, widgetId);
    const expected = expectedVersionOf(ifMatch, undefined);
    const context = mutationContextOf(meta, principal.userId);
    await this.db.withTx(async (tx) => {
      const scope = withTxScope(base.org.scope, tx);
      await this.lockAt(scope, dashboard.id, expected);
      const deleted = await this.widgets.delete(scope, widgetId);
      if (deleted === undefined) throw notFound();
      // Widgets that followed a deleted filter control stop following it.
      const unbound: Id<'wgt'>[] = [];
      if (deleted.type === 'filter_control') {
        const rest = await this.widgets.listByDashboard(scope, dashboard.id);
        // Remapping every remaining widget to itself drops the deleted one.
        const mapping = new Map<string, string>(rest.map((other) => [other.id, other.id]));
        for (const other of rest) {
          const next = remapWidgetIds(other.type, configOf(other), mapping);
          if (JSON.stringify(next) !== JSON.stringify(other.config)) {
            await this.widgets.update(scope, other.id, { config: next as JsonObject });
            unbound.push(other.id);
          }
        }
      }
      await this.bump(scope, base, dashboard.id, tx);
      await this.recordWidget(tx, base, deleted, 'dashboard.widget_deleted', context, {
        before: widgetSnapshotOf(deleted),
        after: null,
        ...(unbound.length === 0 ? {} : { data: { unbound_widget_ids: unbound } }),
      });
    });
  }

  async duplicateWidget(
    principal: Principal,
    widgetId: Id<'wgt'>,
    meta: RequestMeta,
  ): Promise<WidgetDto> {
    const { base, row: dashboard } = await this.locateWidget(principal, widgetId);
    const tables = await this.tableMeta(base);
    const context = mutationContextOf(meta, principal.userId);
    const widget = await this.db.withTx(async (tx) => {
      const scope = withTxScope(base.org.scope, tx);
      await this.lockAt(scope, dashboard.id, undefined);
      const all = await this.widgets.listByDashboard(scope, dashboard.id);
      const source = all.find((item) => item.id === widgetId);
      if (source === undefined) throw notFound();
      if (all.length >= MAX_WIDGETS_PER_DASHBOARD) throw widgetLimitExceeded();
      const { w, h } = layoutOf(source);
      const created = await this.widgets.insert(scope, {
        id: newId('wgt'),
        dashboardId: dashboard.id,
        type: source.type,
        title: source.title,
        config: configOf(source) as JsonObject,
        layout: { ...placeAtBottom(all.map(layoutOf), w, h) },
      });
      await this.bump(scope, base, dashboard.id, tx);
      await this.recordWidget(tx, base, created, 'dashboard.widget_created', context, {
        before: null,
        after: widgetSnapshotOf(created),
        data: { duplicated_from: source.id },
      });
      return created;
    });
    return widgetDtoOf(base, widget, tables);
  }

  // --- Widget data (T806) -----------------------------------------------------------------

  /**
   * A widget of a dashboard the caller may read (`404` otherwise, like `GET
   * /dashboards/:id`), with the caller's base access and why it is
   * `broken` (`null` when every table and field it names is active).
   */
  async readableWidget(
    principal: Principal,
    widgetId: Id<'wgt'>,
  ): Promise<{
    readonly base: BaseAccess;
    readonly dashboard: DashboardRow;
    readonly widget: DashboardWidgetRow;
    readonly brokenReason: 'table_deleted' | 'field_deleted' | null;
    /** Active tables of the base and their active fields (names for CSV headers). */
    readonly tables: ReadonlyMap<string, WidgetTableMeta>;
  }> {
    for (const membership of await this.access.memberships(principal)) {
      const widget = await this.widgets.getById(orgScope(membership.organizationId), widgetId);
      if (widget === undefined) continue;
      const { base, row } = await this.locate(principal, widget.dashboard_id, 'read');
      const tables = await this.tableMeta(base);
      const brokenReason = widgetBrokenReasonOf(widget.type, widget.config, tables);
      return { base, dashboard: row, widget, brokenReason, tables };
    }
    throw notFound();
  }

  /** Every widget of a dashboard the caller already reads (live filter sources, T808). */
  async widgetsOf(base: BaseAccess, dashboardId: Id<'dsh'>): Promise<DashboardWidgetRow[]> {
    return this.widgets.listByDashboard(base.org.scope, dashboardId);
  }

  // --- Realtime (T807) --------------------------------------------------------------------

  /**
   * The `dashboard:<id>` channel of the caller (CONTRACTS §7): the dashboard
   * when they may read it (as `GET /dashboards/:id`, `undefined` otherwise),
   * with the tables its data widgets read — the tables whose record changes
   * become `dashboard.data_changed`.
   */
  async channel(
    principal: Principal,
    dashboardId: Id<'dsh'>,
  ): Promise<{ readonly base: BaseAccess; readonly tableIds: Id<'tbl'>[] } | undefined> {
    let located: Located;
    try {
      located = await this.locate(principal, dashboardId, 'read');
    } catch (error) {
      if (error instanceof AppError && error.code === 'NOT_FOUND') return undefined;
      throw error;
    }
    const widgets = await this.widgets.listByDashboard(located.base.org.scope, dashboardId);
    const tableIds = new Set<Id<'tbl'>>();
    for (const widget of widgets) {
      const query = widgetQueryOf(widget.type, widget.config);
      if (query !== null && query !== 'invalid') tableIds.add(query.tableId);
    }
    return { base: located.base, tableIds: [...tableIds].sort() };
  }

  // --- Helpers ----------------------------------------------------------------------------

  /**
   * A dashboard the caller may read (`404` otherwise), and may change for
   * `admin` (`403` otherwise). Outside the trash, or only in it with
   * `inTrash` (base admins only).
   */
  private async locate(
    principal: Principal,
    dashboardId: Id<'dsh'>,
    level: DashboardLevel,
    options: { readonly inTrash?: boolean } = {},
  ): Promise<Located> {
    for (const membership of await this.access.memberships(principal)) {
      const row = await this.dashboards.getById(orgScope(membership.organizationId), dashboardId, {
        includeDeleted: true,
      });
      if (row === undefined) continue;
      const base = await this.access.findBase(principal, row.base_id);
      if (base === undefined || !canReadDashboard(base, row)) throw notFound();
      if ((row.deleted_at !== null) !== (options.inTrash === true)) throw notFound();
      if (level === 'admin' && !base.access.is_admin) throw cannotManage();
      return { base, row };
    }
    throw notFound();
  }

  /** The dashboard of a widget, for a base admin (`404`/`403` like `locate`). */
  private async locateWidget(principal: Principal, widgetId: Id<'wgt'>): Promise<Located> {
    for (const membership of await this.access.memberships(principal)) {
      const dashboardId = await this.widgets.dashboardIdOf(
        orgScope(membership.organizationId),
        widgetId,
      );
      if (dashboardId !== undefined) return this.locate(principal, dashboardId, 'admin');
    }
    throw notFound();
  }

  /** Locks the dashboard; `404` in the trash, `409 VERSION_CONFLICT` when `expected` is not its version. */
  private async lockAt(
    scope: OrgScope,
    dashboardId: Id<'dsh'>,
    expected: number | undefined,
  ): Promise<DashboardRow> {
    const current = await this.dashboards.lockById(scope, dashboardId);
    if (current === undefined || current.deleted_at !== null) throw notFound();
    if (expected !== undefined && expected !== current.version) {
      throw new AppError('VERSION_CONFLICT', {
        detail: 'The dashboard was changed by someone else.',
        errors: [
          {
            path: 'version',
            code: 'VERSION_CONFLICT',
            message: 'The dashboard was changed by someone else',
            params: {
              current_version: current.version,
              version: expected,
              updated_at: iso(current.updated_at),
              updated_by: null,
            },
          },
        ],
      });
    }
    return current;
  }

  /** Bumps the dashboard `version` after a change of its widgets (and tells subscribers). */
  private async bump(
    scope: OrgScope,
    base: BaseAccess,
    dashboardId: Id<'dsh'>,
    tx: Tx,
  ): Promise<void> {
    const row = await this.dashboards.update(scope, dashboardId, {});
    if (row === undefined) throw notFound();
    await this.publishChanged(tx, base, row);
  }

  /**
   * `dashboard.changed` on the realtime bus after `tx` commits (T807,
   * CONTRACTS §7, §28.5): subscribers of `dashboard:<id>` refetch the
   * configuration, and api instances reload the tables it reads.
   */
  private publishChanged(tx: Tx, base: BaseAccess, row: DashboardRow): Promise<void> {
    return publishRealtime(this.db, tx, {
      v: REALTIME_ENVELOPE_VERSION,
      type: 'dashboard.changed',
      organization_id: base.org.organizationId,
      base_id: base.base.id,
      dashboard_id: row.id,
      version: row.version,
    });
  }

  /** Moves a dashboard to index `position` of the base list (clamped). */
  private async move(
    scope: OrgScope,
    baseId: Id<'bse'>,
    dashboardId: Id<'dsh'>,
    position: number,
  ): Promise<void> {
    const ids = (await this.dashboards.activeIdsByBase(scope, baseId)).filter(
      (id) => id !== dashboardId,
    );
    ids.splice(Math.min(position, ids.length), 0, dashboardId);
    await this.dashboards.setPositions(
      scope,
      baseId,
      ids.map((id, index) => ({ id, position: index })),
    );
  }

  /** Active tables of the base and their active fields, for widget checks. */
  async tableMeta(base: BaseAccess): Promise<Map<string, WidgetTableMeta>> {
    const scope = base.org.scope;
    const tables = await this.tables.listByBase(scope, base.base.id);
    const fields =
      tables.length === 0 ? [] : await this.fields.listActiveByBase(scope, base.base.id);
    const meta = new Map<string, { id: string; fields: WidgetTableMeta['fields'][number][] }>(
      tables.map((table) => [table.id, { id: table.id, fields: [] }]),
    );
    for (const field of fields) {
      meta.get(field.table_id)?.fields.push({
        id: field.id,
        name: field.name,
        type: field.type,
        options: field.options,
        result_type: field.result_type,
      });
    }
    return meta;
  }

  private async dtoOf(base: BaseAccess, row: DashboardRow): Promise<DashboardDto> {
    const scope = base.org.scope;
    const [widgets, tables, creator] = await Promise.all([
      this.widgets.listByDashboard(scope, row.id),
      this.tableMeta(base),
      this.users.findById(row.created_by),
    ]);
    return {
      id: row.id,
      base_id: row.base_id,
      name: row.name,
      icon: row.icon,
      description: row.description,
      theme: row.theme as DashboardDto['theme'],
      global_filters: row.global_filters as DashboardDto['global_filters'],
      position: row.position,
      version: row.version,
      created_by: { id: row.created_by, name: creator?.display_name ?? row.created_by },
      widgets: widgets.map((widget) => widgetDtoOf(base, widget, tables)),
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
    };
  }

  private async recordDashboard(
    tx: Tx,
    base: BaseAccess,
    row: DashboardRow,
    type:
      | 'dashboard.created'
      | 'dashboard.updated'
      | 'dashboard.deleted'
      | 'dashboard.restored'
      | 'dashboard.duplicated',
    context: AuditContext,
    change: {
      readonly before: JsonObject | null;
      readonly after: JsonObject | null;
      readonly data?: JsonObject;
      readonly changes?: Record<string, { from: JsonValue; to: JsonValue }>;
    },
  ): Promise<void> {
    if (type !== 'dashboard.created' && type !== 'dashboard.duplicated') {
      await this.publishChanged(tx, base, row);
    }
    return recordChange(tx, {
      type,
      organizationId: base.org.organizationId,
      baseId: base.base.id,
      entityType: 'dashboard',
      entityId: row.id,
      context,
      before: change.before,
      after: change.after,
      data: { name: row.name, version: row.version, ...change.data },
      ...(change.changes === undefined ? {} : { changes: change.changes }),
    });
  }

  private recordWidget(
    tx: Tx,
    base: BaseAccess,
    row: DashboardWidgetRow,
    type: 'dashboard.widget_created' | 'dashboard.widget_updated' | 'dashboard.widget_deleted',
    context: AuditContext,
    change: {
      readonly before: JsonObject | null;
      readonly after: JsonObject | null;
      readonly data?: JsonObject;
      readonly changes?: Record<string, { from: JsonValue; to: JsonValue }>;
    },
  ): Promise<void> {
    return recordChange(tx, {
      type,
      organizationId: base.org.organizationId,
      baseId: base.base.id,
      entityType: 'dashboard_widget',
      entityId: row.id,
      context,
      before: change.before,
      after: change.after,
      data: { dashboard_id: row.dashboard_id, type: row.type, ...change.data },
      ...(change.changes === undefined ? {} : { changes: change.changes }),
    });
  }

  /** The caller's language: their own, else the organization's, else the default. */
  private localeOf(principal: Principal, base: BaseAccess): string {
    const locales = [principal.user.locale, settingOf(base.org.membership.settings, 'locale')];
    return (
      locales.find((locale): locale is string => typeof locale === 'string' && locale !== '') ??
      this.config.defaults.locale
    );
  }
}

function summaryOf(row: DashboardRow & { readonly widget_count: number }): DashboardSummaryDto {
  return {
    id: row.id,
    base_id: row.base_id,
    name: row.name,
    icon: row.icon,
    description: row.description,
    position: row.position,
    version: row.version,
    widget_count: row.widget_count,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

function siblingsOf(rows: readonly DashboardWidgetRow[]): Map<string, SiblingWidget> {
  return new Map(rows.map((row) => [row.id, { type: row.type, config: row.config }]));
}

/**
 * A widget as read. Its saved `filter` names values of the table, so only
 * base admins (who edit it) see it; viewers get `null` — the widget query
 * (T806) applies it on the server. The `default` of a filter control is
 * values of its field too: a viewer who cannot read that field gets `null`
 * (the control shows "no permission" and is ignored for them anyway — QA S7,
 * T819).
 */
function widgetDtoOf(
  base: BaseAccess,
  row: DashboardWidgetRow,
  tables: ReadonlyMap<string, WidgetTableMeta>,
): WidgetDto {
  const reason = widgetBrokenReasonOf(row.type, row.config, tables);
  const config = { ...configOf(row) };
  if (!base.access.is_admin && 'filter' in config) config['filter'] = null;
  if (
    !base.access.is_admin &&
    row.type === 'filter_control' &&
    !controlFieldReadable(base, config)
  ) {
    config['default'] = null;
  }
  return {
    id: row.id,
    dashboard_id: row.dashboard_id,
    type: row.type,
    title: row.title,
    config,
    layout: layoutOf(row),
    status: reason === null ? 'ok' : 'broken',
    broken_reason: reason,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

/** The viewer reads the table and the field of a filter control config. */
function controlFieldReadable(base: BaseAccess, config: Record<string, unknown>): boolean {
  const { table_id: tableId, field } = config;
  if (typeof tableId !== 'string' || typeof field !== 'string') return false;
  const table = base.access.tables[tableId as Id<'tbl'>];
  return table !== undefined && Object.hasOwn(table.fields, field);
}
