import { keys } from '../../lib/query/keys';

import { columnPrefix, isKanbanKey, type BoardQuery } from './queries';

import type { QueryClient } from '@tanstack/react-query';

/** Changes arriving together (a move and its realtime echo) refresh once. */
export const REFRESH_DELAY_MS = 150;

/**
 * Collects what a change made stale — the group counts, some columns, or
 * everything shown — and refetches it once after {@link REFRESH_DELAY_MS}.
 * Only loaded pages are fetched again (TanStack Query refetches active
 * queries), so a long column is not reloaded from the start.
 */
export class BoardRefresher {
  readonly #queryClient: QueryClient;
  readonly #query: () => BoardQuery;
  readonly #delayMs: number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #counts = false;
  #all = false;
  readonly #columns = new Set<string>();
  #disposed = false;

  constructor(queryClient: QueryClient, query: () => BoardQuery, delayMs = REFRESH_DELAY_MS) {
    this.#queryClient = queryClient;
    this.#query = query;
    this.#delayMs = delayMs;
  }

  /** The counts of the columns. */
  counts(): void {
    this.#counts = true;
    this.#schedule();
  }

  /** The pages of some columns (and the counts: a column changed). */
  columns(columns: Iterable<string | null | undefined>): void {
    for (const column of columns) {
      if (typeof column === 'string') this.#columns.add(column);
    }
    this.counts();
  }

  /** Every loaded page and the counts (batch change, reconnect). */
  all(): void {
    this.#all = true;
    this.counts();
  }

  flush(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#disposed) return;
    const query = this.#query();
    const queryClient = this.#queryClient;
    if (this.#counts) {
      void queryClient.invalidateQueries({ queryKey: keys.groupCountLists(query.tableId) });
    }
    if (this.#all) {
      void queryClient.invalidateQueries({
        queryKey: keys.recordBlocks(query.tableId),
        predicate: (item) => isKanbanKey(item.queryKey),
      });
    } else {
      for (const column of this.#columns) {
        void queryClient.invalidateQueries({ queryKey: columnPrefix(query, column) });
      }
    }
    this.#counts = false;
    this.#all = false;
    this.#columns.clear();
  }

  /**
   * Works again after {@link dispose}: React (StrictMode, a remount with the
   * same memoized refresher) may run an effect's cleanup and then the effect
   * again, and a refresher disposed for good would leave the counts stale.
   */
  resume(): void {
    this.#disposed = false;
  }

  dispose(): void {
    this.#disposed = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #schedule(): void {
    if (this.#disposed || this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.flush();
    }, this.#delayMs);
  }
}
