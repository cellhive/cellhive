/**
 * Lazy chunks that fail to load (T902, FRONTEND §8.2): a dropped
 * connection (`net::ERR_NETWORK_CHANGED`) or a new build whose chunks
 * replaced the old ones. Every route `lazy` ({@link lazyRoute}) and every
 * lazy panel (`lazyPanel`) loads through {@link retryChunk}: one more try
 * after {@link RETRY_DELAY_MS}, then a {@link ChunkLoadFailed} for the
 * boundaries, never a blank page.
 */

/** Wait before the one automatic retry. */
export const RETRY_DELAY_MS = 500;

/** A lazy chunk failed twice (its `cause` is the last failure). */
export class ChunkLoadFailed extends Error {}

// Vite reports every failed dynamic import (and CSS preload) of the build with this event.
const preloadErrors = new WeakSet<Error>();
window.addEventListener('vite:preloadError', (event) => {
  preloadErrors.add(event.payload);
});

/**
 * `String(error)` (name and message) of a dynamic import whose fetch failed:
 * "Failed to fetch dynamically imported module" (Chromium), "error loading
 * dynamically imported module" (Firefox), "Importing a module script
 * failed" (Safari), webpack's `ChunkLoadError`.
 */
const CHUNK_ERROR = /ChunkLoadError|dynamically imported module|Importing a module script failed/u;

export function isChunkLoadError(error: unknown): boolean {
  return error instanceof Error && (preloadErrors.has(error) || CHUNK_ERROR.test(String(error)));
}

/**
 * `load` with one retry after {@link RETRY_DELAY_MS} when a chunk fails to
 * load; a second failure throws {@link ChunkLoadFailed}. Other errors pass
 * through untouched.
 */
export function retryChunk<T>(load: () => Promise<T>): () => Promise<T> {
  return () =>
    load().catch(async (error: unknown) => {
      if (!isChunkLoadError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      return load().catch((again: unknown) => {
        throw isChunkLoadError(again) ? new ChunkLoadFailed(undefined, { cause: again }) : again;
      });
    });
}

/**
 * A route's `lazy`: {@link retryChunk}, and a failure becomes the route's
 * component, which throws it when it renders. React Router keeps a `lazy`
 * that rejected and renders nothing below the root for its route (the blank
 * page of T902); a component that throws reaches the route's error boundary.
 */
export function lazyRoute<T>(
  load: () => Promise<T>,
): () => Promise<T | { Component: () => never }> {
  const attempt = retryChunk(load);
  return () =>
    attempt().catch((error: unknown) => ({
      Component: () => {
        throw error as Error;
      },
    }));
}

/** When "Reload page" was last used for a chunk error in this tab (`Date.now()`). */
export const RELOAD_KEY = 'cellhive.chunkReload';
const RELOAD_GUARD_MS = 60_000;

/**
 * "Reload page" is offered once: after it was used, it is not offered again
 * for a minute, so a page whose chunks keep failing never reloads in a loop.
 */
export function canReloadPage(): boolean {
  try {
    return Date.now() - Number(sessionStorage.getItem(RELOAD_KEY)) > RELOAD_GUARD_MS;
  } catch {
    // Storage blocked (private mode): no guard to read, the button stays.
    return true;
  }
}

/** A full page load: the new build's `index.html` names the new chunks. */
export function reloadPage(): void {
  try {
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    // Storage blocked: reload all the same.
  }
  window.location.reload();
}
