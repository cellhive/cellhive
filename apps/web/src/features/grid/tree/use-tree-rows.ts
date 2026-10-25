import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';

import { recordQueryHash, type EffectiveRecordQuery } from '../../../lib/query/keys';

import { useTreeExpand, type TreeExpand } from './expand-state';
import { TreeRows, type TreeSnapshot } from './tree-rows';

export interface TreeRowsHookOptions {
  /** The view shows a tree (`config.tree.enabled`) and the table has a `parent` field. */
  readonly active: boolean;
  readonly tableId: string;
  readonly viewId: string;
  readonly userId: string | null;
  readonly query: EffectiveRecordQuery;
  readonly showAncestors: boolean;
  readonly permissionVersion: number;
  readonly parentFieldId: string | null;
}

export interface TreeRowsState {
  readonly active: boolean;
  /** The tree's rows; `null` when the view is flat. */
  readonly rows: TreeRows | null;
  readonly snapshot: TreeSnapshot;
  readonly expand: TreeExpand;
}

const IDLE: TreeSnapshot = {
  status: 'loading',
  rowCount: 0,
  estimated: false,
  error: null,
  version: 0,
  newRows: 0,
  stale: false,
};

const noop = () => () => undefined;

/**
 * The rows of a grid view shown as a sub-record tree (T417, FRONTEND §3.3):
 * a `TreeRows` for the effective query (a new query or `permission_version`
 * starts again from the roots) and the user's open branches.
 */
export function useTreeRows({
  active,
  tableId,
  viewId,
  userId,
  query,
  showAncestors,
  permissionVersion,
  parentFieldId,
}: TreeRowsHookOptions): TreeRowsState {
  const queryClient = useQueryClient();
  const expand = useTreeExpand(userId, viewId);
  const hash = recordQueryHash(query);
  const isExpanded = useRef(expand.isExpanded);
  useEffect(() => {
    isExpanded.current = expand.isExpanded;
  });
  const rows = useMemo(
    () =>
      active
        ? new TreeRows({
            queryClient,
            tableId,
            query,
            showAncestors,
            permissionVersion,
            parentFieldId,
            // Read when the rows are made; later states arrive through `setExpansion`.
            // eslint-disable-next-line react-hooks/refs
            isExpanded: isExpanded.current,
          })
        : null,
    // `query` is represented by its hash.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [active, queryClient, tableId, hash, showAncestors, permissionVersion, parentFieldId],
  );
  useEffect(() => {
    if (rows === null) return;
    rows.attach();
    return () => {
      rows.detach();
    };
  }, [rows]);
  useEffect(() => {
    rows?.setExpansion(expand.isExpanded);
  }, [rows, expand.isExpanded]);
  const snapshot = useSyncExternalStore(
    rows === null ? noop : rows.subscribe,
    rows === null ? () => IDLE : rows.getSnapshot,
  );
  return { active: rows !== null, rows, snapshot, expand };
}
