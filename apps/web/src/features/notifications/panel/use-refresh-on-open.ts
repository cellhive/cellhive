import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { keys } from '../../../lib/query/keys';

/** The parts of the organization's notification queries an open panel shows. */
const PANEL_PARTS = new Set(['list', 'unread-count']);

/**
 * (T556, QA S5 L2) Opening the panel asks the server again for the unread
 * count and the lists, once: when realtime missed a `notification.created`
 * (a dropped socket, a blocked WebSocket), the list used to show unread
 * dots while "Mark all as read" stayed off and the count said nothing was
 * unread. No polling: one refetch per opening. `cancelRefetch: false`
 * joins a fetch already running (the list's own fetch on mount, a realtime
 * invalidation) instead of starting a second request.
 */
export function useRefreshOnOpen(orgId: string): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    const prefix = keys.notifications(orgId);
    void queryClient.invalidateQueries(
      {
        queryKey: prefix,
        predicate: (query) => PANEL_PARTS.has(String(query.queryKey[prefix.length])),
      },
      { cancelRefetch: false },
    );
  }, [queryClient, orgId]);
}
