import { useCallback, useEffect, useState } from 'react';

import { thumbnailRetryDelay, thumbnailRetryUrl } from './previews';

export interface RetryingImage {
  /** What to load now; `null` while waiting for the next try or after the last one. */
  readonly src: string | null;
  /** Every try failed (or the source is `null`). */
  readonly failed: boolean;
  /** The `<img>` failed: wait, then try again (T421b). */
  readonly onError: () => void;
}

interface State {
  readonly source: string | null;
  readonly attempt: number;
  readonly phase: 'loading' | 'waiting' | 'failed';
}

/**
 * An image source that is tried again with backoff when it fails (T421b,
 * `previews.ts`): a thumbnail the worker has not rendered yet answers
 * `404`, then appears. A new `source` starts over.
 */
export function useRetryingImage(source: string | null): RetryingImage {
  const [state, setState] = useState<State>({ source, attempt: 0, phase: 'loading' });
  const current: State = state.source === source ? state : { source, attempt: 0, phase: 'loading' };
  if (current !== state) setState(current);

  const { attempt, phase } = current;
  useEffect(() => {
    if (phase !== 'waiting' || source === null) return;
    const delay = thumbnailRetryDelay(source, attempt);
    if (delay === null) return;
    const timer = setTimeout(() => {
      setState((now) =>
        now.source === source && now.attempt === attempt
          ? { source, attempt: attempt + 1, phase: 'loading' }
          : now,
      );
    }, delay);
    return () => {
      clearTimeout(timer);
    };
  }, [source, attempt, phase]);

  const onError = useCallback(() => {
    setState((now) => {
      if (now.source !== source || now.phase !== 'loading' || source === null) return now;
      return {
        source,
        attempt: now.attempt,
        phase: thumbnailRetryDelay(source, now.attempt) === null ? 'failed' : 'waiting',
      };
    });
  }, [source]);

  return {
    src: source === null || phase !== 'loading' ? null : thumbnailRetryUrl(source, attempt),
    failed: source === null || phase === 'failed',
    onError,
  };
}
