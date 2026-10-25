import { createContext, useContext, type ReactNode } from 'react';

import { loginPathFor } from '../navigation/safe-next';
import { endPreferenceSession } from '../preferences';

import { realtimeClient, type RealtimeClient } from './socket';

const RealtimeContext = createContext<RealtimeClient | null>(null);

/** Replaces the app's realtime client below it (component tests). */
export function RealtimeProvider({
  client,
  children,
}: {
  client: RealtimeClient;
  children: ReactNode;
}) {
  return <RealtimeContext.Provider value={client}>{children}</RealtimeContext.Provider>;
}

/**
 * The realtime client of this tab. When the session ends (`4401`) the page
 * is loaded again at the sign-in, so nothing of the previous session stays
 * in memory; the user's unsaved view changes are deleted from the device.
 */
export function useRealtimeClient(): RealtimeClient {
  const provided = useContext(RealtimeContext);
  return (
    provided ??
    realtimeClient({
      onSessionExpired: () => {
        endPreferenceSession();
        window.location.assign(loginPathFor(window.location));
      },
    })
  );
}
