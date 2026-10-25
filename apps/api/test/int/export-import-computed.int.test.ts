import {
  fieldSchema,
  importJobResultSchema,
  importUploadSchema,
  jobSchema,
  recordListResponseSchema,
  recordsResponseSchema,
  viewSchema,
  type FieldDto,
  type Id,
  type ImportJobResult,
  type JobDto,
  type RecordDto,
} from '@cellhive/contracts';
import {
  BaseRolesRepository,
  orgScope,
  RecordMutationService,
  SchemaService,
  type Db,
} from '@cellhive/server-core';
import { createWorker, type WorkerHandle } from '@cellhive/worker';
import { streamXlsxRows } from 'hucre/xlsx';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import {
  buildRecordFixture,
  expectProblem,
  type FixtureUser,
  type RecordFixture,
} from './record-fixture.js';
import { captureLogger, problemOf, startTestApp, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';

const BOUNDARY = 'cellhive-t462-boundary';

function multipart(filename: string, bytes: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: text/csv\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);
}

/** RFC 4180 parser for the tests (quoted cells, `""`, CRLF). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] as string;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i += 1;
    } else cell += char;
  }
  if (cell !== '' || row.length > 0) rows.push([...row, cell]);
  return rows;
}

function csvOf(response: LightMyRequestResponse): string[][] {
  expect(response.statusCode, response.body).toBe(200);
  const text = response.rawPayload.toString('utf8');
  expect(text.startsWith('﻿')).toBe(true);
  return parseCsv(text.slice(1));
}

async function eventually<T>(probe: () => Promise<T | undefined>, label: string): Promise<T> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * T462: formula/lookup columns in exports (CONTRACTS §18: `cell_format=text`
 * under the exporter's access and the field's `style`; `locked` or in
 * error → empty) and imports (§19: never mapped, `FIELD_READ_ONLY` with a
 * computed note; an append import recomputes the lookups it feeds).
 */
describe('export/import with formula and lookup fields (T462)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let worker: WorkerHandle | undefined;
  let customer: FieldDto;
  let phone: FieldDto;
  let amountVnd: FieldDto;
  let customerPhone: FieldDto;
  let broken: FieldDto;
  let ordersTotal: FieldDto;
  const c = {} as Record<'c1' | 'c2', Id<'rec'>>;

  function records(response: LightMyRequestResponse): RecordDto[] {
    expect(response.statusCode, response.body).toBeLessThan(300);
    return recordsResponseSchema.parse(response.json()).records;
  }

  async function field(body: object, table = fx.orders.id): Promise<FieldDto> {
    const response = await fx.call('u_admin', 'POST', `/tables/${table}/fields`, body);
    expect(response.statusCode, response.body).toBe(201);
    return fieldSchema.parse(response.json());
  }

  async function backfill(fieldId: Id<'fld'>): Promise<void> {
    const scope = orgScope(fx.orgId);
    let cursor = 0n;
    for (;;) {
      const result = await t.app.get(RecordMutationService).backfillComputedBatch(scope, {
        fieldId,
        afterAuto: cursor,
        limit: 1000,
        statementTimeoutMs: 30_000,
      });
      if (result.status !== 'more') break;
      cursor = result.cursor;
    }
    await t.app.get(SchemaService).finishComputedBackfill(scope, fieldId, { status: 'ready' });
  }

  async function upload(user: FixtureUser, lines: readonly string[]): Promise<string> {
    const response = await fx.call(
      user,
      'POST',
      `/bases/${fx.baseId}/imports/uploads`,
      multipart('orders.csv', Buffer.from(`${lines.join('\r\n')}\r\n`)),
      { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    );
    expect(response.statusCode, response.body).toBe(201);
    return importUploadSchema.parse(response.json()).id;
  }

  async function finished(user: FixtureUser, jobId: string): Promise<ImportJobResult> {
    worker ??= await createWorker(t.config, {
      logger: captureLogger().logger,
      pollIntervalMs: 100,
    });
    const job = await eventually(async () => {
      const dto: JobDto = jobSchema.parse((await fx.call(user, 'GET', `/jobs/${jobId}`)).json());
      return ['succeeded', 'failed', 'cancelled'].includes(dto.status) ? dto : undefined;
    }, `job ${jobId}`);
    expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
    return importJobResultSchema.parse(job.result);
  }

  /** Text cells of a `records/query` of `user` (`cell_format=text`), by title. */
  async function textCells(user: FixtureUser): Promise<Map<string, Record<string, unknown>>> {
    const response = await fx.call(
      user,
      'POST',
      `/tables/${fx.orders.id}/records/query?cell_format=text`,
      { limit: 100 },
    );
    expect(response.statusCode, response.body).toBe(200);
    return new Map(
      recordListResponseSchema
        .parse(response.json())
        .records.map((record) => [String(record.fields['title']), record.fields]),
    );
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    fx = await buildRecordFixture(t, db);

    // The P18 variant: Sales may download (export).
    const scope = orgScope(fx.orgId);
    const roles = new BaseRolesRepository(db);
    const salesRole = (await roles.listByBase(scope, fx.baseId)).find(
      (role) => role.name === 'Sales',
    );
    const config = structuredClone(salesRole?.config) as { base_rule: Record<string, boolean> };
    config.base_rule['download'] = true;
    await roles.update(scope, fx.baseId, salesRole?.id ?? 'rol_missing', { config });

    phone = await field({ name: 'phone', type: 'text' }, fx.customers.id);
    customer = await field({
      name: 'customer',
      type: 'link',
      options: { link_table: fx.customers.id },
    });
    [c.c1, c.c2] = records(
      await fx.call('u_admin', 'POST', `/tables/${fx.customers.id}/records`, {
        records: [
          { fields: { Tên: 'An Phát', phone: '0901' } },
          { fields: { Tên: 'Bình Minh', phone: '=0907' } },
        ],
      }),
    ).map((record) => record.id) as [Id<'rec'>, Id<'rec'>];
    records(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/records`, {
        records: [
          {
            fields: {
              title: 'o1',
              amount: 1500,
              owner: [{ id: fx.users.u_sales1.id }],
              customer: [c.c1],
            },
          },
          {
            fields: {
              title: 'o2',
              amount: 20,
              owner: [{ id: fx.users.u_sales1.id }],
              customer: [c.c2],
            },
          },
        ],
      }),
    );
    amountVnd = await field({
      name: 'amount_vnd',
      type: 'formula',
      options: {
        expression: '[amount] * 1000',
        style: { type: 'currency', currency_code: 'VND', precision: 0 },
      },
    });
    customerPhone = await field({
      name: 'customer_phone',
      type: 'lookup',
      options: {
        from: fx.customers.id,
        select: phone.id,
        where: { field: '__id', operator: 'is_any_of', value: { field_ref: customer.id } },
      },
    });
    const scratch = await field({ name: 'scratch', type: 'number' });
    broken = await field({
      name: 'broken',
      type: 'formula',
      options: { expression: '[scratch] + 1' },
    });
    ordersTotal = await field(
      {
        name: 'orders_total',
        type: 'lookup',
        options: {
          from: fx.orders.id,
          select: fx.fld.amount?.id,
          where: { field: customer.id, operator: 'intersects', value: { field_ref: '__id' } },
          aggregate: 'sum',
        },
      },
      fx.customers.id,
    );
    for (const item of [amountVnd, customerPhone, broken, ordersTotal]) await backfill(item.id);
    const deleted = await fx.call('u_admin', 'DELETE', `/fields/${scratch.id}`);
    expect(deleted.statusCode, deleted.body).toBeLessThan(300);
  });

  afterAll(async () => {
    await worker?.close();
    await t.close();
    await db.destroy();
    await database.drop();
  });

  describe('export', () => {
    it('writes computed values as text, with their style, like records/query', async () => {
      const [header, ...rows] = csvOf(
        await fx.call('u_admin', 'GET', `/tables/${fx.orders.id}/export`),
      );
      expect(header).toEqual(
        expect.arrayContaining(['amount_vnd', 'customer_phone', 'broken', 'customer']),
      );
      const column = (name: string) => header?.indexOf(name) ?? -1;
      const byTitle = new Map(rows.map((row) => [row[0], row]));
      const text = await textCells('u_admin');
      const o1 = byTitle.get('o1');
      // Currency style of the formula (VND), the same text as the grid.
      expect(o1?.[column('amount_vnd')]).toBe(text.get('o1')?.['amount_vnd']);
      expect(o1?.[column('amount_vnd')]).toMatch(/1[.,\s]?500[.,\s]?000/);
      expect(o1?.[column('customer_phone')]).toBe('0901');
      // CSV injection: a lookup value starting with `=` gets the `'` like any cell.
      expect(byTitle.get('o2')?.[column('customer_phone')]).toBe("'=0907");
      // A field in error (T460) exports empty.
      expect(o1?.[column('broken')]).toBe('');

      const xlsx = await fx.call('u_admin', 'GET', `/tables/${fx.orders.id}/export?format=xlsx`);
      expect(xlsx.statusCode).toBe(200);
      const cells: unknown[][] = [];
      for await (const row of streamXlsxRows(new Uint8Array(xlsx.rawPayload))) {
        cells.push([...row.values]);
      }
      const xlsxO2 = cells.find((row) => row[0] === 'o2');
      expect(xlsxO2?.[column('customer_phone')]).toBe('=0907');
      expect(cells.find((row) => row[0] === 'o1')?.[column('amount_vnd')]).toBe(
        text.get('o1')?.['amount_vnd'],
      );
    });

    it("follows the exporter's access: a locked lookup is an empty column (u_sales1, download)", async () => {
      const [header, ...rows] = csvOf(
        await fx.call('u_sales1', 'GET', `/tables/${fx.orders.id}/export`),
      );
      expect(header).not.toContain('cost');
      const column = header?.indexOf('customer_phone') ?? -1;
      expect(column).toBeGreaterThan(0);
      expect(rows.length).toBe(2);
      for (const row of rows) expect(row[column]).toBe('');
      const text = JSON.stringify(rows);
      expect(text).not.toContain('0901');
      expect(text).not.toContain('0907');
      // The formula over its own row is theirs.
      const amount = header?.indexOf('amount_vnd') ?? -1;
      expect(rows.find((row) => row[0] === 'o1')?.[amount]).toMatch(/1[.,\s]?500[.,\s]?000/);
    });

    it('through a view: sorted by a formula, hidden computed fields left out', async () => {
      const created = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/views`, {
        name: 'By amount',
        type: 'grid',
        config: {
          sort: [{ field: amountVnd.id, direction: 'desc' }],
          hidden_fields: [customerPhone.id],
        },
      });
      expect(created.statusCode, created.body).toBe(201);
      const view = viewSchema.parse(created.json());
      const [header, ...rows] = csvOf(
        await fx.call('u_admin', 'GET', `/tables/${fx.orders.id}/export?view_id=${view.id}`),
      );
      expect(header).not.toContain('customer_phone');
      expect(rows.map((row) => row[0])).toEqual(['o1', 'o2']);
    });
  });

  describe('import', () => {
    it('never maps a computed field: FIELD_READ_ONLY with a computed note', async () => {
      const uploadId = await upload('u_admin', ['title,amount_vnd', 'x,1']);
      const response = await fx.call('u_admin', 'POST', `/bases/${fx.baseId}/imports`, {
        upload_id: uploadId,
        mode: 'append',
        table_id: fx.orders.id,
        mapping: [
          { column: 0, field_id: fx.fld.title?.id },
          { column: 1, field_id: amountVnd.id },
        ],
      });
      expectProblem(response, 403, 'FIELD_READ_ONLY');
      expect(problemOf(response.body).errors).toEqual([
        {
          path: 'mapping[1].field_id',
          code: 'FIELD_READ_ONLY',
          message: 'Formula and lookup fields are computed and cannot be imported',
          params: { type: 'formula' },
        },
      ]);
      // A lookup of another table too.
      const lookup = await fx.call('u_admin', 'POST', `/bases/${fx.baseId}/imports`, {
        upload_id: await upload('u_admin', ['title,phone', 'x,1']),
        mode: 'append',
        table_id: fx.orders.id,
        mapping: [{ column: 1, field_id: customerPhone.id }],
      });
      expectProblem(lookup, 403, 'FIELD_READ_ONLY');
      expect(problemOf(lookup.body).errors).toMatchObject([
        { path: 'mapping[0].field_id', params: { type: 'lookup' } },
      ]);
    });

    it('10 000 rows appended to Orders: the lookup sum of Customers is right after the job', async () => {
      const rows = 10_000;
      const lines = ['title,amount,customer'];
      let expected1 = 1500;
      let expected2 = 20;
      for (let index = 0; index < rows; index += 1) {
        const amount = (index % 7) + 1;
        const first = index % 2 === 0;
        if (first) expected1 += amount;
        else expected2 += amount;
        lines.push(`i${String(index)},${String(amount)},${first ? 'An Phát' : 'Bình Minh'}`);
      }
      const uploadId = await upload('u_admin', lines);
      const response = await fx.call('u_admin', 'POST', `/bases/${fx.baseId}/imports`, {
        upload_id: uploadId,
        mode: 'append',
        table_id: fx.orders.id,
        mapping: [
          { column: 0, field_id: fx.fld.title?.id },
          { column: 1, field_id: fx.fld.amount?.id },
          { column: 2, field_id: customer.id },
        ],
      });
      expect(response.statusCode, response.body).toBe(202);
      const result = await finished('u_admin', response.json<{ job_id: string }>().job_id);
      expect(result).toMatchObject({ rows, imported: rows, failed: 0 });

      const totals = async () => {
        const listed = await fx.call(
          'u_admin',
          'POST',
          `/tables/${fx.customers.id}/records/query?field_key_type=id`,
          {},
        );
        expect(listed.statusCode, listed.body).toBe(200);
        return new Map(
          recordListResponseSchema
            .parse(listed.json())
            .records.map((record) => [record.id, record.fields[ordersTotal.id]]),
        );
      };
      // Recomputed in each batch (or by the recompute job): converge.
      const settled = await eventually(async () => {
        const now = await totals();
        return now.get(c.c1) === expected1 && now.get(c.c2) === expected2 ? now : undefined;
      }, 'lookup totals');
      expect(settled.get(c.c1)).toBe(expected1);

      // T474: the formula of the rows just imported is computed as well — the
      // recompute job running beside the import waits for its locks instead
      // of marking the field TIMEOUT.
      const formula = await eventually(async () => {
        const response = await fx.call('u_admin', 'GET', `/fields/${amountVnd.id}`);
        expect(response.statusCode, response.body).toBe(200);
        const dto = fieldSchema.parse(response.json());
        return dto.compute_state === 'recomputing' || dto.compute_state === 'backfilling'
          ? undefined
          : dto;
      }, 'amount_vnd recomputed');
      expect(formula).toMatchObject({ compute_state: 'ready', compute_error: null });
      const empty = await fx.call(
        'u_admin',
        'POST',
        `/tables/${fx.orders.id}/records/query?field_key_type=id`,
        { filter: { field: amountVnd.id, operator: 'is_empty' }, limit: 5 },
      );
      expect(empty.statusCode, empty.body).toBe(200);
      expect(recordListResponseSchema.parse(empty.json()).records).toEqual([]);
      const last = await fx.call(
        'u_admin',
        'POST',
        `/tables/${fx.orders.id}/records/query?field_key_type=id`,
        { filter: { field: fx.fld.title?.id, operator: 'eq', value: 'i9999' } },
      );
      // amount = 9999 % 7 + 1 = 4.
      expect(last.statusCode, last.body).toBe(200);
      expect(
        recordListResponseSchema
          .parse(last.json())
          .records.map((record) => record.fields[amountVnd.id]),
      ).toEqual([4000]);
    }, 180_000);
  });
});
