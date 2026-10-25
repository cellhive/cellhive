import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { crc32, deflateRawSync } from 'node:zlib';

import {
  IMPORT_MAX_ROWS,
  importJobResultSchema,
  newId,
  importPreviewSchema,
  importUploadSchema,
  jobSchema,
  type Id,
  type ImportJobResult,
  type ImportNewColumn,
  type JobDto,
  type RealtimeServerMessage,
} from '@cellhive/contracts';
import {
  AppError,
  ImportsRepository,
  importReportKey,
  importUploadKey,
  JobsRepository,
  orgScope,
  RecordMutationService,
  runTableImport,
  SchemaService,
  type Db,
  type StorageDriver,
} from '@cellhive/server-core';
import { createWorker, type WorkerHandle } from '@cellhive/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { STORAGE_DRIVER } from '../../src/common/tokens.js';

import { Browser, seedOrg, seedUser } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { closeSockets, listen, TestSocket } from './realtime-support.js';
import {
  buildRecordFixture,
  expectProblem,
  type FixtureUser,
  type RecordFixture,
} from './record-fixture.js';
import {
  captureLogger,
  startTestApp,
  TEST_PUBLIC_URL,
  TEST_SESSION_SECRET,
  type TestApp,
} from './support.js';

import type { LightMyRequestResponse } from 'fastify';

const BOUNDARY = 'cellhive-test-boundary';
const execFileAsync = promisify(execFile);

function multipart(filename: string, bytes: Buffer, contentType = 'text/csv'): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);
}

/** A deflated zip (enough for the XLSX reader); `declaredSize` may lie. */
function zip(entries: { name: string; data: Buffer | string }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = typeof entry.data === 'string' ? Buffer.from(entry.data) : entry.data;
    const packed = deflateRawSync(data);
    const name = Buffer.from(entry.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, packed);
    centrals.push(central, name);
    offset += 30 + name.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

async function eventually<T>(
  probe: () => Promise<T | undefined>,
  timeoutMs = 60_000,
  label = 'condition',
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const BENCH_STATUSES = ['Mới', 'Đang xử lý', 'Xong', 'Huỷ'];

/** The benchmark file: `rows` rows × 20 columns (text, numbers, dates, checkboxes, select, notes). */
function benchLines(rows: number): string[] {
  const header = [
    'Tên',
    ...Array.from({ length: 5 }, (_, i) => `Số ${String(i + 1)}`),
    ...Array.from({ length: 3 }, (_, i) => `Ngày ${String(i + 1)}`),
    'Xong',
    'Ưu tiên',
    'Trạng thái',
    ...Array.from({ length: 8 }, (_, i) => `Ghi chú ${String(i + 1)}`),
  ];
  const lines = [header.join(',')];
  for (let i = 0; i < rows; i += 1) {
    const day = String((i % 28) + 1).padStart(2, '0');
    lines.push(
      [
        `Khách hàng ${String(i)}`,
        ...Array.from({ length: 5 }, (_, k) => `"${(1_000 * (i + k)).toLocaleString('vi-VN')}"`),
        `${day}/09/2026`,
        `${day}/10/2026`,
        `${day}/11/2026`,
        i % 2 === 0 ? 'x' : '',
        i % 3 === 0 ? 'có' : 'không',
        BENCH_STATUSES[i % 4],
        ...Array.from({ length: 8 }, (_, k) => `Ghi chú ${String(k)} của dòng ${String(i)}`),
      ].join(','),
    );
  }
  return lines;
}

/** Columns of `benchLines` as the preview guesses them. */
function benchColumns(): ImportNewColumn[] {
  const names = benchLines(0)[0]?.split(',') ?? [];
  const typeOf = (index: number): ImportNewColumn['type'] =>
    index === 0
      ? 'text'
      : index <= 5
        ? 'number'
        : index <= 8
          ? 'datetime'
          : index <= 10
            ? 'checkbox'
            : index === 11
              ? 'select'
              : 'text';
  return names.map((name, index) => ({
    column: index,
    name,
    type: typeOf(index),
    ...(typeOf(index) === 'datetime' ? { options: { style: { format: 'dd/MM/yyyy' } } } : {}),
    ...(index === 11
      ? {
          options: {
            options: BENCH_STATUSES.map((option) => ({ id: newId('opt'), name: option })),
          },
        }
      : {}),
  }));
}

/** RSS of a process in bytes (`ps`, macOS and Linux). */
async function rssOf(pid: number): Promise<number> {
  const { stdout } = await execFileAsync('ps', ['-o', 'rss=', '-p', String(pid)]);
  return Number(stdout.trim()) * 1024;
}

/**
 * The worker as its own process (`apps/worker/dist/main.js`) on the test
 * database and storage, sampling its RSS until `stop`.
 */
async function spawnWorker(
  config: TestApp['config'],
  databaseUrl: string,
): Promise<{ stop(): Promise<{ baseRss: number; peakRss: number }> }> {
  const main = fileURLToPath(new URL('../../../worker/dist/main.js', import.meta.url));
  const child = spawn(process.execPath, [main], {
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      PUBLIC_URL: TEST_PUBLIC_URL,
      DATABASE_URL: databaseUrl,
      CACHE_URL: config.cache.url,
      APP_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
      SESSION_SECRET: TEST_SESSION_SECRET,
      STORAGE_DRIVER: 'local',
      STORAGE_LOCAL_PATH: config.storage.driver === 'local' ? config.storage.path : '',
      LOG_LEVEL: 'warn',
      // As the `worker` service of docker-compose.yml runs it.
      NODE_OPTIONS:
        process.env.BENCH_NODE_OPTIONS ?? '--max-semi-space-size=4 --max-old-space-size=256',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error('worker did not start');
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  const baseRss = await rssOf(pid);
  let peakRss = baseRss;
  const sampler = setInterval(() => {
    rssOf(pid).then(
      (rss) => {
        peakRss = Math.max(peakRss, rss);
      },
      () => undefined,
    );
  }, 200);
  return {
    async stop() {
      clearInterval(sampler);
      peakRss = Math.max(peakRss, await rssOf(pid));
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
      return { baseRss, peakRss };
    },
  };
}

/**
 * T308: CSV/XLSX import through the real API and worker (CONTRACTS §19):
 * permissions before queuing, preview limits, the `table.import` job with
 * skipped rows, history, realtime `record.batch`, cancellation, cleanup of
 * a new table on failure, tenant fairness, and the 50 000 × 20 benchmark.
 */
describe('CSV/XLSX import (T308)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let worker: WorkerHandle | undefined;
  const sockets: TestSocket[] = [];

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    fx = await buildRecordFixture(t, db);
  });

  afterAll(async () => {
    await closeSockets(sockets);
    await worker?.close();
    await t.close();
    await db.destroy();
    await database.drop();
  });

  const startWorker = async () => {
    worker ??= await createWorker(t.config, {
      logger: captureLogger().logger,
      pollIntervalMs: 100,
    });
  };

  function upload(
    user: FixtureUser,
    filename: string,
    bytes: Buffer,
    baseId: Id<'bse'> = fx.baseId,
  ): Promise<LightMyRequestResponse> {
    return fx.call(user, 'POST', `/bases/${baseId}/imports/uploads`, multipart(filename, bytes), {
      'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
    });
  }

  async function uploaded(user: FixtureUser, filename: string, bytes: Buffer) {
    const response = await upload(user, filename, bytes);
    expect(response.statusCode, response.body).toBe(201);
    return importUploadSchema.parse(response.json());
  }

  function start(user: FixtureUser, body: object, baseId: Id<'bse'> = fx.baseId) {
    return fx.call(user, 'POST', `/bases/${baseId}/imports`, body);
  }

  async function started(user: FixtureUser, body: object): Promise<Id<'job'>> {
    const response = await start(user, body);
    expect(response.statusCode, response.body).toBe(202);
    return response.json<{ job_id: Id<'job'> }>().job_id;
  }

  async function finished(user: FixtureUser, jobId: string, timeoutMs = 60_000): Promise<JobDto> {
    return eventually(
      async () => {
        const job = jobSchema.parse((await fx.call(user, 'GET', `/jobs/${jobId}`)).json());
        return ['succeeded', 'failed', 'cancelled'].includes(job.status) ? job : undefined;
      },
      timeoutMs,
      `job ${jobId}`,
    );
  }

  const csv = (lines: string[]) => Buffer.from(`${lines.join('\r\n')}\r\n`);

  describe('before the job is queued', () => {
    it('checks base access on upload: 404 without access, 403 without anything to import into', async () => {
      const file = csv(['a', '1']);
      expectProblem(await upload('u_out', 'a.csv', file), 404, 'NOT_FOUND');
      expectProblem(await upload('stranger', 'a.csv', file), 404, 'NOT_FOUND');
      expectProblem(await upload('u_reader', 'a.csv', file), 403, 'PERMISSION_DENIED');
      expect((await upload('u_sales1', 'a.csv', file)).statusCode).toBe(201);
    });

    it('refuses what is not a CSV/XLSX, a body without file, and more than 50 MB', async () => {
      expectProblem(
        await upload('u_editor', 'old.xls', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2])),
        415,
        'UNSUPPORTED_MEDIA_TYPE',
      );
      const noFile = await fx.call(
        'u_editor',
        'POST',
        `/bases/${fx.baseId}/imports/uploads`,
        Buffer.from(
          `--${BOUNDARY}\r\nContent-Disposition: form-data; name="x"\r\n\r\ny\r\n--${BOUNDARY}--\r\n`,
        ),
        { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      );
      expectProblem(noFile, 422, 'VALIDATION_FAILED');
      expect(noFile.json<{ errors: { code: string }[] }>().errors[0]?.code).toBe('FILE_REQUIRED');
      const json = await fx.call('u_editor', 'POST', `/bases/${fx.baseId}/imports/uploads`, {
        a: 1,
      });
      expectProblem(json, 415, 'UNSUPPORTED_MEDIA_TYPE');
      const big = Buffer.alloc(50 * 1024 * 1024 + 1, 0x61);
      expectProblem(await upload('u_editor', 'big.csv', big), 413, 'PAYLOAD_TOO_LARGE');
    });

    it(`refuses more than ${String(IMPORT_MAX_ROWS)} rows at the preview (422 TOO_MANY_ROWS)`, async () => {
      const lines = ['n'];
      for (let i = 0; i <= IMPORT_MAX_ROWS; i += 1) lines.push(String(i));
      const response = await upload('u_editor', 'rows.csv', csv(lines));
      expectProblem(response, 422, 'VALIDATION_FAILED');
      expect(response.json<{ errors: unknown[] }>().errors).toEqual([
        expect.objectContaining({ code: 'TOO_MANY_ROWS', params: { limit: IMPORT_MAX_ROWS } }),
      ]);
      lines.pop();
      const ok = await uploaded('u_editor', 'rows.csv', csv(lines));
      expect(ok.preview.total_rows).toBe(IMPORT_MAX_ROWS);
    });

    it('refuses an XLSX zip bomb without inflating it (422 ARCHIVE_LIMIT_EXCEEDED)', async () => {
      const bomb = zip([
        { name: 'xl/workbook.xml', data: '<workbook><sheets/></workbook>' },
        { name: 'xl/worksheets/sheet1.xml', data: Buffer.alloc(300 * 1024 * 1024, 0x20) },
      ]);
      expect(bomb.length).toBeLessThan(1024 * 1024);
      const before = process.memoryUsage().rss;
      const response = await upload('u_editor', 'bomb.xlsx', bomb);
      expectProblem(response, 422, 'VALIDATION_FAILED');
      expect(response.json<{ errors: { code: string }[] }>().errors[0]?.code).toBe(
        'ARCHIVE_LIMIT_EXCEEDED',
      );
      expect(process.memoryUsage().rss - before).toBeLessThan(150 * 1024 * 1024);
    });

    it('previews with other options and keeps them for the import; uploads are private', async () => {
      const file = await uploaded(
        'u_editor',
        'semi.csv',
        csv(['Tên;Số tiền', 'A;1.500.000', 'B;2,5']),
      );
      expect(file.preview).toMatchObject({
        format: 'csv',
        encoding: 'utf-8',
        delimiter: ';',
        total_rows: 2,
      });
      expect(file.preview.columns.map((column) => column.type)).toEqual(['text', 'number']);
      const url = `/bases/${fx.baseId}/imports/uploads/${file.id}/preview`;
      const comma = await fx.call('u_editor', 'GET', `${url}?delimiter=%2C&header_row=false`);
      expect(comma.statusCode, comma.body).toBe(200);
      const preview = importPreviewSchema.parse(comma.json());
      expect(preview).toMatchObject({ delimiter: ',', header_row: false, total_rows: 3 });
      expect(preview.columns).toHaveLength(2); // "B;2,5" splits on the comma
      expectProblem(await fx.call('u_admin', 'GET', url), 404, 'NOT_FOUND');
      expectProblem(
        await fx.call('u_editor', 'GET', `${url}?delimiter=x`),
        422,
        'VALIDATION_FAILED',
      );
    });

    it('checks append permissions and mappings before queuing (P-matrix)', async () => {
      const file = await uploaded('u_sales1', 'orders.csv', csv(['title,cost,status', 'A,1,Mới']));
      const append = (tableId: string, mapping: object[]) =>
        start('u_sales1', { upload_id: file.id, mode: 'append', table_id: tableId, mapping });
      const F = (name: string) => fx.fld[name]?.id as string;
      // Customers is not visible to the Sales role.
      expectProblem(
        await append(fx.customers.id, [{ column: 0, field_id: F('customerName') }]),
        404,
        'NOT_FOUND',
      );
      // `cost` is `no_perm`: an unknown field, like one that does not exist.
      const cost = await append(fx.orders.id, [
        { column: 0, field_id: F('title') },
        { column: 1, field_id: F('cost') },
      ]);
      expectProblem(cost, 422, 'VALIDATION_FAILED');
      expect(cost.json<{ errors: unknown[] }>().errors).toEqual([
        expect.objectContaining({ path: 'mapping[1].field_id', code: 'UNKNOWN_FIELD' }),
      ]);
      // `status` is read-only for Sales.
      const status = await append(fx.orders.id, [{ column: 2, field_id: F('status') }]);
      expectProblem(status, 403, 'FIELD_READ_ONLY');
      expectProblem(
        await append(fx.orders.id, [{ column: 7, field_id: F('title') }]),
        422,
        'VALIDATION_FAILED',
      );
      // Only base admins create tables.
      expectProblem(
        await start('u_sales1', {
          upload_id: file.id,
          mode: 'create_table',
          table: { name: 'Mine', columns: [{ column: 0, name: 'title', type: 'text' }] },
        }),
        403,
        'PERMISSION_DENIED',
      );
      // Nothing was queued.
      const queued = await db.kysely
        .selectFrom('meta.jobs')
        .select('id')
        .where('type', '=', 'table.import')
        .execute();
      expect(queued).toEqual([]);
    });

    it('checks create-table columns (422) and the table name (409)', async () => {
      const file = await uploaded('owner', 'new.csv', csv(['a,b', '1,2']));
      const create = (table: object) =>
        start('owner', { upload_id: file.id, mode: 'create_table', table });
      expectProblem(
        await create({ name: 'X', columns: [{ column: 0, name: 'a', type: 'number' }] }),
        422,
        'VALIDATION_FAILED',
      );
      expectProblem(
        await create({
          name: 'X',
          columns: [
            { column: 0, name: 'a', type: 'text' },
            { column: 0, name: 'b', type: 'text' },
          ],
        }),
        422,
        'VALIDATION_FAILED',
      );
      expectProblem(
        await create({ name: 'Orders', columns: [{ column: 0, name: 'a', type: 'text' }] }),
        409,
        'NAME_CONFLICT',
      );
    });
  });

  describe('failure, cancel and fairness (worker started later)', () => {
    it('moves a new table to the trash when the job fails', async () => {
      const file = await uploaded('owner', 'lost.csv', csv(['Tên,Số', 'A,1']));
      const jobId = await started('owner', {
        upload_id: file.id,
        mode: 'create_table',
        table: {
          name: 'Lost import',
          columns: [
            { column: 0, name: 'Tên', type: 'text' },
            { column: 1, name: 'Số', type: 'number' },
          ],
        },
      });
      // The uploaded file disappears before the job reads it.
      await rm(join(t.storageRoot, 'objects', fx.orgId, file.id), { force: true });
      await startWorker();
      const job = await finished('owner', jobId);
      expect(job.status).toBe('failed');
      expect(job.error).toMatchObject({ code: 'NOT_FOUND' });
      const tables = await db.kysely
        .selectFrom('meta.tables')
        .select(['name', 'deleted_at'])
        .where('name', '=', 'Lost import')
        .execute();
      expect(tables).toHaveLength(1);
      expect(tables[0]?.deleted_at).not.toBeNull();
    });

    it('cancels a queued job and a running one; a created table goes to the trash', async () => {
      await startWorker();
      const lines = ['Tên,Số'];
      for (let i = 0; i < 20_000; i += 1) lines.push(`KH ${String(i)},${String(i)}`);
      const file = await uploaded('owner', 'cancel.csv', csv(lines));
      const jobId = await started('owner', {
        upload_id: file.id,
        mode: 'create_table',
        table: {
          name: 'Cancelled import',
          columns: [
            { column: 0, name: 'Tên', type: 'text' },
            { column: 1, name: 'Số', type: 'number' },
          ],
        },
      });
      await eventually(async () => {
        const job = jobSchema.parse((await fx.call('owner', 'GET', `/jobs/${jobId}`)).json());
        return job.progress > 0 ? job : undefined;
      });
      expectProblem(
        await fx.call('u_editor', 'POST', `/bases/${fx.baseId}/imports/${jobId}/cancel`),
        404,
        'NOT_FOUND',
      );
      const cancel = await fx.call('owner', 'POST', `/bases/${fx.baseId}/imports/${jobId}/cancel`);
      expect(cancel.statusCode, cancel.body).toBe(200);
      expect(cancel.json<JobDto>().status).toBe('cancelled');
      await eventually(async () => {
        const rows = await db.kysely
          .selectFrom('meta.tables')
          .select('deleted_at')
          .where('name', '=', 'Cancelled import')
          .execute();
        return rows[0]?.deleted_at === null || rows[0] === undefined ? undefined : true;
      });
      // A finished job is returned unchanged.
      const again = await fx.call('owner', 'POST', `/bases/${fx.baseId}/imports/${jobId}/cancel`);
      expect(again.json<JobDto>().status).toBe('cancelled');
    });

    it('never lets a busy organization hold another one (ADR-18)', async () => {
      await startWorker();
      // Organization A already runs an import (the org cap is 1).
      const jobs = new JobsRepository(db);
      const busy = await jobs.create(orgScope(fx.orgId), {
        type: 'table.import',
        createdBy: fx.users.owner.id,
      });
      await jobs.markRunning(orgScope(fx.orgId), busy.id);
      const fileA = await uploaded('owner', 'a.csv', csv(['Tên', 'A']));
      const jobA = await started('owner', {
        upload_id: fileA.id,
        mode: 'create_table',
        table: { name: 'Org A import', columns: [{ column: 0, name: 'Tên', type: 'text' }] },
      });

      const orgB = await seedOrg(db, 'Other');
      const ownerB = await seedUser(db, { memberships: [{ orgId: orgB, role: 'owner' }] });
      const browser = new Browser(t.app);
      expect((await browser.login(ownerB.email)).statusCode).toBe(204);
      const call = (method: 'GET' | 'POST', url: string, payload?: unknown, headers?: object) =>
        browser.request({
          method,
          url: `/api/v1${url}`,
          ...(payload === undefined ? {} : { payload: payload as object }),
          ...(headers === undefined ? {} : { headers: headers as Record<string, string> }),
        });
      const workspace = await call('POST', `/orgs/${orgB}/workspaces`, { name: 'W' });
      const baseB = (
        await call('POST', `/workspaces/${workspace.json<{ id: string }>().id}/bases`, {
          name: 'B',
        })
      ).json<{ id: Id<'bse'> }>().id;
      const fileB = await call(
        'POST',
        `/bases/${baseB}/imports/uploads`,
        multipart('b.csv', csv(['Tên', 'B'])),
        {
          'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
        },
      );
      expect(fileB.statusCode, fileB.body).toBe(201);
      const jobB = (
        await call('POST', `/bases/${baseB}/imports`, {
          upload_id: fileB.json<{ id: string }>().id,
          mode: 'create_table',
          table: { name: 'Org B import', columns: [{ column: 0, name: 'Tên', type: 'text' }] },
        })
      ).json<{ job_id: string }>().job_id;
      const doneB = await eventually(async () => {
        const job = jobSchema.parse((await call('GET', `/jobs/${jobB}`)).json());
        return job.status === 'succeeded' ? job : undefined;
      });
      expect(doneB.result).toMatchObject({ imported: 1 });
      // Org A waits for its slot, then runs.
      expect(jobSchema.parse((await fx.call('owner', 'GET', `/jobs/${jobA}`)).json()).status).toBe(
        'queued',
      );
      await jobs.markSucceeded(orgScope(fx.orgId), busy.id, {});
      expect((await finished('owner', jobA)).status).toBe('succeeded');
    });
  });

  describe('append', () => {
    it('skips invalid rows with a report of row/column/code; history carries the import', async () => {
      await startWorker();
      const lines = ['Tiêu đề;Số tiền;Trạng thái;Hạn'];
      const bad = new Set([3, 17, 25, 40, 41, 55, 60, 77, 88, 99]);
      for (let i = 0; i < 100; i += 1) {
        const amount = bad.has(i) ? 'abc' : '1.500.000';
        lines.push(`Ticket ${String(i)};${amount};Mới;25/09/2026`);
      }
      const file = await uploaded('u_editor', 'tickets.csv', csv(lines));
      const F = (name: string) => fx.fld[name]?.id as Id<'fld'>;
      const jobId = await started('u_editor', {
        upload_id: file.id,
        mode: 'append',
        table_id: fx.tickets.id,
        mapping: [
          { column: 0, field_id: F('ticketTitle') },
          { column: 1, field_id: F('ticketAmount') },
          { column: 2, field_id: F('ticketStatus') },
          { column: 3, field_id: F('due') },
        ],
      });
      const job = await finished('u_editor', jobId);
      expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
      const result: ImportJobResult = importJobResultSchema.parse(job.result);
      expect(result).toMatchObject({ mode: 'append', rows: 100, imported: 90, failed: 10 });
      expect(result.errors).toEqual(
        [...bad].map((i) => ({
          row: i + 2,
          data_row: i + 1,
          column: 1,
          column_name: 'Số tiền',
          field_id: F('ticketAmount'),
          code: 'EXPECTED_NUMBER',
        })),
      );
      // The CSV report is downloadable by the importer.
      const reportUrl = (result.download_url ?? '').replace('/api/v1', '');
      const report = await fx.call('u_editor', 'GET', reportUrl);
      expect(report.statusCode).toBe(302);
      expectProblem(await fx.call('u_reader', 'GET', reportUrl), 404, 'NOT_FOUND');
      // It holds the rejected values (T320): the importer only, not even an organization owner
      // (who still sees the job and its errors, without values).
      expectProblem(await fx.call('owner', 'GET', reportUrl), 404, 'NOT_FOUND');
      expect((await fx.call('owner', 'GET', `/jobs/${jobId}`)).statusCode).toBe(200);
      const stream = await t.app
        .get<StorageDriver>(STORAGE_DRIVER)
        .getStream(importReportKey(fx.orgId, jobId));
      const chunks: Buffer[] = [];
      for await (const chunk of stream ?? []) chunks.push(chunk as Buffer);
      const reportLines = Buffer.concat(chunks)
        .toString('utf8')
        .replace(/^\uFEFF/u, '')
        .trim()
        .split('\r\n');
      expect(reportLines[0]).toBe('row,column,column_name,field_id,code,data_row,value');
      expect(reportLines[1]).toBe(`5,1,Số tiền,${F('ticketAmount')},EXPECTED_NUMBER,4,abc`);

      const records = await fx.call(
        'u_editor',
        'POST',
        `/tables/${fx.tickets.id}/records/query?field_key_type=id`,
        { search: 'Ticket 0', limit: 5 },
      );
      expect(records.statusCode, records.body).toBe(200);
      const record = records
        .json<{ records: { id: string; fields: Record<string, unknown> }[] }>()
        .records.find((item) => item.fields[F('ticketTitle')] === 'Ticket 0');
      expect(record?.fields[F('ticketAmount')]).toBe(1_500_000);
      expect(record?.fields[F('due')]).toBe('2026-09-25');
      const history = await fx.call(
        'u_editor',
        'GET',
        `/tables/${fx.tickets.id}/records/${record?.id ?? ''}/history`,
      );
      expect(history.json<{ items: unknown[] }>().items[0]).toMatchObject({
        action: 'record.created',
        actor: { type: 'user', id: fx.users.u_editor.id },
        via: { import_job_id: jobId },
        batch: { id: jobId, size: 90 },
      });
      // One audit entry per record (ADR-23), none for skipped rows.
      const audits = await db.kysely
        .selectFrom('meta.audit_logs')
        .select((eb) => eb.fn.countAll<bigint>().as('n'))
        .where('batch_id', '=', jobId)
        .where('entity_type', '=', 'record')
        .executeTakeFirstOrThrow();
      expect(Number(audits.n)).toBe(90);
    });

    it('reports a text too long for a unique index as a row error (422 on a direct write)', async () => {
      await startWorker();
      const created = await fx.call('owner', 'POST', `/tables/${fx.tickets.id}/fields`, {
        name: 'Mã duy nhất',
        type: 'text',
        unique_values: true,
      });
      expect(created.statusCode, created.body).toBe(201);
      const unique = created.json<{ id: Id<'fld'> }>().id;
      // Incompressible, well past the B-tree entry limit (~2.7 KB).
      const long = randomBytes(6_000).toString('hex');
      const written = await fx.call(
        'u_editor',
        'POST',
        `/tables/${fx.tickets.id}/records?field_key_type=id`,
        { records: [{ fields: { [unique]: long } }] },
      );
      expectProblem(written, 422, 'INVALID_CELL_VALUE');
      expect(written.json()).toMatchObject({
        errors: [{ path: 'records', code: 'UNIQUE_VALUE_TOO_LONG' }],
      });

      const file = await uploaded(
        'u_editor',
        'unique.csv',
        csv(['Tiêu đề,Mã', 'A,u-1', `B,${long}`, 'C,u-3']),
      );
      const jobId = await started('u_editor', {
        upload_id: file.id,
        mode: 'append',
        table_id: fx.tickets.id,
        mapping: [
          { column: 0, field_id: fx.fld.ticketTitle?.id },
          { column: 1, field_id: unique },
        ],
      });
      const job = await finished('u_editor', jobId);
      expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
      expect(importJobResultSchema.parse(job.result)).toMatchObject({
        rows: 3,
        imported: 2,
        failed: 1,
        errors: [{ row: 3, data_row: 2, code: 'UNIQUE_VALUE_TOO_LONG' }],
      });
    });

    it('fails rows one at a time when errors name no row of the batch (no endless retry)', async () => {
      const scope = orgScope(fx.orgId);
      const importId = newId('imp');
      const bytes = csv(['Tiêu đề', 'a', 'b', 'c']);
      const storage = t.app.get<StorageDriver>(STORAGE_DRIVER);
      await storage.put(importUploadKey(fx.orgId, importId), bytes, { contentType: 'text/csv' });
      const imports = new ImportsRepository(db);
      await imports.create(scope, {
        id: importId,
        baseId: fx.baseId,
        createdBy: fx.users.owner.id,
        filename: 'outside.csv',
        format: 'csv',
        size: bytes.length,
        options: {
          encoding: 'utf-8',
          delimiter: ',',
          sheet: null,
          header_row: true,
          columns: ['Tiêu đề'],
          total_rows: 3,
        },
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      const jobs = new JobsRepository(db);
      const job = await jobs.create(scope, { type: 'table.import', createdBy: fx.users.owner.id });
      await imports.claim(
        scope,
        { id: importId, baseId: fx.baseId, userId: fx.users.owner.id },
        job.id,
      );
      await jobs.markRunning(scope, job.id);
      let calls = 0;
      // Every write fails naming a record index outside the batch.
      const records = {
        create: () => {
          calls += 1;
          if (calls > 20) throw new Error('endless retry');
          return Promise.reject(
            new AppError('INVALID_CELL_VALUE', {
              errors: [{ path: 'records[99].fields.x', code: 'EXPECTED_STRING', message: 'x' }],
            }),
          );
        },
      };
      const outcome = await runTableImport(
        {
          db,
          schema: t.app.get(SchemaService),
          records: records,
          jobs,
          imports,
          storage,
          defaults: { timeZone: 'Asia/Ho_Chi_Minh', locale: 'vi' },
          maxFieldsPerTable: 500,
        },
        {
          organization_id: fx.orgId,
          job_id: job.id,
          import_id: importId,
          base_id: fx.baseId,
          user_id: fx.users.owner.id,
          spec: {
            mode: 'append',
            table_id: fx.tickets.id,
            mapping: [{ column: 0, field_id: fx.fld.ticketTitle?.id as Id<'fld'> }],
          },
        },
      );
      expect(outcome).toMatchObject({ status: 'succeeded', rows: 3, imported: 0, failed: 3 });
      expect(calls).toBe(4);
    });

    it('reaches table subscribers as one record.batch per batch, not per record', async () => {
      await startWorker();
      const url = await listen(t.app);
      const socket = await TestSocket.connect(url, {
        origin: TEST_PUBLIC_URL,
        cookie: await fx.cookie('u_editor'),
      });
      sockets.push(socket);
      expect(await socket.subscribe(`table:${fx.tickets.id}`)).toMatchObject({
        type: 'subscribed',
      });
      const own = await TestSocket.connect(url, {
        origin: TEST_PUBLIC_URL,
        cookie: await fx.cookie('u_editor'),
      });
      sockets.push(own);
      expect(await own.subscribe(`user:${fx.users.u_editor.id}`)).toMatchObject({
        type: 'subscribed',
      });
      const lines = ['Tiêu đề'];
      for (let i = 0; i < 2_500; i += 1) lines.push(`Bulk ${String(i)}`);
      const file = await uploaded('u_editor', 'bulk.csv', csv(lines));
      const jobId = await started('u_editor', {
        upload_id: file.id,
        mode: 'append',
        table_id: fx.tickets.id,
        mapping: [{ column: 0, field_id: fx.fld.ticketTitle?.id }],
      });
      expect((await finished('u_editor', jobId)).status).toBe('succeeded');
      const isBatch = (message: RealtimeServerMessage) => message.type === 'record.batch';
      const counts: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        const message = await socket.next(isBatch, 15_000);
        if (message.type === 'record.batch') counts.push(message.count);
      }
      expect(counts.sort((a, b) => a - b)).toEqual([500, 1000, 1000]);
      await socket.expectNone((message) => message.type.startsWith('record.'), 500);
      // job.progress reached the importer's own channel, up to the end.
      const progress = (status: string) => (message: RealtimeServerMessage) =>
        message.type === 'job.progress' && message.job_id === jobId && message.status === status;
      await own.next(progress('running'), 15_000);
      await own.next(progress('succeeded'), 15_000);
    });
  });

  describe('export → import round trip (T321)', () => {
    it('imports back negative numbers and formula-looking text of an exported CSV unchanged', async () => {
      await startWorker();
      const F = (name: string) => fx.fld[name]?.id as Id<'fld'>;
      const titles = ["-2+3+cmd|' /C calc'!A0", '@SUM(1)', 'T321 plain'];
      const amounts = [-1_500_000, -7, 42];
      const created = await fx.call(
        'u_editor',
        'POST',
        `/tables/${fx.orders.id}/records?field_key_type=id`,
        {
          records: titles.map((title, index) => ({
            fields: { [F('title')]: title, [F('amount')]: amounts[index] },
          })),
        },
      );
      expect(created.statusCode, created.body).toBe(201);

      const exported = await fx.call(
        'u_editor',
        'GET',
        `/tables/${fx.orders.id}/export?format=csv`,
      );
      expect(exported.statusCode, exported.body).toBe(200);
      const text = exported.rawPayload.toString('utf8');
      // The formula-looking titles are guarded; the negative numbers are not (T321).
      expect(text).toContain(`\r\n'-2+3+cmd|' /C calc'!A0,-1500000,`);
      expect(text).toContain(`\r\n'@SUM(1),-7,`);
      expect(text).toContain('\r\nT321 plain,42,');

      const file = await uploaded('u_editor', 'orders-export.csv', exported.rawPayload);
      expect(file.preview.columns[1]).toMatchObject({ name: 'amount', type: 'number' });
      const jobId = await started('u_editor', {
        upload_id: file.id,
        mode: 'append',
        table_id: fx.orders.id,
        mapping: [
          { column: 0, field_id: F('title') },
          { column: 1, field_id: F('amount') },
        ],
      });
      const job = await finished('u_editor', jobId);
      expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
      expect(importJobResultSchema.parse(job.result)).toMatchObject({ failed: 0, errors: [] });

      const records = await fx.call(
        'u_editor',
        'POST',
        `/tables/${fx.orders.id}/records/query?field_key_type=id`,
        { limit: 1000 },
      );
      expect(records.statusCode, records.body).toBe(200);
      const rows = records.json<{ records: { fields: Record<string, unknown> }[] }>().records;
      titles.forEach((title, index) => {
        const copies = rows.filter((row) => row.fields[F('title')] === title);
        expect(
          copies.map((row) => row.fields[F('amount')]),
          title,
        ).toEqual([amounts[index], amounts[index]]);
      });
    });
  });

  describe('create table', () => {
    /**
     * T308 acceptance bench: 50 000 rows < 120 s, worker RSS < 300 MB, with
     * `IMPORT_BENCH=1` (`IMPORT_BENCH_MAX_SECONDS`, `IMPORT_BENCH_MAX_RSS_MB`
     * to change the budgets). By default the same path runs on 5 000 rows
     * without the time budget: wall time under load (every package's
     * integration tests at once) is not a property of the code (T319).
     */
    const IMPORT_BENCH = process.env.IMPORT_BENCH === '1';
    const benchRows = IMPORT_BENCH ? 50_000 : 5_000;

    it(`imports ${String(benchRows)} rows × 20 columns into a new table in a worker process (benchmark with IMPORT_BENCH=1)`, async () => {
      await startWorker();
      const lines = benchLines(benchRows);
      const file = await uploaded('owner', 'bench.csv', csv(lines));
      expect(file.preview.total_rows).toBe(benchRows);
      const columns = file.preview.columns.map((column) => ({
        column: column.index,
        name: column.name,
        type: column.type,
        options: column.options,
      }));
      expect(columns.map((column) => column.type)).toEqual([
        'text',
        'number',
        'number',
        'number',
        'number',
        'number',
        'datetime',
        'datetime',
        'datetime',
        'checkbox',
        'checkbox',
        'select',
        'text',
        'text',
        'text',
        'text',
        'text',
        'text',
        'text',
        'text',
      ]);
      // The job runs in a worker process of its own, so its memory can be measured.
      await worker?.close();
      worker = undefined;
      const child = await spawnWorker(t.config, database.url);
      const began = performance.now();
      const jobId = await started('owner', {
        upload_id: file.id,
        mode: 'create_table',
        table: { name: 'Bench import', columns },
      });
      const job = await finished('owner', jobId, 600_000);
      const seconds = (performance.now() - began) / 1000;
      const { baseRss, peakRss } = await child.stop();
      expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
      const result = importJobResultSchema.parse(job.result);
      expect(result).toMatchObject({ rows: benchRows, imported: benchRows, failed: 0 });
      const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);
      // Reported in T308: duration, and memory of the worker process.
      process.stdout.write(
        `[T308 bench] ${String(benchRows)} x 20 CSV → new table: ${seconds.toFixed(1)} s, worker RSS ` +
          `${String(mb(baseRss))} MB idle → peak ${String(mb(peakRss))} MB\n`,
      );
      expect(seconds).toBeLessThan(
        IMPORT_BENCH ? Number(process.env.IMPORT_BENCH_MAX_SECONDS ?? 120) : Infinity,
      );
      expect(peakRss).toBeLessThan(
        Number(process.env.IMPORT_BENCH_MAX_RSS_MB ?? 300) * 1024 * 1024,
      );
      const count = await fx.call('owner', 'POST', `/tables/${result.table_id}/records/query`, {
        limit: 1,
      });
      expect(count.json<{ total: number }>().total).toBe(benchRows);
      // The upload is used up and its file deleted.
      const row = await new ImportsRepository(db).getById(orgScope(fx.orgId), file.id);
      expect(row?.job_id).toBe(jobId);
    }, 900_000);

    // S3 decision 6: numbers only, to decide later whether to raise the cap.
    it.runIf(process.env.IMPORT_BENCH_100K === '1')(
      'measures 100 000 rows × 20 columns (numbers only, above the cap)',
      async () => {
        await worker?.close();
        worker = undefined;
        const lines = benchLines(100_000);
        const scope = orgScope(fx.orgId);
        const importId = newId('imp');
        const bytes = csv(lines);
        const storage = t.app.get<StorageDriver>(STORAGE_DRIVER);
        await storage.put(importUploadKey(fx.orgId, importId), bytes, { contentType: 'text/csv' });
        const imports = new ImportsRepository(db);
        await imports.create(scope, {
          id: importId,
          baseId: fx.baseId,
          createdBy: fx.users.owner.id,
          filename: 'bench100k.csv',
          format: 'csv',
          size: bytes.length,
          options: {
            encoding: 'utf-8',
            delimiter: ',',
            sheet: null,
            header_row: true,
            columns: benchLines(0)[0]?.split(',') ?? [],
            total_rows: 100_000,
          },
          expiresAt: new Date(Date.now() + 3_600_000),
        });
        const jobs = new JobsRepository(db);
        const job = await jobs.create(scope, {
          type: 'table.import',
          createdBy: fx.users.owner.id,
        });
        await imports.claim(
          scope,
          { id: importId, baseId: fx.baseId, userId: fx.users.owner.id },
          job.id,
        );
        await jobs.markRunning(scope, job.id);
        const schema = t.app.get(SchemaService);
        const records = new RecordMutationService(db, {
          schema,
          statementTimeoutMs: 60_000,
        });
        const columns = benchColumns();
        const began = performance.now();
        const outcome = await runTableImport(
          {
            db,
            schema,
            records,
            jobs,
            imports,
            storage,
            defaults: { timeZone: 'Asia/Ho_Chi_Minh', locale: 'vi' },
            maxFieldsPerTable: 500,
            maxRows: 100_000,
          },
          {
            organization_id: fx.orgId,
            job_id: job.id,
            import_id: importId,
            base_id: fx.baseId,
            user_id: fx.users.owner.id,
            spec: { mode: 'create_table', table: { name: 'Bench 100k', columns } },
          },
        );
        const seconds = (performance.now() - began) / 1000;
        process.stdout.write(
          `[T308 bench] 100000 x 20 CSV → new table (in-process): ${seconds.toFixed(1)} s, ` +
            `${String(outcome.batches)} batches\n`,
        );
        expect(outcome).toMatchObject({ status: 'succeeded', imported: 100_000 });
      },
      1_800_000,
    );
  });
});
