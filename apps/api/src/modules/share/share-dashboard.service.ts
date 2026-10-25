import {
  isId,
  sharedFieldOptions,
  UNKNOWN_FILTER,
  UNKNOWN_WIDGET,
  type DashboardGlobalFilter,
  type FieldTypeName,
  type Id,
  type ProblemErrorItem,
  type SharedDashboardDto,
  type SharedWidgetDto,
  type WidgetDataDto,
  type WidgetDataRequest,
  type WidgetExportQuery,
  type WidgetLayout,
  type WidgetOptionsDto,
  type WidgetOptionsRequest,
} from '@cellhive/contracts';
import {
  FieldsRepository,
  widgetBrokenReasonOf,
  widgetReferencesOf,
  type DashboardWidgetRow,
  type JsonValue,
  type AppConfig,
  type WidgetTableMeta,
} from '@cellhive/server-core';
import { AppError } from '@cellhive/server-core/errors';
import { Inject, Injectable } from '@nestjs/common';

import { settingOf } from '../../common/access/time-zone.js';
import { auditContextOf, requestMetaOf } from '../../common/auth/request-meta.js';
import { iso } from '../../common/dto.js';
import { ShareRateLimits } from '../../common/rate-limit/share-rate-limits.js';
import { APP_CONFIG } from '../../common/tokens.js';
import {
  DashboardDataService,
  type WidgetReadContext,
} from '../dashboard/dashboard-data.service.js';
import {
  DashboardExportService,
  type ExportWidgetContext,
  type WidgetCsvFile,
} from '../dashboard/dashboard-export.service.js';
import { DashboardService } from '../dashboard/dashboard.service.js';
import { globalFilterTargetsOf } from '../share-link/share-link-scope.js';

import { ShareAccessStats } from './share-access-stats.js';
import { ShareAccessService, type OpenedShare } from './share-access.service.js';
import { publicResultTypeOf } from './share-computed.js';
import { viewerLocale } from './share-export.service.js';
import { COMPUTED_ATTACHMENTS, COMPUTED_RECORDS, sharedValue } from './share-values.js';

import type { ResolvedDashboardShareLink } from '../share-link/share-link-resolver.service.js';
import type { FastifyRequest } from 'fastify';

type OpenedDashboard = OpenedShare<ResolvedDashboardShareLink>;

function notFound(): AppError {
  return new AppError('NOT_FOUND', { detail: 'Not found.' });
}

function notAllowed(detail: string, errors: ProblemErrorItem[]): AppError {
  return new AppError('PERMISSION_DENIED', { detail, errors });
}

function configOf(widget: DashboardWidgetRow): Record<string, unknown> {
  const config = widget.config;
  return typeof config === 'object' && config !== null && !Array.isArray(config)
    ? { ...config }
    : {};
}

function layoutOf(widget: DashboardWidgetRow): WidgetLayout {
  return widget.layout as unknown as WidgetLayout;
}

/** Widgets in reading order: row, then column (as `GET /dashboards/:id`). */
function readingOrder(widgets: readonly DashboardWidgetRow[]): DashboardWidgetRow[] {
  return [...widgets].sort((a, b) => {
    const left = layoutOf(a);
    const right = layoutOf(b);
    return left.y - right.y || left.x - right.x || a.id.localeCompare(b.id);
  });
}

/**
 * A dashboard through its share link (SPEC §15A, CONTRACTS §16A; BACKLOG
 * T809, S7 decisions 13–16): `GET /shares/:token/dashboard`, `POST
 * /shares/:token/widgets/:id/data|options`, `GET /shares/:token/widgets/:id/export`.
 *
 * - Every request passes the share checks of `ShareAccessService` (rate
 *   limit, token `404`/`410`, audience, password); a view or form link is
 *   `404` here, a widget of another dashboard too.
 * - The reader is the link: the creator's **current** access ∩ the tables
 *   of the dashboard, read only (`resolveShareLinkAccess`), with the
 *   creator's rule variables — so the numbers, the cache entries (keyed by
 *   that access's fingerprint) and the `no_permission` widgets are the
 *   creator's. The creator losing the dashboard, the right to share or the
 *   organization makes the link `410`.
 * - The configuration never carries the saved filters of widgets, nor any
 *   widget, field or global filter target the link cannot read.
 * - Live filters only with `allow_filter_controls` (`403 NOT_ALLOWED`),
 *   and only the dashboard's own sources (a source it does not declare →
 *   `403 NOT_ALLOWED`); records behind a widget (click-through) have no
 *   route through a link.
 * - No WS: the page polls at `refresh_seconds`. Widget requests count
 *   against their own per-IP limit (`SHARE_WIDGET_RATE_LIMIT`) and wait in
 *   the per-link line of the widget query limiter.
 */
@Injectable()
export class ShareDashboardService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ShareAccessService) private readonly shares: ShareAccessService,
    @Inject(ShareAccessStats) private readonly stats: ShareAccessStats,
    @Inject(ShareRateLimits) private readonly limits: ShareRateLimits,
    @Inject(DashboardService) private readonly dashboards: DashboardService,
    @Inject(DashboardDataService) private readonly data: DashboardDataService,
    @Inject(DashboardExportService) private readonly exports: DashboardExportService,
    @Inject(FieldsRepository) private readonly fields: FieldsRepository,
  ) {}

  /** `GET /shares/:token/dashboard`: the configuration the page renders (counts one access). */
  async dashboard(token: string, request: FastifyRequest): Promise<SharedDashboardDto> {
    const opened = await this.shares.openDashboard(token, request);
    const { link, dashboard, widgets, creator, settings } = opened.link;
    const tables = await this.dashboards.tableMeta(creator);
    const readable = (tableId: string | null, fieldIds: readonly string[]): boolean => {
      if (tableId === null) return true;
      const table = opened.link.access.access.tables[tableId as Id<'tbl'>];
      return table !== undefined && fieldIds.every((id) => Object.hasOwn(table.fields, id));
    };
    const shown = new Map<string, Set<string>>();
    const show = (tableId: string, fieldIds: readonly string[]) => {
      const set = shown.get(tableId) ?? new Set<string>();
      for (const id of fieldIds) set.add(id);
      shown.set(tableId, set);
    };

    const sharedWidgets = readingOrder(widgets).map((widget): SharedWidgetDto => {
      const head = {
        id: widget.id,
        type: widget.type,
        title: widget.title,
        layout: layoutOf(widget),
      };
      if (widgetBrokenReasonOf(widget.type, widget.config, tables) !== null) {
        return { ...head, status: 'broken', config: null };
      }
      const references = widgetReferencesOf(widget.type, widget.config);
      if (!readable(references.tableId, references.fieldIds)) {
        return { ...head, status: 'no_permission', config: null };
      }
      const config = configOf(widget);
      // The saved filter names values of the table: applied by the server, never shown.
      if ('filter' in config) config['filter'] = null;
      const shownRefs = widgetReferencesOf(widget.type, config);
      if (shownRefs.tableId !== null) show(shownRefs.tableId, shownRefs.fieldIds);
      return { ...head, status: 'ok', config };
    });

    const globalFilters = this.sharedGlobalFilters(dashboard.global_filters, tables, readable);
    for (const filter of globalFilters) {
      for (const target of filter.targets) show(target.table_id, [target.field]);
    }

    this.stats.record(opened.link.scope.organizationId, link.id, true);
    return {
      target_type: 'dashboard',
      dashboard: {
        id: dashboard.id,
        name: dashboard.name,
        description: dashboard.description,
        icon: dashboard.icon,
        theme: (dashboard.theme ?? {}) as SharedDashboardDto['dashboard']['theme'],
        global_filters: globalFilters,
      },
      widgets: sharedWidgets,
      fields: this.sharedFields(tables, shown),
      settings: {
        allow_filter_controls: settings.dashboard.allow_filter_controls,
        refresh_seconds: settings.dashboard.refresh_seconds,
        tv_mode: settings.dashboard.tv_mode,
        allow_export: settings.allow_export && creator.access.base_rule.download,
      },
      expires_at: link.expires_at === null ? null : iso(link.expires_at),
      csrf_token: opened.csrfToken,
    };
  }

  /** `POST /shares/:token/widgets/:id/data`: the widget's numbers for the link. */
  async widgetData(
    token: string,
    widgetId: Id<'wgt'>,
    body: WidgetDataRequest,
    request: FastifyRequest,
  ): Promise<WidgetDataDto> {
    const opened = await this.openWidgetRoute(token, request);
    if (body.filters.length > 0) this.assertLiveFilters(opened);
    const context = await this.contextOf(opened, widgetId);
    const result = await this.declaredOnly(() => this.data.dataOf(context, body));
    this.stats.record(opened.link.scope.organizationId, opened.link.link.id, false);
    return { ...result, rows: await this.redactRows(opened, context.widget, result) };
  }

  /** `POST /shares/:token/widgets/:id/options`: values of a filter control for the link. */
  async widgetOptions(
    token: string,
    widgetId: Id<'wgt'>,
    body: WidgetOptionsRequest,
    request: FastifyRequest,
  ): Promise<WidgetOptionsDto> {
    const opened = await this.openWidgetRoute(token, request);
    this.assertLiveFilters(opened);
    const context = await this.contextOf(opened, widgetId);
    const result = await this.declaredOnly(() => this.data.optionsOf(context, body));
    this.stats.record(opened.link.scope.organizationId, opened.link.link.id, false);
    return result;
  }

  /**
   * `GET /shares/:token/widgets/:id/export`: the widget's numbers as CSV,
   * with `allow_export` and the creator's current `base_rule.download` (as
   * the view export of T810); one export per link and per IP; audited with
   * the link as actor.
   */
  async widgetCsv(
    token: string,
    widgetId: Id<'wgt'>,
    query: WidgetExportQuery,
    request: FastifyRequest,
  ): Promise<WidgetCsvFile> {
    const opened = await this.openWidgetRoute(token, request);
    if ((query.filters ?? []).length > 0) this.assertLiveFilters(opened);
    const context = await this.contextOf(opened, widgetId);
    const { link, settings, creator } = opened.link;
    if (!settings.allow_export) {
      throw notAllowed('This link does not allow exporting.', [
        { path: '', code: 'NOT_ALLOWED', message: 'Not allowed by this link.' },
      ]);
    }
    const meta = requestMetaOf(request);
    const orgLocale = settingOf(creator.org.membership.settings, 'locale');
    const busy = 'Another export of this link is still running; try again later.';
    const file = await this.declaredOnly(() =>
      this.exports.export(context, query, {
        // The creator's right now (S7 decision 17), checked after the widget kind.
        canDownload: creator.access.base_rule.download,
        leases: [link.id, `ip:${meta.ip ?? 'unknown'}`],
        busy,
        locale: viewerLocale(
          request.headers['accept-language'],
          typeof orgLocale === 'string' && orgLocale !== ''
            ? orgLocale
            : this.config.defaults.locale,
        ),
        audit: {
          ...auditContextOf(meta, { type: 'share_link', id: link.id }),
          via: { share_link_id: link.id },
        },
        auditAfter: { share_link_id: link.id },
      }),
    );
    this.stats.record(opened.link.scope.organizationId, link.id, false);
    return file;
  }

  // ---------------------------------------------------------------------------------------

  /** Share checks of a widget route, counted against the widget limit instead of reads. */
  private async openWidgetRoute(token: string, request: FastifyRequest): Promise<OpenedDashboard> {
    await this.limits.hitWidget(requestMetaOf(request).ip);
    return this.shares.openDashboard(token, request, { rateLimit: false });
  }

  /** `allow_filter_controls = false` → no live filter at all (`403 NOT_ALLOWED`). */
  private assertLiveFilters(opened: OpenedDashboard): void {
    if (!opened.link.settings.dashboard.allow_filter_controls) {
      throw notAllowed('This link does not let viewers filter the dashboard.', [
        { path: 'filters', code: 'NOT_ALLOWED', message: 'Not allowed by this link.' },
      ]);
    }
  }

  /**
   * A live filter source the dashboard does not declare (a global filter or
   * widget id of something else) is not a typo through a link but an
   * attempt to filter outside the dashboard: `403 NOT_ALLOWED` (P71).
   */
  private async declaredOnly<T>(task: () => Promise<T>): Promise<T> {
    try {
      return await task();
    } catch (error) {
      const items = error instanceof AppError ? (error.errors ?? []) : [];
      const outside = items.filter(
        (item) =>
          item.path.startsWith('filters') &&
          (item.code === UNKNOWN_FILTER || item.code === UNKNOWN_WIDGET),
      );
      if (outside.length === 0) throw error;
      throw notAllowed(
        'This link only takes the filters of its dashboard.',
        outside.map((item) => ({
          path: item.path,
          code: 'NOT_ALLOWED',
          message: 'Not a filter of this dashboard.',
        })),
      );
    }
  }

  /** A widget of the link's dashboard (another widget id is `404`), read as the link. */
  private async contextOf(
    opened: OpenedDashboard,
    widgetId: Id<'wgt'>,
  ): Promise<ExportWidgetContext> {
    const { dashboard, widgets, creator, recordAccess, link } = opened.link;
    const widget = widgets.find((item) => item.id === widgetId);
    if (widget === undefined) throw notFound();
    const tables = await this.dashboards.tableMeta(creator);
    const context: WidgetReadContext = {
      base: creator,
      dashboard,
      widget,
      brokenReason: widgetBrokenReasonOf(widget.type, widget.config, tables),
      access: () => Promise.resolve(recordAccess),
      limiterKey: `share_link:${link.id}`,
    };
    return { ...context, tables };
  }

  /**
   * Values of a widget through a link, like records through a view link
   * (T409): users by `{ id, name }` only, a linked record the creator cannot
   * read without its id (a group value is the record id; its `label` is
   * `null` then), no file at all (dashboard links have no file route).
   */
  private async redactRows(
    opened: OpenedDashboard,
    widget: DashboardWidgetRow,
    result: WidgetDataDto,
  ): Promise<WidgetDataDto['rows']> {
    if (result.rows.length === 0) return result.rows;
    const fieldColumns = result.columns.some((column) => column.role === 'field');
    const types = fieldColumns ? await this.valueTypes(opened, widget) : new Map<string, string>();
    const context = { token: '', types };
    return result.rows.map((row) =>
      row.map((cell, index) => {
        const column = result.columns[index];
        if (column === undefined) return cell;
        if (column.role === 'dimension' || column.role === 'series') return hiddenRecord(cell);
        if (column.role === 'field' && column.field_id !== null) {
          return sharedValue(types.get(column.field_id), cell, context);
        }
        return cell;
      }),
    );
  }

  /** Value types of the widget's table for {@link sharedValue}: files never pass a dashboard link. */
  private async valueTypes(
    opened: OpenedDashboard,
    widget: DashboardWidgetRow,
  ): Promise<Map<string, string>> {
    const { tableId } = widgetReferencesOf(widget.type, widget.config);
    const types = new Map<string, string>();
    if (tableId === null) return types;
    for (const field of await this.fields.listByTable(opened.link.scope, tableId as Id<'tbl'>)) {
      const kind = publicResultTypeOf(field.result_type).kind;
      const computed = field.type === 'formula' || field.type === 'lookup';
      types.set(
        field.id,
        field.type === 'attachment' || (computed && kind === 'attachment')
          ? COMPUTED_ATTACHMENTS
          : computed && kind === 'record'
            ? COMPUTED_RECORDS
            : field.type,
      );
    }
    return types;
  }

  /** Global filters with only the targets the link reads (filters without any are left out). */
  private sharedGlobalFilters(
    json: JsonValue,
    tables: ReadonlyMap<string, WidgetTableMeta>,
    readable: (tableId: string, fieldIds: readonly string[]) => boolean,
  ): DashboardGlobalFilter[] {
    if (!Array.isArray(json)) return [];
    const active = (tableId: string, fieldId: string) =>
      tables.get(tableId)?.fields.some((field) => field.id === fieldId) === true;
    const out: DashboardGlobalFilter[] = [];
    for (const item of json) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
      const targets = globalFilterTargetsOf([item]).filter(
        (target) =>
          active(target.table_id, target.field) && readable(target.table_id, [target.field]),
      );
      if (targets.length === 0) continue;
      out.push({ ...(item as unknown as DashboardGlobalFilter), targets });
    }
    return out;
  }

  /** Name, type and display options of the fields the page labels (never other keys). */
  private sharedFields(
    tables: ReadonlyMap<string, WidgetTableMeta>,
    shown: ReadonlyMap<string, ReadonlySet<string>>,
  ): SharedDashboardDto['fields'] {
    const out: SharedDashboardDto['fields'] = [];
    for (const [tableId, ids] of shown) {
      if (!isId('tbl', tableId)) continue;
      for (const field of tables.get(tableId)?.fields ?? []) {
        if (!ids.has(field.id) || !isId('fld', field.id)) continue;
        const computed = field.type === 'formula' || field.type === 'lookup';
        out.push({
          id: field.id,
          table_id: tableId,
          name: field.name,
          type: field.type as FieldTypeName,
          options: sharedFieldOptions(field.type, field.options, 'view'),
          ...(computed ? { result_type: publicResultTypeOf(field.result_type) } : {}),
        });
      }
    }
    return out;
  }
}

/** A group key that is a record id the link cannot read (`label: null`) loses its id (T409). */
function hiddenRecord<T>(cell: T): T {
  if (typeof cell !== 'object' || cell === null || Array.isArray(cell)) return cell;
  const group = cell as { value?: unknown; label?: unknown };
  return isId('rec', group.value) && group.label === null ? ({ ...group, value: null } as T) : cell;
}
