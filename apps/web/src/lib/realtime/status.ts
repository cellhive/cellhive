import { createStore, useStore } from '../store';

/**
 * State of the WebSocket connection (FRONTEND §5, §8.3), reported by the
 * realtime client (`socket.ts`): `idle` without any subscription (signed
 * out), `connecting` → `open`, and `reconnecting` (with the time the
 * connection was lost) while it backs off.
 */
export type RealtimeConnection =
  | { status: 'idle' }
  | { status: 'connecting' }
  | { status: 'open' }
  | { status: 'reconnecting'; since: number };

const store = createStore<RealtimeConnection>({ status: 'idle' });

export const realtimeStatus = {
  get: store.get,
  subscribe: store.subscribe,
  /** Called by the socket. `reconnecting` keeps the first `since` of an outage. */
  set: (next: RealtimeConnection) => {
    store.set((current) =>
      next.status === 'reconnecting' && current.status === 'reconnecting' ? current : next,
    );
  },
};

export function useRealtimeStatus(): RealtimeConnection {
  return useStore(store);
}
