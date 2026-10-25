import {
  QueryObserver,
  type QueryClient,
  type QueryFunction,
  type QueryObserverResult,
} from '@tanstack/react-query';

import { keys, recordQueryHash, type EffectiveRecordQuery } from '../../../lib/query/keys';
import { RECORD_BLOCK_SIZE, recordBlockQuery } from '../../../lib/query/queries';
import {
  applyRecordPatch,
  keepPendingCells,
  type RecordPatch,
} from '../../../lib/records/realtime-merge';

import {
  BLOCK_PADDING,
  blockCount,
  blockOf,
  DRAG_DEBOUNCE_MS,
  MAX_CACHED_BLOCKS,
  neededBlocks,
  prefetchBlock,
  scrollDirection,
  shouldDebounce,
  type RowRange,
} from './block-math';
import { LruOrder } from './lru';
import { planRemoval } from './realtime-patch';

import type { RecordDto, RecordListResponse } from '@cellhive/contracts';

/** Records created by the tab remembered to ignore their realtime echo. */
const MAX_OWN_IDS = 5_000;

/** Blocks nobody shows are dropped from the query cache this long after leaving the grid. */
export const BLOCK_GC_TIME = 60_000;

export type FetchBlock = (index: number, signal: AbortSignal) => Promise<RecordListResponse>;

export interface BlockLoaderOptions {
  readonly queryClient: QueryClient;
  readonly tableId: string;
  readonly query: EffectiveRecordQuery;
  /** `permission_version` of the base: part of every block key (FRONTEND §3.2). */
  readonly permissionVersion: number;
  /** Replaces `POST …/records/query` (tests). */
  readonly fetchBlock?: FetchBlock;
  readonly maxBlocks?: number;
  readonly debounceMs?: number;
  /**
   * The loader this one replaces when only `permissionVersion` changed
   * (adding a field bumps it for everyone): its rows stay on screen as
   * placeholders, with its row count and viewport, until the new blocks
   * arrive — the grid neither blanks to skeleton rows nor scrolls back.
   */
  readonly previous?: RecordBlockLoader;
  /**
   * Nothing is loaded until the first `setViewport` (T312: a grouped grid
   * knows which rows it shows only once the group counts arrived; block 0
   * may belong to a collapsed group).
   */
  readonly waitForViewport?: boolean;
  /**
   * Rows other than the query's own rows (T417: one level of a sub-record
   * tree): added to the query hash of the block keys, so two loaders of the
   * same query keep their blocks apart (still under `keys.recordBlocks`).
   */
  readonly scope?: string;
}

/**
 * Rows to load given as server row ranges (T312, a grouped grid): rows of
 * collapsed groups are skipped, so the blocks needed are those of these
 * ranges — no padding or prefetch of its own (the caller pads its data rows).
 */
export interface ViewportPlan {
  /** Rows on screen (their blocks are loaded first, kept most recently used). */
  readonly visible: readonly RowRange[];
  /** Rows to have loaded: the visible ones and the padding around them. */
  readonly needed: readonly RowRange[];
}

/** What a replaced loader hands over (`BlockLoaderOptions.previous`). */
export interface BlockHandover {
  readonly rowCount: number | null;
  readonly estimated: boolean;
  readonly viewport: RowRange | null;
  /** The ranges of a grouped grid's viewport (`setViewport(…, plan)`). */
  readonly plan?: ViewportPlan | null;
  readonly blocks: ReadonlyMap<number, RecordListResponse>;
}

export interface BlockSnapshot {
  /** `loading` until the row count is known, `error` when it could not be. */
  readonly status: 'loading' | 'ready' | 'error';
  /** Rows the grid shows: `total`, else `total_estimate` (FRONTEND §3.3). */
  readonly rowCount: number;
  /** `rowCount` is `total_estimate` (footer shows "~"). */
  readonly estimated: boolean;
  /** Last failure of a block fetch, until a retry succeeds. */
  readonly error: unknown;
  /** Increases whenever rows or counts change (the grid redraws). */
  readonly version: number;
  /**
   * Records created (or come into reach) elsewhere and not shown yet: the
   * "N new rows" pill (FRONTEND §5); `showNewRows()` loads them.
   */
  readonly newRows: number;
  /**
   * Rows shown may have changed place or left the query in ways the client
   * could not check (T313: a sort/group key edited elsewhere, a lookup by
   * `ids` that failed): the pill offers a refresh instead of a count.
   */
  readonly stale: boolean;
}

/** Realtime updates of the cached rows (FRONTEND §5, T204). */
export interface RecordCachePatcher {
  /**
   * Merges a `record.updated` patch into every cached copy of the record
   * when its `version` is newer (or, recomputed by the system, not older);
   * pending cells of the user's own writes are left alone. Returns whether
   * a cached copy changed.
   */
  applyRecordUpdate(recordId: string, patch: RecordPatch): boolean;
  /**
   * `record.removed_from_view` / `record.deleted`: drops the rows, moving
   * the next ones up, and lowers the row count. Returns the number of rows
   * removed from the loaded blocks.
   */
  removeRecords(recordIds: readonly string[]): number;
  /** `record.created`: counted in the "new rows" pill unless already shown. */
  noteNewRecord(recordId: string): void;
  /**
   * Records checked by `ids` (T313) and not in the grid's query any more:
   * shown rows are dropped (as `removeRecords`), pending new rows leave the
   * pill; nothing is refetched for records that were not shown.
   */
  leaveQuery(recordIds: readonly string[]): void;
  /** The shown rows may be out of place (T313): the pill offers a refresh. */
  markStale(): void;
  /** Whether a loaded block holds the record. */
  hasRecord(recordId: string): boolean;
  /**
   * Records fetched after `record.added`: a shown one is refreshed, the
   * others are counted as new rows.
   */
  upsertRecords(records: readonly RecordDto[]): void;
  /**
   * After a reconnect (or `record.restored`): refetch the loaded blocks;
   * the "new rows" pill is cleared unless `clearNew` is false.
   */
  refetchVisible(clearNew?: boolean): void;
  /**
   * `record.batch` (T303): many records changed at once — refetch the
   * loaded blocks and the row count (block 0, even when not shown); the
   * "new rows" pill stays. Pending cells keep their optimistic value.
   */
  resync(): void;
}

type BlockKey = ReturnType<typeof recordBlockQuery>['queryKey'];

interface BlockEntry {
  readonly observer: { refetch: () => Promise<unknown> };
  unsubscribe: () => void;
  rows: readonly RecordDto[] | undefined;
  failed: boolean;
}

type Listener = () => void;

const INITIAL_RANGE: RowRange = { firstRow: 0, lastRow: 0 };

/**
 * Windowed loading of a grid (FRONTEND §3.3). Rows live in 200-row blocks
 * in the TanStack Query cache under `keys.recordBlock(table, queryHash,
 * permission_version, index)`; each cached block has an observer, so writes
 * to the cache (optimistic edits T203, realtime T204) reach the grid.
 *
 * - The blocks needed are the visible ones ± 1; blocks being fetched that
 *   leave that range are aborted (removing the query aborts its signal).
 * - Near a block edge, the next block in the scroll direction is prefetched.
 * - Viewport changes are debounced while the scroll bar is dragged or the
 *   view jumps.
 * - At most `maxBlocks` (30) blocks are kept, least recently used evicted.
 *
 * A loader serves one query hash and permission version: a new query is a
 * new loader (the grid resets to block 0).
 */
export class RecordBlockLoader implements RecordCachePatcher {
  readonly #options: BlockLoaderOptions;
  readonly #queryHash: string;
  readonly #entries = new Map<number, BlockEntry>();
  readonly #lru = new LruOrder<number>();
  readonly #listeners = new Set<Listener>();
  #applied: RowRange | null = null;
  #plan: ViewportPlan | null = null;
  #latest: RowRange | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #attached = false;
  #followTail = false;
  #serverOrdered = false;
  #rowCount: number | null = null;
  #estimated = false;
  #error: unknown = null;
  readonly #newIds = new Set<string>();
  /** See `BlockSnapshot.stale`. */
  #stale = false;
  /**
   * Records announced by realtime (`record.created`/`record.added`) that the
   * row count does not include yet: when one shows up in a loaded block the
   * count grows by one; a fresh `total` (block 0) includes them all.
   */
  readonly #uncounted = new Set<string>();
  /** Records this tab created and counted itself: their realtime echo is not new. */
  readonly #ownIds = new Set<string>();
  #snapshot: BlockSnapshot = {
    status: 'loading',
    rowCount: 0,
    estimated: false,
    error: null,
    version: 0,
    newRows: 0,
    stale: false,
  };

  readonly #placeholders: ReadonlyMap<number, RecordListResponse>;

  constructor(options: BlockLoaderOptions) {
    this.#options = options;
    this.#queryHash =
      options.scope === undefined
        ? recordQueryHash(options.query)
        : `${recordQueryHash(options.query)}#${options.scope}`;
    const handover =
      options.previous !== undefined &&
      options.previous.#options.tableId === options.tableId &&
      options.previous.#queryHash === this.#queryHash
        ? options.previous.handover()
        : undefined;
    this.#placeholders = handover?.blocks ?? new Map();
    if (handover !== undefined && handover.rowCount !== null) {
      this.#rowCount = handover.rowCount;
      this.#estimated = handover.estimated;
      this.#applied = handover.viewport;
      this.#plan = handover.plan ?? null;
      this.#latest = handover.viewport;
      this.#snapshot = {
        ...this.#snapshot,
        status: 'ready',
        rowCount: handover.rowCount,
        estimated: handover.estimated,
      };
    }
  }

  /** Rows, count and viewport for the loader that replaces this one (`previous`). */
  handover(): BlockHandover {
    const blocks = new Map<number, RecordListResponse>();
    for (const index of this.#entries.keys()) {
      const data = this.#options.queryClient.getQueryData<RecordListResponse>(this.#key(index));
      if (data !== undefined) blocks.set(index, data);
    }
    return {
      rowCount: this.#rowCount,
      estimated: this.#estimated,
      viewport: this.#applied,
      plan: this.#plan,
      blocks,
    };
  }

  // --- external store (useSyncExternalStore) --------------------------------

  readonly subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly getSnapshot = (): BlockSnapshot => this.#snapshot;

  // --- lifecycle -------------------------------------------------------------

  /** Starts observing (again): the last viewport, else the first block. */
  attach(): void {
    if (this.#attached) return;
    this.#attached = true;
    if (this.#applied === null && this.#options.waitForViewport === true) return;
    this.#apply(this.#applied ?? INITIAL_RANGE);
  }

  /** Stops every observer and in-flight fetch; cached blocks stay for `BLOCK_GC_TIME`. */
  detach(): void {
    if (!this.#attached) return;
    this.#attached = false;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    for (const index of [...this.#entries.keys()]) {
      const entry = this.#entries.get(index);
      if (entry === undefined) continue;
      entry.unsubscribe();
      // A block still loading is dropped (its fetch aborted); loaded ones stay cached.
      if (entry.rows === undefined) this.#removeQuery(index);
      this.#entries.delete(index);
      this.#lru.delete(index);
    }
  }

  // --- viewport ---------------------------------------------------------------

  /**
   * The rows on screen changed (every scroll). With a `plan` (grouped grid,
   * T312) the blocks loaded are those of its ranges; `range` spans them
   * (scroll direction, debounce).
   */
  setViewport(range: RowRange, dragging = false, plan: ViewportPlan | null = null): void {
    const debounce = shouldDebounce(this.#latest, range, dragging);
    this.#latest = range;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (debounce) {
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        this.#plan = plan;
        this.#apply(range);
      }, this.#options.debounceMs ?? DRAG_DEBOUNCE_MS);
      return;
    }
    this.#plan = plan;
    this.#apply(range);
  }

  /**
   * The server decides where rows go even without sort, filter or search
   * in the query (T312: grouped rows): a created record is never appended
   * locally, the blocks reload.
   */
  setServerOrdered(ordered: boolean): void {
    this.#serverOrdered = ordered;
  }

  /** The record of a row, `undefined` while its block is not loaded. */
  getRecord(row: number): RecordDto | undefined {
    return this.#entries.get(blockOf(row))?.rows?.[row % RECORD_BLOCK_SIZE];
  }

  /** Block indexes currently cached, least recently used first (tests, debugging). */
  cachedBlocks(): number[] {
    return this.#lru.keys();
  }

  /** Refetches the blocks that failed. */
  retry(): void {
    this.#error = null;
    for (const entry of this.#entries.values()) {
      if (entry.failed) void entry.observer.refetch();
    }
    this.#emit();
  }

  // --- edits (T203) ----------------------------------------------------------------

  /**
   * A cached record by id: any loaded block of this grid, else a block of
   * the same query loaded off screen (`loadRows`: paste, copy, fill).
   */
  findRecord(recordId: string): RecordDto | undefined {
    for (const entry of this.#entries.values()) {
      const found = entry.rows?.find((record) => record.id === recordId);
      if (found !== undefined) return found;
    }
    const { tableId, permissionVersion } = this.#options;
    for (const [, data] of this.#options.queryClient.getQueriesData<RecordListResponse>({
      queryKey: [...keys.recordBlocks(tableId), this.#queryHash, permissionVersion],
    })) {
      const found = data?.records.find((record) => record.id === recordId);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  /** Row of a record in the loaded blocks (record panel previous / next, T206). */
  rowOf(recordId: string): number | undefined {
    for (const [index, entry] of this.#entries) {
      const offset = entry.rows?.findIndex((record) => record.id === recordId) ?? -1;
      if (offset >= 0) return index * RECORD_BLOCK_SIZE + offset;
    }
    return undefined;
  }

  /**
   * The records of rows `firstRow`…`lastRow` (inclusive), loading blocks
   * that are not cached (a paste or fill beyond the screen, FRONTEND §4.2).
   * Rows past the end are `undefined`. Loaded blocks stay in the query
   * cache (`BLOCK_GC_TIME`) without being observed.
   */
  async loadRows(firstRow: number, lastRow: number): Promise<(RecordDto | undefined)[]> {
    const first = blockOf(Math.max(0, firstRow));
    const last = blockOf(Math.max(0, lastRow));
    const blocks = await Promise.all(
      Array.from({ length: last - first + 1 }, async (_, offset) => {
        const index = first + offset;
        const rows = this.#entries.get(index)?.rows;
        if (rows !== undefined) return rows;
        // Cached data is used as it is (like `ensureQueryData`); only missing blocks are fetched.
        const data = await this.#options.queryClient.query({
          ...this.#blockQuery(index),
          staleTime: 'static',
        });
        return data.records;
      }),
    );
    const result: (RecordDto | undefined)[] = [];
    for (let row = firstRow; row <= lastRow; row += 1) {
      result.push(blocks[blockOf(row) - first]?.[row % RECORD_BLOCK_SIZE]);
    }
    return result;
  }

  /**
   * Replaces a record in every cached block of the table (optimistic value,
   * server answer). Observers see the new block and the grid redraws.
   */
  updateRecord(recordId: string, update: (record: RecordDto) => RecordDto): void {
    this.updateRecords(new Map([[recordId, update]]));
  }

  /** `updateRecord` for many records in one pass over the cached blocks (bulk writes). */
  updateRecords(updates: ReadonlyMap<string, (record: RecordDto) => RecordDto>): void {
    if (updates.size === 0) return;
    const { queryClient, tableId } = this.#options;
    queryClient.setQueriesData<RecordListResponse>(
      { queryKey: keys.recordBlocks(tableId) },
      (data) => {
        if (data === undefined || !data.records.some((record) => updates.has(record.id))) {
          return data;
        }
        return {
          ...data,
          records: data.records.map((record) => updates.get(record.id)?.(record) ?? record),
        };
      },
    );
    // An open record panel (`keys.record`, T206) shows the same values (paste, undo).
    for (const [key, data] of queryClient.getQueriesData<RecordDto>({
      queryKey: keys.record(tableId, '').slice(0, -1),
    })) {
      const update = data === undefined ? undefined : updates.get(data.id);
      if (data !== undefined && update !== undefined) queryClient.setQueryData(key, update(data));
    }
  }

  /**
   * A created record: without sort, filter or search it is the last row.
   * Returns that row, or `null` when its place is up to the server (sorted
   * or filtered view) or the end is not known (estimated count): then the
   * blocks are reloaded.
   */
  insertAtEnd(record: RecordDto): number | null {
    this.#countedHere([record.id]);
    const { sort, filter, search } = this.#options.query;
    const ordered =
      this.#serverOrdered ||
      (sort?.length ?? 0) > 0 ||
      (filter ?? null) !== null ||
      (search ?? '') !== '';
    if (this.#rowCount === null || this.#estimated || ordered) {
      // Sorted or filtered rows: the server decides where the record goes.
      this.#rowCount =
        this.#rowCount === null || this.#estimated ? this.#rowCount : this.#rowCount + 1;
      this.#shiftTotal(this.#estimated ? 0 : 1);
      this.reload();
      return null;
    }
    const row = this.#rowCount;
    const index = blockOf(row);
    this.#rowCount += 1;
    this.#shiftTotal(1);
    const entry = this.#entries.get(index);
    if (entry?.rows !== undefined && entry.rows.length === row % RECORD_BLOCK_SIZE) {
      this.#options.queryClient.setQueryData<RecordListResponse>(this.#key(index), (data) =>
        data === undefined ? data : { ...data, records: [...data.records, record] },
      );
    }
    this.#emit();
    if (this.#applied !== null) this.#apply(this.#applied, false);
    return row;
  }

  /**
   * Many records created at once (a paste past the last row, T205): the
   * count grows by `count` (unless it is estimated) and the cached blocks
   * reload once, so the new rows show where the server puts them.
   */
  insertManyAtEnd(count: number, recordIds: readonly string[] = []): void {
    this.#countedHere(recordIds);
    if (count <= 0) return;
    if (this.#rowCount !== null && !this.#estimated) {
      this.#rowCount += count;
      this.#shiftTotal(count);
      this.#emit();
      if (this.#applied !== null) this.#apply(this.#applied, false);
    }
    this.reload();
  }

  /**
   * Rows changed place (records deleted or out of reach): the count drops
   * by `removed` at once and the cached blocks of the table refetch.
   */
  reload(removed = 0): void {
    if (removed > 0 && this.#rowCount !== null && !this.#estimated) {
      this.#rowCount = Math.max(0, this.#rowCount - removed);
      this.#shiftTotal(-removed);
      this.#emit();
    }
    void this.#options.queryClient.invalidateQueries({
      queryKey: keys.recordBlocks(this.#options.tableId),
    });
  }

  /** Keeps `total` of block 0 in step with a local count change. */
  #shiftTotal(delta: number): void {
    this.#options.queryClient.setQueryData<RecordListResponse>(this.#key(0), (data) =>
      data === undefined || !('total' in data) ? data : { ...data, total: data.total + delta },
    );
  }

  // --- realtime (T204) ------------------------------------------------------------

  applyRecordUpdate(recordId: string, patch: RecordPatch): boolean {
    // Every cached copy (record panel, other query hashes), pending cells kept.
    return applyRecordPatch(this.#options.queryClient, this.#options.tableId, recordId, patch);
  }

  removeRecords(recordIds: readonly string[]): number {
    const ids = new Set(recordIds);
    for (const id of ids) {
      this.#newIds.delete(id);
      this.#uncounted.delete(id);
    }
    const loaded = [...this.#entries].flatMap(([index, entry]) =>
      entry.rows === undefined ? [] : [{ index, records: entry.rows }],
    );
    const plan = planRemoval(loaded, ids);
    if (plan.removed === 0 || this.#estimated || this.#rowCount === null) {
      // Not shown (maybe in an unloaded block, maybe outside the query), or
      // the count is an estimate: the loaded blocks are fetched again.
      if (plan.removed > 0 || ids.size > 0) this.refetchVisible(false);
      this.#emit();
      return plan.removed;
    }
    const count = Math.max(0, this.#rowCount - plan.removed);
    this.#rowCount = count;
    // Block 0 first, with the new total: its observer resets the count from it.
    this.#setTotal(count);
    const { queryClient } = this.#options;
    for (const [index, records] of plan.blocks) {
      queryClient.setQueryData<RecordListResponse>(this.#key(index), (data) =>
        data === undefined ? data : { ...data, records: [...records] },
      );
    }
    if (plan.staleFrom !== null) {
      const from = plan.staleFrom;
      void queryClient.invalidateQueries({
        queryKey: this.#prefix(),
        predicate: (query) => {
          const index = query.queryKey[5];
          return typeof index === 'number' && index >= from;
        },
      });
    }
    // The local count is a guess (the record may never have been counted):
    // the server's `total` settles it.
    if (plan.staleFrom !== 0) this.#reconcileCount();
    this.#emit();
    if (this.#applied !== null) this.#apply(this.#applied, false);
    return plan.removed;
  }

  /**
   * Records created by this tab, already in the count: their realtime
   * `record.created` (before or after this call) is neither a new row nor
   * a count to add.
   */
  #countedHere(recordIds: readonly string[]): void {
    let pill = false;
    for (const id of recordIds) {
      this.#uncounted.delete(id);
      pill = this.#newIds.delete(id) || pill;
      this.#ownIds.add(id);
    }
    if (pill) this.#emit();
    // Only recent echoes matter: keep the newest few thousand.
    for (const id of this.#ownIds) {
      if (this.#ownIds.size <= MAX_OWN_IDS) break;
      this.#ownIds.delete(id);
    }
  }

  noteNewRecord(recordId: string): void {
    if (this.#ownIds.has(recordId)) return;
    if (this.#newIds.has(recordId) || this.findRecord(recordId) !== undefined) return;
    this.#newIds.add(recordId);
    this.#uncounted.add(recordId);
    this.#emit();
  }

  leaveQuery(recordIds: readonly string[]): void {
    const shown = recordIds.filter((id) => this.findRecord(id) !== undefined);
    let pill = false;
    for (const id of recordIds) {
      if (this.#newIds.delete(id)) pill = true;
      this.#uncounted.delete(id);
    }
    if (shown.length > 0) this.removeRecords(shown);
    else if (pill) this.#emit();
  }

  hasRecord(recordId: string): boolean {
    return this.findRecord(recordId) !== undefined;
  }

  markStale(): void {
    if (this.#stale) return;
    this.#stale = true;
    this.#emit();
  }

  upsertRecords(records: readonly RecordDto[]): void {
    for (const record of records) {
      if (this.findRecord(record.id) !== undefined) {
        this.#options.queryClient.setQueriesData<RecordListResponse>(
          { queryKey: keys.recordBlocks(this.#options.tableId) },
          (data) => {
            if (data === undefined) return data;
            const index = data.records.findIndex((item) => item.id === record.id);
            const current = data.records[index];
            if (current === undefined || current.version > record.version) return data;
            const next = [...data.records];
            next[index] = record;
            return { ...data, records: next };
          },
        );
      } else {
        this.noteNewRecord(record.id);
      }
    }
  }

  /**
   * Refetches the blocks of this grid and the row count (block 0, even when
   * it is not on screen). The "new rows" pill is cleared unless `clearNew`
   * is false.
   */
  refetchVisible(clearNew = true): void {
    if (clearNew && (this.#newIds.size > 0 || this.#stale)) {
      this.#newIds.clear();
      this.#stale = false;
      this.#emit();
    }
    void this.#options.queryClient.invalidateQueries({ queryKey: this.#prefix() });
    if (!this.#entries.has(0)) this.#reconcileCount();
  }

  resync(): void {
    this.refetchVisible(false);
  }

  /**
   * Asks the server for the row count: block 0 (which carries `total`) is
   * refetched, or fetched once without being shown when it is off screen.
   */
  #reconcileCount(): void {
    if (!this.#attached) return;
    const { queryClient } = this.#options;
    if (this.#entries.has(0)) {
      void queryClient.invalidateQueries({ queryKey: this.#key(0), exact: true });
      return;
    }
    queryClient.query({ ...this.#blockQuery(0), staleTime: 0 }).then(
      (data) => {
        if (!this.#attached || this.#entries.has(0)) return;
        const before = this.#rowCount;
        this.#updateCount(0, data);
        if (this.#rowCount !== before) this.#emit();
      },
      () => undefined, // Best effort: the next scroll or refetch brings the count.
    );
  }

  /** The pill was clicked: load the new rows (they appear where the query puts them). */
  showNewRows(): void {
    this.refetchVisible(true);
  }

  /** Keys of this grid's blocks: table, query hash, permission version. */
  #prefix() {
    const { tableId, permissionVersion } = this.#options;
    return [...keys.recordBlocks(tableId), this.#queryHash, permissionVersion] as const;
  }

  /** Keeps `total` of block 0 equal to the local row count. */
  #setTotal(count: number): void {
    this.#options.queryClient.setQueryData<RecordListResponse>(this.#key(0), (data) =>
      data === undefined || !('total' in data) ? data : { ...data, total: count },
    );
  }

  // --- internals --------------------------------------------------------------

  #key(index: number) {
    const { tableId, permissionVersion } = this.#options;
    return keys.recordBlock(tableId, this.#queryHash, permissionVersion, index);
  }

  /**
   * Loads what `range` needs. `fromViewport` is false when only the row
   * count changed (the same range is applied again).
   */
  #apply(range: RowRange, fromViewport = true): void {
    if (!this.#attached) {
      this.#applied = range;
      return;
    }
    const direction = scrollDirection(this.#applied, range);
    this.#applied = range;
    if (this.#plan !== null) {
      this.#applyPlan(this.#plan);
      return;
    }
    // Until block 0 gave the row count, nothing beyond the visible blocks is requested.
    const needed = neededBlocks(range, this.#rowCount, this.#rowCount === null ? 0 : undefined);
    const prefetch = prefetchBlock(range, direction, this.#rowCount);
    const wanted = new Set(needed);
    if (prefetch !== null) wanted.add(prefetch);
    // At the end of an estimated count the table may go on: keep loading the
    // last block until a short one gives the exact count, while the user
    // stays at the end (the estimate can be thousands of rows short).
    const lastBlock = this.#rowCount === null ? -1 : blockCount(this.#rowCount) - 1;
    if (fromViewport) {
      this.#followTail =
        this.#estimated && lastBlock >= 0 && blockOf(range.lastRow) + BLOCK_PADDING >= lastBlock;
    }
    const tail = this.#followTail && this.#estimated && lastBlock >= 0 ? lastBlock : null;
    if (tail !== null) wanted.add(tail);

    // Fast scroll: blocks still loading that are no longer wanted are aborted.
    for (const [index, entry] of this.#entries) {
      if (!wanted.has(index) && entry.rows === undefined) this.#drop(index);
    }
    if (prefetch !== null) this.#ensure(prefetch);
    if (tail !== null) this.#ensure(tail);
    // Visible blocks last: they become the most recently used.
    const visible = new Set(neededBlocks(range, this.#rowCount, 0));
    for (const index of needed) if (!visible.has(index)) this.#ensure(index);
    for (const index of visible) this.#ensure(index);

    for (const index of this.#lru.evict(this.#options.maxBlocks ?? MAX_CACHED_BLOCKS, wanted)) {
      this.#drop(index, true);
    }
  }

  /** `#apply` for a viewport given as server row ranges (grouped grid, T312). */
  #applyPlan(plan: ViewportPlan): void {
    const blocksOf = (ranges: readonly RowRange[]) => {
      const blocks = new Set<number>();
      for (const range of ranges) {
        if (range.lastRow < range.firstRow) continue;
        for (const index of neededBlocks(range, null, 0)) blocks.add(index);
      }
      return blocks;
    };
    const visible = blocksOf(plan.visible);
    const wanted = blocksOf(plan.needed);
    for (const index of visible) wanted.add(index);
    this.#followTail = false;
    for (const [index, entry] of this.#entries) {
      if (!wanted.has(index) && entry.rows === undefined) this.#drop(index);
    }
    for (const index of wanted) if (!visible.has(index)) this.#ensure(index);
    for (const index of visible) this.#ensure(index);
    for (const index of this.#lru.evict(this.#options.maxBlocks ?? MAX_CACHED_BLOCKS, wanted)) {
      this.#drop(index, true);
    }
  }

  /** Key, fetch and cache time of a block. */
  #blockQuery(index: number) {
    const base = recordBlockQuery(
      this.#options.tableId,
      this.#options.query,
      this.#options.permissionVersion,
      index,
    );
    const fetchBlock = this.#options.fetchBlock;
    const fetchRows: QueryFunction<RecordListResponse, BlockKey> =
      fetchBlock === undefined
        ? (base.queryFn as QueryFunction<RecordListResponse, BlockKey>)
        : async ({ signal }) => {
            const data = await fetchBlock(index, signal);
            const records = keepPendingCells(
              this.#options.queryClient,
              this.#options.tableId,
              data.records,
            );
            return records === data.records ? data : { ...data, records: [...records] };
          };
    const queryFn: QueryFunction<RecordListResponse, BlockKey> = async (context) => {
      const data = await fetchRows(context);
      // A fresh total counts every record created so far.
      if ('total' in data) this.#uncounted.clear();
      return data;
    };
    // `base.queryKey` unless the loader has a scope (T417).
    const queryKey =
      this.#options.scope === undefined ? base.queryKey : (this.#key(index) as BlockKey);
    return { queryKey, queryFn, gcTime: BLOCK_GC_TIME };
  }

  #ensure(index: number): void {
    this.#lru.touch(index);
    if (this.#entries.has(index)) return;
    const observer = new QueryObserver<
      RecordListResponse,
      Error,
      RecordListResponse,
      RecordListResponse,
      BlockKey
    >(this.#options.queryClient, {
      ...this.#blockQuery(index),
      // Rows of the loader this one replaced, until the block arrives (`previous`).
      placeholderData: () => this.#placeholders.get(index),
    });
    const entry: BlockEntry = {
      observer,
      unsubscribe: () => undefined,
      rows: undefined,
      failed: false,
    };
    this.#entries.set(index, entry);
    entry.unsubscribe = observer.subscribe((result) => {
      this.#onResult(index, result);
    });
    this.#onResult(index, observer.getCurrentResult());
  }

  /** Stops observing a block and removes it from the query cache (aborting a fetch). */
  #drop(index: number, alreadyEvicted = false): void {
    const entry = this.#entries.get(index);
    if (entry === undefined) return;
    entry.unsubscribe();
    this.#entries.delete(index);
    if (!alreadyEvicted) this.#lru.delete(index);
    this.#removeQuery(index);
  }

  #removeQuery(index: number): void {
    this.#options.queryClient.removeQueries({ queryKey: this.#key(index), exact: true });
  }

  #onResult(index: number, result: QueryObserverResult<RecordListResponse>): void {
    const entry = this.#entries.get(index);
    if (entry === undefined) return;
    const data = result.data;
    const rowsChanged = data !== undefined && data.records !== entry.rows;
    if (data !== undefined) {
      entry.rows = data.records;
      this.#updateCount(index, data);
      // New rows now shown (appended by the edit flow, or loaded) leave the pill.
      if (rowsChanged && this.#newIds.size > 0) {
        for (const record of data.records) this.#newIds.delete(record.id);
      }
      // …and, if the count did not include them yet, now it does: the grid
      // grows so that they are shown (never a row fetched but cut off).
      if (rowsChanged && this.#uncounted.size > 0) this.#countShown(data.records);
    }
    const failed = result.status === 'error' && result.fetchStatus === 'idle';
    const failureChanged = failed !== entry.failed;
    entry.failed = failed;
    if (failed) this.#error = result.error;
    else if (failureChanged && ![...this.#entries.values()].some((item) => item.failed)) {
      this.#error = null;
    }
    if (rowsChanged || failureChanged) this.#emit();
  }

  /** Records announced by realtime found in a loaded block: counted now. */
  #countShown(records: readonly RecordDto[]): void {
    let shown = 0;
    for (const record of records) {
      if (this.#uncounted.delete(record.id)) shown += 1;
    }
    if (shown === 0 || this.#rowCount === null || this.#estimated) return;
    this.#rowCount += shown;
    this.#shiftTotal(shown);
    queueMicrotask(() => {
      if (this.#applied !== null) this.#apply(this.#applied, false);
    });
  }

  /**
   * Row count (FRONTEND §3.3): `total` of block 0, else `total_estimate`
   * until the end is reached — a block with fewer than 200 rows gives the
   * exact count; a full block at the estimated end extends it by one row so
   * the next block is requested (followed while the user stays at the end).
   */
  #updateCount(index: number, data: RecordListResponse): void {
    const before = this.#rowCount;
    if ('total' in data) {
      this.#rowCount = data.total;
      this.#estimated = false;
    } else if ('total_estimate' in data && (this.#rowCount === null || this.#estimated)) {
      this.#rowCount = data.total_estimate;
      this.#estimated = true;
    }
    const length = data.records.length;
    const end = index * RECORD_BLOCK_SIZE + length;
    const counting = this.#estimated || this.#rowCount === null;
    if (counting && length < RECORD_BLOCK_SIZE && (length > 0 || index === 0)) {
      // A short block is the last one: the count is exact now.
      this.#rowCount = end;
      this.#estimated = false;
    } else if (counting && length === 0) {
      // Past the end: the table ends somewhere in an earlier block — exactly
      // here when the block before is loaded and full.
      this.#rowCount = Math.min(this.#rowCount ?? end, end);
      if (this.#entries.get(index - 1)?.rows?.length === RECORD_BLOCK_SIZE) {
        this.#estimated = false;
      }
    } else if (this.#estimated && this.#rowCount !== null && end >= this.#rowCount) {
      // A full block at the estimated end: there may be more, ask for the next
      // block — unless it already came back empty (it may answer first): then
      // the table ends exactly here.
      if (this.#entries.get(index + 1)?.rows?.length === 0) {
        this.#rowCount = end;
        this.#estimated = false;
      } else {
        this.#rowCount = end + 1;
      }
    }
    if (this.#rowCount !== before && this.#applied !== null) {
      // A new count changes which blocks exist (the first count clips the
      // needed blocks to the table; a longer estimate adds a block to follow).
      queueMicrotask(() => {
        if (this.#applied !== null) this.#apply(this.#applied, false);
      });
    }
  }

  #emit(): void {
    const rowCount = this.#rowCount;
    this.#snapshot = {
      status: rowCount !== null ? 'ready' : this.#error !== null ? 'error' : 'loading',
      rowCount: rowCount ?? 0,
      estimated: this.#estimated,
      error: this.#error,
      version: this.#snapshot.version + 1,
      newRows: this.#newIds.size,
      stale: this.#stale,
    };
    for (const listener of this.#listeners) listener();
  }
}
