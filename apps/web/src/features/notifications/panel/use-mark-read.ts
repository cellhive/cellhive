import { useMutation, useQueryClient, type InfiniteData } from '@tanstack/react-query';

import { keys } from '../../../lib/query/keys';
import { showErrorToast } from '../../../lib/toast/toast';
import { notificationsApi } from '../api';
import { announceRead } from '../shell/unread';

import type {
  NotificationDto,
  NotificationListDto,
  NotificationUnreadCountDto,
} from '@cellhive/contracts';

type NotificationId = NotificationDto['id'];
type BaseId = NonNullable<NotificationDto['base']>['id'];

export type MarkReadTarget =
  | { readonly ids: readonly [NotificationId, ...NotificationId[]] }
  | { readonly all: true; readonly baseId: BaseId | null };

/**
 * Marks notifications read (CONTRACTS §22.3 `POST …/notifications/read`):
 * the lists and the count change at once (optimistic), then everything of
 * the organization is fetched again and the other tabs are told
 * (`announceRead`). A failure brings the server's state back with a toast.
 */
export function useMarkRead(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (target: MarkReadTarget) =>
      notificationsApi.markRead(
        orgId,
        'ids' in target
          ? { ids: [...target.ids] }
          : target.baseId === null
            ? { all: true }
            : { all: true, base_id: target.baseId },
      ),
    onMutate: async (target) => {
      const prefix = keys.notifications(orgId);
      await queryClient.cancelQueries({ queryKey: prefix });
      const now = new Date().toISOString();
      const hits = (item: NotificationListDto['items'][number]) =>
        item.read_at === null &&
        ('ids' in target
          ? target.ids.includes(item.id)
          : target.baseId === null || item.base?.id === target.baseId);
      let changed = 0;
      const seen = new Set<string>();
      queryClient.setQueriesData<InfiniteData<NotificationListDto>>(
        { queryKey: [...prefix, 'list'] },
        (data) =>
          data === undefined
            ? data
            : {
                ...data,
                pages: data.pages.map((page) => ({
                  ...page,
                  items: page.items.map((item) => {
                    if (!hits(item)) return item;
                    if (!seen.has(item.id)) {
                      seen.add(item.id);
                      changed += 1;
                    }
                    return { ...item, read_at: now };
                  }),
                })),
              },
      );
      queryClient.setQueryData<NotificationUnreadCountDto>(
        keys.notificationUnreadCount(orgId),
        (data) =>
          data === undefined
            ? data
            : 'all' in target && target.baseId === null
              ? { count: 0 }
              : { count: Math.max(0, data.count - changed) },
      );
    },
    onError: (error) => {
      showErrorToast(error);
    },
    onSettled: () => {
      announceRead(orgId);
      return queryClient.invalidateQueries({ queryKey: keys.notifications(orgId) });
    },
  });
}
