import { QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { json, ORG, problem, stubApi } from '../../../../test/app-harness';
import { createQueryClient } from '../../query/client';
import { keys } from '../../query/keys';
import { useAiAvailability } from '../use-ai-availability';

import type { ReactNode } from 'react';

/** T912: whether AI entry points render, from `ai` of `GET /orgs/:id` (CONTRACTS §29.1). */

function render(orgId: string | undefined, answer: () => Response) {
  const fetchMock = stubApi({ signedIn: true, routes: { [`GET /orgs/${ORG.id}`]: answer } });
  const queryClient = createQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const hook = renderHook(() => useAiAvailability(orgId), { wrapper });
  return { hook, fetchMock, queryClient };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useAiAvailability', () => {
  it.each([
    [{ available: true, record_data: false }],
    [{ available: true, record_data: true }],
    [{ available: false, record_data: false }],
  ])('reads %j from the organization', async (ai) => {
    const { hook } = render(ORG.id, () => json({ ...ORG, ai }));
    await waitFor(() => {
      expect(hook.result.current).toEqual(ai);
    });
  });

  it('is unavailable while loading, on an error, and without an organization', async () => {
    const loading = render(ORG.id, () =>
      json({ ...ORG, ai: { available: true, record_data: true } }),
    );
    expect(loading.hook.result.current).toEqual({ available: false, record_data: false });

    vi.unstubAllGlobals();
    const failed = render(ORG.id, () => problem('INTERNAL', 500));
    await waitFor(() => {
      expect(failed.fetchMock).toHaveBeenCalled();
    });
    expect(failed.hook.result.current).toEqual({ available: false, record_data: false });

    vi.unstubAllGlobals();
    const none = render(undefined, () => json(ORG));
    expect(none.hook.result.current).toEqual({ available: false, record_data: false });
    expect(none.fetchMock).not.toHaveBeenCalled();
  });

  it('follows the cached organization (the settings page writes `ai` after a save)', async () => {
    const { hook, queryClient } = render(ORG.id, () =>
      json({ ...ORG, ai: { available: false, record_data: false } }),
    );
    await waitFor(() => {
      expect(queryClient.getQueryData(keys.org(ORG.id))).toBeDefined();
    });
    queryClient.setQueryData(keys.org(ORG.id), {
      ...ORG,
      ai: { available: true, record_data: false },
    });
    await waitFor(() => {
      expect(hook.result.current).toEqual({ available: true, record_data: false });
    });
  });
});
