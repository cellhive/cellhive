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
import { paintCardCell, strokeCardCell, type CardCellLines, type CardColors } from './group-card';

import type { GridRowFrame } from '../rows';
import type { Chip } from './chips';
import type { CustomCell, CustomRenderer, Rectangle } from '@glideapps/glide-data-grid';

/** Colors of a header and of the card rows. */
export interface GroupHeaderColors {
  readonly text: string;
  readonly muted: string;
  readonly card: CardColors;
}

/** Where the header's parts landed (written when drawn; read by clicks). */
export interface GroupHeaderHits {
  /** "N records ▾" (opens the group menu), px from the header's origin. */
  menu: [number, number] | null;
}

export interface GroupHeaderCellData {
  readonly kind: 'ob-group';
  /**
   * `head`: the cell over the frozen columns (the header's content, stays
   * in place when scrolling sideways); `tail`: the rest of the row (what
   * overflows a narrow frozen area, the card's right border).
   */
  readonly part: 'head' | 'tail';
  readonly collapsed: boolean;
  /** The group has nested groups (their cards start right under the header). */
  readonly nested: boolean;
  readonly frame: GridRowFrame;
  /** Select values as chips; `null` → `text`. */
  readonly chips: readonly Chip[] | null;
  readonly text: string;
  /** The empty group ("(Empty)"): muted text. */
  readonly empty: boolean;
  /** "470 records". */
  readonly count: string;
  /** Width of the head part (frozen columns), px. */
  readonly headWidth: number;
  /** Width of the whole row (every column), px. */
  readonly rowWidth: number;
  /** The row has a tail (not every column is frozen). */
  readonly hasTail: boolean;
  readonly colors: GroupHeaderColors;
  readonly hits: GroupHeaderHits;
  /**
   * (T472) Summaries over the tail's columns: `x` from the tail's left
   * edge, the column's `width`, px.
   */
  readonly summaries?: readonly PlacedGroupSummary[];
}

export interface PlacedGroupSummary {
  readonly x: number;
  readonly width: number;
  readonly label: string;
  readonly value: string;
  readonly right: boolean;
}

export type GroupHeaderCell = CustomCell<GroupHeaderCellData>;

/** A blank cell of a spacer or a "+" row: only its card background and lines. */
export interface CardCellData {
  readonly kind: 'ob-card';
  readonly frame: GridRowFrame;
  readonly lines: CardCellLines;
  readonly colors: CardColors;
}

export type CardCell = CustomCell<CardCellData>;

/** Inner padding of the header, px. */
export const HEADER_PADDING = 8;
/** Space between the value and the count when they follow each other, px. */
const COUNT_GAP = 12;
/** The menu caret after the count, px. */
const CARET_WIDTH = 8;
const CARET_GAP = 4;

const VALUE_FONT = '600 13px';
const CHIP_FONT = '500 12px';
const COUNT_FONT = '12px';

/** Measures and shortens texts in a font (canvas in the browser, a stub in tests). */
export interface TextMetrics {
  readonly width: (text: string, font: string) => number;
  readonly fit: (text: string, maxWidth: number, font: string) => string;
}

export interface HeaderLayout {
  /** Chips (or the value text when `chips` is empty) with their x and width, px from the origin. */
  readonly chips: readonly { readonly label: string; readonly x: number; readonly width: number }[];
  readonly text: { readonly label: string; readonly x: number } | null;
  readonly countX: number;
  readonly caretX: number;
  /** The content is wider than the head: it goes on in the tail. */
  readonly overflow: boolean;
}

/**
 * Header layout (pure): the value at its natural width — chips are only
 * shortened when they would not fit the whole row — then the count. When
 * everything fits over the frozen columns the count is right-aligned
 * against the frozen divider (Lark); otherwise it follows the value and
 * the content overflows into the tail.
 */
export function layoutHeader(
  data: Pick<GroupHeaderCellData, 'chips' | 'text' | 'count' | 'headWidth' | 'rowWidth'>,
  metrics: TextMetrics,
  fontFamily: string,
): HeaderLayout {
  const chipFont = fontOf(CHIP_FONT, fontFamily);
  const valueFont = fontOf(VALUE_FONT, fontFamily);
  const countFont = fontOf(COUNT_FONT, fontFamily);
  const countWidth = metrics.width(data.count, countFont);
  const tailRoom = COUNT_GAP + countWidth + CARET_GAP + CARET_WIDTH + HEADER_PADDING;
  const valueRoom = Math.max(0, data.rowWidth - HEADER_PADDING - tailRoom);
  let x = HEADER_PADDING;
  const chips: { label: string; x: number; width: number }[] = [];
  let text: HeaderLayout['text'] = null;
  if (data.chips !== null && data.chips.length > 0) {
    for (const chip of data.chips) {
      const available = HEADER_PADDING + valueRoom - x;
      if (available < CHIP_PADDING_X * 2 + 8) break;
      const label = metrics.fit(chip.label, available - CHIP_PADDING_X * 2, chipFont);
      if (label === '') break;
      const width = metrics.width(label, chipFont) + CHIP_PADDING_X * 2;
      chips.push({ label, x, width });
      x += width + CHIP_GAP;
    }
    x -= CHIP_GAP;
  } else {
    const label = metrics.fit(data.text, valueRoom, valueFont);
    text = { label, x };
    x += metrics.width(label, valueFont);
  }
  const fits = x + tailRoom <= data.headWidth;
  const countX = fits
    ? data.headWidth - HEADER_PADDING - CARET_WIDTH - CARET_GAP - countWidth
    : x + COUNT_GAP;
  return {
    chips,
    text,
    countX,
    caretX: countX + countWidth + CARET_GAP,
    overflow: !fits,
  };
}

const SUMMARY_PADDING = 10;
const SUMMARY_GAP = 6;
/** Below this column width a summary shows its value only (QA S4b M6, like the bar). */
export const SUMMARY_LABEL_MIN_WIDTH = 120;

/**
 * What a summary of `width` px shows (QA S4b M6): the value first — the label
 * only when the column is at least {@link SUMMARY_LABEL_MIN_WIDTH} wide and
 * both fit; otherwise the value alone, clipped with "…" only when even it
 * does not fit. `fit(text, max)` shortens a text to `max` px.
 */
export function summaryText(
  width: number,
  label: string,
  value: string,
  measure: { label: (text: string) => number; value: (text: string) => number },
  fit: (text: string, maxWidth: number) => string,
): { readonly label: string | null; readonly value: string } {
  const room = width - SUMMARY_PADDING * 2;
  const valueWidth = measure.value(value);
  if (width >= SUMMARY_LABEL_MIN_WIDTH && measure.label(label) + SUMMARY_GAP + valueWidth <= room) {
    return { label, value };
  }
  return { label: null, value: valueWidth <= room ? value : fit(value, room) };
}
const SUMMARY_FONT = '12px';
const SUMMARY_VALUE_FONT = '600 12px';

/**
 * Summaries of a header in the tail (T472): label (muted) then value, the
 * value first in narrow columns ({@link summaryText}, M6), clipped to its column; columns under an overflowing head content
 * (`from`, px from the tail's edge) are left out.
 */
function drawSummaries(
  ctx: CanvasRenderingContext2D,
  rect: Rectangle,
  data: GroupHeaderCellData,
  from: number,
  fontFamily: string,
): void {
  const middle = rect.y + rect.height / 2;
  const labelFont = fontOf(SUMMARY_FONT, fontFamily);
  const valueFont = fontOf(SUMMARY_VALUE_FONT, fontFamily);
  for (const summary of data.summaries ?? []) {
    if (summary.x < from) continue;
    const left = rect.x + summary.x + SUMMARY_PADDING;
    const room = summary.width - SUMMARY_PADDING * 2;
    if (room <= 8) continue;
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x + summary.x, rect.y, summary.width, rect.height);
    ctx.clip();
    const shown = summaryText(
      summary.width,
      summary.label,
      summary.value,
      {
        label: (text) => measureTextCached(text, ctx, labelFont).width,
        value: (text) => measureTextCached(text, ctx, valueFont).width,
      },
      (text, maxWidth) => {
        ctx.font = valueFont;
        return fitText(ctx, text, maxWidth);
      },
    );
    const labelWidth =
      shown.label === null ? 0 : measureTextCached(shown.label, ctx, labelFont).width + SUMMARY_GAP;
    const valueWidth = measureTextCached(shown.value, ctx, valueFont).width;
    const total = labelWidth + valueWidth;
    const start = summary.right ? Math.max(left, left + room - total) : left;
    if (shown.label !== null) {
      ctx.font = labelFont;
      ctx.fillStyle = data.colors.muted;
      ctx.fillText(shown.label, start, middle);
    }
    ctx.font = valueFont;
    ctx.fillStyle = data.colors.text;
    ctx.fillText(shown.value, start + labelWidth, middle);
    ctx.restore();
  }
}

/** Canvas metrics with glide's measure cache. */
function canvasMetrics(ctx: CanvasRenderingContext2D): TextMetrics {
  return {
    width: (text, font) => measureTextCached(text, ctx, font).width,
    fit: (text, maxWidth, font) => {
      ctx.font = font;
      return fitText(ctx, text, maxWidth);
    },
  };
}

function drawCaret(ctx: CanvasRenderingContext2D, x: number, middle: number, color: string): void {
  ctx.beginPath();
  ctx.moveTo(x, middle - 2);
  ctx.lineTo(x + CARET_WIDTH, middle - 2);
  ctx.lineTo(x + CARET_WIDTH / 2, middle + 2.5);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

/** Draws the header content with its origin at `origin` (clipped by the caller). */
function drawContent(
  ctx: CanvasRenderingContext2D,
  origin: number,
  rect: Rectangle,
  data: GroupHeaderCellData,
  layout: HeaderLayout,
  fontFamily: string,
): void {
  const middle = rect.y + rect.height / 2;
  const { colors } = data;
  if (layout.text === null) {
    ctx.font = fontOf(CHIP_FONT, fontFamily);
    const chips = data.chips ?? [];
    layout.chips.forEach((placed, index) => {
      const color = chips[index]?.color;
      if (color === undefined) return;
      fillRoundedRect(
        ctx,
        origin + placed.x,
        middle - CHIP_HEIGHT / 2,
        placed.width,
        CHIP_HEIGHT,
        CHIP_RADIUS,
        color.bg,
      );
      ctx.fillStyle = color.fg;
      ctx.fillText(placed.label, origin + placed.x + CHIP_PADDING_X, middle);
    });
  } else {
    ctx.font = fontOf(data.empty ? CHIP_FONT : VALUE_FONT, fontFamily);
    ctx.fillStyle = data.empty ? colors.muted : colors.text;
    ctx.fillText(layout.text.label, origin + layout.text.x, middle);
  }
  ctx.font = fontOf(COUNT_FONT, fontFamily);
  ctx.fillStyle = colors.muted;
  ctx.fillText(data.count, origin + layout.countX, middle);
  drawCaret(ctx, origin + layout.caretX, middle, colors.muted);
}

/**
 * A group header row (T312, T320a): the value (select values as chips in
 * their option colors) and "N records ▾" over the frozen columns; the
 * chevron is drawn in the row gutter. The header is two spans — the head
 * over the frozen columns (glide keeps it in place when scrolling sideways)
 * and the tail over the others — so a value wider than the frozen area
 * goes on in the tail instead of being cut at the frozen divider.
 */
export const groupHeaderRenderer: CustomRenderer<GroupHeaderCell> = {
  kind: GridCellKind.Custom,
  isMatch: (cell): cell is GroupHeaderCell => (cell.data as { kind?: unknown }).kind === 'ob-group',
  needsHover: false,
  draw: (args, cell) => {
    const { ctx, rect, theme, highlighted } = args;
    const data = cell.data;
    const layout = layoutHeader(data, canvasMetrics(ctx), theme.fontFamily);
    const head = data.part === 'head';
    // Under an expanded header with nested groups, the first nested card's top border is the line.
    const bottom = !data.nested || data.collapsed;
    const lines: CardCellLines = head
      ? { right: !data.hasTail || !layout.overflow, cardRight: !data.hasTail, bottom }
      : { right: true, cardRight: true, bottom };
    paintCardCell(ctx, rect, data.frame, lines, data.colors.card, highlighted);
    if (head || layout.overflow) {
      const origin = head ? rect.x : rect.x - data.headWidth;
      withCellClip(ctx, rect, () => {
        drawContent(ctx, origin, rect, data, layout, theme.fontFamily);
      });
    }
    if (!head && data.summaries !== undefined && data.summaries.length > 0) {
      // Past the head's content when it overflows into the tail.
      const from = layout.overflow ? layout.caretX + CARET_WIDTH + COUNT_GAP - data.headWidth : 0;
      withCellClip(ctx, rect, () => {
        drawSummaries(ctx, rect, data, from, theme.fontFamily);
      });
    }
    strokeCardCell(ctx, rect, data.frame, lines, data.colors.card);
    data.hits.menu = [layout.countX - 4, layout.caretX + CARET_WIDTH + 4];
  },
};

/** Spacer and "+" row cells: their card background and lines only. */
export const cardCellRenderer: CustomRenderer<CardCell> = {
  kind: GridCellKind.Custom,
  isMatch: (cell): cell is CardCell => (cell.data as { kind?: unknown }).kind === 'ob-card',
  needsHover: false,
  draw: (args, cell) => {
    const { ctx, rect, highlighted } = args;
    const { frame, lines, colors } = cell.data;
    paintCardCell(ctx, rect, frame, lines, colors, highlighted);
    strokeCardCell(ctx, rect, frame, lines, colors);
  },
};
