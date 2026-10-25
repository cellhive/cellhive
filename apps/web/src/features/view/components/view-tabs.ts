/**
 * Which view tabs fit in the view bar (T320b, QA S3; T322a): tabs shrink
 * down to {@link TAB_MIN_WIDTH} with an ellipsis — about 12 characters of
 * the name stay readable — and past that the last ones go into a "⋯ N
 * views" menu. The open view always keeps its tab, and "New view" and the
 * menu button always stay visible. Tabs never overlap: each tab's `min-width`
 * is the minimum used here, so the tabs shown always fit.
 */

/** Narrowest a tab gets: icon + about 12 characters of 13 px text + padding (CSS `min-width`). */
export const TAB_MIN_WIDTH = 128;

/** A tab around its name: padding 8 + 4, type icon 16 and its gap 6, rounding. */
const TAB_CHROME = 36;
/** A personal or locked marker: 14 px icon and its gap. */
const TAB_MARKER = 20;

/**
 * The CSS `min-width` of a tab: {@link TAB_MIN_WIDTH}, or less for a name
 * that is shorter (a short tab keeps its natural width, no empty room).
 * `textWidth` is the width of the name at 13 px.
 */
export function tabMinWidth(textWidth: number, markers: number): number {
  return Math.min(TAB_MIN_WIDTH, Math.ceil(TAB_CHROME + markers * TAB_MARKER + textWidth));
}

/** Gap between two tabs (`gap-1`). */
export const TAB_GAP = 4;

/**
 * The open tab's "…" button, next to its name (the other tabs' button
 * overlays the name): a control, 32 px (44 px on touch-sized screens),
 * counted at its largest.
 */
export const ACTIVE_MENU_WIDTH = 44;

/** The line between shared and personal tabs, with its margins and gaps. */
export const GROUP_SEPARATOR_WIDTH = 17;

/** Room kept for the overflow menu button ("⋯ 12 views") and its gap. */
export const OVERFLOW_BUTTON_WIDTH = 108;

/**
 * How many tabs fit in `width` px (the tab strip), `reserved` px of it
 * taken by the rest of the strip ("New view", the separator of the personal
 * views), counting the overflow button when not all `count` tabs fit.
 * `mins` are the tabs' minimum widths ({@link tabMinWidth}, bar order;
 * without it every tab counts {@link TAB_MIN_WIDTH}); the open tab
 * (`activeIndex`) takes the last slot when it would be hidden, like
 * {@link planTabs}. `Infinity` when the width is not known (no layout, e.g.
 * before the first measure or in tests).
 */
export function tabCapacity(
  width: number,
  count: number,
  reserved = 0,
  mins?: readonly number[],
  activeIndex = -1,
): number {
  if (!Number.isFinite(width) || width <= 0) return Number.POSITIVE_INFINITY;
  const room = width - reserved - ACTIVE_MENU_WIDTH;
  const minOf = (index: number) => mins?.[index] ?? TAB_MIN_WIDTH;
  const needed = (shown: number) => {
    let sum = 0;
    for (let index = 0; index < shown; index += 1) {
      const slot = index === shown - 1 && activeIndex >= shown ? activeIndex : index;
      sum += minOf(slot) + TAB_GAP;
    }
    return sum;
  };
  if (needed(count) <= room) return count;
  for (let shown = count - 1; shown > 1; shown -= 1) {
    if (needed(shown) + OVERFLOW_BUTTON_WIDTH <= room) return shown;
  }
  return 1;
}

/**
 * Splits `views` (in bar order) into the tabs shown and the ones in the
 * overflow menu: the first `capacity` views, the open one taking the last
 * slot when it would be hidden. Order is kept in both lists.
 */
export function planTabs<T extends { readonly id: string }>(
  views: readonly T[],
  activeId: string,
  capacity: number,
): { visible: T[]; overflow: T[] } {
  if (views.length <= capacity) return { visible: [...views], overflow: [] };
  const slots = Math.max(1, Math.floor(capacity));
  const shown = new Set(views.slice(0, slots).map((view) => view.id));
  if (!shown.has(activeId) && views.some((view) => view.id === activeId)) {
    const last = views[slots - 1];
    if (last !== undefined) shown.delete(last.id);
    shown.add(activeId);
  }
  return {
    visible: views.filter((view) => shown.has(view.id)),
    overflow: views.filter((view) => !shown.has(view.id)),
  };
}

/** A pointer that moved this far between press and release was a drag, not a click. */
export const CLICK_SLOP_PX = 4;

/** Whether a press at `from` released at `to` is a click (not the end of a drag). */
export function isClick(
  from: { readonly x: number; readonly y: number } | null,
  to: { readonly x: number; readonly y: number },
): boolean {
  if (from === null) return true;
  return Math.hypot(to.x - from.x, to.y - from.y) < CLICK_SLOP_PX;
}
