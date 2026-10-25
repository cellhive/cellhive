import { RELATIVE_DATE_RANGES } from '@cellhive/contracts';

import type {
  DashboardDto,
  DashboardGlobalFilter,
  FilterControlValue,
  IgnoredFilterReason,
  LiveFilterSource,
  WidgetDto,
  WidgetGroupKey,
  WidgetLiveFilterInput,
} from '@cellhive/contracts';

/**
 * Live filters of a dashboard on this screen (T813, CONTRACTS §28.4, S7
 * decisions #9, #11): the values picked in the global filters and the
 * filter controls, and the cross-filters (a group clicked in a chart).
 * Pure: the page keeps one state, writes it to the URL (`?f=`) and derives
 * from it, for each widget, the live filters its request carries — only the
 * ones that can apply to it, so a filter on another table never changes
 * the widget's query key (CONTRACTS §28.5: the cache is keyed by them).
 */

type WidgetId = WidgetDto['id'];

export interface CrossFilter {
  /** The widget whose group was clicked (the source). */
  readonly widgetId: WidgetId;
  /** The group key (`rows[][0].value` of its data; `null` = the empty group). */
  readonly value: WidgetGroupKey;
  /** Text of the group as the chart showed it (chip). */
  readonly label: string;
}

export interface DashboardFilterState {
  /** Value by global filter id. */
  readonly global: Readonly<Record<string, FilterControlValue>>;
  /** Value by `filter_control` widget id. */
  readonly controls: Readonly<Record<string, FilterControlValue>>;
  /** At most one per source widget, in the order they were set. */
  readonly cross: readonly CrossFilter[];
}

export const EMPTY_FILTER_STATE: DashboardFilterState = { global: {}, controls: {}, cross: [] };

/** A filter the client knows does not apply to a widget (said on the card). */
export interface NotApplied {
  readonly source: LiveFilterSource;
  readonly id: string;
  readonly reason: IgnoredFilterReason;
}

export interface WidgetLiveFilters {
  /** Sorted by source then id: one stable query key per effective query. */
  readonly filters: readonly WidgetLiveFilterInput[];
  readonly notApplied: readonly NotApplied[];
}

const NOTHING: WidgetLiveFilters = { filters: [], notApplied: [] };

/** `values: []` or a range without bounds filters nothing (CONTRACTS §28.4). */
export function isActiveValue(value: FilterControlValue | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  if ('values' in value) return value.values.length > 0;
  if ('range' in value) return value.range.from !== null || value.range.to !== null;
  return true;
}

/** The table a widget reads (`null`: text). */
export function tableOf(widget: Pick<WidgetDto, 'config'>): string | null {
  const tableId = (widget.config as { table_id?: unknown }).table_id;
  return typeof tableId === 'string' ? tableId : null;
}

function bindingsOf(widget: WidgetDto): readonly string[] {
  const bindings = (widget.config as { filter_bindings?: unknown }).filter_bindings;
  return Array.isArray(bindings)
    ? bindings.filter((item): item is string => typeof item === 'string')
    : [];
}

function parentOf(widget: WidgetDto | undefined): WidgetId | null {
  const parent = (widget?.config as { parent_control_id?: unknown } | undefined)?.parent_control_id;
  return typeof parent === 'string' ? (parent as WidgetId) : null;
}

/** Widgets whose groups can cross-filter (CONTRACTS §28.4: a dimension). */
export function hasDimension(widget: WidgetDto): boolean {
  if (['bar', 'line', 'pie', 'combo'].includes(widget.type)) return true;
  return (
    widget.type === 'table' &&
    (widget.config as { table?: { mode?: unknown } }).table?.mode === 'pivot'
  );
}

/** Widgets with numbers (not text, not a filter control). */
export function isDataWidget(widget: Pick<WidgetDto, 'type'>): boolean {
  return widget.type !== 'text' && widget.type !== 'filter_control';
}

const SOURCE_ORDER: Readonly<Record<LiveFilterSource, number>> = {
  global: 0,
  control: 1,
  cross: 2,
};

const idOfFilter = (filter: WidgetLiveFilterInput) =>
  filter.source === 'global' ? filter.id : filter.widget_id;

function sortFilters(filters: WidgetLiveFilterInput[]): WidgetLiveFilterInput[] {
  return filters.sort(
    (a, b) =>
      SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] || idOfFilter(a).localeCompare(idOfFilter(b)),
  );
}

/**
 * The live filters a data widget's request carries: global filters with a
 * target on its table, the controls it follows (`filter_bindings`), the
 * cross-filters of other widgets on its table. Global and cross filters on
 * another table are not sent and come back as "does not apply" notices
 * (S7 decision #11); a control the widget does not follow is simply not its
 * filter. The server answers the rest (`ignored_filters`: no permission,
 * broken).
 */
export function liveFiltersFor(
  widget: WidgetDto,
  state: DashboardFilterState,
  dashboard: Pick<DashboardDto, 'global_filters' | 'widgets'>,
): WidgetLiveFilters {
  if (!isDataWidget(widget)) return NOTHING;
  const table = tableOf(widget);
  const filters: WidgetLiveFilterInput[] = [];
  const notApplied: NotApplied[] = [];
  for (const global of dashboard.global_filters) {
    const value = state.global[global.id];
    if (!isActiveValue(value) || value === undefined) continue;
    if (global.targets.some((target) => target.table_id === table)) {
      filters.push({ source: 'global', id: global.id, value });
    } else {
      notApplied.push({ source: 'global', id: global.id, reason: 'other_table' });
    }
  }
  const bound = new Set(bindingsOf(widget));
  for (const control of dashboard.widgets) {
    if (control.type !== 'filter_control' || !bound.has(control.id)) continue;
    const value = state.controls[control.id];
    if (!isActiveValue(value) || value === undefined) continue;
    filters.push({ source: 'control', widget_id: control.id, value });
  }
  for (const cross of state.cross) {
    if (cross.widgetId === widget.id) continue;
    const source = dashboard.widgets.find((item) => item.id === cross.widgetId);
    if (source === undefined) continue;
    if (tableOf(source) === table) {
      filters.push({ source: 'cross', widget_id: cross.widgetId, value: cross.value });
    } else {
      notApplied.push({ source: 'cross', id: cross.widgetId, reason: 'other_table' });
    }
  }
  if (filters.length === 0 && notApplied.length === 0) return NOTHING;
  return { filters: sortFilters(filters), notApplied };
}

/**
 * Filters of `POST /widgets/:id/options` for a control: the values of its
 * parent controls, transitively (cascading slicers, S7 decision #11; the
 * server applies only those).
 */
export function parentFiltersFor(
  control: WidgetDto,
  state: DashboardFilterState,
  widgets: readonly WidgetDto[],
): WidgetLiveFilterInput[] {
  const filters: WidgetLiveFilterInput[] = [];
  const seen = new Set<string>([control.id]);
  let parentId = parentOf(control);
  while (parentId !== null && !seen.has(parentId)) {
    seen.add(parentId);
    const value = state.controls[parentId];
    if (isActiveValue(value) && value !== undefined) {
      filters.push({ source: 'control', widget_id: parentId, value });
    }
    parentId = parentOf(widgets.find((widget) => widget.id === parentId));
  }
  return sortFilters(filters);
}

/** Controls below `controlId` (children, grandchildren…): their values go with a new parent value. */
export function descendantsOf(controlId: string, widgets: readonly WidgetDto[]): string[] {
  const found: string[] = [];
  const queue = [controlId];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const widget of widgets) {
      if (
        widget.type === 'filter_control' &&
        parentOf(widget) === current &&
        !found.includes(widget.id) &&
        widget.id !== controlId
      ) {
        found.push(widget.id);
        queue.push(widget.id);
      }
    }
  }
  return found;
}

// --- State changes ------------------------------------------------------------------------

/** The state a dashboard opens with: each control's saved `default` (the server never applies it). */
export function defaultState(widgets: readonly WidgetDto[]): DashboardFilterState {
  const controls: Record<string, FilterControlValue> = {};
  for (const widget of widgets) {
    if (widget.type !== 'filter_control') continue;
    const value = (widget.config as { default?: FilterControlValue | null }).default ?? null;
    if (isActiveValue(value) && value !== null) controls[widget.id] = value;
  }
  return { global: {}, controls, cross: [] };
}

function withEntry(
  map: Readonly<Record<string, FilterControlValue>>,
  id: string,
  value: FilterControlValue | null,
): Readonly<Record<string, FilterControlValue>> {
  const others = Object.fromEntries(Object.entries(map).filter(([key]) => key !== id));
  return value === null || !isActiveValue(value) ? others : { ...others, [id]: value };
}

export function setGlobalValue(
  state: DashboardFilterState,
  id: string,
  value: FilterControlValue | null,
): DashboardFilterState {
  return { ...state, global: withEntry(state.global, id, value) };
}

/** A control's new value; the values of its child controls no longer fit and are cleared. */
export function setControlValue(
  state: DashboardFilterState,
  controlId: string,
  value: FilterControlValue | null,
  widgets: readonly WidgetDto[],
): DashboardFilterState {
  let controls = withEntry(state.controls, controlId, value);
  for (const child of descendantsOf(controlId, widgets))
    controls = withEntry(controls, child, null);
  return { ...state, controls };
}

/**
 * Clicking a group: filters by it, or — the same group clicked again —
 * removes the filter (Metabase's behavior, research §2.1). Another group of
 * the same widget replaces it.
 */
export function toggleCross(state: DashboardFilterState, cross: CrossFilter): DashboardFilterState {
  const current = state.cross.find((item) => item.widgetId === cross.widgetId);
  const others = state.cross.filter((item) => item.widgetId !== cross.widgetId);
  if (current !== undefined && current.value === cross.value) return { ...state, cross: others };
  return { ...state, cross: [...others, cross] };
}

export function removeCross(state: DashboardFilterState, widgetId: string): DashboardFilterState {
  return { ...state, cross: state.cross.filter((item) => item.widgetId !== widgetId) };
}

/** Anything filters the dashboard now. */
export function hasActiveFilters(state: DashboardFilterState): boolean {
  return (
    Object.keys(state.global).length > 0 ||
    Object.keys(state.controls).length > 0 ||
    state.cross.length > 0
  );
}

/** Drops values of filters and widgets the dashboard no longer has (edited, deleted). */
export function pruneState(
  state: DashboardFilterState,
  dashboard: Pick<DashboardDto, 'global_filters' | 'widgets'>,
): DashboardFilterState {
  const globals = new Set(dashboard.global_filters.map((filter) => filter.id));
  const controls = new Set<string>(
    dashboard.widgets.filter((widget) => widget.type === 'filter_control').map((w) => w.id),
  );
  const sources = new Set<string>(
    dashboard.widgets.filter(hasDimension).map((widget) => widget.id),
  );
  const global = Object.fromEntries(Object.entries(state.global).filter(([id]) => globals.has(id)));
  const control = Object.fromEntries(
    Object.entries(state.controls).filter(([id]) => controls.has(id)),
  );
  const cross = state.cross.filter((item) => sources.has(item.widgetId));
  if (
    Object.keys(global).length === Object.keys(state.global).length &&
    Object.keys(control).length === Object.keys(state.controls).length &&
    cross.length === state.cross.length
  ) {
    return state;
  }
  return { global, controls: control, cross };
}

// --- URL (`?f=`) ----------------------------------------------------------------------------

/** URL search parameter of the filter state (FRONTEND §2). */
export const FILTER_PARAM = 'f';

const RELATIVE: ReadonlySet<string> = new Set(RELATIVE_DATE_RANGES);
const MAX_URL_VALUES = 200;

function isBound(value: unknown): value is string | number | null {
  return value === null || typeof value === 'string' || typeof value === 'number';
}

/** Reads a filter value of untrusted input (the URL), or `null`. */
export function readValue(raw: unknown): FilterControlValue | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (Array.isArray(record['values'])) {
    const values = record['values']
      .filter(
        (item): item is string | number | boolean =>
          (typeof item === 'string' && item.length <= 1000) ||
          typeof item === 'number' ||
          typeof item === 'boolean',
      )
      .slice(0, MAX_URL_VALUES);
    return { values };
  }
  const range = record['range'];
  if (typeof range === 'object' && range !== null) {
    const { from = null, to = null } = range as { from?: unknown; to?: unknown };
    if (!isBound(from) || !isBound(to)) return null;
    return { range: { from, to } };
  }
  const relative = record['relative'];
  if (typeof relative === 'string' && RELATIVE.has(relative)) {
    return { relative: relative as (typeof RELATIVE_DATE_RANGES)[number] };
  }
  return null;
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

function fromBase64Url(text: string): string {
  const padded = text.replace(/-/gu, '+').replace(/_/gu, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * The state as a short URL value: compact JSON (`g` global, `c` controls,
 * `x` cross-filters as `[widget, value, label]`) in base64url — one opaque
 * token that survives sharing the link.
 */
export function encodeFilterState(state: DashboardFilterState): string {
  const compact: Record<string, unknown> = {};
  if (Object.keys(state.global).length > 0) compact['g'] = state.global;
  if (Object.keys(state.controls).length > 0) compact['c'] = state.controls;
  if (state.cross.length > 0) {
    compact['x'] = state.cross.map((item) => [item.widgetId, item.value, item.label]);
  }
  return toBase64Url(JSON.stringify(compact));
}

/** The state of a `?f=` value; anything malformed is dropped (an old or edited link). */
export function decodeFilterState(text: string): DashboardFilterState {
  let raw: unknown;
  try {
    raw = JSON.parse(fromBase64Url(text));
  } catch {
    return EMPTY_FILTER_STATE;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return EMPTY_FILTER_STATE;
  const { g, c, x } = raw as { g?: unknown; c?: unknown; x?: unknown };
  const readMap = (map: unknown) => {
    const result: Record<string, FilterControlValue> = {};
    if (typeof map !== 'object' || map === null || Array.isArray(map)) return result;
    for (const [id, value] of Object.entries(map)) {
      const read = readValue(value);
      if (read !== null && isActiveValue(read) && /^[A-Za-z0-9_-]{1,64}$/u.test(id)) {
        result[id] = read;
      }
    }
    return result;
  };
  const cross: CrossFilter[] = [];
  if (Array.isArray(x)) {
    for (const item of x) {
      if (!Array.isArray(item)) continue;
      const [widgetId, value, label] = item as unknown[];
      if (typeof widgetId !== 'string' || !/^wgt_[A-Za-z0-9]{1,40}$/u.test(widgetId)) continue;
      if (!(
        value === null ||
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
      )) {
        continue;
      }
      if (cross.some((existing) => existing.widgetId === widgetId)) continue;
      cross.push({
        widgetId: widgetId as WidgetId,
        value,
        label: typeof label === 'string' ? label.slice(0, 200) : String(value),
      });
    }
  }
  return { global: readMap(g), controls: readMap(c), cross };
}

/** The global filter declared under `id`. */
export function globalFilterOf(
  dashboard: Pick<DashboardDto, 'global_filters'>,
  id: string,
): DashboardGlobalFilter | undefined {
  return dashboard.global_filters.find((filter) => filter.id === id);
}
