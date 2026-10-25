import { createContext, useContext } from 'react';

import type { WidgetDto, WidgetGroupKey, WidgetLiveFilterInput } from '@cellhive/contracts';

/** A group of a widget (click-through, CONTRACTS §28.4 `segment`). */
export interface WidgetSegment {
  readonly dimension: WidgetGroupKey;
  readonly series?: WidgetGroupKey | undefined;
}

/** What the drawer of a click-through shows (T813). */
export interface RecordsRequest {
  readonly widget: WidgetDto;
  /** Widget title as shown. */
  readonly title: string;
  /** `null`: every record behind the widget. */
  readonly segment: WidgetSegment | null;
  /** Text of the group ("Urgent", "Urgent · Lan"), `null` without a segment. */
  readonly segmentLabel: string | null;
  readonly filters: readonly WidgetLiveFilterInput[];
}

/**
 * (T813) Actions of the widgets in view mode, given by the dashboard page:
 * click-through ("View records"), CSV and PNG downloads (only with
 * `base_rule.download`, S7 decision #12 — the items are not shown without
 * it). Absent (the editor): no widget menu.
 */
export interface WidgetActions {
  readonly canDownload: boolean;
  /** `null`: no click-through (a dashboard share link, T814). */
  readonly viewRecords: ((request: RecordsRequest) => void) | null;
  readonly downloadCsv: (
    widget: WidgetDto,
    title: string,
    filters: readonly WidgetLiveFilterInput[],
  ) => void;
  readonly downloadPng: (title: string, dataUrl: string) => void;
}

export const WidgetActionsContext = createContext<WidgetActions | null>(null);

export function useWidgetActions(): WidgetActions | null {
  return useContext(WidgetActionsContext);
}

/** Per card: the drawn chart's PNG (ECharts `getDataURL`), registered by the chart. */
export class ChartSnapshot {
  private getter: (() => string) | null = null;

  /** The chart drawn now (`null`: none, e.g. "View as table"). */
  set(getter: (() => string) | null): void {
    this.getter = getter;
  }

  /** Whether a chart is drawn. */
  get ready(): boolean {
    return this.getter !== null;
  }

  /** The PNG data URL of the chart, `null` when none is drawn. */
  take(): string | null {
    return this.getter === null ? null : this.getter();
  }
}

export const ChartSnapshotContext = createContext<ChartSnapshot | null>(null);
