import { queryOptions } from '@tanstack/react-query';

import { api } from '../../../lib/api';
import { keys, recordQueryHash, type EffectiveRecordQuery } from '../../../lib/query/keys';

/**
 * Hash of a grid's group counts (T312): the parts of the record query that
 * decide which rows exist and how they group — not the sort, which only
 * orders rows inside a group.
 */
export function groupCountsHash(query: EffectiveRecordQuery): string {
  return `grid:${recordQueryHash({
    view_id: query.view_id,
    filter: query.filter,
    filter_mode: query.filter_mode,
    search: query.search,
    group: query.group,
  })}`;
}

/**
 * `POST …/records/group-counts` with the grid's query (same view, filter,
 * search and group as its blocks, CONTRACTS §1.4): every group in row order
 * with its row count.
 */
export const gridGroupCountsQuery = (
  tableId: string,
  query: EffectiveRecordQuery,
  permissionVersion: number,
) =>
  queryOptions({
    queryKey: keys.groupCounts(tableId, groupCountsHash(query), permissionVersion),
    queryFn: ({ signal }) =>
      api.records.groupCounts(
        tableId,
        {
          view_id: query.view_id ?? null,
          filter: query.filter ?? null,
          ...(query.filter_mode === undefined ? {} : { filter_mode: query.filter_mode }),
          search: query.search ?? null,
          ...(query.group === undefined || query.group === null
            ? {}
            : {
                group: query.group.map((item) => ({
                  field: item.field,
                  direction: item.direction ?? ('asc' as const),
                })),
              }),
        },
        { signal },
      ),
  });
