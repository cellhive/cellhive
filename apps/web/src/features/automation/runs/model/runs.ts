import {
  CANCELLABLE_RUN_STATUSES,
  RERUNNABLE_RUN_STATUSES,
  type AutomationAction,
  type AutomationDefinition,
  type AutomationRunDto,
  type AutomationRunStatus,
  type AutomationRunStepDto,
} from '@cellhive/contracts';

/**
 * Pure helpers of the run history (T523, FRONTEND §13.3; CONTRACTS §21
 * "Lịch sử chạy"): filters ⇄ URL, which runs are still moving (polling),
 * what a run may do (re-run, cancel), the steps of a run in the order of its
 * definition, and the batch a run belongs to.
 */

/** Status filter of the list (one choice; the API takes several statuses). */
export const RUN_FILTERS = [
  'all',
  'failed',
  'active',
  'waiting',
  'succeeded',
  'skipped',
  'cancelled',
] as const;
export type RunFilter = (typeof RUN_FILTERS)[number];

const FILTER_STATUSES: Record<RunFilter, readonly AutomationRunStatus[] | undefined> = {
  all: undefined,
  failed: ['failed'],
  active: ['queued', 'running', 'waiting'],
  waiting: ['waiting'],
  succeeded: ['succeeded'],
  skipped: ['skipped'],
  cancelled: ['cancelled'],
};

export function statusesOf(filter: RunFilter): readonly AutomationRunStatus[] | undefined {
  return FILTER_STATUSES[filter];
}

export function parseRunFilter(value: string | null): RunFilter {
  return (RUN_FILTERS as readonly string[]).includes(value ?? '') ? (value as RunFilter) : 'all';
}

/** Time range of the list (on `created_at`); runs are kept 90 days by default. */
export const RUN_RANGES = ['24h', '7d', '30d', 'all'] as const;
export type RunRange = (typeof RUN_RANGES)[number];
export const DEFAULT_RUN_RANGE: RunRange = '7d';

const RANGE_MS: Record<Exclude<RunRange, 'all'>, number> = {
  '24h': 24 * 3_600_000,
  '7d': 7 * 24 * 3_600_000,
  '30d': 30 * 24 * 3_600_000,
};

export function parseRunRange(value: string | null): RunRange {
  return (RUN_RANGES as readonly string[]).includes(value ?? '')
    ? (value as RunRange)
    : DEFAULT_RUN_RANGE;
}

/** `from` of the API (inclusive) for a range ending now; `undefined` = no bound. */
export function fromOf(range: RunRange, now: Date): string | undefined {
  if (range === 'all') return undefined;
  return new Date(now.getTime() - RANGE_MS[range]).toISOString();
}

/** Runs that may still change status (the list and the detail poll while they show). */
export const ACTIVE_RUN_STATUSES = ['queued', 'running', 'waiting'] as const;

export function isActiveRun(status: AutomationRunStatus): boolean {
  return (ACTIVE_RUN_STATUSES as readonly string[]).includes(status);
}

/** Poll quickly while a run is queued or running. */
export const FAST_POLL_MS = 3_000;
/** A `delay` lasts minutes to days: a waiting run is asked again now and then. */
export const SLOW_POLL_MS = 30_000;

/**
 * How often to ask again (no realtime for runs, CONTRACTS §21): fast while
 * any shown run is queued or running, slowly while some only wait, never
 * when every run has ended.
 */
export function pollIntervalOf(statuses: Iterable<AutomationRunStatus>): number | false {
  let waiting = false;
  for (const status of statuses) {
    if (status === 'queued' || status === 'running') return FAST_POLL_MS;
    if (status === 'waiting') waiting = true;
  }
  return waiting ? SLOW_POLL_MS : false;
}

export function canRerun(run: Pick<AutomationRunDto, 'status'>): boolean {
  return (RERUNNABLE_RUN_STATUSES as readonly string[]).includes(run.status);
}

export function canCancel(run: Pick<AutomationRunDto, 'status'>): boolean {
  return (CANCELLABLE_RUN_STATUSES as readonly string[]).includes(run.status);
}

/** A re-run of this run that has not ended yet blocks another one (`409`). */
export function hasActiveRerun(reruns: readonly { status: AutomationRunStatus }[]): boolean {
  return reruns.some((rerun) => isActiveRun(rerun.status));
}

/** One line of the step timeline: an action of the definition and its step, if it ran. */
export interface TimelineItem {
  readonly actionId: string;
  /** "1", "2", "2.1" (numbered across both branches of an `if`, as the builder); `null` if unknown. */
  readonly number: string | null;
  readonly type: string | null;
  /** The action as defined at run time (`null`: not in the snapshot). */
  readonly action: AutomationAction | null;
  /** Latest step of this action (`null`: did not run). */
  readonly step: AutomationRunStepDto | null;
}

function numbered(definition: Pick<AutomationDefinition, 'actions'>) {
  const out: { action: AutomationAction; number: string }[] = [];
  definition.actions.forEach((action, index) => {
    const number = String(index + 1);
    out.push({ action, number });
    if (action.type !== 'if') return;
    let inner = 0;
    for (const branch of ['then', 'else'] as const) {
      for (const child of action.config[branch]) {
        inner += 1;
        out.push({ action: child, number: `${number}.${String(inner)}` });
      }
    }
  });
  return out;
}

/**
 * The steps of a run in the order of the definition it used (board "S5 ·
 * Run history": actions that did not run read "Did not run"); steps whose
 * action is not in the snapshot (it no longer parses) follow in the order
 * they started.
 */
export function timelineOf(
  definition: Pick<AutomationDefinition, 'actions'> | null,
  steps: readonly AutomationRunStepDto[],
): TimelineItem[] {
  const byAction = new Map<string, AutomationRunStepDto>();
  for (const step of steps) byAction.set(step.action_id, step);
  const items: TimelineItem[] = [];
  const seen = new Set<string>();
  for (const { action, number } of definition === null ? [] : numbered(definition)) {
    seen.add(action.id);
    items.push({
      actionId: action.id,
      number,
      type: action.type,
      action,
      step: byAction.get(action.id) ?? null,
    });
  }
  for (const step of steps) {
    if (seen.has(step.action_id)) continue;
    seen.add(step.action_id);
    items.push({
      actionId: step.action_id,
      number: null,
      type: step.action_type,
      action: null,
      step: byAction.get(step.action_id) ?? step,
    });
  }
  return items;
}

/** Milliseconds between two ISO instants, `null` when one is missing. */
export function elapsedMs(from: string | null, to: string | null): number | null {
  if (from === null || to === null) return null;
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** The fan-out stand-in run of a full batch (ADR-26 §4): how many runs, how many skipped. */
export interface BatchOverflow {
  readonly size: number | null;
  readonly limit: number | null;
  readonly skipped: number | null;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function batchOverflowOf(
  run: Pick<AutomationRunDto, 'error' | 'trigger'>,
): BatchOverflow | null {
  if (run.error?.code !== 'batch_fanout_exceeded') return null;
  const params = run.error.params ?? {};
  return {
    size: run.trigger.batch?.size ?? null,
    limit: count(params['limit']),
    skipped: count(params['skipped']),
  };
}

/** A string param of an error (`params.scope`, `params.user_id`…). */
export function textParam(
  params: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | null {
  const value = params?.[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}
