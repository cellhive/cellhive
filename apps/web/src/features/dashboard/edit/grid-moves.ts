import {
  DASHBOARD_GRID_COLUMNS,
  MAX_WIDGET_HEIGHT,
  MAX_WIDGET_ROW,
  MAX_WIDGET_WIDTH,
  MIN_WIDGET_HEIGHT,
  MIN_WIDGET_WIDTH,
  layoutBottom,
  rectsOverlap,
  sortByPosition,
  type GridItem,
} from '@cellhive/contracts';

/**
 * Keyboard moves on the 12-column grid (T812, S7 decision #19:
 * react-grid-layout has no keyboard support). Pure: each move returns the
 * whole new layout, vertically compacted like react-grid-layout and the
 * server (`compactLayout`, CONTRACTS §28.1), or `null` when the widget
 * cannot go that way.
 */

export type GridDirection = 'left' | 'right' | 'up' | 'down';

/** Which item wins a tie on the same row while settling. */
type Priority = 'first' | 'last';

function sameLayout(a: readonly GridItem[], b: readonly GridItem[]): boolean {
  if (a.length !== b.length) return false;
  const byId = new Map(b.map((item) => [item.id, item]));
  return a.every((item) => {
    const other = byId.get(item.id);
    return (
      other !== undefined &&
      other.x === item.x &&
      other.y === item.y &&
      other.w === item.w &&
      other.h === item.h
    );
  });
}

/**
 * Settles a layout that may overlap after one item changed: in reading
 * order (the changed item first — or last — among items of its row), each
 * item is pushed below whatever it overlaps among the items already placed,
 * then moves up to the highest free row. The result never overlaps and is
 * stable under `compactLayout`.
 */
export function settleLayout<T extends GridItem>(
  items: readonly T[],
  changedId?: string,
  priority: Priority = 'first',
): T[] {
  const rank = (item: T) => (item.id === changedId ? (priority === 'first' ? -1 : 1) : 0);
  const ordered = [...items].sort(
    (a, b) => a.y - b.y || rank(a) - rank(b) || a.x - b.x || (a.id < b.id ? -1 : 1),
  );
  const placed: T[] = [];
  for (const item of ordered) {
    let y = item.y;
    for (;;) {
      const blocker = placed.find((other) => rectsOverlap(other, { ...item, y }));
      if (blocker === undefined) break;
      y = blocker.y + blocker.h;
    }
    while (y > 0 && !placed.some((other) => rectsOverlap(other, { ...item, y: y - 1 }))) {
      y -= 1;
    }
    placed.push({ ...item, y });
  }
  return sortByPosition(placed);
}

/**
 * Moves widget `id` one step: left/right by one column; up/down past the
 * next widget in that direction (a compacted grid has no empty row to step
 * into, so a row at a time would change nothing).
 */
export function moveItem<T extends GridItem>(
  items: readonly T[],
  id: string,
  direction: GridDirection,
): T[] | null {
  const item = items.find((candidate) => candidate.id === id);
  if (item === undefined) return null;
  const replaced = (patch: Partial<GridItem>) =>
    items.map((candidate) => (candidate.id === id ? { ...candidate, ...patch } : candidate));

  if (direction === 'left' || direction === 'right') {
    const x = item.x + (direction === 'left' ? -1 : 1);
    if (x < 0 || x + item.w > DASHBOARD_GRID_COLUMNS) return null;
    const next = settleLayout(replaced({ x }), id);
    return sameLayout(next, items) ? null : next;
  }

  const bottom = Math.min(layoutBottom(items), MAX_WIDGET_ROW);
  if (direction === 'up') {
    for (let y = item.y - 1; y >= 0; y -= 1) {
      const next = settleLayout(replaced({ y }), id, 'first');
      if (!sameLayout(next, items)) return next;
    }
    return null;
  }
  for (let y = item.y + 1; y <= bottom; y += 1) {
    const next = settleLayout(replaced({ y }), id, 'last');
    if (!sameLayout(next, items)) return next;
  }
  return null;
}

/**
 * Resizes widget `id` by one cell: right/left widen/narrow it by a column
 * (its left edge stays), down/up make it a row taller/shorter.
 */
export function resizeItem<T extends GridItem>(
  items: readonly T[],
  id: string,
  direction: GridDirection,
): T[] | null {
  const item = items.find((candidate) => candidate.id === id);
  if (item === undefined) return null;
  let { w, h } = item;
  if (direction === 'right') w += 1;
  else if (direction === 'left') w -= 1;
  else if (direction === 'down') h += 1;
  else h -= 1;
  if (
    w < MIN_WIDGET_WIDTH ||
    w > MAX_WIDGET_WIDTH ||
    item.x + w > DASHBOARD_GRID_COLUMNS ||
    h < MIN_WIDGET_HEIGHT ||
    h > MAX_WIDGET_HEIGHT
  ) {
    return null;
  }
  return settleLayout(
    items.map((candidate) => (candidate.id === id ? { ...candidate, w, h } : candidate)),
    id,
  );
}

/** The arrow key of a keyboard event as a direction, else `null`. */
export function arrowDirection(key: string): GridDirection | null {
  switch (key) {
    case 'ArrowLeft':
      return 'left';
    case 'ArrowRight':
      return 'right';
    case 'ArrowUp':
      return 'up';
    case 'ArrowDown':
      return 'down';
    default:
      return null;
  }
}
