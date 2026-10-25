import { GridCellKind, measureTextCached } from '@glideapps/glide-data-grid';

import {
  CHIP_GAP,
  CHIP_HEIGHT,
  CHIP_PADDING_X,
  CHIP_RADIUS,
  fillRoundedRect,
  fitText,
  fontOf,
  withCellClip,
} from './draw';

import type { ChipColor } from '../theme';
import type { CustomCell, CustomRenderer } from '@glideapps/glide-data-grid';

export interface Chip {
  readonly label: string;
  readonly color: ChipColor;
}

export interface ChipsCellData {
  readonly kind: 'ob-chips';
  readonly chips: readonly Chip[];
}

export type ChipsCell = CustomCell<ChipsCellData>;

const CHIP_FONT = '500 12px';

/**
 * Select values as chips in their option colors (FRONTEND §9.3). The option
 * name is always written: color is never the only channel (FRONTEND §9.2).
 * Chips that do not fit end with a "+N" count.
 */
export const chipsCellRenderer: CustomRenderer<ChipsCell> = {
  kind: GridCellKind.Custom,
  isMatch: (cell): cell is ChipsCell => (cell.data as { kind?: unknown }).kind === 'ob-chips',
  needsHover: false,
  draw: (args, cell) => {
    const { ctx, rect, theme } = args;
    const { chips } = cell.data;
    if (chips.length === 0) return;
    const font = fontOf(CHIP_FONT, theme.fontFamily);
    withCellClip(ctx, rect, () => {
      ctx.font = font;
      const top = rect.y + (rect.height - CHIP_HEIGHT) / 2;
      const right = rect.x + rect.width - theme.cellHorizontalPadding;
      let x = rect.x + theme.cellHorizontalPadding;
      for (const [index, chip] of chips.entries()) {
        const remaining = chips.length - index - 1;
        const moreLabel = remaining > 0 ? `+${String(remaining)}` : '';
        const moreWidth =
          remaining > 0 ? measureTextCached(moreLabel, ctx, font).width + CHIP_GAP : 0;
        const available = right - x - (index === 0 ? 0 : moreWidth);
        const textWidth = measureTextCached(chip.label, ctx, font).width;
        let label = chip.label;
        let width = textWidth + CHIP_PADDING_X * 2;
        if (width > available) {
          if (index > 0) {
            // No room for this chip: say how many are left.
            ctx.fillStyle = theme.textMedium;
            ctx.fillText(`+${String(chips.length - index)}`, x, top + CHIP_HEIGHT / 2);
            return;
          }
          label = fitText(ctx, chip.label, available - CHIP_PADDING_X * 2);
          width = Math.max(available, CHIP_PADDING_X * 2);
        }
        fillRoundedRect(ctx, x, top, width, CHIP_HEIGHT, CHIP_RADIUS, chip.color.bg);
        ctx.fillStyle = chip.color.fg;
        ctx.fillText(label, x + CHIP_PADDING_X, top + CHIP_HEIGHT / 2);
        x += width + CHIP_GAP;
      }
    });
  },
  measure: (ctx, cell, theme) =>
    cell.data.chips.reduce(
      (width, chip) =>
        width +
        measureTextCached(chip.label, ctx, fontOf(CHIP_FONT, theme.fontFamily)).width +
        CHIP_PADDING_X * 2 +
        CHIP_GAP,
      theme.cellHorizontalPadding * 2,
    ),
};
