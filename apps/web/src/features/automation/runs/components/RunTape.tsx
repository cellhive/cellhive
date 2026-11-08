/*! Lucian UX/UI Prompt #191 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#191 */
import '../../../../styles/lucian.css';
import './RunTape.css';

import { Button } from '@cellhive/ui';
import { Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';

import { useFormatters, type Formatters } from '../../../../lib/i18n/format';
import { stepOutputView, type StepOutputView } from '../model/output';
import {
  clockText,
  clockUnitOf,
  nextStop,
  playDurationMs,
  positionAt,
  previousStop,
  spanAt,
  timeAt,
  type Tape,
  type TapeSpan,
} from '../model/tape';

import {
  formatDuration,
  retryAtOf,
  runErrorText,
  StatusBadge,
  StepIcon,
  stepTitleOf,
} from './RunBits';

import type { AutomationStepStatus } from '@cellhive/contracts';
import type { TFunction } from 'i18next';

/**
 * Lucian UX/UI #191 "Event replay tape" (element 1f44267b9d, catalog
 * 34c4b3e61d) over the steps of a run (FRONTEND §13.3, §9.3 "Lucian UX/UI";
 * BACKLOG S9 decision #9): a card for the step under the playhead in place
 * of the pattern's recorded screen, the tape — a segment per step from its
 * start to its end, colored by status, dashed waits between steps, dots for
 * a retry and for a wait — with a playhead to drag (`role=slider`: ←/→ step
 * to step, Home/End, Space plays), and Back to start / Play / Next event /
 * Speed with "t / T" in the run's own time. The step list under it stays the
 * accessible record of the run: the step under the playhead is marked there
 * and scrolled to whenever the playhead moves (not while it is dragged).
 *
 * The pattern's script runs as React state and two effects (the play loop,
 * the card's entrance); positions and times come from the pure model
 * (`model/tape.ts`). A run still going grows with each poll: the playhead
 * keeps its time, or stays at the end.
 */

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
const END = 1 - 1e-9;
/** The pattern's longest frame step while playing. */
const MAX_FRAME_MS = 60;

const LEGEND_ORDER: readonly AutomationStepStatus[] = [
  'succeeded',
  'failed',
  'running',
  'waiting',
  'skipped',
  'cancelled',
];

function reducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(REDUCED_MOTION).matches;
}

function percent(value: number): string {
  return `${String(Math.round(value * 100_000) / 1000)}%`;
}

/** The nearest ancestor that scrolls (the drawer's `<dialog>`). */
function scrollerOf(node: HTMLElement): HTMLElement | null {
  for (let parent = node.parentElement; parent !== null; parent = parent.parentElement) {
    const { overflowY } = window.getComputedStyle(parent);
    if (
      (overflowY === 'auto' || overflowY === 'scroll') &&
      parent.scrollHeight > parent.clientHeight
    ) {
      return parent;
    }
  }
  return null;
}

/** One line of what the step returned, ids and counts only (the list shows it in full). */
function summaryOf(view: StepOutputView | null, t: TFunction, format: Formatters): ReactNode {
  if (view === null) return null;
  switch (view.kind) {
    case 'find':
      return `${t('output.found')}: ${t('output.foundCount', { count: view.count ?? view.records.length })}`;
    case 'record':
      return (
        <>
          {t('output.record')}:{' '}
          {view.recordId === null ? (
            t('output.hidden')
          ) : (
            <span className="u191-id">{view.recordId}</span>
          )}
        </>
      );
    case 'if':
      return view.branch === null
        ? null
        : `${t('output.branch')}: ${t(`output.branchName.${view.branch}`, { defaultValue: view.branch })}`;
    case 'updateRecords':
      return view.updated === null
        ? null
        : `${t('output.updated')}: ${format.number(view.updated)}`;
    case 'delay':
      if (view.resumedAt !== null)
        return `${t('output.resumedAt')}: ${format.dateTime(view.resumedAt)}`;
      return view.until === null ? null : `${t('output.until')}: ${format.dateTime(view.until)}`;
    case 'email':
      return `${t('output.accepted')}: ${format.number(view.accepted.length)}`;
    case 'notification':
      return view.delivered === null
        ? null
        : `${t('output.delivered')}: ${t('output.people', { count: view.delivered })}`;
    default:
      return null;
  }
}

/** The pattern's recorded screen, as the card of the step under the playhead (fixed height). */
function StepCard({
  span,
  unit,
  userName,
}: {
  readonly span: TapeSpan;
  readonly unit: ReturnType<typeof clockUnitOf>;
  readonly userName: (userId: string) => string | null;
}) {
  const { t } = useTranslation(['automationRuns', 'automationBuilder']);
  const format = useFormatters();
  const body = useRef<HTMLDivElement>(null);
  const step = span.item.step;
  const withUnit = useClockUnit(unit);

  // The pattern's "Signed up!" entrance (opacity .3 s, a spring rise .4 s) when the step changes.
  useLayoutEffect(() => {
    const node = body.current;
    if (node === null || typeof node.animate !== 'function' || reducedMotion()) return;
    const spring =
      window.getComputedStyle(node).getPropertyValue('--ux-spring').trim() ||
      'cubic-bezier(.34,1.45,.64,1)';
    node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, easing: 'ease-out' });
    node.animate([{ transform: 'translateY(6px)' }, { transform: 'none' }], {
      duration: 400,
      easing: spring,
    });
  }, [span.actionId]);

  if (step === null) return null;
  const meta = [
    t('tape.startedAt', { time: withUnit(clockText(span.start, unit, format.locale)) }),
    span.open
      ? t('tape.soFar', { duration: formatDuration(span.end - span.start, format, t) })
      : formatDuration(span.end - span.start, format, t),
    ...(step.attempt > 1 ? [t('detail.attempt', { count: step.attempt })] : []),
  ].join(' · ');
  const retryAt = retryAtOf(step.error);
  const until = (step.output as { until?: unknown } | null)?.until;
  let note: ReactNode;
  let tone: 'danger' | undefined;
  if (step.error !== null) {
    const error = runErrorText(step.error, { t, format, userName });
    note =
      retryAt === null
        ? error
        : `${error} · ${t('detail.retryAt', { time: format.dateTime(retryAt) })}`;
    if (retryAt === null && step.status === 'failed') tone = 'danger';
  } else if (
    step.status === 'waiting' &&
    typeof until === 'string' &&
    !Number.isNaN(Date.parse(until))
  ) {
    note = t('detail.waitingUntil', { time: format.dateTime(until) });
  } else {
    note =
      summaryOf(stepOutputView(step.action_type ?? span.item.type, step.output), t, format) ??
      (step.redacted ? t('output.hidden') : null);
  }
  return (
    <div className="u191-card" data-testid="run-tape-card" data-step={span.actionId}>
      <div ref={body} key={span.actionId} className="u191-card-body">
        <div className="u191-card-head">
          <StepIcon status={step.status} />
          <span className="u191-card-title">{stepTitleOf(span.item, t)}</span>
          <StatusBadge status={step.status} />
        </div>
        <p className="u191-card-line">{meta}</p>
        {note === null ? null : (
          <p className="u191-card-line" data-tone={tone}>
            {note}
          </p>
        )}
      </div>
    </div>
  );
}

/** "1.2" → "1.2 s" for a tape measured in ms or seconds (m:ss and h:mm:ss need no unit). */
function useClockUnit(unit: ReturnType<typeof clockUnitOf>) {
  const { t } = useTranslation('automationRuns');
  return useCallback(
    (text: string) =>
      unit === 'ms'
        ? t('duration.ms', { value: text })
        : unit === 's'
          ? t('duration.s', { value: text })
          : text,
    [t, unit],
  );
}

export interface RunTapeProps {
  readonly tape: Tape;
  readonly userName: (userId: string) => string | null;
  /** The step under the playhead, once the person has used the tape (marks its row). */
  readonly onSelect: (actionId: string) => void;
  /** The row of a step in the list under the tape. */
  readonly rowOf: (actionId: string) => HTMLElement | null;
}

export function RunTape({ tape, userName, onSelect, rowOf }: RunTapeProps) {
  const { t } = useTranslation(['automationRuns', 'automationBuilder']);
  const format = useFormatters();
  const root = useRef<HTMLDivElement>(null);
  const marks = useRef<HTMLDivElement>(null);
  // The playhead (0–1 along the tape) of the tape it was set on: a new poll keeps its time.
  const [position, setPosition] = useState({ tape, u: 1 });
  let u = position.u;
  if (position.tape !== tape) {
    u = u >= END ? 1 : positionAt(tape, timeAt(position.tape, u));
    setPosition({ tape, u });
  }
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<1 | 2>(1);
  const [touched, setTouched] = useState(false);
  /** A jump (keys, buttons, a click) glides; a drag and a play follow the pointer and the clock. */
  const [glide, setGlide] = useState(false);
  const dragging = useRef(false);
  // What the play loop and the handlers read between renders.
  const live = useRef({ u, tape, speed });
  useLayoutEffect(() => {
    live.current = { u, tape, speed };
  });

  const index = spanAt(tape, u);
  const span = tape.spans[index];
  const currentId = span?.actionId ?? null;
  const unit = clockUnitOf(tape.total);
  const withUnit = useClockUnit(unit);
  const time = timeAt(tape, u);

  const reveal = useCallback(
    (actionId: string) => {
      const row = rowOf(actionId);
      const panel = root.current;
      if (row === null || panel === null) return;
      const scroller = scrollerOf(panel);
      if (scroller === null) return;
      // Below the tape (its box ends with an 8 px band), above the bottom edge. The tape sticks
      // to the top of the drawer: a row under it may scroll up until it meets the tape there.
      const view = scroller.getBoundingClientRect();
      const tapeBox = panel.getBoundingClientRect();
      const below = Math.max(view.top, tapeBox.bottom);
      const belowStuck = view.top + tapeBox.height;
      const bottom = view.bottom - 8;
      const box = row.getBoundingClientRect();
      const delta =
        box.top < below
          ? box.top - below
          : box.bottom > bottom
            ? Math.min(box.bottom - bottom, box.top - belowStuck)
            : 0;
      if (Math.abs(delta) > 1) {
        scroller.scrollBy({ top: delta, behavior: reducedMotion() ? 'auto' : 'smooth' });
      }
    },
    [rowOf],
  );

  const go = (next: number, options: { readonly reveal: boolean; readonly glide: boolean }) => {
    const target = Math.min(1, Math.max(0, next));
    live.current = { ...live.current, u: target };
    setTouched(true);
    setGlide(options.glide);
    setPosition({ tape, u: target });
    const id = tape.spans[spanAt(tape, target)]?.actionId;
    if (id !== undefined && options.reveal) reveal(id);
  };

  // The list follows the playhead once the tape is used.
  useEffect(() => {
    if (touched && currentId !== null) onSelect(currentId);
  }, [touched, currentId, onSelect]);
  useEffect(() => {
    if (playing && currentId !== null) reveal(currentId);
  }, [playing, currentId, reveal]);

  // The pattern's play loop: frames of at most 60 ms, at the chosen speed, stop at the end.
  useEffect(() => {
    if (!playing) return undefined;
    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      const dt = Math.max(0, Math.min(MAX_FRAME_MS, now - last));
      last = now;
      const { tape: current, speed: rate } = live.current;
      const next = Math.min(1, live.current.u + (dt * rate) / playDurationMs(current.total));
      live.current = { ...live.current, u: next };
      setPosition({ tape: current, u: next });
      if (next >= 1) setPlaying(false);
      else raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [playing]);

  const togglePlay = () => {
    if (playing) {
      setPlaying(false);
      return;
    }
    // Reduced motion: no animation, the end state at once.
    if (reducedMotion()) {
      go(1, { reveal: true, glide: false });
      return;
    }
    go(live.current.u >= END ? 0 : live.current.u, { reveal: false, glide: false });
    setPlaying(true);
  };

  const seek = (event: PointerEvent<HTMLElement>) => {
    const box = marks.current?.getBoundingClientRect();
    if (box === undefined || box.width <= 0) return;
    go((event.clientX - box.left) / box.width, { reveal: false, glide: false });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = nextStop(tape, u);
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = previousStop(tape, u);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = 1;
    else if (event.key === ' ') {
      event.preventDefault();
      togglePlay();
      return;
    }
    if (next === null) return;
    event.preventDefault();
    setPlaying(false);
    go(next, { reveal: true, glide: true });
  };

  if (span === undefined) return null;
  const legend = LEGEND_ORDER.filter((status) => tape.spans.some((item) => item.status === status));
  const retries = tape.marks.some((mark) => mark.kind === 'retry');
  const totalText = withUnit(clockText(tape.total, unit, format.locale));
  const step = span.item.step;

  return (
    <div
      ref={root}
      className="ux u191"
      data-testid="run-tape"
      role="group"
      aria-label={t('tape.label')}
    >
      <div className="u191-frame">
        <StepCard span={span} unit={unit} userName={userName} />
        <div
          className="u191-tp"
          role="slider"
          tabIndex={0}
          aria-label={t('tape.position')}
          aria-valuemin={0}
          aria-valuemax={Math.round(tape.total / 100) / 10}
          aria-valuenow={Math.round(time / 100) / 10}
          aria-valuetext={t('tape.valueText', {
            step: stepTitleOf(span.item, t),
            status: t(`status.${step?.status ?? span.status}`),
            time: withUnit(clockText(time, unit, format.locale)),
            total: totalText,
          })}
          data-testid="run-tape-track"
          onKeyDown={onKeyDown}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            dragging.current = true;
            setPlaying(false);
            seek(event);
            try {
              event.currentTarget.setPointerCapture(event.pointerId);
            } catch {
              // a synthetic pointer cannot be captured
            }
          }}
          onPointerMove={(event) => {
            if (dragging.current) seek(event);
          }}
          onPointerUp={() => {
            if (!dragging.current) return;
            dragging.current = false;
            if (currentId !== null) reveal(currentId);
          }}
          onPointerCancel={() => {
            dragging.current = false;
          }}
        >
          <div ref={marks} className="u191-marks" aria-hidden="true">
            {tape.gaps.map((gap) => (
              <span
                key={`gap-${String(gap.x0)}`}
                className="u191-gap"
                style={{ left: percent(gap.x0), width: percent(gap.x1 - gap.x0) }}
              />
            ))}
            {tape.spans.map((item, at) => (
              <span
                key={item.actionId}
                className="u191-seg"
                data-status={item.status}
                data-open={item.open ? '' : undefined}
                data-current={at === index ? '' : undefined}
                data-testid={`run-tape-segment-${item.actionId}`}
                style={{ left: percent(item.x0), width: percent(item.x1 - item.x0) }}
              />
            ))}
            {tape.marks.map((mark) => (
              <span
                key={`${mark.kind}-${mark.actionId}-${String(mark.x)}`}
                className="u191-dot"
                data-kind={mark.kind}
                data-testid={`run-tape-dot-${mark.kind}-${mark.actionId}`}
                style={{ left: percent(mark.x) }}
              />
            ))}
            <span
              className="u191-ph"
              data-glide={glide ? '' : undefined}
              style={{ left: percent(u) }}
            />
          </div>
          <div className="u191-lg" aria-hidden="true">
            {legend.map((status) => (
              <span key={status} data-k={status}>
                {t(`status.${status}`)}
              </span>
            ))}
            {retries ? <span data-k="retry">{t('tape.retry')}</span> : null}
          </div>
        </div>
        <div className="u191-ct">
          <Button
            variant="secondary"
            size="icon"
            aria-label={t('tape.start')}
            data-testid="run-tape-start"
            onClick={() => {
              go(0, { reveal: true, glide: true });
            }}
          >
            <SkipBack aria-hidden="true" />
          </Button>
          <Button
            size="icon"
            className="u191-pl"
            aria-label={playing ? t('tape.pause') : t('tape.play')}
            data-testid="run-tape-play"
            data-playing={playing ? '' : undefined}
            onClick={togglePlay}
          >
            {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
          </Button>
          <Button
            variant="secondary"
            size="icon"
            aria-label={t('tape.next')}
            data-testid="run-tape-next"
            onClick={() => {
              setPlaying(false);
              go(nextStop(tape, live.current.u), { reveal: true, glide: true });
            }}
          >
            <SkipForward aria-hidden="true" />
          </Button>
          <Button
            variant="secondary"
            size="toolbar"
            className="u191-sp"
            aria-label={t('tape.speed', { speed })}
            data-testid="run-tape-speed"
            onClick={() => {
              setSpeed((value) => (value === 1 ? 2 : 1));
            }}
          >
            {speed}×
          </Button>
          <output aria-live="off" data-testid="run-tape-time">
            {t('tape.output', {
              time: clockText(time, unit, format.locale),
              total: totalText,
            })}
          </output>
        </div>
      </div>
    </div>
  );
}
