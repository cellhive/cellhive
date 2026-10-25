import { describe, expect, it } from 'vitest';

import {
  ACTIVE_MENU_WIDTH,
  isClick,
  OVERFLOW_BUTTON_WIDTH,
  planTabs,
  TAB_GAP,
  TAB_MIN_WIDTH,
  tabCapacity,
  tabMinWidth,
} from '../components/view-tabs';

/** A tab at its minimum width with the gap after it. */
const SLOT = TAB_MIN_WIDTH + TAB_GAP;

const views = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => ({ id }));
const ids = (list: readonly { id: string }[]) => list.map((view) => view.id);

describe('view tab overflow (T320b)', () => {
  it.each<[string, number, number, number, number]>([
    ['unknown width shows every tab', 0, 7, 0, Number.POSITIVE_INFINITY],
    ['room for all at the minimum width', SLOT * 7 + ACTIVE_MENU_WIDTH, 7, 0, 7],
    ['one pixel short: the overflow menu', SLOT * 7 + ACTIVE_MENU_WIDTH - 1, 7, 0, 6],
    [
      'the overflow button takes room',
      SLOT * 4 + ACTIVE_MENU_WIDTH + OVERFLOW_BUTTON_WIDTH,
      7,
      0,
      4,
    ],
    [
      'the rest of the strip ("New view") is reserved',
      SLOT * 4 + ACTIVE_MENU_WIDTH + OVERFLOW_BUTTON_WIDTH + 100,
      7,
      100,
      4,
    ],
    ['at least the open tab', 50, 7, 0, 1],
  ])('%s', (_label, width, count, reserved, expected) => {
    expect(tabCapacity(width, count, reserved)).toBe(expected);
  });

  it('short names keep their natural width; long ones stop at the minimum', () => {
    expect(tabMinWidth(30, 0)).toBe(66);
    expect(tabMinWidth(30, 1)).toBe(86);
    expect(tabMinWidth(400, 0)).toBe(TAB_MIN_WIDTH);
  });

  it('counts each tab at its own minimum; the open tab takes the last slot', () => {
    const mins = [60, 60, 60, TAB_MIN_WIDTH, TAB_MIN_WIDTH];
    const all = mins.reduce((sum, min) => sum + min + TAB_GAP, 0) + ACTIVE_MENU_WIDTH;
    expect(tabCapacity(all, 5, 0, mins)).toBe(5);
    // Three short tabs + overflow button fit, not a fourth long one.
    const three = 3 * (60 + TAB_GAP) + ACTIVE_MENU_WIDTH + OVERFLOW_BUTTON_WIDTH + 8;
    expect(tabCapacity(three, 5, 0, mins)).toBe(3);
    // The open tab (long, index 4) replaces the third: only two short ones fit beside it.
    expect(tabCapacity(three, 5, 0, mins, 4)).toBe(2);
  });

  it('never plans tabs narrower than the minimum (no overlap, about 12 characters)', () => {
    for (let width = 200; width <= 1600; width += 7) {
      for (const count of [1, 3, 8, 20]) {
        const shown = Math.min(count, tabCapacity(width, count, 120));
        const needed =
          shown * TAB_MIN_WIDTH +
          (shown - 1) * TAB_GAP +
          ACTIVE_MENU_WIDTH +
          (shown < count ? OVERFLOW_BUTTON_WIDTH : 0) +
          120;
        // One tab is always shown, even when it does not fit.
        if (shown > 1) expect(needed).toBeLessThanOrEqual(width);
      }
    }
  });

  it.each<[string, string, number, string[], string[]]>([
    ['all fit', 'c', 7, ['a', 'b', 'c', 'd', 'e', 'f', 'g'], []],
    ['the open tab is among the first', 'b', 3, ['a', 'b', 'c'], ['d', 'e', 'f', 'g']],
    ['the open tab takes the last slot', 'f', 3, ['a', 'b', 'f'], ['c', 'd', 'e', 'g']],
    ['one slot: only the open tab', 'g', 1, ['g'], ['a', 'b', 'c', 'd', 'e', 'f']],
  ])('%s', (_label, active, capacity, visible, overflow) => {
    const plan = planTabs(views, active, capacity);
    expect(ids(plan.visible)).toEqual(visible);
    expect(ids(plan.overflow)).toEqual(overflow);
  });

  it.each<[string, { x: number; y: number } | null, { x: number; y: number }, boolean]>([
    ['no press (keyboard)', null, { x: 0, y: 0 }, true],
    ['released in place', { x: 10, y: 10 }, { x: 12, y: 11 }, true],
    ['dragged away', { x: 10, y: 10 }, { x: 60, y: 10 }, false],
  ])('%s → click %s', (_label, from, to, expected) => {
    expect(isClick(from, to)).toBe(expected);
  });
});
