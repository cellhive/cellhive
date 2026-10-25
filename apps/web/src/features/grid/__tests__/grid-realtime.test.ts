import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ADDED_BATCH_MS,
  GridRealtimeHandler,
  gridRealtimeScope,
  REMOVED_BATCH_MS,
  type FetchRecords,
  type GridRealtimeScope,
} from '../blocks/use-grid-realtime';

import type { ChannelMessage } from '../../../lib/realtime/socket';
import type { RecordCachePatcher } from '../blocks/block-loader';
import type { RecordDto } from '@cellhive/contracts';

const CHANNEL = 'table:tbl_T000000000000001';
const NOW = '2026-09-24T00:00:00.000Z';

function id(n: number): `rec_${string}` {
  return `rec_${String(n).padStart(16, '0')}`;
}

function patcher() {
  return {
    applyRecordUpdate: vi.fn(() => true),
    removeRecords: vi.fn(() => 0),
    noteNewRecord: vi.fn(),
    upsertRecords: vi.fn<(records: readonly RecordDto[]) => void>(),
    refetchVisible: vi.fn(),
    resync: vi.fn(),
    leaveQuery: vi.fn<(recordIds: readonly string[]) => void>(),
    markStale: vi.fn(),
    hasRecord: vi.fn((recordId: string) => recordId === id(1)),
  } satisfies RecordCachePatcher;
}

function added(n: number): ChannelMessage {
  return { type: 'record.added', channel: CHANNEL, record_id: id(n) };
}

function setup(scope?: GridRealtimeScope, matching?: (recordId: string) => boolean) {
  const cache = patcher();
  const fetchRecords = vi.fn<FetchRecords>((ids) =>
    Promise.resolve(
      ids
        .filter((recordId) => matching?.(recordId) ?? true)
        .map((recordId): RecordDto => ({
          id: recordId as `rec_${string}`,
          created_at: NOW,
          updated_at: NOW,
          version: 1,
          fields: {},
        })),
    ),
  );
  const gone = vi.fn();
  const handler = new GridRealtimeHandler(cache, fetchRecords, {
    onRecordsGone: gone,
    ...(scope === undefined ? {} : { scope }),
  });
  return { cache, fetchRecords, gone, handler };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GridRealtimeHandler (FRONTEND §5)', () => {
  it('merges record.updated by version; event_id null is a recomputation', () => {
    const { cache, handler } = setup();
    handler.handle({
      type: 'record.updated',
      channel: CHANNEL,
      record_id: id(1),
      version: 5,
      fields: { fld_A000000000000001: 1 },
      actor_id: 'usr_U000000000000001',
      event_id: 'evt_E000000000000001',
    });
    handler.handle({
      type: 'record.updated',
      channel: CHANNEL,
      record_id: id(1),
      version: 5,
      fields: { fld_N000000000000001: 3 },
      actor_id: null,
      event_id: null,
    });
    expect(cache.applyRecordUpdate.mock.calls).toEqual([
      [id(1), { fields: { fld_A000000000000001: 1 }, version: 5, recomputed: false }],
      [id(1), { fields: { fld_N000000000000001: 3 }, version: 5, recomputed: true }],
    ]);
  });

  it('counts record.created in the pill', () => {
    const { cache, handler } = setup();
    handler.handle({
      type: 'record.created',
      channel: CHANNEL,
      record_id: id(9),
      version: 1,
      fields: {},
      actor_id: null,
      event_id: 'evt_E000000000000001',
    });
    expect(cache.noteNewRecord).toHaveBeenCalledWith(id(9));
  });

  it('batches record.added for 100 ms into one lookup', async () => {
    const { cache, fetchRecords, handler } = setup();
    handler.handle(added(1));
    handler.handle(added(2));
    handler.handle(added(2));
    await vi.advanceTimersByTimeAsync(ADDED_BATCH_MS - 1);
    expect(fetchRecords).not.toHaveBeenCalled();
    handler.handle(added(3));
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchRecords.mock.calls).toEqual([[[id(1), id(2), id(3)]]]);
    expect(cache.upsertRecords).toHaveBeenCalledTimes(1);
    expect(cache.upsertRecords.mock.calls[0]?.[0].map((record) => record.id)).toEqual([
      id(1),
      id(2),
      id(3),
    ]);
  });

  it('sends at most 1 000 ids per lookup', async () => {
    const { fetchRecords, handler } = setup();
    for (let n = 0; n < 2_500; n += 1) handler.handle(added(n));
    await vi.advanceTimersByTimeAsync(ADDED_BATCH_MS);
    expect(fetchRecords.mock.calls.map(([ids]) => ids.length)).toEqual([1_000, 1_000, 500]);
  });

  it('does not look up a record removed before its batch left', async () => {
    const { fetchRecords, cache, handler } = setup();
    handler.handle(added(1));
    handler.handle(added(2));
    handler.handle({ type: 'record.removed_from_view', channel: CHANNEL, record_id: id(2) });
    await vi.advanceTimersByTimeAsync(ADDED_BATCH_MS);
    expect(fetchRecords.mock.calls).toEqual([[[id(1)]]]);
    expect(cache.removeRecords).toHaveBeenCalledWith([id(2)]);
  });

  it('removes rows of removed_from_view and deleted together, and tells the page', async () => {
    const { cache, gone, handler } = setup();
    handler.handle({ type: 'record.removed_from_view', channel: CHANNEL, record_id: id(1) });
    handler.handle({ type: 'record.deleted', channel: CHANNEL, record_ids: [id(2), id(3)] });
    expect(cache.removeRecords).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(REMOVED_BATCH_MS);
    expect(cache.removeRecords.mock.calls).toEqual([[[id(1), id(2), id(3)]]]);
    expect(gone).toHaveBeenCalledWith([id(1), id(2), id(3)]);
  });

  it('refetches on record.restored (rows keep the new-rows pill) and after a reconnect', async () => {
    const { cache, fetchRecords, handler } = setup();
    handler.handle({ type: 'record.restored', channel: CHANNEL, record_ids: [id(4)] });
    expect(cache.refetchVisible).toHaveBeenLastCalledWith(false);
    handler.handle(added(5));
    handler.reconnected();
    expect(cache.refetchVisible).toHaveBeenLastCalledWith();
    await vi.advanceTimersByTimeAsync(ADDED_BATCH_MS);
    // The refetch covers the pending lookups.
    expect(fetchRecords).not.toHaveBeenCalled();
  });

  it('resyncs on record.batch without per-record work (T303)', async () => {
    const { cache, fetchRecords, gone, handler } = setup();
    handler.handle(added(1));
    handler.handle({ type: 'record.deleted', channel: CHANNEL, record_ids: [id(2)] });
    handler.handle({
      type: 'record.batch',
      channel: CHANNEL,
      actor_id: 'usr_U000000000000001',
      count: 1_000,
      ops: { created: 0, updated: 1_000, added: 0, removed_from_view: 0, deleted: 0, restored: 0 },
    });
    expect(cache.resync).toHaveBeenCalledTimes(1);
    // The pill is left as it is; the refetch covers the pending lookups and removals.
    expect(cache.refetchVisible).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(ADDED_BATCH_MS);
    expect(fetchRecords).not.toHaveBeenCalled();
    expect(cache.removeRecords).not.toHaveBeenCalled();
    expect(cache.applyRecordUpdate).not.toHaveBeenCalled();
    expect(gone).not.toHaveBeenCalled();
  });

  it('ignores a message type it does not know', () => {
    const { cache, handler } = setup();
    handler.handle({ type: 'record.future', channel: CHANNEL } as unknown as ChannelMessage);
    expect(Object.values(cache).every((mock) => mock.mock.calls.length === 0)).toBe(true);
  });

  it('ignores everything once disposed', async () => {
    const { cache, fetchRecords, handler } = setup();
    handler.handle(added(1));
    handler.dispose();
    handler.handle(added(2));
    await vi.advanceTimersByTimeAsync(ADDED_BATCH_MS);
    expect(fetchRecords).not.toHaveBeenCalled();
    expect(cache.upsertRecords).not.toHaveBeenCalled();
  });
});

const TITLE = 'fld_T000000000000001';
const STATUS = 'fld_S000000000000001';
const AMOUNT = 'fld_A000000000000001';
const ME = 'usr_U000000000000001';
const OTHER = 'usr_U000000000000002';

function created(n: number): ChannelMessage {
  return {
    type: 'record.created',
    channel: CHANNEL,
    record_id: id(n),
    version: 1,
    fields: {},
    actor_id: OTHER,
    event_id: 'evt_E000000000000001',
  };
}

function updated(n: number, fields: Record<string, unknown>, actor = OTHER): ChannelMessage {
  return {
    type: 'record.updated',
    channel: CHANNEL,
    record_id: id(n),
    version: 7,
    fields,
    actor_id: actor,
    event_id: 'evt_E000000000000002',
  };
}

describe('gridRealtimeScope (T313)', () => {
  it('sends the view to the server and keeps the temporary filter and search on the client', () => {
    expect(gridRealtimeScope({ view_id: 'viw_V000000000000001' })).toEqual({
      view: { id: 'viw_V000000000000001' },
      scope: { narrowed: false, checkFields: new Set(), orderFields: new Set(), userId: null },
    });
    const temporary = gridRealtimeScope(
      {
        view_id: 'viw_V000000000000001',
        filter: { op: 'and', items: [{ field: STATUS, operator: 'is', value: 'x' }] },
        filter_mode: 'replace',
        sort: [{ field: AMOUNT, direction: 'desc' }],
        search: ' pos ',
      },
      { primaryFieldId: TITLE, group: [{ field: STATUS }], userId: ME },
    );
    expect(temporary.view).toEqual({ id: 'viw_V000000000000001', filter_mode: 'replace' });
    expect(temporary.scope).toEqual({
      narrowed: true,
      checkFields: new Set([STATUS, TITLE]),
      orderFields: new Set([AMOUNT, STATUS]),
      userId: ME,
    });
  });
});

describe('GridRealtimeHandler per view (T313)', () => {
  const narrowed: GridRealtimeScope = {
    narrowed: true,
    checkFields: new Set([STATUS]),
    orderFields: new Set([AMOUNT]),
    userId: ME,
  };

  it('counts record.created at once when the server scope is the whole query', () => {
    // The server only sends records created in the open view: no lookup.
    const { cache, fetchRecords, handler } = setup();
    handler.handle(created(9));
    expect(cache.noteNewRecord).toHaveBeenCalledWith(id(9));
    expect(fetchRecords).not.toHaveBeenCalled();
  });

  it('with a temporary filter, a new record reaches the pill only when it matches', async () => {
    const { cache, fetchRecords, handler } = setup(narrowed, (recordId) => recordId === id(3));
    handler.handle(created(2));
    handler.handle(created(3));
    expect(cache.noteNewRecord).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(ADDED_BATCH_MS);
    expect(fetchRecords.mock.calls).toEqual([[[id(2), id(3)]]]);
    expect(cache.upsertRecords.mock.calls[0]?.[0].map((record) => record.id)).toEqual([id(3)]);
  });

  it('checks a record again when a field of the temporary filter changes; gone rows leave', async () => {
    const { cache, fetchRecords, gone, handler } = setup(narrowed, () => false);
    handler.handle(updated(1, { [TITLE]: 'x' }));
    await vi.advanceTimersByTimeAsync(ADDED_BATCH_MS);
    expect(fetchRecords).not.toHaveBeenCalled();
    handler.handle(updated(1, { [STATUS]: 'Done' }));
    await vi.advanceTimersByTimeAsync(ADDED_BATCH_MS);
    expect(fetchRecords.mock.calls).toEqual([[[id(1)]]]);
    expect(cache.leaveQuery).toHaveBeenCalledWith([id(1)]);
    expect(gone).toHaveBeenCalledWith([id(1)]);
  });

  it('a record that came into the temporary filter is counted as new', async () => {
    const { cache, handler } = setup(narrowed, () => true);
    handler.handle(updated(5, { [STATUS]: 'New' }));
    await vi.advanceTimersByTimeAsync(ADDED_BATCH_MS);
    expect(cache.upsertRecords.mock.calls[0]?.[0].map((record) => record.id)).toEqual([id(5)]);
    expect(cache.leaveQuery).not.toHaveBeenCalled();
  });

  it("a sort key edited by someone else makes shown rows stale; one's own edit does not", () => {
    const { cache, handler } = setup(narrowed);
    handler.handle(updated(1, { [AMOUNT]: 3 }, ME));
    handler.handle(updated(2, { [AMOUNT]: 3 }));
    expect(cache.markStale).not.toHaveBeenCalled();
    handler.handle(updated(1, { [AMOUNT]: 4 }));
    expect(cache.markStale).toHaveBeenCalledTimes(1);
  });

  it('a failed check offers a refresh instead of a wrong count', async () => {
    const { cache, fetchRecords, handler } = setup(narrowed);
    fetchRecords.mockRejectedValueOnce(new Error('422'));
    handler.handle(created(4));
    await vi.advanceTimersByTimeAsync(ADDED_BATCH_MS);
    expect(cache.markStale).toHaveBeenCalled();
    expect(cache.noteNewRecord).not.toHaveBeenCalled();
    expect(cache.upsertRecords).not.toHaveBeenCalled();
  });
});
