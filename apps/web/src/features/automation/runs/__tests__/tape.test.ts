import { describe, expect, it } from 'vitest';

import { timelineOf } from '../model/runs';
import {
  clockText,
  clockUnitOf,
  nextStop,
  playDurationMs,
  positionAt,
  previousStop,
  spanAt,
  tapeOf,
  TAPE_MIN_WIDTH,
  timeAt,
  type Tape,
} from '../model/tape';

import type {
  AutomationDefinition,
  AutomationRunStatus,
  AutomationRunStepDto,
} from '@cellhive/contracts';

const T0 = Date.parse('2026-11-08T03:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();

function step(
  actionId: string,
  from: number,
  to: number | null,
  overrides: Partial<AutomationRunStepDto> = {},
): AutomationRunStepDto {
  return {
    id: `stp_${actionId}`,
    action_id: actionId,
    action_type: null,
    status: 'succeeded',
    attempt: 1,
    started_at: at(from),
    finished_at: to === null ? null : at(to),
    reused: false,
    output: null,
    redacted: false,
    error: null,
    ...overrides,
  };
}

const definition = {
  actions: [
    { id: 'act_1', type: 'find_records', config: {} },
    { id: 'act_2', type: 'update_record', config: {} },
    { id: 'act_3', type: 'create_record', config: {} },
  ],
} as unknown as AutomationDefinition;

function tape(
  steps: AutomationRunStepDto[],
  run: { status: AutomationRunStatus; from?: number | null; to?: number | null; now?: number },
): Tape | null {
  return tapeOf({
    items: timelineOf(definition, steps),
    run: {
      status: run.status,
      started_at: run.from === null ? null : at(run.from ?? 0),
      finished_at: run.to === undefined || run.to === null ? null : at(run.to),
    },
    now: T0 + (run.now ?? 0),
  });
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

describe('run tape: layout', () => {
  it('has no tape when no step ran in the run (reused steps did not run again)', () => {
    expect(tape([], { status: 'queued', from: null })).toBeNull();
    expect(
      tape([step('act_1', 0, 100, { reused: true })], { status: 'succeeded', to: 100 }),
    ).toBeNull();
  });

  it('places three steps in proportion to their time, gaps between them', () => {
    const result = tape(
      [step('act_1', 0, 1000), step('act_2', 1000, 3000), step('act_3', 3000, 4000)],
      {
        status: 'succeeded',
        to: 4000,
      },
    );
    expect(result?.total).toBe(4000);
    expect(result?.spans.map((span) => [span.actionId, round(span.x0), round(span.x1)])).toEqual([
      ['act_1', 0, 0.25],
      ['act_2', 0.25, 0.75],
      ['act_3', 0.75, 1],
    ]);
    expect(result?.gaps).toEqual([]);
  });

  it.each([
    // [what, steps, run, spans [id, x0, x1], gaps]
    [
      'a retry backoff is a gap; the retried step has a retry dot at its start',
      [
        step('act_1', 0, 1000),
        step('act_2', 9000, 10_000, { attempt: 2 }),
        step('act_3', 10_000, 11_000, { status: 'failed' }),
      ],
      { status: 'failed' as const, to: 11_000 },
      [
        ['act_1', 0, 0.091, 'succeeded'],
        ['act_2', 0.818, 0.909, 'succeeded'],
        ['act_3', 0.909, 1, 'failed'],
      ],
      [[0.091, 0.818]],
      [{ kind: 'retry', actionId: 'act_2', x: 0.818 }],
    ],
    [
      'a waiting delay runs to the last poll and has a dot at its end',
      [step('act_1', 0, 1000), step('act_2', 1000, null, { status: 'waiting' })],
      { status: 'waiting' as const, now: 4000 },
      [
        ['act_1', 0, 0.25, 'succeeded'],
        ['act_2', 0.25, 1, 'waiting'],
      ],
      [],
      [{ kind: 'waiting', actionId: 'act_2', x: 1 }],
    ],
    [
      'a run waiting for a retry: the failed step, then the wait, then the retry to come',
      [
        step('act_1', 0, 1000),
        step('act_2', 1000, 2000, {
          status: 'failed',
          error: { code: 'temporary_error', attempt: 1, retry_at: at(60_000) },
        }),
      ],
      { status: 'queued' as const, now: 4000 },
      [
        ['act_1', 0, 0.25, 'succeeded'],
        ['act_2', 0.25, 0.5, 'failed'],
      ],
      [[0.5, 1]],
      [{ kind: 'retry', actionId: 'act_2', x: 1 }],
    ],
  ])('%s', (_, steps, run, spans, gaps, marks) => {
    const result = tape(steps, run);
    expect(
      result?.spans.map((span) => [span.actionId, round(span.x0), round(span.x1), span.status]),
    ).toEqual(spans);
    expect(result?.gaps.map((gap) => [round(gap.x0), round(gap.x1)])).toEqual(gaps);
    expect(result?.marks.map((mark) => ({ ...mark, x: round(mark.x) }))).toEqual(marks);
  });

  it('keeps a short step after a long wait visible (minimum width), the wait shrinks', () => {
    const result = tape(
      [
        step('act_1', 0, 50),
        step('act_2', 3_600_000, 3_600_040),
        step('act_3', 3_600_040, 3_600_080),
      ],
      { status: 'succeeded', to: 3_600_080 },
    );
    const widths = result?.spans.map((span) => round(span.x1 - span.x0));
    expect(widths).toEqual([TAPE_MIN_WIDTH, TAPE_MIN_WIDTH, TAPE_MIN_WIDTH]);
    expect(result?.gaps.map((gap) => round(gap.x1 - gap.x0))).toEqual([
      round(1 - 3 * TAPE_MIN_WIDTH),
    ]);
  });

  it('shares the tape between steps that took no time', () => {
    const result = tape([step('act_1', 0, 0), step('act_2', 0, 0)], { status: 'succeeded', to: 0 });
    expect(result?.total).toBe(0);
    expect(result?.spans.map((span) => [span.x0, span.x1])).toEqual([
      [0, 0.5],
      [0.5, 1],
    ]);
  });

  it('a running step grows to the last poll; the run start counts before the first step', () => {
    const first = tape(
      [step('act_1', 500, 1000), step('act_2', 1000, null, { status: 'running' })],
      {
        status: 'running',
        now: 2000,
      },
    );
    expect(first?.total).toBe(2000);
    expect(first?.spans.map((span) => [span.open, round(span.x0), round(span.x1)])).toEqual([
      [false, 0.25, 0.5],
      [true, 0.5, 1],
    ]);
    expect(first?.gaps.map((gap) => [round(gap.x0), round(gap.x1)])).toEqual([[0, 0.25]]);
    const later = tape(
      [step('act_1', 500, 1000), step('act_2', 1000, null, { status: 'running' })],
      {
        status: 'running',
        now: 4000,
      },
    );
    expect(later?.total).toBe(4000);
    expect(round(later?.spans[1]?.x0 ?? 0)).toBe(0.25);
  });

  it('a step whose clock went back starts where the previous one ended', () => {
    const result = tape([step('act_1', 0, 2000), step('act_2', 1500, 3000)], {
      status: 'succeeded',
      to: 3000,
    });
    expect(result?.spans.map((span) => [span.start, span.end])).toEqual([
      [0, 2000],
      [2000, 3000],
    ]);
  });
});

describe('run tape: playhead', () => {
  const result = tape(
    [
      step('act_1', 0, 1000),
      step('act_2', 9000, 10_000, { attempt: 2 }),
      step('act_3', 10_000, 11_000, { status: 'failed' }),
    ],
    { status: 'failed', to: 11_000 },
  ) as Tape;

  it.each([
    [0, 0],
    [0.05, 550],
    [0.5, 5500],
    [1, 11_000],
    [2, 11_000],
  ])('position %s is %s ms', (u, ms) => {
    expect(Math.round(timeAt(result, u))).toBe(ms);
    expect(round(positionAt(result, timeAt(result, u)))).toBe(round(Math.min(1, u)));
  });

  it('a step that took no time keeps its time across its width', () => {
    const instant = tape([step('act_1', 0, 0), step('act_2', 0, 1000)], {
      status: 'succeeded',
      to: 1000,
    }) as Tape;
    expect(timeAt(instant, TAPE_MIN_WIDTH / 2)).toBe(0);
    expect(positionAt(instant, 0)).toBe(0);
  });

  it.each([
    // [u, step index]
    [0, 0],
    [0.05, 0],
    [0.5, 0], // in the retry wait: the step that ran last
    [0.82, 1],
    [0.95, 2],
    [1, 2],
  ])('at %s the step is #%s', (u, index) => {
    expect(spanAt(result, u)).toBe(index);
  });

  it.each([
    // [u, next, previous]
    [0, 0.818, 0],
    [0.5, 0.818, 0],
    [0.818, 0.909, 0],
    [0.909, 1, 0.818],
    [1, 1, 0.909],
  ])('from %s: next stop %s, previous %s', (u, next, previous) => {
    const exact =
      u === 0.818 ? (result.spans[1]?.x0 ?? 0) : u === 0.909 ? (result.spans[2]?.x0 ?? 0) : u;
    expect(round(nextStop(result, exact))).toBe(next);
    expect(round(previousStop(result, exact))).toBe(previous);
  });

  it('from the start, → skips a first step that starts at once', () => {
    const quick = tape([step('act_1', 20, 1000), step('act_2', 1000, 4000)], {
      status: 'succeeded',
      to: 4000,
    }) as Tape;
    expect(round(nextStop(quick, 0))).toBe(0.25);
    expect(previousStop(quick, quick.spans[1]?.x0 ?? 0)).toBe(quick.spans[0]?.x0);
    expect(previousStop(quick, quick.spans[0]?.x0 ?? 0)).toBe(0);
  });

  it.each([
    [40, 2_000],
    [3_400, 3_400],
    [600_000, 7_000],
  ])('a play of a %s ms run lasts %s ms', (total, ms) => {
    expect(playDurationMs(total)).toBe(ms);
  });
});

describe('run tape: clock', () => {
  it.each([
    [120, 340, 'en', '120 / 340'],
    [1234, 3449, 'en', '1.2 / 3.4'],
    [1234, 3449, 'vi', '1,2 / 3,4'],
    [65_000, 270_000, 'en', '1:05 / 4:30'],
    [725_000, 10_800_000, 'en', '0:12:05 / 3:00:00'],
  ])('%s of %s ms (%s) reads "%s"', (t, total, locale, text) => {
    const unit = clockUnitOf(total);
    expect(`${clockText(t, unit, locale)} / ${clockText(total, unit, locale)}`).toBe(text);
  });
});
