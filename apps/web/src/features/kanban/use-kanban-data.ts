import { useQueries, useQuery } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';

import {
  buildColumns,
  columnKeyOf,
  countsByColumn,
  mergeUsers,
  placeCards,
  usersOfGroups,
  type ColumnUser,
  type KanbanColumnDef,
} from './board';
import {
  arrivalsQuery,
  groupCountsQuery,
  KANBAN_PAGE_SIZE,
  kanbanPageQuery,
  type BoardQuery,
} from './queries';

import type { FieldDto, RecordDto } from '@cellhive/contracts';

export interface KanbanColumnState {
  readonly def: KanbanColumnDef;
  /** Cards in display order (arrivals first, then server order). */
  readonly cards: readonly RecordDto[];
  /** Records of the column (`group-counts`), `null` until known. */
  readonly count: number | null;
  /** First page on its way (skeleton cards). */
  readonly loading: boolean;
  /** More pages exist on the server. */
  readonly hasMore: boolean;
  /** A next page is on its way. */
  readonly loadingMore: boolean;
  readonly error: unknown;
}

/** Which columns the board shows and which of them load their cards. */
export interface BoardWindow {
  /** Columns without any record are left out (`kanban.hide_empty_columns`). */
  readonly hideEmpty: boolean;
  /** Index range (in shown columns) of the columns on screen, plus one on each side. */
  readonly first: number;
  readonly last: number;
}

export interface KanbanData {
  /** Every column of the group field. */
  readonly columns: readonly KanbanColumnState[];
  /** The columns shown (all, or the non-empty ones). */
  readonly shown: readonly KanbanColumnState[];
  readonly countsError: unknown;
  /** Loads the next page of a column (no-op while one is on its way or at the end). */
  readonly loadMore: (column: string) => void;
  /** Fetches the failed pages and counts again. */
  readonly retry: () => void;
  /** The column a record belongs to by its current group value. */
  readonly columnOf: (record: RecordDto) => string;
}

interface PageSpec {
  readonly column: string;
  readonly index: number;
}

interface PageState {
  readonly data: { readonly records: readonly RecordDto[] } | undefined;
  readonly pending: boolean;
  readonly fetching: boolean;
  readonly error: unknown;
  readonly refetch: () => unknown;
}

const NO_RECORDS: readonly RecordDto[] = [];

/**
 * The cards and counts of a kanban board. Only columns in the window (on
 * screen) with at least one record load their pages; each column starts
 * with one page and grows with {@link KanbanData.loadMore}.
 */
export function useKanbanData(query: BoardQuery, field: FieldDto, range: BoardWindow): KanbanData {
  const counts = useQuery(groupCountsQuery(query));
  const arrivals = useQuery(arrivalsQuery(query));

  // Members met on a user board stay columns for the session (a column emptied by a move
  // is still a drop target): merged when new counts arrive (state from the previous render).
  const [users, setUsers] = useState<readonly ColumnUser[]>([]);
  const groups = counts.data?.groups;
  const [mergedGroups, setMergedGroups] = useState<typeof groups>(undefined);
  if (groups !== mergedGroups) {
    setMergedGroups(groups);
    if (query.kind === 'user' && groups !== undefined) {
      const merged = mergeUsers(users, usersOfGroups(groups));
      if (merged.length !== users.length || merged.some((user, i) => user !== users[i])) {
        setUsers(merged);
      }
    }
  }

  const defs = useMemo(() => buildColumns(field, query.kind, users), [field, query.kind, users]);
  const countMap = useMemo(
    () => (groups === undefined ? null : countsByColumn(field, query.kind, groups)),
    [field, query.kind, groups],
  );

  const { hideEmpty, first, last } = range;
  const active = useMemo(() => {
    if (countMap === null) return new Set<string>();
    const counted = hideEmpty ? defs.filter((def) => (countMap.get(def.key) ?? 0) > 0) : defs;
    return new Set(counted.slice(first, last + 1).map((def) => def.key));
  }, [countMap, defs, hideEmpty, first, last]);

  const [pageCounts, setPageCounts] = useState<Readonly<Record<string, number>>>({});
  const specs = useMemo<PageSpec[]>(() => {
    if (countMap === null) return [];
    return defs.flatMap((def) => {
      // Empty columns need no request; off-screen ones wait until scrolled to.
      if ((countMap.get(def.key) ?? 0) === 0 || !active.has(def.key)) return [];
      const pages = pageCounts[def.key] ?? 1;
      return Array.from({ length: pages }, (_, index) => ({ column: def.key, index }));
    });
  }, [defs, countMap, active, pageCounts]);

  const pages = useQueries({
    queries: specs.map((spec) => kanbanPageQuery(query, spec.column, spec.index)),
    combine: (results) =>
      results.map((result): PageState => ({
        data: result.data,
        pending: result.isPending,
        fetching: result.isFetching,
        error: result.error,
        refetch: result.refetch,
      })),
  });

  const groupFieldId = query.groupFieldId;
  const kind = query.kind;
  const columnOf = useCallback(
    (record: RecordDto) => columnKeyOf(field, kind, record.fields[groupFieldId] ?? null),
    [field, kind, groupFieldId],
  );

  const arrivalRecords = arrivals.data?.records ?? NO_RECORDS;
  const byColumn = useMemo(() => {
    const loaded = new Map<string, RecordDto[]>();
    const state = new Map<
      string,
      { loading: boolean; hasMore: boolean; loadingMore: boolean; error: unknown }
    >();
    specs.forEach((spec, i) => {
      const page = pages[i];
      if (page === undefined) return;
      const current = state.get(spec.column) ?? {
        loading: false,
        hasMore: false,
        loadingMore: false,
        error: null,
      };
      if (page.data === undefined) {
        state.set(spec.column, {
          ...current,
          loading: current.loading || spec.index === 0,
          loadingMore: current.loadingMore || spec.index > 0,
          error: page.error ?? current.error,
        });
        return;
      }
      const records = loaded.get(spec.column) ?? [];
      records.push(...page.data.records);
      loaded.set(spec.column, records);
      state.set(spec.column, {
        ...current,
        // The last page decides: a full page means more may follow.
        hasMore: page.data.records.length === KANBAN_PAGE_SIZE,
        error: page.error ?? current.error,
      });
    });
    return { loaded, state };
  }, [specs, pages]);

  const columns = useMemo<KanbanColumnState[]>(() => {
    const cards = placeCards(defs, byColumn.loaded, arrivalRecords, columnOf);
    return defs.map((def) => {
      const count = countMap === null ? null : (countMap.get(def.key) ?? 0);
      const state = byColumn.state.get(def.key);
      return {
        def,
        cards: cards.get(def.key) ?? [],
        count,
        // Counted cards not asked for yet (off screen) show as loading too.
        loading: count === null || state?.loading === true || (count > 0 && state === undefined),
        hasMore: state?.hasMore ?? false,
        loadingMore: state?.loadingMore ?? false,
        error: state?.error ?? null,
      };
    });
  }, [defs, byColumn, arrivalRecords, columnOf, countMap]);

  const shown = useMemo(
    () =>
      hideEmpty
        ? columns.filter(
            // Until counted, every column shows (skeletons).
            (column) => column.count === null || column.count > 0 || column.cards.length > 0,
          )
        : columns,
    [columns, hideEmpty],
  );

  const loadMore = useCallback(
    (column: string) => {
      const state = byColumn.state.get(column);
      if (state === undefined || !state.hasMore || state.loadingMore || state.loading) return;
      setPageCounts((current) => ({ ...current, [column]: (current[column] ?? 1) + 1 }));
    },
    [byColumn],
  );

  const refetchCounts = counts.refetch;
  const retry = useCallback(() => {
    if (counts.error !== null) void refetchCounts();
    for (const page of pages) {
      if (page.error !== null) void page.refetch();
    }
  }, [counts.error, refetchCounts, pages]);

  return { columns, shown, countsError: counts.error, loadMore, retry, columnOf };
}
