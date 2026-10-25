import { keys } from '../query/keys';

import type { ViewDto, ViewList } from '@cellhive/contracts';
import type { QueryClient } from '@tanstack/react-query';

/** Replaces one view in the cached list of its table (a response of `PATCH`/`GET /views/:id`). */
export function replaceCachedView(queryClient: QueryClient, view: ViewDto): void {
  queryClient.setQueryData<ViewList>(keys.views(view.table_id), (list) =>
    list === undefined
      ? list
      : { ...list, items: list.items.map((item) => (item.id === view.id ? view : item)) },
  );
}

/** Adds a new view to the cached list (end of its group, as the server places it). */
export function addCachedView(queryClient: QueryClient, view: ViewDto): void {
  queryClient.setQueryData<ViewList>(keys.views(view.table_id), (list) => {
    if (list === undefined || list.items.some((item) => item.id === view.id)) return list;
    const items = view.is_personal
      ? [...list.items, view]
      : [
          ...list.items.filter((item) => !item.is_personal),
          view,
          ...list.items.filter((item) => item.is_personal),
        ];
    return { ...list, items, total: list.total + 1 };
  });
}

export function removeCachedView(queryClient: QueryClient, tableId: string, viewId: string): void {
  queryClient.setQueryData<ViewList>(keys.views(tableId), (list) =>
    list === undefined
      ? list
      : {
          ...list,
          items: list.items.filter((item) => item.id !== viewId),
          total: Math.max(0, list.total - 1),
        },
  );
}

/** Shared views first (by position), then personal ones: the order of `GET /tables/:id/views`. */
export function sharedViews(views: readonly ViewDto[]): ViewDto[] {
  return views.filter((view) => !view.is_personal);
}

export function personalViews(views: readonly ViewDto[]): ViewDto[] {
  return views.filter((view) => view.is_personal);
}
