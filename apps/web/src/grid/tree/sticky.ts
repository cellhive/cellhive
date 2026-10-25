import type { GridTreeNode } from './types';

const NONE: readonly string[] = [];

/**
 * The sticky parent path of a tree (T417, fixed in T421b): the ancestors of
 * `underPath` (the first row below the 30 px path) that have scrolled above
 * the screen — those still on it need no reminder. `first` is the first row
 * on screen without the path: when it is a root (the top of the grid, or a
 * root scrolled to the top) nothing is pinned, so the path never covers a
 * root. Pure.
 */
export function stickyTreePath(
  nodeAt: (row: number) => GridTreeNode | undefined,
  first: number,
  underPath: number,
): readonly string[] {
  const top = nodeAt(first);
  if (top === undefined || top.depth === 0) return NONE;
  const node = nodeAt(underPath);
  if (node === undefined || node.ancestors.length === 0) return NONE;
  const onScreen = new Set<string>();
  for (let row = first; row < underPath; row += 1) {
    const covered = nodeAt(row);
    // A root between them: another tree, nothing of this branch to pin.
    if (covered === undefined || covered.depth === 0) return NONE;
    if (covered.recordId !== undefined) onScreen.add(covered.recordId);
  }
  const above = node.ancestors.filter((id) => !onScreen.has(id));
  return above.length === 0 ? NONE : above;
}
