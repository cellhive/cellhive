import { checkLayout, compactLayout, type GridItem } from '@cellhive/contracts';
import { describe, expect, it } from 'vitest';

import { arrowDirection, moveItem, resizeItem, settleLayout } from '../edit/grid-moves';

const item = (id: string, x: number, y: number, w: number, h: number): GridItem => ({
  id,
  x,
  y,
  w,
  h,
});

/** `id@x,y wxh` of each item, in reading order. */
const describeLayout = (items: readonly GridItem[] | null) =>
  items === null
    ? null
    : items.map(
        (entry) =>
          `${entry.id}@${String(entry.x)},${String(entry.y)} ${String(entry.w)}x${String(entry.h)}`,
      );

/** Every result is valid and already compacted (the server would not move anything). */
function expectSettled(items: readonly GridItem[] | null) {
  expect(items).not.toBeNull();
  const layout = items ?? [];
  expect(checkLayout(layout)).toEqual([]);
  expect(describeLayout(compactLayout(layout))).toEqual(describeLayout(layout));
}

// A stacked on B in one column, C beside them.
const stack = [item('a', 0, 0, 6, 4), item('b', 0, 4, 6, 3), item('c', 6, 0, 6, 2)];

describe('moveItem (T812, keyboard moves)', () => {
  it.each([
    {
      name: 'right by one column',
      items: [item('a', 0, 0, 4, 2)],
      id: 'a',
      direction: 'right' as const,
      expected: ['a@1,0 4x2'],
    },
    {
      name: 'left at the first column: cannot',
      items: [item('a', 0, 0, 4, 2)],
      id: 'a',
      direction: 'left' as const,
      expected: null,
    },
    {
      name: 'right at the last column: cannot',
      items: [item('a', 8, 0, 4, 2)],
      id: 'a',
      direction: 'right' as const,
      expected: null,
    },
    {
      name: 'down past the widget below (they swap)',
      items: stack,
      id: 'a',
      direction: 'down' as const,
      expected: ['b@0,0 6x3', 'c@6,0 6x2', 'a@0,3 6x4'],
    },
    {
      name: 'up past the widget above (they swap)',
      items: stack,
      id: 'b',
      direction: 'up' as const,
      expected: ['b@0,0 6x3', 'c@6,0 6x2', 'a@0,3 6x4'],
    },
    {
      name: 'up at the top: cannot',
      items: stack,
      id: 'a',
      direction: 'up' as const,
      expected: null,
    },
    {
      name: 'down with nothing below: cannot (no empty rows in a compacted grid)',
      items: stack,
      id: 'c',
      direction: 'down' as const,
      expected: null,
    },
    {
      name: 'right into a neighbour pushes it below',
      items: [item('a', 0, 0, 6, 2), item('b', 6, 0, 6, 3)],
      id: 'a',
      direction: 'right' as const,
      expected: ['a@1,0 6x2', 'b@6,2 6x3'],
    },
  ])('$name', ({ items, id, direction, expected }) => {
    const result = moveItem(items, id, direction);
    expect(describeLayout(result)).toEqual(expected);
    if (expected !== null) expectSettled(result);
  });
});

describe('resizeItem (T812, keyboard resize)', () => {
  it.each([
    { direction: 'right' as const, expected: ['a@0,0 7x4', 'c@7,0 5x2', 'b@0,4 6x3'] },
    { direction: 'down' as const, expected: ['a@0,0 6x5', 'c@6,0 6x2', 'b@0,5 6x3'] },
    { direction: 'up' as const, expected: ['a@0,0 6x3', 'c@6,0 6x2', 'b@0,3 6x3'] },
    { direction: 'left' as const, expected: ['a@0,0 5x4', 'c@6,0 6x2', 'b@0,4 6x3'] },
  ])('$direction', ({ direction, expected }) => {
    // To widen A, C starts one column further right.
    const items =
      direction === 'right'
        ? [item('a', 0, 0, 6, 4), item('b', 0, 4, 6, 3), item('c', 7, 0, 5, 2)]
        : stack;
    const result = resizeItem(items, 'a', direction);
    expect(describeLayout(result)).toEqual(expected);
    expectSettled(result);
  });

  it.each([
    {
      name: 'narrower than one column',
      items: [item('a', 0, 0, 1, 2)],
      direction: 'left' as const,
    },
    { name: 'shorter than two rows', items: [item('a', 0, 0, 4, 2)], direction: 'up' as const },
    { name: 'past the last column', items: [item('a', 6, 0, 6, 2)], direction: 'right' as const },
    { name: 'taller than 24 rows', items: [item('a', 0, 0, 4, 24)], direction: 'down' as const },
  ])('cannot: $name', ({ items, direction }) => {
    expect(resizeItem(items, 'a', direction)).toBeNull();
  });
});

describe('settleLayout', () => {
  it('pushes overlapped widgets below and compacts', () => {
    const result = settleLayout(
      [item('a', 0, 0, 12, 2), item('b', 0, 1, 6, 2), item('c', 6, 5, 6, 2)],
      'a',
    );
    expect(describeLayout(result)).toEqual(['a@0,0 12x2', 'b@0,2 6x2', 'c@6,2 6x2']);
  });
});

describe('arrowDirection', () => {
  it.each([
    ['ArrowLeft', 'left'],
    ['ArrowRight', 'right'],
    ['ArrowUp', 'up'],
    ['ArrowDown', 'down'],
    ['Enter', null],
  ])('%s → %s', (key, expected) => {
    expect(arrowDirection(key)).toBe(expected);
  });
});
