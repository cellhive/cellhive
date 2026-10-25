import { describe, expect, it } from 'vitest';

import { stickyTreePath } from '../tree/sticky';

import type { GridTreeNode } from '../tree/types';

/** A → A1 → A1a, A → A2, B, C (display order, all open). */
const ROWS: readonly (readonly [string, readonly string[]])[] = [
  ['A', []],
  ['A1', ['A']],
  ['A1a', ['A', 'A1']],
  ['A2', ['A']],
  ['B', []],
  ['C', []],
];

const nodeAt = (row: number): GridTreeNode | undefined => {
  const entry = ROWS[row];
  if (entry === undefined) return undefined;
  const [recordId, ancestors] = entry;
  return {
    recordId,
    depth: ancestors.length,
    parentId: ancestors.at(-1) ?? null,
    ancestors,
    childCount: 0,
    expanded: true,
    ancestorOnly: false,
  };
};

describe('stickyTreePath (T421b: only ancestors scrolled off the screen, never over a root)', () => {
  it.each([
    // [first row on screen, first row under the path, path]
    ['top of the grid: a root is first, nothing pinned', 0, 1, []],
    // A1 is still on screen: only A (scrolled away) is pinned.
    ['the parent is still on screen', 1, 2, ['A']],
    ['inside a branch whose root scrolled away', 1, 1, ['A']],
    ['deeper: every ancestor above the screen', 2, 3, ['A']],
    ['a root reaches the path: nothing pinned', 3, 4, []],
    ['a root is first', 4, 5, []],
  ] as const)('%s', (_, first, underPath, expected) => {
    expect(stickyTreePath(nodeAt, first, underPath)).toEqual(expected);
  });

  it('pins the whole chain when the first row is two levels down', () => {
    expect(stickyTreePath(nodeAt, 2, 2)).toEqual(['A', 'A1']);
  });

  it('a deep chain: pins the ancestors above the screen, not those still on it', () => {
    // Rows: L0 → L1 → … → L6, one per level (the "ten levels" case).
    const chain = (row: number): GridTreeNode | undefined =>
      row > 6
        ? undefined
        : {
            recordId: `L${String(row)}`,
            depth: row,
            parentId: row === 0 ? null : `L${String(row - 1)}`,
            ancestors: Array.from({ length: row }, (_, index) => `L${String(index)}`),
            childCount: row === 6 ? 0 : 1,
            expanded: true,
            ancestorOnly: false,
          };
    expect(stickyTreePath(chain, 3, 4)).toEqual(['L0', 'L1', 'L2']);
    expect(stickyTreePath(chain, 0, 1)).toEqual([]);
  });

  it('is empty past the last row', () => {
    expect(stickyTreePath(nodeAt, 9, 9)).toEqual([]);
  });
});
