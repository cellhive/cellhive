import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';

import { isApiError } from '../api/client';
import { endPreferenceSession } from '../preferences';

import { keys } from './keys';

/**
 * Client errors other than 408/429 do not get better by retrying. A read
 * refused by the rate limit (`429`, e.g. several tabs refetching after the
 * same change, T470) is tried twice more, after its `Retry-After`.
 */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (isApiError(error) && error.status >= 400 && error.status < 500) {
    if (error.status === 429) return failureCount < 2;
    return error.status === 408 && failureCount < 1;
  }
  return failureCount < 2;
}

/** Longest wait before a read is tried again. */
const MAX_RETRY_DELAY_MS = 30_000;

/**
 * Wait before retry `failureCount` (0-based): the `Retry-After` of a `429`
 * plus up to 250 ms, so that tabs refused in the same window do not all come
 * back in the next one together; else TanStack's backoff (1 s, 2 s, …).
 */
export function retryDelay(failureCount: number, error: unknown, random = Math.random): number {
  if (isApiError(error) && error.status === 429 && error.retry_after !== undefined) {
    return Math.min(error.retry_after * 1000 + Math.floor(random() * 250), MAX_RETRY_DELAY_MS);
  }
  return Math.min(1000 * 2 ** failureCount, MAX_RETRY_DELAY_MS);
}

/**
 * The app's QueryClient. A `401` from any call means the session ended:
 * `me` becomes `null` (the user's unsaved view changes are deleted), and
 * the app shell sends the user to the sign-in page.
 */
export function createQueryClient(): QueryClient {
  const onError = (error: unknown) => {
    if (isApiError(error) && error.status === 401) {
      if (queryClient.getQueryData(keys.me()) !== null) {
        // The user's unsaved view changes do not stay on the device (S3 QA).
        endPreferenceSession();
        queryClient.setQueryData(keys.me(), null);
      }
    }
  };
  const queryClient: QueryClient = new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        // Sign-in answers 401 for a wrong password, accepting an invitation for an
        // existing account without a session too; neither means a lost session.
        if (mutation.meta?.['ignoreUnauthenticated'] === true) return;
        onError(error);
      },
    }),
    defaultOptions: {
      queries: {
        retry: shouldRetry,
        retryDelay: (failureCount, error) => retryDelay(failureCount, error),
        staleTime: 30_000,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
  });
  return queryClient;
}
