import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { newId, type Id } from '@cellhive/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { systemAuditContext } from '../../src/audit/index.js';
import { OrgMembersRepository, orgScope, type Db, type OrgScope } from '../../src/db/index.js';
import {
  abandonTableImport,
  cancelImportJob,
  IMPORT_FINISHED_FANOUT_PRIORITY,
  ImportsRepository,
  importUploadKey,
  notifyImportFinished,
  resolveMemberBaseAccess,
  runTableImport,
  settleCancelledImport,
  type ImportSpec,
  type TableImportDeps,
  type TableImportPayload,
} from '../../src/import/index.js';
import { JobsRepository } from '../../src/jobs/index.js';
import {
  NotificationFanout,
  type NotificationsFanoutPayload,
} from '../../src/notifications/index.js';
import { RecordMutationService, RecordQueryService } from '../../src/records/index.js';
import { SchemaService } from '../../src/schema/index.js';
import { LocalStorageDriver } from '../../src/storage/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { seedTenant, type SeededTenant } from '../support/tenant.js';

const ORG_A: Id<'org'> = 'org_ImpFinishOrgA001';
const ORG_B: Id<'org'> = 'org_ImpFinishOrgB001';
const ADMIN: Id<'usr'> = 'usr_ImpFinishAdmin01';
const DEFAULTS = { timeZone: 'Asia/Ho_Chi_Minh', locale: 'vi' };

/**
 * T548 (ADR-34 §4, CONTRACTS §19, §22.1): `import.finished` is queued for
 * the importer with each final state of a `table.import` job — in the
 * transaction of that state, `group_key = job_id`, the importer notified
 * although they are its actor — and never twice.
 */
describe('import.finished (T548, server-core)', () => {
  let database: TestDatabase;
  let db: Db;
  let a: SeededTenant;
  let b: SeededTenant;
  let scopeA: OrgScope;
  let storageRoot: string;
  let deps: TableImportDeps;
  let fanout: NotificationFanout;
  let jobs: JobsRepository;
  let imports: ImportsRepository;
  let schema: SchemaService;
  let tableId: Id<'tbl'>;
  let nameField: Id<'fld'>;
  let amountField: Id<'fld'>;

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    a = await seedTenant(db, ORG_A);
    b = await seedTenant(db, ORG_B);
    scopeA = orgScope(ORG_A);
    const members = new OrgMembersRepository(db);
    await db.kysely
      .insertInto('meta.users')
      .values({ id: ADMIN, email: 'imp-finish-admin@example.test', display_name: 'Admin' })
      .execute();
    await members.add(scopeA, a.userId, 'owner');
    await members.add(scopeA, ADMIN, 'admin');
    await members.add(orgScope(ORG_B), b.userId, 'owner');
    storageRoot = await mkdtemp(join(tmpdir(), 'cellhive-import-finished-'));
    schema = new SchemaService(db, { maxFieldsPerTable: 500 });
    const query = new RecordQueryService(db);
    jobs = new JobsRepository(db);
    imports = new ImportsRepository(db);
    deps = {
      db,
      schema,
      records: new RecordMutationService(db, { schema, query }),
      jobs,
      imports,
      storage: new LocalStorageDriver({
        root: storageRoot,
        publicUrl: 'https://ob.example.test',
        sessionSecret: 'x'.repeat(32),
      }),
      defaults: DEFAULTS,
      maxFieldsPerTable: 500,
      batchSize: 2,
    };
    fanout = new NotificationFanout(db, query, { emailEnabled: false, defaults: DEFAULTS });
    const created = await schema.createTable(
      scopeA,
      { baseId: a.baseId, name: 'Orders', primaryFieldName: 'Tên' },
      systemAuditContext(),
    );
    tableId = created.table.id;
    nameField = created.primaryField.id;
    amountField = (
      await schema.addField(
        scopeA,
        tableId,
        { name: 'Số', type: 'number', options: {} },
        systemAuditContext(),
      )
    ).id;
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
    await rm(storageRoot, { recursive: true, force: true });
  });

  /** `notifications.fanout` jobs queued about one import job. */
  async function queued(jobId: Id<'job'>): Promise<NotificationsFanoutPayload[]> {
    const { rows } = await sql<{ payload: NotificationsFanoutPayload }>`
      SELECT p.payload
        FROM graphile_worker.jobs JOIN graphile_worker._private_jobs p USING (id)
       WHERE jobs.task_identifier = 'notifications.fanout'
         AND p.payload->>'entity_id' = ${jobId}
    `.execute(db.kysely);
    return rows.map((row) => row.payload);
  }

  async function notificationsOf(jobId: Id<'job'>) {
    return db.kysely
      .selectFrom('meta.notifications')
      .select([
        'organization_id',
        'user_id',
        'type',
        'table_id',
        'actor_id',
        'group_key',
        'payload',
      ])
      .where('entity_type', '=', 'job')
      .where('entity_id', '=', jobId)
      .execute();
  }

  /** An uploaded file claimed by a `running` job, as the worker finds it. */
  async function runningImport(
    spec: ImportSpec,
    file: { readonly bytes: Buffer; readonly format?: 'csv' | 'xlsx'; readonly columns: string[] },
    rows: number,
  ): Promise<TableImportPayload> {
    const importId = newId('imp');
    await deps.storage.put(importUploadKey(ORG_A, importId), file.bytes, {
      contentType: 'text/csv',
    });
    await imports.create(scopeA, {
      id: importId,
      baseId: a.baseId,
      createdBy: a.userId,
      filename: 'data.csv',
      format: file.format ?? 'csv',
      size: file.bytes.length,
      options: {
        encoding: 'utf-8',
        delimiter: ',',
        sheet: null,
        header_row: true,
        columns: file.columns,
        total_rows: rows,
      },
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const job = await jobs.create(scopeA, { type: 'table.import', createdBy: a.userId });
    await imports.claim(scopeA, { id: importId, baseId: a.baseId, userId: a.userId }, job.id);
    await jobs.markRunning(scopeA, job.id);
    return {
      organization_id: ORG_A,
      job_id: job.id,
      import_id: importId,
      base_id: a.baseId,
      user_id: a.userId,
      spec,
    };
  }

  const csv = (lines: string[]) => Buffer.from(`${lines.join('\r\n')}\r\n`);
  const appendSpec = (): ImportSpec => ({
    mode: 'append',
    table_id: tableId,
    mapping: [
      { column: 0, field_id: nameField },
      { column: 1, field_id: amountField },
    ],
  });

  it('notifyImportFinished: the importer, about the job, keyed by it; only if the transaction commits', async () => {
    const jobId = newId('job');
    await expect(
      db.withTx(async (tx) => {
        await notifyImportFinished(tx, {
          organizationId: ORG_A,
          jobId,
          baseId: a.baseId,
          tableId,
          userId: a.userId,
          status: 'succeeded',
          created: 3,
          updated: 0,
          failedRows: 1,
        });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await queued(jobId)).toEqual([]);

    await db.withTx((tx) =>
      notifyImportFinished(tx, {
        organizationId: ORG_A,
        jobId,
        baseId: a.baseId,
        tableId,
        userId: a.userId,
        endedBy: ADMIN,
        status: 'cancelled',
        created: 3,
        updated: 0,
        failedRows: 1,
      }),
    );
    expect(await queued(jobId)).toEqual([
      {
        organization_id: ORG_A,
        type: 'import.finished',
        base_id: a.baseId,
        table_id: tableId,
        entity_type: 'job',
        entity_id: jobId,
        actor: { type: 'user', id: ADMIN },
        group_key: jobId,
        recipients: { user_ids: [a.userId], base_admins: false },
        requires: { record_id: null, field_ids: [] },
        skip_actor: false,
        data: { job_id: jobId, status: 'cancelled', created: 3, updated: 0, failed_rows: 1 },
      },
    ]);
    // Ahead of the `events.dispatch` backlog of the import (priority 0).
    const { rows } = await sql<{ priority: number }>`
      SELECT jobs.priority
        FROM graphile_worker.jobs JOIN graphile_worker._private_jobs p USING (id)
       WHERE jobs.task_identifier = 'notifications.fanout' AND p.payload->>'entity_id' = ${jobId}
    `.execute(db.kysely);
    expect(rows).toEqual([{ priority: IMPORT_FINISHED_FANOUT_PRIORITY }]);
    expect(IMPORT_FINISHED_FANOUT_PRIORITY).toBeLessThan(0);
  });

  it('refuses data outside the catalogue schema (nothing queued)', async () => {
    const jobId = newId('job');
    await expect(
      db.withTx((tx) =>
        notifyImportFinished(tx, {
          organizationId: ORG_A,
          jobId,
          baseId: a.baseId,
          tableId,
          userId: a.userId,
          status: 'succeeded',
          created: -1,
          updated: 0,
          failedRows: 0,
        }),
      ),
    ).rejects.toThrow();
    expect(await queued(jobId)).toEqual([]);
  });

  it('a succeeded import notifies its importer once with its counts, even when the fan-out runs again', async () => {
    const lines = ['Tên,Số', 'A,1', 'B,abc', 'C,3', 'D,4', 'E,5'];
    const payload = await runningImport(
      appendSpec(),
      { bytes: csv(lines), columns: ['Tên', 'Số'] },
      5,
    );
    const outcome = await runTableImport(deps, payload);
    expect(outcome).toMatchObject({ status: 'succeeded', imported: 4, failed: 1 });
    const notices = await queued(payload.job_id);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      type: 'import.finished',
      table_id: tableId,
      actor: { type: 'user', id: a.userId },
      skip_actor: false,
      recipients: { user_ids: [a.userId], base_admins: false },
      data: { job_id: payload.job_id, status: 'succeeded', created: 4, updated: 0, failed_rows: 1 },
    });
    // The fan-out job may run twice (retry): one notification.
    const first = await fanout.run(notices[0] as NotificationsFanoutPayload);
    const again = await fanout.run(notices[0] as NotificationsFanoutPayload);
    expect(first.written).toEqual([expect.objectContaining({ userId: a.userId, inApp: true })]);
    expect(first.skipped).toEqual([]);
    expect(again.written).toEqual([expect.objectContaining({ userId: a.userId, id: null })]);
    expect(await notificationsOf(payload.job_id)).toEqual([
      {
        organization_id: ORG_A,
        user_id: a.userId,
        type: 'import.finished',
        table_id: tableId,
        actor_id: a.userId,
        group_key: payload.job_id,
        payload: {
          job_id: payload.job_id,
          status: 'succeeded',
          created: 4,
          updated: 0,
          failed_rows: 1,
        },
      },
    ]);
    // Running the job again (a retried task) changes nothing.
    expect(await runTableImport(deps, payload)).toMatchObject({ status: 'failed' });
    expect(await queued(payload.job_id)).toHaveLength(1);
    expect((await jobs.getById(scopeA, payload.job_id))?.status).toBe('succeeded');
  });

  it('a broken file fails the job: import.finished `failed`, without the trashed new table', async () => {
    const payload = await runningImport(
      {
        mode: 'create_table',
        table: {
          name: 'Broken',
          columns: [
            { column: 0, name: 'Tên', type: 'text' },
            { column: 1, name: 'Số', type: 'number' },
          ],
        },
      },
      {
        bytes: Buffer.from('PK\u0003\u0004 not really a zip'),
        format: 'xlsx',
        columns: ['Tên', 'Số'],
      },
      1,
    );
    const outcome = await runTableImport(deps, payload);
    expect(outcome).toMatchObject({
      status: 'failed',
      code: 'VALIDATION_FAILED',
      tableTrashed: true,
    });
    const notices = await queued(payload.job_id);
    expect(notices).toEqual([
      expect.objectContaining({
        table_id: null,
        base_id: a.baseId,
        data: { job_id: payload.job_id, status: 'failed', created: 0, updated: 0, failed_rows: 0 },
      }),
    ]);
    // No table to read: the importer only needs the base.
    const result = await fanout.run(notices[0] as NotificationsFanoutPayload);
    expect(result.written).toEqual([expect.objectContaining({ userId: a.userId, inApp: true })]);
  });

  it('a job cancelled while it runs is notified by the run, with what it wrote', async () => {
    const lines = ['Tên,Số', 'A,1', 'B,2', 'C,3', 'D,4'];
    const payload = await runningImport(
      appendSpec(),
      { bytes: csv(lines), columns: ['Tên', 'Số'] },
      4,
    );
    // `POST …/cancel` right after the first batch (2 rows) is written.
    const cancelling: TableImportDeps['jobs'] = {
      getById: (scope, id) => jobs.getById(scope, id),
      markSucceeded: (scope, id, result) => jobs.markSucceeded(scope, id, result),
      markFailed: (scope, id, problem) => jobs.markFailed(scope, id, problem),
      setProgress: async (scope, id, progress) => {
        const row = await jobs.setProgress(scope, id, progress);
        await jobs.markCancelled(scopeA, id);
        return row;
      },
    };
    const outcome = await runTableImport({ ...deps, jobs: cancelling }, payload);
    expect(outcome).toMatchObject({ status: 'cancelled', imported: 2 });
    expect(await queued(payload.job_id)).toEqual([
      expect.objectContaining({
        table_id: tableId,
        data: {
          job_id: payload.job_id,
          status: 'cancelled',
          created: 2,
          updated: 0,
          failed_rows: 0,
        },
      }),
    ]);
  });

  it('cancelImportJob: a queued job is notified there; a running one is left to its run', async () => {
    const queuedJob = await jobs.create(scopeA, { type: 'table.import', createdBy: a.userId });
    const cancelled = await cancelImportJob(db, jobs, {
      organizationId: ORG_A,
      jobId: queuedJob.id,
      baseId: a.baseId,
      cancelledBy: ADMIN,
    });
    expect(cancelled?.status).toBe('cancelled');
    expect(await queued(queuedJob.id)).toEqual([
      expect.objectContaining({
        table_id: null,
        actor: { type: 'user', id: ADMIN },
        recipients: { user_ids: [a.userId], base_admins: false },
        data: { job_id: queuedJob.id, status: 'cancelled', created: 0, updated: 0, failed_rows: 0 },
      }),
    ]);
    // Final: unchanged, nothing more.
    expect(
      await cancelImportJob(db, jobs, {
        organizationId: ORG_A,
        jobId: queuedJob.id,
        baseId: a.baseId,
        cancelledBy: a.userId,
      }),
    ).toBeUndefined();
    expect(await queued(queuedJob.id)).toHaveLength(1);

    const running = await jobs.create(scopeA, { type: 'table.import', createdBy: a.userId });
    await jobs.markRunning(scopeA, running.id);
    expect(
      (
        await cancelImportJob(db, jobs, {
          organizationId: ORG_A,
          jobId: running.id,
          baseId: a.baseId,
          cancelledBy: a.userId,
        })
      )?.status,
    ).toBe('cancelled');
    expect(await queued(running.id)).toEqual([]);

    // Another type of job, or a job of another organization: untouched.
    const other = await jobs.create(scopeA, { type: 'base.export', createdBy: a.userId });
    expect(
      await cancelImportJob(db, jobs, {
        organizationId: ORG_A,
        jobId: other.id,
        baseId: a.baseId,
        cancelledBy: a.userId,
      }),
    ).toBeUndefined();
    expect((await jobs.getById(scopeA, other.id))?.status).toBe('queued');
    const foreign = await jobs.create(orgScope(ORG_B), {
      type: 'table.import',
      createdBy: b.userId,
    });
    expect(
      await cancelImportJob(db, jobs, {
        organizationId: ORG_A,
        jobId: foreign.id,
        baseId: a.baseId,
        cancelledBy: a.userId,
      }),
    ).toBeUndefined();
    expect((await jobs.getById(orgScope(ORG_B), foreign.id))?.status).toBe('queued');
    expect(await queued(foreign.id)).toEqual([]);
  });

  it('JobsRepository.lockById: own organization only, inside a transaction', async () => {
    const job = await jobs.create(scopeA, { type: 'table.import', createdBy: a.userId });
    await expect(jobs.lockById(scopeA, job.id)).rejects.toThrow(TypeError);
    await db.withTx(async (tx) => {
      expect((await jobs.lockById(orgScope(ORG_A, tx), job.id))?.id).toBe(job.id);
      expect(await jobs.lockById(orgScope(ORG_B, tx), job.id)).toBeUndefined();
    });
  });

  it('an interrupted run fails with import.finished counting what it wrote (audit), once', async () => {
    const payload = await runningImport(
      appendSpec(),
      { bytes: csv(['Tên,Số', 'A,1']), columns: ['Tên', 'Số'] },
      1,
    );
    // Two records written by the run (as it writes them) before the worker stopped.
    const access = await resolveMemberBaseAccess(
      db,
      scopeA,
      { userId: a.userId, baseId: a.baseId },
      DEFAULTS,
    );
    if (access === undefined) throw new Error('the importer reads the base');
    await deps.records.create(
      scopeA,
      tableId,
      access.record,
      {
        field_key_type: 'id',
        records: [{ fields: { [nameField]: 'X' } }, { fields: { [nameField]: 'Y' } }],
      },
      {
        actor: { type: 'user', id: a.userId },
        via: { import_job_id: payload.job_id },
        batch_id: payload.job_id,
        request_id: null,
        ip: null,
        user_agent: null,
      },
      { readBack: false },
    );
    expect(await abandonTableImport(deps, payload)).toEqual({ tableTrashed: false });
    expect((await jobs.getById(scopeA, payload.job_id))?.status).toBe('failed');
    expect(await queued(payload.job_id)).toEqual([
      expect.objectContaining({
        table_id: tableId,
        data: {
          job_id: payload.job_id,
          status: 'failed',
          created: 2,
          updated: 0,
          failed_rows: 0,
        },
      }),
    ]);
    // Found again (another restart): already failed, nothing more.
    await abandonTableImport(deps, payload);
    expect(await queued(payload.job_id)).toHaveLength(1);
  });

  it('settleCancelledImport: a job cancelled while it ran, found again, trashes its table and notifies once', async () => {
    const payload = await runningImport(
      {
        mode: 'create_table',
        table: { name: 'Half done', columns: [{ column: 0, name: 'Tên', type: 'text' }] },
      },
      { bytes: csv(['Tên', 'A']), columns: ['Tên'] },
      1,
    );
    // The run made its table, then the worker stopped; the job was cancelled meanwhile.
    const created = await schema.createTable(
      scopeA,
      { baseId: a.baseId, name: 'Half done', primaryFieldName: 'Tên' },
      systemAuditContext(),
    );
    await imports.mergeOptions(scopeA, payload.import_id, { created_table_id: created.table.id });
    await jobs.markCancelled(scopeA, payload.job_id);

    expect(await settleCancelledImport(deps, payload)).toEqual({
      settled: true,
      tableTrashed: true,
    });
    const notices = await queued(payload.job_id);
    expect(notices).toEqual([
      expect.objectContaining({
        table_id: null,
        data: {
          job_id: payload.job_id,
          status: 'cancelled',
          created: 0,
          updated: 0,
          failed_rows: 0,
        },
      }),
    ]);
    expect(
      await db.kysely
        .selectFrom('meta.tables')
        .select('deleted_at')
        .where('id', '=', created.table.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ deleted_at: expect.any(Date) as unknown });
    // Settled again (another retry): the fan-out writes one notification only.
    await settleCancelledImport(deps, payload);
    const all = await queued(payload.job_id);
    for (const notice of all) await fanout.run(notice);
    expect(await notificationsOf(payload.job_id)).toHaveLength(1);

    // A job cancelled before it started was notified by `POST …/cancel`: nothing here.
    const never = await jobs.create(scopeA, { type: 'table.import', createdBy: a.userId });
    await jobs.markCancelled(scopeA, never.id);
    expect(await settleCancelledImport(deps, { ...payload, job_id: never.id })).toEqual({
      settled: false,
      tableTrashed: false,
    });
    expect(await queued(never.id)).toEqual([]);
  });

  it('a recipient who left the organization gets nothing', async () => {
    const jobId = newId('job');
    await db.withTx((tx) =>
      notifyImportFinished(tx, {
        organizationId: ORG_A,
        jobId,
        baseId: a.baseId,
        tableId,
        userId: b.userId,
        status: 'succeeded',
        created: 1,
        updated: 0,
        failedRows: 0,
      }),
    );
    const [notice] = await queued(jobId);
    const result = await fanout.run(notice as NotificationsFanoutPayload);
    expect(result.written).toEqual([]);
    expect(result.skipped).toEqual([{ userId: b.userId, reason: 'cannot_read_base' }]);
    expect(await notificationsOf(jobId)).toEqual([]);
  });
});
