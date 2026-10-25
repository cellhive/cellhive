import { recordTreeApi } from '../../../lib/api/record-tree';
import { keys, type EffectiveRecordQuery } from '../../../lib/query/keys';
import { RECORD_BLOCK_SIZE, recordBlockRange } from '../../../lib/query/queries';
import { applyRecordPatch, type RecordPatch } from '../../../lib/records/realtime-merge';
import { RecordBlockLoader, type RecordCachePatcher } from '../blocks/block-loader';
import { PREFETCH_DISTANCE, type RowRange } from '../blocks/block-math';

import { EMPTY_TREE, TreeRowModel, type TreeLevelInput, type TreeRowPlace } from './tree-model';

import type { RecordCache } from '../../../lib/records/edit-controller';
import type { RecordDto, RecordListResponse, TreeRecordDto } from '@cellhive/contracts';
import type { QueryClient } from '@tanstack/react-query';

/** Most levels of a tree (SPEC §5.7): a record at depth 9 has no children. */
export const TREE_MAX_LEVELS = 10;

/** Marks the block keys of a tree's levels (`BlockLoaderOptions.scope`). */
const TREE_SCOPE = '#tree:';

/** Realtime changes are applied this long after the last one (like group moves, T312). */
export const TREE_REFRESH_MS = 150;

/**
 * Marked when the first rows of an opened branch are laid out (FRONTEND
 * §11.1, local only: the E2E perf test measures "expand < 300 ms" from the
 * click on the caret).
 */
export const BRANCH_ROWS_MARK = 'app:tree:branch-rows';

/** One level's rows from the server (`POST …/records/tree`; tests replace it). */
export type FetchTreeLevel = (
  parentId: string | null,
  index: number,
  signal: AbortSignal,
) => Promise<RecordListResponse>;

export interface TreeRowsOptions {
  readonly queryClient: QueryClient;
  readonly tableId: string;
  /** The grid's effective query (view, temporary filter/sort, search); its group is never sent. */
  readonly query: EffectiveRecordQuery;
  /** Filtered: also the readable ancestors of the matches, dimmed (`ancestor_only`). */
  readonly showAncestors: boolean;
  readonly permissionVersion: number;
  /** The `parent` field: a realtime change of it moves a record in the tree. */
  readonly parentFieldId: string | null;
  /** Whether a record (at `depth`) shows its children. */
  readonly isExpanded: (recordId: string, depth: number, open?: boolean) => boolean;
  readonly fetchLevel?: FetchTreeLevel;
}

export interface TreeSnapshot {
  readonly status: 'loading' | 'ready' | 'error';
  /** Rows of the layout (roots and expanded branches). */
  readonly rowCount: number;
  /** The roots are counted by estimate (more than 100 000). */
  readonly estimated: boolean;
  readonly error: unknown;
  /** Increases whenever rows or the layout change (the grid redraws). */
  readonly version: number;
  readonly newRows: number;
  readonly stale: boolean;
}

/** What the grid needs to know about a row of the tree. */
export interface TreeNode {
  readonly recordId: string | undefined;
  /** 0 for a root. */
  readonly depth: number;
  readonly parentId: string | null;
  /** Record ids from the root down to the parent. */
  readonly ancestors: readonly string[];
  /** Children in the visible tree (0: a leaf). */
  readonly childCount: number;
  readonly expanded: boolean;
  /** Shown only as an ancestor of a filter match: dimmed. */
  readonly ancestorOnly: boolean;
  /** Level offset (siblings before it). */
  readonly offset: number;
}

type Listener = () => void;

function isTreeRecord(record: RecordDto | undefined): record is TreeRecordDto {
  return record !== undefined && 'tree' in record;
}

function treeOf(record: RecordDto | undefined): TreeRecordDto['tree'] | undefined {
  return isTreeRecord(record) ? record.tree : undefined;
}

/** The body of `records/tree` for a grid query (CONTRACTS §1.4): the group is not sent. */
export function treeLevelBody(
  query: EffectiveRecordQuery,
  showAncestors: boolean,
  parentId: string | null,
  index: number,
) {
  return {
    view_id: query.view_id ?? null,
    parent_id: parentId as `rec_${string}` | null,
    filter: query.filter ?? null,
    ...(query.filter_mode === undefined ? {} : { filter_mode: query.filter_mode }),
    sort: query.sort === undefined || query.sort === null ? null : [...query.sort],
    ...(query.sort_mode === undefined ? {} : { sort_mode: query.sort_mode }),
    search: query.search ?? null,
    show_ancestors: showAncestors,
    fields: query.fields === undefined || query.fields === null ? null : [...query.fields],
    ...recordBlockRange(index),
    include_total: index === 0,
  };
}

/**
 * The rows of a grid shown as a sub-record tree (T417, FRONTEND §3.3).
 *
 * Every level is a `RecordBlockLoader` on `POST …/records/tree` (blocks of
 * 200, abort on fast scroll, LRU, optimistic writes and realtime patches
 * through the query cache, `keys.recordBlocks` prefix): the roots, and one
 * loader per expanded branch, made when its rows come into view (or when
 * it is expanded). The layout (`TreeRowModel`) is rebuilt whenever a
 * level's rows or count change and the grid's viewport is split into each
 * level's offsets, so collapsed branches are never fetched.
 *
 * It is also the edit flow's record cache and the realtime patcher of the
 * grid: cells are patched in place; a move, a new or removed record
 * refreshes the levels shown (a moved record changes two parents' counts).
 */
export class TreeRows implements RecordCachePatcher {
  readonly #options: TreeRowsOptions;
  readonly #root: RecordBlockLoader;
  readonly #branches = new Map<string, { loader: RecordBlockLoader; off: () => void }>();
  /** Branches whose first rows were marked (`BRANCH_ROWS_MARK`). */
  readonly #marked = new Set<string>();
  readonly #listeners = new Set<Listener>();
  #offRoot: (() => void) | null = null;
  #isExpanded: (recordId: string, depth: number, open?: boolean) => boolean;
  #model: TreeRowModel = EMPTY_TREE;
  #viewport: { firstRow: number; lastRow: number; dragging: boolean } | null = null;
  #dirty = false;
  #attached = false;
  #refreshTimer: ReturnType<typeof setTimeout> | undefined;
  #snapshot: TreeSnapshot = {
    status: 'loading',
    rowCount: 0,
    estimated: false,
    error: null,
    version: 0,
    newRows: 0,
    stale: false,
  };

  constructor(options: TreeRowsOptions) {
    this.#options = options;
    this.#isExpanded = options.isExpanded;
    this.#root = this.#loader(null, false);
  }

  // --- external store ---------------------------------------------------------------

  readonly subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly getSnapshot = (): TreeSnapshot => this.#snapshot;

  get model(): TreeRowModel {
    return this.#model;
  }

  attach(): void {
    if (this.#attached) return;
    this.#attached = true;
    this.#offRoot = this.#root.subscribe(this.#changed);
    this.#root.attach();
    for (const branch of this.#branches.values()) branch.loader.attach();
    this.#rebuild();
  }

  detach(): void {
    if (!this.#attached) return;
    this.#attached = false;
    clearTimeout(this.#refreshTimer);
    this.#offRoot?.();
    this.#offRoot = null;
    this.#root.detach();
    for (const branch of this.#branches.values()) branch.loader.detach();
  }

  /** New expand state (a branch toggled, "open N levels"): the layout changes. */
  setExpansion(isExpanded: (recordId: string, depth: number, open?: boolean) => boolean): void {
    this.#isExpanded = isExpanded;
    this.#rebuild();
  }

  // --- rows ---------------------------------------------------------------------------

  /** The record of a data row, `undefined` while its block loads. */
  getRecord(row: number): RecordDto | undefined {
    const place = this.#model.placeOf(row);
    if (place === undefined) return undefined;
    return this.#levelLoader(place.level.parentId)?.getRecord(place.offset);
  }

  /** Some loaded row is shown only as an ancestor of a match (the grid explains the dimmed rows). */
  hasAncestorOnly(): boolean {
    for (const loader of [this.#root, ...[...this.#branches.values()].map((b) => b.loader)]) {
      for (const block of loader.cachedBlocks()) {
        const first = block * RECORD_BLOCK_SIZE;
        for (let offset = first; offset < first + RECORD_BLOCK_SIZE; offset += 1) {
          const record = loader.getRecord(offset);
          if (record === undefined) break;
          if (treeOf(record)?.ancestor_only === true) return true;
        }
      }
    }
    return false;
  }

  placeOf(row: number): TreeRowPlace | undefined {
    return this.#model.placeOf(row);
  }

  /** What the grid draws for a row (indent, caret, count, dimmed). */
  nodeAt(row: number): TreeNode | undefined {
    const place = this.#model.placeOf(row);
    if (place === undefined) return undefined;
    const record = this.#levelLoader(place.level.parentId)?.getRecord(place.offset);
    const tree = treeOf(record);
    const depth = place.level.depth;
    const childCount = record === undefined ? 0 : this.#childCount(record.id, tree);
    return {
      recordId: record?.id,
      depth,
      parentId: place.level.parentId,
      ancestors: place.level.ancestors,
      childCount,
      expanded:
        record !== undefined &&
        childCount > 0 &&
        depth < TREE_MAX_LEVELS - 1 &&
        this.#isExpanded(record.id, depth, tree?.ancestor_only === true),
      ancestorOnly: tree?.ancestor_only === true,
      offset: place.offset,
    };
  }

  /** Data row of a record shown in the tree. */
  rowOf(recordId: string): number | undefined {
    const offset = this.#root.rowOf(recordId);
    if (offset !== undefined) return this.#model.rowOf(null, offset);
    for (const [parentId, branch] of this.#branches) {
      const found = branch.loader.rowOf(recordId);
      if (found !== undefined) return this.#model.rowOf(parentId, found);
    }
    return undefined;
  }

  findRecord(recordId: string): RecordDto | undefined {
    const root = this.#root.findRecord(recordId);
    if (root !== undefined) return root;
    for (const branch of this.#branches.values()) {
      const found = branch.loader.findRecord(recordId);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  /** Records of rows `firstRow`…`lastRow`, loading what is missing (paste, copy, fill). */
  async loadRows(firstRow: number, lastRow: number): Promise<(RecordDto | undefined)[]> {
    const length = Math.max(0, lastRow - firstRow + 1);
    const result: (RecordDto | undefined)[] = Array.from({ length }, () => undefined);
    const jobs: Promise<void>[] = [];
    let row = firstRow;
    while (row <= lastRow) {
      const place = this.#model.placeOf(row);
      if (place === undefined) break;
      // A run of rows of one level (up to the next branch or the end).
      let end = row;
      while (end + 1 <= lastRow) {
        const next = this.#model.placeOf(end + 1);
        if (next?.level !== place.level || next.offset !== place.offset + (end + 1 - row)) break;
        end += 1;
      }
      const loader = this.#ensureLoader(place.level.parentId);
      const start = row;
      jobs.push(
        loader.loadRows(place.offset, place.offset + (end - start)).then((records) => {
          records.forEach((record, index) => {
            result[start - firstRow + index] = record;
          });
        }),
      );
      row = end + 1;
    }
    await Promise.all(jobs);
    return result;
  }

  /** The viewport in data rows: every level loads the offsets it shows (± a block). */
  setViewport(firstRow: number, lastRow: number, dragging: boolean): void {
    this.#viewport = { firstRow, lastRow, dragging };
    this.#applyViewport();
  }

  /** Loads a branch's first rows at once (expanding it: children in < 300 ms). */
  prefetchBranch(recordId: string): void {
    this.#ensureLoader(recordId);
  }

  /** Fetches every level shown again (moves, realtime, pill). */
  refresh(): Promise<void> {
    clearTimeout(this.#refreshTimer);
    this.#refreshTimer = undefined;
    // Only the tree's levels: the flat grid of the same page is idle meanwhile.
    return this.#options.queryClient.invalidateQueries({
      queryKey: keys.recordBlocks(this.#options.tableId),
      predicate: (query) => {
        const hash = query.queryKey[3];
        return typeof hash === 'string' && hash.includes(TREE_SCOPE);
      },
    });
  }

  /** `refresh` once realtime messages stop arriving (a batch of moves). */
  refreshSoon(): void {
    clearTimeout(this.#refreshTimer);
    this.#refreshTimer = setTimeout(() => {
      void this.refresh();
    }, TREE_REFRESH_MS);
  }

  retry(): void {
    this.#root.retry();
    for (const branch of this.#branches.values()) branch.loader.retry();
  }

  showNewRows(): void {
    void this.refresh();
  }

  // --- the edit flow's cache (FRONTEND §4.1) -----------------------------------------------

  /** Writes of the grid's edit flow: cells in place, new or removed records refresh the tree. */
  readonly cache: RecordCache = {
    get: (recordId) => this.findRecord(recordId),
    patch: (recordId, fields) => {
      this.#root.updateRecord(recordId, (record) => ({
        ...record,
        fields: { ...record.fields, ...fields },
      }));
      this.#movedBy(fields);
    },
    replace: (record) => {
      // The server's answer has no `tree`: the one shown is kept.
      this.#root.updateRecord(record.id, (current) => ({ ...current, ...record }));
    },
    patchMany: (patches) => {
      for (const fields of patches.values()) this.#movedBy(fields);
      this.#root.updateRecords(
        new Map(
          [...patches].map(([recordId, fields]) => [
            recordId,
            (record: RecordDto) => ({ ...record, fields: { ...record.fields, ...fields } }),
          ]),
        ),
      );
    },
    replaceMany: (records) => {
      this.#root.updateRecords(
        new Map(
          records.map((record) => [record.id, (current: RecordDto) => ({ ...current, ...record })]),
        ),
      );
    },
    // A new record goes where the server puts it (a root, or under its parent).
    append: () => {
      void this.refresh();
      return null;
    },
    appendMany: () => {
      void this.refresh();
    },
    remove: (recordIds) => {
      this.removeRecords(recordIds);
    },
  };

  // --- realtime (FRONTEND §5) -----------------------------------------------------------

  applyRecordUpdate(recordId: string, patch: RecordPatch): boolean {
    const changed = applyRecordPatch(
      this.#options.queryClient,
      this.#options.tableId,
      recordId,
      patch,
    );
    const parentFieldId = this.#options.parentFieldId;
    if (parentFieldId !== null && parentFieldId in patch.fields) this.refreshSoon();
    return changed;
  }

  removeRecords(recordIds: readonly string[]): number {
    let removed = this.#root.removeRecords(recordIds);
    for (const branch of this.#branches.values()) {
      removed += branch.loader.removeRecords(recordIds);
    }
    // Parents' counts change too.
    this.refreshSoon();
    return removed;
  }

  noteNewRecord(): void {
    this.refreshSoon();
  }

  leaveQuery(recordIds: readonly string[]): void {
    const shown = recordIds.filter((id) => this.findRecord(id) !== undefined);
    if (shown.length > 0) this.removeRecords(shown);
  }

  markStale(): void {
    // Siblings are sorted on the server: a changed sort key reorders them in place.
    this.refreshSoon();
  }

  hasRecord(recordId: string): boolean {
    return this.findRecord(recordId) !== undefined;
  }

  upsertRecords(): void {
    this.refreshSoon();
  }

  refetchVisible(): void {
    void this.refresh();
  }

  resync(): void {
    void this.refresh();
  }

  // --- internals ---------------------------------------------------------------------------

  /** A write of the parent field (undo of a move, paste) moves the record: the tree reloads. */
  #movedBy(fields: Readonly<Record<string, unknown>>): void {
    const parentFieldId = this.#options.parentFieldId;
    if (parentFieldId !== null && parentFieldId in fields) this.refreshSoon();
  }

  #loader(parentId: string | null, waitForViewport: boolean): RecordBlockLoader {
    const { queryClient, tableId, query, permissionVersion, showAncestors } = this.#options;
    const fetchLevel = this.#options.fetchLevel;
    return new RecordBlockLoader({
      queryClient,
      tableId,
      query,
      permissionVersion,
      waitForViewport,
      // `#` + scope ends the query hash: `…#tree:a:rec_…` (see TREE_SCOPE).
      scope: `tree:${showAncestors ? 'a' : 'm'}:${parentId ?? ''}`,
      fetchBlock: (index, signal) =>
        fetchLevel === undefined
          ? recordTreeApi.level(tableId, treeLevelBody(query, showAncestors, parentId, index), {
              signal,
            })
          : fetchLevel(parentId, index, signal),
    });
  }

  #levelLoader(parentId: string | null): RecordBlockLoader | undefined {
    return parentId === null ? this.#root : this.#branches.get(parentId)?.loader;
  }

  #ensureLoader(parentId: string | null): RecordBlockLoader {
    const existing = this.#levelLoader(parentId);
    if (existing !== undefined) return existing;
    const id = parentId ?? '';
    const loader = this.#loader(id, false);
    const off = loader.subscribe(this.#changed);
    this.#branches.set(id, { loader, off });
    if (this.#attached) loader.attach();
    return loader;
  }

  /** Children of a record in the visible tree: its level's count once loaded, else `children_count`. */
  #childCount(recordId: string, tree: TreeRecordDto['tree'] | undefined): number {
    const branch = this.#branches.get(recordId)?.loader.getSnapshot();
    if (branch?.status === 'ready') return branch.rowCount;
    return tree?.children_count ?? 0;
  }

  readonly #changed = () => {
    if (this.#dirty) return;
    this.#dirty = true;
    queueMicrotask(() => {
      if (this.#dirty) this.#rebuild();
    });
  };

  /** The layout from the loaded rows, then what the viewport needs now. */
  #rebuild(): void {
    this.#dirty = false;
    const root = this.#root.getSnapshot();
    const shown = new Set<string>();
    const level = (
      loader: RecordBlockLoader | undefined,
      count: number,
      depth: number,
    ): TreeLevelInput => {
      if (loader === undefined || depth >= TREE_MAX_LEVELS - 1) return { count, expanded: [] };
      const expanded: TreeLevelInput['expanded'][number][] = [];
      for (const block of loader.cachedBlocks()) {
        const first = block * RECORD_BLOCK_SIZE;
        for (let offset = first; offset < first + RECORD_BLOCK_SIZE; offset += 1) {
          const record = loader.getRecord(offset);
          if (record === undefined) break;
          const tree = treeOf(record);
          const children = this.#childCount(record.id, tree);
          // Ancestors shown for a filter match open by default: the match is what counts.
          const open = this.#isExpanded(record.id, depth, tree?.ancestor_only === true);
          if (children === 0 || !open) continue;
          shown.add(record.id);
          const child = this.#branches.get(record.id)?.loader;
          expanded.push({ offset, recordId: record.id, child: level(child, children, depth + 1) });
        }
      }
      return { count, expanded };
    };
    const rootCount = root.status === 'ready' ? root.rowCount : 0;
    this.#model = new TreeRowModel(level(this.#root, rootCount, 0));
    // Branches no longer shown (collapsed, moved away) stop loading; their blocks stay cached.
    for (const [parentId, branch] of this.#branches) {
      if (shown.has(parentId)) continue;
      branch.off();
      branch.loader.detach();
      this.#branches.delete(parentId);
    }
    const errors = [
      root.error,
      ...[...this.#branches.values()].map((b) => b.loader.getSnapshot().error),
    ];
    const error = errors.find((item) => item !== null) ?? null;
    this.#snapshot = {
      status: root.status,
      rowCount: this.#model.rowCount,
      estimated: root.estimated,
      error,
      version: this.#snapshot.version + 1,
      newRows: 0,
      stale: false,
    };
    for (const listener of this.#listeners) listener();
    for (const [parentId, branch] of this.#branches) {
      if (this.#marked.has(parentId) || branch.loader.getRecord(0) === undefined) continue;
      this.#marked.add(parentId);
      if (typeof performance.mark === 'function') performance.mark(BRANCH_ROWS_MARK);
    }
    if (this.#viewport !== null)
      queueMicrotask(() => {
        this.#applyViewport();
      });
  }

  #applyViewport(): void {
    const viewport = this.#viewport;
    if (viewport === null || !this.#attached) return;
    const { firstRow, lastRow, dragging } = viewport;
    const model = this.#model;
    const visible = model.offsetRanges(firstRow, lastRow);
    const needed = model.offsetRanges(
      firstRow - RECORD_BLOCK_SIZE,
      lastRow + RECORD_BLOCK_SIZE + PREFETCH_DISTANCE,
    );
    // Before the roots are counted: their first rows.
    if (model.rowCount === 0) {
      this.#root.setViewport({ firstRow: 0, lastRow: Math.max(0, lastRow) }, dragging);
      return;
    }
    for (const [parentId, ranges] of needed) {
      const loader = this.#ensureLoader(parentId);
      const shown = visible.get(parentId) ?? [];
      const all = [...ranges, ...shown];
      const span: RowRange = {
        firstRow: Math.min(...all.map((range) => range.firstRow)),
        lastRow: Math.max(...all.map((range) => range.lastRow)),
      };
      loader.setViewport(span, dragging, { visible: shown, needed: ranges });
    }
  }
}
