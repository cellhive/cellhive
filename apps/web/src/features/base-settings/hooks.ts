import { infiniteQueryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';

import { rolesApi } from '../../lib/api/roles';
import { keys } from '../../lib/query/keys';

import type { AssignRoleRequest, RemoveRoleAssignmentRequest, RoleList } from '@cellhive/contracts';

/**
 * Data of the base settings pages (T712). Keys sit under `['base', id]`, so
 * a `permission.changed` of the base (any role or assignment change, from
 * this tab or another, CONTRACTS §14) refetches them with the base itself
 * (`applyBaseMessage`, FRONTEND §5). Not in `lib/query/keys.ts`: that module
 * is part of the app shell.
 */
export const principalKeys = {
  all: (baseId: string) => [...keys.base(baseId), 'principals'] as const,
  list: (baseId: string, q: string) => [...keys.base(baseId), 'principals', q] as const,
};

/** `GET /bases/:id/principals?q=` page by page ("Load more" follows `next_cursor`). */
export const principalsQuery = (baseId: string, q: string) =>
  infiniteQueryOptions({
    queryKey: principalKeys.list(baseId, q),
    queryFn: ({ pageParam, signal }) =>
      rolesApi.principals(
        baseId,
        {
          ...(q === '' ? {} : { q }),
          ...(pageParam === null ? {} : { cursor: pageParam }),
        },
        signal,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
  });

/**
 * Role and assignment mutations. Each one refetches the roles (names,
 * assignments) and the principal rows when it settles, whatever the
 * outcome: a conflict usually means the list is out of date.
 */
export function useRoleMutations(baseId: string) {
  const queryClient = useQueryClient();
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: keys.roles(baseId) }),
      queryClient.invalidateQueries({ queryKey: principalKeys.all(baseId) }),
    ]);
  const settle = { onSettled: refresh };
  return {
    create: useMutation({
      mutationFn: (name: string) => rolesApi.create(baseId, { name }),
      ...settle,
    }),
    rename: useMutation({
      mutationFn: ({ roleId, name }: { roleId: string; name: string }) =>
        rolesApi.update(baseId, roleId, { name }),
      ...settle,
    }),
    remove: useMutation({
      mutationFn: (roleId: string) => rolesApi.remove(baseId, roleId),
      onSuccess: (_, roleId) => {
        queryClient.setQueryData<RoleList>(keys.roles(baseId), (list) =>
          list === undefined
            ? list
            : {
                ...list,
                items: list.items.filter((role) => role.id !== roleId),
                total: list.total - 1,
              },
        );
      },
      ...settle,
    }),
    assign: useMutation({
      mutationFn: (body: AssignRoleRequest) => rolesApi.assign(baseId, body),
      ...settle,
    }),
    unassign: useMutation({
      mutationFn: (body: RemoveRoleAssignmentRequest) => rolesApi.unassign(baseId, body),
      ...settle,
    }),
  };
}

const NARROW_QUERY = '(max-width: 767.98px)';

function subscribeNarrow(listener: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => undefined;
  const media = window.matchMedia(NARROW_QUERY);
  media.addEventListener('change', listener);
  return () => {
    media.removeEventListener('change', listener);
  };
}

function isNarrow(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(NARROW_QUERY).matches;
}

/** Phones (< 768 px) get cards instead of tables (FRONTEND §9.4). */
export function useIsNarrow(): boolean {
  return useSyncExternalStore(subscribeNarrow, isNarrow, () => false);
}
