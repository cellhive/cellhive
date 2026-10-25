import { GridCellKind, measureTextCached } from '@glideapps/glide-data-grid';

import { CHIP_GAP, fillRoundedRect, fitText, fontOf, withCellClip } from './draw';

import type { CustomCell, CustomRenderer, GridCell, Theme } from '@glideapps/glide-data-grid';

/**
 * Linked records of a `link` cell (T413, board "S4 · Ô liên kết trong
 * grid"): one neutral chip per record with its title, as many as fit, then
 * a "+N" count. A record the user cannot read (`title = null`, P20) is a
 * chip with a lock and "No access" — nothing of the record leaks. When no
 * record of the cell is readable the cell reads "🔒 N links" (a lock drawn
 * as a path, never an emoji).
 */

/** Chip of the design: 22 px high, 4 px radius, 8 px padding, at most 180 px wide. */
export const LINK_CHIP_HEIGHT = 22;
export const LINK_CHIP_PADDING_X = 8;
export const LINK_CHIP_MAX_WIDTH = 180;
/** Narrowest chip still drawn (a first chip shrinks down to this). */
export const LINK_CHIP_MIN_WIDTH = 28;
/** "+N" badge: 6 px padding. */
export const LINK_MORE_PADDING_X = 6;
/** Lock icon and the gap after it. */
export const LOCK_SIZE = 12;
export const LOCK_GAP = 4;

const CHIP_FONT = '12px';
const MORE_FONT = '500 12px';

export interface LinkChip {
  readonly id: string;
  /** Title of the record; `null` when the user cannot read it (P20). */
  readonly title: string | null;
}

/** Where a chip (or the "+N" badge) was drawn, relative to the cell's left edge. */
export interface LinkChipHit {
  readonly start: number;
  readonly end: number;
  /** Index of the chip in the cell, `-1` for the "+N" badge. */
  readonly index: number;
}

export interface LinksCellData {
  readonly kind: 'ob-links';
  readonly chips: readonly LinkChip[];
  /** Text of a locked chip ("No access"). */
  readonly lockedLabel: string;
  /** "N links", drawn instead of chips when no record is readable. */
  readonly countLabel: string;
  /**
   * Filled by every draw (like the group header's hits): the page finds the
   * chip under the pointer for the hover card (`GridView`).
   */
  readonly hits: LinkChipHit[];
}

export type LinksCell = CustomCell<LinksCellData>;

export function isLinksCell(cell: GridCell): cell is LinksCell {
  return cell.kind === GridCellKind.Custom && (cell.data as { kind?: unknown }).kind === 'ob-links';
}

/** One chip placed by {@link layoutLinkChips}. */
export interface ChipSlot {
  readonly index: number;
  readonly x: number;
  readonly width: number;
}

export interface ChipLayout {
  readonly slots: readonly ChipSlot[];
  /** The "+N" badge after the last chip drawn, `null` when every chip fits. */
  readonly more: { readonly x: number; readonly width: number; readonly count: number } | null;
}

/**
 * Places chips of the given natural widths from `left` to `right`: a chip
 * is drawn only when it fits together with the "+N" badge of the chips
 * after it; the first chip shrinks (its text cut with "…") rather than
 * leaving the cell with a count only. Pure, so the hit areas are testable.
 */
export function layoutLinkChips(
  widths: readonly number[],
  moreWidth: (count: number) => number,
  left: number,
  right: number,
): ChipLayout {
  const slots: ChipSlot[] = [];
  let x = left;
  for (const [index, natural] of widths.entries()) {
    const width = Math.min(natural, LINK_CHIP_MAX_WIDTH);
    const remaining = widths.length - index - 1;
    const reserve = remaining > 0 ? moreWidth(remaining) + CHIP_GAP : 0;
    if (x + width + reserve <= right) {
      slots.push({ index, x, width });
      x += width + CHIP_GAP;
      continue;
    }
    if (index === 0) {
      const shrunk = Math.max(LINK_CHIP_MIN_WIDTH, right - x - reserve);
      slots.push({ index, x, width: shrunk });
      x += shrunk + CHIP_GAP;
      continue;
    }
    const count = widths.length - index;
    return { slots, more: { x, width: moreWidth(count), count } };
  }
  return { slots, more: null };
}

/** A small padlock (FRONTEND §7: an SVG-like icon, not an emoji), centered on `y`. */
export function drawLock(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: string,
): void {
  const body = size * 0.58;
  const top = y - size / 2 + size - body;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.25;
  // Shackle.
  ctx.beginPath();
  const radius = size * 0.26;
  const cx = x + size / 2;
  ctx.moveTo(cx - radius, top);
  ctx.lineTo(cx - radius, top - size * 0.12);
  ctx.arc(cx, top - size * 0.12, radius, Math.PI, 0);
  ctx.lineTo(cx + radius, top);
  ctx.stroke();
  // Body.
  fillRoundedRect(ctx, x + size * 0.12, top, size * 0.76, body, 1.5, color);
  ctx.restore();
}

function chipTextWidth(
  ctx: CanvasRenderingContext2D,
  chip: LinkChip,
  lockedLabel: string,
  font: string,
): number {
  const text = chip.title ?? lockedLabel;
  const icon = chip.title === null ? LOCK_SIZE + LOCK_GAP : 0;
  return measureTextCached(text, ctx, font).width + icon + LINK_CHIP_PADDING_X * 2;
}

interface DrawColors {
  readonly chip: string;
  readonly line: string;
  readonly text: string;
  readonly muted: string;
}

function colorsOf(theme: Theme): DrawColors {
  return {
    chip: theme.bgCellMedium,
    line: theme.borderColor,
    text: theme.textDark,
    muted: theme.textMedium,
  };
}

function drawChip(
  ctx: CanvasRenderingContext2D,
  chip: LinkChip,
  slot: ChipSlot,
  top: number,
  lockedLabel: string,
  colors: DrawColors,
): void {
  const { x, width } = slot;
  fillRoundedRect(ctx, x, top, width, LINK_CHIP_HEIGHT, 4, colors.line);
  fillRoundedRect(ctx, x + 1, top + 1, width - 2, LINK_CHIP_HEIGHT - 2, 3, colors.chip);
  const middle = top + LINK_CHIP_HEIGHT / 2;
  let textX = x + LINK_CHIP_PADDING_X;
  if (chip.title === null) {
    drawLock(ctx, textX, middle, LOCK_SIZE, colors.muted);
    textX += LOCK_SIZE + LOCK_GAP;
  }
  const room = x + width - LINK_CHIP_PADDING_X - textX;
  ctx.fillStyle = chip.title === null ? colors.muted : colors.text;
  ctx.fillText(fitText(ctx, chip.title ?? lockedLabel, room), textX, middle);
}

export const linksCellRenderer: CustomRenderer<LinksCell> = {
  kind: GridCellKind.Custom,
  isMatch: (cell): cell is LinksCell => (cell.data as { kind?: unknown }).kind === 'ob-links',
  needsHover: false,
  draw: (args, cell) => {
    const { ctx, rect, theme } = args;
    const { chips, lockedLabel, countLabel, hits } = cell.data;
    hits.length = 0;
    if (chips.length === 0) return;
    const colors = colorsOf(theme);
    const chipFont = fontOf(CHIP_FONT, theme.fontFamily);
    const moreFont = fontOf(MORE_FONT, theme.fontFamily);
    const left = rect.x + theme.cellHorizontalPadding;
    const right = rect.x + rect.width - theme.cellHorizontalPadding;
    const middle = rect.y + rect.height / 2;
    withCellClip(ctx, rect, () => {
      if (chips.every((chip) => chip.title === null)) {
        // Nothing readable: a lock and the count, like the board's "🔒 2 liên kết".
        drawLock(ctx, left, middle, LOCK_SIZE, colors.muted);
        ctx.font = chipFont;
        ctx.fillStyle = colors.muted;
        const textX = left + LOCK_SIZE + LOCK_GAP;
        ctx.fillText(fitText(ctx, countLabel, right - textX), textX, middle);
        return;
      }
      ctx.font = chipFont;
      const widths = chips.map((chip) => chipTextWidth(ctx, chip, lockedLabel, chipFont));
      const moreWidth = (count: number) =>
        measureTextCached(`+${String(count)}`, ctx, moreFont).width + LINK_MORE_PADDING_X * 2;
      const layout = layoutLinkChips(widths, moreWidth, left, right);
      const top = rect.y + (rect.height - LINK_CHIP_HEIGHT) / 2;
      for (const slot of layout.slots) {
        const chip = chips[slot.index];
        if (chip === undefined) continue;
        drawChip(ctx, chip, slot, top, lockedLabel, colors);
        hits.push({ start: slot.x - rect.x, end: slot.x + slot.width - rect.x, index: slot.index });
      }
      if (layout.more !== null) {
        const { x, width, count } = layout.more;
        fillRoundedRect(ctx, x, top, width, LINK_CHIP_HEIGHT, 4, colors.chip);
        ctx.font = moreFont;
        ctx.fillStyle = colors.muted;
        ctx.fillText(`+${String(count)}`, x + LINK_MORE_PADDING_X, middle);
        hits.push({ start: x - rect.x, end: x + width - rect.x, index: -1 });
      }
    });
  },
  measure: (ctx, cell, theme) => {
    const font = fontOf(CHIP_FONT, theme.fontFamily);
    return cell.data.chips.reduce(
      (width, chip) =>
        width +
        Math.min(LINK_CHIP_MAX_WIDTH, chipTextWidth(ctx, chip, cell.data.lockedLabel, font)) +
        CHIP_GAP,
      theme.cellHorizontalPadding * 2,
    );
  },
};

/** The chip (index) under `x` (px from the cell's left edge), `-1` for "+N", `null` for none. */
export function linkChipAt(data: LinksCellData, x: number): number | null {
  const hit = data.hits.find((item) => x >= item.start && x <= item.end);
  return hit === undefined ? null : hit.index;
}
