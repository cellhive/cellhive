import { useEffect, useState, useSyncExternalStore } from 'react';

import { useRealtimeStatus } from './status';

function subscribeOnline(listener: () => void): () => void {
  window.addEventListener('online', listener);
  window.addEventListener('offline', listener);
  return () => {
    window.removeEventListener('online', listener);
    window.removeEventListener('offline', listener);
  };
}

const isOnline = () => navigator.onLine;

/**
 * Whether the app can reach the server. `navigator.onLine` alone is not
 * trusted: browsers report `false` behind some VPNs and proxies while the
 * server answers, which would lock every editor. An open WebSocket proves
 * the connection, so it wins over the browser's flag.
 */
export function useOnline(): boolean {
  const browserOnline = useSyncExternalStore(subscribeOnline, isOnline, () => true);
  const realtime = useRealtimeStatus();
  return browserOnline || realtime.status === 'open';
}

/** A lost WebSocket is announced after this long (FRONTEND §5). */
export const RECONNECTING_NOTICE_MS = 5000;

export type ConnectionState = 'online' | 'offline' | 'reconnecting';

/**
 * What the connection banner shows and editors obey (FRONTEND §8.3):
 * `offline` (browser offline: editors locked, data read-only), `reconnecting`
 * (WebSocket lost for more than 5 s: data may be stale) or `online`.
 */
export function useConnectionState(now: () => number = Date.now): ConnectionState {
  const online = useOnline();
  const realtime = useRealtimeStatus();
  const since = realtime.status === 'reconnecting' ? realtime.since : null;
  const [late, setLate] = useState<number | null>(null);

  useEffect(() => {
    if (since === null) return;
    const wait = since + RECONNECTING_NOTICE_MS - now();
    const timer = window.setTimeout(
      () => {
        setLate(since);
      },
      Math.max(0, wait),
    );
    return () => {
      window.clearTimeout(timer);
    };
  }, [since, now]);

  if (!online) return 'offline';
  if (since !== null && late === since) return 'reconnecting';
  return 'online';
}
