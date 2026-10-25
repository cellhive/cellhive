import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { keys } from '../../query/keys';
import {
  applyBaseMessage,
  applyTableMessage,
  SCHEMA_REFETCH_JITTER_MS,
  SCHEMA_REFETCH_MS,
  useBaseChannel,
  useTableChannel,
} from '../channels';
import { RealtimeProvider } from '../context';
import { resetFieldConversions, type FieldConvertingMessage } from '../field-conversions';
import { expectOwnSchemaChange, resetOwnChanges } from '../own-changes';
import { RECORD_COUNT_REFRESH_MS } from '../record-counts';
import { RealtimeClient, type ChannelMessage, type SocketLike } from '../socket';

import type { ReactNode } from 'react';

const TABLE = 'tbl_T000000000000001';
const OTHER = 'tbl_T000000000000002';
const BASE = 'bse_B000000000000001';

let queryClient: QueryClient;

function seed() {
  const keysToSeed = [
    keys.base(BASE),
    keys.tables(BASE),
    keys.fields(TABLE),
    keys.tableMeta(TABLE),
    keys.recordBlock(TABLE, '{}', 1, 0),
    keys.recordTrash(TABLE),
    keys.fields(OTHER),
  ];
  for (const key of keysToSeed) queryClient.setQueryData(key, {});
  queryClient.setQueryData(keys.tables(BASE), { items: [{ id: TABLE }, { id: OTHER }] });
}

function stale(): string[] {
  return queryClient
    .getQueryCache()
    .getAll()
    .filter((query) => query.state.isInvalidated)
    .map((query) => query.queryKey.join('/'))
    .sort();
}

beforeEach(() => {
  queryClient = new QueryClient();
  seed();
});

afterEach(() => {
  queryClient.clear();
  resetOwnChanges();
});

function fieldChanged(action: 'created' | 'updated' | 'deleted' | 'restored' | 'converted') {
  applyTableMessage(queryClient, TABLE, {
    type: 'schema.changed',
    channel: `table:${TABLE}`,
    entity: 'field',
    entity_id: 'fld_F000000000000001',
    action,
  });
}

describe('query effects of realtime messages (FRONTEND §3.2, §5)', () => {
  it.each(['created', 'deleted', 'restored'] as const)(
    'schema.changed: field %s refetches the field list (the permission bump renews the blocks)',
    (action) => {
      queryClient.setQueryData(keys.record(TABLE, 'rec_R000000000000001'), {});
      fieldChanged(action);
      expect(stale()).toEqual(
        [`table/${TABLE}/fields`, `table/${TABLE}/record/rec_R000000000000001`].sort(),
      );
    },
  );

  it.each(['updated', 'converted'] as const)(
    'schema.changed: field %s also refetches the values (record blocks)',
    (action) => {
      fieldChanged(action);
      expect(stale()).toEqual([`table/${TABLE}/fields`, `table/${TABLE}/records/{}/1/0`].sort());
    },
  );

  it('schema.changed of a view invalidates the whole table', () => {
    applyTableMessage(queryClient, TABLE, {
      type: 'schema.changed',
      channel: `table:${TABLE}`,
      entity: 'view',
      entity_id: 'viw_V000000000000001',
      action: 'created',
    });
    expect(stale()).toEqual(
      [
        `table/${TABLE}/fields`,
        `table/${TABLE}/meta`,
        `table/${TABLE}/records/{}/1/0`,
        `table/${TABLE}/trash`,
      ].sort(),
    );
  });

  it("skips the messages of this tab's own schema change, once each", () => {
    expectOwnSchemaChange(TABLE, { schema: 1, permission: 1 });
    fieldChanged('created');
    applyBaseMessage(queryClient, BASE, { type: 'permission.changed', channel: `base:${BASE}` });
    expect(stale()).toEqual([]);
    // The next ones come from someone else.
    fieldChanged('created');
    expect(stale()).toEqual([`table/${TABLE}/fields`]);
  });

  it('forgets an announced change after a while (socket down, message never came)', () => {
    expectOwnSchemaChange(TABLE, { schema: 1, permission: 0 }, Date.now() - 60_000);
    fieldChanged('updated');
    expect(stale()).toContain(`table/${TABLE}/fields`);
  });

  it.each(['record.deleted', 'record.restored', 'record.purged'] as const)(
    '%s invalidates the trash',
    (type) => {
      applyTableMessage(queryClient, TABLE, {
        type,
        channel: `table:${TABLE}`,
        record_ids: ['rec_R000000000000001'],
      });
      expect(stale()).toEqual([`table/${TABLE}/trash`]);
    },
  );

  it('record.batch refetches open records, and the trash only after deletes or restores', () => {
    queryClient.setQueryData(keys.record(TABLE, 'rec_R000000000000001'), {});
    queryClient.setQueryData(keys.record(OTHER, 'rec_R000000000000002'), {});
    const batch = (deleted: number) => ({
      type: 'record.batch' as const,
      channel: `table:${TABLE}`,
      actor_id: null,
      count: 500,
      ops: {
        created: 0,
        updated: 500 - deleted,
        added: 0,
        removed_from_view: 0,
        deleted,
        restored: 0,
      },
    });
    applyTableMessage(queryClient, TABLE, batch(0));
    // Record blocks are the grid's job (`resync`).
    expect(stale()).toEqual([`table/${TABLE}/record/rec_R000000000000001`]);
    applyTableMessage(queryClient, TABLE, batch(5));
    expect(stale()).toEqual(
      [`table/${TABLE}/record/rec_R000000000000001`, `table/${TABLE}/trash`].sort(),
    );
  });

  it('permission.changed refetches the base and the schema of its tables', () => {
    applyBaseMessage(queryClient, BASE, { type: 'permission.changed', channel: `base:${BASE}` });
    expect(stale()).toEqual(
      [
        `base/${BASE}`,
        `base/${BASE}/tables`,
        `table/${TABLE}/fields`,
        `table/${TABLE}/meta`,
        `table/${TABLE}/trash`,
        `table/${OTHER}/fields`,
      ].sort(),
    );
  });

  describe('field.converting of a link conversion (T415)', () => {
    const LINK = 'fld_L000000000000001' as const;
    const TEXT = 'fld_X000000000000001' as const;
    const converting = (
      fieldId: `fld_${string}`,
      status: 'running' | 'succeeded' | 'failed',
      linkChange: 'to_two_way' | 'to_one_way' | 'to_single' | undefined,
    ): FieldConvertingMessage => {
      const message: FieldConvertingMessage = {
        type: 'field.converting',
        channel: `table:${TABLE}`,
        field_id: fieldId,
        job_id: 'job_J000000000000001',
        status,
        progress: status === 'running' ? 0.5 : 1,
        from_type: 'link',
        to_type: 'link',
        actor_id: null,
      };
      return linkChange === undefined ? message : { ...message, link_change: linkChange };
    };

    beforeEach(() => {
      queryClient.setQueryData(keys.fields(TABLE), {
        items: [
          { id: LINK, type: 'link', options: { link_table: OTHER } },
          { id: TEXT, type: 'text', options: {} },
        ],
      });
    });

    afterEach(() => {
      resetFieldConversions();
    });

    it.each(['to_two_way', 'to_one_way', 'to_single'] as const)(
      'once %s ends, the linked table refetches its fields (the reverse field changed there)',
      (change) => {
        applyTableMessage(queryClient, TABLE, converting(LINK, 'succeeded', change));
        expect(stale()).toEqual([`table/${OTHER}/fields`]);
      },
    );

    it('a failed one too (the reverse field may have been taken back)', () => {
      applyTableMessage(queryClient, TABLE, converting(LINK, 'failed', 'to_two_way'));
      expect(stale()).toEqual([`table/${OTHER}/fields`]);
    });

    it('a fetch of the linked fields still running (answered before the job committed) is sent again', async () => {
      const answers = [
        { items: [{ id: 'before' }] },
        { items: [{ id: 'before' }, { id: 'reverse' }] },
      ];
      const pending: ((value: unknown) => void)[] = [];
      const observer = new QueryObserver(queryClient, {
        queryKey: keys.fields(OTHER),
        queryFn: () =>
          new Promise((resolve) => {
            pending.push(resolve);
          }),
      });
      const unsubscribe = observer.subscribe(() => undefined);
      await vi.waitFor(() => {
        expect(pending).toHaveLength(1);
      });
      applyTableMessage(queryClient, TABLE, converting(LINK, 'succeeded', 'to_two_way'));
      await vi.waitFor(() => {
        expect(pending).toHaveLength(2);
      });
      pending[0]?.(answers[0]);
      pending[1]?.(answers[1]);
      await vi.waitFor(() => {
        expect(queryClient.getQueryData(keys.fields(OTHER))).toEqual(answers[1]);
      });
      unsubscribe();
    });

    it('not while it runs, nor for a conversion of the column type', () => {
      applyTableMessage(queryClient, TABLE, converting(LINK, 'running', 'to_two_way'));
      applyTableMessage(queryClient, TABLE, converting(TEXT, 'succeeded', undefined));
      expect(stale()).toEqual([]);
    });
  });

  it('schema.changed of a table on the base channel refreshes the table list', () => {
    applyBaseMessage(queryClient, BASE, {
      type: 'schema.changed',
      channel: `base:${BASE}`,
      entity: 'table',
      entity_id: OTHER,
      action: 'updated',
    });
    expect(stale()).toEqual([`base/${BASE}/tables`, `table/${OTHER}/fields`].sort());
  });
});

describe('bursts of schema messages (T470: table deleted with several tabs open)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refetches at once on the first message, once more after the burst', async () => {
    vi.useFakeTimers();
    const fetches = { fields: 0, tables: 0 };
    const fields = new QueryObserver(queryClient, {
      queryKey: keys.fields(TABLE),
      queryFn: () => {
        fetches.fields += 1;
        return {};
      },
      staleTime: Infinity,
    });
    const tables = new QueryObserver(queryClient, {
      queryKey: keys.tables(BASE),
      queryFn: () => {
        fetches.tables += 1;
        return { items: [{ id: TABLE }, { id: OTHER }] };
      },
      staleTime: Infinity,
    });
    const offFields = fields.subscribe(() => undefined);
    const offTables = tables.subscribe(() => undefined);
    // The messages of one table deletion.
    const deleted = {
      type: 'schema.changed' as const,
      channel: `base:${BASE}`,
      entity: 'table' as const,
      entity_id: OTHER,
      action: 'deleted' as const,
    };
    // The first message refetches at once (leading edge: the change shows fast).
    applyBaseMessage(queryClient, BASE, deleted);
    expect(stale()).toContain(`base/${BASE}/tables`);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetches).toEqual({ fields: 0, tables: 1 });
    // The rest of the burst, in separate tasks, only marks…
    applyBaseMessage(queryClient, BASE, { type: 'permission.changed', channel: `base:${BASE}` });
    await vi.advanceTimersByTimeAsync(10);
    fieldChanged('deleted');
    await vi.advanceTimersByTimeAsync(10);
    applyBaseMessage(queryClient, BASE, { type: 'permission.changed', channel: `base:${BASE}` });
    await vi.advanceTimersByTimeAsync(10);
    expect(fetches).toEqual({ fields: 0, tables: 1 });
    // …and the window ends with one refetch of what they marked.
    await vi.advanceTimersByTimeAsync(SCHEMA_REFETCH_MS + SCHEMA_REFETCH_JITTER_MS);
    expect(fetches).toEqual({ fields: 1, tables: 2 });
    // A lone change later: one refetch at once, none at the end of its window.
    applyBaseMessage(queryClient, BASE, { type: 'permission.changed', channel: `base:${BASE}` });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetches).toEqual({ fields: 2, tables: 3 });
    await vi.advanceTimersByTimeAsync(SCHEMA_REFETCH_MS + SCHEMA_REFETCH_JITTER_MS);
    expect(fetches).toEqual({ fields: 2, tables: 3 });
    offFields();
    offTables();
  });

  it('a fetch running when a message comes is sent again, not reused (its answer may predate the change)', async () => {
    vi.useFakeTimers();
    const pending: ((value: unknown) => void)[] = [];
    const records = new QueryObserver(queryClient, {
      queryKey: keys.recordBlock(TABLE, '{}', 1, 0),
      queryFn: () =>
        new Promise((resolve) => {
          pending.push(resolve);
        }),
      staleTime: Infinity,
    });
    const off = records.subscribe(() => undefined);
    // The formula saved by this tab: its mutation refetches the values…
    void queryClient.invalidateQueries({ queryKey: keys.recordBlock(TABLE, '{}', 1, 0) });
    await vi.advanceTimersByTimeAsync(0);
    expect(pending).toHaveLength(1);
    // …and the backfill ends (its `schema.changed`) before that fetch answers.
    fieldChanged('updated');
    await vi.advanceTimersByTimeAsync(0);
    expect(pending).toHaveLength(2);
    pending[0]?.({ values: 'before' });
    pending[1]?.({ values: 'after' });
    await vi.advanceTimersByTimeAsync(SCHEMA_REFETCH_MS + SCHEMA_REFETCH_JITTER_MS);
    expect(queryClient.getQueryData(keys.recordBlock(TABLE, '{}', 1, 0))).toEqual({
      values: 'after',
    });
    expect(pending).toHaveLength(2);
    off();
  });

  it('a message of the same burst during the leading fetch reuses it (one read per query, T291)', async () => {
    vi.useFakeTimers();
    const pending: ((value: unknown) => void)[] = [];
    const fields = new QueryObserver(queryClient, {
      queryKey: keys.fields(TABLE),
      queryFn: () =>
        new Promise((resolve) => {
          pending.push(resolve);
        }),
      staleTime: Infinity,
    });
    const off = fields.subscribe(() => undefined);
    // A field created in another tab: `schema.changed`, then `permission.changed`.
    fieldChanged('created');
    await vi.advanceTimersByTimeAsync(0);
    expect(pending).toHaveLength(1);
    applyBaseMessage(queryClient, BASE, { type: 'permission.changed', channel: `base:${BASE}` });
    await vi.advanceTimersByTimeAsync(SCHEMA_REFETCH_MS + SCHEMA_REFETCH_JITTER_MS);
    pending[0]?.({ items: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(pending).toHaveLength(1);
    off();
  });
});

describe('useTableChannel', () => {
  it('holds table:{id} while mounted and forwards messages', () => {
    const sent: unknown[] = [];
    const socket: SocketLike = {
      readyState: 1,
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send: (data) => sent.push(JSON.parse(data)),
      close: vi.fn(),
    };
    const client = new RealtimeClient({
      createSocket: () => socket,
      onStatus: () => undefined,
      watchNetwork: false,
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <RealtimeProvider client={client}>{children}</RealtimeProvider>
      </QueryClientProvider>
    );
    const onMessage = vi.fn();
    const first = renderHook(
      () => {
        useTableChannel(TABLE, { onMessage });
      },
      { wrapper },
    );
    const second = renderHook(
      () => {
        useTableChannel(TABLE);
      },
      { wrapper },
    );
    expect(client.channels()).toEqual([`table:${TABLE}`]);
    socket.onmessage?.({
      data: JSON.stringify({
        type: 'record.deleted',
        channel: `table:${TABLE}`,
        record_ids: ['rec_R000000000000001'],
      }),
    });
    expect(onMessage).toHaveBeenCalledTimes(1);
    first.unmount();
    expect(client.channels()).toEqual([`table:${TABLE}`]);
    second.unmount();
    expect(client.channels()).toEqual([]);
    expect(sent.at(-1)).toEqual({ type: 'unsubscribe', channel: `table:${TABLE}` });
    client.stop();
  });

  it('does not subscribe for ids that are not well-formed (typed URLs)', () => {
    const socket: SocketLike = {
      readyState: 1,
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send: () => undefined,
      close: vi.fn(),
    };
    const client = new RealtimeClient({
      createSocket: () => socket,
      onStatus: () => undefined,
      watchNetwork: false,
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <RealtimeProvider client={client}>{children}</RealtimeProvider>
      </QueryClientProvider>
    );
    renderHook(
      () => {
        useTableChannel('tbl_bad!!');
        useTableChannel('whatever');
        useBaseChannel('bse_short');
      },
      { wrapper },
    );
    expect(client.channels()).toEqual([]);
    client.stop();
  });
});

describe('record counts follow record messages (T420)', () => {
  const RECORD = 'rec_R000000000000001';
  // Test fixtures: plain strings where the contract brands ids.
  const asMessage = (message: unknown) => message as ChannelMessage;
  const created = {
    type: 'record.created' as const,
    channel: `table:${TABLE}`,
    record_id: RECORD,
    version: 1,
    fields: {},
    actor_id: null,
    event_id: null,
  };
  const batch = (ops: Partial<Record<'created' | 'updated' | 'deleted' | 'restored', number>>) => ({
    type: 'record.batch' as const,
    channel: `table:${TABLE}`,
    actor_id: null,
    count: 200,
    ops: {
      created: 0,
      updated: 0,
      added: 0,
      removed_from_view: 0,
      deleted: 0,
      restored: 0,
      ...ops,
    },
  });

  beforeEach(() => {
    vi.useFakeTimers();
    queryClient.setQueryData(keys.tableRecordCount(TABLE), { count: 3, estimated: false });
    queryClient.setQueryData(keys.tableRecordCount(OTHER), { count: 7, estimated: false });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const countStale = (tableId: string) =>
    queryClient.getQueryState(keys.tableRecordCount(tableId))?.isInvalidated ?? false;

  it.each([
    ['record.created', created],
    ['record.deleted', { type: 'record.deleted', channel: `table:${TABLE}`, record_ids: [RECORD] }],
    [
      'record.restored',
      { type: 'record.restored', channel: `table:${TABLE}`, record_ids: [RECORD] },
    ],
    ['record.batch with creations', batch({ created: 150 })],
    ['record.batch with deletions', batch({ deleted: 150, updated: 50 })],
  ] as const)('%s asks the count again after the window', (_, message) => {
    applyTableMessage(queryClient, TABLE, asMessage(message));
    expect(countStale(TABLE)).toBe(false);
    vi.advanceTimersByTime(RECORD_COUNT_REFRESH_MS);
    expect(countStale(TABLE)).toBe(true);
    expect(countStale(OTHER)).toBe(false);
  });

  it.each([
    ['record.updated', { ...created, type: 'record.updated' as const, version: 2 }],
    ['record.batch of updates', batch({ updated: 200 })],
    ['record.added', { type: 'record.added', channel: `table:${TABLE}`, record_id: RECORD }],
  ] as const)('%s leaves the count alone', (_, message) => {
    applyTableMessage(queryClient, TABLE, asMessage(message));
    vi.advanceTimersByTime(RECORD_COUNT_REFRESH_MS * 2);
    expect(countStale(TABLE)).toBe(false);
  });

  it('many messages in a window cost one refetch', () => {
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const countCalls = () =>
      invalidate.mock.calls.filter(
        ([filters]) =>
          JSON.stringify(filters?.queryKey) === JSON.stringify(keys.tableRecordCount(TABLE)),
      ).length;
    for (let index = 0; index < 50; index += 1)
      applyTableMessage(queryClient, TABLE, asMessage(created));
    vi.advanceTimersByTime(RECORD_COUNT_REFRESH_MS);
    expect(countCalls()).toBe(1);
    // A message after the window opens a new one.
    applyTableMessage(queryClient, TABLE, asMessage(created));
    vi.advanceTimersByTime(RECORD_COUNT_REFRESH_MS);
    expect(countCalls()).toBe(2);
  });
});
