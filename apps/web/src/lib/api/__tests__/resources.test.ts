import { describe, expect, it, vi } from 'vitest';

import { api } from '..';
import { ApiError } from '../client';
import { rolesApi } from '../roles';

const TABLE = 'tbl_Orders0000000001';
const RECORD = 'rec_A1b2C3d4E5f6G7h8';
const BASE = 'bse_Sales00000000001';
const NOW = '2026-09-24T00:00:00.000Z';

const record = (version = 1) => ({
  id: RECORD,
  created_at: NOW,
  updated_at: NOW,
  version,
  fields: { fld_Amount0000000001: 10 },
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function problem(code: string, status: number, extra: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      type: `https://cellhive.io/errors/${code}`,
      title: code,
      status,
      code,
      request_id: 'req_0123456789ABCDEF',
      ...extra,
    }),
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

function mockFetch(response: Response) {
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(() =>
    Promise.resolve(response),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function lastCall(fetchMock: ReturnType<typeof mockFetch>) {
  const call = fetchMock.mock.calls.at(-1);
  if (call === undefined) throw new TypeError('fetch was not called');
  const [url, init = {}] = call;
  return { url: new URL(url, 'http://localhost'), init, headers: new Headers(init.headers) };
}

describe('api.records (FRONTEND §3.1)', () => {
  it('queries by field id with JSON cells by default, and passes the signal', async () => {
    const fetchMock = mockFetch(json({ records: [record()], total: 1, offset: 0, limit: 200 }));
    const controller = new AbortController();
    const page = await api.records.query(
      TABLE,
      { filter: { op: 'and', items: [] }, include_total: false },
      { signal: controller.signal },
    );
    expect(page.records).toHaveLength(1);
    const { url, init } = lastCall(fetchMock);
    expect(url.pathname).toBe(`/api/v1/tables/${TABLE}/records/query`);
    expect(url.searchParams.get('field_key_type')).toBe('id');
    expect(url.searchParams.get('cell_format')).toBe('json');
    expect(init.method).toBe('POST');
    expect(init.signal).toBe(controller.signal);
    expect(JSON.parse(init.body as string)).toEqual({
      filter: { op: 'and', items: [] },
      include_total: false,
    });
  });

  it('sends X-CSRF-Token on every write', async () => {
    document.cookie = 'ob_csrf=nonce.sig; path=/';
    const writes: [string, () => Promise<unknown>, Response][] = [
      ['create', () => api.records.create(TABLE, [{ fields: {} }]), json({ records: [] }, 201)],
      [
        'update',
        () => api.records.update(TABLE, [{ id: RECORD, version: 1, fields: {} }]),
        json({ records: [] }),
      ],
      ['remove', () => api.records.remove(TABLE, [RECORD]), json({ ids: [RECORD] })],
      ['restore', () => api.records.restore(TABLE, [RECORD]), json({ records: [] })],
      [
        'unassign',
        () =>
          rolesApi.unassign(BASE, {
            principal_type: 'user',
            principal_id: 'usr_0123456789ABCDEF',
          }),
        new Response(null, { status: 204 }),
      ],
    ];
    for (const [name, call, response] of writes) {
      const fetchMock = mockFetch(response);
      await call();
      expect(lastCall(fetchMock).headers.get('x-csrf-token'), name).toBe('nonce.sig');
    }
  });

  it('repeats list parameters and adds the Idempotency-Key header', async () => {
    let fetchMock = mockFetch(json(record()));
    await api.records.get(TABLE, RECORD, { fields: ['fld_A', 'fld,B'] });
    expect(lastCall(fetchMock).url.searchParams.getAll('fields')).toEqual(['fld_A', 'fld,B']);

    fetchMock = mockFetch(json({ records: [record()] }, 201));
    await api.records.create(TABLE, [{ fields: {} }], { typecast: true, idempotencyKey: 'k-1' });
    const { url, headers } = lastCall(fetchMock);
    expect(url.searchParams.get('typecast')).toBe('true');
    expect(headers.get('idempotency-key')).toBe('k-1');
  });

  it('answers null when a write leaves the record unreadable (204)', async () => {
    mockFetch(new Response(null, { status: 204 }));
    await expect(
      api.records.updateOne(TABLE, RECORD, { version: 1, fields: {} }),
    ).resolves.toBeNull();
  });

  it('passes the history cursor and field filter', async () => {
    const fetchMock = mockFetch(json({ items: [], next_cursor: null }));
    await api.records.history(TABLE, RECORD, { cursor: 'c1', field: 'fld_Status0000000001' });
    const { url } = lastCall(fetchMock);
    expect(url.pathname).toBe(`/api/v1/tables/${TABLE}/records/${RECORD}/history`);
    expect(url.searchParams.get('cursor')).toBe('c1');
    expect(url.searchParams.get('field')).toBe('fld_Status0000000001');
    expect(url.searchParams.get('field_key_type')).toBe('id');
  });

  it('omits an empty cursor on the first trash page', async () => {
    const fetchMock = mockFetch(json({ records: [], next_cursor: null }));
    await api.records.trash(TABLE, { cursor: null });
    expect(lastCall(fetchMock).url.searchParams.has('cursor')).toBe(false);
  });
});

describe('error mapping of the endpoint functions', () => {
  it.each([
    [
      'version conflict',
      () => api.records.update(TABLE, [{ id: RECORD, version: 1, fields: {} }]),
      problem('VERSION_CONFLICT', 409, {
        errors: [
          {
            path: 'records[0]',
            code: 'VERSION_CONFLICT',
            message: 'Version mismatch',
            params: { current_version: 3 },
          },
        ],
      }),
      { status: 409, code: 'VERSION_CONFLICT' },
    ],
    [
      'invalid cell',
      () => api.records.create(TABLE, [{ fields: { fld_Amount0000000001: 'x' } }]),
      problem('INVALID_CELL_VALUE', 422, {
        errors: [
          { path: 'records[0].fields.fld_Amount0000000001', code: 'EXPECTED_NUMBER', message: 'x' },
        ],
      }),
      { status: 422, code: 'INVALID_CELL_VALUE' },
    ],
    [
      'hidden table',
      () => api.fields.list(TABLE),
      problem('NOT_FOUND', 404),
      { status: 404, code: 'NOT_FOUND' },
    ],
    [
      'schema lock',
      () => api.fields.create(TABLE, { name: 'A', type: 'text' }),
      problem('SCHEMA_LOCKED', 409),
      { status: 409, code: 'SCHEMA_LOCKED' },
    ],
    [
      'role still assigned',
      () => rolesApi.remove(BASE, 'rol_Sales00000000001'),
      problem('VALIDATION_FAILED', 422, {
        errors: [
          {
            path: 'role_id',
            code: 'ROLE_IN_USE',
            message: 'assigned',
            params: { assignments: 2 },
          },
        ],
      }),
      { status: 422, code: 'VALIDATION_FAILED' },
    ],
    [
      'job of someone else',
      () => api.jobs.get('job_0123456789ABCDEF'),
      problem('NOT_FOUND', 404),
      { status: 404, code: 'NOT_FOUND' },
    ],
  ])('%s → ApiError', async (_name, call, response, expected) => {
    mockFetch(response);
    const error: unknown = await call().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ ...expected, request_id: 'req_0123456789ABCDEF' });
    if (expected.code !== 'NOT_FOUND' && expected.code !== 'SCHEMA_LOCKED') {
      expect((error as ApiError).errors).toHaveLength(1);
    }
  });

  it('reports a response that breaks the contract as UNEXPECTED_RESPONSE (dev)', async () => {
    mockFetch(json({ items: [{ id: 'not-a-table' }], total: 1, offset: 0, limit: 1000 }));
    await expect(api.tables.list(BASE)).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
  });

  it('reports an unreachable server as NETWORK_ERROR', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    await expect(rolesApi.list(BASE)).rejects.toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
  });
});
