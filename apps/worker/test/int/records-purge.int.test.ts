import { newId, type Id } from '@cellhive/contracts';
import {
  AttachmentsRepository,
  BasesRepository,
  FieldsRepository,
  JobsRepository,
  orgScope,
  RecordMutationService,
  SchemaService,
  systemAuditContext,
  TablesRepository,
  type Db,
  type FieldRow,
  type RecordAccessContext,
  type TableRow,
} from '@cellhive/server-core';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createRecordsPurgeOrgTask,
  createRecordsPurgeTask,
  RECORDS_PURGE_JOB_TYPE,
} from '../../src/tasks/records-purge.js';

import {
  captureLogger,
  createMigratedDatabase,
  createTestDb,
  type TestDatabase,
} from './support.js';

import type { JobHelpers } from 'graphile-worker';

const ORG_A: Id<'org'> = 'org_RecordsPurgeOrgA';
const ORG_B: Id<'org'> = 'org_RecordsPurgeOrgB';
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date();

interface Tenant {
  readonly org: Id<'org'>;
  readonly user: Id<'usr'>;
  readonly baseId: Id<'bse'>;
}

/** Fake graphile-worker helpers: what `deferrableJob` reads. */
function helpersFor(payload: unknown): JobHelpers {
  return {
    job: {
      id: '1',
      task_identifier: 'records.purge_org',
      payload,
      priority: 0,
      attempts: 1,
      max_attempts: 5,
      key: null,
      flags: null,
      job_queue_id: null,
    },
    getQueueName: () => Promise.resolve(null),
  } as unknown as JobHelpers;
}

/**
 * `records.purge` / `records.purge_org` (T408): records trashed more than
 * 30 days ago are permanently deleted per organization, in batches, with
 * their links, children's parent and files, one summary audit entry per
 * batch and table; other organizations and recent trash are untouched; runs
 * are idempotent and resumable.
 */
describe('records.purge (T408)', () => {
  let database: TestDatabase;
  let db: Db;
  let schema: SchemaService;
  let records: RecordMutationService;
  let jobs: JobsRepository;
  let attachments: AttachmentsRepository;
  let a: Tenant;
  let b: Tenant;
  // Organization A: T (link to U, parent, files) and U.
  let tA: TableRow;
  let uA: TableRow;
  let link: FieldRow;
  let files: FieldRow;
  let tB: TableRow;
  const rec: Record<string, Id<'rec'>> = {};

  async function tenant(org: Id<'org'>): Promise<Tenant> {
    const user: Id<'usr'> = `usr_${org.slice(4)}`;
    const workspace: Id<'wsp'> = `wsp_${org.slice(4)}`;
    await db.withTx(async (tx) => {
      await tx
        .insertInto('meta.organizations')
        .values({ id: org, name: org, slug: org.toLowerCase() })
        .execute();
      await tx
        .insertInto('meta.users')
        .values({ id: user, email: `${org.toLowerCase()}@example.test`, display_name: 'U' })
        .execute();
      await tx
        .insertInto('meta.org_members')
        .values({ organization_id: org, user_id: user, role: 'owner' })
        .execute();
      await tx
        .insertInto('meta.workspaces')
        .values({ id: workspace, organization_id: org, name: 'W', slug: 'main' })
        .execute();
    });
    const base = await new BasesRepository(db).create(orgScope(org), {
      workspaceId: workspace,
      ownerId: user,
      name: 'B',
    });
    return { org, user, baseId: base.id };
  }

  /** Base admin on every table of the base (fields: edit). */
  async function adminAccess(t: Tenant, tables: readonly TableRow[]): Promise<RecordAccessContext> {
    const fieldsRepo = new FieldsRepository(db);
    const entries = await Promise.all(
      tables.map(async (table) => {
        const fields = await fieldsRepo.listByTable(orgScope(t.org), table.id);
        return [
          table.id,
          {
            perm: 'manage' as const,
            operations: ['add' as const, 'delete' as const],
            view_rule: { allow_edit: true, visible_views: null },
            read_scope: 'all' as const,
            fields: Object.fromEntries(fields.map((field) => [field.id, 'edit' as const])),
            option_edit_fields: [],
            file_download_fields: [],
          },
        ] as const;
      }),
    );
    return {
      baseId: t.baseId,
      resolved: {
        access: {
          role: null,
          is_admin: true,
          base_rule: { copy: true, download: true, share_link: true },
          tables: Object.fromEntries(entries),
          dashboards: {},
        },
        internal: {
          editFilters: Object.fromEntries(tables.map((table) => [table.id, null])),
          readFilters: Object.fromEntries(tables.map((table) => [table.id, null])),
        },
      },
      userId: t.user,
      groupMemberUserIds: [],
      timeZone: 'UTC',
      locale: 'en',
    } as unknown as RecordAccessContext;
  }

  const context = (t: Tenant) => ({
    ...systemAuditContext(),
    actor: { type: 'user' as const, id: t.user },
    batch_id: newId('req'),
  });

  async function create(
    t: Tenant,
    table: TableRow,
    access: RecordAccessContext,
    items: { name: string; fields?: Record<string, unknown>; parent_id?: Id<'rec'> }[],
  ): Promise<void> {
    const primary = (await new FieldsRepository(db).listByTable(orgScope(t.org), table.id)).find(
      (field) => field.is_primary,
    ) as FieldRow;
    const result = await records.create(
      orgScope(t.org),
      table.id,
      access,
      {
        field_key_type: 'id',
        records: items.map((item) => ({
          fields: { [primary.id]: item.name, ...item.fields },
          ...(item.parent_id === undefined ? {} : { parent_id: item.parent_id }),
        })),
      },
      context(t),
    );
    result.records.forEach((record, index) => {
      rec[items[index]?.name ?? ''] = record.id;
    });
  }

  async function trashedAgo(table: TableRow, name: string, days: number): Promise<void> {
    await sql`
      UPDATE ${sql.table(`data.${table.db_table_name}`)}
         SET __deleted_at = ${new Date(NOW.getTime() - days * DAY)}
       WHERE __id = ${rec[name] ?? ''}
    `.execute(db.kysely);
  }

  async function ids(table: TableRow): Promise<string[]> {
    const { rows } = await sql<{ id: string }>`
      SELECT __id AS id FROM ${sql.table(`data.${table.db_table_name}`)} ORDER BY __id
    `.execute(db.kysely);
    // Sorted in JS: the order of `ORDER BY __id` depends on the collation (mixed case ids).
    return rows.map((row) => row.id).sort();
  }

  async function purgeAudits(org: Id<'org'>) {
    return db.kysely
      .selectFrom('meta.audit_logs')
      .select(['table_id', 'entity_type', 'entity_id', 'batch_id', 'after', 'actor_type'])
      .where('organization_id', '=', org)
      .where('action', '=', 'record.purged')
      .orderBy('created_at')
      .execute();
  }

  function orgTask(batchSize?: number) {
    const captured = captureLogger();
    const task = createRecordsPurgeOrgTask({
      db,
      records,
      tables: new TablesRepository(db),
      jobs,
      logger: captured.logger,
      now: () => NOW,
      ...(batchSize === undefined ? {} : { batchSize }),
    });
    return {
      captured,
      run: (org: Id<'org'>, jobId: Id<'job'>) => {
        const payload = { organization_id: org, job_id: jobId };
        return task(payload, helpersFor(payload));
      },
    };
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    schema = new SchemaService(db, { maxFieldsPerTable: 500 });
    records = new RecordMutationService(db, { schema });
    jobs = new JobsRepository(db);
    attachments = new AttachmentsRepository(db);
    a = await tenant(ORG_A);
    b = await tenant(ORG_B);

    const audit = systemAuditContext();
    const scopeA = orgScope(ORG_A);
    ({ table: tA } = await schema.createTable(
      scopeA,
      { baseId: a.baseId, name: 'T', primaryFieldName: 'Name' },
      audit,
    ));
    ({ table: uA } = await schema.createTable(
      scopeA,
      { baseId: a.baseId, name: 'U', primaryFieldName: 'Name' },
      audit,
    ));
    link = await schema.addField(
      scopeA,
      tA.id,
      { name: 'u', type: 'link', options: { link_table: uA.id, bidirectional: true } },
      audit,
    );
    await schema.addField(scopeA, tA.id, { name: 'Parent', type: 'parent', options: {} }, audit);
    files = await schema.addField(
      scopeA,
      tA.id,
      { name: 'files', type: 'attachment', options: {} },
      audit,
    );
    ({ table: tB } = await schema.createTable(
      orgScope(ORG_B),
      { baseId: b.baseId, name: 'T', primaryFieldName: 'Name' },
      audit,
    ));

    const accessA = await adminAccess(a, [tA, uA]);
    await create(a, uA, accessA, [{ name: 'u1' }]);
    await create(a, tA, accessA, [
      { name: 'old1', fields: { [link.id]: [rec.u1] } },
      { name: 'old2' },
      { name: 'recent' },
    ]);
    await create(a, tA, accessA, [{ name: 'child', parent_id: rec.old2 as Id<'rec'> }]);
    const accessB = await adminAccess(b, [tB]);
    await create(b, tB, accessB, [{ name: 'b1' }, { name: 'b2' }, { name: 'b3' }]);

    // Trash: old2 with its branch, old1 and recent in A; everything in B.
    await records.delete(
      scopeA,
      tA.id,
      accessA,
      { ids: [rec.old2 as string], children: 'delete' },
      context(a),
    );
    await records.delete(
      scopeA,
      tA.id,
      accessA,
      { ids: [rec.old1 as string, rec.recent as string] },
      context(a),
    );
    await records.delete(
      orgScope(ORG_B),
      tB.id,
      accessB,
      { ids: [rec.b1, rec.b2, rec.b3] as string[] },
      context(b),
    );
    await trashedAgo(tA, 'old1', 31);
    await trashedAgo(tA, 'old2', 31);
    await trashedAgo(tA, 'child', 10);
    await trashedAgo(tA, 'recent', 29);
    for (const name of ['b1', 'b2', 'b3']) await trashedAgo(tB, name, 40);

    // A file of old1 shared with `recent` (copy, S4 #12).
    const file = await attachments.create(scopeA, {
      baseId: a.baseId,
      tableId: tA.id,
      fieldId: files.id,
      createdBy: a.user,
      filename: 'a.pdf',
      mime: 'application/pdf',
      size: 1,
    });
    await attachments.markReady(scopeA, file.id, { size: 1, sha256: 'c'.repeat(64) });
    await attachments.attach(scopeA, [file.id], rec.old1 as Id<'rec'>);
    const ready = await attachments.getById(scopeA, file.id);
    await attachments.copyTo(scopeA, ready as NonNullable<typeof ready>, {
      recordId: rec.recent as Id<'rec'>,
      createdBy: null,
    });
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('starts one job per organization with tables, once (idempotent fan-out)', async () => {
    const captured = captureLogger();
    const fanOut = createRecordsPurgeTask({ db, jobs, logger: captured.logger });
    await fanOut({}, {} as JobHelpers);
    await fanOut({}, {} as JobHelpers);
    expect(captured.lines.map((line) => [line.enqueued, line.skipped])).toEqual([
      [2, 0],
      [0, 2],
    ]);
    const rows = await db.kysely
      .selectFrom('meta.jobs')
      .select(['organization_id', 'status', 'created_by'])
      .where('type', '=', RECORDS_PURGE_JOB_TYPE)
      .orderBy('organization_id')
      .execute();
    expect(rows).toEqual([
      { organization_id: ORG_A, status: 'queued', created_by: null },
      { organization_id: ORG_B, status: 'queued', created_by: null },
    ]);
    const { rows: queued } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM graphile_worker.jobs WHERE task_identifier = 'records.purge_org'
    `.execute(db.kysely);
    expect(queued[0]?.n).toBe(2);
    // Tenant scoping of the lookups used by the job.
    const tables = new TablesRepository(db);
    // Sorted in JS on both sides: the database collation orders ids differently.
    expect([...(await tables.listIds(orgScope(ORG_A)))].sort()).toEqual([tA.id, uA.id].sort());
    expect(await tables.listIds(orgScope(ORG_B))).toEqual([tB.id]);
    const jobA = await jobs.findActive(orgScope(ORG_A), RECORDS_PURGE_JOB_TYPE);
    expect(jobA?.organization_id).toBe(ORG_A);
  });

  it('defers a second run of the same organization while one is running (ADR-18)', async () => {
    const running = await jobs.findActive(orgScope(ORG_A), RECORDS_PURGE_JOB_TYPE);
    const other = await jobs.create(orgScope(ORG_A), {
      type: RECORDS_PURGE_JOB_TYPE,
      createdBy: null,
    });
    await jobs.markRunning(orgScope(ORG_A), other.id);
    const task = orgTask();
    await task.run(ORG_A, running?.id as Id<'job'>);
    expect(task.captured.lines.at(-1)).toMatchObject({ state: 'deferred' });
    expect(await ids(tA)).toContain(rec.old1);
    await jobs.markCancelled(orgScope(ORG_A), other.id);
  });

  it('purges records trashed more than 30 days ago with links, children and files', async () => {
    const job = await jobs.findActive(orgScope(ORG_A), RECORDS_PURGE_JOB_TYPE);
    const task = orgTask();
    await task.run(ORG_A, job?.id as Id<'job'>);

    // old1 and old2 go; the recent record and the child trashed 10 days ago stay.
    expect(await ids(tA)).toEqual([rec.recent, rec.child].sort());
    expect(await ids(uA)).toEqual([rec.u1]);
    // The junction lost old1's link (both sides read the same rows).
    const { rows: links } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM ${sql.table(`data.${link.link_junction ?? ''}`)}
    `.execute(db.kysely);
    expect(links[0]?.n).toBe(0);
    // The child of the purged parent is a root (still in the trash).
    const { rows: child } = await sql<{ parent: string | null }>`
      SELECT __parent_id AS parent FROM ${sql.table(`data.${tA.db_table_name}`)}
       WHERE __id = ${rec.child ?? ''}
    `.execute(db.kysely);
    expect(child).toEqual([{ parent: null }]);
    // old1's file is handed to the cleanup; the copy of `recent` keeps the object.
    const files = await db.kysely
      .selectFrom('meta.attachments')
      .select(['record_id', 'record_purged_at'])
      .where('organization_id', '=', ORG_A)
      .orderBy('record_id')
      .execute();
    expect(files.map((row) => [row.record_id, row.record_purged_at !== null])).toEqual(
      [
        [rec.old1, true],
        [rec.recent, false],
      ].sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
    );
    // One summary audit entry for the table (ADR-23 §2), actor system, batch = job.
    const audits = await purgeAudits(ORG_A);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      table_id: tA.id,
      entity_type: 'table',
      entity_id: tA.id,
      batch_id: job?.id,
      actor_type: 'system',
    });
    expect(audits[0]?.after).toEqual({
      count: 2,
      record_ids: expect.arrayContaining([rec.old1, rec.old2]) as unknown,
    });
    const events = await db.kysely
      .selectFrom('meta.events')
      .select(['entity_type', 'entity_id', 'payload'])
      .where('organization_id', '=', ORG_A)
      .where('type', '=', 'record.purged')
      .execute();
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ data: { count: 2, reason: 'retention' } });
    // Earlier audit entries of the purged records are kept.
    const history = await db.kysely
      .selectFrom('meta.audit_logs')
      .select('action')
      .where('organization_id', '=', ORG_A)
      .where('entity_id', '=', rec.old1 as string)
      .execute();
    expect(history.map((row) => row.action).sort()).toEqual(['record.created', 'record.deleted']);
    expect(await jobs.getById(orgScope(ORG_A), job?.id as Id<'job'>)).toMatchObject({
      status: 'succeeded',
      result: { tables: 2, purged: 2, skipped_tables: 0 },
    });
    // Another organization is untouched.
    expect(await ids(tB)).toHaveLength(3);
  });

  it('is idempotent: a finished job is skipped, nothing is purged twice', async () => {
    const [job] = await db.kysely
      .selectFrom('meta.jobs')
      .select('id')
      .where('organization_id', '=', ORG_A)
      .where('type', '=', RECORDS_PURGE_JOB_TYPE)
      .where('status', '=', 'succeeded')
      .execute();
    const task = orgTask();
    await task.run(ORG_A, job?.id as Id<'job'>);
    expect(task.captured.lines.at(-1)).toMatchObject({ state: 'skip' });
    const again = await records.purgeExpired(orgScope(ORG_A), tA.id, {
      before: new Date(NOW.getTime() - 30 * DAY),
      auditContext: systemAuditContext(),
    });
    expect(again).toEqual({ purged: [], done: true });
    expect(await purgeAudits(ORG_A)).toHaveLength(1);
  });

  it('works in batches and resumes a running job (worker restart)', async () => {
    const job = await jobs.findActive(orgScope(ORG_B), RECORDS_PURGE_JOB_TYPE);
    // As if a previous attempt had started and crashed after one batch.
    await jobs.markRunning(orgScope(ORG_B), job?.id as Id<'job'>);
    const first = await records.purgeExpired(orgScope(ORG_B), tB.id, {
      before: new Date(NOW.getTime() - 30 * DAY),
      auditContext: systemAuditContext(job?.id ?? null),
      batchSize: 2,
    });
    expect(first.purged).toHaveLength(2);
    expect(first.done).toBe(false);
    const task = orgTask(2);
    await task.run(ORG_B, job?.id as Id<'job'>);
    expect(await ids(tB)).toEqual([]);
    const audits = await purgeAudits(ORG_B);
    expect(audits.map((row) => (row.after as { count: number }).count)).toEqual([2, 1]);
    expect(new Set(audits.map((row) => row.batch_id))).toEqual(new Set([job?.id]));
    expect(task.captured.lines.at(-1)).toMatchObject({
      msg: 'records.purge_org finished',
      resumed: true,
      purged: 1,
    });
    // Organization A saw nothing of it.
    expect(await purgeAudits(ORG_A)).toHaveLength(1);
  });
});
