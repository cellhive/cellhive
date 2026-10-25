import { GridCellKind, measureTextCached, roundedRect } from '@glideapps/glide-data-grid';

import { CHIP_GAP, fillRoundedRect, fitText, fontOf, withCellClip } from './draw';

import type { ChipColor } from '../theme';
import type { CustomCell, CustomRenderer } from '@glideapps/glide-data-grid';

/** A file of the cell: a thumbnail (raster image the user may load) or a type badge. */
export type AttachmentTile =
  | { readonly type: 'image'; readonly url: string; readonly name: string }
  | {
      readonly type: 'badge';
      readonly label: string;
      readonly color: ChipColor;
      readonly name: string;
      /** An image without a thumbnail (no download right): drawn as a picture placeholder. */
      readonly picture: boolean;
    };

export interface AttachmentsCellData {
  readonly kind: 'ob-attachments';
  readonly tiles: readonly AttachmentTile[];
  /** Colors of the placeholders and the "+N" chip. */
  readonly colors: {
    readonly sunken: string;
    readonly muted: string;
    readonly text: string;
    readonly accent: string;
  };
  /** Shown in an empty cell the user may fill, while it is selected (board S4 states). */
  readonly hint: string | null;
}

export type AttachmentsCell = CustomCell<AttachmentsCellData>;

/** Thumbnails of the board: 24 px on compact rows, 28 px from 44 px, 4 px radius. */
export function tileSize(rowHeight: number): number {
  return rowHeight >= 44 ? 28 : 24;
}

/** At most this many tiles, then "+N" (board S4 "Ô tệp đính kèm"). */
export const MAX_TILES = 4;
const TILE_RADIUS = 4;
const TILE_GAP = CHIP_GAP;
const MORE_HEIGHT = 22;
const MORE_PADDING = 6;
const MORE_FONT = '500 12px';
const NAME_FONT = '12px';
const NAME_GAP = 8;

/** How many tiles fit `width` (with room for "+N" when some are left out). */
export function visibleTiles(
  count: number,
  width: number,
  size: number,
  moreWidth: (hidden: number) => number,
): number {
  let shown = Math.min(count, MAX_TILES);
  while (shown > 0) {
    const hidden = count - shown;
    const needed =
      shown * size + (shown - 1) * TILE_GAP + (hidden > 0 ? TILE_GAP + moreWidth(hidden) : 0);
    if (needed <= width) return shown;
    shown -= 1;
  }
  return 0;
}

function drawPicture(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: string,
) {
  // A small picture glyph (frame, sun, hill) centred in the tile.
  const inset = size * 0.26;
  const left = x + inset;
  const top = y + inset + 1;
  const width = size - inset * 2;
  const height = width * 0.8;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  roundedRect(ctx, left, top, width, height, 1.5);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(left + width * 0.32, top + height * 0.36, width * 0.09, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(left + width * 0.1, top + height * 0.9);
  ctx.lineTo(left + width * 0.62, top + height * 0.45);
  ctx.lineTo(left + width * 0.95, top + height * 0.8);
  ctx.stroke();
  ctx.restore();
}

/**
 * Attachment cells (T418, board S4 "Ô tệp đính kèm và tải lên"): image
 * thumbnails loaded lazily through glide's image window loader (the canvas
 * never waits for them: a placeholder is drawn until the image arrives),
 * type badges ("PDF", "XLS"…) for other files, a single non-image file
 * with its name, and "+N" for what does not fit.
 */
export const attachmentsCellRenderer: CustomRenderer<AttachmentsCell> = {
  kind: GridCellKind.Custom,
  isMatch: (cell): cell is AttachmentsCell =>
    (cell.data as { kind?: unknown }).kind === 'ob-attachments',
  needsHover: false,
  draw: (args, cell) => {
    const { ctx, rect, theme, imageLoader, col, row, highlighted } = args;
    const { tiles, colors, hint } = cell.data;
    withCellClip(ctx, rect, () => {
      const left = rect.x + theme.cellHorizontalPadding;
      const right = rect.x + rect.width - theme.cellHorizontalPadding;
      const middle = rect.y + rect.height / 2;
      if (tiles.length === 0) {
        if (hint === null || !highlighted || cell.readonly !== false) return;
        // Board S4 states: an upload glyph (arrow over a tray), then the hint.
        ctx.save();
        ctx.strokeStyle = colors.muted;
        ctx.lineWidth = 1.3;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(left + 6, middle + 3);
        ctx.lineTo(left + 6, middle - 5);
        ctx.moveTo(left + 3, middle - 2);
        ctx.lineTo(left + 6, middle - 5);
        ctx.lineTo(left + 9, middle - 2);
        ctx.moveTo(left + 1, middle + 3);
        ctx.lineTo(left + 1, middle + 5);
        ctx.lineTo(left + 11, middle + 5);
        ctx.lineTo(left + 11, middle + 3);
        ctx.stroke();
        ctx.restore();
        ctx.font = fontOf(NAME_FONT, theme.fontFamily);
        ctx.fillStyle = colors.muted;
        ctx.fillText(fitText(ctx, hint, right - left - 18), left + 18, middle);
        return;
      }
      const size = tileSize(rect.height);
      const top = Math.round(middle - size / 2);
      const moreFont = fontOf(MORE_FONT, theme.fontFamily);
      const moreWidth = (hidden: number) =>
        measureTextCached(`+${String(hidden)}`, ctx, moreFont).width + MORE_PADDING * 2;
      const shown = visibleTiles(tiles.length, right - left, size, moreWidth);
      let x = left;
      for (const tile of tiles.slice(0, Math.max(1, shown))) {
        if (tile.type === 'image') {
          const image = imageLoader.loadOrGetImage(tile.url, col, row);
          ctx.save();
          ctx.beginPath();
          roundedRect(ctx, x, top, size, size, TILE_RADIUS);
          ctx.clip();
          if (image === undefined) {
            ctx.fillStyle = colors.sunken;
            ctx.fillRect(x, top, size, size);
            drawPicture(ctx, x, top, size, colors.muted);
          } else {
            // Cover the square: crop the longer side of the image.
            const scale = Math.max(size / image.width, size / image.height);
            const width = image.width * scale;
            const height = image.height * scale;
            ctx.drawImage(image, x + (size - width) / 2, top + (size - height) / 2, width, height);
          }
          ctx.restore();
        } else {
          fillRoundedRect(ctx, x, top, size, size, TILE_RADIUS, tile.color.bg);
          if (tile.picture) {
            drawPicture(ctx, x, top, size, tile.color.fg);
          } else {
            const fontSize = tile.label.length > 3 ? 7 : 8;
            ctx.font = fontOf(
              `600 ${String(size >= 28 ? fontSize + 1 : fontSize)}px`,
              theme.fontFamily,
            );
            ctx.fillStyle = tile.color.fg;
            ctx.textAlign = 'center';
            ctx.fillText(tile.label, x + size / 2, middle);
            ctx.textAlign = 'left';
          }
        }
        x += size + TILE_GAP;
      }
      const only = tiles[0];
      if (tiles.length === 1 && only?.type === 'badge' && !only.picture) {
        // One document: its name next to the badge (board).
        const nameX = left + size + NAME_GAP;
        ctx.font = fontOf(NAME_FONT, theme.fontFamily);
        ctx.fillStyle = colors.text;
        ctx.fillText(fitText(ctx, only.name, right - nameX), nameX, middle);
        return;
      }
      const hidden = tiles.length - Math.max(1, shown);
      if (hidden > 0) {
        const label = `+${String(hidden)}`;
        const width = moreWidth(hidden);
        const moreTop = Math.round(middle - MORE_HEIGHT / 2);
        fillRoundedRect(ctx, x, moreTop, width, MORE_HEIGHT, TILE_RADIUS, colors.sunken);
        ctx.font = moreFont;
        ctx.fillStyle = colors.muted;
        ctx.fillText(label, x + MORE_PADDING, middle);
      }
    });
  },
  measure: (_ctx, cell, theme) => {
    const count = Math.min(cell.data.tiles.length, MAX_TILES);
    return theme.cellHorizontalPadding * 2 + count * (24 + TILE_GAP) + 32;
  },
};
