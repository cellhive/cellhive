import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { api } from '../../lib/api';
import { keys } from '../../lib/query/keys';
import { expectOwnSchemaChange, retractOwnSchemaChange } from '../../lib/realtime/own-changes';

import type {
  ConvertFieldRequest,
  CreateFieldRequest,
  RevertConversionRequest,
  FieldDto,
  TableDto,
  UpdateFieldRequest,
} from '@cellhive/contracts';

/**
 * Schema mutations of the field dialogs (CONTRACTS §13). Each refetches
 * exactly what it changed and announces the realtime messages it causes
 * (`lib/realtime/own-changes.ts`), so that its own `schema.changed` and
 * `permission.changed` do not refetch the same queries again (S2 QA: one
 * field created cost ~14 requests and hit `429` with several tabs open).
 * Other tabs refetch on those messages (T204).
 */

/** A fetch already running is reused rather than cancelled and sent again. */
const REUSE = { cancelRefetch: false } as const;

/** Messages caused by creating, deleting or restoring a field (it bumps `permission_version`). */
const FIELD_SET_CHANGE = { schema: 1, permission: 1 } as const;
const FIELD_UPDATE = { schema: 1, permission: 0 } as const;

/** Sends a schema request of this tab, announcing the messages it causes. */
async function announced<T>(
  tableId: string,
  counts: { readonly schema: number; readonly permission: number },
  request: () => Promise<T>,
): Promise<T> {
  expectOwnSchemaChange(tableId, counts);
  try {
    return await request();
  } catch (error) {
    retractOwnSchemaChange(tableId, counts);
    throw error;
  }
}

function tableQueries(tableId: string, parts: readonly string[]) {
  return {
    queryKey: keys.table(tableId),
    predicate: (query: { queryKey: readonly unknown[] }) =>
      parts.includes(String(query.queryKey[2])),
  };
}

/**
 * A field created, deleted or restored: the field list, the open record,
 * and the base (new `access` and `permission_version`: the grid loads its
 * record blocks again under the new version, with the new field).
 */
function refetchAfterFieldSetChange(queryClient: QueryClient, tableId: string): Promise<unknown> {
  const baseId = queryClient.getQueryData<TableDto>(keys.tableMeta(tableId))?.base_id;
  return Promise.all([
    queryClient.invalidateQueries(tableQueries(tableId, ['fields', 'record']), REUSE),
    baseId === undefined
      ? undefined
      : queryClient.invalidateQueries({ queryKey: keys.base(baseId), exact: true }, REUSE),
  ]);
}

/** A field updated: its definition and the values read (options removed…). */
function refetchAfterFieldUpdate(queryClient: QueryClient, tableId: string): Promise<unknown> {
  return queryClient.invalidateQueries(
    tableQueries(tableId, ['fields', 'records', 'record']),
    REUSE,
  );
}

export function useCreateField(tableId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    /**
     * `index`: place in the field order. A new field comes last; moving it is
     * a second request (`PATCH { position }`), skipped when it is last anyway.
     */
    mutationFn: async ({
      body,
      index,
      count,
    }: {
      body: CreateFieldRequest;
      index: number | undefined;
      count: number;
    }): Promise<FieldDto> => {
      const created = await announced(tableId, FIELD_SET_CHANGE, () =>
        api.fields.create(tableId, body),
      );
      if (index === undefined || index >= count) return created;
      try {
        return await announced(tableId, FIELD_UPDATE, () =>
          api.fields.update(created.id, { position: index }),
        );
      } catch {
        // The field exists (last); only its place could not be set.
        return created;
      }
    },
    onSettled: () => refetchAfterFieldSetChange(queryClient, tableId),
  });
}

export function useUpdateField(tableId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ fieldId, body }: { fieldId: string; body: UpdateFieldRequest }) =>
      announced(tableId, FIELD_UPDATE, () => api.fields.update(fieldId, body)),
    onSuccess: () => refetchAfterFieldUpdate(queryClient, tableId),
  });
}

/**
 * `PUT /fields/:id` (T414, CONTRACTS §4.4): the conversion starts (`202`),
 * its job runs in the background; the grid follows it through the field
 * list (`conversion`) and `field.converting`. A link conversion may change
 * the linked table too (reverse field): its fields are fetched again.
 */
export function useConvertField(tableId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      fieldId,
      body,
    }: {
      fieldId: string;
      body: ConvertFieldRequest;
      linkedTableId?: string | undefined;
    }) => announced(tableId, FIELD_UPDATE, () => api.fields.convert(fieldId, body)),
    onSuccess: (_result, { linkedTableId }) =>
      Promise.all([
        refetchAfterFieldUpdate(queryClient, tableId),
        linkedTableId === undefined || linkedTableId === tableId
          ? undefined
          : queryClient.invalidateQueries(tableQueries(linkedTableId, ['fields']), REUSE),
      ]),
  });
}

/**
 * `POST /fields/:id/revert-conversion` (T414): the field goes back (or its
 * old version becomes a new field). Values and fields change: refetched;
 * a link revert changes the linked table's fields too.
 */
export function useRevertConversion(tableId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      fieldId,
      body,
    }: {
      fieldId: string;
      body: RevertConversionRequest;
      linkedTableId?: string | undefined;
    }) => api.fields.revert(fieldId, body),
    onSuccess: (_field, { linkedTableId }) =>
      Promise.all([
        refetchAfterFieldSetChange(queryClient, tableId),
        queryClient.invalidateQueries(tableQueries(tableId, ['records']), REUSE),
        linkedTableId === undefined || linkedTableId === tableId
          ? undefined
          : queryClient.invalidateQueries({ queryKey: keys.table(linkedTableId) }, REUSE),
      ]),
  });
}

export function useDeleteField(tableId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (fieldId: string) =>
      announced(tableId, FIELD_SET_CHANGE, () => api.fields.remove(fieldId)),
    onSuccess: () => refetchAfterFieldSetChange(queryClient, tableId),
  });
}
