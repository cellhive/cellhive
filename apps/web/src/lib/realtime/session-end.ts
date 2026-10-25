/**
 * Sign-out → realtime client, without importing the client: `session.ts` is
 * part of the light entries (`/login`, `/s/:token`, `/verify-sender`), and
 * `socket.ts` pulls the contracts' realtime zod schemas (FRONTEND §11.1).
 * The client registers itself when it is created (`realtimeClient()`); a tab
 * that never opened a WebSocket has nothing to end.
 */
let ender: (() => void) | null = null;

/** Called by `realtimeClient()` once the tab's client exists. */
export function setRealtimeSessionEnder(end: () => void): void {
  ender = end;
}

/** Ends the session of this tab's realtime client, if one was created (sign-out). */
export function endRealtimeSession(): void {
  ender?.();
}
