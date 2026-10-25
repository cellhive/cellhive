import { GridCellKind, measureTextCached } from '@glideapps/glide-data-grid';

import { fillRoundedRect, fitText, fontOf, withCellClip } from './draw';

import type { CustomCell, CustomRenderer, GridCell, Rectangle } from '@glideapps/glide-data-grid';

/**
 * A button field's cell on the canvas (T525, board "S5 · Button field";
 * Quyết định S5 thiết kế #6): a pill with a bolt and the label on the light
 * background of its palette color (dark text, ≥ 4.5:1), grey when disabled,
 * "Running…" while a click of the user runs. `copyData` is what screen
 * readers get: the label and the state ("Approve, unavailable").
 */
export interface ButtonCellData {
  readonly kind: 'ob-button';
  readonly text: string;
  readonly state: 'ready' | 'disabled' | 'running';
  readonly colors: {
    readonly bg: string;
    readonly fg: string;
    readonly border: string;
  };
}

export type ButtonCanvasCell = CustomCell<ButtonCellData>;

export function isButtonCanvasCell(cell: GridCell): cell is ButtonCanvasCell {
  return (
    cell.kind === GridCellKind.Custom && (cell.data as { kind?: unknown }).kind === 'ob-button'
  );
}

const FONT = '500 12px';
const HEIGHT = 24;
const PADDING_X = 10;
const ICON = 12;
const ICON_GAP = 6;
const RADIUS = 6;

/** Lucide `zap`, 24×24. */
const BOLT =
  'M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 ' +
  '.78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z';
let boltPath: Path2D | null | undefined;

function drawBolt(ctx: CanvasRenderingContext2D, x: number, middle: number, color: string) {
  if (boltPath === undefined) boltPath = typeof Path2D === 'function' ? new Path2D(BOLT) : null;
  if (boltPath === null) return;
  ctx.save();
  ctx.translate(x, middle - ICON / 2);
  ctx.scale(ICON / 24, ICON / 24);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke(boltPath);
  ctx.restore();
}

/** A three-quarter ring (the board's loader; not animated on the canvas). */
function drawRing(ctx: CanvasRenderingContext2D, x: number, middle: number, color: string) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x + ICON / 2, middle, ICON / 2 - 1, -Math.PI / 2, Math.PI);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.75;
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.restore();
}

/**
 * Where the pill is in a cell of `rect` for a text `textWidth` wide: the
 * click target (`GridView` hit-tests pointer clicks with it).
 */
export function buttonPillRect(
  rect: Rectangle,
  textWidth: number,
  horizontalPadding: number,
): Rectangle {
  const width = Math.min(
    PADDING_X * 2 + ICON + ICON_GAP + textWidth,
    Math.max(0, rect.width - horizontalPadding * 2),
  );
  const height = Math.min(HEIGHT, Math.max(0, rect.height - 6));
  return {
    x: rect.x + horizontalPadding,
    y: rect.y + (rect.height - height) / 2,
    width,
    height,
  };
}

let measuring: CanvasRenderingContext2D | null | undefined;

/** Width of a label at the pill's font, without a drawing context (hit tests). */
export function measureButtonText(text: string, family: string): number {
  if (measuring === undefined) {
    try {
      measuring = document.createElement('canvas').getContext('2d');
    } catch {
      measuring = null;
    }
  }
  if (measuring === null) return text.length * 7;
  measuring.font = fontOf(FONT, family);
  return measuring.measureText(text).width;
}

export const buttonCellRenderer: CustomRenderer<ButtonCanvasCell> = {
  kind: GridCellKind.Custom,
  isMatch: (cell): cell is ButtonCanvasCell =>
    (cell.data as { kind?: unknown }).kind === 'ob-button',
  needsHover: false,
  draw: (args, cell) => {
    const { ctx, rect, theme } = args;
    const { text, state, colors } = cell.data;
    const font = fontOf(FONT, theme.fontFamily);
    withCellClip(ctx, rect, () => {
      ctx.font = font;
      const pill = buttonPillRect(
        rect,
        measureTextCached(text, ctx, font).width,
        theme.cellHorizontalPadding,
      );
      if (pill.width <= 0) return;
      const middle = pill.y + pill.height / 2;
      fillRoundedRect(ctx, pill.x, pill.y, pill.width, pill.height, RADIUS, colors.border);
      fillRoundedRect(
        ctx,
        pill.x + 1,
        pill.y + 1,
        pill.width - 2,
        pill.height - 2,
        RADIUS - 1,
        colors.bg,
      );
      const iconX = pill.x + PADDING_X;
      if (state === 'running') drawRing(ctx, iconX, middle, colors.fg);
      else drawBolt(ctx, iconX, middle, colors.fg);
      const textX = iconX + ICON + ICON_GAP;
      ctx.fillStyle = colors.fg;
      ctx.fillText(fitText(ctx, text, pill.x + pill.width - PADDING_X - textX), textX, middle);
    });
  },
  measure: (ctx, cell, theme) =>
    measureTextCached(cell.data.text, ctx, fontOf(FONT, theme.fontFamily)).width +
    PADDING_X * 2 +
    ICON +
    ICON_GAP +
    theme.cellHorizontalPadding * 2,
};
