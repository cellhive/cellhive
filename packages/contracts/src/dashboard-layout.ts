/**
 * The 12-column grid of a dashboard (SPEC §10.1, CONTRACTS §28.1, BACKLOG
 * "Quyết định S7" #5): pure checks shared by the API (`PUT
 * /dashboards/:id/layout`, widget saves) and the web editor, so both answer
 * the same way.
 */

/** Columns of the grid. */
export const DASHBOARD_GRID_COLUMNS = 12;
/** Width of a widget, in columns. */
export const MIN_WIDGET_WIDTH = 1;
export const MAX_WIDGET_WIDTH = DASHBOARD_GRID_COLUMNS;
/** Height of a widget, in rows. */
export const MIN_WIDGET_HEIGHT = 2;
export const MAX_WIDGET_HEIGHT = 24;
/** Highest row a widget may start on (30 widgets of 24 rows fit well below it). */
export const MAX_WIDGET_ROW = 1000;

/** Place of a widget on the grid: column `x`, row `y`, width `w`, height `h`. */
export interface GridRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** A widget's place, with its id. */
export interface GridItem extends GridRect {
  readonly id: string;
}

/** Detail codes of a layout problem (`VALIDATION_FAILED`, CONTRACTS §6, §28.1). */
export const LAYOUT_OUT_OF_BOUNDS = 'LAYOUT_OUT_OF_BOUNDS';
export const LAYOUT_OVERLAP = 'LAYOUT_OVERLAP';

export interface LayoutIssue {
  readonly code: typeof LAYOUT_OUT_OF_BOUNDS | typeof LAYOUT_OVERLAP;
  /** The widget at fault. */
  readonly id: string;
  /** `LAYOUT_OVERLAP`: the widget it overlaps. */
  readonly other?: string;
}

function isInt(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

/** Whether a rectangle lies inside the grid with an allowed size. */
export function isRectInBounds(rect: GridRect): boolean {
  return (
    isInt(rect.w, MIN_WIDGET_WIDTH, MAX_WIDGET_WIDTH) &&
    isInt(rect.h, MIN_WIDGET_HEIGHT, MAX_WIDGET_HEIGHT) &&
    isInt(rect.x, 0, DASHBOARD_GRID_COLUMNS - 1) &&
    rect.x + rect.w <= DASHBOARD_GRID_COLUMNS &&
    isInt(rect.y, 0, MAX_WIDGET_ROW)
  );
}

/** Whether two rectangles share at least one cell. */
export function rectsOverlap(a: GridRect, b: GridRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Problems of a layout, in item order: every item outside the grid
 * (`LAYOUT_OUT_OF_BOUNDS`), then every item overlapping an earlier one
 * (`LAYOUT_OVERLAP`, `other` = the earlier one). Empty when valid.
 */
export function checkLayout(items: readonly GridItem[]): LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  const inside: GridItem[] = [];
  for (const item of items) {
    if (isRectInBounds(item)) inside.push(item);
    else issues.push({ code: LAYOUT_OUT_OF_BOUNDS, id: item.id });
  }
  for (const [index, item] of inside.entries()) {
    const other = inside.slice(0, index).find((earlier) => rectsOverlap(earlier, item));
    if (other !== undefined) issues.push({ code: LAYOUT_OVERLAP, id: item.id, other: other.id });
  }
  return issues;
}

/** Items in reading order: by row, then column, then id (a stable total order). */
export function sortByPosition<T extends GridItem>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : 1));
}

/**
 * Vertical compaction (react-grid-layout `compactType: "vertical"`): in
 * reading order, each item moves up to the highest row where it overlaps
 * none of the items already placed; columns and sizes never change. A
 * layout without overlaps stays without overlaps. Returns new items in
 * reading order.
 */
export function compactLayout<T extends GridItem>(items: readonly T[]): T[] {
  const placed: T[] = [];
  for (const item of sortByPosition(items)) {
    let y = item.y;
    while (y > 0 && !placed.some((other) => rectsOverlap(other, { ...item, y: y - 1 }))) {
      y -= 1;
    }
    placed.push({ ...item, y });
  }
  return sortByPosition(placed);
}

/** First row below every item (0 for an empty layout). */
export function layoutBottom(items: readonly GridRect[]): number {
  return items.reduce((bottom, item) => Math.max(bottom, item.y + item.h), 0);
}

/** A free place of `w` × `h` for a new widget: column 0, below every item. */
export function placeAtBottom(items: readonly GridRect[], w: number, h: number): GridRect {
  return { x: 0, y: Math.min(layoutBottom(items), MAX_WIDGET_ROW), w, h };
}
