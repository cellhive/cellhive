import { MAX_QUERY_IDS, type RealtimeSubscribeView, type RecordDto } from '@cellhive/contracts';
import { useEffect, useMemo, useRef } from 'react';

import { api } from '../../../lib/api';
import { devWarn } from '../../../lib/dev-log';
import { isLinkValue } from '../../../lib/links/values';
import { recordQueryHash } from '../../../lib/query/keys';
import { IdBatcher } from '../../../lib/realtime/batch';
import { useTableChannel } from '../../../lib/realtime/channels';

import type { RecordCachePatcher } from './block-loader';
import type { EffectiveRecordQuery } from '../../../lib/query/keys';
import type { ChannelMessage } from '../../../lib/realtime/socket';

/** `record.added` ids are collected this long before one lookup (FRONTEND §5). */
export const ADDED_BATCH_MS = 100;
/** Removals arriving together are applied at once (one cache pass, one refetch). */
export const REMOVED_BATCH_MS = 16;

export type FetchRecords = (ids: readonly string[]) => Promise<readonly RecordDto[]>;

/**
 * What the server does not know about the grid's query (T313, ADR-0031).
 * The `table:` subscription carries the view: the server scopes record
 * messages by its saved filter (hidden conditions included) and the read
 * rule. The temporary filter and the search box stay on the client, so
 * records they may concern are checked by `ids` through the full query.
 */
export interface GridRealtimeScope {
  /** A temporary filter or a search narrows the view: new and changed records are checked. */
  readonly narrowed: boolean;
  /** Fields of those conditions (the temporary filter, the primary field for search). */
  readonly checkFields: ReadonlySet<string>;
  /** Sort and group keys of the query: edited elsewhere, a shown row may be out of place. */
  readonly orderFields: ReadonlySet<string>;
  /** The signed-in user: their own edits never make rows stale (they see them happen). */
  readonly userId: string | null;
}

/** A link cell value (`[{ id, title }]`) with a record whose title is `null`. */
function hasWithheldTitle(value: unknown): boolean {
  return isLinkValue(value) && value.some((ref) => ref.title === null);
}

const WHOLE_VIEW: GridRealtimeScope = {
  narrowed: false,
  checkFields: new Set(),
  orderFields: new Set(),
  userId: null,
};

/** Field ids named by a filter (stored DSL). */
function filterFields(node: unknown, into: Set<string>): Set<string> {
  if (typeof node !== 'object' || node === null) return into;
  const item = node as { items?: unknown; item?: unknown; field?: unknown };
  if (Array.isArray(item.items)) for (const child of item.items) filterFields(child, into);
  if (item.item !== undefined) filterFields(item.item, into);
  if (typeof item.field === 'string') into.add(item.field);
  return into;
}

/**
 * The realtime scope of a grid query: the view goes to the server
 * (`filter_mode: replace` when a temporary filter takes the place of the
 * part of the saved filter the user sees); the temporary filter and the
 * search are checked by the client.
 */
export function gridRealtimeScope(
  query: EffectiveRecordQuery,
  options: {
    readonly primaryFieldId?: string | null;
    /** Group keys of the view when the query does not send its own. */
    readonly group?: readonly { readonly field: string }[];
    readonly userId?: string | null;
  } = {},
): { readonly view: RealtimeSubscribeView | null; readonly scope: GridRealtimeScope } {
  const hasFilter = query.filter !== undefined && query.filter !== null;
  const search = typeof query.search === 'string' && query.search.trim() !== '';
  const view =
    query.view_id === undefined || query.view_id === null
      ? null
      : {
          id: query.view_id as RealtimeSubscribeView['id'],
          ...(query.filter_mode === 'replace' ? { filter_mode: 'replace' as const } : {}),
        };
  const checkFields = hasFilter ? filterFields(query.filter, new Set()) : new Set<string>();
  if (search && options.primaryFieldId !== undefined && options.primaryFieldId !== null) {
    checkFields.add(options.primaryFieldId);
  }
  const orderFields = new Set<string>();
  for (const key of query.sort ?? []) orderFields.add(key.field);
  for (const key of query.group ?? options.group ?? []) orderFields.add(key.field);
  return {
    view,
    scope: {
      // Without a view (no server scope) a filter is also the client's to check.
      narrowed: hasFilter || search,
      checkFields,
      orderFields,
      userId: options.userId ?? null,
    },
  };
}

export interface GridRealtimeOptions {
  /** Replaces `POST …/records/query { ids }` (tests). */
  readonly fetchRecords?: FetchRecords;
  /** A record shown elsewhere on the page left (detail panel, T206). */
  readonly onRecordsGone?: (recordIds: readonly string[]) => void;
  /** See {@link GridRealtimeScope}; default: the server's scope is the whole query. */
  readonly scope?: GridRealtimeScope;
  /** Primary field (search, T313) and the view's group keys, for {@link gridRealtimeScope}. */
  readonly primaryFieldId?: string | null;
  readonly group?: readonly { readonly field: string }[];
  readonly userId?: string | null;
  /** Every message of the table channel after the rows were patched (T312: group counts). */
  readonly onMessage?: (message: ChannelMessage) => void;
  /**
   * (T816) The view of the subscription: the colors (`meta`) of its
   * `record.updated` messages go to the blocks read through it only.
   */
  readonly viewId?: string | null;
}

/**
 * Applies the record messages of `table:{id}` (subscribed with the view on
 * screen, T313) to the grid's cached rows (FRONTEND §5):
 * - `record.updated` → merge by version (pending cells kept); with a
 *   temporary filter or search, a change of one of their fields is checked
 *   by `ids` (left the query → row dropped, came in → pill); a sort/group
 *   key changed by someone else → the pill offers a refresh (rows stay);
 * - `record.created` → "N new rows" pill, never inserted mid-grid; with a
 *   temporary filter or search, only once `ids` says it matches;
 * - `record.added` → ids batched (100 ms, ≤ 1 000) → `POST …/records/query
 *   { ids }` with the grid's query → refreshed or counted as new;
 * - a failed check → the pill offers a refresh rather than a wrong count;
 * - `record.removed_from_view` / `record.deleted` → rows removed, count lowered;
 * - `record.restored` → blocks refetched (rows come back where they belong);
 * - `record.batch` (T303) → loaded blocks and row count refetched, pending
 *   cells kept, the pill left as it is;
 * - reconnect → blocks refetched.
 * Query-level effects (schema, trash) come from `useTableChannel`.
 */
export class GridRealtimeHandler {
  readonly #patcher: RecordCachePatcher;
  readonly #added: IdBatcher;
  readonly #checked: IdBatcher;
  readonly #removed: IdBatcher;
  /** Shown records whose link titles came withheld (`null`, T413): fetched again by `ids`. */
  readonly #titles: IdBatcher;
  readonly #fetchRecords: FetchRecords;
  readonly #onRecordsGone: ((recordIds: readonly string[]) => void) | undefined;
  readonly #scope: GridRealtimeScope;
  readonly #viewId: string | undefined;
  #disposed = false;

  constructor(
    patcher: RecordCachePatcher,
    fetchRecords: FetchRecords,
    options: GridRealtimeOptions = {},
  ) {
    this.#patcher = patcher;
    this.#fetchRecords = fetchRecords;
    this.#onRecordsGone = options.onRecordsGone;
    this.#scope = options.scope ?? WHOLE_VIEW;
    this.#viewId = options.viewId ?? undefined;
    this.#added = new IdBatcher({
      delayMs: ADDED_BATCH_MS,
      max: MAX_QUERY_IDS,
      flush: (ids) => {
        void this.#lookup(ids, false);
      },
    });
    this.#checked = new IdBatcher({
      delayMs: ADDED_BATCH_MS,
      max: MAX_QUERY_IDS,
      flush: (ids) => {
        void this.#lookup(ids, true);
      },
    });
    this.#titles = new IdBatcher({
      delayMs: ADDED_BATCH_MS,
      max: MAX_QUERY_IDS,
      flush: (ids) => {
        void this.#lookup(ids, false);
      },
    });
    this.#removed = new IdBatcher({
      delayMs: REMOVED_BATCH_MS,
      max: MAX_QUERY_IDS,
      flush: (ids) => {
        this.#patcher.removeRecords(ids);
        this.#onRecordsGone?.(ids);
      },
    });
  }

  handle(message: ChannelMessage): void {
    if (this.#disposed) return;
    switch (message.type) {
      case 'record.updated': {
        this.#patcher.applyRecordUpdate(message.record_id, {
          fields: message.fields,
          version: message.version,
          recomputed: message.event_id === null,
          ...(message.meta === undefined || this.#viewId === undefined
            ? {}
            : { meta: message.meta, metaViewId: this.#viewId }),
        });
        const changed = Object.keys(message.fields);
        // Link titles are only sent to subscribers who read every linked record
        // (CONTRACTS §7): a `null` title may be one this user reads — ask again.
        if (
          Object.values(message.fields).some(hasWithheldTitle) &&
          this.#patcher.hasRecord(message.record_id)
        ) {
          this.#titles.add([message.record_id]);
        }
        const scope = this.#scope;
        if (scope.narrowed && changed.some((fieldId) => scope.checkFields.has(fieldId))) {
          this.#checked.add([message.record_id]);
        }
        if (
          message.actor_id !== scope.userId &&
          changed.some((fieldId) => scope.orderFields.has(fieldId)) &&
          this.#patcher.hasRecord(message.record_id)
        ) {
          // Rows are not moved under the user's eyes: the pill offers a refresh.
          this.#patcher.markStale();
        }
        return;
      }
      case 'record.created':
        if (this.#scope.narrowed) {
          this.#removed.delete([message.record_id]);
          this.#added.add([message.record_id]);
        } else {
          this.#patcher.noteNewRecord(message.record_id);
        }
        return;
      case 'record.added':
        this.#removed.delete([message.record_id]);
        this.#added.add([message.record_id]);
        return;
      case 'record.removed_from_view':
        this.#added.delete([message.record_id]);
        this.#checked.delete([message.record_id]);
        this.#removed.add([message.record_id]);
        return;
      case 'record.deleted':
        this.#added.delete(message.record_ids);
        this.#checked.delete(message.record_ids);
        this.#removed.add(message.record_ids);
        return;
      case 'record.restored':
        this.#patcher.refetchVisible(false);
        return;
      case 'record.batch':
        // Many records at once (T303): no ids, so everything shown is fetched
        // again — the refetch also brings pending additions and drops removals.
        this.#added.clear();
        this.#checked.clear();
        this.#removed.clear();
        this.#titles.clear();
        this.#patcher.resync();
        return;
      default:
        return;
    }
  }

  /** The connection came back: whatever was missed is fetched again. */
  reconnected(): void {
    if (this.#disposed) return;
    // The refetch brings the added records and drops the removed ones.
    this.#added.clear();
    this.#checked.clear();
    this.#removed.clear();
    this.#patcher.refetchVisible();
  }

  dispose(): void {
    this.#disposed = true;
    this.#added.dispose();
    this.#checked.dispose();
    this.#removed.dispose();
    this.#titles.dispose();
  }

  /**
   * Fetches records through the grid's query (`ids`): those returned are
   * refreshed or counted as new rows; with `check`, those not returned left
   * the query (dropped, or out of the pill). A failure cannot tell: the
   * pill offers a refresh.
   */
  async #lookup(ids: readonly string[], check: boolean): Promise<void> {
    let records: readonly RecordDto[];
    try {
      records = await this.#fetchRecords(ids);
    } catch (error) {
      devWarn('realtime: cannot fetch records by ids', error);
      if (!this.#disposed) this.#patcher.markStale();
      return;
    }
    if (this.#disposed) return;
    this.#patcher.upsertRecords(records);
    if (!check) return;
    const found = new Set<string>(records.map((record) => record.id));
    const gone = ids.filter((id) => !found.has(id));
    if (gone.length === 0) return;
    this.#patcher.leaveQuery(gone);
    this.#onRecordsGone?.(gone);
  }
}

/** Subscribes the grid to `table:{id}` and patches its rows. */
export function useGridRealtime(
  tableId: string,
  query: EffectiveRecordQuery,
  patcher: RecordCachePatcher,
  options: GridRealtimeOptions = {},
): void {
  const { fetchRecords, onRecordsGone, primaryFieldId, group, userId, scope: fixed } = options;
  const onMessage = useRef(options.onMessage);
  useEffect(() => {
    onMessage.current = options.onMessage;
  });
  const handler = useRef<GridRealtimeHandler | null>(null);
  const hash = recordQueryHash(query);
  const groupKey = JSON.stringify(group ?? null);
  const { view, scope } = useMemo(
    () =>
      gridRealtimeScope(query, {
        primaryFieldId: primaryFieldId ?? null,
        ...(group === undefined ? {} : { group }),
        userId: userId ?? null,
      }),
    // `query` is represented by its hash, `group` by its JSON.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hash, primaryFieldId, groupKey, userId],
  );
  useEffect(() => {
    const fetch: FetchRecords =
      fetchRecords ??
      (async (ids) =>
        (
          await api.records.query(tableId, {
            view_id: query.view_id ?? null,
            filter: query.filter ?? null,
            ...(query.filter_mode === undefined ? {} : { filter_mode: query.filter_mode }),
            search: query.search ?? null,
            fields: query.fields === undefined || query.fields === null ? null : [...query.fields],
            ids: [...ids],
            offset: 0,
            limit: ids.length,
            include_total: false,
          })
        ).records);
    const current = new GridRealtimeHandler(patcher, fetch, {
      ...(onRecordsGone === undefined ? {} : { onRecordsGone }),
      scope: fixed ?? scope,
      viewId: query.view_id ?? null,
    });
    handler.current = current;
    return () => {
      current.dispose();
      if (handler.current === current) handler.current = null;
    };
    // `query` is represented by its hash.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableId, hash, patcher, fetchRecords, onRecordsGone, scope, fixed]);
  useTableChannel(tableId, {
    view,
    onMessage: (message) => {
      handler.current?.handle(message);
      onMessage.current?.(message);
    },
    onReconnect: () => {
      handler.current?.reconnected();
    },
  });
}
