import { createContext, useContext } from 'react';

/**
 * Screens rendered without a session (the public share pages, T317):
 * shared hooks that would read the signed-in user (`GET /me`, e.g. the time
 * zone of `useFormatters`) use the browser's settings instead, so an
 * anonymous visitor never gets a `401` in the console (T421b).
 */
const SessionlessContext = createContext(false);

export const SessionlessProvider = SessionlessContext.Provider;

/** Whether this screen runs without a session. */
export function useSessionless(): boolean {
  return useContext(SessionlessContext);
}
