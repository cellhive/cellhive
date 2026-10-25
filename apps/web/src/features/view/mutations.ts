import { useMutation, useQueryClient } from '@tanstack/react-query';

import { api, type CreateViewBody } from '../../lib/api';
import { keys } from '../../lib/query/keys';
import { expectOwnSchemaChange, retractOwnSchemaChange } from '../../lib/realtime/own-changes';
import { addCachedView, removeCachedView, replaceCachedView } from '../../lib/views/cache';
import { isEmptyPatch } from '../../lib/views/config';
import { viewSessions } from '../../lib/views/session';

import { markDeletedHere } from './deleted';

import type { UpdateViewRequest, ViewDto, ViewList } from '@cellhive/contracts';

/**
 * View mutations of the view bar (CONTRACTS §15). Each updates the cached
 * view list itself and announces the `schema.changed` it causes
 * (`lib/realtime/own-changes.ts`), so its own echo does not refetch the
 * table; other tabs refetch on that message.
 */
const VIEW_CHANGE = { schema: 1, permission: 0 } as const;

async function announced<T>(tableId: string, request: () => Promise<T>): Promise<T> {
  expectOwnSchemaChange(tableId, VIEW_CHANGE);
  try {
    return await request();
  } catch (error) {
    retractOwnSchemaChange(tableId, VIEW_CHANGE);
    throw error;
  }
}

export function useCreateView(tableId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateViewBody) => announced(tableId, () => api.views.create(tableId, body)),
    onSuccess: (view) => {
      addCachedView(queryClient, view);
    },
  });
}

export function useDuplicateView(tableId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ viewId, personal }: { viewId: string; personal?: boolean }) =>
      announced(tableId, () =>
        api.views.duplicate(viewId, personal === undefined ? {} : { is_personal: personal }),
      ),
    onSuccess: (view) => {
      addCachedView(queryClient, view);
    },
  });
}

/** Rename, lock/unlock (not the config: `lib/views/session.ts` saves that). */
export function useUpdateView(tableId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ viewId, body }: { viewId: string; body: UpdateViewRequest }) =>
      announced(tableId, () => api.views.update(viewId, body)),
    onSuccess: (view) => {
      replaceCachedView(queryClient, view);
    },
  });
}

/** `views` with `viewId` moved to `index` within its group (shared or personal). */
export function reorderInList(list: ViewList, viewId: string, index: number): ViewList {
  const moved = list.items.find((view) => view.id === viewId);
  if (moved === undefined) return list;
  const group = list.items.filter((view) => view.is_personal === moved.is_personal);
  const rest = group.filter((view) => view.id !== viewId);
  rest.splice(Math.min(Math.max(index, 0), rest.length), 0, moved);
  const renumbered = rest.map((view, position) => ({ ...view, position }));
  const shared = moved.is_personal ? list.items.filter((view) => !view.is_personal) : renumbered;
  const personal = moved.is_personal ? renumbered : list.items.filter((view) => view.is_personal);
  return { ...list, items: [...shared, ...personal] };
}

/** Drag or "Move left/right": `PATCH { position }`, optimistic, rolled back on refusal. */
export function useMoveView(tableId: string) {
  const queryClient = useQueryClient();
  const listKey = keys.views(tableId);
  return useMutation({
    mutationFn: ({ viewId, index }: { viewId: string; index: number }) =>
      announced(tableId, () => api.views.update(viewId, { position: index })),
    onMutate: async ({ viewId, index }) => {
      await queryClient.cancelQueries({ queryKey: listKey, exact: true });
      const previous = queryClient.getQueryData<ViewList>(listKey);
      if (previous !== undefined) {
        queryClient.setQueryData(listKey, reorderInList(previous, viewId, index));
      }
      return { previous };
    },
    onError: (_error, _move, context) => {
      if (context?.previous !== undefined) queryClient.setQueryData(listKey, context.previous);
    },
    // The others' positions shifted on the server.
    onSettled: () => queryClient.invalidateQueries({ queryKey: listKey, exact: true }),
  });
}

export function useDeleteView(tableId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (viewId: string) => announced(tableId, () => api.views.remove(viewId)),
    onSuccess: (_result, viewId) => {
      markDeletedHere(viewId);
      removeCachedView(queryClient, tableId, viewId);
      viewSessions.forget(viewId);
    },
  });
}

/**
 * "Save as personal view" (BACKLOG S3 decision 4): a personal copy of the
 * view with the temporary changes saved into it; the source view gets back
 * its saved config. The copy's config only keeps fields the user reads.
 */
export function useSaveAsPersonal(tableId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ source, name }: { source: ViewDto; name?: string }): Promise<ViewDto> => {
      const copy = await announced(tableId, () =>
        api.views.duplicate(source.id, {
          is_personal: true,
          ...(name === undefined ? {} : { name }),
        }),
      );
      addCachedView(queryClient, copy);
      const draft = viewSessions.get(source.id).draft;
      if (isEmptyPatch(draft)) return copy;
      const saved = await announced(tableId, () => api.views.update(copy.id, { config: draft }));
      replaceCachedView(queryClient, saved);
      return saved;
    },
    onSuccess: (_copy, { source }) => {
      viewSessions.discard(source.id);
    },
  });
}
