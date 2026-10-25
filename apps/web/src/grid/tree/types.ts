import type { CellAddress, HeaderMenuAnchor } from '../hooks';

/**
 * A grid shown as a sub-record tree (T417, FRONTEND §3.3). Every row is a
 * record (no header or spacer rows): the adapter draws the indent, the
 * branch caret and the child count in the first column, dims the
 * ancestors shown only for context, pins the parent path while scrolling
 * inside a branch, and turns the drag handle, the caret and the tree keys
 * into these hooks. What a move does is up to the page.
 */

/** Where a dragged row is dropped: onto a row (its child) or between rows (its sibling). */
export type DropPlacement = 'child' | 'before' | 'after';

/** Why a move is refused before it is sent (the server says the same, CONTRACTS §1.4). */
export type MoveProblem = 'same' | 'cycle' | 'depth' | 'unloaded';

/** A row of the tree as the grid draws it. */
export interface GridTreeNode {
  /** `undefined` while the row loads. */
  readonly recordId: string | undefined;
  /** 0 for a root. */
  readonly depth: number;
  readonly parentId: string | null;
  /** Record ids from the root down to the parent. */
  readonly ancestors: readonly string[];
  /** Children in the visible tree (0: a leaf, no caret). */
  readonly childCount: number;
  readonly expanded: boolean;
  /** Shown only as an ancestor of a filter match: dimmed (`ancestor_only`). */
  readonly ancestorOnly: boolean;
}

export interface GridTreeHooks {
  /** The caret (click), → / ← on the first column. */
  readonly onToggle: (recordId: string, row: number) => void;
  /** A crumb of the sticky parent path: the grid scrolls to that record and selects it. */
  readonly onReveal: (recordId: string) => void;
  /** "+ Sub-record" on the hovered row; absent without the right to add records. */
  readonly onAddChild?: ((recordId: string, row: number) => void) | undefined;
  /**
   * Drag ⋮⋮, indent / outdent (menu, Ctrl/⌘+] / [, Alt+Shift+→ / ←);
   * absent without the right to change the parent field.
   */
  readonly moves?: GridTreeMoves | undefined;
  /**
   * Right click on a cell of the tree: the row menu (open, cell history,
   * add a sub-record or a sibling, change the parent, indent, outdent,
   * delete) instead of the plain cell menu.
   */
  readonly onRowMenu?:
    ((cell: CellAddress, row: number, anchor: HeaderMenuAnchor) => void) | undefined;
}

export interface GridTreeMoves {
  /** Whether dropping `row` on / next to `target` is allowed (the drop indicator says why not). */
  readonly checkDrop: (row: number, target: number, placement: DropPlacement) => MoveProblem | null;
  readonly onDrop: (row: number, target: number, placement: DropPlacement) => void;
  readonly onIndent: (row: number) => void;
  readonly onOutdent: (row: number) => void;
}

export interface GridTree {
  readonly nodeAt: (row: number) => GridTreeNode | undefined;
  /** Title of a record of the tree (primary field as text): the sticky parent path. */
  readonly titleOf: (recordId: string) => string;
  readonly hooks: GridTreeHooks;
}
