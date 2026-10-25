import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

/**
 * Component tests never reach a server: the app's realtime client gets a
 * WebSocket that stays `CONNECTING` forever (unit tests of the client pass
 * their own fake socket).
 */
class InertWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly readyState = 0;
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;
  send(): void {
    // Never open.
  }
  close(): void {
    // Nothing to close.
  }
}
Object.defineProperty(globalThis, 'WebSocket', { value: InertWebSocket, writable: true });

// Lazy route and panel chunks are transformed on first use: under a full parallel run
// that can take longer than the default 1 s of `findBy*` / `waitFor`.
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (typeof document === 'undefined') return;
  document.cookie.split(';').forEach((cookie) => {
    const name = cookie.split('=')[0]?.trim();
    if (name !== undefined && name !== '') {
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
    }
  });
});
