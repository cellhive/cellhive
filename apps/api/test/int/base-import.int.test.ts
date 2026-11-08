import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BASE_IMPORT_JOB_TYPE,
  baseImportResultSchema,
  jobAcceptedSchema,
  jobSchema,
  newId,
  type BaseImportResult,
  type Id,
  type JobDto,
} from '@cellhive/contracts';
import {
  AttachmentsRepository,
  basePackageImportKey,
  basePackageKey,
  createBaseRecord,
  createStorageDriver,
  enqueue,
  JobsRepository,
  orgScope,
  SchemaService,
  systemAuditContext,
  type BaseImportTarget,
  type Db,
  type FieldRow,
  type StorageDriver,
} from '@cellhive/server-core';
import { buildTaskList, createWorker, type WorkerHandle } from '@cellhive/worker';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createSampleAttachment, sampleFiles } from '../../src/seed/sample-attachments.js';

import { leftovers, MULTIPART, multipart } from './chbase-packages.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { listen, TestSocket } from './realtime-support.js';
import { buildRecordFixture, type FixtureUser, type RecordFixture } from './record-fixture.js';
import { captureLogger, startTestApp, TEST_PUBLIC_URL, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';

const MIB = 1024 * 1024;

async function finishedJob(read: () => Promise<LightMyRequestResponse>): Promise<JobDto> {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const response = await read();
    expect(response.statusCode, response.body).toBe(200);
    const job = jobSchema.parse(response.json());
    if (['succeeded', 'failed', 'cancelled'].includes(job.status)) return job;
    if (Date.now() > deadline) throw new Error(`job ${job.id} still ${job.status}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

/** `target` with some of its methods replaced (the others keep their receiver). */
function wrapTarget(
  target: BaseImportTarget,
  overrides: Partial<BaseImportTarget>,
): BaseImportTarget {
  return {
    members: () => target.members(),
    createBase: (input) => target.createBase(input),
    createTable: (baseId, input) => target.createTable(baseId, input),
    createLink: (baseId, input) => target.createLink(baseId, input),
    storeFile: (baseId, file, content) => target.storeFile(baseId, file, content),
    load: (baseId, batch) => target.load(baseId, batch),
    checkpoint: () => target.checkpoint(),
    progress: (progress, phase) => target.progress(progress, phase),
    finish: (baseId, result, counts) => target.finish(baseId, result, counts),
    purge: () => target.purge(),
    ...overrides,
  };
}

async function streamBytes(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/**
 * BACKLOG T1018 (CONTRACTS §12.2): the round trip of a base through a
 * `.chbase` package — the fixture base of CONTRACTS §5 with links both
 * ways, sub-records, a file, users, select options, dates and auto numbers
 * exported by T1017's job, then imported into another workspace through
 * `POST /workspaces/:id/bases/import` and the `base.import` job: every
 * table, field, record value, time, creator, link (with its position),
 * parent and file matches, under new ids.
 */
describe('base import round trip (T1018)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let worker: WorkerHandle;
  let storage: StorageDriver;
  let tempRoot: string;
  let targetWorkspace: Id<'wsp'>;
  let packageBytes: Buffer;
  let result: BaseImportResult;
  const extra = {} as Record<'customer' | 'reverse' | 'files' | 'done' | 'parent', FieldRow>;
  const recordIds = {} as Record<'c1' | 'c2' | 'r1' | 'r2' | 'r3' | 't1' | 't2' | 't3', Id<'rec'>>;
  let attachmentSha: string;
  let nextTarget: ((target: BaseImportTarget) => BaseImportTarget) | null = null;

  const jobOf = (jobId: Id<'job'>) => finishedJob(() => fx.call('owner', 'GET', `/jobs/${jobId}`));

  async function importAs(
    user: FixtureUser,
    into: Id<'wsp'>,
    bytes: Buffer,
    filename = 'base.chbase',
  ): Promise<LightMyRequestResponse> {
    return fx.call(
      user,
      'POST',
      `/workspaces/${into}/bases/import`,
      multipart(filename, bytes),
      MULTIPART,
    );
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url, BASE_PACKAGE_MAX_BYTES: String(4 * MIB) });
    fx = await buildRecordFixture(t, db);
    storage = createStorageDriver(t.config);
    tempRoot = await mkdtemp(join(tmpdir(), 'cellhive-base-import-test-'));
    const scope = orgScope(fx.orgId);
    const schema = t.app.get(SchemaService);
    const context = systemAuditContext();
    extra.customer = await schema.addField(
      scope,
      fx.orders.id,
      {
        name: 'customer',
        type: 'link',
        options: {
          link_table: fx.customers.id,
          bidirectional: true,
          bidirectional_link_field_name: 'orders',
          allow_multiple: true,
        },
      },
      context,
    );
    const reverseId = (extra.customer.options as { symmetric_field_id: Id<'fld'> })
      .symmetric_field_id;
    extra.reverse = await db.kysely
      .selectFrom('meta.fields')
      .selectAll()
      .where('id', '=', reverseId)
      .executeTakeFirstOrThrow();
    extra.files = await schema.addField(
      scope,
      fx.orders.id,
      { name: 'files', type: 'attachment' },
      context,
    );
    extra.done = await schema.addField(
      scope,
      fx.orders.id,
      { name: 'done', type: 'checkbox' },
      context,
    );
    extra.parent = await schema.addField(
      scope,
      fx.tickets.id,
      { name: 'parent', type: 'parent' },
      context,
    );

    const create = async (tableId: Id<'tbl'>, records: object[]) => {
      const response = await fx.call('owner', 'POST', `/tables/${tableId}/records`, { records });
      expect(response.statusCode, response.body).toBe(201);
      return response.json<{ records: { id: Id<'rec'> }[] }>().records.map((record) => record.id);
    };
    [recordIds.c1, recordIds.c2] = (await create(fx.customers.id, [
      { fields: { Tên: 'An', 'Mã khách hàng': 'C-1' } },
      { fields: { Tên: 'Bình', 'Mã khách hàng': 'C-2' } },
    ])) as [Id<'rec'>, Id<'rec'>];
    const statusOptions = (fx.fld['status']?.options as { options: { id: Id<'opt'> }[] }).options;
    [recordIds.r1, recordIds.r2, recordIds.r3] = (await create(fx.orders.id, [
      {
        fields: {
          title: 'r1',
          amount: 100,
          cost: 60,
          status: statusOptions[0]?.id,
          owner: [{ id: fx.users.u_sales1.id }],
          customer: [recordIds.c1],
          done: true,
        },
      },
      {
        fields: {
          title: 'r2',
          amount: 200.5,
          owner: [{ id: fx.users.u_sales2.id }],
          customer: [recordIds.c2, recordIds.c1],
        },
      },
      { fields: { title: 'r3' } },
    ])) as [Id<'rec'>, Id<'rec'>, Id<'rec'>];
    [recordIds.t1] = (await create(fx.tickets.id, [
      { fields: { 'Tiêu đề': 't1', Hạn: '2026-11-08' } },
    ])) as [Id<'rec'>];
    [recordIds.t2] = (await create(fx.tickets.id, [
      { fields: { 'Tiêu đề': 't2' }, parent_id: recordIds.t1 },
    ])) as [Id<'rec'>];
    [recordIds.t3] = (await create(fx.tickets.id, [
      { fields: { 'Tiêu đề': 't3' }, parent_id: recordIds.t2 },
    ])) as [Id<'rec'>];

    const file = sampleFiles()[0];
    if (file === undefined) throw new Error('no sample file');
    attachmentSha = sha256(file.bytes);
    const attachment = await createSampleAttachment(db, storage, scope, {
      baseId: fx.baseId,
      tableId: fx.orders.id,
      fieldId: extra.files.id,
      ownerId: fx.users.owner.id,
      file,
    });
    const attached = await fx.call('owner', 'PATCH', `/tables/${fx.orders.id}/records`, {
      records: [{ id: recordIds.r1, fields: { files: [{ id: attachment }] } }],
    });
    expect(attached.statusCode, attached.body).toBe(200);

    const target = await fx.call('owner', 'POST', `/orgs/${fx.orgId}/workspaces`, {
      name: 'Imported',
    });
    expect(target.statusCode, target.body).toBe(201);
    targetWorkspace = target.json<{ id: Id<'wsp'> }>().id;

    const { logger } = captureLogger();
    worker = await createWorker(t.config, {
      logger,
      pollIntervalMs: 50,
      taskList: buildTaskList({
        config: t.config,
        db,
        logger,
        baseExport: { tempRoot },
        baseImport: {
          tempRoot,
          target: (own) => {
            const wrap = nextTarget;
            nextTarget = null;
            return wrap === null ? own : wrap(own);
          },
        },
      }),
    });

    const exported = await fx.call('owner', 'POST', `/bases/${fx.baseId}/export`);
    expect(exported.statusCode, exported.body).toBe(202);
    const exportJob = await jobOf(jobAcceptedSchema.parse(exported.json()).job_id);
    expect(exportJob.status, JSON.stringify(exportJob.error)).toBe('succeeded');
    const stream = await storage.getStream(basePackageKey(fx.orgId, exportJob.id));
    if (stream === null) throw new Error('no package');
    packageBytes = await streamBytes(stream);

    const imported = await importAs('owner', targetWorkspace, packageBytes);
    expect(imported.statusCode, imported.body).toBe(202);
    const job = await jobOf(jobAcceptedSchema.parse(imported.json()).job_id);
    expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
    result = baseImportResultSchema.parse(job.result);
  }, 240_000);

  afterAll(async () => {
    await (worker as WorkerHandle | undefined)?.close();
    await storage.close();
    await t.close();
    await db.destroy();
    await database.drop();
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('creates a visible base in the target workspace, owned by the importer, with a report', async () => {
    const base = await fx.call('owner', 'GET', `/bases/${result.base_id}`);
    expect(base.statusCode, base.body).toBe(200);
    expect(base.json()).toMatchObject({
      workspace_id: targetWorkspace,
      owner_id: fx.users.owner.id,
      name: 'B',
      deleted_at: null,
    });
    expect(result.report).toMatchObject({
      tables: 3,
      records: 8,
      links: 3,
      attachments: 1,
      files_skipped: [],
      unmatched_users: 0,
    });
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it('keeps every table, field, value, time, creator, link, parent and file under new ids', async () => {
    const tablesOf = (baseId: Id<'bse'>) =>
      db.kysely
        .selectFrom('meta.tables')
        .selectAll()
        .where('base_id', '=', baseId)
        .orderBy('position')
        .execute();
    const source = await tablesOf(fx.baseId);
    const copy = await tablesOf(result.base_id);
    expect(copy.map((table) => table.name)).toEqual(source.map((table) => table.name));
    for (const [index, table] of source.entries()) {
      const twin = copy[index];
      if (twin === undefined) throw new Error('missing table');
      expect(twin.id).not.toBe(table.id);
      const fieldsOf = (tableId: Id<'tbl'>) =>
        db.kysely
          .selectFrom('meta.fields')
          .selectAll()
          .where('table_id', '=', tableId)
          .where('deleted_at', 'is', null)
          .orderBy('position')
          .execute();
      const fields = await fieldsOf(table.id);
      const twinFields = await fieldsOf(twin.id);
      expect(twinFields.map((field) => [field.name, field.type, field.is_primary])).toEqual(
        fields.map((field) => [field.name, field.type, field.is_primary]),
      );
      const rowsOf = async (dataTable: string) =>
        (
          await sql<
            Record<string, unknown>
          >`SELECT * FROM ${sql.table(`data.${dataTable}`)} ORDER BY __auto`.execute(db.kysely)
        ).rows;
      const rows = await rowsOf(table.db_table_name);
      const twinRows = await rowsOf(twin.db_table_name);
      expect(twinRows).toHaveLength(rows.length);
      for (const [position, row] of rows.entries()) {
        const other = twinRows[position] ?? {};
        expect(other['__auto']).toEqual(row['__auto']);
        expect(other['__created_at']).toEqual(row['__created_at']);
        expect(other['__updated_at']).toEqual(row['__updated_at']);
        expect(other['__created_by']).toEqual(row['__created_by']);
        expect(other['__version']).toBe(1);
        for (const [fieldIndex, field] of fields.entries()) {
          const twinField = twinFields[fieldIndex];
          if (field.db_column_name === null || twinField?.db_column_name === null) continue;
          const value = row[field.db_column_name];
          const twinValue = other[twinField?.db_column_name ?? ''];
          if (field.type === 'select' && Array.isArray(value)) {
            const names = (options: unknown, ids: unknown) =>
              (ids as string[]).map(
                (id) =>
                  (options as { options: { id: string; name: string }[] }).options.find(
                    (option) => option.id === id,
                  )?.name,
              );
            expect(names(twinField?.options, twinValue)).toEqual(names(field.options, value));
          } else if (field.type === 'attachment' && Array.isArray(value)) {
            expect((twinValue as { name: string }[]).map((file) => file.name)).toEqual(
              (value as { name: string }[]).map((file) => file.name),
            );
          } else {
            expect(twinValue).toEqual(value);
          }
        }
      }
    }
  });

  it('keeps both sides of links with their positions, and the parents', async () => {
    const recordsOf = async (baseId: Id<'bse'>, name: string) => {
      const table = await db.kysely
        .selectFrom('meta.tables')
        .select('db_table_name')
        .where('base_id', '=', baseId)
        .where('name', '=', name)
        .executeTakeFirstOrThrow();
      return (
        await sql<{
          __id: string;
          __auto: string;
          __parent_id: string | null;
        }>`SELECT * FROM ${sql.table(`data.${table.db_table_name}`)} ORDER BY __auto`.execute(
          db.kysely,
        )
      ).rows;
    };
    const junctionOf = async (baseId: Id<'bse'>) => {
      const field = await db.kysely
        .selectFrom('meta.fields as f')
        .innerJoin('meta.tables as t', 't.id', 'f.table_id')
        .select(['f.link_junction', 'f.id'])
        .where('t.base_id', '=', baseId)
        .where('f.type', '=', 'link')
        .where('f.link_side', '=', 'a')
        .executeTakeFirstOrThrow();
      return (
        await sql<{
          a_id: string;
          b_id: string;
          position: number;
        }>`SELECT * FROM ${sql.table(`data.${field.link_junction ?? ''}`)} ORDER BY a_id, position`.execute(
          db.kysely,
        )
      ).rows;
    };
    const autoOf = (rows: { __id: string; __auto: string }[]) =>
      new Map(rows.map((row) => [row.__id, row.__auto]));
    const [orders, customers, twinOrders, twinCustomers] = await Promise.all([
      recordsOf(fx.baseId, 'Orders'),
      recordsOf(fx.baseId, 'Customers'),
      recordsOf(result.base_id, 'Orders'),
      recordsOf(result.base_id, 'Customers'),
    ]);
    const shape = (
      rows: { a_id: string; b_id: string; position: number }[],
      a: Map<string, string>,
      b: Map<string, string>,
    ) => rows.map((row) => [a.get(row.a_id), b.get(row.b_id), row.position]).sort();
    expect(
      shape(await junctionOf(result.base_id), autoOf(twinOrders), autoOf(twinCustomers)),
    ).toEqual(shape(await junctionOf(fx.baseId), autoOf(orders), autoOf(customers)));
    const tickets = await recordsOf(result.base_id, 'Tickets');
    const auto = autoOf(tickets);
    expect(
      tickets.map((row) => (row.__parent_id === null ? null : auto.get(row.__parent_id))),
    ).toEqual([null, auto.get(tickets[0]?.__id ?? ''), auto.get(tickets[1]?.__id ?? '')]);
    // The reverse side reads the same junction: Customers show their orders.
    const reverse = await fx.call(
      'owner',
      'GET',
      `/tables/${(await db.kysely.selectFrom('meta.tables').select('id').where('base_id', '=', result.base_id).where('name', '=', 'Customers').executeTakeFirstOrThrow()).id}/records?field_key_type=name`,
    );
    expect(reverse.statusCode, reverse.body).toBe(200);
  });

  it('stores the files again under new keys with the same content', async () => {
    const files = await db.kysely
      .selectFrom('meta.attachments')
      .selectAll()
      .where('base_id', '=', result.base_id)
      .execute();
    expect(files).toHaveLength(1);
    const [file] = files;
    expect(file).toMatchObject({
      status: 'ready',
      sha256: attachmentSha,
      created_by: fx.users.owner.id,
    });
    expect(file?.object_key).toBe(`${fx.orgId}/${file?.id ?? ''}`);
    const stream = await storage.getStream(file?.object_key ?? '');
    expect(sha256(await streamBytes(stream as NodeJS.ReadableStream))).toBe(attachmentSha);
  });

  it('records base.created and one base.imported, no event or audit entry per record', async () => {
    const audit = await db.kysely
      .selectFrom('meta.audit_logs')
      .select(['action', 'entity_type', 'entity_id', 'after'])
      .where('base_id', '=', result.base_id)
      .execute();
    expect(audit.map((entry) => entry.action).sort()).toEqual(['base.created', 'base.imported']);
    expect(audit.find((entry) => entry.action === 'base.imported')).toMatchObject({
      entity_type: 'job',
      after: { counts: { tables: 3, records: 8, links: 3, attachments: 1 } },
    });
    const { rows: events } = await sql<{ type: string }>`
      SELECT type FROM meta.events WHERE payload->>'base_id' = ${result.base_id}
    `.execute(db.kysely);
    expect(events.map((event) => event.type)).toEqual(['base.created']);
  });

  it('new records continue after the imported ones', async () => {
    const tickets = await db.kysely
      .selectFrom('meta.tables')
      .select('id')
      .where('base_id', '=', result.base_id)
      .where('name', '=', 'Tickets')
      .executeTakeFirstOrThrow();
    const created = await fx.call('owner', 'POST', `/tables/${tickets.id}/records`, {
      records: [{ fields: { 'Tiêu đề': 't4' } }],
    });
    expect(created.statusCode, created.body).toBe(201);
    const autos = await db.kysely
      .selectFrom('meta.tables')
      .select('db_table_name')
      .where('id', '=', tickets.id)
      .executeTakeFirstOrThrow();
    const { rows } = await sql<{
      auto: string;
    }>`SELECT max(__auto)::text AS auto FROM ${sql.table(`data.${autos.db_table_name}`)}`.execute(
      db.kysely,
    );
    expect(Number(rows[0]?.auto)).toBe(4);
  });

  describe('P126 — the base while it is imported; failures purge it', () => {
    const snapshot = () => leftovers(db, { storage: t.storageRoot, temp: tempRoot });

    async function startImport(): Promise<Id<'job'>> {
      const imported = await importAs('owner', targetWorkspace, packageBytes);
      expect(imported.statusCode, imported.body).toBe(202);
      return jobAcceptedSchema.parse(imported.json()).job_id;
    }

    /** Stops the next import after its first table; resolves with the hidden base. */
    function holdAfterFirstTable(): { reached: Promise<Id<'bse'>>; release: () => void } {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reach: (baseId: Id<'bse'>) => void = () => undefined;
      const reached = new Promise<Id<'bse'>>((resolve) => {
        reach = resolve;
      });
      nextTarget = (own) =>
        wrapTarget(own, {
          createTable: async (baseId, input) => {
            await own.createTable(baseId, input);
            reach(baseId);
            await gate;
          },
        });
      return { reached, release };
    }

    it('P126 the hidden base is 404 for the importer, a base admin and an org admin; in no list, trash or channel', async () => {
      const before = await snapshot();
      const hold = holdAfterFirstTable();
      const jobId = await startImport();
      const hidden = await hold.reached;
      try {
        for (const user of ['owner', 'u_admin', 'u_editor'] as const) {
          const response = await fx.call(user, 'GET', `/bases/${hidden}`);
          expect(response.statusCode, `${user}: ${response.body}`).toBe(404);
        }
        for (const query of ['', '?include_deleted=true']) {
          const list = await fx.call(
            'owner',
            'GET',
            `/workspaces/${targetWorkspace}/bases${query}`,
          );
          expect(list.statusCode, list.body).toBe(200);
          expect(
            list.json<{ items: { id: string }[] }>().items.map((base) => base.id),
          ).not.toContain(hidden);
        }
        expect((await fx.call('owner', 'POST', `/bases/${hidden}/restore`)).statusCode).toBe(404);
        const tables = await db.kysely
          .selectFrom('meta.tables')
          .select('id')
          .where('base_id', '=', hidden)
          .execute();
        for (const table of tables) {
          expect((await fx.call('owner', 'GET', `/tables/${table.id}/fields`)).statusCode).toBe(
            404,
          );
        }
        const url = await listen(t.app);
        const socket = await TestSocket.connect(url, {
          origin: TEST_PUBLIC_URL,
          cookie: await fx.cookie('owner'),
        });
        try {
          expect(await socket.subscribe(`base:${hidden}`)).toMatchObject({
            type: 'error',
            code: 'NOT_FOUND',
          });
        } finally {
          socket.ws.close();
        }
      } finally {
        hold.release();
      }
      const job = await jobOf(jobId);
      expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
      expect(baseImportResultSchema.parse(job.result).base_id).toBe(hidden);
      const after = await snapshot();
      expect(after['meta.bases']).toBe((before['meta.bases'] as number) + 1);
      expect(after['hidden bases']).toBe(0);
    });

    it('a failure after table 2 → failed INTERNAL; no base, data.* table, object or meta row left', async () => {
      const before = await snapshot();
      let created = 0;
      nextTarget = (own) =>
        wrapTarget(own, {
          createTable: async (baseId, input) => {
            await own.createTable(baseId, input);
            created += 1;
            if (created === 2) throw new Error('connection reset');
          },
        });
      const job = await jobOf(await startImport());
      expect(job).toMatchObject({ status: 'failed', error: { code: 'INTERNAL' } });
      expect(JSON.stringify(job.error)).not.toContain('connection reset');
      expect(created).toBe(2);
      expect(await snapshot()).toEqual(before);
    });

    it('a failure after the files are stored → their objects are deleted too', async () => {
      const before = await snapshot();
      let stored = 0;
      nextTarget = (own) =>
        wrapTarget(own, {
          storeFile: async (baseId, file, content) => {
            await own.storeFile(baseId, file, content);
            stored += 1;
          },
          load: () => Promise.reject(new Error('disk full')),
        });
      const job = await jobOf(await startImport());
      expect(job).toMatchObject({ status: 'failed', error: { code: 'INTERNAL' } });
      expect(stored).toBe(1);
      expect(await snapshot()).toEqual(before);
    });

    it('a job cancelled while it imports → purged, it stays cancelled', async () => {
      const before = await snapshot();
      const hold = holdAfterFirstTable();
      const jobId = await startImport();
      await hold.reached;
      await new JobsRepository(db).markCancelled(orgScope(fx.orgId), jobId);
      hold.release();
      const deadline = Date.now() + 30_000;
      while ((await snapshot())['hidden bases'] !== 0) {
        if (Date.now() > deadline) throw new Error('not purged');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect((await jobOf(jobId)).status).toBe('cancelled');
      expect(await snapshot()).toEqual(before);
    });

    it('P126 a worker that dies mid-job: the retry purges what it built, then the job fails', async () => {
      const before = await snapshot();
      const scope = orgScope(fx.orgId);
      const jobId = newId('job');
      const jobs = new JobsRepository(db);
      // What the attempt that died left: the row running, a hidden base with a
      // table and a stored file, the uploaded package.
      await jobs.create(scope, {
        id: jobId,
        type: BASE_IMPORT_JOB_TYPE,
        createdBy: fx.users.owner.id,
      });
      await db.kysely
        .updateTable('meta.jobs')
        .set({ status: 'running', started_at: new Date() })
        .where('id', '=', jobId)
        .execute();
      const hidden = await db.withTx((tx) =>
        createBaseRecord(
          db,
          tx,
          scope,
          {
            workspaceId: targetWorkspace,
            ownerId: fx.users.owner.id,
            name: 'Half',
            importJobId: jobId,
          },
          systemAuditContext(),
        ),
      );
      const tableId = newId('tbl');
      const filesId = newId('fld');
      await t.app.get(SchemaService).importTable(
        scope,
        { baseId: hidden.id, importJobId: jobId },
        {
          id: tableId,
          name: 'Half',
          description: null,
          position: 0,
          primary: {
            id: newId('fld'),
            name: 'Name',
            type: 'text',
            options: {},
            description: null,
            required: false,
            uniqueValues: false,
            position: 0,
          },
          fields: [
            {
              id: filesId,
              name: 'Files',
              type: 'attachment',
              options: {},
              description: null,
              required: false,
              uniqueValues: false,
              position: 1,
            },
          ],
        },
      );
      const file = await new AttachmentsRepository(db).create(scope, {
        baseId: hidden.id,
        tableId,
        fieldId: filesId,
        createdBy: fx.users.owner.id,
        filename: 'half.txt',
        mime: 'text/plain',
        size: 4,
      });
      await storage.put(file.object_key, Buffer.from('half'), { contentType: 'text/plain' });
      await storage.put(basePackageImportKey(fx.orgId, jobId), packageBytes, {
        contentType: 'application/zip',
      });
      await db.withTx((tx) =>
        enqueue(tx, 'base.import', {
          organization_id: fx.orgId,
          job_id: jobId,
          workspace_id: targetWorkspace,
        }),
      );
      const job = await jobOf(jobId);
      expect(job).toMatchObject({ status: 'failed', error: { code: 'INTERNAL' } });
      expect(await storage.head(file.object_key)).toBeNull();
      expect(await snapshot()).toEqual(before);
    });
  });
});
