import { meResponseSchema, setupStatusSchema, type MeResponse } from '@cellhive/contracts';
import { queryOptions } from '@tanstack/react-query';

import { apiRequest, apiRequestVoid, isApiError, UNCHECKED_SCHEMA } from '../api/client';
import { endPreferenceSession, setPreferenceUser } from '../preferences';
import { keys } from '../query/keys';
import { endRealtimeSession } from '../realtime/session-end';

/**
 * Session state shared by the route guards, the app shell and the auth
 * screens: first-run status (with public sign-in settings) and the signed-in
 * user (CONTRACTS §5A, §12.0).
 */
export const sessionApi = {
  setupStatus: (signal?: AbortSignal) =>
    apiRequest('/setup', import.meta.env.DEV ? setupStatusSchema : UNCHECKED_SCHEMA, { signal }),
  /** The signed-in user, or `null` without a valid session. */
  me: async (signal?: AbortSignal): Promise<MeResponse | null> => {
    let me: MeResponse | null;
    try {
      me = await apiRequest('/me', import.meta.env.DEV ? meResponseSchema : UNCHECKED_SCHEMA, {
        signal,
      });
    } catch (error) {
      if (isApiError(error) && error.status === 401) me = null;
      else throw error;
    }
    // Per-user preferences (unsaved view changes…) are read for this user.
    setPreferenceUser(me?.user.id ?? null);
    return me;
  },
  logout: () => apiRequestVoid('/auth/logout', { method: 'POST' }),
};

export const setupStatusQuery = () =>
  queryOptions({
    queryKey: keys.setupStatus(),
    queryFn: ({ signal }) => sessionApi.setupStatus(signal),
    staleTime: 5 * 60_000,
  });

export const meQuery = () =>
  queryOptions({
    queryKey: keys.me(),
    queryFn: ({ signal }) => sessionApi.me(signal),
    staleTime: 60_000,
  });

/**
 * Signs out, then loads `target` as a new document: nothing of the previous
 * user (query cache, component state) survives in memory.
 */
export async function signOut(target = '/login'): Promise<void> {
  // Unsaved view changes of this user do not stay on the device (S3 QA).
  endPreferenceSession();
  // The server closes this tab's WebSocket with `4401` when the session
  // ends; that must not redirect to a sign-in with `?next=` meanwhile.
  endRealtimeSession();
  try {
    await sessionApi.logout();
  } finally {
    window.location.assign(target);
  }
}
