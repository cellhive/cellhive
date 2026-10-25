import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useSyncExternalStore } from 'react';

import { keys } from '../../../lib/query/keys';

import { withIdentity } from './api';

import type { EmailIdentityDto, EmailIdentityList } from '@cellhive/contracts';

/**
 * Writes answers into the cached list (the page shows them at once), then
 * asks for the list again: the server is the source (another admin, a link
 * confirmed from the mailbox).
 */
export function useIdentityCache(orgId: string) {
  const queryClient = useQueryClient();
  return useMemo(() => {
    const key = keys.orgEmailIdentities(orgId);
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: key });
    };
    return {
      put(identity: EmailIdentityDto) {
        queryClient.setQueryData<EmailIdentityList>(key, (list) =>
          list === undefined ? list : { items: withIdentity(list.items, identity) },
        );
        refresh();
      },
      drop(identityId: string) {
        queryClient.setQueryData<EmailIdentityList>(key, (list) =>
          list === undefined
            ? list
            : { items: list.items.filter((item) => item.id !== identityId) },
        );
        refresh();
      },
      refresh,
    };
  }, [orgId, queryClient]);
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

/** Phones (< 768 px) get cards instead of the table (FRONTEND §9.4). */
export function useIsNarrow(): boolean {
  return useSyncExternalStore(subscribeNarrow, isNarrow, () => false);
}
