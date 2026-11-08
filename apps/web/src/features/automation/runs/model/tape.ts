import { instantOf, isActiveRun, type TimelineItem } from './runs';

import type { AutomationRunDto, AutomationStepStatus } from '@cellhive/contracts';

/**
 * The run tape of the run drawer (T1013, FRONTEND §13.3; Lucian UX/UI #191
 * "Event replay tape", BACKLOG S9 decision #9): the steps of a run on one
 * horizontal line built from their own times — `started_at` → `finished_at`
 * of each step's latest attempt (the store keeps one row per action: a
 * retry moves its start) — the waits between them, dots for retries and
 * waits, and a playhead. No screen replay: only what the run log stores.
 * Pure.
 *
 * Positions are fractions of the tape (0–1). Time is proportional, except
 * that every step keeps a minimum width — a 40 ms step after an hour's wait
 * stays visible and can be picked — so time and position map onto each
 * other through knots, piecewise linear.
 */

/** Narrowest step, as a share of the tape (≈ 10 px in the 480 px drawer). */
export const TAPE_MIN_WIDTH = 0.025;
/** Steps widened to the minimum never take more than this share together. */
const MAX_WIDENED_SHARE = 0.6;
/** A play from start to end lasts the run's own time, kept within these bounds (#191 plays 7 s). */
export const PLAY_MIN_MS = 2_000;
export const PLAY_MAX_MS = 7_000;
const EPSILON = 1e-6;

/** A step that ran in this run, placed on the tape. */
export interface TapeSpan {
  readonly item: TimelineItem;
  readonly actionId: string;
  readonly status: AutomationStepStatus;
  /** Milliseconds from the start of the tape. */
  readonly start: number;
  readonly end: number;
  /** Still running or waiting: it ends at the last poll and grows with the next one. */
  readonly open: boolean;
  readonly x0: number;
  readonly x1: number;
}

/** A dot: a step that ran again (`retry`, also a retry still to come) or waits (`waiting`). */
export interface TapeMark {
  readonly kind: 'retry' | 'waiting';
  readonly actionId: string;
  readonly x: number;
}

export interface Tape {
  /** Epoch ms of the start of the tape (the run's start, or its first step's). */
  readonly origin: number;
  /** Length of the tape in ms (to the run's end, or to the last poll while it goes on). */
  readonly total: number;
  /** In the order they started. */
  readonly spans: readonly TapeSpan[];
  /** Time between steps (queue, retry backoff, the end of a run still going). */
  readonly gaps: readonly { readonly x0: number; readonly x1: number }[];
  readonly marks: readonly TapeMark[];
  /** Time ⇄ position, both non-decreasing; from `{ t: 0, x: 0 }` to `{ t: total, x: 1 }`. */
  readonly knots: readonly { readonly t: number; readonly x: number }[];
}

export interface TapeInput {
  readonly items: readonly TimelineItem[];
  readonly run: Pick<AutomationRunDto, 'status' | 'started_at' | 'finished_at'>;
  /** When the run was read (its last poll): the end of what is still going. */
  readonly now: number;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * Widths of the parts of the tape: proportional to their time, but no step
 * narrower than `minWidth` (the others shrink to make room); when nothing
 * takes time, the steps share the tape.
 */
function widthsOf(parts: readonly { span: boolean; ms: number }[], minWidth: number): number[] {
  const spanCount = parts.filter((part) => part.span).length;
  const least = Math.min(minWidth, MAX_WIDENED_SHARE / Math.max(1, spanCount));
  const widened = new Set<number>();
  for (;;) {
    const rest = parts.reduce((sum, part, index) => (widened.has(index) ? sum : sum + part.ms), 0);
    if (rest <= 0) return parts.map((part) => (part.span ? 1 / spanCount : 0));
    const free = 1 - widened.size * least;
    const narrow = parts.flatMap((part, index) =>
      part.span && !widened.has(index) && (part.ms / rest) * free < least ? [index] : [],
    );
    narrow.forEach((index) => widened.add(index));
    if (narrow.length === 0) {
      return parts.map((part, index) => (widened.has(index) ? least : (part.ms / rest) * free));
    }
  }
}

/**
 * The tape of a run, `null` when no step ran in it (steps reused from the
 * run a re-run repeats did not run again: they stay off the tape).
 */
export function tapeOf(input: TapeInput, minWidth = TAPE_MIN_WIDTH): Tape | null {
  const active = isActiveRun(input.run.status);
  const ran = input.items
    .flatMap((item, index) =>
      item.step === null || item.step.reused || item.startedAt === null
        ? []
        : [{ item, step: item.step, startedAt: item.startedAt, index }],
    )
    .sort((a, b) => a.startedAt - b.startedAt || a.index - b.index);
  const first = ran[0];
  if (first === undefined) return null;
  const runStart = instantOf(input.run.started_at);
  const origin = runStart === null ? first.startedAt : Math.min(runStart, first.startedAt);
  let latest = origin;
  for (const { item, startedAt } of ran) {
    latest = Math.max(latest, startedAt, item.finishedAt ?? startedAt);
  }
  const runEnd = instantOf(input.run.finished_at);
  const end = active ? Math.max(latest, input.now) : Math.max(latest, runEnd ?? latest);
  const total = end - origin;

  // Steps in ms from the origin, one after the other (a clock that went back is clamped).
  let cursor = 0;
  const placed = ran.map(({ item, step, startedAt }) => {
    const open =
      active &&
      item.finishedAt === null &&
      (step.status === 'running' || step.status === 'waiting');
    const start = clamp(startedAt - origin, cursor, total);
    const stop = item.finishedAt === null ? (open ? total : start) : item.finishedAt - origin;
    const span = { item, status: step.status, start, end: clamp(stop, start, total), open };
    cursor = span.end;
    return span;
  });

  const parts: { span: number; t0: number; t1: number }[] = [];
  let at = 0;
  placed.forEach((span, index) => {
    if (span.start > at) parts.push({ span: -1, t0: at, t1: span.start });
    parts.push({ span: index, t0: span.start, t1: span.end });
    at = span.end;
  });
  if (total > at) parts.push({ span: -1, t0: at, t1: total });

  const widths = widthsOf(
    parts.map((part) => ({ span: part.span >= 0, ms: part.t1 - part.t0 })),
    minWidth,
  );
  const knots = [{ t: 0, x: 0 }];
  const bounds = new Map<number, { x0: number; x1: number }>();
  const gaps: { x0: number; x1: number }[] = [];
  let x = 0;
  parts.forEach((part, index) => {
    const x0 = x;
    x = index === parts.length - 1 ? 1 : Math.min(1, x + (widths[index] ?? 0));
    knots.push({ t: part.t1, x });
    if (part.span >= 0) bounds.set(part.span, { x0, x1: x });
    else if (x > x0) gaps.push({ x0, x1: x });
  });

  const spans: TapeSpan[] = placed.map((span, index) => ({
    ...span,
    actionId: span.item.actionId,
    ...(bounds.get(index) ?? { x0: 0, x1: 0 }),
  }));
  const marks: TapeMark[] = [];
  for (const span of spans) {
    const step = span.item.step;
    if (step === null) continue;
    if (step.attempt > 1) marks.push({ kind: 'retry', actionId: span.actionId, x: span.x0 });
    if (span.status === 'waiting')
      marks.push({ kind: 'waiting', actionId: span.actionId, x: span.x1 });
  }
  // A step that failed and will run again: the retry still to come, at the end.
  const last = spans.at(-1);
  if (
    last !== undefined &&
    input.run.status === 'queued' &&
    last.status === 'failed' &&
    last.item.step?.error?.retry_at !== undefined
  ) {
    marks.push({ kind: 'retry', actionId: last.actionId, x: 1 });
  }
  return { origin, total, spans, gaps, marks, knots };
}

/** Milliseconds from the start of the tape at position `u`. */
export function timeAt(tape: Pick<Tape, 'knots' | 'total'>, u: number): number {
  const p = clamp(u, 0, 1);
  const { knots } = tape;
  for (let index = 0; index < knots.length - 1; index += 1) {
    const a = knots[index];
    const b = knots[index + 1];
    if (a === undefined || b === undefined) break;
    if (p <= b.x) return b.x > a.x ? a.t + ((p - a.x) / (b.x - a.x)) * (b.t - a.t) : b.t;
  }
  return tape.total;
}

/** Position of `t` ms from the start (a step that took no time: its left edge). */
export function positionAt(tape: Pick<Tape, 'knots'>, t: number): number {
  const { knots } = tape;
  for (let index = 0; index < knots.length - 1; index += 1) {
    const a = knots[index];
    const b = knots[index + 1];
    if (a === undefined || b === undefined) break;
    if (t <= b.t)
      return b.t > a.t ? a.x + ((Math.max(t, a.t) - a.t) / (b.t - a.t)) * (b.x - a.x) : a.x;
  }
  return 1;
}

/**
 * The step at position `u`: the last one started there or before (between
 * two steps, the one that ran last; before the first, the first).
 */
export function spanAt(tape: Pick<Tape, 'spans'>, u: number): number {
  let found = 0;
  tape.spans.forEach((span, index) => {
    if (span.x0 <= u + EPSILON) found = index;
  });
  return found;
}

/** Where ← / → and "Next event" stop: the start of the tape, of each step, its end. */
export function stopsOf(tape: Pick<Tape, 'spans'>): number[] {
  return [...new Set([0, ...tape.spans.map((span) => span.x0), 1])].sort((a, b) => a - b);
}

/**
 * Stops this close to the playhead (≈ 2 px of the drawer's tape) are where it
 * already is: from the start, → goes to step 2 when step 1 starts at once.
 */
const SAME_STOP = 0.005;

export function nextStop(tape: Pick<Tape, 'spans'>, u: number): number {
  return stopsOf(tape).find((stop) => stop > u + SAME_STOP) ?? 1;
}

export function previousStop(tape: Pick<Tape, 'spans'>, u: number): number {
  return stopsOf(tape).findLast((stop) => stop < u - SAME_STOP) ?? 0;
}

/** How long a play from start to end lasts at 1×: the run's own time, within 2–7 s. */
export function playDurationMs(total: number): number {
  return clamp(total, PLAY_MIN_MS, PLAY_MAX_MS);
}

/** How "t / T" reads, chosen by the length of the tape: ms, seconds, m:ss or h:mm:ss. */
export type ClockUnit = 'ms' | 's' | 'm' | 'h';

export function clockUnitOf(total: number): ClockUnit {
  if (total < 1_000) return 'ms';
  if (total < 60_000) return 's';
  return total < 3_600_000 ? 'm' : 'h';
}

/** `ms` in `unit` ("340", "1.2" — "1,2" in Vietnamese —, "4:05", "1:02:05"). */
export function clockText(ms: number, unit: ClockUnit, locale: string): string {
  const value = Math.max(0, ms);
  if (unit === 'ms') return new Intl.NumberFormat(locale).format(Math.round(value));
  if (unit === 's') {
    return new Intl.NumberFormat(locale, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }).format(Math.round(value / 100) / 10);
  }
  const seconds = Math.floor(value / 1_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  if (unit === 'm') return `${String(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
  return `${String(Math.floor(seconds / 3_600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
}
