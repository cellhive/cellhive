import { useSyncExternalStore } from 'react';

import type { ChannelMessage } from './socket';

/**
 * Field type conversions seen by this tab (T414, BACKLOG S4 design decision
 * #8): the `field.converting` messages of the `table:` and `base:` channels
 * (everyone with the base open who sees the field), one entry per field.
 * The grid shows a progress banner while a conversion runs, a result banner
 * once it ended; `dismiss` hides the latter. The field list (`conversion`
 * of the field, CONTRACTS §4.4) stays the truth for what is locked: this
 * store only adds the progress, the actor and the end.
 */

export type FieldConvertingMessage = Extract<ChannelMessage, { type: 'field.converting' }>;

export interface FieldConversionProgress {
  readonly fieldId: string;
  readonly jobId: string;
  readonly status: FieldConvertingMessage['status'];
  /** 0 → 1; never goes back for the same job (messages of two channels may cross). */
  readonly progress: number;
  readonly fromType: string;
  readonly toType: string;
  readonly actorId: string | null;
  readonly linkChange: FieldConvertingMessage['link_change'];
  /** When this tab heard of the end (`Date.now()`), `null` while running. */
  readonly endedAt: number | null;
  /** The result banner was closed. */
  readonly dismissed: boolean;
  /** When and at what progress this tab first heard of the job, and of the last progress. */
  readonly seenAt: number;
  readonly seenProgress: number;
  readonly updatedAt: number;
}

/**
 * Seconds left from the speed seen since this tab heard of the job (the
 * banner's "about N seconds left"); `null` until there is enough to tell.
 */
export function etaSeconds(entry: FieldConversionProgress | undefined): number | null {
  if (entry?.status !== 'running' || entry.progress < 0.05) return null;
  const done = entry.progress - entry.seenProgress;
  const elapsed = (entry.updatedAt - entry.seenAt) / 1000;
  if (done <= 0 || elapsed < 1) return null;
  return Math.max(1, Math.round((elapsed / done) * (1 - entry.progress)));
}

type Snapshot = ReadonlyMap<string, FieldConversionProgress>;

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

/** A `field.converting` message (from `table:` or `base:`; the same message may come twice). */
export function recordFieldConverting(
  message: FieldConvertingMessage,
  now: number = Date.now(),
): void {
  const current = entries.get(message.field_id);
  const sameJob = current?.jobId === message.job_id;
  // A message of a job that already ended here is an echo of the other channel.
  if (sameJob && current.status !== 'running' && message.status === 'running') return;
  const ended = message.status !== 'running';
  const next: FieldConversionProgress = {
    fieldId: message.field_id,
    jobId: message.job_id,
    status: message.status,
    progress: sameJob ? Math.max(current.progress, message.progress) : message.progress,
    fromType: message.from_type,
    toType: message.to_type,
    actorId: message.actor_id,
    linkChange: message.link_change,
    endedAt: ended ? (sameJob && current.endedAt !== null ? current.endedAt : now) : null,
    dismissed: sameJob && ended ? current.dismissed : false,
    seenAt: sameJob ? current.seenAt : now,
    seenProgress: sameJob ? current.seenProgress : message.progress,
    updatedAt: now,
  };
  if (
    current !== undefined &&
    sameJob &&
    current.status === next.status &&
    current.progress === next.progress
  ) {
    return;
  }
  const map = new Map(entries);
  map.set(message.field_id, next);
  emit(map);
}

/** The result banner of `fieldId` was closed (or its conversion was reverted). */
export function dismissFieldConversion(fieldId: string): void {
  const current = entries.get(fieldId);
  if (current === undefined || current.dismissed) return;
  const map = new Map(entries);
  map.set(fieldId, { ...current, dismissed: true });
  emit(map);
}

/** Forgets everything (sign-out, tests). */
export function resetFieldConversions(): void {
  emit(new Map());
}

/** The conversions this tab heard of, by field id. */
export function useFieldConversionProgress(): Snapshot {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Current entry of a field (tests, non-React readers). */
export function fieldConversionOf(fieldId: string): FieldConversionProgress | undefined {
  return entries.get(fieldId);
}
