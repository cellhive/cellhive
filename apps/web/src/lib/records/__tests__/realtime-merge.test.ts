import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { keys } from '../../query/keys';
import { RecordEditController, type RecordWriteApi } from '../edit-controller';
import {
  applyRecordPatch,
  isCellPending,
  keepPendingCells,
  registerPendingCells,
} from '../realtime-merge';

import type { RecordDto, RecordListResponse } from '@cellhive/contracts';

const TABLE = 'tbl_Orders0000000001';
const R1 = 'rec_A000000000000001';
const AMOUNT = 'fld_Amount0000000001';
const TITLE = 'fld_Title00000000001';
const NOW = '2026-09-24T00:00:00.000Z';

function record(version: number, fields: Record<string, unknown>): RecordDto {
  return { id: R1, created_at: NOW, updated_at: NOW, version, fields };
}

let queryClient = new QueryClient();

afterEach(() => {
  queryClient.clear();
  queryClient = new QueryClient();
});

function seed() {
  queryClient.setQueryData(keys.record(TABLE, R1), record(1, { [AMOUNT]: 1, [TITLE]: 'a' }));
  const block: RecordListResponse = {
    records: [record(1, { [AMOUNT]: 1, [TITLE]: 'a' })],
    total: 1,
    offset: 0,
    limit: 200,
  };
  queryClient.setQueryData(keys.recordBlock(TABLE, '{}', 1, 0), block);
}

function copies() {
  return [
    queryClient.getQueryData<RecordDto>(keys.record(TABLE, R1)),
    queryClient.getQueryData<RecordListResponse>(keys.recordBlock(TABLE, '{}', 1, 0))?.records[0],
  ];
}

describe('applyRecordPatch (FRONTEND §5)', () => {
  it('updates the record panel query and the grid blocks alike', () => {
    seed();
    expect(
      applyRecordPatch(queryClient, TABLE, R1, {
        fields: { [AMOUNT]: 5 },
        version: 2,
        recomputed: false,
      }),
    ).toBe(true);
    for (const copy of copies()) {
      expect(copy).toMatchObject({ version: 2, fields: { [AMOUNT]: 5, [TITLE]: 'a' } });
    }
    expect(
      applyRecordPatch(queryClient, TABLE, R1, {
        fields: { [AMOUNT]: 0 },
        version: 2,
        recomputed: false,
      }),
    ).toBe(false);
  });

  it('keeps the pending cells of every edit flow of the table (grid and panel)', async () => {
    seed();
    const api = {
      update: vi.fn<RecordWriteApi['update']>(() => new Promise(() => undefined)),
      get: vi.fn<RecordWriteApi['get']>(),
      create: vi.fn<RecordWriteApi['create']>(),
      remove: vi.fn<RecordWriteApi['remove']>(),
      restore: vi.fn<RecordWriteApi['restore']>(),
    };
    const cache = {
      get: () => record(1, { [AMOUNT]: 1, [TITLE]: 'a' }),
      patch: vi.fn(),
      replace: vi.fn(),
      append: () => null,
      remove: vi.fn(),
    };
    const notify = { conflict: vi.fn(), denied: vi.fn(), notFound: vi.fn(), failed: vi.fn() };
    const panel = new RecordEditController({ tableId: TABLE, api, cache, notify });
    panel.attach();
    void panel.commit({ recordId: R1, fieldId: TITLE, value: 'mine' });
    await Promise.resolve();
    expect(isCellPending(TABLE, R1, TITLE)).toBe(true);
    applyRecordPatch(queryClient, TABLE, R1, {
      fields: { [TITLE]: 'theirs', [AMOUNT]: 7 },
      version: 2,
      recomputed: false,
    });
    for (const copy of copies()) {
      expect(copy).toMatchObject({ version: 1, fields: { [AMOUNT]: 7, [TITLE]: 'a' } });
    }
    panel.detach();
    expect(isCellPending(TABLE, R1, TITLE)).toBe(false);
  });

  it('registrations are per table and removable', () => {
    const off = registerPendingCells(TABLE, () => true);
    expect(isCellPending(TABLE, R1, TITLE)).toBe(true);
    expect(isCellPending('tbl_Other00000000001', R1, TITLE)).toBe(false);
    off();
    expect(isCellPending(TABLE, R1, TITLE)).toBe(false);
  });
});

describe('keepPendingCells (refetch after record.batch, T303)', () => {
  it('returns the fetched rows as they are when nothing is pending', () => {
    seed();
    const fetched = [record(4, { [AMOUNT]: 9, [TITLE]: 'theirs' })];
    expect(keepPendingCells(queryClient, TABLE, fetched)).toBe(fetched);
  });

  it('keeps the optimistic value of pending cells and the cached version', () => {
    seed();
    queryClient.setQueryData(keys.record(TABLE, R1), record(1, { [AMOUNT]: 1, [TITLE]: 'mine' }));
    const unregister = registerPendingCells(TABLE, (id, field) => id === R1 && field === TITLE);
    const other = { ...record(2, { [TITLE]: 'x' }), id: 'rec_A000000000000002' as const };
    const fetched = [record(4, { [AMOUNT]: 9, [TITLE]: 'theirs' }), other];
    expect(keepPendingCells(queryClient, TABLE, fetched)).toEqual([
      record(1, { [AMOUNT]: 9, [TITLE]: 'mine' }),
      other,
    ]);
    // Another table is not affected.
    expect(keepPendingCells(queryClient, 'tbl_Other00000000001', fetched)).toBe(fetched);
    unregister();
  });

  it('uses a grid block copy when no record query holds the record', () => {
    seed();
    queryClient.removeQueries({ queryKey: keys.record(TABLE, R1) });
    queryClient.setQueryData(keys.recordBlock(TABLE, '{}', 1, 0), {
      records: [record(1, { [AMOUNT]: 5, [TITLE]: 'a' })],
      total: 1,
      offset: 0,
      limit: 200,
    });
    const unregister = registerPendingCells(TABLE, (id, field) => id === R1 && field === AMOUNT);
    expect(
      keepPendingCells(queryClient, TABLE, [record(3, { [AMOUNT]: 7, [TITLE]: 'b' })]),
    ).toEqual([record(1, { [AMOUNT]: 5, [TITLE]: 'b' })]);
    unregister();
  });
});

describe('applyRecordPatch: colors of the color rules (T816)', () => {
  const VIEW = 'viw_Grid000000000001';
  const OTHER = 'viw_Other00000000001';
  const viewBlock = keys.recordBlock(TABLE, `{"view_id":"${VIEW}"}`, 1, 0);
  const otherBlock = keys.recordBlock(TABLE, `{"view_id":"${OTHER}"}`, 1, 0);
  const RED = { color: { row: 'clr_Red0000000000001' } } as RecordDto['meta'];

  function seedViews() {
    for (const key of [viewBlock, otherBlock]) {
      const block: RecordListResponse = {
        records: [record(2, { [AMOUNT]: 1 })],
        total: 1,
        offset: 0,
        limit: 200,
      };
      queryClient.setQueryData(key, block);
    }
    queryClient.setQueryData(keys.record(TABLE, R1), record(2, { [AMOUNT]: 1 }));
  }
  const first = (key: readonly unknown[]) =>
    queryClient.getQueryData<RecordListResponse>(key)?.records[0];

  it('colors the blocks of the subscribed view only, never the record panel', () => {
    seedViews();
    applyRecordPatch(queryClient, TABLE, R1, {
      fields: { [AMOUNT]: 5 },
      version: 3,
      recomputed: false,
      meta: RED,
      metaViewId: VIEW,
    });
    expect(first(viewBlock)).toMatchObject({ version: 3, meta: RED });
    expect(first(otherBlock)).toMatchObject({ version: 3, fields: { [AMOUNT]: 5 } });
    expect(first(otherBlock)?.meta).toBeUndefined();
    expect(queryClient.getQueryData<RecordDto>(keys.record(TABLE, R1))?.meta).toBeUndefined();
  });

  it('takes the colors of the echo of an own write (same version), not of an older one', () => {
    seedViews();
    applyRecordPatch(queryClient, TABLE, R1, {
      fields: { [AMOUNT]: 1 },
      version: 2,
      recomputed: false,
      meta: RED,
      metaViewId: VIEW,
    });
    expect(first(viewBlock)?.meta).toEqual(RED);
    applyRecordPatch(queryClient, TABLE, R1, {
      fields: {},
      version: 1,
      recomputed: false,
      meta: { color: {} },
      metaViewId: VIEW,
    });
    expect(first(viewBlock)?.meta).toEqual(RED);
  });
});
