import { fillRoundedRect } from './customCells/draw';
import { withAlphaHex } from './theme';

import type { GridPalette } from './theme';
import type { Rectangle, Theme } from '@glideapps/glide-data-grid';

/**
 * Badges of computed column headers (T468, board "S4b · Cột tính toán: lỗi
 * và tính lại"), drawn on the canvas at the right end of the header, left
 * of glide's menu button when it shows:
 * - `progress`: a determinate ring and its percentage in the accent color
 *   (`computed.recomputing.progress`, BACKLOG S4b additional decision #6);
 * - `error`: a 24 px button-like square with a warning sign in the danger
 *   color (danger-tinted while its popover is open); a click opens the
 *   popover of the page (`HeaderMenuHooks.onHeaderBadge`).
 */
export type HeaderBadge =
  | { readonly kind: 'progress'; readonly progress: number }
  | { readonly kind: 'error'; readonly open: boolean };

/** Glide's header menu button (`menuButtonSize` of the library). */
const MENU_BUTTON = 30;
const PAD_RIGHT = 8;
const ERROR_SIZE = 24;
const RING = 16;
const RING_GAP = 4;
const RING_STROKE = 2.5;
/** Width of "100%" at 12 px: the progress badge keeps one width while it counts. */
const PERCENT_WIDTH = 30;
/** Fade from the header background over the end of a long title. */
const FADE = 12;

export function percentOf(progress: number): number {
  return Math.round(Math.min(Math.max(progress, 0), 1) * 100);
}

function badgeWidth(badge: HeaderBadge): number {
  return badge.kind === 'error' ? ERROR_SIZE : RING + RING_GAP + PERCENT_WIDTH;
}

/**
 * Where the badge is, relative to the header's rectangle (`x`, `y` from its
 * top-left corner). `menuShown`: glide draws its menu button (hovered header
 * of a grid with a header menu).
 */
export function headerBadgeBounds(
  header: { readonly width: number; readonly height: number },
  badge: HeaderBadge,
  menuShown: boolean,
): Rectangle {
  const width = badgeWidth(badge);
  const height = badge.kind === 'error' ? ERROR_SIZE : RING;
  const right = header.width - PAD_RIGHT - (menuShown ? MENU_BUTTON - PAD_RIGHT : 0);
  return { x: right - width, y: (header.height - height) / 2, width, height };
}

/** Whether a point of the header (local coordinates) hits the badge; a little slack around it. */
export function hitsHeaderBadge(
  header: { readonly width: number; readonly height: number },
  badge: HeaderBadge,
  x: number,
  y: number,
): boolean {
  // The badge moves left when the menu button shows: either place counts.
  return [false, true].some((menuShown) => {
    const bounds = headerBadgeBounds(header, badge, menuShown);
    return (
      x >= bounds.x - 2 &&
      x <= bounds.x + bounds.width + 2 &&
      y >= bounds.y - 4 &&
      y <= bounds.y + bounds.height + 4
    );
  });
}

/** Lucide "triangle-alert" at 14 px, stroked (the icon of the board). */
function drawWarning(ctx: CanvasRenderingContext2D, x: number, y: number, color: string): void {
  const scale = 14 / 24;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.8 / scale;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke(
    new Path2D('m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3'),
  );
  ctx.stroke(new Path2D('M12 9v4'));
  ctx.stroke(new Path2D('M12 17h.01'));
  ctx.restore();
}

export interface HeaderBadgeDraw {
  readonly ctx: CanvasRenderingContext2D;
  readonly rect: Rectangle;
  readonly theme: Theme;
  readonly background: string;
  readonly menuShown: boolean;
  readonly palette: GridPalette;
}

/** Draws `badge` over the end of a header glide has drawn. */
export function drawHeaderBadge(draw: HeaderBadgeDraw, badge: HeaderBadge): void {
  const { ctx, rect, theme, background, menuShown, palette } = draw;
  const local = headerBadgeBounds(rect, badge, menuShown);
  const x = rect.x + local.x;
  const y = rect.y + local.y;
  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.width, rect.height);
  ctx.clip();
  // Cover the end of the title: a short fade, then the header background.
  const coverRight = rect.x + rect.width - (menuShown ? MENU_BUTTON : 0);
  const coverLeft = x - 4;
  const fade = ctx.createLinearGradient(coverLeft - FADE, 0, coverLeft, 0);
  fade.addColorStop(0, withAlpha(background, 0));
  fade.addColorStop(1, background);
  ctx.fillStyle = fade;
  ctx.fillRect(coverLeft - FADE, rect.y + 1, FADE, rect.height - 2);
  ctx.fillStyle = background;
  ctx.fillRect(coverLeft, rect.y + 1, coverRight - coverLeft, rect.height - 2);
  if (badge.kind === 'error') {
    if (badge.open)
      fillRoundedRect(ctx, x, y, ERROR_SIZE, ERROR_SIZE, 4, withAlphaHex(palette.danger, 0.12));
    drawWarning(ctx, x + (ERROR_SIZE - 14) / 2, y + (ERROR_SIZE - 14) / 2, palette.danger);
  } else {
    const cx = x + RING / 2;
    const cy = y + RING / 2;
    const radius = (RING - RING_STROKE) / 2;
    ctx.lineWidth = RING_STROKE;
    ctx.strokeStyle = palette.border;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();
    const fraction = percentOf(badge.progress) / 100;
    if (fraction > 0) {
      ctx.strokeStyle = palette.accent;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(cx, cy, radius, -Math.PI / 2, -Math.PI / 2 + fraction * Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = palette.accent;
    ctx.font = `12px ${theme.fontFamily}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(`${String(percentOf(badge.progress))}%`, x + RING + RING_GAP, cy);
  }
  ctx.restore();
}

/** A CSS color with an alpha (hex or `rgb()`/`rgba()`): the start of the fade. */
function withAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{6})$/iu.exec(color.trim());
  if (hex !== null) {
    const value = hex[1] ?? '000000';
    const channel = (index: number) => Number.parseInt(value.slice(index, index + 2), 16);
    return `rgba(${String(channel(0))}, ${String(channel(2))}, ${String(channel(4))}, ${String(alpha)})`;
  }
  const rgb = /^rgba?\(([^)]+)\)$/iu.exec(color.trim());
  if (rgb !== null) {
    const [r, g, b] = (rgb[1] ?? '').split(',').map((part) => part.trim());
    return `rgba(${r ?? '0'}, ${g ?? '0'}, ${b ?? '0'}, ${String(alpha)})`;
  }
  return 'rgba(0, 0, 0, 0)';
}

/**
 * Error badges of the computed columns among `fields` (share page, T468:
 * the token and nothing more; no popover, no progress — share pages have
 * no realtime).
 */
export function computedErrorBadges(
  fields: readonly {
    readonly field: { readonly id: string };
    readonly computed?: { readonly error: unknown } | undefined;
  }[],
): ReadonlyMap<string, HeaderBadge> {
  const badges = new Map<string, HeaderBadge>();
  for (const field of fields) {
    if (field.computed !== undefined && field.computed.error !== null) {
      badges.set(field.field.id, { kind: 'error', open: false });
    }
  }
  return badges;
}
