/**
 * Development-only diagnostics (contract drift, missing translations). Never
 * pass record values, tokens or other user data (FRONTEND §8.2); in
 * production builds this is a no-op and there is no telemetry.
 */
export function devWarn(message: string, details?: unknown): void {
  if (!import.meta.env.DEV || import.meta.env.MODE === 'test') return;
  // eslint-disable-next-line no-console -- the only console sink of the app, dev builds only
  console.warn(`[cellhive] ${message}`, details ?? '');
}
