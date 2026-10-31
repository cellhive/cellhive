import { GridCellKind } from '@glideapps/glide-data-grid';

import { fillRoundedRect, fitText, withCellClip } from './draw';

import type { AiCellState } from '@cellhive/contracts';
import type { CustomCell, CustomRenderer, GridCell } from '@glideapps/glide-data-grid';

/**
 * A cell of an AI field that is not simply its value (T915, research S8
 * §5.6, `record.meta.ai`): waiting or being generated — a thin shimmering
 * bar (under the old value, or a short skeleton line when empty); paused —
 * the bar still, amber, with a pause mark; failed — a warning mark at the
 * end. The value itself (text, or the option's name) stays readable,
 * dimmed while it waits. The canvas animates the shimmer itself
 * (`requestAnimationFrame` of glide), never with reduced motion.
 *
 * `copyData` is what screen readers get (the value and the state); the
 * clipboard reads the value (`cellClipboardText`).
 */
export interface AiStateData {
  readonly kind: 'ob-ai';
  readonly state: AiCellState;
  readonly text: string;
  readonly colors: {
    readonly text: string;
    readonly muted: string;
    readonly track: string;
    readonly accent: string;
    readonly warning: string;
    readonly danger: string;
  };
}

export type AiStateCell = CustomCell<AiStateData>;

export function isAiStateCell(cell: GridCell): cell is AiStateCell {
  return cell.kind === GridCellKind.Custom && (cell.data as { kind?: unknown }).kind === 'ob-ai';
}

/** One sweep of the shimmer, ms (FRONTEND §9.3 `animate-shimmer`: a band running across). */
const SWEEP_MS = 1600;
const BAND = 64;
const MARK = 14;

let reducedMotion: MediaQueryList | null | undefined;
function motionReduced(): boolean {
  if (reducedMotion === undefined) {
    reducedMotion =
      typeof window === 'undefined' || typeof window.matchMedia !== 'function'
        ? null
        : window.matchMedia('(prefers-reduced-motion: reduce)');
  }
  return reducedMotion?.matches ?? false;
}

/** A bar with a band of `accent` running across it (`phase` 0…1). */
function shimmerBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  colors: AiStateData['colors'],
  phase: number | null,
  strength: number,
): void {
  fillRoundedRect(ctx, x, y, width, height, height / 2, colors.track);
  if (phase === null) return;
  const center = x - BAND + phase * (width + 2 * BAND);
  const gradient = ctx.createLinearGradient(center - BAND, 0, center + BAND, 0);
  gradient.addColorStop(0, 'rgba(0,0,0,0)');
  gradient.addColorStop(0.5, colors.accent);
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.save();
  ctx.globalAlpha = strength;
  ctx.beginPath();
  ctx.rect(x, y, width, height);
  ctx.clip();
  ctx.fillStyle = gradient;
  ctx.fillRect(center - BAND, y, 2 * BAND, height);
  ctx.restore();
}

/** A warning triangle with "!" (lucide `triangle-alert`), `size` px, centered at x, y. */
function drawWarning(ctx: CanvasRenderingContext2D, x: number, y: number, color: string): void {
  const half = MARK / 2;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x, y - half + 1);
  ctx.lineTo(x + half, y + half - 1);
  ctx.lineTo(x - half, y + half - 1);
  ctx.closePath();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x, y - 2);
  ctx.lineTo(x, y + 1.5);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y + 4, 0.9, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

/** Two bars (pause), centered at x, y. */
function drawPause(ctx: CanvasRenderingContext2D, x: number, y: number, color: string): void {
  ctx.save();
  ctx.fillStyle = color;
  ctx.fillRect(x - 3.5, y - 4.5, 2.5, 9);
  ctx.fillRect(x + 1, y - 4.5, 2.5, 9);
  ctx.restore();
}

export const aiStateRenderer: CustomRenderer<AiStateCell> = {
  kind: GridCellKind.Custom,
  isMatch: (cell): cell is AiStateCell => (cell.data as { kind?: unknown }).kind === 'ob-ai',
  needsHover: false,
  draw: (args, cell) => {
    const { ctx, rect, theme } = args;
    const { state, text, colors } = cell.data;
    const left = rect.x + theme.cellHorizontalPadding;
    const right = rect.x + rect.width - theme.cellHorizontalPadding;
    const middle = rect.y + rect.height / 2;
    const marked = state === 'failed' || state === 'paused';
    const textRight = marked ? right - MARK - 6 : right;
    const waiting = state === 'queued' || state === 'running';
    const animate = waiting && !motionReduced();
    const phase = animate ? (args.frameTime % SWEEP_MS) / SWEEP_MS : null;
    // Waiting is subtle, generating stronger (the band brighter).
    const strength = state === 'running' ? 0.7 : 0.4;
    withCellClip(ctx, rect, () => {
      if (text !== '') {
        ctx.font = `${theme.baseFontStyle} ${theme.fontFamily}`;
        ctx.fillStyle = state === 'failed' ? colors.text : colors.muted;
        ctx.fillText(fitText(ctx, text, textRight - left), left, middle);
      }
      if (waiting || state === 'paused') {
        if (text === '') {
          // A short skeleton line where the value comes.
          const width = Math.max(24, Math.min(160, (textRight - left) * 0.6));
          shimmerBar(ctx, left, middle - 3, width, 6, colors, phase, strength);
        } else {
          shimmerBar(
            ctx,
            left,
            rect.y + rect.height - 5,
            textRight - left,
            2,
            colors,
            phase,
            strength,
          );
        }
      }
      if (state === 'failed') drawWarning(ctx, right - MARK / 2, middle, colors.danger);
      if (state === 'paused') drawPause(ctx, right - MARK / 2, middle, colors.warning);
    });
    if (animate) args.requestAnimationFrame();
  },
};
