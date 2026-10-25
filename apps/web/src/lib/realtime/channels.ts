import {
  baseChannel,
  isId,
  tableChannel,
  userChannel,
  type Id,
  type RealtimeSubscribeView,
  ErrorCode,
  TableList,
  type FieldList,
} from '@cellhive/contracts';
import {
  useQueryClient,
  type InvalidateQueryFilters,
  type QueryClient,
} from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

import { keys } from '../query/keys';

import { recordComputedProgress } from './computed-progress';
import { useRealtimeClient } from './context';
import { recordFieldConverting } from './field-conversions';
import { onJobProgress } from './jobs';
import { takeOwnPermissionChange, takeOwnSchemaChange } from './own-changes';
import { changesRecordCount, scheduleRecordCountRefresh } from './record-counts';

import type { ChannelErrorDetail, ChannelMessage, ChannelRelease } from './socket';

/**
 * Screen subscriptions (FRONTEND §5): `user:{me}` while signed in,
 * `base:{id}` inside a base, `table:{id}` for the table on screen. Each hook
 * holds a reference on its channel for as long as the component is mounted
 * and applies the query-level effects of the messages; screens add their
 * own handling (the grid patches its rows).
 */

interface ChannelOptions {
  readonly onMessage?: (message: ChannelMessage) => void;
  readonly onError?: (code: ErrorCode, detail: ChannelErrorDetail) => void;
  /** After a reconnect: the messages missed meanwhile are lost, refetch. */
  readonly onReconnect?: () => void;
  /**
   * The view open on screen (`table:` only, T313): record messages follow
   * its saved filter. Changing it subscribes again without a gap.
   */
  readonly view?: RealtimeSubscribeView | null;
}

/** Holds `channel` (none when `null`) with the latest handlers. */
export function useRealtimeChannel(channel: string | null, options: ChannelOptions): void {
  const client = useRealtimeClient();
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });
  const view = options.view ?? null;
  const viewId = view?.id ?? null;
  const filterMode = view?.filter_mode ?? null;
  const release = useRef<ChannelRelease | null>(null);
  useEffect(() => {
    if (channel === null) return;
    const current = client.subscribe(channel, {
      onMessage: (message) => latest.current.onMessage?.(message),
      onError: (code, detail) => latest.current.onError?.(code, detail),
      view: latest.current.view ?? null,
    });
    release.current = current;
    const offReconnect = client.onReconnect(() => latest.current.onReconnect?.());
    return () => {
      offReconnect();
      if (release.current === current) release.current = null;
      current();
    };
  }, [client, channel]);
  useEffect(() => {
    release.current?.setView(
      viewId === null
        ? null
        : { id: viewId, ...(filterMode === null ? {} : { filter_mode: filterMode }) },
    );
  }, [viewId, filterMode]);
}

/**
 * Realtime schema and permission messages come in bursts: a table deleted
 * or restored sends `schema.changed` and `permission.changed` on `base:` and
 * `schema.changed` on the `table:` of every table linked to it, and every
 * open tab gets them all (QA S4b, T470: two tabs went past the 20 requests/s
 * of a base, SPEC §13.1). Each message marks its queries stale at once.
 * Leading edge: the first message of a quiet period refetches the active
 * stale queries right away (the change shows in well under a second); the
 * messages that follow inside the window only mark, and the window ends with
 * **one** more refetch when any came — one change costs at most two fetches
 * per query and tab, not one per message.
 */
export const SCHEMA_REFETCH_MS = 250;
/** Up to this much more, at random: the trailing refetches of a user's tabs spread out. */
export const SCHEMA_REFETCH_JITTER_MS = 400;

interface RefetchWindow {
  readonly timer: ReturnType<typeof setTimeout>;
  /** Messages came after the leading refetch: refetch again when the window ends. */
  trailing: boolean;
}

const refetchWindows = new WeakMap<QueryClient, RefetchWindow>();

/**
 * Fetches the active stale queries. `fresh` (the leading edge): a fetch
 * already running started before the message came — the values the tab's
 * own mutation fetches after saving a formula, then the end of its backfill
 * ~100 ms later — and may have been answered before that change committed;
 * reused, its answer would clear the stale mark with the values from
 * before: it is cancelled and sent again. At the end of a window a running
 * fetch is the leading one of the same burst, and it is reused.
 */
function refetchStale(queryClient: QueryClient, fresh: boolean): void {
  void queryClient.refetchQueries(
    { type: 'active', predicate: (query) => query.state.isInvalidated },
    { cancelRefetch: fresh },
  );
}

/**
 * Marks the queries of `filters` stale now; refetches the active ones at
 * once on the first message of a window, else once at its end.
 */
function invalidateSoon(queryClient: QueryClient, filters: InvalidateQueryFilters): Promise<void> {
  const marked = queryClient.invalidateQueries({ ...filters, refetchType: 'none' });
  const open = refetchWindows.get(queryClient);
  if (open !== undefined) {
    open.trailing = true;
    return marked;
  }
  // After the marking above (and of any message handled in the same task).
  queueMicrotask(() => {
    refetchStale(queryClient, true);
  });
  const window: RefetchWindow = {
    trailing: false,
    timer: setTimeout(
      () => {
        refetchWindows.delete(queryClient);
        if (window.trailing) refetchStale(queryClient, false);
      },
      SCHEMA_REFETCH_MS + Math.floor(Math.random() * SCHEMA_REFETCH_JITTER_MS),
    ),
  };
  refetchWindows.set(queryClient, window);
  return marked;
}

/**
 * Refetches every query of a table but its record blocks (the grid refetches those itself).
 * A fetch already running (the `schema.changed` of the same change) is reused.
 */
function tableButRecords(tableId: string): InvalidateQueryFilters {
  return { queryKey: keys.table(tableId), predicate: (query) => query.queryKey[2] !== 'records' };
}

function invalidateTableButRecords(queryClient: QueryClient, tableId: string): Promise<void> {
  return queryClient.invalidateQueries(tableButRecords(tableId), { cancelRefetch: false });
}

/**
 * What a `schema.changed` makes stale. A field created, deleted or restored
 * changes the field list (the `permission.changed` that comes with it gives
 * the grid new record blocks); a field updated can also change the values
 * read (removed options). Table and view changes refetch the whole table.
 * Active queries are fetched at the end of the window ({@link invalidateSoon}).
 */
function invalidateSchemaChange(
  queryClient: QueryClient,
  tableId: string,
  message: Extract<ChannelMessage, { type: 'schema.changed' }>,
): Promise<void> {
  if (message.entity !== 'field') {
    return invalidateSoon(queryClient, { queryKey: keys.table(tableId) });
  }
  // `converted` (T403): the field's values changed type too.
  const values = message.action === 'updated' || message.action === 'converted';
  return invalidateSoon(queryClient, {
    queryKey: keys.table(tableId),
    predicate: (query) =>
      query.queryKey[2] === 'fields' ||
      query.queryKey[2] === 'record' ||
      (values && query.queryKey[2] === 'records'),
  });
}

/**
 * A link conversion of a field of `tableId` that ended (T415) changed the
 * linked table too: the reverse field of `to_two_way` exists from then on,
 * `to_one_way` sent one side to the trash. Its `schema.changed` goes to
 * `table:{linked}`, which a screen of this table does not hold, and the
 * fetch after `PUT /fields/:id` (`202`) may predate the end of the job: the
 * linked table's fields are fetched again (the field dialog names the
 * reverse field from them). A fetch still running may have been answered
 * before the job committed: it is cancelled and sent again, not reused
 * (its answer would clear the invalidation), inactive lists included.
 */
export function invalidateLinkedFields(
  queryClient: QueryClient,
  tableId: string,
  fieldId: string,
): Promise<void> {
  const field = queryClient
    .getQueryData<FieldList>(keys.fields(tableId))
    ?.items.find((item) => item.id === fieldId);
  const linked = field?.type === 'link' ? field.options['link_table'] : undefined;
  if (typeof linked !== 'string' || linked === tableId) return Promise.resolve();
  return queryClient.invalidateQueries(
    { queryKey: keys.fields(linked), refetchType: 'all' },
    { cancelRefetch: true },
  );
}

/** Query-level effects of a `table:` message (FRONTEND §5). */
export function applyTableMessage(
  queryClient: QueryClient,
  tableId: string,
  message: ChannelMessage,
): void {
  // The sidebar's record count (T420): asked again once per window.
  if (changesRecordCount(message)) scheduleRecordCountRefresh(queryClient, tableId);
  switch (message.type) {
    case 'schema.changed':
      // Caused by this tab: its mutation already refetched what changed.
      if (takeOwnSchemaChange(tableId)) return;
      void invalidateSchemaChange(queryClient, tableId, message);
      return;
    // Permanently deleted elsewhere (T408, `record.purged`): the rows leave open trash lists.
    case 'record.deleted':
    case 'record.restored':
    case 'record.purged':
      void queryClient.invalidateQueries({ queryKey: keys.recordTrash(tableId) });
      return;
    case 'record.batch':
      // No ids (T303): the trash and any open record (panel) are fetched
      // again; a record gone or out of reach answers 404 and the panel closes.
      if (message.ops.deleted > 0 || message.ops.restored > 0) {
        void queryClient.invalidateQueries({ queryKey: keys.recordTrash(tableId) });
      }
      void queryClient.invalidateQueries({ queryKey: keys.record(tableId, '').slice(0, -1) });
      return;
    case 'field.converting':
      // Progress banner of a type conversion (T414); the `schema.changed` around it refetches.
      recordFieldConverting(message);
      if (message.link_change !== undefined && message.status !== 'running') {
        void invalidateLinkedFields(queryClient, tableId, message.field_id);
      }
      return;
    case 'computed.recomputing':
      // Progress on the header of a computed column (T468); values come as record messages.
      recordComputedProgress(message);
      return;
    default:
      return;
  }
}

/**
 * `table:{id}` for a screen showing the table (grid, kanban, trash); with
 * `view`, record messages follow the view open on screen (T313). A view the
 * server refuses (deleted, hidden) refetches the table's views: the page
 * moves to another one (T310).
 */
export function useTableChannel(tableId: string | null, options: ChannelOptions = {}): void {
  const queryClient = useQueryClient();
  // An id from the URL that is not even well-formed has no channel (the page shows 404).
  useRealtimeChannel(tableId !== null && isId('tbl', tableId) ? tableChannel(tableId) : null, {
    onMessage: (message) => {
      if (tableId !== null) applyTableMessage(queryClient, tableId, message);
      options.onMessage?.(message);
    },
    ...(options.view === undefined ? {} : { view: options.view }),
    onError: (code, detail) => {
      if (tableId !== null && detail.viewId !== undefined) {
        void queryClient.invalidateQueries({ queryKey: keys.table(tableId) });
      }
      options.onError?.(code, detail);
    },
    onReconnect: () => {
      if (tableId !== null) {
        void invalidateTableButRecords(queryClient, tableId);
        // Record messages missed meanwhile.
        scheduleRecordCountRefresh(queryClient, tableId);
      }
      options.onReconnect?.();
    },
  });
}

/** Query-level effects of a `base:` message (FRONTEND §3.2, §5). */
export function applyBaseMessage(
  queryClient: QueryClient,
  baseId: string,
  message: ChannelMessage,
): void {
  switch (message.type) {
    case 'permission.changed': {
      // A new `permission_version` gives every grid new block keys; the
      // schema (visible tables and fields) is fetched again.
      const tables = queryClient.getQueryData<TableList>(keys.tables(baseId));
      // Caused by a field this tab created or deleted: its mutation refetched the base and fields.
      if (takeOwnPermissionChange(tables?.items.map((table) => table.id) ?? [])) return;
      void invalidateSoon(queryClient, { queryKey: keys.base(baseId) });
      for (const table of tables?.items ?? []) {
        void invalidateSoon(queryClient, tableButRecords(table.id));
      }
      return;
    }
    case 'schema.changed':
      if (message.entity === 'table') {
        void invalidateSoon(queryClient, { queryKey: keys.tables(baseId) });
        void invalidateSoon(queryClient, tableButRecords(message.entity_id));
      }
      return;
    case 'field.converting':
      recordFieldConverting(message);
      return;
    default:
      return;
  }
}

/** `base:{id}` while a screen of the base is open. */
export function useBaseChannel(baseId: string | null): void {
  const queryClient = useQueryClient();
  useRealtimeChannel(baseId !== null && isId('bse', baseId) ? baseChannel(baseId) : null, {
    onMessage: (message) => {
      if (baseId !== null) applyBaseMessage(queryClient, baseId, message);
    },
    onReconnect: () => {
      if (baseId !== null) void queryClient.invalidateQueries({ queryKey: keys.base(baseId) });
    },
  });
}

/** `user:{me}` while signed in: progress of the jobs started from this tab. */
export function useUserChannel(userId: string | null): void {
  useRealtimeChannel(userId === null ? null : userChannel(userId as Id<'usr'>), {
    onMessage: (message) => {
      if (message.type === 'job.progress') onJobProgress(message);
    },
  });
}
