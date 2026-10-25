import { TREE_MAX_LEVELS, type TreeNode } from './tree-rows';

import type { DropPlacement, MoveProblem } from '../../../grid/tree/types';

export type { DropPlacement, MoveProblem };

/**
 * Where a record goes when it is dragged, indented or outdented (T417,
 * BACKLOG S4 design decision 3). Pure. Records have no manual order (SPEC
 * §4): a move only changes the parent — the record lands among its new
 * siblings where the view's order puts it.
 */

export type MoveCheck =
  | { readonly ok: true; readonly parentId: string | null }
  | { readonly ok: false; readonly problem: MoveProblem };

/** The rows a move is checked against (a window of the tree's model). */
export interface MoveSource {
  readonly nodeAt: (row: number) => TreeNode | undefined;
  /** Last row of a row's branch (its expanded descendants). */
  readonly branchEnd: (row: number) => number;
}

/**
 * Levels below a row that are loaded (0: no child row loaded): a moved
 * branch takes them along, so they count against the depth limit. Rows of
 * collapsed branches are unknown here; the server checks them.
 */
export function loadedHeight(source: MoveSource, row: number): number {
  const node = source.nodeAt(row);
  if (node === undefined) return 0;
  let height = 0;
  const end = source.branchEnd(row);
  for (let index = row + 1; index <= end; index += 1) {
    const below = source.nodeAt(index);
    if (below !== undefined) height = Math.max(height, below.depth - node.depth);
  }
  return height;
}

/**
 * Checks a new parent for the record of `row` (`parentId` null: a root;
 * `parentDepth` its depth, -1 for none): the record itself or one of its
 * descendants is a cycle (SUBRECORD_CYCLE); deeper than 10 levels with the
 * branch it takes along is SUBRECORD_TOO_DEEP.
 */
export function checkMove(
  source: MoveSource,
  row: number,
  parentId: string | null,
  parentDepth: number,
  parentAncestors: readonly string[] = [],
): MoveCheck {
  const node = source.nodeAt(row);
  if (node?.recordId === undefined) return { ok: false, problem: 'unloaded' };
  if (node.parentId === parentId) return { ok: false, problem: 'same' };
  if (parentId === node.recordId || parentAncestors.includes(node.recordId)) {
    return { ok: false, problem: 'cycle' };
  }
  const depth = parentId === null ? 0 : parentDepth + 1;
  if (depth + loadedHeight(source, row) > TREE_MAX_LEVELS - 1) {
    return { ok: false, problem: 'depth' };
  }
  return { ok: true, parentId };
}

/** Dropping the row `row` on (or next to) the row `target`. */
export function checkDrop(
  source: MoveSource,
  row: number,
  target: number,
  placement: DropPlacement,
): MoveCheck {
  const over = source.nodeAt(target);
  if (over?.recordId === undefined) return { ok: false, problem: 'unloaded' };
  if (placement === 'child') {
    return checkMove(source, row, over.recordId, over.depth, over.ancestors);
  }
  // Between rows: a sibling of the row it is dropped next to.
  const moving = source.nodeAt(row);
  if (moving?.recordId !== undefined && over.recordId === moving.recordId) {
    return { ok: false, problem: 'same' };
  }
  return checkMove(source, row, over.parentId, over.depth - 1, over.ancestors.slice(0, -1));
}

/**
 * Indent ("Make a sub-record of the row above", Ctrl/⌘+]): the record
 * becomes a child of its previous sibling. `undefined`: nothing to indent
 * under (first sibling).
 */
export function indentTarget(source: MoveSource, row: number): MoveCheck | undefined {
  const node = source.nodeAt(row);
  if (node === undefined || node.offset === 0) return undefined;
  // The previous sibling is the closest row above at the same depth.
  for (let above = row - 1; above >= 0; above -= 1) {
    const candidate = source.nodeAt(above);
    if (candidate === undefined) return { ok: false, problem: 'unloaded' };
    if (candidate.depth < node.depth) return undefined;
    if (candidate.depth === node.depth) {
      if (candidate.recordId === undefined) return { ok: false, problem: 'unloaded' };
      return checkMove(source, row, candidate.recordId, candidate.depth, candidate.ancestors);
    }
  }
  return undefined;
}

/**
 * Outdent ("Move up one level", Ctrl/⌘+[): the record becomes a sibling of
 * its parent. `undefined` for a root.
 */
export function outdentTarget(source: MoveSource, row: number): MoveCheck | undefined {
  const node = source.nodeAt(row);
  if (node === undefined || node.depth === 0) return undefined;
  const grandparent = node.ancestors.length >= 2 ? (node.ancestors.at(-2) ?? null) : null;
  return checkMove(source, row, grandparent, node.depth - 2, node.ancestors.slice(0, -2));
}
