import { MAX_QUERY_IDS } from '@cellhive/contracts';
import { useQueries } from '@tanstack/react-query';
import { useMemo } from 'react';

import { api } from '../../../lib/api';

import type { TableDto } from '@cellhive/contracts';

/** A trigger record as the viewer sees it: its title, or that they cannot read it. */
export type RecordTitle =
  | { readonly state: 'loading' }
  | { readonly state: 'readable'; readonly title: string }
  | { readonly state: 'hidden' };

export interface RecordRef {
  readonly tableId: string;
  readonly recordId: string;
}

/**
 * Titles (primary field, as text) of the trigger records of the runs shown
 * (board "S5 · Run history": the record's name, not its id). One `ids`
 * query per table with the viewer's own permissions (CONTRACTS §1.4): a
 * record they cannot read — read rule, trash, table — is simply absent and
 * shows without a link (BACKLOG T523 "link … nếu đọc được"). Tables the
 * viewer does not see are not asked.
 */
export function useRecordTitles(
  refs: readonly RecordRef[],
  tables: readonly Pick<TableDto, 'id' | 'primary_field_id'>[] | undefined,
): (ref: RecordRef) => RecordTitle {
  const groups = useMemo(() => {
    const byTable = new Map<string, Set<string>>();
    for (const ref of refs) {
      const ids = byTable.get(ref.tableId) ?? new Set<string>();
      ids.add(ref.recordId);
      byTable.set(ref.tableId, ids);
    }
    return [...byTable.entries()].map(([tableId, ids]) => ({
      tableId,
      ids: [...ids].sort().slice(0, MAX_QUERY_IDS),
      primary: tables?.find((table) => table.id === tableId)?.primary_field_id ?? null,
    }));
  }, [refs, tables]);

  const results = useQueries({
    queries: groups.map((group) => ({
      queryKey: ['table', group.tableId, 'run-record-titles', group.ids] as const,
      enabled: group.primary !== null,
      staleTime: 60_000,
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.records.query(
          group.tableId,
          {
            ids: group.ids,
            fields: group.primary === null ? [] : [group.primary],
            limit: group.ids.length,
            include_total: false,
          },
          { signal, cellFormat: 'text' },
        ),
    })),
  });

  return (ref: RecordRef): RecordTitle => {
    const index = groups.findIndex((group) => group.tableId === ref.tableId);
    const group = groups[index];
    if (group === undefined || group.primary === null) {
      // A table the viewer does not see (or not loaded yet).
      return tables === undefined ? { state: 'loading' } : { state: 'hidden' };
    }
    const result = results[index];
    if (result === undefined || result.isPending) return { state: 'loading' };
    if (result.isError) return { state: 'hidden' };
    const record = result.data.records.find((item) => item.id === ref.recordId);
    if (record === undefined) return { state: 'hidden' };
    const value = record.fields[group.primary];
    return { state: 'readable', title: typeof value === 'string' ? value : '' };
  };
}
