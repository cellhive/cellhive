import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { keys, recordQueryHash } from '../../../lib/query/keys';
import { registerPendingCells } from '../../../lib/records/realtime-merge';
import { RecordBlockLoader, type FetchBlock } from '../blocks/block-loader';

import type { RecordListResponse } from '@cellhive/contracts';

const TABLE = 'tbl_Bench0000000001';
const NOW = '2026-09-24T00:00:00.000Z';

function recordId(row: number): `rec_${string}` {
  return `rec_${String(row).padStart(16, '0')}`;
}

/** A fake `POST …/records/query` over `rows` rows, answering when `release` is called. */
function fakeServer(rows: number, count: 'total' | 'estimate' = 'total', estimate = rows) {
  const calls: { index: number; signal: AbortSignal; release: () => void }[] = [];
  const fetchBlock: FetchBlock = (index, signal) =>
    new Promise<RecordListResponse>((resolve, reject) => {
      const offset = index * 200;
      const length = Math.max(0, Math.min(200, rows - offset));
      const page = {
        records: Array.from({ length }, (_, item) => ({
          id: recordId(offset + item),
          created_at: NOW,
          updated_at: NOW,
          version: 1,
          fields: { fld_Name000000000001: `Row ${String(offset + item)}` },
        })),
        offset,
        limit: 200,
      };
      signal.addEventListener('abort', () => {
        reject(new DOMException('Aborted', 'AbortError'));
      });
      const release = () => {
        if (index !== 0) resolve(page);
        else if (count === 'total') resolve({ ...page, total: rows });
        else resolve({ ...page, total_estimate: estimate });
      };
      calls.push({ index, signal, release });
    });
  return { calls, fetchBlock };
}

async function settle() {
  // Observer notifications are batched on a timer by TanStack Query.
  await vi.advanceTimersByTimeAsync(10);
}

async function releaseAll(calls: { release: () => void }[]) {
  for (const call of calls) call.release();
  await settle();
}

describe('RecordBlockLoader (FRONTEND §3.3)', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.useFakeTimers();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
    });
  });

  afterEach(() => {
    queryClient.clear();
    vi.useRealTimers();
  });

  function loader(fetchBlock: FetchBlock, maxBlocks?: number) {
    return new RecordBlockLoader({
      queryClient,
      tableId: TABLE,
      query: {},
      permissionVersion: 7,
      fetchBlock,
      ...(maxBlocks === undefined ? {} : { maxBlocks }),
    });
  }

  it('loads block 0 first, then the blocks around the viewport once the count is known', async () => {
    const server = fakeServer(200_000);
    const grid = loader(server.fetchBlock);
    grid.attach();
    expect(server.calls.map((call) => call.index)).toEqual([0]);
    expect(grid.getSnapshot().status).toBe('loading');

    await releaseAll(server.calls);
    expect(grid.getSnapshot()).toMatchObject({
      status: 'ready',
      rowCount: 200_000,
      estimated: false,
    });
    expect(grid.getRecord(0)?.id).toBe(recordId(0));
    // Block 1 is the +1 padding of the visible block 0.
    expect(server.calls.map((call) => call.index)).toEqual([0, 1]);
  });

  it('keys blocks by query hash and permission version', async () => {
    const server = fakeServer(500);
    const grid = loader(server.fetchBlock);
    grid.attach();
    await releaseAll(server.calls);
    const key = keys.recordBlock(TABLE, recordQueryHash({}), 7, 0);
    expect(queryClient.getQueryData(key)).toBeDefined();
    expect(queryClient.getQueryData(keys.recordBlock(TABLE, recordQueryHash({}), 8, 0))).toBe(
      undefined,
    );
  });

  it('a new permission version keeps the old rows, count and viewport until its blocks arrive', async () => {
    const server = fakeServer(200_000);
    const before = loader(server.fetchBlock);
    before.attach();
    await releaseAll(server.calls);
    before.setViewport({ firstRow: 1_000, lastRow: 1_030 });
    await releaseAll(server.calls);
    const shown = before.getRecord(1_010);
    expect(shown?.id).toBe(recordId(1_010));

    // Adding a field bumps `permission_version` (S2 QA: the grid blanked to
    // skeleton rows and jumped back to the top, eating keys typed meanwhile).
    const after = new RecordBlockLoader({
      queryClient,
      tableId: TABLE,
      query: {},
      permissionVersion: 8,
      fetchBlock: server.fetchBlock,
      previous: before,
    });
    before.detach();
    after.attach();
    expect(after.getSnapshot()).toMatchObject({ status: 'ready', rowCount: 200_000 });
    expect(after.getRecord(1_010)).toEqual(shown);
    const requested = server.calls.slice(-3).map((call) => call.index);
    expect(requested).toContain(5);
    await releaseAll(server.calls);
    expect(
      queryClient.getQueryData(keys.recordBlock(TABLE, recordQueryHash({}), 8, 5)),
    ).toBeDefined();
    expect(after.getRecord(1_010)?.id).toBe(recordId(1_010));
  });

  it('does not take over the rows of another query', async () => {
    const server = fakeServer(500);
    const before = loader(server.fetchBlock);
    before.attach();
    await releaseAll(server.calls);
    const sorted = new RecordBlockLoader({
      queryClient,
      tableId: TABLE,
      query: { sort: [{ field: 'fld_Name000000000001', direction: 'desc' }] },
      permissionVersion: 7,
      fetchBlock: server.fetchBlock,
      previous: before,
    });
    sorted.attach();
    expect(sorted.getSnapshot().status).toBe('loading');
    expect(sorted.getRecord(0)).toBeUndefined();
  });

  it('shows skeletons (undefined rows) for blocks not loaded yet', async () => {
    const server = fakeServer(200_000);
    const grid = loader(server.fetchBlock);
    grid.attach();
    await releaseAll(server.calls);
    grid.setViewport({ firstRow: 1_000, lastRow: 1_030 });
    expect(grid.getRecord(1_000)).toBeUndefined();
    await releaseAll(server.calls);
    expect(grid.getRecord(1_000)?.id).toBe(recordId(1_000));
    expect(grid.getRecord(1_199)?.id).toBe(recordId(1_199));
  });

  it('aborts fetches of blocks that leave the needed range (fast scroll)', async () => {
    const server = fakeServer(200_000);
    const grid = loader(server.fetchBlock);
    grid.attach();
    await releaseAll(server.calls);
    grid.setViewport({ firstRow: 300, lastRow: 330 });
    const pending = server.calls.filter((call) => call.index === 2);
    expect(pending).toHaveLength(1);
    // Scrolling on in small steps (no debounce): block 2 is no longer needed.
    for (const first of [500, 700, 900, 1_100])
      grid.setViewport({ firstRow: first, lastRow: first + 30 });
    expect(pending[0]?.signal.aborted).toBe(true);
    // Loaded blocks are not aborted.
    expect(server.calls.find((call) => call.index === 0)?.signal.aborted).toBe(false);
  });

  it('debounces while the scroll bar is dragged: only the final position is fetched', async () => {
    const server = fakeServer(200_000);
    const grid = loader(server.fetchBlock);
    grid.attach();
    await releaseAll(server.calls);
    const before = server.calls.length;
    for (let first = 0; first < 100_000; first += 5_000) {
      grid.setViewport({ firstRow: first, lastRow: first + 30 }, true);
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(server.calls.length).toBe(before);
    await vi.advanceTimersByTimeAsync(50);
    expect(server.calls.slice(before).map((call) => call.index)).toEqual([474, 476, 475]);
  });

  it('prefetches the next block in the scroll direction near a block edge', async () => {
    const server = fakeServer(200_000);
    const grid = loader(server.fetchBlock);
    grid.attach();
    await releaseAll(server.calls);
    grid.setViewport({ firstRow: 100, lastRow: 130 });
    grid.setViewport({ firstRow: 130, lastRow: 160 });
    expect(server.calls.map((call) => call.index)).toEqual([0, 1, 2]);
  });

  it('keeps at most 30 blocks, evicting the least recently used from the query cache', async () => {
    const server = fakeServer(200_000);
    const grid = loader(server.fetchBlock);
    grid.attach();
    await releaseAll(server.calls);
    for (let block = 0; block < 60; block += 1) {
      const first = block * 200 + 80;
      grid.setViewport({ firstRow: first, lastRow: first + 30 });
      await releaseAll(server.calls);
    }
    const cached = grid.cachedBlocks();
    expect(cached).toHaveLength(30);
    expect(cached).toContain(59);
    expect(cached).not.toContain(0);
    const hash = recordQueryHash({});
    expect(queryClient.getQueryData(keys.recordBlock(TABLE, hash, 7, 0))).toBeUndefined();
    expect(queryClient.getQueryData(keys.recordBlock(TABLE, hash, 7, 59))).toBeDefined();
    expect(grid.getRecord(0)).toBeUndefined();
  });

  it('uses total_estimate until the last block gives the exact count', async () => {
    const server = fakeServer(150_321, 'estimate', 150_000);
    const grid = loader(server.fetchBlock);
    grid.attach();
    await releaseAll(server.calls);
    expect(grid.getSnapshot()).toMatchObject({ rowCount: 150_000, estimated: true });

    // At the estimated end the table goes on: the loader follows the last
    // block (one more each time a full block arrives) until a short block
    // gives the exact count, without the user scrolling further.
    grid.setViewport({ firstRow: 149_970, lastRow: 149_999 });
    await vi.advanceTimersByTimeAsync(60);
    for (let round = 0; round < 5; round += 1) await releaseAll(server.calls);
    expect(grid.getSnapshot()).toMatchObject({ rowCount: 150_321, estimated: false });
    expect(grid.getRecord(150_320)?.id).toBe(recordId(150_320));
  });

  it('gets the exact count from an empty block after a full one', async () => {
    const server = fakeServer(150_200, 'estimate', 150_000);
    const grid = loader(server.fetchBlock);
    grid.attach();
    await releaseAll(server.calls);
    grid.setViewport({ firstRow: 149_970, lastRow: 149_999 });
    await vi.advanceTimersByTimeAsync(60);
    for (let round = 0; round < 5; round += 1) await releaseAll(server.calls);
    expect(grid.getSnapshot()).toMatchObject({ rowCount: 150_200, estimated: false });
  });

  it('gets the exact count when the empty block after the end arrives before the full last one', async () => {
    // An estimate above a table of exactly 1 000 full blocks (t202-perf, T319):
    // the viewport at the estimated end asks for blocks 999 (full) and 1 000
    // (empty); whichever answers first, the count ends exact.
    const server = fakeServer(200_000, 'estimate', 200_017);
    const grid = loader(server.fetchBlock);
    grid.attach();
    await releaseAll(server.calls);
    expect(grid.getSnapshot()).toMatchObject({ rowCount: 200_017, estimated: true });
    grid.setViewport({ firstRow: 199_990, lastRow: 200_016 });
    await vi.advanceTimersByTimeAsync(60);
    const pending = server.calls.filter((call) => call.index >= 999);
    expect(pending.map((call) => call.index).sort((a, b) => a - b)).toEqual([999, 1000]);
    await releaseAll([...pending].sort((a, b) => b.index - a.index));
    for (let round = 0; round < 3; round += 1) await releaseAll(server.calls);
    expect(grid.getSnapshot()).toMatchObject({ rowCount: 200_000, estimated: false });
    expect(grid.getRecord(199_999)?.id).toBe(recordId(199_999));
  });

  it('does not follow the end when the viewport is elsewhere', async () => {
    const server = fakeServer(150_321, 'estimate', 150_000);
    const grid = loader(server.fetchBlock);
    grid.attach();
    for (let round = 0; round < 3; round += 1) await releaseAll(server.calls);
    expect(server.calls.map((call) => call.index)).toEqual([0, 1]);
    expect(grid.getSnapshot()).toMatchObject({ rowCount: 150_000, estimated: true });
  });

  it('reports an error when block 0 fails, and retries on demand', async () => {
    let fail = true;
    const grid = loader((index) =>
      fail
        ? Promise.reject(new Error('network'))
        : Promise.resolve({ records: [], offset: index * 200, limit: 200, total: 0 }),
    );
    grid.attach();
    await settle();
    expect(grid.getSnapshot().status).toBe('error');
    fail = false;
    grid.retry();
    await settle();
    expect(grid.getSnapshot()).toMatchObject({ status: 'ready', rowCount: 0, error: null });
  });

  it('stops observing on detach and resumes from the cache on attach', async () => {
    const server = fakeServer(1_000);
    const grid = loader(server.fetchBlock);
    grid.attach();
    await releaseAll(server.calls);
    // Block 1 is requested once block 0 gave the count.
    await releaseAll(server.calls);
    expect(server.calls.map((call) => call.index)).toEqual([0, 1]);
    grid.detach();
    const calls = server.calls.length;
    grid.attach();
    await settle();
    expect(server.calls.length).toBe(calls);
    expect(grid.getRecord(0)?.id).toBe(recordId(0));
  });

  describe('edits (T203)', () => {
    it('finds and replaces a cached record; the grid sees a new object', async () => {
      const server = fakeServer(300);
      const grid = loader(server.fetchBlock);
      grid.attach();
      await releaseAll(server.calls);
      const before = grid.getRecord(5);
      expect(grid.findRecord(recordId(5))).toBe(before);
      expect(grid.findRecord('rec_nope')).toBeUndefined();
      const version = grid.getSnapshot().version;
      grid.updateRecord(recordId(5), (record) => ({
        ...record,
        fields: { ...record.fields, fld_Name000000000001: 'Changed' },
      }));
      await settle();
      expect(grid.getRecord(5)).not.toBe(before);
      expect(grid.getRecord(5)?.fields['fld_Name000000000001']).toBe('Changed');
      expect(grid.getSnapshot().version).toBeGreaterThan(version);
    });

    it('appends a created record as the last row and counts it', async () => {
      const server = fakeServer(150);
      const grid = loader(server.fetchBlock);
      grid.attach();
      await releaseAll(server.calls);
      const created = {
        id: recordId(9_999),
        created_at: NOW,
        updated_at: NOW,
        version: 1,
        fields: {},
      };
      expect(grid.insertAtEnd(created)).toBe(150);
      await settle();
      expect(grid.getSnapshot().rowCount).toBe(151);
      expect(grid.getRecord(150)?.id).toBe(recordId(9_999));
      // Block 0 keeps its `total` in step, so a later answer does not undo the count.
      const block0 = queryClient.getQueryData<RecordListResponse>(
        keys.recordBlock(TABLE, recordQueryHash({}), 7, 0),
      );
      expect(block0 !== undefined && 'total' in block0 ? block0.total : null).toBe(151);
    });

    it('with an estimated count, a created record reloads the blocks instead', async () => {
      const server = fakeServer(200_000, 'estimate');
      const grid = loader(server.fetchBlock);
      grid.attach();
      await releaseAll(server.calls);
      const calls = server.calls.length;
      expect(
        grid.insertAtEnd({
          id: recordId(1),
          created_at: NOW,
          updated_at: NOW,
          version: 1,
          fields: {},
        }),
      ).toBeNull();
      await settle();
      expect(server.calls.length).toBeGreaterThan(calls);
    });

    it('removed rows lower the count at once and refetch the blocks', async () => {
      const server = fakeServer(300);
      const grid = loader(server.fetchBlock);
      grid.attach();
      await releaseAll(server.calls);
      await releaseAll(server.calls);
      const calls = server.calls.length;
      grid.reload(2);
      expect(grid.getSnapshot().rowCount).toBe(298);
      await settle();
      expect(server.calls.length).toBeGreaterThan(calls);
    });
  });

  describe('bulk writes (T205)', () => {
    it('loadRows loads blocks off screen once and finds their records afterwards', async () => {
      const server = fakeServer(1_000);
      const grid = loader(server.fetchBlock);
      grid.attach();
      await releaseAll(server.calls);
      await releaseAll(server.calls);
      const before = server.calls.length;
      const rows = grid.loadRows(150, 650);
      await settle();
      await releaseAll(server.calls.slice(before));
      const loaded = await rows;
      expect(loaded).toHaveLength(501);
      expect(loaded[0]?.id).toBe(recordId(150));
      expect(loaded[500]?.id).toBe(recordId(650));
      // Blocks 0 and 1 were on screen: only 2 and 3 are fetched.
      expect(server.calls.slice(before).map((call) => call.index)).toEqual([2, 3]);
      expect(grid.findRecord(recordId(640))?.id).toBe(recordId(640));
      // Cached now: no new request.
      await grid.loadRows(600, 610);
      expect(server.calls).toHaveLength(before + 2);
    });

    it('updateRecords changes many cached records in one pass, also an open record query', async () => {
      const server = fakeServer(300);
      const grid = loader(server.fetchBlock);
      grid.attach();
      await releaseAll(server.calls);
      await releaseAll(server.calls);
      const panelKey = keys.record(TABLE, recordId(5));
      queryClient.setQueryData(panelKey, grid.getRecord(5));
      grid.updateRecords(
        new Map([
          [recordId(5), (row) => ({ ...row, version: 2 })],
          [recordId(250), (row) => ({ ...row, version: 3 })],
        ]),
      );
      expect(grid.findRecord(recordId(5))?.version).toBe(2);
      expect(grid.findRecord(recordId(250))?.version).toBe(3);
      expect(queryClient.getQueryData<{ version: number }>(panelKey)?.version).toBe(2);
    });

    it('insertManyAtEnd raises the exact count and reloads once', async () => {
      const server = fakeServer(300);
      const grid = loader(server.fetchBlock);
      grid.attach();
      await releaseAll(server.calls);
      await releaseAll(server.calls);
      const calls = server.calls.length;
      grid.insertManyAtEnd(40);
      expect(grid.getSnapshot().rowCount).toBe(340);
      await settle();
      expect(server.calls.length).toBeGreaterThan(calls);
    });
  });

  describe('realtime (T204, FRONTEND §5)', () => {
    const NAME = 'fld_Name000000000001';

    async function loaded(rows = 1_000) {
      const server = fakeServer(rows);
      const grid = loader(server.fetchBlock);
      grid.attach();
      await releaseAll(server.calls);
      await releaseAll(server.calls);
      return { server, grid };
    }

    it('merges a newer record.updated, drops an older one, keeps pending cells', async () => {
      const { grid } = await loaded();
      const id = recordId(3);
      expect(
        grid.applyRecordUpdate(id, { fields: { [NAME]: 'v2' }, version: 2, recomputed: false }),
      ).toBe(true);
      await settle();
      expect(grid.getRecord(3)).toMatchObject({ version: 2, fields: { [NAME]: 'v2' } });
      // Same or older version: already applied.
      expect(
        grid.applyRecordUpdate(id, { fields: { [NAME]: 'old' }, version: 2, recomputed: false }),
      ).toBe(false);
      expect(
        grid.applyRecordUpdate(id, { fields: { [NAME]: 'old' }, version: 1, recomputed: false }),
      ).toBe(false);
      // A system recomputation keeps the version: applied when not older.
      expect(
        grid.applyRecordUpdate(id, {
          fields: { fld_Auto000000000001: 7 },
          version: 2,
          recomputed: true,
        }),
      ).toBe(true);
      await settle();
      expect(grid.getRecord(3)?.fields).toMatchObject({ [NAME]: 'v2', fld_Auto000000000001: 7 });
      // The user's own write in flight is not overwritten.
      const unregister = registerPendingCells(
        TABLE,
        (record, field) => record === id && field === NAME,
      );
      grid.applyRecordUpdate(id, {
        fields: { [NAME]: 'theirs', fld_Other00000000001: 1 },
        version: 3,
        recomputed: false,
      });
      await settle();
      expect(grid.getRecord(3)).toMatchObject({
        version: 2,
        fields: { [NAME]: 'v2', fld_Other00000000001: 1 },
      });
      unregister();
      // Unknown records are ignored.
      expect(
        grid.applyRecordUpdate(recordId(900), { fields: {}, version: 9, recomputed: false }),
      ).toBe(false);
    });

    it('removes rows without holes, lowers the count and refetches the tail', async () => {
      const { server, grid } = await loaded();
      expect(grid.getSnapshot().rowCount).toBe(1_000);
      const before = server.calls.length;
      expect(grid.removeRecords([recordId(5), recordId(250)])).toBe(2);
      await settle();
      expect(grid.getSnapshot().rowCount).toBe(998);
      expect(grid.getRecord(4)?.id).toBe(recordId(4));
      expect(grid.getRecord(5)?.id).toBe(recordId(6));
      // Rows moved across the block edge.
      expect(grid.getRecord(199)?.id).toBe(recordId(200));
      expect(grid.getRecord(249)?.id).toBe(recordId(251));
      // Block 0 carries the new total, so its next answer agrees.
      const first = queryClient.getQueryData<RecordListResponse>(
        keys.recordBlock(TABLE, recordQueryHash({}), 7, 0),
      );
      expect(first !== undefined && 'total' in first ? first.total : null).toBe(998);
      // The last loaded block misses its tail: fetched again; block 0 too,
      // for the server's count (the local one is a guess).
      expect(
        server.calls
          .slice(before)
          .map((call) => call.index)
          .sort(),
      ).toEqual([0, 1]);
    });

    it('refetches when the removed record is not loaded', async () => {
      const { server, grid } = await loaded();
      const before = server.calls.length;
      expect(grid.removeRecords([recordId(900)])).toBe(0);
      await settle();
      expect(grid.getSnapshot().rowCount).toBe(1_000);
      expect(
        server.calls
          .slice(before)
          .map((call) => call.index)
          .sort(),
      ).toEqual([0, 1]);
    });

    it('counts created records in the pill until they are shown', async () => {
      const { server, grid } = await loaded(300);
      grid.noteNewRecord(recordId(10)); // already shown
      expect(grid.getSnapshot().newRows).toBe(0);
      grid.noteNewRecord('rec_New0000000000001');
      grid.noteNewRecord('rec_New0000000000001');
      grid.noteNewRecord('rec_New0000000000002');
      expect(grid.getSnapshot().newRows).toBe(2);
      const before = server.calls.length;
      grid.showNewRows();
      expect(grid.getSnapshot().newRows).toBe(0);
      await settle();
      expect(
        server.calls
          .slice(before)
          .map((call) => call.index)
          .sort(),
      ).toEqual([0, 1]);
    });

    it('leaveQuery drops shown rows and pill entries without refetching the others (T313)', async () => {
      const { server, grid } = await loaded(300);
      grid.noteNewRecord('rec_New0000000000001');
      expect(grid.hasRecord(recordId(10))).toBe(true);
      const before = server.calls.length;
      grid.leaveQuery(['rec_New0000000000001', 'rec_Out0000000000001']);
      expect(grid.getSnapshot().newRows).toBe(0);
      await settle();
      expect(server.calls.length).toBe(before);
      grid.leaveQuery([recordId(10)]);
      expect(grid.hasRecord(recordId(10))).toBe(false);
      expect(grid.getSnapshot().rowCount).toBe(299);
    });

    it('markStale offers a refresh until the rows are fetched again (T313)', async () => {
      const { grid } = await loaded(300);
      grid.markStale();
      expect(grid.getSnapshot()).toMatchObject({ stale: true, newRows: 0 });
      grid.showNewRows();
      expect(grid.getSnapshot().stale).toBe(false);
    });

    describe('record.batch (T303)', () => {
      /** A server whose rows change: `rows` records, values of `generation`. */
      function liveServer(state: { rows: number; generation: number }) {
        const indexes: number[] = [];
        const fetchBlock: FetchBlock = (index) => {
          indexes.push(index);
          const offset = index * 200;
          const length = Math.max(0, Math.min(200, state.rows - offset));
          const records = Array.from({ length }, (_, item) => ({
            id: recordId(offset + item),
            created_at: NOW,
            updated_at: NOW,
            version: state.generation,
            fields: { [NAME]: `g${String(state.generation)} ${String(offset + item)}` },
          }));
          const page = { records, offset, limit: 200 };
          return Promise.resolve(index === 0 ? { ...page, total: state.rows } : page);
        };
        return { indexes, fetchBlock };
      }

      it('refetches loaded blocks and the count, keeps the pill and pending cells', async () => {
        const state = { rows: 1_000, generation: 1 };
        const server = liveServer(state);
        const grid = loader(server.fetchBlock);
        grid.attach();
        await settle();
        await settle();
        expect(grid.getSnapshot().rowCount).toBe(1_000);
        grid.noteNewRecord('rec_New0000000000001');
        const mine = recordId(3);
        grid.updateRecord(mine, (record) => ({ ...record, fields: { [NAME]: 'typing' } }));
        const unregister = registerPendingCells(
          TABLE,
          (record, field) => record === mine && field === NAME,
        );
        state.rows = 900;
        state.generation = 2;
        const before = server.indexes.length;
        grid.resync();
        await settle();
        expect(server.indexes.slice(before).sort((x, y) => x - y)).toEqual([0, 1]);
        expect(grid.getSnapshot().rowCount).toBe(900);
        expect(grid.getSnapshot().newRows).toBe(1);
        expect(grid.getRecord(4)).toMatchObject({ version: 2, fields: { [NAME]: 'g2 4' } });
        // The cell being written keeps its value, and the record its version (409 still possible).
        expect(grid.getRecord(3)).toMatchObject({ version: 1, fields: { [NAME]: 'typing' } });
        unregister();
      });

      it('QA: a new row scrolled into view is shown and counted; deleting it restores the count', async () => {
        // sales1 opens Orders (1 667 rows); admin creates an order owned by sales1.
        const state = { rows: 1_667, generation: 1 };
        const server = liveServer(state);
        const grid = loader(server.fetchBlock);
        grid.attach();
        await settle();
        await settle();
        expect(grid.getSnapshot().rowCount).toBe(1_667);
        state.rows = 1_668;
        const created = recordId(1_667);
        grid.noteNewRecord(created);
        expect(grid.getSnapshot()).toMatchObject({ newRows: 1, rowCount: 1_667 });
        // Scrolled to the bottom: the last block brings the new record.
        grid.setViewport({ firstRow: 1_630, lastRow: 1_666 });
        await settle();
        await settle();
        expect(grid.getSnapshot()).toMatchObject({ newRows: 0, rowCount: 1_668 });
        expect(grid.getRecord(1_667)?.id).toBe(created);
        // Admin deletes it: the count goes back to the server's.
        state.rows = 1_667;
        grid.removeRecords([created]);
        await settle();
        await settle();
        expect(grid.getSnapshot().rowCount).toBe(1_667);
        expect(grid.getRecord(1_667)).toBeUndefined();
      });

      it('QA: deleting a record never loaded does not lower the count below the server total', async () => {
        const state = { rows: 1_667, generation: 1 };
        const server = liveServer(state);
        const grid = loader(server.fetchBlock);
        grid.attach();
        await settle();
        await settle();
        grid.noteNewRecord('rec_New0000000000001');
        grid.removeRecords(['rec_New0000000000001']);
        await settle();
        await settle();
        expect(grid.getSnapshot()).toMatchObject({ newRows: 0, rowCount: 1_667 });
        // A count gone wrong locally is put right by the server's total.
        grid.insertManyAtEnd(3);
        expect(grid.getSnapshot().rowCount).toBe(1_670);
        await settle();
        grid.removeRecords([recordId(10)]);
        await settle();
        await settle();
        expect(grid.getSnapshot().rowCount).toBe(1_667);
      });

      it("does not count this tab's own created records twice", async () => {
        const state = { rows: 1_000, generation: 1 };
        const server = liveServer(state);
        const grid = loader(server.fetchBlock);
        grid.attach();
        await settle();
        await settle();
        state.rows = 1_002;
        // The echo can come before or after the answer of the write.
        grid.noteNewRecord(recordId(1_000));
        grid.insertManyAtEnd(2, [recordId(1_000), recordId(1_001)]);
        grid.noteNewRecord(recordId(1_001));
        expect(grid.getSnapshot()).toMatchObject({ newRows: 0, rowCount: 1_002 });
        grid.setViewport({ firstRow: 960, lastRow: 1_001 });
        await settle();
        await settle();
        expect(grid.getSnapshot()).toMatchObject({ newRows: 0, rowCount: 1_002 });
        expect(grid.getRecord(1_001)?.id).toBe(recordId(1_001));
      });

      it('fetches block 0 for the count when it is not on screen', async () => {
        const state = { rows: 2_000, generation: 1 };
        const server = liveServer(state);
        const grid = loader(server.fetchBlock, 2);
        grid.attach();
        await settle();
        await settle();
        grid.setViewport({ firstRow: 1_500, lastRow: 1_530 });
        await settle();
        expect(grid.cachedBlocks()).not.toContain(0);
        state.rows = 1_990;
        const before = server.indexes.length;
        grid.resync();
        await settle();
        expect(server.indexes.slice(before)).toContain(0);
        expect(grid.getSnapshot().rowCount).toBe(1_990);
      });
    });

    it('refreshes fetched records it holds and counts the others as new', async () => {
      const { grid } = await loaded(300);
      grid.upsertRecords([
        { id: recordId(1), created_at: NOW, updated_at: NOW, version: 4, fields: { [NAME]: 'x' } },
        { id: 'rec_New0000000000003', created_at: NOW, updated_at: NOW, version: 1, fields: {} },
      ]);
      await settle();
      expect(grid.getRecord(1)).toMatchObject({ version: 4, fields: { [NAME]: 'x' } });
      expect(grid.getSnapshot().newRows).toBe(1);
    });
  });

  describe('grouped viewport plan (T312)', () => {
    function grouped(fetchBlock: FetchBlock) {
      return new RecordBlockLoader({
        queryClient,
        tableId: TABLE,
        query: {},
        permissionVersion: 7,
        fetchBlock,
        waitForViewport: true,
      });
    }

    it('loads nothing before the first viewport, then only the blocks of the ranges', async () => {
      const server = fakeServer(200_000);
      const grid = grouped(server.fetchBlock);
      grid.attach();
      expect(server.calls).toEqual([]);
      // Rows 0–9 shown, then a collapsed group, then rows from 150 000 (padding included).
      grid.setViewport({ firstRow: 0, lastRow: 150_010 }, false, {
        visible: [
          { firstRow: 0, lastRow: 9 },
          { firstRow: 150_000, lastRow: 150_010 },
        ],
        needed: [
          { firstRow: 0, lastRow: 250 },
          { firstRow: 150_000, lastRow: 150_300 },
        ],
      });
      expect(server.calls.map((call) => call.index).sort((a, b) => a - b)).toEqual([
        0, 1, 750, 751,
      ]);
      await releaseAll(server.calls);
      expect(grid.getRecord(150_000)?.id).toBe(recordId(150_000));
      expect(grid.cachedBlocks().sort((a, b) => a - b)).toEqual([0, 1, 750, 751]);
    });

    it('an empty plan (only collapsed headers on screen) loads nothing', () => {
      const server = fakeServer(1_000);
      const grid = grouped(server.fetchBlock);
      grid.attach();
      grid.setViewport({ firstRow: 0, lastRow: 0 }, false, { visible: [], needed: [] });
      expect(server.calls).toEqual([]);
    });

    it('a record created in grouped rows is never appended locally: the blocks reload', async () => {
      const server = fakeServer(10);
      const grid = grouped(server.fetchBlock);
      grid.setServerOrdered(true);
      grid.attach();
      grid.setViewport({ firstRow: 0, lastRow: 9 }, false, {
        visible: [{ firstRow: 0, lastRow: 9 }],
        needed: [{ firstRow: 0, lastRow: 9 }],
      });
      await releaseAll(server.calls);
      const row = grid.insertAtEnd({
        id: recordId(10),
        created_at: NOW,
        updated_at: NOW,
        version: 1,
        fields: {},
      });
      expect(row).toBeNull();
    });
  });
});
