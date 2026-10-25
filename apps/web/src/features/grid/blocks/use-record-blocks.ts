import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';

import { recordQueryHash, type EffectiveRecordQuery } from '../../../lib/query/keys';

import { RecordBlockLoader, type BlockLoaderOptions, type BlockSnapshot } from './block-loader';

import type {
  FetchRecordBlock,
  UseWindowedRows,
  WindowedRows,
} from '../../../lib/share/public-page';

export interface RecordBlocks {
  readonly loader: RecordBlockLoader;
  readonly snapshot: BlockSnapshot;
}

/**
 * The windowed rows of a table for the effective query (FRONTEND §3.3). A
 * change of the query hash gives a new loader, i.e. the grid starts again
 * from block 0. A new `permission_version` (bumped by every field or table
 * created for instance) also gives a new loader, but it keeps the rows of
 * the old one on screen until its blocks arrive (`previous`).
 */
export function useRecordBlocks(
  tableId: string,
  query: EffectiveRecordQuery,
  permissionVersion: number,
  options: Pick<BlockLoaderOptions, 'waitForViewport'> = {},
): RecordBlocks {
  const queryClient = useQueryClient();
  const hash = recordQueryHash(query);
  const current = useRef<RecordBlockLoader | undefined>(undefined);
  const loader = useMemo(
    () =>
      new RecordBlockLoader({
        queryClient,
        tableId,
        query,
        permissionVersion,
        // Read when the loader is made (grouped or not, T312).
        ...options,
        // Used only when the table and the query are the same (the loader checks).
        // eslint-disable-next-line react-hooks/refs
        ...(current.current === undefined ? {} : { previous: current.current }),
      }),
    // `query` is represented by its hash: an equal query keeps the loader.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queryClient, tableId, hash, permissionVersion],
  );
  useEffect(() => {
    current.current = loader;
    loader.attach();
    return () => {
      loader.detach();
    };
  }, [loader]);
  const snapshot = useSyncExternalStore(loader.subscribe, loader.getSnapshot);
  return { loader, snapshot };
}

/**
 * The windowed rows of a source other than `POST /tables/:id/records/query`
 * (T317: the public share page reads `POST /shares/:token/records/query`),
 * through the same block loader: blocks of 200 rows, visible ± 1, abort on
 * fast scroll, LRU of 30 blocks. The route hands it to the share page
 * (`SharePageParts.loadWindowedRows`, FRONTEND §1.2).
 */
export const useWindowedRecordBlocks: UseWindowedRows = (scope, query, fetchBlock) => {
  const queryClient = useQueryClient();
  const hash = recordQueryHash(query);
  // The loader keeps the first `fetchBlock`; later ones (same query) are read through the ref.
  const latestFetch = useRef(fetchBlock);
  useEffect(() => {
    latestFetch.current = fetchBlock;
  });
  const fetchLatest = useCallback<FetchRecordBlock>(
    (index, signal) => latestFetch.current(index, signal),
    [],
  );
  const loader = useMemo(
    () =>
      // Blocks are fetched after render (attach, viewport changes), never during it.
      // eslint-disable-next-line react-hooks/refs
      new RecordBlockLoader({
        queryClient,
        tableId: scope,
        query,
        permissionVersion: 0,
        fetchBlock: fetchLatest,
      }),
    // `query` is represented by its hash: an equal query keeps the loader.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queryClient, scope, hash, fetchLatest],
  );
  useEffect(() => {
    loader.attach();
    return () => {
      loader.detach();
    };
  }, [loader]);
  const snapshot = useSyncExternalStore(loader.subscribe, loader.getSnapshot);
  const rows = useMemo<WindowedRows>(
    () => ({
      getRecord: (row) => loader.getRecord(row),
      setViewport: (range, dragging) => {
        loader.setViewport(range, dragging);
      },
      loadRows: (firstRow, lastRow) => loader.loadRows(firstRow, lastRow),
      refresh: () => {
        loader.refetchVisible();
      },
      retry: () => {
        loader.retry();
      },
    }),
    [loader],
  );
  return { rows, snapshot };
};
