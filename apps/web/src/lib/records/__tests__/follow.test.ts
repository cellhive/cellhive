import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { keys } from '../../query/keys';
import { showErrorToast } from '../../toast/toast';
import { optimisticFollow, setRecordFollow } from '../follow';

import type { RecordFollowDto } from '@cellhive/contracts';

vi.mock('../../toast/toast', () => ({ showErrorToast: vi.fn() }));

const TABLE = 'tbl_0123456789ABCDEF';
const RECORD = 'rec_0123456789ABCDEF';
const KEY = keys.recordFollow(TABLE, RECORD);

describe('optimisticFollow', () => {
  it.each<[string, RecordFollowDto | undefined, boolean, RecordFollowDto]>([
    ['unknown → follow', undefined, true, { following: true, source: 'manual' }],
    ['unknown → unfollow', undefined, false, { following: false, source: null }],
    [
      'not following → follow',
      { following: false, source: null },
      true,
      { following: true, source: 'manual' },
    ],
    [
      'created → follow keeps the source',
      { following: true, source: 'created' },
      true,
      { following: true, source: 'created' },
    ],
    [
      'assigned → unfollow',
      { following: true, source: 'assigned' },
      false,
      { following: false, source: null },
    ],
  ])('%s', (_, previous, following, expected) => {
    expect(optimisticFollow(previous, following)).toEqual(expected);
  });
});

function response(status: number, body?: unknown): Response {
  return body === undefined
    ? new Response(null, { status })
    : new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/problem+json' },
      });
}

function problemOf(code: string, status: number) {
  return response(status, { type: code, title: code, status, code, request_id: 'req_1' });
}

describe('setRecordFollow', () => {
  let client: QueryClient;
  beforeEach(() => {
    client = new QueryClient();
  });
  afterEach(() => {
    vi.mocked(showErrorToast).mockClear();
    vi.unstubAllGlobals();
  });

  it('PUT / DELETE the follow route, the state changing before the answer', async () => {
    let release: (value: Response) => void = () => undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    client.setQueryData<RecordFollowDto>(KEY, { following: false, source: null });
    const done = setRecordFollow(client, TABLE, RECORD, true);
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(client.getQueryData(KEY)).toEqual({ following: true, source: 'manual' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/v1/tables/${TABLE}/records/${RECORD}/follow`);
    expect(init.method).toBe('PUT');
    release(response(204));
    await expect(done).resolves.toBe('done');
    expect(client.getQueryData(KEY)).toEqual({ following: true, source: 'manual' });
  });

  it('runs the requests of a record in click order', async () => {
    const order: string[] = [];
    const releases: ((value: Response) => void)[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_: string, init: RequestInit) =>
          new Promise<Response>((resolve) => {
            order.push(init.method ?? 'GET');
            releases.push(resolve);
          }),
      ),
    );
    const first = setRecordFollow(client, TABLE, RECORD, true);
    const second = setRecordFollow(client, TABLE, RECORD, false);
    await vi.waitFor(() => {
      expect(order).toEqual(['PUT']);
    });
    // The DELETE waits for the PUT.
    expect(client.getQueryData(KEY)).toEqual({ following: false, source: null });
    releases[0]?.(response(204));
    await vi.waitFor(() => {
      expect(order).toEqual(['PUT', 'DELETE']);
    });
    releases[1]?.(response(204));
    await expect(Promise.all([first, second])).resolves.toEqual(['done', 'done']);
  });

  it('a refusal puts the state back and shows an error toast', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(problemOf('VALIDATION_FAILED', 422))),
    );
    client.setQueryData<RecordFollowDto>(KEY, { following: false, source: null });
    await expect(setRecordFollow(client, TABLE, RECORD, true)).resolves.toBe('failed');
    expect(client.getQueryData(KEY)).toEqual({ following: false, source: null });
    expect(showErrorToast).toHaveBeenCalledTimes(1);
    expect(vi.mocked(showErrorToast).mock.calls[0]?.[0]).toMatchObject({
      status: 422,
      code: 'VALIDATION_FAILED',
    });
  });

  it('404: `gone`, not following, no error toast', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(problemOf('NOT_FOUND', 404))),
    );
    client.setQueryData<RecordFollowDto>(KEY, { following: true, source: 'created' });
    await expect(setRecordFollow(client, TABLE, RECORD, false)).resolves.toBe('gone');
    expect(client.getQueryData(KEY)).toEqual({ following: false, source: null });
    expect(showErrorToast).not.toHaveBeenCalled();
  });
});
