import {
  MAX_QUERY_IDS,
  type Id,
  type RecordDto,
  type RecordListResponse,
} from '@cellhive/contracts';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef } from 'react';

import { api } from '../../lib/api';
import { devWarn } from '../../lib/dev-log';
import { IdBatcher } from '../../lib/realtime/batch';
import { useTableChannel } from '../../lib/realtime/channels';
import { applyRecordPatch } from '../../lib/records/realtime-merge';
import { cachedRecord } from '../../lib/records/record-sync';

import { arrivalsKey, dropBoardRecords, pinArrivals, type BoardQuery } from './queries';

import type { BoardRefresher } from './refresh';
import type { ChannelMessage } from '../../lib/realtime/socket';

/** `record.created` / `record.added` ids are collected this long before one lookup. */
export const KANBAN_ADDED_BATCH_MS = 100;

export type FetchBoardRecords = (ids: readonly string[]) => Promise<readonly RecordDto[]>;

export interface KanbanRealtimeContext {
  readonly queryClient: QueryClient;
  readonly query: () => BoardQuery;
  readonly refresher: BoardRefresher;
  /** Column of a record by its group value, and of a raw group value. */
  readonly columnOf: (record: RecordDto) => string;
  readonly columnOfValue: (value: unknown) => string;
  readonly fetchRecords: FetchBoardRecords;
  /**
   * Moves one record from column `from` to column `to` in the cached group
   * counts at once (the refetch that follows corrects them).
   */
  readonly shiftCounts?: ((from: string, to: string) => void) | undefined;
  /** Records gone from the board (the open panel closes). */
  readonly onRecordsGone: (recordIds: readonly string[]) => void;
}

/**
 * The record messages of `table:{id}` on a kanban board (FRONTEND §5, T314),
 * subscribed with the board's view (T313: messages follow its filter):
 * - `record.updated` → merged into every cached copy by version (pending
 *   cells kept); a new group value moves the card to its column at once
 *   (it stays there as an arrival) and refreshes the counts and the column
 *   it left;
 * - `record.created` / `record.added` → looked up through the view
 *   (`ids`, 100 ms batches) and shown at the top of their column;
 * - `record.removed_from_view` / `record.deleted` → cards dropped, counts
 *   refreshed;
 * - `record.restored`, `record.batch`, reconnect → every loaded page, the
 *   counts and the arrivals fetched again.
 */
export class KanbanRealtimeHandler {
  readonly #context: KanbanRealtimeContext;
  readonly #added: IdBatcher;
  #disposed = false;

  constructor(context: KanbanRealtimeContext) {
    this.#context = context;
    this.#added = new IdBatcher({
      delayMs: KANBAN_ADDED_BATCH_MS,
      max: MAX_QUERY_IDS,
      flush: (ids) => {
        void this.#lookup(ids, false);
      },
    });
  }

  handle(message: ChannelMessage): void {
    if (this.#disposed) return;
    const { queryClient, refresher } = this.#context;
    const query = this.#context.query();
    switch (message.type) {
      case 'record.updated': {
        const before = cachedRecord(queryClient, query.tableId, message.record_id);
        applyRecordPatch(queryClient, query.tableId, message.record_id, {
          fields: message.fields,
          version: message.version,
          recomputed: message.event_id === null,
        });
        const fields: Readonly<Record<string, unknown>> = message.fields;
        if (!Object.hasOwn(fields, query.groupFieldId)) return;
        const to = this.#context.columnOfValue(fields[query.groupFieldId] ?? null);
        const after = cachedRecord(queryClient, query.tableId, message.record_id);
        if (before === undefined || after === undefined) {
          // Not on the board: it may now belong to a loaded column.
          refresher.columns([to]);
          return;
        }
        const from = this.#context.columnOf(before);
        const moved = this.#context.columnOf(after);
        if (from === moved) {
          // Our own write coming back, or nothing moved: only the counts may be stale.
          refresher.counts();
          return;
        }
        pinArrivals(queryClient, query, [after]);
        // Someone else moved the card: its columns' counts follow at once, then refetch.
        this.#context.shiftCounts?.(from, moved);
        refresher.columns([from]);
        return;
      }
      case 'record.created':
      case 'record.added':
        this.#added.add([message.record_id]);
        return;
      case 'record.removed_from_view':
        this.#remove([message.record_id]);
        return;
      case 'record.deleted':
        this.#remove(message.record_ids);
        return;
      case 'record.restored':
      case 'record.batch':
        this.resync();
        return;
      default:
        return;
    }
  }

  /** Everything shown is fetched again (batch change, reconnect). */
  resync(): void {
    if (this.#disposed) return;
    this.#added.clear();
    this.#context.refresher.all();
    const query = this.#context.query();
    const arrivals =
      this.#context.queryClient.getQueryData<RecordListResponse>(arrivalsKey(query))?.records ?? [];
    if (arrivals.length > 0) {
      void this.#lookup(
        arrivals.slice(0, MAX_QUERY_IDS).map((record) => record.id),
        true,
      );
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#added.dispose();
  }

  #remove(recordIds: readonly string[]): void {
    const { queryClient, refresher } = this.#context;
    const query = this.#context.query();
    const columns = recordIds.flatMap((recordId) => {
      const record = cachedRecord(queryClient, query.tableId, recordId);
      return record === undefined ? [] : [this.#context.columnOf(record)];
    });
    this.#added.delete(recordIds);
    dropBoardRecords(queryClient, query.tableId, recordIds);
    // The pages after the removed cards shift up: reload the columns they were in.
    refresher.columns(columns);
    this.#context.onRecordsGone(recordIds);
  }

  /**
   * Fetches records through the view. `replace`: the arrivals are
   * refreshed (a record no longer in the view leaves them); otherwise new
   * records not on the board yet become arrivals.
   */
  async #lookup(ids: readonly string[], replace: boolean): Promise<void> {
    const { queryClient, refresher } = this.#context;
    let records: readonly RecordDto[];
    try {
      records = await this.#context.fetchRecords(ids);
    } catch (error) {
      // Best effort: the next refresh (reconnect, a move) brings them.
      devWarn('kanban: cannot fetch records', error);
      return;
    }
    if (this.#disposed) return;
    const query = this.#context.query();
    if (replace) {
      const found = new Set<string>(records.map((record) => record.id));
      const missing = ids.filter((id) => !found.has(id));
      dropBoardRecords(queryClient, query.tableId, missing);
      pinArrivals(queryClient, query, records);
      return;
    }
    const fresh = records.filter(
      (record) => cachedRecord(queryClient, query.tableId, record.id) === undefined,
    );
    pinArrivals(queryClient, query, fresh);
    refresher.counts();
  }
}

export interface KanbanRealtimeOptions {
  readonly query: BoardQuery;
  readonly refresher: BoardRefresher;
  readonly columnOf: (record: RecordDto) => string;
  readonly columnOfValue: (value: unknown) => string;
  readonly shiftCounts?: ((from: string, to: string) => void) | undefined;
  readonly onRecordsGone: (recordIds: readonly string[]) => void;
}

/** Subscribes the board to `table:{id}` (FRONTEND §5). */
export function useKanbanRealtime({
  query,
  refresher,
  columnOf,
  columnOfValue,
  shiftCounts,
  onRecordsGone,
}: KanbanRealtimeOptions): void {
  const queryClient = useQueryClient();
  const latest = useRef({ query, columnOf, columnOfValue, shiftCounts, onRecordsGone });
  useEffect(() => {
    latest.current = { query, columnOf, columnOfValue, shiftCounts, onRecordsGone };
  });
  const handler = useRef<KanbanRealtimeHandler | null>(null);
  useEffect(() => {
    const current = new KanbanRealtimeHandler({
      queryClient,
      refresher,
      query: () => latest.current.query,
      columnOf: (record) => latest.current.columnOf(record),
      columnOfValue: (value) => latest.current.columnOfValue(value),
      shiftCounts: (from, to) => {
        latest.current.shiftCounts?.(from, to);
      },
      onRecordsGone: (recordIds) => {
        latest.current.onRecordsGone(recordIds);
      },
      fetchRecords: async (ids) => {
        const board = latest.current.query;
        const response = await api.records.query(board.tableId, {
          view_id: board.viewId,
          ids: ids.map((id) => id as `rec_${string}`),
          offset: 0,
          limit: ids.length,
          include_total: false,
        });
        return response.records;
      },
    });
    handler.current = current;
    return () => {
      current.dispose();
      if (handler.current === current) handler.current = null;
    };
  }, [queryClient, refresher]);
  // Record messages follow the board's view (T313): cards entering or leaving
  // its filter — conditions hidden from the user included — arrive as
  // `record.added` / `record.removed_from_view`.
  const view = useMemo(() => ({ id: query.viewId as Id<'viw'> }), [query.viewId]);
  useTableChannel(query.tableId, {
    view,
    onMessage: (message) => {
      handler.current?.handle(message);
    },
    onReconnect: () => {
      handler.current?.resync();
    },
  });
}
