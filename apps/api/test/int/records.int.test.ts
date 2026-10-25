import {
  deletedRecordsResponseSchema,
  IDEMPOTENT_REPLAYED_HEADER,
  newId,
  recordListResponseSchema,
  recordSchema,
  recordsResponseSchema,
  upsertRecordsResponseSchema,
  type Id,
  type RecordDto,
} from '@cellhive/contracts';
import { type Db } from '@cellhive/server-core';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { requestFingerprint } from '../../src/common/idempotency/idempotency.service.js';
import { ApiRateLimits } from '../../src/common/rate-limit/api-rate-limits.js';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import {
  buildRecordFixture,
  expectProblem,
  relaxRateLimits,
  type RecordFixture,
} from './record-fixture.js';
import { problemOf, startTestApp, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';

/** Today in the organization's zone as `yyyyMMdd` (auto number `created_time` rule). */
function todayInHoChiMinh(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(new Date())
    .replaceAll('-', '');
}

function records(response: LightMyRequestResponse): RecordDto[] {
  return recordsResponseSchema.parse(response.json()).records;
}

/**
 * T108: the record REST API. Every HTTP example of CONTRACTS §1.4 runs
 * against the real application and its response is checked against the
 * documented shape; then `Idempotency-Key`, rate limits and the permission
 * matrix of CONTRACTS §5 (P03, P04, P07, P09–P15) end to end.
 */
describe('record API (T108)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let tickets: string;
  let orders: string;
  let customers: string;

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    fx = await buildRecordFixture(t, db);
    tickets = `/tables/${fx.tickets.id}/records`;
    orders = `/tables/${fx.orders.id}/records`;
    customers = `/tables/${fx.customers.id}/records`;
  });

  afterAll(async () => {
    await t.close();
    await db.destroy();
    await database.drop();
  });

  describe('CONTRACTS §1.4 examples', () => {
    let created: RecordDto;

    it('creates with typecast: "1.500.000", "25/09/2026", option name, auto number', async () => {
      // The example's "Khách hàng" link field arrives in S4 (BACKLOG T108): left out here.
      const response = await fx.call(
        'u_admin',
        'POST',
        `${tickets}?field_key_type=name&typecast=true`,
        {
          records: [
            {
              fields: {
                'Tiêu đề': 'Máy POS lỗi in',
                'Trạng thái': 'Mới',
                'Số tiền': '1.500.000',
                Hạn: '25/09/2026',
              },
            },
          ],
        },
      );
      expect(response.statusCode).toBe(201);
      const [record] = records(response);
      if (record === undefined) throw new Error('no record');
      expect(record.id).toMatch(/^rec_[0-9A-Za-z]{16}$/);
      expect(record.version).toBe(1);
      expect(record.created_at).toBe(record.updated_at);
      expect(record.fields).toEqual({
        'Tiêu đề': 'Máy POS lỗi in',
        'Trạng thái': 'Mới',
        'Số tiền': 1500000,
        Hạn: '2026-09-25',
        'Mã ticket': expect.stringMatching(
          new RegExp(`^TK-${todayInHoChiMinh()}-\\d{4}$`),
        ) as unknown,
      });
      created = record;
    });

    it('creates a single record from `{ fields }` and answers the record itself', async () => {
      const response = await fx.call('u_admin', 'POST', tickets, {
        fields: { 'Tiêu đề': 'Một bản ghi', 'Số tiền': 10 },
      });
      expect(response.statusCode).toBe(201);
      const record = recordSchema.parse(response.json());
      expect(record.fields).toMatchObject({ 'Tiêu đề': 'Một bản ghi', 'Số tiền': 10 });
    });

    it('typecasts with the base locale, not the writer locale (CONTRACTS §2)', async () => {
      const typecast = (value: string) =>
        fx.call('u_editor', 'POST', `${tickets}?typecast=true`, {
          fields: { 'Tiêu đề': 'Locale', 'Số tiền': value },
        });
      const amountOf = (response: LightMyRequestResponse) =>
        recordSchema.parse(response.json()).fields['Số tiền'];
      try {
        // The writer prefers English; the organization (no base locale) is `vi`.
        await db.kysely
          .updateTable('meta.users')
          .set({ locale: 'en-US' })
          .where('id', '=', fx.users.u_editor.id)
          .execute();
        expect(amountOf(await typecast('1.500.000'))).toBe(1500000);

        // A base locale wins over the organization default.
        await sql`UPDATE meta.bases SET settings = settings || '{"locale":"en-US"}'::jsonb
                   WHERE id = ${fx.baseId}`.execute(db.kysely);
        expect(amountOf(await typecast('1,500,000'))).toBe(1500000);
      } finally {
        await sql`UPDATE meta.bases SET settings = settings - 'locale' WHERE id = ${fx.baseId}`.execute(
          db.kysely,
        );
        await db.kysely
          .updateTable('meta.users')
          .set({ locale: null })
          .where('id', '=', fx.users.u_editor.id)
          .execute();
      }
    });

    it('rejects a string number without typecast', async () => {
      const response = await fx.call('u_admin', 'POST', tickets, {
        records: [{ fields: { 'Số tiền': '1.500.000' } }],
      });
      expectProblem(response, 422, 'INVALID_CELL_VALUE');
      expect(problemOf(response.body).errors).toEqual([
        expect.objectContaining({ path: 'records[0].fields.Số tiền', code: 'EXPECTED_NUMBER' }),
      ]);
    });

    it('PATCH (bulk, field ids) with version; a stale version is 409 VERSION_CONFLICT', async () => {
      const status = fx.fld.ticketStatus?.id ?? '';
      const response = await fx.call('u_admin', 'PATCH', `${tickets}?field_key_type=id`, {
        records: [{ id: created.id, version: 1, fields: { [status]: 'Đang xử lý' } }],
      });
      expect(response.statusCode).toBe(200);
      const [record] = records(response);
      expect(record).toMatchObject({ id: created.id, version: 2 });
      expect(record?.fields[status]).toBe('Đang xử lý');
      expect(Object.keys(record?.fields ?? {}).every((key) => key.startsWith('fld_'))).toBe(true);

      const stale = await fx.call('u_admin', 'PATCH', `${tickets}?field_key_type=id`, {
        records: [{ id: created.id, version: 1, fields: { [status]: 'Mới' } }],
      });
      expectProblem(stale, 409, 'VERSION_CONFLICT');
      expect(problemOf(stale.body).errors).toEqual([
        expect.objectContaining({
          code: 'VERSION_CONFLICT',
          params: expect.objectContaining({
            current_version: 2,
            updated_at: record?.updated_at,
            updated_by: { id: fx.users.u_admin.id, name: expect.any(String) as unknown },
          }) as unknown,
        }),
      ]);
    });

    it('upserts on merge_on: first creates, then updates the same record', async () => {
      const body = (name: string) => ({
        upsert: { merge_on: ['Mã khách hàng'] },
        records: [{ fields: { 'Mã khách hàng': 'KH001', Tên: name } }],
      });
      const first = await fx.call('u_admin', 'PATCH', customers, body('An Phát'));
      expect(first.statusCode).toBe(200);
      const created = upsertRecordsResponseSchema.parse(first.json());
      expect(created.created_ids).toHaveLength(1);
      expect(created.updated_ids).toEqual([]);
      expect(created.records[0]?.fields).toEqual({ Tên: 'An Phát', 'Mã khách hàng': 'KH001' });

      const second = await fx.call('u_admin', 'PATCH', customers, body('Cửa hàng An Phát'));
      const updated = upsertRecordsResponseSchema.parse(second.json());
      expect(updated.created_ids).toEqual([]);
      expect(updated.updated_ids).toEqual(created.created_ids);
      expect(updated.records[0]).toMatchObject({ version: 2, fields: { Tên: 'Cửa hàng An Phát' } });
    });

    it('DELETE { ids } soft-deletes; POST restore brings the record back', async () => {
      const deleted = await fx.call('u_admin', 'DELETE', tickets, { ids: [created.id] });
      expect(deleted.statusCode).toBe(200);
      expect(deletedRecordsResponseSchema.parse(deleted.json())).toEqual({ ids: [created.id] });
      expectProblem(await fx.call('u_admin', 'GET', `${tickets}/${created.id}`), 404, 'NOT_FOUND');

      const restored = await fx.call('u_admin', 'POST', `${tickets}/restore`, {
        ids: [created.id],
      });
      expect(restored.statusCode).toBe(200);
      const [record] = records(restored);
      // Delete and restore bump the version (T107 convention).
      expect(record).toMatchObject({ id: created.id, version: 4 });
      expect((await fx.call('u_admin', 'GET', `${tickets}/${created.id}`)).statusCode).toBe(200);
    });

    it('queries with a tuple filter, sort, search and field list', async () => {
      await fx.call('u_admin', 'POST', `${tickets}?typecast=true`, {
        records: [
          {
            fields: {
              'Tiêu đề': 'Cửa hàng An Phát báo lỗi',
              'Trạng thái': 'Mới',
              Hạn: '01/03/2020',
            },
          },
          {
            fields: { 'Tiêu đề': 'AN PHAT đổi máy', 'Trạng thái': 'Đang xử lý', Hạn: '01/01/2020' },
          },
          { fields: { 'Tiêu đề': 'An Phát hẹn sau', 'Trạng thái': 'Mới', Hạn: '01/01/2999' } },
          { fields: { 'Tiêu đề': 'An Phát xong', 'Trạng thái': 'Đã xong', Hạn: '01/01/2020' } },
          { fields: { 'Tiêu đề': 'Bình Minh', 'Trạng thái': 'Mới', Hạn: '01/01/2020' } },
        ],
      });
      // The example's `view_id` is left out: views arrive in S3 (any view is 404 until then).
      const body = {
        fields: ['Tiêu đề', 'Trạng thái'],
        filter: {
          logic: 'and',
          conditions: [
            ['Trạng thái', 'intersects', ['Mới', 'Đang xử lý']],
            ['Hạn', '<', 'Today'],
          ],
        },
        sort: [{ field: 'Hạn', direction: 'asc' }],
        search: 'an phat',
        offset: 0,
        limit: 200,
      };
      const response = await fx.call(
        'u_admin',
        'POST',
        `${tickets}/query?field_key_type=name`,
        body,
      );
      expect(response.statusCode).toBe(200);
      const list = recordListResponseSchema.parse(response.json());
      expect(list).toMatchObject({ total: 2, offset: 0, limit: 200 });
      expect(list.records.map((record) => record.fields)).toEqual([
        { 'Tiêu đề': 'AN PHAT đổi máy', 'Trạng thái': 'Đang xử lý' },
        { 'Tiêu đề': 'Cửa hàng An Phát báo lỗi', 'Trạng thái': 'Mới' },
      ]);

      // The same query as GET query-string parameters.
      const query = new URLSearchParams([
        ['fields', 'Tiêu đề'],
        ['fields', 'Trạng thái'],
        ['filter', JSON.stringify(body.filter)],
        ['sort', JSON.stringify(body.sort)],
        ['search', 'an phat'],
        ['limit', '200'],
      ]);
      const listed = await fx.call('u_admin', 'GET', `${tickets}?${query.toString()}`);
      expect(listed.statusCode).toBe(200);
      expect(recordListResponseSchema.parse(listed.json())).toEqual(list);

      const withView = await fx.call('u_admin', 'POST', `${tickets}/query`, {
        ...body,
        view_id: 'viw_x',
      });
      expectProblem(withView, 404, 'NOT_FOUND');
    });

    it('GET one record honours field_key_type, cell_format and fields', async () => {
      const response = await fx.call(
        'u_admin',
        'GET',
        `${tickets}/${created.id}?cell_format=text&fields=${encodeURIComponent('Số tiền')}`,
      );
      expect(response.statusCode).toBe(200);
      const record = recordSchema.parse(response.json());
      expect(record.fields).toEqual({ 'Số tiền': expect.stringContaining('1.500.000') as unknown });
    });

    it('PATCH and DELETE one record by id', async () => {
      const response = await fx.call('u_admin', 'PATCH', `${tickets}/${created.id}`, {
        fields: { 'Tiêu đề': 'Máy POS lỗi in (đã kiểm tra)' },
      });
      expect(response.statusCode).toBe(200);
      expect(recordSchema.parse(response.json()).fields['Tiêu đề']).toBe(
        'Máy POS lỗi in (đã kiểm tra)',
      );
      const removed = await fx.call('u_admin', 'DELETE', `${tickets}/${created.id}`);
      expect(removed.statusCode).toBe(204);
      expect(removed.body).toBe('');
      expectProblem(
        await fx.call('u_admin', 'DELETE', `${tickets}/${created.id}`),
        404,
        'NOT_FOUND',
      );
    });
  });

  describe('records/query for the grid (ids, include_total)', () => {
    it('fetches given ids under the caller’s read rule, and skips the count on request', async () => {
      const created = records(
        await fx.call('u_admin', 'POST', tickets, {
          records: [{ fields: { 'Tiêu đề': 'A' } }, { fields: { 'Tiêu đề': 'B' } }],
        }),
      );
      const ids = created.map((record) => record.id);
      const query = await fx.call('u_reader', 'POST', `${tickets}/query`, {
        ids: [ids[1], 'rec_0000000000000000'],
        include_total: false,
      });
      expect(query.statusCode).toBe(200);
      const body = query.json<Record<string, unknown>>();
      expect(recordListResponseSchema.parse(body).records.map((record) => record.id)).toEqual([
        ids[1],
      ]);
      expect(body).not.toHaveProperty('total');
      expect(body).not.toHaveProperty('total_estimate');
      const counted = await fx.call('u_reader', 'POST', `${tickets}/query`, { ids });
      expect(counted.json()).toMatchObject({ total: 2 });
      expectProblem(
        await fx.call('u_reader', 'POST', `${tickets}/query`, {
          ids: Array.from({ length: 1001 }, () => ids[0]),
        }),
        422,
        'VALIDATION_FAILED',
      );
    });
  });

  describe('request validation', () => {
    it('rejects malformed ids, filters and bodies with 422 and too many records with 413', async () => {
      expectProblem(
        await fx.call('u_admin', 'GET', '/tables/not-a-table/records'),
        422,
        'VALIDATION_FAILED',
      );
      expectProblem(
        await fx.call('u_admin', 'GET', `${tickets}/rec_bad`),
        422,
        'VALIDATION_FAILED',
      );
      const badFilter = await fx.call('u_admin', 'GET', `${tickets}?filter=%7Bnot-json`);
      expectProblem(badFilter, 422, 'VALIDATION_FAILED');
      expect(problemOf(badFilter.body).errors).toEqual([
        expect.objectContaining({ path: 'filter', code: 'MALFORMED_JSON' }),
      ]);
      expectProblem(
        await fx.call('u_admin', 'POST', tickets, { records: [{ fields: {} }], fields: {} }),
        422,
        'VALIDATION_FAILED',
      );
      expectProblem(
        await fx.call('u_admin', 'PATCH', tickets, { records: [{ fields: {} }] }),
        422,
        'VALIDATION_FAILED',
      );
      const tooMany = Array.from({ length: 1001 }, () => ({ fields: {} }));
      expectProblem(
        await fx.call('u_admin', 'POST', tickets, { records: tooMany }),
        413,
        'PAYLOAD_TOO_LARGE',
      );
      expectProblem(
        await fx.call('u_admin', 'POST', `${tickets}/query`, { sort: [{ field: 'Nope' }] }),
        422,
        'INVALID_SORT',
      );
      expectProblem(
        await fx.call('u_admin', 'GET', `/tables/${newId('tbl')}/records`),
        404,
        'NOT_FOUND',
      );
    });
  });

  describe('Idempotency-Key', () => {
    it('replays the stored response, rejects reuse with another body', async () => {
      const key = { 'idempotency-key': `create-${newId('req')}` };
      const body = { records: [{ fields: { 'Tiêu đề': 'Idempotent' } }] };
      const first = await fx.call('u_editor', 'POST', tickets, body, key);
      expect(first.statusCode).toBe(201);
      expect(first.headers[IDEMPOTENT_REPLAYED_HEADER]).toBeUndefined();

      const again = await fx.call('u_editor', 'POST', tickets, body, key);
      expect(again.statusCode).toBe(201);
      expect(again.headers[IDEMPOTENT_REPLAYED_HEADER]).toBe('true');
      expect(again.body).toBe(first.body);
      const count = await fx.call('u_editor', 'POST', `${tickets}/query`, { search: 'Idempotent' });
      expect(recordListResponseSchema.parse(count.json())).toMatchObject({ total: 1 });

      const other = await fx.call(
        'u_editor',
        'POST',
        tickets,
        { records: [{ fields: { 'Tiêu đề': 'Khác' } }] },
        key,
      );
      expectProblem(other, 409, 'IDEMPOTENCY_KEY_REUSED');
      // Another path with the same key is another request too.
      expectProblem(
        await fx.call('u_editor', 'POST', `${tickets}/restore`, { ids: [newId('rec')] }, key),
        409,
        'IDEMPOTENCY_KEY_REUSED',
      );
      // Keys are per principal: another user may use the same key.
      expect((await fx.call('u_admin', 'POST', tickets, body, key)).statusCode).toBe(201);
    });

    it('does not store failures: the same key works after a failed request', async () => {
      const key = { 'idempotency-key': `retry-${newId('req')}` };
      const failed = await fx.call(
        'u_editor',
        'POST',
        tickets,
        { records: [{ fields: { 'Số tiền': 'abc' } }] },
        key,
      );
      expectProblem(failed, 422, 'INVALID_CELL_VALUE');
      const ok = await fx.call(
        'u_editor',
        'POST',
        tickets,
        { records: [{ fields: { 'Số tiền': 5 } }] },
        key,
      );
      expect(ok.statusCode).toBe(201);
    });

    it('answers 409 while the first request with the key is still running', async () => {
      const key = `inflight-${newId('req')}`;
      const url = `/api/v1${tickets}`;
      await db.kysely
        .insertInto('meta.idempotency_keys')
        .values({
          organization_id: fx.orgId,
          principal_key: fx.users.u_editor.id,
          key,
          request_hash: requestFingerprint({ key, method: 'POST', url, body: { fields: {} } }),
        })
        .execute();
      const response = await fx.call(
        'u_editor',
        'POST',
        tickets,
        { fields: {} },
        { 'idempotency-key': key },
      );
      expectProblem(response, 409, 'IDEMPOTENCY_KEY_REUSED');
      expect(problemOf(response.body).detail).toMatch(/still being processed/);

      // After 60 s without a response the first request is considered dead.
      await sql`UPDATE meta.idempotency_keys SET created_at = now() - interval '2 minutes'
                 WHERE key = ${key}`.execute(db.kysely);
      const retried = await fx.call(
        'u_editor',
        'POST',
        tickets,
        { fields: {} },
        { 'idempotency-key': key },
      );
      expect(retried.statusCode).toBe(201);
    });

    it('replays restore and rejects a malformed key', async () => {
      const [record] = records(
        await fx.call('u_admin', 'POST', tickets, { records: [{ fields: { 'Tiêu đề': 'R' } }] }),
      );
      const id = record?.id as Id<'rec'>;
      await fx.call('u_admin', 'DELETE', tickets, { ids: [id] });
      const key = { 'idempotency-key': `restore-${newId('req')}` };
      const first = await fx.call('u_admin', 'POST', `${tickets}/restore`, { ids: [id] }, key);
      expect(first.statusCode).toBe(200);
      const again = await fx.call('u_admin', 'POST', `${tickets}/restore`, { ids: [id] }, key);
      expect({ status: again.statusCode, body: again.body }).toEqual({
        status: 200,
        body: first.body,
      });
      expectProblem(
        await fx.call(
          'u_admin',
          'POST',
          tickets,
          { fields: {} },
          { 'idempotency-key': 'has space' },
        ),
        422,
        'VALIDATION_FAILED',
      );
    });
  });

  describe('rate limits', () => {
    it('limits requests per user and base with 429 + Retry-After', async () => {
      const limits = t.app.get(ApiRateLimits);
      try {
        limits.perBase = { limit: 3, windowSeconds: 60 };
        for (let i = 0; i < 3; i += 1) {
          expect((await fx.call('u_reader', 'GET', `${tickets}?limit=1`)).statusCode).toBe(200);
        }
        const limited = await fx.call('u_reader', 'GET', `${tickets}?limit=1`);
        expectProblem(limited, 429, 'RATE_LIMITED');
        expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
        expect(Number(limited.headers['retry-after'])).toBeLessThanOrEqual(60);
        // Another user has their own budget.
        expect((await fx.call('u_editor', 'GET', `${tickets}?limit=1`)).statusCode).toBe(200);

        relaxRateLimits(t);
        limits.perPrincipal = { limit: 2, windowSeconds: 60 };
        expect((await fx.call('u_sales2', 'GET', `${orders}?limit=1`)).statusCode).toBe(200);
        expect((await fx.call('u_sales2', 'GET', `${orders}?limit=1`)).statusCode).toBe(200);
        expectProblem(await fx.call('u_sales2', 'GET', `${orders}?limit=1`), 429, 'RATE_LIMITED');
      } finally {
        relaxRateLimits(t);
      }
    });
  });

  describe('permission matrix (CONTRACTS §5) over HTTP', () => {
    const ids: Record<'r1' | 'r2' | 'r3', Id<'rec'>> = {} as never;

    beforeAll(async () => {
      const response = await fx.call('u_admin', 'POST', orders, {
        records: [
          {
            fields: {
              title: 'r1',
              amount: 100,
              cost: 60,
              status: 'Mới',
              owner: [{ id: fx.users.u_sales1.id }],
            },
          },
          {
            fields: {
              title: 'r2',
              amount: 200,
              cost: 120,
              status: 'Mới',
              owner: [{ id: fx.users.u_sales2.id }],
            },
          },
          { fields: { title: 'r3', amount: 300, cost: 180, status: 'Xong' } },
        ],
      });
      expect(response.statusCode).toBe(201);
      const [r1, r2, r3] = records(response);
      ids.r1 = r1?.id as Id<'rec'>;
      ids.r2 = r2?.id as Id<'rec'>;
      ids.r3 = r3?.id as Id<'rec'>;
    });

    const patch = (user: 'u_reader' | 'u_editor' | 'u_sales1', id: Id<'rec'>, fields: object) =>
      fx.call(user, 'PATCH', orders, { records: [{ id, fields }] });

    it('P01/P19: no access to the base or the table is 404', async () => {
      expectProblem(await fx.call('u_out', 'GET', orders), 404, 'NOT_FOUND');
      expectProblem(await fx.call('stranger', 'POST', `${orders}/query`, {}), 404, 'NOT_FOUND');
      expectProblem(await fx.call('u_sales1', 'POST', `${customers}/query`, {}), 404, 'NOT_FOUND');
      expectProblem(await fx.call('u_sales1', 'GET', `${customers}/${ids.r1}`), 404, 'NOT_FOUND');
    });

    it('P02: u_reader sees r1, r2, r3 with every field', async () => {
      const list = recordListResponseSchema.parse(
        (await fx.call('u_reader', 'POST', `${orders}/query`, {})).json(),
      );
      expect(list.records.map((record) => record.fields.title)).toEqual(['r1', 'r2', 'r3']);
      expect(Object.keys(list.records[0]?.fields ?? {}).sort()).toEqual(
        ['amount', 'cost', 'owner', 'status', 'title'].sort(),
      );
    });

    it('P03: u_reader PATCH r1 → 403 PERMISSION_DENIED', async () => {
      expectProblem(await patch('u_reader', ids.r1, { amount: 1 }), 403, 'PERMISSION_DENIED');
    });

    it('P04: u_editor PATCH r1.amount → 200', async () => {
      const response = await patch('u_editor', ids.r1, { amount: 110 });
      expect(response.statusCode).toBe(200);
      expect(records(response)[0]?.fields.amount).toBe(110);
    });

    it('P07: u_sales1 query → only r1, without the key `cost`', async () => {
      const response = await fx.call('u_sales1', 'POST', `${orders}/query`, {});
      const list = recordListResponseSchema.parse(response.json());
      expect(list).toMatchObject({ total: 1 });
      expect(list.records.map((record) => record.id)).toEqual([ids.r1]);
      expect(list.records[0]?.fields).not.toHaveProperty('cost');
      expect(response.body).not.toContain('"cost"');
      const one = await fx.call('u_sales1', 'GET', `${orders}/${ids.r1}`);
      expect(recordSchema.parse(one.json()).fields).not.toHaveProperty('cost');
      expectProblem(await fx.call('u_sales1', 'GET', `${orders}/${ids.r2}`), 404, 'NOT_FOUND');
    });

    it('P08: u_sales1 filtering on `cost` → 422 INVALID_FILTER', async () => {
      const response = await fx.call('u_sales1', 'POST', `${orders}/query`, {
        filter: { logic: 'and', conditions: [['cost', '>', 0]] },
      });
      expectProblem(response, 422, 'INVALID_FILTER');
    });

    it('P09: u_sales1 PATCH r1.amount → 200', async () => {
      expect((await patch('u_sales1', ids.r1, { amount: 120 })).statusCode).toBe(200);
      const single = await fx.call('u_sales1', 'PATCH', `${orders}/${ids.r1}`, {
        fields: { amount: 125 },
      });
      expect(single.statusCode).toBe(200);
      expect(recordSchema.parse(single.json()).fields).toMatchObject({ amount: 125 });
    });

    it('P10: u_sales1 PATCH r1.status → 403', async () => {
      expectProblem(await patch('u_sales1', ids.r1, { status: 'Xong' }), 403, 'FIELD_READ_ONLY');
    });

    it('P11: u_sales1 PATCH r2 → 404', async () => {
      expectProblem(await patch('u_sales1', ids.r2, { amount: 1 }), 404, 'NOT_FOUND');
      expectProblem(
        await fx.call('u_sales1', 'PATCH', `${orders}/${ids.r2}`, { fields: { amount: 1 } }),
        404,
        'NOT_FOUND',
      );
    });

    it('P12: u_sales1 PATCH r1.owner = u_sales2 → 403 RECORD_RULE_VIOLATION', async () => {
      expectProblem(
        await patch('u_sales1', ids.r1, { owner: [{ id: fx.users.u_sales2.id }] }),
        403,
        'RECORD_RULE_VIOLATION',
      );
    });

    it('P13: u_sales1 creates a record owned by u_sales1 → 201', async () => {
      const response = await fx.call('u_sales1', 'POST', orders, {
        fields: { title: 'r4', amount: 1, owner: [{ id: fx.users.u_sales1.id }] },
      });
      expect(response.statusCode).toBe(201);
      expect(recordSchema.parse(response.json()).fields).not.toHaveProperty('cost');
    });

    it('P14: u_sales1 creates a record owned by u_sales2 → 403 RECORD_RULE_VIOLATION', async () => {
      expectProblem(
        await fx.call('u_sales1', 'POST', orders, {
          records: [{ fields: { title: 'r5', owner: [{ id: fx.users.u_sales2.id }] } }],
        }),
        403,
        'RECORD_RULE_VIOLATION',
      );
    });

    it('P15: u_sales1 deletes r1 → 403', async () => {
      expectProblem(
        await fx.call('u_sales1', 'DELETE', orders, { ids: [ids.r1] }),
        403,
        'PERMISSION_DENIED',
      );
      expectProblem(
        await fx.call('u_sales1', 'DELETE', `${orders}/${ids.r1}`),
        403,
        'PERMISSION_DENIED',
      );
      expectProblem(
        await fx.call('u_sales1', 'POST', `${orders}/restore`, { ids: [ids.r1] }),
        403,
        'PERMISSION_DENIED',
      );
    });

    it('writes carry the request id as audit batch id and the acting user', async () => {
      const response = await patch('u_editor', ids.r3, { amount: 301 });
      expect(response.statusCode).toBe(200);
      const requestId = response.headers['x-request-id'] as string;
      const entries = await db.kysely
        .selectFrom('meta.audit_logs')
        .select(['actor_type', 'actor_id', 'batch_id', 'request_id', 'entity_id', 'action'])
        .where('request_id', '=', requestId)
        .execute();
      expect(entries).toEqual([
        {
          actor_type: 'user',
          actor_id: fx.users.u_editor.id,
          batch_id: requestId,
          request_id: requestId,
          entity_id: ids.r3,
          action: 'record.updated',
        },
      ]);
    });
  });
});
