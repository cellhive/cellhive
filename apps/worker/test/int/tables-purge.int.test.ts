import { type Id } from '@cellhive/contracts';
import {
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
  type TableRow,
} from '@cellhive/server-core';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createTablesPurgeOrgTask,
  createTablesPurgeTask,
  TABLES_PURGE_JOB_TYPE,
} from '../../src/tasks/tables-purge.js';

import {
  captureLogger,
  createMigratedDatabase,
  createTestDb,
  type TestDatabase,
} from './support.js';

import type { JobHelpers } from 'graphile-worker';

const ORG_A: Id<'org'> = 'org_TablesPurgeOrgA0';
const ORG_B: Id<'org'> = 'org_TablesPurgeOrgB0';
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
      task_identifier: 'tables.purge_org',
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
 * `tables.purge` / `tables.purge_org` (T461): tables trashed more than 30
 * days ago are permanently deleted per organization (data table, junctions,
 * link fields of other tables put in the trash for good), one `table.purged`
 * audit entry each (actor system, batch = job); recent trash, live tables
 * and other organizations are untouched; runs are idempotent.
 */
describe('tables.purge (T461)', () => {
  let database: TestDatabase;
  let db: Db;
  let schema: SchemaService;
  let jobs: JobsRepository;
  let a: Tenant;
  let b: Tenant;
  let old: TableRow;
  let recent: TableRow;
  let live: TableRow;
  let link: FieldRow;
  let tB: TableRow;

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

  async function trashedAgo(t: Tenant, table: TableRow, days: number): Promise<void> {
    await schema.deleteTable(orgScope(t.org), table.id, systemAuditContext());
    await db.kysely
      .updateTable('meta.tables')
      .set({ deleted_at: new Date(NOW.getTime() - days * DAY) })
      .where('id', '=', table.id)
      .execute();
  }

  async function exists(name: string): Promise<boolean> {
    const { rows } = await sql<{ oid: string | null }>`
      SELECT to_regclass(${`data.${name}`})::text AS oid
    `.execute(db.kysely);
    return rows[0]?.oid != null;
  }

  async function purgeAudits(org: Id<'org'>) {
    return db.kysely
      .selectFrom('meta.audit_logs')
      .select(['entity_id', 'batch_id', 'actor_type', 'after'])
      .where('organization_id', '=', org)
      .where('action', '=', 'table.purged')
      .orderBy('created_at')
      .execute();
  }

  function orgTask() {
    const captured = captureLogger();
    const task = createTablesPurgeOrgTask({
      db,
      schema,
      tables: new TablesRepository(db),
      jobs,
      logger: captured.logger,
      now: () => NOW,
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
    jobs = new JobsRepository(db);
    a = await tenant(ORG_A);
    b = await tenant(ORG_B);
    const audit = systemAuditContext();
    const table = async (t: Tenant, name: string) =>
      (
        await schema.createTable(
          orgScope(t.org),
          { baseId: t.baseId, name, primaryFieldName: 'Name' },
          audit,
        )
      ).table;
    old = await table(a, 'Old');
    recent = await table(a, 'Recent');
    live = await table(a, 'Live');
    tB = await table(b, 'Old');
    link = await schema.addField(
      orgScope(ORG_A),
      live.id,
      { name: 'old', type: 'link', options: { link_table: old.id, bidirectional: true } },
      audit,
    );
    await trashedAgo(a, old, 31);
    await trashedAgo(a, recent, 29);
    await trashedAgo(b, tB, 40);
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('starts one job per organization with expired trash, once (idempotent fan-out)', async () => {
    const captured = captureLogger();
    const fanOut = createTablesPurgeTask({ db, jobs, logger: captured.logger, now: () => NOW });
    await fanOut({}, {} as JobHelpers);
    await fanOut({}, {} as JobHelpers);
    expect(captured.lines.map((line) => [line.enqueued, line.skipped])).toEqual([
      [2, 0],
      [0, 2],
    ]);
    const rows = await db.kysely
      .selectFrom('meta.jobs')
      .select(['organization_id', 'status', 'created_by'])
      .where('type', '=', TABLES_PURGE_JOB_TYPE)
      .orderBy('organization_id')
      .execute();
    expect(rows).toEqual([
      { organization_id: ORG_A, status: 'queued', created_by: null },
      { organization_id: ORG_B, status: 'queued', created_by: null },
    ]);
    const { rows: queued } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM graphile_worker.jobs WHERE task_identifier = 'tables.purge_org'
    `.execute(db.kysely);
    expect(queued[0]?.n).toBe(2);
  });

  it('defers a second run of the same organization while one is running (ADR-18)', async () => {
    const running = await jobs.findActive(orgScope(ORG_A), TABLES_PURGE_JOB_TYPE);
    const other = await jobs.create(orgScope(ORG_A), {
      type: TABLES_PURGE_JOB_TYPE,
      createdBy: null,
    });
    await jobs.markRunning(orgScope(ORG_A), other.id);
    const task = orgTask();
    await task.run(ORG_A, running?.id as Id<'job'>);
    expect(task.captured.lines.at(-1)).toMatchObject({ state: 'deferred' });
    expect(await exists(old.db_table_name)).toBe(true);
    await jobs.markCancelled(orgScope(ORG_A), other.id);
  });

  it('purges tables trashed more than 30 days ago with the link fields pointing at them', async () => {
    const job = await jobs.findActive(orgScope(ORG_A), TABLES_PURGE_JOB_TYPE);
    const task = orgTask();
    await task.run(ORG_A, job?.id as Id<'job'>);

    expect(await exists(old.db_table_name)).toBe(false);
    expect(await exists(link.link_junction ?? '')).toBe(false);
    expect(await exists(recent.db_table_name)).toBe(true);
    expect(await exists(live.db_table_name)).toBe(true);
    // The reverse field in Live is in the trash for good.
    const reverse = (
      await new FieldsRepository(db).listByTable(orgScope(ORG_A), live.id, {
        includeDeleted: true,
      })
    ).find((field) => field.id === link.id);
    expect(reverse?.deleted_at).not.toBeNull();
    expect(reverse?.link_table_purged_at).not.toBeNull();

    const audits = await purgeAudits(ORG_A);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      entity_id: old.id,
      batch_id: job?.id,
      actor_type: 'system',
      after: { name: 'Old', record_count: 0 },
    });
    const events = await db.kysely
      .selectFrom('meta.events')
      .select('payload')
      .where('organization_id', '=', ORG_A)
      .where('type', '=', 'table.purged')
      .execute();
    expect(events[0]?.payload).toMatchObject({ data: { reason: 'retention' } });
    expect(await jobs.getById(orgScope(ORG_A), job?.id as Id<'job'>)).toMatchObject({
      status: 'succeeded',
      result: { tables: 1, purged: 1, records: 0, skipped_tables: 0 },
    });
    // Another organization is untouched until its own job runs.
    expect(await exists(tB.db_table_name)).toBe(true);
  });

  it('is idempotent: a finished job is skipped, a new run finds nothing', async () => {
    const [done] = await db.kysely
      .selectFrom('meta.jobs')
      .select('id')
      .where('organization_id', '=', ORG_A)
      .where('type', '=', TABLES_PURGE_JOB_TYPE)
      .where('status', '=', 'succeeded')
      .execute();
    const task = orgTask();
    await task.run(ORG_A, done?.id as Id<'job'>);
    expect(task.captured.lines.at(-1)).toMatchObject({ state: 'skip' });
    const again = await jobs.create(orgScope(ORG_A), {
      type: TABLES_PURGE_JOB_TYPE,
      createdBy: null,
    });
    await task.run(ORG_A, again.id);
    expect(await jobs.getById(orgScope(ORG_A), again.id)).toMatchObject({
      status: 'succeeded',
      result: { tables: 0, purged: 0 },
    });
    expect(await purgeAudits(ORG_A)).toHaveLength(1);
    // The records purge no longer visits the purged table.
    expect(await new TablesRepository(db).listIds(orgScope(ORG_A))).not.toContain(old.id);
    const records = new RecordMutationService(db, { schema });
    expect(
      await records.purgeExpired(orgScope(ORG_A), old.id, {
        before: NOW,
        auditContext: systemAuditContext(),
      }),
    ).toEqual({ purged: [], done: true });
  });

  it('purges the other organization with its own job', async () => {
    const job = await jobs.findActive(orgScope(ORG_B), TABLES_PURGE_JOB_TYPE);
    await orgTask().run(ORG_B, job?.id as Id<'job'>);
    expect(await exists(tB.db_table_name)).toBe(false);
    expect(await purgeAudits(ORG_B)).toHaveLength(1);
    expect(await purgeAudits(ORG_A)).toHaveLength(1);
  });
});
