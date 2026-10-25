import { sortByPosition } from '@cellhive/contracts';

import type { WidgetDto } from '@cellhive/contracts';

/** Height of one grid row in pixels (a 6-row widget ≈ 336 px with the gaps). */
export const ROW_HEIGHT = 48;
/** Gap between widgets, in pixels (16 px, FRONTEND §9.3 spacing). */
export const GRID_GAP = 16;
/** Below this width the dashboard is one column (SPEC §10.1). */
export const SINGLE_COLUMN_BELOW = 1024;

/** A react-grid-layout item of view mode: nothing moves or resizes. */
export interface ViewLayoutItem {
  readonly i: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly static: true;
}

/** Widgets in reading order: row, then column (SPEC §10.1 — the one-column order, focus order). */
export function readingOrder(widgets: readonly WidgetDto[]): WidgetDto[] {
  const byId = new Map(widgets.map((widget) => [widget.id, widget]));
  return sortByPosition(widgets.map((widget) => ({ id: widget.id, ...widget.layout }))).flatMap(
    (item) => {
      const widget = byId.get(item.id);
      return widget === undefined ? [] : [widget];
    },
  );
}

/** The 12-column layout of view mode, in reading order. */
export function viewLayout(widgets: readonly WidgetDto[]): ViewLayoutItem[] {
  return readingOrder(widgets).map((widget) => ({
    i: widget.id,
    x: widget.layout.x,
    y: widget.layout.y,
    w: widget.layout.w,
    h: widget.layout.h,
    static: true,
  }));
}

/** Pixel height of a widget of `h` rows in the one-column layout (same rhythm as the grid). */
export function singleColumnHeight(h: number, gap: number = GRID_GAP): number {
  return h * ROW_HEIGHT + (h - 1) * gap;
}

/** react-grid-layout measurements of the 12-column grid with a gap of `gap` pixels. */
export function gridConfig(gap: number = GRID_GAP) {
  return {
    cols: 12,
    rowHeight: ROW_HEIGHT,
    margin: [gap, gap] as const,
    containerPadding: [0, 0] as const,
  };
}
