import {
  filterControlWidgetConfigSchema,
  MAX_CONTROL_OPTIONS,
  UNKNOWN_WIDGET,
  WIDGET_RETRY_AFTER_SECONDS,
  type Id,
  type WidgetDataDto,
  type WidgetDataRequest,
  type WidgetLiveFilterInput,
  type WidgetOptionsDto,
  type WidgetOptionsRequest,
  type WidgetRecordsDto,
  type WidgetRecordsRequest,
} from '@cellhive/contracts';
import {
  GroupMembersRepository,
  RecordQueryService,
  WidgetResultCache,
  widgetQueryOf,
  type AppConfig,
  type DashboardRow,
  type DashboardWidgetRow,
  type RecordAccessContext,
  type WidgetAggregateResult,
  type WidgetCacheOutcome,
} from '@cellhive/server-core';
import { AppError } from '@cellhive/server-core/errors';
import { Inject, Injectable } from '@nestjs/common';
import { Counter, Histogram } from 'prom-client';

import { recordAccessContextOf } from '../../common/access/record-access-context.js';
import { firstTimeZone, settingOf, validTimeZone } from '../../common/access/time-zone.js';
import { validationFailed } from '../../common/dto.js';
import { AppLogger } from '../../common/logging/app-logger.js';
import { APP_CONFIG } from '../../common/tokens.js';
import { MetricsService } from '../metrics/metrics.service.js';

import { DashboardService } from './dashboard.service.js';
import {
  ancestorsOf,
  bindingsOf,
  EMPTY_LIVE_FILTER_PLAN,
  planLiveFilters,
  type LiveFilterPlan,
  type LiveFilterTarget,
} from './live-filter-plan.js';
import { ValkeyWidgetCacheStore } from './widget-cache-store.js';
import { WidgetQueryLimiter } from './widget-query-limiter.js';

import type { BaseAccess } from '../../common/access/access.service.js';
import type { Principal } from '../../common/auth/principal.js';

const BROKEN: WidgetAggregateResult = { status: 'broken', columns: [], rows: [] };

/**
 * A widget and who reads it: a member (session or API token) or, through a
 * dashboard share link (T809), the link — the creator's current access ∩
 * the dashboard. Everything else (live filter sources, cache, limiter,
 * timeouts) is the same for both.
 */
export interface WidgetReadContext {
  /** Base of the dashboard as the reader reaches it (organization scope and settings). */
  readonly base: BaseAccess;
  readonly dashboard: DashboardRow;
  readonly widget: DashboardWidgetRow;
  readonly brokenReason: 'table_deleted' | 'field_deleted' | null;
  /** The record access to read the widget's tables with. */
  readonly access: () => Promise<RecordAccessContext>;
  /** Line of the reader in {@link WidgetQueryLimiter}: a user id, or `share_link:<id>`. */
  readonly limiterKey: string;
}

const noData = () =>
  validationFailed('Text and filter control widgets have no data.', {
    path: '',
    code: UNKNOWN_WIDGET,
    message: 'The widget has no data',
  });

/**
 * Widget data (SPEC §10.3, CONTRACTS §28.3; BACKLOG T806): the caller must
 * read the dashboard (`404` otherwise); the numbers come from
 * `RecordQueryService.widgetData` with the caller's record access (P21) —
 * there is no SQL of its own here. Queries wait in the per-user /
 * per-instance line of {@link WidgetQueryLimiter}; durations go to
 * `dashboard_widget_query_seconds{type,status}` (no organization, widget or
 * user label).
 *
 * Cache (T807, CONTRACTS §28.5): results are kept in Valkey under a key of
 * the widget, its query, the viewer's resolved permission fingerprint and
 * the tables' `data_version` (`RecordQueryService.widgetCacheKey`); cold
 * keys are computed once (lock + 2 s wait), Valkey failures bypass the
 * cache. `dashboard_cache_total{result}`,
 * `dashboard_cache_coalesced_total`. Only computations wait in the line of
 * the limiter; hits never do.
 *
 * Live filters (T808, CONTRACTS §28.4): only the sources the dashboard
 * declares (`planLiveFilters`), each set aside when it names a field the
 * viewer cannot read; the applied ones are part of the cache key. Also the
 * values of filter controls (cascading through parent controls) and the
 * records behind a widget (click-through).
 */
@Injectable()
export class DashboardDataService {
  private readonly duration: Histogram<'type' | 'status'>;
  private readonly cacheResults: Counter<'result'>;
  private readonly coalesced: Counter;
  /** The widget result cache (tests read its state). */
  readonly cache: WidgetResultCache<WidgetAggregateResult>;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DashboardService) private readonly dashboards: DashboardService,
    @Inject(RecordQueryService) private readonly records: RecordQueryService,
    @Inject(GroupMembersRepository) private readonly groupMembers: GroupMembersRepository,
    @Inject(WidgetQueryLimiter) private readonly limiter: WidgetQueryLimiter,
    @Inject(ValkeyWidgetCacheStore) store: ValkeyWidgetCacheStore,
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Inject(MetricsService) metrics: MetricsService,
  ) {
    this.duration = new Histogram({
      name: 'dashboard_widget_query_seconds',
      help: 'Duration of dashboard widget queries, by widget type and result status',
      labelNames: ['type', 'status'],
      buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
      registers: [metrics.registry],
    });
    this.cacheResults = new Counter({
      name: 'dashboard_cache_total',
      help: 'Dashboard widget requests by cache result (bypass: not cacheable or Valkey failed)',
      labelNames: ['result'],
      registers: [metrics.registry],
    });
    this.coalesced = new Counter({
      name: 'dashboard_cache_coalesced_total',
      help: 'Dashboard widget requests answered by the computation of a concurrent request',
      registers: [metrics.registry],
    });
    this.cache = new WidgetResultCache<WidgetAggregateResult>(store, {
      outcome: (result: WidgetCacheOutcome) => {
        this.cacheResults.inc({ result });
      },
      coalesced: () => {
        this.coalesced.inc();
      },
      error: (err: unknown, operation) => {
        this.logger.warn({ err, operation }, 'dashboard cache unavailable, answering without it');
      },
    });
  }

  async data(
    principal: Principal,
    widgetId: Id<'wgt'>,
    body: WidgetDataRequest,
  ): Promise<WidgetDataDto> {
    return this.dataOf(await this.memberContext(principal, widgetId), body);
  }

  /** A widget of a dashboard the member reads (`404` otherwise), read with their access. */
  async memberContext(principal: Principal, widgetId: Id<'wgt'>): Promise<WidgetReadContext> {
    const located = await this.dashboards.readableWidget(principal, widgetId);
    return {
      ...located,
      access: () => this.accessOf(principal, located.base),
      limiterKey: principal.userId,
    };
  }

  /** The numbers of a widget for the reader of `context` (CONTRACTS §28.3–§28.5). */
  async dataOf(context: WidgetReadContext, body: WidgetDataRequest): Promise<WidgetDataDto> {
    const { base, dashboard, widget, brokenReason } = context;
    const query = widgetQueryOf(widget.type, widget.config);
    if (query === null) throw noData();
    const plan =
      query === 'invalid'
        ? EMPTY_LIVE_FILTER_PLAN
        : await this.planFor(base, dashboard, body.filters, {
            id: widget.id,
            tableId: query.tableId,
            mode: 'data',
            controls: bindingsOf(widget.config),
          });
    const started = performance.now();
    let status = 'error';
    try {
      if (brokenReason !== null || query === 'invalid') {
        status = BROKEN.status;
        return {
          ...BROKEN,
          computed_at: new Date().toISOString(),
          cache: 'miss',
          ignored_filters: plan.ignored,
        };
      }
      const access = await context.access();
      const timeZone = this.timeZoneOf(base, body.timezone);
      const orgZone = settingOf(base.org.membership.settings, 'timezone');
      const scope = base.org.scope;
      // Before the computation: the versions in the key are never newer than its data.
      const key = await this.records.widgetCacheKey(scope, access, widget.id, query, {
        timeZone,
        filters: { applied: plan.applied, ignored: plan.ignored },
        context: { org_time_zone: validTimeZone(orgZone) ? orgZone : null },
      });
      const { value, computedAt, cache } = await this.cache.read(key, () =>
        this.limiter.run(context.limiterKey, () =>
          this.records.widgetData(scope, access, query, { timeZone, live: plan.applied }),
        ),
      );
      status = value.status;
      const { ignored, ...result } = value;
      return { ...result, computed_at: computedAt, cache, ignored_filters: plan.report(ignored) };
    } catch (error) {
      if (error instanceof AppError && error.code === 'QUERY_TIMEOUT') {
        status = 'timeout';
        throw retryable(error);
      }
      if (error instanceof AppError && error.status < 500) status = 'rejected';
      throw error;
    } finally {
      this.duration.observe({ type: widget.type, status }, (performance.now() - started) / 1000);
    }
  }

  /**
   * `POST /widgets/:id/options` (T808): the values a `select`, `user` or
   * `text` filter control offers the caller — distinct values of its field
   * among the records they read, narrowed by the values of its parent
   * controls (cascading slicers) and `search`. Range controls have none
   * (`422 UNKNOWN_WIDGET`).
   */
  async options(
    principal: Principal,
    widgetId: Id<'wgt'>,
    body: WidgetOptionsRequest,
  ): Promise<WidgetOptionsDto> {
    return this.optionsOf(await this.memberContext(principal, widgetId), body);
  }

  /** The values a filter control offers the reader of `context` (CONTRACTS §28.4). */
  async optionsOf(
    context: WidgetReadContext,
    body: WidgetOptionsRequest,
  ): Promise<WidgetOptionsDto> {
    const { base, dashboard, widget, brokenReason } = context;
    const noOptions = () =>
      validationFailed('Only select, user and text filter controls offer values.', {
        path: '',
        code: UNKNOWN_WIDGET,
        message: 'The widget offers no values',
      });
    if (widget.type !== 'filter_control') throw noOptions();
    const parsed = filterControlWidgetConfigSchema.safeParse(widget.config ?? {});
    if (
      parsed.success &&
      (parsed.data.control === 'date_range' || parsed.data.control === 'number_range')
    ) {
      throw noOptions();
    }
    if (!parsed.success || brokenReason !== null) {
      return { status: 'broken', items: [], has_more: false, ignored_filters: [] };
    }
    const control = parsed.data;
    const widgets = body.filters.length === 0 ? [] : await this.widgetsOf(base, dashboard);
    const plan = planLiveFilters(
      {
        id: widget.id,
        tableId: control.table_id,
        mode: 'options',
        controls: ancestorsOf(control, new Map(widgets.map((item) => [item.id, item]))),
      },
      dashboard.global_filters,
      new Map(widgets.map((item) => [item.id, item])),
      body.filters,
    );
    const access = await context.access();
    const timeZone = this.timeZoneOf(base, body.timezone);
    try {
      const result = await this.limiter.run(context.limiterKey, () =>
        this.records.controlOptions(
          base.org.scope,
          access,
          { tableId: control.table_id, field: control.field, kind: control.control },
          {
            timeZone,
            live: plan.applied,
            search: body.search ?? null,
            limit: MAX_CONTROL_OPTIONS,
          },
        ),
      );
      return {
        status: result.status,
        items: result.items,
        has_more: result.hasMore,
        ignored_filters: plan.report(result.ignored),
      };
    } catch (error) {
      if (error instanceof AppError && error.code === 'QUERY_TIMEOUT') throw retryable(error);
      throw error;
    }
  }

  /**
   * `POST /widgets/:id/records` (T808, click-through): the records behind a
   * data widget — or one of its groups (`segment`) — that the caller reads,
   * with the live filters applied like the widget's numbers; fields the
   * caller reads only. Signed-in callers (and API tokens) only: share links
   * have no such route ("Quyết định S7" #9).
   */
  async recordsOf(
    principal: Principal,
    widgetId: Id<'wgt'>,
    body: WidgetRecordsRequest,
  ): Promise<WidgetRecordsDto> {
    const { base, dashboard, widget, brokenReason } = await this.dashboards.readableWidget(
      principal,
      widgetId,
    );
    const query = widgetQueryOf(widget.type, widget.config);
    if (query === null) throw noData();
    const page = { offset: body.offset, limit: body.limit };
    if (brokenReason !== null || query === 'invalid') {
      return { status: 'broken', records: [], ...page, ignored_filters: [] };
    }
    const plan = await this.planFor(base, dashboard, body.filters, {
      id: widget.id,
      tableId: query.tableId,
      mode: 'data',
      controls: bindingsOf(widget.config),
    });
    const access = await this.accessOf(principal, base);
    const timeZone = this.timeZoneOf(base, body.timezone);
    try {
      const result = await this.limiter.run(principal.userId, () =>
        this.records.widgetRecords(base.org.scope, access, query, {
          timeZone,
          live: plan.applied,
          segment: body.segment,
          ...page,
        }),
      );
      const list = result.page;
      return {
        status: result.status,
        records: list?.records ?? [],
        ...page,
        ...(list !== null && 'total' in list ? { total: list.total } : {}),
        ...(list !== null && 'total_estimate' in list
          ? { total_estimate: list.total_estimate }
          : {}),
        ignored_filters: plan.report(result.ignored),
      };
    } catch (error) {
      if (error instanceof AppError && error.code === 'QUERY_TIMEOUT') throw retryable(error);
      throw error;
    }
  }

  /** The live filters of a request for a widget (no read when there are none). */
  private async planFor(
    base: BaseAccess,
    dashboard: DashboardRow,
    filters: readonly WidgetLiveFilterInput[],
    target: LiveFilterTarget,
  ): Promise<LiveFilterPlan> {
    if (filters.length === 0) return EMPTY_LIVE_FILTER_PLAN;
    const widgets = await this.widgetsOf(base, dashboard);
    return planLiveFilters(
      target,
      dashboard.global_filters,
      new Map(widgets.map((item) => [item.id, item])),
      filters,
    );
  }

  private widgetsOf(base: BaseAccess, dashboard: DashboardRow): Promise<DashboardWidgetRow[]> {
    return this.dashboards.widgetsOf(base, dashboard.id);
  }

  private accessOf(principal: Principal, base: BaseAccess): Promise<RecordAccessContext> {
    return recordAccessContextOf(
      { groupMembers: this.groupMembers, config: this.config },
      principal.user,
      base,
    );
  }

  /** Zone of date buckets and relative dates: the request's, else the organization's. */
  private timeZoneOf(base: BaseAccess, requested: string | null | undefined): string {
    return firstTimeZone(
      [requested, settingOf(base.org.membership.settings, 'timezone')],
      this.config.defaults.timezone,
    );
  }
}

/** A widget query timeout with `Retry-After` (CONTRACTS §28.3). */
function retryable(error: AppError): AppError {
  if (error.retryAfterSeconds !== undefined) return error;
  return new AppError('QUERY_TIMEOUT', {
    detail: error.detail ?? 'The widget query took too long and was cancelled.',
    retryAfterSeconds: WIDGET_RETRY_AFTER_SECONDS,
    cause: error,
  });
}
