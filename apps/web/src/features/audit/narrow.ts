import { useSyncExternalStore } from 'react';

const NARROW_QUERY = '(max-width: 767.98px)';

function subscribe(listener: () => void): () => void {
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
  return useSyncExternalStore(subscribe, isNarrow, () => false);
}
