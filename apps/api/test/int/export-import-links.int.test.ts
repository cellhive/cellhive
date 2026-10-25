import {
  attachmentSchema,
  createUploadResponseSchema,
  fieldSchema,
  importJobResultSchema,
  importUploadSchema,
  jobSchema,
  recordsResponseSchema,
  type FieldDto,
  type Id,
  type ImportJobResult,
  type JobDto,
  type RecordDto,
} from '@cellhive/contracts';
import {
  importReportKey,
  orgScope,
  SchemaService,
  systemAuditContext,
  type Db,
  type FieldRow,
  type JsonObject,
  type StorageDriver,
} from '@cellhive/server-core';
import { createWorker, type WorkerHandle } from '@cellhive/worker';
import { streamXlsxRows } from 'hucre/xlsx';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { STORAGE_DRIVER } from '../../src/common/tokens.js';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import {
  buildRecordFixture,
  expectProblem,
  type FixtureUser,
  type RecordFixture,
} from './record-fixture.js';
import { captureLogger, startTestApp, TEST_PUBLIC_URL, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';

const BOUNDARY = 'cellhive-t411-boundary';

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

/** A CSV cell as RFC 4180 writes it. */
const csvCell = (value: string) =>
  /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;

function csvOf(response: LightMyRequestResponse): string[][] {
  expect(response.statusCode, response.body).toBe(200);
  const text = response.rawPayload.toString('utf8');
  expect(text.startsWith('\uFEFF')).toBe(true);
  return parseCsv(text.slice(1));
}

async function eventually<T>(probe: () => Promise<T | undefined>, label: string): Promise<T> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * T411: export of link (titles the exporter reads, P20), attachment (file
 * names) and parent (title) cells; append imports into link and parent
 * fields by title (title lists, `LINK_TARGET_AMBIGUOUS`,
 * `LINK_TARGET_NOT_FOUND`, `TOO_MANY_VALUES`), attachment fields refused
 * (`INVALID_FIELD_TYPE`), and an export → import round trip of links.
 */
describe('export/import of link, attachment and parent cells (T411)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let worker: WorkerHandle | undefined;
  let customer: FieldDto;
  let parent: FieldDto;
  let files: FieldRow;
  const customers: Record<string, Id<'rec'>> = {};
  const orders: Record<string, Id<'rec'>> = {};

  function records(response: LightMyRequestResponse): RecordDto[] {
    expect(response.statusCode, response.body).toBeLessThan(300);
    return recordsResponseSchema.parse(response.json()).records;
  }

  /** Records of a `records/query` page. */
  function queried(response: LightMyRequestResponse): RecordDto[] {
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ records: RecordDto[] }>().records;
  }

  async function uploadFile(name: string, bytes: Buffer): Promise<string> {
    const started = await fx.call('u_editor', 'POST', '/files/uploads', {
      table_id: files.table_id,
      field_id: files.id,
      filename: name,
      size: bytes.length,
      mime: 'application/pdf',
    });
    expect(started.statusCode, started.body).toBe(201);
    const { id, upload } = createUploadResponseSchema.parse(started.json());
    const url = new URL(upload.url);
    expect(url.origin).toBe(TEST_PUBLIC_URL);
    const put = await t.app.inject({
      method: 'PUT',
      url: url.pathname + url.search,
      headers: upload.headers,
      payload: bytes,
    });
    expect(put.statusCode).toBe(200);
    const done = await fx.call('u_editor', 'POST', `/files/uploads/${id}/complete`);
    expect(done.statusCode, done.body).toBe(200);
    return attachmentSchema.parse(done.json()).id;
  }

  async function importCsv(
    user: FixtureUser,
    tableId: Id<'tbl'>,
    lines: readonly string[],
    mapping: readonly { column: number; field_id: string }[],
  ): Promise<LightMyRequestResponse> {
    const upload = await fx.call(
      user,
      'POST',
      `/bases/${fx.baseId}/imports/uploads`,
      multipart('links.csv', Buffer.from(`${lines.join('\r\n')}\r\n`)),
      { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    );
    expect(upload.statusCode, upload.body).toBe(201);
    const { id } = importUploadSchema.parse(upload.json());
    return fx.call(user, 'POST', `/bases/${fx.baseId}/imports`, {
      upload_id: id,
      mode: 'append',
      table_id: tableId,
      mapping,
    });
  }

  async function imported(
    user: FixtureUser,
    tableId: Id<'tbl'>,
    lines: readonly string[],
    mapping: readonly { column: number; field_id: string }[],
  ): Promise<{ jobId: Id<'job'>; result: ImportJobResult }> {
    const response = await importCsv(user, tableId, lines, mapping);
    expect(response.statusCode, response.body).toBe(202);
    const jobId = response.json<{ job_id: Id<'job'> }>().job_id;
    worker ??= await createWorker(t.config, {
      logger: captureLogger().logger,
      pollIntervalMs: 100,
    });
    const job = await eventually(async () => {
      const dto: JobDto = jobSchema.parse((await fx.call(user, 'GET', `/jobs/${jobId}`)).json());
      return ['succeeded', 'failed', 'cancelled'].includes(dto.status) ? dto : undefined;
    }, `job ${jobId}`);
    expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
    return { jobId, result: importJobResultSchema.parse(job.result) };
  }

  /** `{ title → linked titles }` of the Orders records created by an import job. */
  async function linksOf(ids: readonly Id<'rec'>[]): Promise<Map<Id<'rec'>, string[]>> {
    const listed = queried(
      await fx.call('owner', 'POST', `/tables/${fx.orders.id}/records/query?field_key_type=id`, {
        limit: 1000,
      }),
    );
    const wanted = new Set(ids);
    return new Map(
      listed
        .filter((record) => wanted.has(record.id))
        .map((record) => [
          record.id,
          ((record.fields[customer.id] as { title: string | null }[] | null) ?? []).map(
            (ref) => ref.title ?? '?',
          ),
        ]),
    );
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    fx = await buildRecordFixture(t, db);
    const created = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
      name: 'customer',
      type: 'link',
      options: { link_table: fx.customers.id },
    });
    expect(created.statusCode, created.body).toBe(201);
    customer = fieldSchema.parse(created.json());
    const tree = await fx.call('u_admin', 'POST', `/tables/${fx.tickets.id}/fields`, {
      name: 'parent',
      type: 'parent',
    });
    expect(tree.statusCode, tree.body).toBe(201);
    parent = fieldSchema.parse(tree.json());
    files = await t.app
      .get(SchemaService)
      .addField(
        orgScope(fx.orgId),
        fx.orders.id,
        { name: 'files', type: 'attachment', options: {} },
        systemAuditContext(),
      );

    for (const record of records(
      await fx.call('u_admin', 'POST', `/tables/${fx.customers.id}/records`, {
        records: ['An Phát', 'Bình Minh', 'Nguyễn, An', 'Trùng', 'Trùng', '=cmd'].map((name) => ({
          fields: { Tên: name },
        })),
      }),
    )) {
      customers[record.fields['Tên'] as string] ??= record.id;
    }
    const attachment = await uploadFile('báo giá.pdf', Buffer.from('%PDF-1.7\n%%EOF\n'));
    for (const record of records(
      await fx.call('u_editor', 'POST', `/tables/${fx.orders.id}/records?field_key_type=id`, {
        records: [
          {
            fields: {
              [fx.fld.title?.id as string]: 'o1',
              [fx.fld.owner?.id as string]: [{ id: fx.users.u_sales1.id }],
              [customer.id]: [customers['An Phát'], customers['Nguyễn, An']],
              [files.id]: [{ id: attachment }],
            },
          },
          {
            fields: {
              [fx.fld.title?.id as string]: 'o2',
              [customer.id]: [customers['Bình Minh'], customers['=cmd']],
            },
          },
        ],
      }),
    )) {
      orders[record.fields[fx.fld.title?.id as string] as string] = record.id;
    }
  });

  afterAll(async () => {
    await worker?.close();
    await t.close();
    await db.destroy();
    await database.drop();
  });

  describe('export', () => {
    it('writes link titles (quoted lists), file names and parent titles', async () => {
      const [header, ...rows] = csvOf(
        await fx.call('u_editor', 'GET', `/tables/${fx.orders.id}/export`),
      );
      expect(header).toEqual(['title', 'amount', 'cost', 'status', 'owner', 'customer', 'files']);
      const byTitle = new Map(rows.map((row) => [row[0], row]));
      expect(byTitle.get('o1')?.slice(5)).toEqual(['An Phát, "Nguyễn, An"', 'báo giá.pdf']);
      // CSV injection: the cell starts with `=` only inside the list, not at its start.
      expect(byTitle.get('o2')?.slice(5)).toEqual(['Bình Minh, =cmd', '']);

      const xlsx = await fx.call('u_editor', 'GET', `/tables/${fx.orders.id}/export?format=xlsx`);
      expect(xlsx.statusCode).toBe(200);
      const cells: unknown[][] = [];
      for await (const row of streamXlsxRows(new Uint8Array(xlsx.rawPayload))) {
        cells.push([...row.values]);
      }
      expect(cells.find((row) => row[0] === 'o1')?.slice(5, 7)).toEqual([
        'An Phát, "Nguyễn, An"',
        'báo giá.pdf',
      ]);

      // Parent field of a sub-record table: the parent's title.
      const [root] = records(
        await fx.call('u_admin', 'POST', `/tables/${fx.tickets.id}/records`, {
          records: [{ fields: { 'Tiêu đề': 'Gốc' } }],
        }),
      );
      await fx.call('u_admin', 'POST', `/tables/${fx.tickets.id}/records`, {
        records: [{ fields: { 'Tiêu đề': 'Con' }, parent_id: root?.id }],
      });
      const [ticketHeader, ...tickets] = csvOf(
        await fx.call('u_editor', 'GET', `/tables/${fx.tickets.id}/export`),
      );
      const column = ticketHeader?.indexOf('parent') ?? -1;
      expect(column).toBeGreaterThan(0);
      expect(tickets.find((row) => row[0] === 'Con')?.[column]).toBe('Gốc');
      expect(tickets.find((row) => row[0] === 'Gốc')?.[column]).toBe('');
    });

    it('P20: an exporter who cannot read Customers gets no titles', async () => {
      const roles = await fx.call('owner', 'GET', `/bases/${fx.baseId}/roles`);
      const sales = roles
        .json<{ items: { id: Id<'rol'>; name: string; config: JsonObject }[] }>()
        .items.find((role) => role.name === 'Sales');
      if (sales === undefined) throw new Error('no Sales role');
      const config = sales.config as { base_rule: JsonObject };
      const url = `/bases/${fx.baseId}/roles/${sales.id}`;
      const variant = { ...config, base_rule: { ...config.base_rule, download: true } };
      expect((await fx.call('owner', 'PATCH', url, { config: variant })).statusCode).toBe(200);
      try {
        const [header, ...rows] = csvOf(
          await fx.call('u_sales1', 'GET', `/tables/${fx.orders.id}/export`),
        );
        const column = header?.indexOf('customer') ?? -1;
        expect(column).toBeGreaterThan(0);
        // Only o1 is readable (owner = u_sales1); its links are there, their titles are not.
        expect(rows.map((row) => [row[0], row[column]])).toEqual([['o1', '']]);
        const text = rows.flat().join('\n');
        for (const name of ['An Phát', 'Nguyễn', 'Bình Minh']) expect(text).not.toContain(name);
      } finally {
        expect((await fx.call('owner', 'PATCH', url, { config: sales.config })).statusCode).toBe(
          200,
        );
      }
    });
  });

  describe('import', () => {
    it('refuses attachment fields (422 INVALID_FIELD_TYPE) before queuing', async () => {
      const response = await importCsv(
        'u_editor',
        fx.orders.id,
        ['title,files', 'x,báo giá.pdf'],
        [
          { column: 0, field_id: fx.fld.title?.id as string },
          { column: 1, field_id: files.id },
        ],
      );
      expectProblem(response, 422, 'VALIDATION_FAILED');
      expect(response.json<{ errors: unknown[] }>().errors).toEqual([
        expect.objectContaining({
          path: 'mapping[1].field_id',
          code: 'INVALID_FIELD_TYPE',
          params: { type: 'attachment' },
        }),
      ]);
    });

    it('links 1 000 rows by title; ambiguous and unknown titles are row errors', async () => {
      const cells = [
        'An Phát',
        'An Phát, Bình Minh',
        '"Nguyễn, An", Bình Minh',
        'Nguyễn, An', // the whole cell is one title
        'Trùng', // two customers: ambiguous
        'Ai đó', // no such customer
        "'=cmd", // the export's CSV injection guard is removed
      ];
      const lines = ['title,customer'];
      for (let i = 0; i < 1000; i += 1) {
        lines.push(`imp${String(i)},${csvCell(cells[i % cells.length] as string)}`);
      }
      const { jobId, result } = await imported('u_editor', fx.orders.id, lines, [
        { column: 0, field_id: fx.fld.title?.id as string },
        { column: 1, field_id: customer.id },
      ]);
      const bad = Array.from({ length: 1000 }, (_, i) => i % cells.length).filter(
        (k) => k === 4 || k === 5,
      ).length;
      expect(result).toMatchObject({ rows: 1000, imported: 1000 - bad, failed: bad });
      expect(result.errors.slice(0, 2)).toEqual([
        {
          row: 6,
          data_row: 5,
          column: 1,
          column_name: 'customer',
          field_id: customer.id,
          code: 'LINK_TARGET_AMBIGUOUS',
        },
        {
          row: 7,
          data_row: 6,
          column: 1,
          column_name: 'customer',
          field_id: customer.id,
          code: 'LINK_TARGET_NOT_FOUND',
        },
      ]);
      // The report lists every row error with its code and value.
      const stream = await t.app
        .get<StorageDriver>(STORAGE_DRIVER)
        .getStream(importReportKey(fx.orgId, jobId));
      const chunks: Buffer[] = [];
      for await (const chunk of stream ?? []) chunks.push(chunk as Buffer);
      const report = parseCsv(Buffer.concat(chunks).toString('utf8').slice(1));
      expect(report[0]).toEqual([
        'row',
        'column',
        'column_name',
        'field_id',
        'code',
        'data_row',
        'value',
      ]);
      expect(report).toHaveLength(bad + 1);
      expect(report[1]?.slice(4)).toEqual(['LINK_TARGET_AMBIGUOUS', '5', 'Trùng']);
      expect(report[2]?.slice(4)).toEqual(['LINK_TARGET_NOT_FOUND', '6', 'Ai đó']);

      const all = queried(
        await fx.call('owner', 'POST', `/tables/${fx.orders.id}/records/query`, { limit: 1000 }),
      );
      const titlesOf = (title: string) =>
        (
          (all.find((record) => record.fields['title'] === title)?.fields['customer'] as
            { title: string }[] | null) ?? []
        ).map((ref) => ref.title);
      expect(titlesOf('imp0')).toEqual(['An Phát']);
      expect(titlesOf('imp1')).toEqual(['An Phát', 'Bình Minh']);
      expect(titlesOf('imp2')).toEqual(['Nguyễn, An', 'Bình Minh']);
      expect(titlesOf('imp3')).toEqual(['Nguyễn, An']);
      expect(titlesOf('imp6')).toEqual(['=cmd']);
      expect(all.some((record) => record.fields['title'] === 'imp4')).toBe(false);
    });

    it('P20: titles of records the importer cannot read are not found', async () => {
      // u_sales1 writes Orders (owner = self) but does not read Customers.
      const { result } = await imported(
        'u_sales1',
        fx.orders.id,
        ['title,owner,customer', `s1,${fx.users.u_sales1.email},An Phát`],
        [
          { column: 0, field_id: fx.fld.title?.id as string },
          { column: 1, field_id: fx.fld.owner?.id as string },
          { column: 2, field_id: customer.id },
        ],
      );
      expect(result).toMatchObject({ imported: 0, failed: 1 });
      expect(result.errors.map((error) => error.code)).toEqual(['LINK_TARGET_NOT_FOUND']);
    });

    it('reports every error of a row, not only the first check that failed (T421b)', async () => {
      const { result } = await imported(
        'u_editor',
        fx.orders.id,
        ['title,amount,customer', 'multi,không phải số,Ai đó', 'ok,5,An Phát'],
        [
          { column: 0, field_id: fx.fld.title?.id as string },
          { column: 1, field_id: fx.fld.amount?.id as string },
          { column: 2, field_id: customer.id },
        ],
      );
      expect(result).toMatchObject({ imported: 1, failed: 1 });
      expect(result.errors.map((error) => [error.data_row, error.column_name])).toEqual([
        [1, 'amount'],
        [1, 'customer'],
      ]);
      expect(result.errors[1]?.code).toBe('LINK_TARGET_NOT_FOUND');
    });

    it('caps a cell at 500 links (TOO_MANY_VALUES) and allow_multiple=false at one', async () => {
      const single = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
        name: 'main customer',
        type: 'link',
        options: { link_table: fx.customers.id, allow_multiple: false },
      });
      expect(single.statusCode, single.body).toBe(201);
      const singleId = fieldSchema.parse(single.json()).id;
      const many = Array.from({ length: 501 }, (_, i) => `k${String(i)}`).join(', ');
      const { result } = await imported(
        'u_editor',
        fx.orders.id,
        [
          'title,customer,main customer',
          `cap1,${csvCell(many)},`,
          `cap2,,${csvCell('An Phát, Bình Minh')}`,
          `cap3,,${csvCell('Nguyễn, An')}`,
        ],
        [
          { column: 0, field_id: fx.fld.title?.id as string },
          { column: 1, field_id: customer.id },
          { column: 2, field_id: singleId },
        ],
      );
      expect(result).toMatchObject({ imported: 1, failed: 2 });
      expect(result.errors.map((error) => [error.data_row, error.code])).toEqual([
        [1, 'TOO_MANY_VALUES'],
        [2, 'TOO_MANY_VALUES'],
      ]);
    });

    it('sets the parent of sub-records by title', async () => {
      const { result } = await imported(
        'u_editor',
        fx.tickets.id,
        ['Tiêu đề,parent', 'Con 2,Gốc', 'Con 3,Không có'],
        [
          { column: 0, field_id: fx.fld.ticketTitle?.id as string },
          { column: 1, field_id: parent.id },
        ],
      );
      expect(result).toMatchObject({ imported: 1, failed: 1 });
      expect(result.errors.map((error) => [error.data_row, error.code])).toEqual([
        [2, 'LINK_TARGET_NOT_FOUND'],
      ]);
      const listed = queried(
        await fx.call('owner', 'POST', `/tables/${fx.tickets.id}/records/query`, { limit: 100 }),
      );
      expect(
        listed.find((record) => record.fields['Tiêu đề'] === 'Con 2')?.fields['parent'],
      ).toEqual({ id: expect.any(String) as string, title: 'Gốc' });
    });

    it('round trip: an exported file imports back with the same links', async () => {
      const [header, ...rows] = csvOf(
        await fx.call('u_editor', 'GET', `/tables/${fx.orders.id}/export`),
      );
      const titleColumn = header?.indexOf('title') ?? -1;
      const customerColumn = header?.indexOf('customer') ?? -1;
      const source = rows.filter((row) => ['o1', 'o2', 'imp2'].includes(row[titleColumn] ?? ''));
      expect(source).toHaveLength(3);
      const lines = [
        'title,customer',
        ...source.map(
          (row) =>
            `${csvCell(`copy of ${row[titleColumn] ?? ''}`)},${csvCell(row[customerColumn] ?? '')}`,
        ),
      ];
      const { result } = await imported('u_editor', fx.orders.id, lines, [
        { column: 0, field_id: fx.fld.title?.id as string },
        { column: 1, field_id: customer.id },
      ]);
      expect(result).toMatchObject({ imported: 3, failed: 0 });
      const all = queried(
        await fx.call('owner', 'POST', `/tables/${fx.orders.id}/records/query?field_key_type=id`, {
          limit: 1000,
        }),
      );
      const idOf = (title: string) =>
        all.find((record) => record.fields[fx.fld.title?.id as string] === title)?.id;
      const links = await linksOf(
        ['o1', 'o2', 'imp2', 'copy of o1', 'copy of o2', 'copy of imp2'].map(
          (title) => idOf(title) as Id<'rec'>,
        ),
      );
      for (const title of ['o1', 'o2', 'imp2']) {
        expect(links.get(idOf(`copy of ${title}`) as Id<'rec'>)).toEqual(
          links.get(idOf(title) as Id<'rec'>),
        );
      }
      expect(links.get(orders.o1 as Id<'rec'>)).toEqual(['An Phát', 'Nguyễn, An']);
    });
  });
});
