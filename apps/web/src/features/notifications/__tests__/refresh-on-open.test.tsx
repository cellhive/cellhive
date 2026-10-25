import {
  QueryClient,
  QueryClientProvider,
  useInfiniteQuery,
  useQuery,
} from '@tanstack/react-query';
import { render, waitFor } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { keys } from '../../../lib/query/keys';
import { useRefreshOnOpen } from '../panel/use-refresh-on-open';

const ORG = 'org_aaaaaaaaaaaaaaaa';
const FILTER = { unread: false, baseId: null };

type Cache = 'empty' | 'fresh' | 'stale';

function setup(cache: Cache) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  });
  const listFn = vi.fn(() => Promise.resolve({ items: [], next_cursor: null }));
  const countFn = vi.fn(() => Promise.resolve({ count: 2 }));
  const settingsFn = vi.fn(() => Promise.resolve({ email_frequency: 'immediate' }));
  if (cache !== 'empty') {
    const updatedAt = cache === 'fresh' ? Date.now() : Date.now() - 600_000;
    client.setQueryData(
      keys.notificationList(ORG, FILTER),
      { pages: [{ items: [], next_cursor: null }], pageParams: [null] },
      { updatedAt },
    );
    client.setQueryData(keys.notificationUnreadCount(ORG), { count: 0 }, { updatedAt });
  }
  client.setQueryData(keys.notificationSettings(ORG), { email_frequency: 'daily' });
  return { client, listFn, countFn, settingsFn };
}

interface PanelProps {
  readonly listFn: () => Promise<unknown>;
  readonly countFn: () => Promise<unknown>;
  readonly settingsFn: () => Promise<unknown>;
}

/** The queries of the notification panel, plus the settings page possibly open behind it. */
function Panel({ listFn, countFn, settingsFn }: PanelProps) {
  useInfiniteQuery({
    queryKey: keys.notificationList(ORG, FILTER),
    queryFn: listFn,
    initialPageParam: null as string | null,
    getNextPageParam: () => null,
  });
  useQuery({ queryKey: keys.notificationUnreadCount(ORG), queryFn: countFn, staleTime: 300_000 });
  useQuery({ queryKey: keys.notificationSettings(ORG), queryFn: settingsFn });
  useRefreshOnOpen(ORG);
  return null;
}

function tree(client: QueryClient, props: PanelProps, strict = false) {
  const node: ReactNode = (
    <QueryClientProvider client={client}>
      <Panel {...props} />
    </QueryClientProvider>
  );
  return strict ? <StrictMode>{node}</StrictMode> : node;
}

describe('useRefreshOnOpen (T556, QA S5 L2)', () => {
  const cases: { name: string; cache: Cache; strict: boolean }[] = [
    { name: 'nothing cached', cache: 'empty', strict: false },
    { name: 'fresh cache (realtime missed a message)', cache: 'fresh', strict: false },
    { name: 'stale cache (joins the fetch on mount)', cache: 'stale', strict: false },
    { name: 'fresh cache, StrictMode', cache: 'fresh', strict: true },
    { name: 'stale cache, StrictMode', cache: 'stale', strict: true },
  ];

  it.each(cases)(
    'refetches the count and the list exactly once: $name',
    async ({ cache, strict }) => {
      const { client, ...props } = setup(cache);
      render(tree(client, props, strict));
      await waitFor(() => {
        expect(client.getQueryData(keys.notificationUnreadCount(ORG))).toEqual({ count: 2 });
      });
      await waitFor(() => {
        expect(client.isFetching()).toBe(0);
      });
      expect(props.countFn).toHaveBeenCalledTimes(1);
      expect(props.listFn).toHaveBeenCalledTimes(1);
      // Not the panel's: the settings page behind it keeps its data.
      expect(props.settingsFn).not.toHaveBeenCalled();
    },
  );

  it('refetches again on the next opening, and never on its own', async () => {
    const { client, ...props } = setup('fresh');
    const first = render(tree(client, props));
    await waitFor(() => {
      expect(props.countFn).toHaveBeenCalledTimes(1);
    });
    first.unmount();
    render(tree(client, props));
    await waitFor(() => {
      expect(props.countFn).toHaveBeenCalledTimes(2);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(props.countFn).toHaveBeenCalledTimes(2);
    expect(props.listFn).toHaveBeenCalledTimes(2);
  });
});
