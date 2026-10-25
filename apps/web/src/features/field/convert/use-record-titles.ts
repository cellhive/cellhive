import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { api } from '../../../lib/api';
import { tableQuery } from '../../../lib/query/queries';

/**
 * Titles (primary field as text) of the records a preview names by id
 * (samples, over-limit records): one `records/query { ids }` with the
 * caller's rights — records they cannot read are simply absent.
 */
export function useRecordTitles(
  tableId: string | undefined,
  ids: readonly string[],
): ReadonlyMap<string, string> {
  const table = useQuery({ ...tableQuery(tableId ?? ''), enabled: tableId !== undefined });
  const primary = table.data?.primary_field_id;
  const unique = useMemo(() => [...new Set(ids)].sort(), [ids]);
  const titles = useQuery({
    queryKey: ['table', tableId ?? '', 'titles', primary ?? '', unique] as const,
    queryFn: ({ signal }) =>
      api.records.query(
        tableId ?? '',
        { ids: unique, fields: [primary ?? ''], limit: unique.length, include_total: false },
        { signal, cellFormat: 'text' },
      ),
    enabled: tableId !== undefined && primary !== undefined && unique.length > 0,
    staleTime: 30_000,
  });
  return useMemo(() => {
    const map = new Map<string, string>();
    for (const record of titles.data?.records ?? []) {
      const value = primary === undefined ? undefined : record.fields[primary];
      map.set(record.id, typeof value === 'string' ? value : '');
    }
    return map;
  }, [titles.data, primary]);
}
