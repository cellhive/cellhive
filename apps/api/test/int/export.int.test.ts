import { newId, type Id } from '@cellhive/contracts';
import { type Db, type JsonObject } from '@cellhive/server-core';
import { streamXlsxRows } from 'hucre/xlsx';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ExportLeases } from '../../src/modules/export/export-leases.js';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { buildRecordFixture, expectProblem, type RecordFixture } from './record-fixture.js';
import { problemOf, startTestApp, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';

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

/** A CSV cell as `records/query?cell_format=text` shows it (the injection guard removed). */
const unguard = (cell: string) => (/^'[=+\-@\t\r]/.test(cell) ? cell.slice(1) : cell);

function csvOf(response: LightMyRequestResponse): string[][] {
  expect(response.statusCode).toBe(200);
  expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
  const text = response.rawPayload.toString('utf8');
  expect(text.startsWith('\uFEFF')).toBe(true);
  return parseCsv(text.slice(1));
}

/**
 * T307: `GET /tables/:id/export` end to end — P18 for real, the Sales
 * variant with `download = true` (only r1, no `cost`, view outside
 * `visible_views` → 404), CSV injection, CSV/XLSX equal to
 * `records/query?cell_format=text`, view columns, one `export.created` per
 * export, one running export per user, and `EXPORT_MAX_ROWS`.
 */
describe('table export (T307)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let exportUrl: string;
  let salesRole: { id: Id<'rol'>; config: JsonObject };
  let salesView: Id<'viw'>;
  let allView: Id<'viw'>;

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    fx = await buildRecordFixture(t, db);
    exportUrl = `/tables/${fx.orders.id}/export`;
    const create = await fx.call('owner', 'POST', `/tables/${fx.orders.id}/records`, {
      records: [
        {
          fields: {
            title: '=HYPERLINK("http://evil")',
            amount: -1500,
            cost: 10,
            owner: [{ id: fx.users.u_sales1.id }],
          },
        },
        { fields: { title: 'r2', amount: 20, cost: 20, owner: [{ id: fx.users.u_sales2.id }] } },
        { fields: { title: '@r3, "quoted"\nline', amount: 30, cost: 30 } },
        { fields: { title: '+r4', amount: 40, cost: 40 } },
      ],
    });
    expect(create.statusCode).toBe(201);

    const viewOf = async (body: object) => {
      const response = await fx.call('owner', 'POST', `/tables/${fx.orders.id}/views`, body);
      expect(response.statusCode).toBe(201);
      return response.json<{ id: Id<'viw'> }>().id;
    };
    salesView = await viewOf({
      name: 'Sales view',
      type: 'grid',
      config: {
        sort: [{ field: fx.fld.amount?.id, direction: 'desc' }],
        hidden_fields: [fx.fld.status?.id],
        field_order: [fx.fld.amount?.id],
      },
    });
    allView = await viewOf({ name: 'All', type: 'grid' });
    const roles = await fx.call('owner', 'GET', `/bases/${fx.baseId}/roles`);
    const sales = roles
      .json<{ items: { id: Id<'rol'>; name: string; config: JsonObject }[] }>()
      .items.find((role) => role.name === 'Sales');
    if (sales === undefined) throw new Error('no Sales role');
    salesRole = sales;
  });

  afterAll(async () => {
    await t.close();
    await db.destroy();
    await database.drop();
  });

  async function exportAuditCount(): Promise<number> {
    const row = await db.kysely
      .selectFrom('meta.audit_logs')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('action', '=', 'export.created')
      .where('table_id', '=', fx.orders.id)
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  /** The Sales variant of BACKLOG T307: `download = true`, only `viw_sales` visible. */
  async function withSalesDownload(run: () => Promise<void>): Promise<void> {
    const config = salesRole.config as {
      base_rule: JsonObject;
      tables: Record<string, { view_rule: JsonObject }>;
    };
    const orders = config.tables[fx.orders.id];
    if (orders === undefined) throw new Error('no Orders in Sales');
    const variant = {
      ...config,
      base_rule: { ...config.base_rule, download: true },
      tables: {
        ...config.tables,
        [fx.orders.id]: {
          ...orders,
          view_rule: { ...orders.view_rule, visible_views: [salesView] },
        },
      },
    };
    const url = `/bases/${fx.baseId}/roles/${salesRole.id}`;
    expect((await fx.call('owner', 'PATCH', url, { config: variant })).statusCode).toBe(200);
    try {
      await run();
    } finally {
      expect((await fx.call('owner', 'PATCH', url, { config: salesRole.config })).statusCode).toBe(
        200,
      );
    }
  }

  it('P18: download=false → 403; readers get the file; invisible table → 404', async () => {
    expectProblem(
      await fx.call('u_sales1', 'GET', `${exportUrl}?format=csv`),
      403,
      'PERMISSION_DENIED',
    );
    expectProblem(
      await fx.call('u_sales1', 'GET', `/tables/${fx.customers.id}/export`),
      404,
      'NOT_FOUND',
    );
    for (const user of ['u_out', 'stranger'] as const) {
      expectProblem(await fx.call(user, 'GET', exportUrl), 404, 'NOT_FOUND');
    }
    const rows = csvOf(await fx.call('u_reader', 'GET', `${exportUrl}?format=csv`));
    expect(rows).toHaveLength(5);
    expect(rows[0]).toEqual(['title', 'amount', 'cost', 'status', 'owner']);
  });

  it('P18 variant: Sales with download=true → only r1 without cost; viw_all → 404', async () => {
    await withSalesDownload(async () => {
      const response = await fx.call('u_sales1', 'GET', `${exportUrl}?view_id=${salesView}`);
      const rows = csvOf(response);
      expect(rows[0]).toEqual(['amount', 'title', 'owner']);
      expect(rows.slice(1).map((row) => unguard(row[1] ?? ''))).toEqual([
        '=HYPERLINK("http://evil")',
      ]);
      expectProblem(
        await fx.call('u_sales1', 'GET', `${exportUrl}?view_id=${allView}`),
        404,
        'NOT_FOUND',
      );
      // Personal to nobody, malformed, of another table: all the same 404.
      for (const viewId of ['viw_nope', newId('viw')]) {
        expectProblem(
          await fx.call('u_sales1', 'GET', `${exportUrl}?view_id=${viewId}`),
          404,
          'NOT_FOUND',
        );
      }
    });
  });

  it('neutralises formula-like cells and otherwise equals records/query cell_format=text', async () => {
    const response = await fx.call('u_editor', 'GET', `${exportUrl}?view_id=${salesView}`);
    expect(response.headers['content-disposition']).toBe(
      `attachment; filename="Orders - Sales view.csv"; filename*=UTF-8''Orders%20-%20Sales%20view.csv`,
    );
    expect(response.headers['cache-control']).toBe('private, no-store');
    const [header, ...rows] = csvOf(response);
    expect(header).toEqual(['amount', 'title', 'cost', 'owner']);
    const text = response.rawPayload.toString('utf8');
    expect(text).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(text).toContain(`"'@r3, ""quoted""\nline"`);
    expect(text).toContain("'+r4");
    for (const row of rows) {
      for (const cell of row) {
        // A plain number is not a formula (T321): `-1` is written as it is.
        if (!/^-?\d+(?:[.,]\d+)*$/u.test(cell)) expect(cell).not.toMatch(/^[=+\-@]/);
      }
    }

    const listed = await fx.call(
      'u_editor',
      'POST',
      `/tables/${fx.orders.id}/records/query?cell_format=text`,
      { view_id: salesView },
    );
    const expected = listed
      .json<{ records: { fields: Record<string, string> }[] }>()
      .records.map((record) => (header ?? []).map((name) => record.fields[name] ?? ''));
    expect(rows.map((row) => row.map(unguard))).toEqual(expected);
  });

  it('XLSX: same cells as records/query, formula-like text kept as inert strings', async () => {
    const response = await fx.call('u_reader', 'GET', `${exportUrl}?format=xlsx`);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    const cells: (string | null)[][] = [];
    for await (const row of streamXlsxRows(new Uint8Array(response.rawPayload))) {
      cells.push(Array.from({ length: 5 }, (_, i) => (row.values[i] as string | null) ?? null));
    }
    const listed = await fx.call(
      'u_reader',
      'POST',
      `/tables/${fx.orders.id}/records/query?cell_format=text`,
      {},
    );
    const header = ['title', 'amount', 'cost', 'status', 'owner'];
    expect(cells[0]).toEqual(header);
    expect(cells.slice(1)).toEqual(
      listed
        .json<{ records: { fields: Record<string, string> }[] }>()
        .records.map((record) => header.map((name) => record.fields[name] || null)),
    );
    expect(cells[1]?.[0]).toBe('=HYPERLINK("http://evil")');
  });

  it('writes exactly one export.created per export, without values', async () => {
    const before = await exportAuditCount();
    expect((await fx.call('u_reader', 'GET', `${exportUrl}?view_id=${salesView}`)).statusCode).toBe(
      200,
    );
    expectProblem(await fx.call('u_sales1', 'GET', exportUrl), 403, 'PERMISSION_DENIED');
    expect(await exportAuditCount()).toBe(before + 1);
    const entry = await db.kysely
      .selectFrom('meta.audit_logs')
      .selectAll()
      .where('action', '=', 'export.created')
      .where('table_id', '=', fx.orders.id)
      .orderBy('created_at', 'desc')
      .executeTakeFirstOrThrow();
    expect(entry).toMatchObject({
      actor_type: 'user',
      actor_id: fx.users.u_reader.id,
      entity_type: 'table',
      entity_id: fx.orders.id,
      base_id: fx.baseId,
      after: { view_id: salesView, format: 'csv', row_count: 4 },
    });
  });

  it('one running export per user: 429 with Retry-After, others unaffected', async () => {
    const lease = await t.app.get(ExportLeases).acquire(fx.users.u_reader.id);
    try {
      const busy = await fx.call('u_reader', 'GET', exportUrl);
      expectProblem(busy, 429, 'RATE_LIMITED');
      expect(Number(busy.headers['retry-after'])).toBeGreaterThan(0);
      expect((await fx.call('u_editor', 'GET', exportUrl)).statusCode).toBe(200);
    } finally {
      await lease.release();
    }
    expect((await fx.call('u_reader', 'GET', exportUrl)).statusCode).toBe(200);
    // The slot is freed after each export.
    expect((await fx.call('u_reader', 'GET', exportUrl)).statusCode).toBe(200);
  });

  it('rejects a bad format with 422', async () => {
    const response = await fx.call('u_reader', 'GET', `${exportUrl}?format=pdf`);
    expectProblem(response, 422, 'VALIDATION_FAILED');
  });

  it('EXPORT_MAX_ROWS: more matching rows → 422 EXPORT_TOO_LARGE before streaming', async () => {
    const small = await startTestApp({ DATABASE_URL: database.url, EXPORT_MAX_ROWS: '3' });
    try {
      const other = await buildRecordFixture(small, db);
      await other.call('owner', 'POST', `/tables/${other.orders.id}/records`, {
        records: [1, 2, 3, 4].map((n) => ({ fields: { title: `n${String(n)}` } })),
      });
      const response = await other.call('u_reader', 'GET', `/tables/${other.orders.id}/export`);
      expectProblem(response, 422, 'VALIDATION_FAILED');
      expect(problemOf(response.body)['errors']).toEqual([
        expect.objectContaining({ code: 'EXPORT_TOO_LARGE', params: { limit: 3 } }),
      ]);
    } finally {
      await small.close();
    }
  });
});
