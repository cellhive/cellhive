import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';

import {
  EMPTY_FILTER_STATE,
  FILTER_PARAM,
  decodeFilterState,
  defaultState,
  encodeFilterState,
  liveFiltersFor,
  pruneState,
  removeCross,
  setControlValue,
  setGlobalValue,
  toggleCross,
  type CrossFilter,
  type DashboardFilterState,
  type WidgetLiveFilters,
} from './filter-state';

import type { DashboardDto, FilterControlValue, WidgetDto } from '@cellhive/contracts';

/** What the dashboard's widgets, filter bar and controls share (T813). */
export interface DashboardFilters {
  /** Live filters work here (view and TV mode); the editor shows unfiltered numbers. */
  readonly enabled: boolean;
  readonly state: DashboardFilterState;
  readonly dashboard: Pick<DashboardDto, 'id' | 'name' | 'global_filters' | 'widgets'>;
  readonly setGlobal: (id: string, value: FilterControlValue | null) => void;
  readonly setControl: (widgetId: string, value: FilterControlValue | null) => void;
  readonly toggleCross: (cross: CrossFilter) => void;
  readonly removeCross: (widgetId: string) => void;
  /** "Clear filters": every value, defaults included, until the page is opened again. */
  readonly clear: () => void;
}

const NOOP = () => undefined;

const DISABLED: DashboardFilters = {
  enabled: false,
  state: EMPTY_FILTER_STATE,
  dashboard: { id: '' as DashboardDto['id'], name: '', global_filters: [], widgets: [] },
  setGlobal: NOOP,
  setControl: NOOP,
  toggleCross: NOOP,
  removeCross: NOOP,
  clear: NOOP,
};

export const DashboardFiltersContext = createContext<DashboardFilters>(DISABLED);

/** The filters of the dashboard on screen (disabled outside a filtering page). */
export function useDashboardFilters(): DashboardFilters {
  return useContext(DashboardFiltersContext);
}

const NO_FILTERS: WidgetLiveFilters = { filters: [], notApplied: [] };

/** The live filters one widget's requests carry, and the ones that do not apply to it. */
export function useWidgetLiveFilters(widget: WidgetDto): WidgetLiveFilters {
  const { enabled, state, dashboard } = useDashboardFilters();
  return useMemo(
    () => (enabled ? liveFiltersFor(widget, state, dashboard) : NO_FILTERS),
    [enabled, widget, state, dashboard],
  );
}

/** The state this page last wrote, ahead of the URL (a navigation commits later). */
interface LocalFilters {
  /** `?f` as last seen in the URL. */
  readonly seen: string | null;
  /** `?f` this page wrote and waits for (`null`: nothing pending). */
  readonly mine: string | null;
  readonly value: DashboardFilterState | null;
}

/**
 * (T813) The filter state of a dashboard page, kept in the URL (`?f=`,
 * FRONTEND §2) so a link shares the filtered dashboard: without `f` the
 * controls' saved defaults apply (the server never applies them, CONTRACTS
 * §28.4); once the viewer changes anything, `f` holds the whole state
 * (`replace`: filtering does not fill the history). A change shows at once
 * (a check box does not wait for the router's navigation to commit); a URL
 * changed from elsewhere (back, a link) wins.
 */
export function useDashboardFilterState(dashboard: DashboardDto | undefined): DashboardFilters {
  const [params, setParams] = useSearchParams();
  const raw = params.get(FILTER_PARAM);
  const widgets = dashboard?.widgets;
  const [local, setLocal] = useState<LocalFilters>({ seen: raw, mine: null, value: null });
  let current = local;
  if (local.seen !== raw) {
    // The URL moved: to what this page wrote (keep it) or to something else (read it).
    current =
      raw === local.mine
        ? { seen: raw, mine: null, value: local.value }
        : { seen: raw, mine: null, value: null };
    setLocal(current);
  }
  const fromUrl = useMemo(() => {
    if (dashboard === undefined) return EMPTY_FILTER_STATE;
    const read = raw === null ? defaultState(dashboard.widgets) : decodeFilterState(raw);
    return pruneState(read, dashboard);
  }, [raw, dashboard]);
  const written = current.value;
  const state = useMemo(
    () => (written === null || dashboard === undefined ? fromUrl : pruneState(written, dashboard)),
    [written, fromUrl, dashboard],
  );

  const write = useCallback(
    (change: (current: DashboardFilterState) => DashboardFilterState) => {
      if (dashboard === undefined) return;
      const next = change(state);
      const encoded = encodeFilterState(next);
      setLocal({ seen: raw, mine: encoded, value: next });
      setParams(
        (url) => {
          const nextUrl = new URLSearchParams(url);
          nextUrl.set(FILTER_PARAM, encoded);
          return nextUrl;
        },
        { replace: true },
      );
    },
    [setParams, dashboard, state, raw],
  );

  return useMemo<DashboardFilters>(() => {
    if (dashboard === undefined) return DISABLED;
    return {
      enabled: true,
      state,
      dashboard,
      setGlobal: (id, value) => {
        write((current) => setGlobalValue(current, id, value));
      },
      setControl: (widgetId, value) => {
        write((current) => setControlValue(current, widgetId, value, widgets ?? []));
      },
      toggleCross: (cross) => {
        write((current) => toggleCross(current, cross));
      },
      removeCross: (widgetId) => {
        write((current) => removeCross(current, widgetId));
      },
      clear: () => {
        write(() => EMPTY_FILTER_STATE);
      },
    };
  }, [dashboard, state, write, widgets]);
}
