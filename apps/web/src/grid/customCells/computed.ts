import { GridCellKind } from '@glideapps/glide-data-grid';

import { fitText, withCellClip } from './draw';
import { drawLock, LOCK_SIZE } from './links';

import type { CustomCell, CustomRenderer, GridCell } from '@glideapps/glide-data-grid';

/**
 * Cells of a computed column that show no value (T468, board "S4b · Cột
 * tính toán: lỗi và tính lại"):
 * - `lock`: the reader cannot read the source (P34–P36) — a padlock, nothing else;
 * - `token`: a field-level error — `#REF!`, `#CIRCLE!`, `#TIMEOUT!`,
 *   `#VALUE!` in grey monospace (the API reads `null`);
 * - `pending`: a new field being computed — a dim "…".
 *
 * `copyData` is what screen readers get (glide's accessibility table reads
 * it for custom cells); the clipboard never reads it (`cellClipboardText`
 * gives the value, `null` here: copy is empty).
 */
export interface ComputedMarkData {
  readonly kind: 'ob-computed-mark';
  readonly mark: 'lock' | 'token' | 'pending';
  readonly text: string;
  readonly color: string;
  /** Monospace family of the tokens. */
  readonly fontCode: string;
  readonly align: 'left' | 'right';
}

export type ComputedMarkCell = CustomCell<ComputedMarkData>;

export function isComputedMarkCell(cell: GridCell): cell is ComputedMarkCell {
  return (
    cell.kind === GridCellKind.Custom &&
    (cell.data as { kind?: unknown }).kind === 'ob-computed-mark'
  );
}

/** Opacity of the "…" of a field being filled (board: 0.6). */
const PENDING_ALPHA = 0.6;

export const computedMarkRenderer: CustomRenderer<ComputedMarkCell> = {
  kind: GridCellKind.Custom,
  isMatch: (cell): cell is ComputedMarkCell =>
    (cell.data as { kind?: unknown }).kind === 'ob-computed-mark',
  needsHover: false,
  draw: (args, cell) => {
    const { ctx, rect, theme } = args;
    const { mark, text, color, fontCode, align } = cell.data;
    const left = rect.x + theme.cellHorizontalPadding;
    const right = rect.x + rect.width - theme.cellHorizontalPadding;
    const middle = rect.y + rect.height / 2;
    withCellClip(ctx, rect, () => {
      if (mark === 'lock') {
        const x = align === 'right' ? right - LOCK_SIZE : left;
        drawLock(ctx, x, middle, LOCK_SIZE, color);
        return;
      }
      ctx.font =
        mark === 'token' ? `12px ${fontCode}` : `${theme.baseFontStyle} ${theme.fontFamily}`;
      ctx.fillStyle = color;
      if (mark === 'pending') ctx.globalAlpha = PENDING_ALPHA;
      const shown = fitText(ctx, mark === 'pending' ? '…' : text, right - left);
      if (align === 'right') {
        ctx.textAlign = 'right';
        ctx.fillText(shown, right, middle);
      } else {
        ctx.fillText(shown, left, middle);
      }
    });
  },
};
