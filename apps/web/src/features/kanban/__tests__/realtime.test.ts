import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { keys } from '../../../lib/query/keys';
import { columnKeyOf, EMPTY_COLUMN } from '../board';
import { arrivalsKey, columnPrefix, kanbanPageQuery, type BoardQuery } from '../queries';
import { BoardRefresher } from '../refresh';
import {
  KanbanRealtimeHandler,
  KANBAN_ADDED_BATCH_MS,
  type FetchBoardRecords,
} from '../use-kanban-realtime';

import type { FieldDto, RecordDto, RecordListResponse } from '@cellhive/contracts';

const NOW = '2026-09-24T00:00:00.000Z';
const TABLE = 'tbl_Tickets000000001';
const STATUS = 'fld_Status0000000001';
const NEW = 'opt_New0000000000001';
const DOING = 'opt_Doing00000000001';

const field = {
  id: STATUS,
  table_id: TABLE,
  name: 'Status',
  type: 'select',
  options: {
    multiple: false,
    options: [
      { id: NEW, name: 'New' },
      { id: DOING, name: 'Doing' },
    ],
  },
  is_primary: false,
  required: false,
  unique_values: false,
  description: null,
  position: 1,
  created_at: NOW,
  updated_at: NOW,
} as FieldDto;

const QUERY: BoardQuery = {
  tableId: TABLE,
  viewId: 'viw_Board00000000001',
  permissionVersion: 3,
  groupFieldId: STATUS,
  kind: 'select',
  sort: [],
};

function record(id: string, status: string | null, version = 1): RecordDto {
  return {
    id: id as RecordDto['id'],
    created_at: NOW,
    updated_at: NOW,
    version,
    fields: { [STATUS]: status },
  };
}

const columnOfValue = (value: unknown) => columnKeyOf(field, 'select', value);
const columnOf = (item: RecordDto) => columnOfValue(item.fields[STATUS]);

function setup(
  fetchRecords: FetchBoardRecords = () => Promise.resolve([]),
  shiftCounts?: (from: string, to: string) => void,
) {
  const queryClient = new QueryClient();
  const refresher = new BoardRefresher(queryClient, () => QUERY, 0);
  const counts = vi.spyOn(refresher, 'counts');
  const columns = vi.spyOn(refresher, 'columns');
  const all = vi.spyOn(refresher, 'all');
  const onRecordsGone = vi.fn();
  const handler = new KanbanRealtimeHandler({
    queryClient,
    query: () => QUERY,
    refresher,
    columnOf,
    columnOfValue,
    fetchRecords,
    shiftCounts,
    onRecordsGone,
  });
  const page = (column: string, records: RecordDto[]) => {
    queryClient.setQueryData<RecordListResponse>(kanbanPageQuery(QUERY, column, 0).queryKey, {
      records,
      offset: 0,
      limit: 50,
    });
  };
  const arrivals = () =>
    queryClient.getQueryData<RecordListResponse>(arrivalsKey(QUERY))?.records.map((r) => r.id) ??
    [];
  return { queryClient, refresher, counts, columns, all, onRecordsGone, handler, page, arrivals };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('KanbanRealtimeHandler', () => {
  it('moves a card another tab moved: merged, pinned, the column it left refreshed', () => {
    const { handler, page, queryClient, columns, arrivals } = setup();
    page(NEW, [record('rec_1', 'New')]);
    handler.handle({
      type: 'record.updated',
      channel: `table:${TABLE}`,
      record_id: 'rec_1',
      version: 2,
      fields: { [STATUS]: 'Doing' },
      actor_id: 'usr_Other00000000001',
      event_id: 'evt_A000000000000001',
    } as never);
    const cached = queryClient.getQueryData<RecordListResponse>(
      kanbanPageQuery(QUERY, NEW, 0).queryKey,
    );
    expect(cached?.records[0]).toMatchObject({ version: 2, fields: { [STATUS]: 'Doing' } });
    expect(arrivals()).toEqual(['rec_1']);
    expect(columns).toHaveBeenCalledWith([NEW]);
  });

  it('only refreshes the counts when its own write comes back or another field changed', () => {
    const { handler, page, counts, columns, arrivals } = setup();
    page(DOING, [record('rec_1', 'Doing', 2)]);
    handler.handle({
      type: 'record.updated',
      channel: `table:${TABLE}`,
      record_id: 'rec_1',
      version: 2,
      fields: { [STATUS]: 'Doing' },
      actor_id: null,
      event_id: 'evt_A000000000000001',
    } as never);
    expect(counts).toHaveBeenCalled();
    expect(columns).not.toHaveBeenCalled();
    expect(arrivals()).toEqual([]);
    counts.mockClear();
    handler.handle({
      type: 'record.updated',
      channel: `table:${TABLE}`,
      record_id: 'rec_1',
      version: 3,
      fields: { fld_Notes00000000001: 'x' },
      actor_id: null,
      event_id: 'evt_B000000000000001',
    } as never);
    expect(counts).not.toHaveBeenCalled();
  });

  it('reloads the target column for a record not on the board', () => {
    const { handler, columns } = setup();
    handler.handle({
      type: 'record.updated',
      channel: `table:${TABLE}`,
      record_id: 'rec_9',
      version: 4,
      fields: { [STATUS]: null },
      actor_id: null,
      event_id: 'evt_A000000000000001',
    } as never);
    expect(columns).toHaveBeenCalledWith([EMPTY_COLUMN]);
  });

  it('drops deleted cards and reloads their columns', () => {
    const { handler, page, queryClient, columns, onRecordsGone } = setup();
    page(NEW, [record('rec_1', 'New'), record('rec_2', 'New')]);
    handler.handle({
      type: 'record.deleted',
      channel: `table:${TABLE}`,
      record_ids: ['rec_1'],
    } as never);
    expect(
      queryClient
        .getQueryData<RecordListResponse>(kanbanPageQuery(QUERY, NEW, 0).queryKey)
        ?.records.map((r) => r.id),
    ).toEqual(['rec_2']);
    expect(columns).toHaveBeenCalledWith([NEW]);
    expect(onRecordsGone).toHaveBeenCalledWith(['rec_1']);
  });

  it('looks up created records through the view and shows the new ones on top', async () => {
    const fetchRecords = vi.fn((ids: readonly string[]) =>
      Promise.resolve(ids.map((id) => record(id, 'New'))),
    );
    const { handler, arrivals, counts } = setup(fetchRecords);
    handler.handle({
      type: 'record.created',
      channel: `table:${TABLE}`,
      record_id: 'rec_5',
      version: 1,
      fields: {},
      actor_id: null,
      event_id: 'evt_A000000000000001',
    } as never);
    handler.handle({
      type: 'record.added',
      channel: `table:${TABLE}`,
      record_id: 'rec_6',
    } as never);
    await vi.advanceTimersByTimeAsync(KANBAN_ADDED_BATCH_MS);
    expect(fetchRecords).toHaveBeenCalledWith(['rec_5', 'rec_6']);
    expect(arrivals()).toEqual(['rec_5', 'rec_6']);
    expect(counts).toHaveBeenCalled();
  });

  it('refetches everything on a batch change', () => {
    const { handler, all } = setup();
    handler.handle({
      type: 'record.batch',
      channel: `table:${TABLE}`,
      actor_id: null,
      count: 200,
      ops: { created: 0, updated: 200, added: 0, removed_from_view: 0, deleted: 0, restored: 0 },
    } as never);
    expect(all).toHaveBeenCalled();
  });
});

describe('BoardRefresher', () => {
  it('refetches the counts and the named columns once', async () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const refresher = new BoardRefresher(queryClient, () => QUERY, 50);
    refresher.columns([NEW]);
    refresher.columns([NEW, null]);
    refresher.counts();
    expect(invalidate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
      keys.groupCountLists(TABLE),
      columnPrefix(QUERY, NEW),
    ]);
  });

  it('keeps working after an effect cleanup ran and the effect ran again (StrictMode)', async () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const refresher = new BoardRefresher(queryClient, () => QUERY, 10);
    refresher.dispose();
    refresher.resume();
    refresher.counts();
    await vi.advanceTimersByTimeAsync(10);
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
      keys.groupCountLists(TABLE),
    ]);
  });
});

describe('counts of cards moved by someone else (T320 QA: stale counts)', () => {
  it('shift at once between the two columns, then refetch', () => {
    const shift = vi.fn();
    const { handler, page, counts } = setup(undefined, shift);
    page(NEW, [record('rec_1', 'New')]);
    handler.handle({
      type: 'record.updated',
      channel: `table:${TABLE}`,
      record_id: 'rec_1',
      version: 2,
      fields: { [STATUS]: 'Doing' },
      actor_id: 'usr_Other00000000001',
      event_id: 'evt_A000000000000001',
    } as never);
    expect(shift).toHaveBeenCalledWith(NEW, DOING);
    expect(counts).toHaveBeenCalled();
  });

  it('do not shift for the echo of our own move (already shifted)', () => {
    const shift = vi.fn();
    const { handler, page, counts } = setup(undefined, shift);
    page(NEW, [record('rec_1', 'Doing', 2)]);
    handler.handle({
      type: 'record.updated',
      channel: `table:${TABLE}`,
      record_id: 'rec_1',
      version: 2,
      fields: { [STATUS]: 'Doing' },
      actor_id: 'usr_Me0000000000001',
      event_id: 'evt_A000000000000002',
    } as never);
    expect(shift).not.toHaveBeenCalled();
    expect(counts).toHaveBeenCalled();
  });
});
