import { GridCellKind, measureTextCached } from '@glideapps/glide-data-grid';

import { fillRoundedRect, fontOf, withCellClip } from './draw';

import type { CustomCell, CustomRenderer } from '@glideapps/glide-data-grid';

export interface ProgressCellData {
  readonly kind: 'ob-progress';
  /** Filled share, clamped to 0–1. */
  readonly fraction: number;
  /** Formatted value (`field-types` `formatText`), written next to the bar. */
  readonly label: string;
  readonly color: string;
  readonly track: string;
}

export type ProgressCell = CustomCell<ProgressCellData>;

const BAR_HEIGHT = 6;
const BAR_MAX_WIDTH = 120;
const LABEL_GAP = 8;

/** `number` with style `progress`: a bar and the formatted value. */
export const progressCellRenderer: CustomRenderer<ProgressCell> = {
  kind: GridCellKind.Custom,
  isMatch: (cell): cell is ProgressCell => (cell.data as { kind?: unknown }).kind === 'ob-progress',
  needsHover: false,
  draw: (args, cell) => {
    const { ctx, rect, theme } = args;
    const { fraction, label, color, track } = cell.data;
    const font = fontOf(theme.baseFontStyle, theme.fontFamily);
    withCellClip(ctx, rect, () => {
      ctx.font = font;
      const labelWidth = measureTextCached(label, ctx, font).width;
      const x = rect.x + theme.cellHorizontalPadding;
      const inner = rect.width - theme.cellHorizontalPadding * 2 - labelWidth - LABEL_GAP;
      const barWidth = Math.max(0, Math.min(BAR_MAX_WIDTH, inner));
      const top = rect.y + (rect.height - BAR_HEIGHT) / 2;
      if (barWidth > 0) {
        fillRoundedRect(ctx, x, top, barWidth, BAR_HEIGHT, BAR_HEIGHT / 2, track);
        if (fraction > 0) {
          const filled = Math.max(BAR_HEIGHT, barWidth * fraction);
          fillRoundedRect(ctx, x, top, filled, BAR_HEIGHT, BAR_HEIGHT / 2, color);
        }
      }
      ctx.fillStyle = theme.textDark;
      ctx.fillText(label, x + barWidth + (barWidth > 0 ? LABEL_GAP : 0), rect.y + rect.height / 2);
    });
  },
};

export interface RatingCellData {
  readonly kind: 'ob-rating';
  /** Filled symbols. */
  readonly value: number;
  readonly max: number;
  readonly symbol: string;
  readonly color: string;
  readonly empty: string;
}

export type RatingCell = CustomCell<RatingCellData>;

const SYMBOL_GAP = 2;

/** `number` with style `rating`: `max` symbols, the first `value` in color. */
export const ratingCellRenderer: CustomRenderer<RatingCell> = {
  kind: GridCellKind.Custom,
  isMatch: (cell): cell is RatingCell => (cell.data as { kind?: unknown }).kind === 'ob-rating',
  needsHover: false,
  draw: (args, cell) => {
    const { ctx, rect, theme } = args;
    const { value, max, symbol, color, empty } = cell.data;
    const font = fontOf(theme.baseFontStyle, theme.fontFamily);
    withCellClip(ctx, rect, () => {
      ctx.font = font;
      const width = measureTextCached(symbol, ctx, font).width;
      let x = rect.x + theme.cellHorizontalPadding;
      for (let index = 0; index < max; index += 1) {
        ctx.fillStyle = index < value ? color : empty;
        ctx.fillText(symbol, x, rect.y + rect.height / 2);
        x += width + SYMBOL_GAP;
      }
    });
  },
};
