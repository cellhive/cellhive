import { meResponseSchema } from '@cellhive/contracts';
import { describe, expect, it, vi } from 'vitest';

import { ApiError, apiRequest, apiRequestVoid, isApiError, readCookie } from '../client';

const ME = {
  user: {
    id: 'usr_0123456789ABCDEF',
    email: 'an@example.test',
    display_name: 'An',
    avatar_url: null,
  },
  orgs: [],
  locale: 'en',
  timezone: 'UTC',
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

function mockFetch(response: Response | (() => Promise<Response>)) {
  const fetchMock = vi.fn(
    typeof response === 'function' ? response : () => Promise.resolve(response),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function lastInit(fetchMock: ReturnType<typeof mockFetch>): RequestInit {
  const call = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit] | undefined;
  if (call === undefined) throw new TypeError('fetch was not called');
  return call[1];
}

function lastUrl(fetchMock: ReturnType<typeof mockFetch>): string {
  const call = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit] | undefined;
  return call?.[0] ?? '';
}

describe('readCookie', () => {
  it.each([
    ['ob_csrf=abc.def', 'abc.def'],
    ['a=1; ob_csrf=abc.def; b=2', 'abc.def'],
    ['ob_csrf_other=x; ob_csrf=y', 'y'],
    ['ob_csrf=a%2Eb', 'a.b'],
    ['other=1', undefined],
    ['', undefined],
  ])('reads ob_csrf from %j', (cookies, expected) => {
    expect(readCookie('ob_csrf', cookies)).toBe(expected);
  });
});

describe('apiRequest', () => {
  it('calls /api/v1 with credentials, Accept and the abort signal', async () => {
    const fetchMock = mockFetch(jsonResponse(ME));
    const controller = new AbortController();
    const me = await apiRequest('/me', meResponseSchema, { signal: controller.signal });
    expect(me.user.email).toBe('an@example.test');
    expect(lastUrl(fetchMock)).toBe('/api/v1/me');
    const init = lastInit(fetchMock);
    expect(init.credentials).toBe('include');
    expect(init.signal).toBe(controller.signal);
    expect(new Headers(init.headers).get('accept')).toBe('application/json');
  });

  it('serialises query parameters and skips undefined ones', async () => {
    const fetchMock = mockFetch(jsonResponse({ items: [], total: 0, offset: 0, limit: 5 }));
    await apiRequestVoid('/orgs', { query: { offset: 0, limit: 5, status: undefined } });
    expect(lastUrl(fetchMock)).toBe('/api/v1/orgs?offset=0&limit=5');
  });

  it.each(['POST', 'PATCH', 'PUT', 'DELETE'] as const)(
    'sends the CSRF cookie as X-CSRF-Token on %s',
    async (method) => {
      document.cookie = 'ob_csrf=nonce.signature; path=/';
      const fetchMock = mockFetch(new Response(null, { status: 204 }));
      await apiRequestVoid('/auth/logout', { method, body: { a: 1 } });
      const headers = new Headers(lastInit(fetchMock).headers);
      expect(headers.get('x-csrf-token')).toBe('nonce.signature');
      expect(headers.get('content-type')).toBe('application/json');
      expect(lastInit(fetchMock).body).toBe('{"a":1}');
    },
  );

  it('does not send the CSRF header on GET', async () => {
    document.cookie = 'ob_csrf=nonce.signature; path=/';
    const fetchMock = mockFetch(jsonResponse(ME));
    await apiRequest('/me', meResponseSchema);
    expect(new Headers(lastInit(fetchMock).headers).has('x-csrf-token')).toBe(false);
  });

  it('omits the CSRF header when there is no cookie (no session yet)', async () => {
    const fetchMock = mockFetch(new Response(null, { status: 204 }));
    await apiRequestVoid('/auth/login', { method: 'POST', body: {} });
    expect(new Headers(lastInit(fetchMock).headers).has('x-csrf-token')).toBe(false);
  });

  it('turns problem+json into an ApiError with code, errors and request_id', async () => {
    mockFetch(
      jsonResponse(
        {
          type: 'https://cellhive.io/errors/VALIDATION_FAILED',
          title: 'Validation failed',
          status: 422,
          code: 'VALIDATION_FAILED',
          detail: 'The request does not match the expected schema.',
          errors: [
            { path: 'password', code: 'TOO_SMALL', message: 'Too small', params: { minimum: 10 } },
            { nonsense: true },
          ],
          request_id: 'req_0123456789ABCDEF',
        },
        { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
      ),
    );
    const error = await apiRequestVoid('/setup', { method: 'POST', body: {} }).catch(
      (caught: unknown) => caught,
    );
    expect(isApiError(error)).toBe(true);
    expect(error).toMatchObject({
      status: 422,
      code: 'VALIDATION_FAILED',
      detail: 'The request does not match the expected schema.',
      request_id: 'req_0123456789ABCDEF',
      errors: [{ path: 'password', code: 'TOO_SMALL', params: { minimum: 10 } }],
    });
  });

  it('keeps Retry-After in seconds', async () => {
    mockFetch(
      jsonResponse(
        { code: 'RATE_LIMITED', status: 429, title: 'Rate limited', request_id: 'req_x' },
        { status: 429, headers: { 'Retry-After': '42' } },
      ),
    );
    const error = await apiRequestVoid('/auth/login', { method: 'POST', body: {} }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).retry_after).toBe(42);
  });

  it('maps a non-problem error page to UNEXPECTED_RESPONSE with its status', async () => {
    mockFetch(new Response('<html>Bad gateway</html>', { status: 502 }));
    await expect(apiRequest('/me', meResponseSchema)).rejects.toMatchObject({
      status: 502,
      code: 'UNEXPECTED_RESPONSE',
    });
  });

  it('maps a failed connection to NETWORK_ERROR', async () => {
    mockFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    await expect(apiRequest('/me', meResponseSchema)).rejects.toMatchObject({
      status: 0,
      code: 'NETWORK_ERROR',
    });
  });

  it('rethrows cancellation as is', async () => {
    const controller = new AbortController();
    mockFetch(() => {
      controller.abort();
      return Promise.reject(new DOMException('Aborted', 'AbortError'));
    });
    const error = await apiRequest('/me', meResponseSchema, { signal: controller.signal }).catch(
      (caught: unknown) => caught,
    );
    expect(isApiError(error)).toBe(false);
    expect((error as DOMException).name).toBe('AbortError');
  });

  it('validates responses against the contract in development', async () => {
    mockFetch(jsonResponse({ user: { id: 'not-an-id' } }));
    await expect(apiRequest('/me', meResponseSchema)).rejects.toMatchObject({
      code: 'UNEXPECTED_RESPONSE',
    });
  });
});

describe('429 retries of writes (T421a)', () => {
  const limited = (retryAfter: string | null = '1') =>
    new Response(JSON.stringify({ code: 'RATE_LIMITED', title: 'Too many requests' }), {
      status: 429,
      headers: {
        'Content-Type': 'application/problem+json',
        ...(retryAfter === null ? {} : { 'Retry-After': retryAfter }),
      },
    });
  const answers = (...responses: (() => Response)[]) => {
    let call = 0;
    return mockFetch(() => {
      const next = responses[Math.min(call, responses.length - 1)];
      call += 1;
      return Promise.resolve((next ?? (() => jsonResponse(ME)))());
    });
  };

  it.each([
    ['POST with an Idempotency-Key', { method: 'POST', idempotencyKey: 'key-1', body: {} }],
    ['PATCH with a version', { method: 'PATCH', body: { fields: {}, version: 3 } }],
    [
      'PATCH of records, each with a version',
      { method: 'PATCH', body: { records: [{ id: 'rec_1', version: 1, fields: {} }] } },
    ],
    ['DELETE with an Idempotency-Key', { method: 'DELETE', idempotencyKey: 'key-2' }],
  ] as const)('retries %s after Retry-After, then succeeds', async (_name, options) => {
    vi.useFakeTimers();
    try {
      const fetchMock = answers(
        () => limited('2'),
        () => jsonResponse(ME),
      );
      const done = apiRequest('/me', meResponseSchema, options);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(done).resolves.toMatchObject({ user: { email: 'an@example.test' } });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // The same key goes with the retry: the server replays one write.
      if ('idempotencyKey' in options) {
        expect(new Headers(lastInit(fetchMock).headers).get('idempotency-key')).toBe(
          options.idempotencyKey,
        );
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up after 2 retries with the 429', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = answers(() => limited('1'));
      const done = apiRequest('/me', meResponseSchema, {
        method: 'PATCH',
        body: { fields: {}, version: 1 },
      });
      const caught = done.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(5_000);
      const error = await caught;
      expect(isApiError(error) && error.status).toBe(429);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['a POST without Idempotency-Key', { method: 'POST', body: {} }, () => limited()],
    ['a PATCH without version', { method: 'PATCH', body: { fields: {} } }, () => limited()],
    [
      'a PATCH of records one of which has no version',
      { method: 'PATCH', body: { records: [{ id: 'rec_1', version: 1 }, { id: 'rec_2' }] } },
      () => limited(),
    ],
    ['a GET (queries retry on their own)', { method: 'GET' }, () => limited()],
    [
      'another error (503)',
      { method: 'POST', idempotencyKey: 'key-3', body: {} },
      () => new Response('{}', { status: 503 }),
    ],
    [
      'a 409 conflict',
      { method: 'PATCH', body: { fields: {}, version: 1 } },
      () => new Response(JSON.stringify({ code: 'VERSION_CONFLICT' }), { status: 409 }),
    ],
    [
      'a wait longer than the client waits (Retry-After 120)',
      { method: 'POST', idempotencyKey: 'key-4', body: {} },
      () => limited('120'),
    ],
  ] as const)('never retries %s', async (_name, options, response) => {
    const fetchMock = answers(response);
    await expect(apiRequest('/me', meResponseSchema, options)).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops waiting when the request is aborted', async () => {
    const fetchMock = answers(() => limited('5'));
    const controller = new AbortController();
    const done = apiRequest('/me', meResponseSchema, {
      method: 'POST',
      idempotencyKey: 'key-5',
      body: {},
      signal: controller.signal,
    });
    const caught = done.catch((error: unknown) => error);
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    controller.abort();
    expect(await caught).toBeInstanceOf(Error);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
