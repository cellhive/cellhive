import type { OrgScope } from '../db/repository.js';

/**
 * Cursors of the shared time scan core (ADR-34 §1, BACKLOG T546). Each
 * consumer keeps its own table (automation: `meta.automation_time_cursors`
 * per automation; S5b date reminders: per field) behind this interface; the
 * core only needs the two moments below.
 */
export interface TimeScanCursor {
  /** End of the window already handled. */
  readonly scannedUntil: Date;
  /** When the consumer was (re)armed; `null` = no arming moment of its own. */
  readonly armedAt: Date | null;
}

/**
 * A consumer's cursor table. `lock` reads the cursor of `key` under a row
 * lock held until the transaction of `scope` ends (created at the arming
 * moment, else `now`, when missing); `advance` moves it to `until`, never
 * backwards, in the same transaction as whatever the window produced, so two
 * scans never handle one window twice and a stopped worker resumes where it
 * stopped.
 */
export interface TimeScanCursorStore<Key> {
  lock(scope: OrgScope, key: Key, now: Date): Promise<TimeScanCursor>;
  advance(scope: OrgScope, key: Key, until: Date): Promise<void>;
}

/** A scan window `(from, to]`, epoch milliseconds. */
export interface TimeScanWindow {
  readonly from: number;
  readonly to: number;
}

/**
 * The window of a cursor at `now`: `(max(scanned_until, armed_at), now]` —
 * only moments that pass **after** the consumer was armed count, and a
 * stopped worker resumes from where it stopped. `null` when empty. Pure.
 */
export function windowOf(cursor: TimeScanCursor, now: Date): TimeScanWindow | null {
  const until = cursor.scannedUntil.getTime();
  const from = Math.max(until, cursor.armedAt?.getTime() ?? until);
  const to = now.getTime();
  return to > from ? { from, to } : null;
}

/** Locks the cursor of `key` (transaction scope) and returns its window at `now`. */
export async function openWindow<Key>(
  store: TimeScanCursorStore<Key>,
  scope: OrgScope,
  key: Key,
  now: Date,
): Promise<TimeScanWindow | null> {
  return windowOf(await store.lock(scope, key, now), now);
}
