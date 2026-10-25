import { useSyncExternalStore } from 'react';

import type { ChannelMessage } from './socket';

/**
 * Progress of the computation of stored formula/lookup fields seen by this
 * tab (T468, CONTRACTS §7 `computed.recomputing`, BACKLOG S4b additional
 * decision #6): the backfill of a new definition and the incremental
 * recompute job, one entry per field. The column header draws the
 * percentage while the field's `compute_state` is `backfilling` or
 * `recomputing` — the field list stays the truth for the state (it changes
 * through `schema.changed`); this store only adds how far the job got.
 */

export type ComputedRecomputingMessage = Extract<ChannelMessage, { type: 'computed.recomputing' }>;

export interface ComputedProgress {
  readonly fieldId: string;
  readonly status: ComputedRecomputingMessage['status'];
  /** 0 → 1 as the server reports it. */
  readonly progress: number;
  readonly updatedAt: number;
}

type Snapshot = ReadonlyMap<string, ComputedProgress>;

let entries: Snapshot = new Map();
const listeners = new Set<() => void>();

function emit(next: Snapshot): void {
  entries = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): Snapshot {
  return entries;
}

/** A `computed.recomputing` message of a `table:` channel. */
export function recordComputedProgress(
  message: ComputedRecomputingMessage,
  now: number = Date.now(),
): void {
  const next = new Map(entries);
  next.set(message.field_id, {
    fieldId: message.field_id,
    status: message.status,
    progress: message.status === 'succeeded' ? 1 : message.progress,
    updatedAt: now,
  });
  emit(next);
}

/** Forgets the progress of fields (tests; a field back to `ready`). */
export function clearComputedProgress(fieldIds?: readonly string[]): void {
  if (fieldIds === undefined) {
    emit(new Map());
    return;
  }
  if (!fieldIds.some((id) => entries.has(id))) return;
  const next = new Map(entries);
  for (const id of fieldIds) next.delete(id);
  emit(next);
}

/** Progress by field id, re-rendering on every message. */
export function useComputedProgress(): Snapshot {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * The fraction a computing field shows: the last `running` message (a new
 * job starts from 0), `0` before any message. A `succeeded` message while
 * the field list still says it computes (its `schema.changed` is on its
 * way) keeps 100 %.
 */
export function progressOf(progress: ComputedProgress | undefined): number {
  if (progress === undefined) return 0;
  return progress.status === 'succeeded' ? 1 : progress.progress;
}
