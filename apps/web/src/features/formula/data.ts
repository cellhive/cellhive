import { useQueries, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useAiAvailability } from '../../lib/ai/use-ai-availability';
import { api } from '../../lib/api';
import { canManageSchema } from '../../lib/permissions/access';
import { keys } from '../../lib/query/keys';
import { baseQuery, fieldsQuery, orgQuery, tableQuery, tablesQuery } from '../../lib/query/queries';

import { PREVIEW_ROWS } from './model/preview';
import { buildFormulaSchema, type FormulaSchema } from './model/schema';

import type { FieldDto, RecordDto, RecordListResponse } from '@cellhive/contracts';

/**
 * Data of the formula editor (T466): the schema it resolves names against
 * (every table of the base the user reads and their readable fields), the
 * organization's zone (ADR-21) and the rows of the preview.
 */

export interface FormulaEnvironment {
  readonly schema: FormulaSchema | null;
  readonly tableName: string;
  /** Zone of calendar functions (organization default, ADR-21). */
  readonly timeZone: string | undefined;
  readonly currency: string | undefined;
}

/** Stable `combine` of the field lists: one array of items per table (`undefined` while loading). */
function fieldItems(results: readonly { data?: { items: FieldDto[] } | undefined }[]) {
  return results.map((result) => result.data?.items);
}

export function useFormulaEnvironment(tableId: string, fieldId?: string): FormulaEnvironment {
  const table = useQuery(tableQuery(tableId));
  const baseId = table.data?.base_id;
  const base = useQuery({ ...baseQuery(baseId ?? ''), enabled: baseId !== undefined });
  const orgId = base.data?.organization_id;
  const org = useQuery({ ...orgQuery(orgId ?? ''), enabled: orgId !== undefined });
  const tables = useQuery({ ...tablesQuery(baseId ?? ''), enabled: baseId !== undefined });
  const list = tables.data?.items;
  const fields = useQueries({
    queries: (list ?? []).map((item) => fieldsQuery(item.id)),
    combine: fieldItems,
  });
  const schema = useMemo(() => {
    if (list === undefined || fields.some((items) => items === undefined)) return null;
    const byTable = new Map<string, FieldDto[] | undefined>(
      list.map((item, index) => [item.id, fields[index]]),
    );
    return buildFormulaSchema(tableId, list, (id) => byTable.get(id), fieldId);
  }, [list, fields, tableId, fieldId]);
  return {
    schema,
    tableName: table.data?.name ?? '',
    timeZone: org.data?.settings.timezone,
    currency: org.data?.settings.currency,
  };
}

/**
 * (T913) Whether the editor offers "Describe the formula": AI on for the
 * organization (research S8 §5.1) and the caller changes this table's schema
 * (`manage` or base admin, the rule of the AI route). Here, not in the box, so
 * that the box's code loads only when it renders.
 */
export function useAiFormulaEntry(tableId: string): boolean {
  const table = useQuery(tableQuery(tableId));
  const baseId = table.data?.base_id;
  const base = useQuery({ ...baseQuery(baseId ?? ''), enabled: baseId !== undefined });
  const ai = useAiAvailability(base.data?.organization_id);
  return ai.available && canManageSchema(base.data?.access, tableId);
}

/**
 * The first rows the grid of `tableId` has loaded (block 0 of the most
 * recent query of it, in view order) — "the 5 rows being shown" of the
 * preview (BACKLOG T466). Embedded link tables and trees are left aside.
 */
export function cachedRows(client: QueryClient, tableId: string): RecordDto[] | null {
  const queries = client
    .getQueryCache()
    .findAll({ queryKey: keys.recordBlocks(tableId) })
    .filter((query) => {
      const hash = query.queryKey[3];
      const index = query.queryKey[5];
      return index === 0 && typeof hash === 'string' && !hash.startsWith('linked:');
    })
    .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt);
  for (const query of queries) {
    const data = query.state.data as RecordListResponse | undefined;
    if (data !== undefined && data.records.length > 0) return data.records.slice(0, PREVIEW_ROWS);
  }
  return null;
}

/** Rows of the preview: the grid's when cached, else the first 5 the user reads. */
export function usePreviewRows(tableId: string): RecordDto[] | undefined {
  const client = useQueryClient();
  const cached = useMemo(() => cachedRows(client, tableId), [client, tableId]);
  const fetched = useQuery({
    queryKey: keys.formulaPreviewRows(tableId),
    queryFn: ({ signal }) =>
      api.records.query(
        tableId,
        { offset: 0, limit: PREVIEW_ROWS, include_total: false },
        { signal },
      ),
    enabled: cached === null,
  });
  if (cached !== null) return cached;
  return fetched.data?.records;
}
