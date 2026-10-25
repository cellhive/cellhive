import {
  dashboardGlobalFiltersSchema,
  filterControlWidgetConfigSchema,
  INVALID_FILTER_VALUE,
  liveFilterIdOf,
  UNKNOWN_FILTER,
  UNKNOWN_WIDGET,
  type DashboardGlobalFilter,
  type Id,
  type IgnoredFilterDto,
  type IgnoredFilterReason,
  type WidgetLiveFilterInput,
  type WidgetType,
} from '@cellhive/contracts';
import {
  controlValueIssue,
  widgetQueryOf,
  type IgnoredLiveFilter,
  type WidgetLiveFilter,
} from '@cellhive/server-core';

import { validationFailed } from '../../common/dto.js';

/**
 * Which live filters of a request apply to one widget (BACKLOG T808,
 * CONTRACTS §28.4, "Quyết định S7" #9, #11). Pure: the caller loads the
 * dashboard and its widgets.
 *
 * Only declared sources are accepted — a global filter of
 * `dashboard.global_filters` (`422 UNKNOWN_FILTER` otherwise), a
 * `filter_control` widget of the dashboard, a grouped data widget for a
 * cross-filter (`422 UNKNOWN_WIDGET` otherwise) — with a value fitting the
 * control kind (`422 INVALID_FILTER_VALUE`). The condition is always built
 * by the server from the declared field: a global filter on the field it
 * targets in the widget's table, a control on its field, a cross-filter on
 * the dimension of the source widget. A declared source that does not
 * concern the widget is listed in `ignored` (other table, a control the
 * widget does not follow, its own cross-filter); `RecordQueryService` sets
 * aside, in turn, filters on fields the viewer cannot read.
 */

/** A widget of the dashboard, as stored. */
export interface DashboardWidgetLike {
  readonly id: string;
  readonly type: WidgetType;
  readonly config: unknown;
}

/** The widget the filters are for. */
export interface LiveFilterTarget {
  readonly id: Id<'wgt'>;
  readonly tableId: Id<'tbl'>;
  /**
   * `data`: a data widget — global filters, the controls of
   * `filter_bindings` and cross-filters of its table apply; `options`: the
   * values of a filter control — only its parent controls apply.
   */
  readonly mode: 'data' | 'options';
  /** Controls that apply: `filter_bindings`, or the parent chain of a control. */
  readonly controls: ReadonlySet<string>;
}

export interface LiveFilterPlan {
  /** What `RecordQueryService` applies (keys `source:id`). */
  readonly applied: WidgetLiveFilter[];
  /** Declared sources that do not concern the widget. */
  readonly ignored: IgnoredFilterDto[];
  /** `ignored` of `RecordQueryService` (by key) as the API reports it. */
  readonly report: (ignored: readonly IgnoredLiveFilter[] | undefined) => IgnoredFilterDto[];
}

export const EMPTY_LIVE_FILTER_PLAN: LiveFilterPlan = {
  applied: [],
  ignored: [],
  report: () => [],
};

/** `filter_bindings` of a data widget config (ids only). */
export function bindingsOf(config: unknown): Set<string> {
  const bindings = (config as { filter_bindings?: unknown } | null)?.filter_bindings;
  return new Set(
    Array.isArray(bindings) ? bindings.filter((id): id is string => typeof id === 'string') : [],
  );
}

/** The parent controls of a control, nearest first (a loop stops the walk). */
export function ancestorsOf(
  config: unknown,
  widgets: ReadonlyMap<string, DashboardWidgetLike>,
): Set<string> {
  const ancestors = new Set<string>();
  let parent = (config as { parent_control_id?: unknown } | null)?.parent_control_id;
  while (typeof parent === 'string' && !ancestors.has(parent)) {
    const widget = widgets.get(parent);
    if (widget?.type !== 'filter_control') break;
    ancestors.add(parent);
    parent = (widget.config as { parent_control_id?: unknown } | null)?.parent_control_id;
  }
  return ancestors;
}

function parsedGlobalFilters(input: unknown): DashboardGlobalFilter[] {
  const parsed = dashboardGlobalFiltersSchema.safeParse(input ?? []);
  return parsed.success ? parsed.data : [];
}

export function planLiveFilters(
  target: LiveFilterTarget,
  globalFilters: unknown,
  widgets: ReadonlyMap<string, DashboardWidgetLike>,
  filters: readonly WidgetLiveFilterInput[],
): LiveFilterPlan {
  if (filters.length === 0) return EMPTY_LIVE_FILTER_PLAN;
  const globals = parsedGlobalFilters(globalFilters);
  const applied: WidgetLiveFilter[] = [];
  const ignored: IgnoredFilterDto[] = [];
  const echo = new Map<string, Pick<IgnoredFilterDto, 'source' | 'id'>>();
  const misfit = (path: string, message: string) =>
    validationFailed('A filter value does not fit its filter.', {
      path,
      code: INVALID_FILTER_VALUE,
      message,
    });

  for (const [index, filter] of filters.entries()) {
    const id = liveFilterIdOf(filter);
    const key = `${filter.source}:${id}`;
    const at = `filters[${String(index)}]`;
    const path = `${at}.value`;
    const skip = (reason: IgnoredFilterReason) => {
      ignored.push({ source: filter.source, id, reason });
    };
    echo.set(key, { source: filter.source, id });

    switch (filter.source) {
      case 'global': {
        const global = globals.find((item) => item.id === filter.id);
        if (global === undefined) {
          throw validationFailed('The dashboard has no such global filter.', {
            path: `${at}.id`,
            code: UNKNOWN_FILTER,
            message: 'Not a global filter of this dashboard',
          });
        }
        const issue = controlValueIssue(global.kind, filter.value);
        if (issue !== null) throw misfit(path, issue);
        if (target.mode === 'options') {
          skip('not_bound');
          break;
        }
        const field = global.targets.find((item) => item.table_id === target.tableId)?.field;
        if (field === undefined) {
          skip('other_table');
          break;
        }
        applied.push({
          kind: 'control',
          key,
          path,
          control: global.kind,
          field,
          value: filter.value,
        });
        break;
      }
      case 'control': {
        const widget = widgets.get(filter.widget_id);
        if (widget?.type !== 'filter_control') {
          throw validationFailed('The dashboard has no such filter control.', {
            path: `${at}.widget_id`,
            code: UNKNOWN_WIDGET,
            message: 'Not a filter control of this dashboard',
          });
        }
        const config = filterControlWidgetConfigSchema.safeParse(widget.config);
        if (!config.success) {
          skip('broken');
          break;
        }
        const issue = controlValueIssue(config.data.control, filter.value);
        if (issue !== null) throw misfit(path, issue);
        if (!target.controls.has(filter.widget_id)) {
          skip('not_bound');
          break;
        }
        if (config.data.table_id !== target.tableId) {
          skip('other_table');
          break;
        }
        applied.push({
          kind: 'control',
          key,
          path,
          control: config.data.control,
          field: config.data.field,
          value: filter.value,
        });
        break;
      }
      case 'cross': {
        const widget = widgets.get(filter.widget_id);
        const query = widget === undefined ? null : widgetQueryOf(widget.type, widget.config);
        if (query === null || (query !== 'invalid' && query.kind !== 'grouped')) {
          throw validationFailed('The dashboard has no such grouped widget.', {
            path: `${at}.widget_id`,
            code: UNKNOWN_WIDGET,
            message: 'Not a grouped widget of this dashboard',
          });
        }
        if (target.mode === 'options') {
          skip('not_bound');
          break;
        }
        if (filter.widget_id === target.id) {
          skip('self');
          break;
        }
        if (query === 'invalid') {
          skip('broken');
          break;
        }
        if (query.tableId !== target.tableId) {
          skip('other_table');
          break;
        }
        applied.push({
          kind: 'segment',
          key,
          path,
          dimension: query.dimension,
          value: filter.value,
        });
        break;
      }
    }
  }
  return {
    applied,
    ignored,
    report: (items) => [
      ...ignored,
      ...(items ?? []).flatMap((item) => {
        const source = echo.get(item.key);
        return source === undefined ? [] : [{ ...source, reason: item.reason }];
      }),
    ],
  };
}
