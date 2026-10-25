import { roundedRect } from '@glideapps/glide-data-grid';

import type { Rectangle } from '@glideapps/glide-data-grid';

/** Chip geometry of the design (FRONTEND §9.3): 4 px radius, 20 px high. */
export const CHIP_HEIGHT = 20;
export const CHIP_PADDING_X = 8;
export const CHIP_GAP = 4;
export const CHIP_RADIUS = 4;

const ELLIPSIS = '…';

/** Longest prefix of `text` (with "…") that fits `maxWidth` at the current font. */
export function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (ctx.measureText(text).width <= maxWidth) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (ctx.measureText(text.slice(0, middle) + ELLIPSIS).width <= maxWidth) low = middle;
    else high = middle - 1;
  }
  return low === 0 ? '' : text.slice(0, low) + ELLIPSIS;
}

/** Runs `draw` with the cell rectangle as clip and restores the context after. */
export function withCellClip(
  ctx: CanvasRenderingContext2D,
  rect: Rectangle,
  draw: () => void,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.width, rect.height);
  ctx.clip();
  ctx.textBaseline = 'middle';
  draw();
  ctx.restore();
}

/** A filled rounded rectangle. */
export function fillRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  color: string,
): void {
  ctx.beginPath();
  roundedRect(ctx, x, y, width, height, radius);
  ctx.fillStyle = color;
  ctx.fill();
}

/** Canvas font string from a weight/size style (`500 12px`) and a family. */
export function fontOf(style: string, family: string): string {
  return `${style} ${family}`;
}
