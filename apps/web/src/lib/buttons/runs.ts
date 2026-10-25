import { createStore, useStore } from '../store';

import type { FinishedStatus } from './clicks';

/**
 * Clicks of this tab still running (T525): from the click until
 * `automation.run.finished` of their run on `user:<me>` (CONTRACTS §7).
 * One store for the tab, so the grid and the record panel show the same
 * spinner and only one of them answers the message (`takeRun`).
 */

export interface RunningClick {
  /** `buttonKey(recordId, fieldId)`. */
  readonly key: string;
  /** `null` until the `202` arrives. */
  readonly runId: string | null;
  readonly tableId: string;
  readonly recordId: string;
  readonly fieldId: string;
  /** The button's label and the record's title, for the toast. */
  readonly label: string;
  readonly recordTitle: string;
  readonly startedAt: number;
}

const store = createStore<ReadonlyMap<string, RunningClick>>(new Map());

/**
 * Runs that finished before their click's `202` was read (a very short
 * run): the status waits here for `attachRun`.
 */
const finishedEarly = new Map<string, FinishedStatus>();

export function runningClicks(): ReadonlyMap<string, RunningClick> {
  return store.get();
}

export function useRunningClicks(): ReadonlyMap<string, RunningClick> {
  return useStore(store);
}

/** `false` when that cell already runs (a second click is ignored). */
export function beginClick(click: Omit<RunningClick, 'runId' | 'startedAt'>): boolean {
  if (store.get().has(click.key)) return false;
  store.set((current) =>
    new Map(current).set(click.key, { ...click, runId: null, startedAt: Date.now() }),
  );
  return true;
}

/**
 * The click was accepted: its run is known. Returns the status when the
 * run already finished (the click is then over).
 */
export function attachRun(key: string, runId: string): FinishedStatus | undefined {
  const early = finishedEarly.get(runId);
  if (early !== undefined) {
    finishedEarly.delete(runId);
    return early;
  }
  const click = store.get().get(key);
  if (click !== undefined) {
    store.set((current) => new Map(current).set(key, { ...click, runId }));
  }
  return undefined;
}

/** The click is over (refused, finished, timed out). */
export function endClick(key: string): void {
  if (!store.get().has(key)) return;
  store.set((current) => {
    const next = new Map(current);
    next.delete(key);
    return next;
  });
}

/**
 * The run of a click finished: returns its click, once (the first screen
 * to ask answers it). A run not attached yet but with a click in flight is
 * remembered for `attachRun`; a run of another tab is ignored.
 */
export function takeRun(runId: string, status: FinishedStatus): RunningClick | undefined {
  for (const click of store.get().values()) {
    if (click.runId !== runId) continue;
    endClick(click.key);
    return click;
  }
  if ([...store.get().values()].some((click) => click.runId === null)) {
    finishedEarly.set(runId, status);
    // Bounded: only clicks in flight can claim it.
    if (finishedEarly.size > 50) finishedEarly.delete(finishedEarly.keys().next().value ?? '');
  }
  return undefined;
}

/** Tests: forget every click. */
export function resetRunningClicks(): void {
  store.set(new Map());
  finishedEarly.clear();
}
