import type { GridRecord } from './types';
import type { Rectangle } from '@glideapps/glide-data-grid';

/**
 * Colors of rows and cells by the color rules of a view (T816, FRONTEND
 * §6.9). The screen decides which color a cell gets (`GridColorPaint`,
 * from `record.meta.color` the server computed); the adapter only paints.
 */

/** What one colored cell draws: a background and the left mark. */
export interface GridCellPaint {
  /** Opaque background (`--rule-<color>-bg`). */
  readonly bg: string;
  /** The left stripe (`--rule-<color>-mark`), so the color is not the only signal. */
  readonly mark: string;
  /**
   * A row rule: the stripe is drawn on the first column only; a cell rule
   * draws it in its own cell.
   */
  readonly row: boolean;
}

/**
 * The paint of one cell, `null` when it is not colored. Called while drawing
 * every visible cell: it must not allocate (return shared paint objects).
 */
export type GridColorPaint = (record: GridRecord, fieldId: string) => GridCellPaint | null;

/** Width of the left mark, px. */
export const RULE_MARK_WIDTH = 3;

/**
 * Paints `paint` under the cell's content. A selected or highlighted cell
 * keeps glide's selection fill (the selection must stay visible); the mark
 * is drawn either way.
 */
export function drawRuleColor(
  ctx: CanvasRenderingContext2D,
  rect: Rectangle,
  paint: GridCellPaint,
  firstColumn: boolean,
  highlighted: boolean,
): void {
  const fillStyle = ctx.fillStyle;
  if (!highlighted) {
    ctx.fillStyle = paint.bg;
    // Inside the grid lines (glide draws them over the cells' edges).
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  }
  if (!paint.row || firstColumn) {
    ctx.fillStyle = paint.mark;
    ctx.fillRect(rect.x, rect.y, RULE_MARK_WIDTH, rect.height);
  }
  ctx.fillStyle = fillStyle;
}
