import type { DropPlacement, GridTreeNode } from './types';
import type { Rectangle } from '@glideapps/glide-data-grid';

/**
 * Canvas drawing of the tree column (T417, board "Sub-records dạng cây"):
 * one 20 px guide per level (a 1 px line in its middle), a 20 px box with
 * the branch caret, then the cell's own content; a closed branch shows its
 * child count in a pill after the text. Pure geometry + canvas calls.
 */

/** Width of one level of indent, px. */
export const TREE_INDENT = 20;
/** Box of the caret, px. */
export const TREE_CARET = 20;
/** The tree starts this far into the cell (the board pulls it 4 px left of the text padding). */
export const TREE_LEFT = 4;

/** How far the cell's own content moves right for a row at `depth`. */
export function treeInset(depth: number): number {
  return (depth + 1) * TREE_INDENT;
}

/** Screen box of the caret of a row at `depth` in a cell at `cell`. */
export function caretBox(cell: Rectangle, depth: number): Rectangle {
  return {
    x: cell.x + TREE_LEFT + depth * TREE_INDENT,
    y: cell.y + (cell.height - TREE_CARET) / 2,
    width: TREE_CARET,
    height: TREE_CARET,
  };
}

/** Whether a click `x` px into the first cell hits the caret of a row at `depth`. */
export function hitsCaret(localX: number, depth: number): boolean {
  const left = TREE_LEFT + depth * TREE_INDENT;
  return localX >= left - 2 && localX <= left + TREE_CARET + 2;
}

/** Where a drop lands given how far down the pointer is in a row: top quarter, bottom quarter, middle. */
export function placementAt(fraction: number): DropPlacement {
  if (fraction < 0.25) return 'before';
  if (fraction > 0.75) return 'after';
  return 'child';
}

export interface TreeColors {
  readonly guide: string;
  readonly caret: string;
  readonly pill: string;
  readonly pillText: string;
}

/** Guides and caret, before the cell draws its content (shifted by `treeInset`). */
export function drawTreeLead(
  ctx: CanvasRenderingContext2D,
  rect: Rectangle,
  node: GridTreeNode,
  colors: TreeColors,
): void {
  ctx.save();
  ctx.strokeStyle = colors.guide;
  ctx.lineWidth = 1;
  for (let level = 0; level < node.depth; level += 1) {
    const x = Math.round(rect.x + TREE_LEFT + level * TREE_INDENT + TREE_INDENT / 2) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, rect.y);
    ctx.lineTo(x, rect.y + rect.height);
    ctx.stroke();
  }
  if (node.childCount > 0) {
    const box = caretBox(rect, node.depth);
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    ctx.strokeStyle = colors.caret;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    if (node.expanded) {
      // ▾ chevron down (lucide "chevron-down" at 14 px).
      ctx.moveTo(cx - 3.5, cy - 1.75);
      ctx.lineTo(cx, cy + 1.75);
      ctx.lineTo(cx + 3.5, cy - 1.75);
    } else {
      // ▸ chevron right.
      ctx.moveTo(cx - 1.75, cy - 3.5);
      ctx.lineTo(cx + 1.75, cy);
      ctx.lineTo(cx - 1.75, cy + 3.5);
    }
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * The child count of a closed branch, right after the text (`textEnd`, px
 * from the cell's left), when it fits in the cell.
 */
export function drawChildCount(
  ctx: CanvasRenderingContext2D,
  rect: Rectangle,
  textEnd: number,
  label: string,
  font: string,
  colors: TreeColors,
): void {
  ctx.save();
  ctx.font = font;
  const width = Math.ceil(ctx.measureText(label).width) + 12;
  const height = 18;
  const x = rect.x + textEnd + 6;
  if (x + width > rect.x + rect.width - 4) {
    ctx.restore();
    return;
  }
  const y = rect.y + (rect.height - height) / 2;
  ctx.fillStyle = colors.pill;
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, height / 2);
  ctx.fill();
  ctx.fillStyle = colors.pillText;
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x + 6, y + height / 2 + 0.5);
  ctx.restore();
}
