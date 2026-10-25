import type { GridRowFrame } from '../rows';
import type { Rectangle } from '@glideapps/glide-data-grid';

/**
 * Group cards of a grouped grid (T320a, Lark Base): every group is a white
 * card on the page background, nested groups are cards inset inside it.
 * Glide's own grid lines are off while grouped (they would cross the
 * spacers); every cell paints its card background and its own lines here:
 * the bottom line and the right line of the cell (the last pixel row and
 * column, like glide's damage redraws expect), the card's top border on a
 * header, and the card's left borders and indent in the row gutter.
 */

/** Left edge of the outermost card inside the row gutter, px. */
export const CARD_MARGIN = 6;
/** Inset of each nested card, px. */
export const CARD_INDENT = 16;
/** Corner radius of a card, px. */
export const CARD_RADIUS = 6;
/** Spacer between top-level cards (and before the first), px. */
export const GAP_HEIGHT = 16;
/** Spacer between nested cards and under the last one, px. */
export const NESTED_GAP_HEIGHT = 8;

/** Height of a spacer row of `depth` (`GridRowModel.gapDepth`). */
export function gapHeight(depth: number): number {
  return depth === 0 ? GAP_HEIGHT : NESTED_GAP_HEIGHT;
}

/** Colors of the cards (from the design tokens: the canvas cannot read CSS variables). */
export interface CardColors {
  /** Page behind the cards (`surface-sunken`). */
  readonly page: string;
  /** Card background (`surface`). */
  readonly card: string;
  /** Card borders and cell lines (`border`). */
  readonly line: string;
  /** Tint of selected cells (glide's `accentLight`). */
  readonly selected: string;
}

/** What a cell of a card row draws besides its content. */
export interface CardCellLines {
  /** A line on the right edge (column separator, frozen divider, card's right border). */
  readonly right: boolean;
  /** The right edge is the card's right border (rounded on the outermost card). */
  readonly cardRight: boolean;
  /** A line on the bottom edge (row separator); card bottoms always get one. */
  readonly bottom: boolean;
}

/** Width of the row gutter (row numbers) of a grid grouped in `depth` levels. */
export function gutterWidth(depth: number, numberWidth: number): number {
  return CARD_MARGIN + Math.max(0, depth - 1) * CARD_INDENT + numberWidth;
}

/** Left edge of the card of level `level` in a gutter starting at `x`. */
export function cardLeft(x: number, level: number): number {
  return x + CARD_MARGIN + level * CARD_INDENT;
}

/** Where the row number (or a header's chevron, a "+") goes in the gutter of a row. */
export function gutterContent(rect: Rectangle, frame: GridRowFrame): Rectangle {
  const left = cardLeft(rect.x, Math.max(0, frame.depth - 1));
  const right = rect.x + rect.width;
  return { x: left, y: rect.y, width: Math.max(0, right - left), height: rect.height };
}

/** A rectangle path with some corners rounded. */
function cornerPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  corners: { tl: boolean; tr: boolean; bl: boolean; br: boolean },
): void {
  const r = Math.min(CARD_RADIUS, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + (corners.tl ? r : 0), y);
  if (corners.tr) {
    ctx.lineTo(x + width - r, y);
    ctx.arcTo(x + width, y, x + width, y + r, r);
  } else {
    ctx.lineTo(x + width, y);
  }
  if (corners.br) {
    ctx.lineTo(x + width, y + height - r);
    ctx.arcTo(x + width, y + height, x + width - r, y + height, r);
  } else {
    ctx.lineTo(x + width, y + height);
  }
  if (corners.bl) {
    ctx.lineTo(x + r, y + height);
    ctx.arcTo(x, y + height, x, y + height - r, r);
  } else {
    ctx.lineTo(x, y + height);
  }
  if (corners.tl) {
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
  } else {
    ctx.lineTo(x, y);
  }
  ctx.closePath();
}

/**
 * The row gutter (glide's row-marker column) of a card row: the page
 * background left of the outermost card, each card's white band and left
 * border (rounded at a card's top and bottom), the row line.
 */
export function paintGutter(
  ctx: CanvasRenderingContext2D,
  rect: Rectangle,
  frame: GridRowFrame,
  kind: 'data' | 'group' | 'add' | 'gap',
  colors: CardColors,
  highlighted: boolean,
  /** The row line under the row (not under a header whose first nested card follows). */
  rowLine = kind === 'data' || kind === 'group',
): void {
  const { x, y, width, height } = rect;
  const right = x + width;
  ctx.save();
  ctx.fillStyle = colors.page;
  ctx.fillRect(x, y, width, height);
  const innermost = frame.depth - 1;
  for (let level = 0; level <= innermost; level += 1) {
    const left = cardLeft(x, level);
    const isInner = level === innermost;
    const top = isInner && frame.top;
    const bottom = isInner && frame.bottom;
    ctx.fillStyle = colors.card;
    // Extends past the right edge (clipped): only the left corners are rounded.
    cornerPath(ctx, left, y, right - left + CARD_RADIUS, height, {
      tl: top,
      tr: false,
      bl: bottom,
      br: false,
    });
    ctx.fill();
    if (isInner && highlighted && kind === 'data') {
      ctx.fillStyle = colors.selected;
      ctx.fillRect(left + 1, y, right - left - 1, height - 1);
    }
    // Left border, with the corners.
    ctx.strokeStyle = colors.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const lx = left + 0.5;
    const r = CARD_RADIUS;
    if (top) {
      ctx.moveTo(right, y + 0.5);
      ctx.lineTo(lx + r, y + 0.5);
      ctx.arcTo(lx, y + 0.5, lx, y + 0.5 + r, r);
    } else {
      ctx.moveTo(lx, y);
    }
    if (bottom) {
      ctx.lineTo(lx, y + height - 0.5 - r);
      ctx.arcTo(lx, y + height - 0.5, lx + r, y + height - 0.5, r);
      ctx.lineTo(right, y + height - 0.5);
    } else {
      ctx.lineTo(lx, y + height);
    }
    ctx.stroke();
  }
  // Row line (data rows, headers) from the innermost card's border.
  if (innermost >= 0 && !frame.bottom && rowLine) {
    ctx.beginPath();
    ctx.moveTo(cardLeft(x, innermost) + 0.5, y + height - 0.5);
    ctx.lineTo(right, y + height - 0.5);
    ctx.strokeStyle = colors.line;
    ctx.stroke();
  }
  ctx.restore();
}

/** Background of a cell in a card row (before its content). */
export function paintCardCell(
  ctx: CanvasRenderingContext2D,
  rect: Rectangle,
  frame: GridRowFrame,
  lines: CardCellLines,
  colors: CardColors,
  highlighted: boolean,
): void {
  const { x, y, width, height } = rect;
  ctx.save();
  if (frame.depth === 0) {
    ctx.fillStyle = colors.page;
    ctx.fillRect(x, y, width, height);
    ctx.restore();
    return;
  }
  const rounded = lines.cardRight && frame.depth === 1;
  if (rounded && (frame.top || frame.bottom)) {
    ctx.fillStyle = colors.page;
    ctx.fillRect(x, y, width, height);
    ctx.fillStyle = colors.card;
    cornerPath(ctx, x - CARD_RADIUS, y, width + CARD_RADIUS, height, {
      tl: false,
      tr: frame.top,
      bl: false,
      br: frame.bottom,
    });
    ctx.fill();
  } else {
    ctx.fillStyle = colors.card;
    ctx.fillRect(x, y, width, height);
  }
  if (highlighted) {
    ctx.fillStyle = colors.selected;
    ctx.fillRect(x, y, width - (lines.right ? 1 : 0), height - 1);
  }
  ctx.restore();
}

/** Lines of a cell in a card row (after its content). */
export function strokeCardCell(
  ctx: CanvasRenderingContext2D,
  rect: Rectangle,
  frame: GridRowFrame,
  lines: CardCellLines,
  colors: CardColors,
): void {
  if (frame.depth === 0) return;
  const { x, y, width, height } = rect;
  const right = x + width - 0.5;
  const rounded = lines.cardRight && frame.depth === 1;
  const r = CARD_RADIUS;
  ctx.save();
  ctx.strokeStyle = colors.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (frame.top) {
    ctx.moveTo(x, y + 0.5);
    if (lines.right && rounded) {
      ctx.lineTo(right - r, y + 0.5);
      ctx.arcTo(right, y + 0.5, right, y + 0.5 + r, r);
    } else {
      ctx.lineTo(x + width, y + 0.5);
    }
  }
  if (lines.right) {
    ctx.moveTo(right, frame.top && rounded ? y + 0.5 + r : y);
    ctx.lineTo(right, frame.bottom && rounded ? y + height - 0.5 - r : y + height);
    if (frame.bottom && rounded) {
      ctx.arcTo(right, y + height - 0.5, right - r, y + height - 0.5, r);
    }
  }
  if (lines.bottom || frame.bottom) {
    const end = frame.bottom && rounded && lines.right ? right - r : x + width;
    ctx.moveTo(end, y + height - 0.5);
    ctx.lineTo(x, y + height - 0.5);
  }
  ctx.stroke();
  ctx.restore();
}

/** A chevron: ▾ expanded, ▸ collapsed, centered on (`cx`, `cy`). */
export function drawChevron(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  collapsed: boolean,
  color: string,
): void {
  ctx.save();
  ctx.beginPath();
  if (collapsed) {
    ctx.moveTo(cx - 2, cy - 4);
    ctx.lineTo(cx + 2.5, cy);
    ctx.lineTo(cx - 2, cy + 4);
  } else {
    ctx.moveTo(cx - 4, cy - 2);
    ctx.lineTo(cx, cy + 2.5);
    ctx.lineTo(cx + 4, cy - 2);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

/** A "+" centered on (`cx`, `cy`). */
export function drawPlus(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  color: string,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(cx - 5, cy);
  ctx.lineTo(cx + 5, cy);
  ctx.moveTo(cx, cy - 5);
  ctx.lineTo(cx, cy + 5);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.restore();
}
