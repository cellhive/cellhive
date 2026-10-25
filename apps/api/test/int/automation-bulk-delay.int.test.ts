import { newId, type Id } from '@cellhive/contracts';
import {
  AppError,
  AutomationRunEngine,
  BaseRoleMembersRepository,
  BaseRolesRepository,
  AutomationRunsRepository,
  AutomationRunStepsRepository,
  AutomationsRepository,
  automationWaitJobKey,
  createUpdateRecordsAction,
  defaultActionRegistry,
  isBulkEvent,
  NO_AUTOMATION_NOTIFICATIONS,
  orgScope,
  RecordMutationService,
  RecordQueryService,
  resolveMemberBaseAccess,
  toEventDocument,
  type AuditContext,
  type AutomationRunEngineOptions,
  type Db,
  type DeferrableJob,
  type JsonObject,
  type RecordAccessContext,
} from '@cellhive/server-core';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { buildRecordFixture, type FixtureUser, type RecordFixture } from './record-fixture.js';
import { startTestApp, TEST_PUBLIC_URL, type TestApp } from './support.js';

const MINUTE = 60_000;
const T0 = new Date('2026-10-05T03:00:00.000Z').getTime();

function jobOf(orgId: Id<'org'>, runId: Id<'run'>): DeferrableJob {
  return {
    task_identifier: 'automation.run',
    payload: { organization_id: orgId, run_id: runId },
    priority: 0,
    attempts: 1,
    max_attempts: 25,
    key: null,
    flags: null,
    queue_name: null,
  };
}

/**
 * BACKLOG T506 acceptance at the service level (`AutomationRunEngine`
 * called like the `automation.run` job, clock pinned — no real wait):
 * `update_records` counts first (10 001 matches over a limit of 10 000 →
 * `too_many_records`, nothing written), writes batches of ≤ 1 000 with
 * `batch_id = run_…` (bulk events with chained causation downstream),
 * resumes after the last committed batch when a batch fails, resolves
 * values of SPEC §11.4 inside its filter, stays within `run_as`'s record
 * rules and organization, `ANALYZE`s after large writes; `delay` parks the
 * run `waiting` (job scheduled, waiting not counted as running time), a
 * job arriving early is put back, the recheck skips the run when the
 * record no longer matches or was deleted, turning the automation off
 * cancels waiting runs, a waiting run keeps its definition snapshot.
 */
describe('update_records and delay (T506, service level)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let other: RecordFixture;
  let records: RecordMutationService;
  let query: RecordQueryService;
  let clock = T0;

  const F = (name: string) => fx.fld[name]?.id as Id<'fld'>;

  function engine(overrides: Partial<AutomationRunEngineOptions> = {}): AutomationRunEngine {
    return new AutomationRunEngine(db, {
      defaults: { timeZone: 'Asia/Ho_Chi_Minh', locale: 'vi' },
      query,
      actions: defaultActionRegistry({ records, query }),
      publicUrl: TEST_PUBLIC_URL,
      notifier: NO_AUTOMATION_NOTIFICATIONS,
      random: () => 0,
      now: () => new Date(clock),
      ...overrides,
    });
  }

  const execute = (runId: Id<'run'>, e: AutomationRunEngine = engine(), fixture = fx) =>
    e.execute(orgScope(fixture.orgId), runId, jobOf(fixture.orgId, runId));

  const accessCache = new Map<string, RecordAccessContext>();
  async function accessOf(user: FixtureUser, fixture = fx): Promise<RecordAccessContext> {
    const key = `${fixture.orgId}:${user}`;
    const cached = accessCache.get(key);
    if (cached !== undefined) return cached;
    const resolved = await resolveMemberBaseAccess(
      db,
      orgScope(fixture.orgId),
      { userId: fixture.users[user].id, baseId: fixture.baseId },
      { timeZone: 'UTC', locale: 'vi' },
    );
    if (resolved === undefined) throw new Error(`${user} has no access`);
    accessCache.set(key, resolved.record);
    return resolved.record;
  }

  function adminContext(fixture = fx): AuditContext {
    return {
      actor: { type: 'user', id: fixture.users.u_admin.id },
      via: null,
      batch_id: newId('req'),
      request_id: null,
      ip: null,
      user_agent: null,
    };
  }

  /** Orders created as u_admin, 1 000 per call; their ids in order. */
  async function seedOrders(
    rows: readonly Record<string, unknown>[],
    fixture = fx,
  ): Promise<Id<'rec'>[]> {
    const ids: Id<'rec'>[] = [];
    for (let start = 0; start < rows.length; start += 1_000) {
      await records.create(
        orgScope(fixture.orgId),
        fixture.orders.id,
        await accessOf('u_admin', fixture),
        {
          field_key_type: 'id',
          typecast: true,
          records: rows.slice(start, start + 1_000).map((fields) => ({ fields })),
        },
        adminContext(fixture),
        {
          readBack: false,
          onCreated: (_tx, created) => {
            ids.push(...created);
            return Promise.resolve();
          },
        },
      );
    }
    return ids;
  }

  /** Record ids in the order of the database (the `__id` order of the batches). */
  async function dbOrder(ids: readonly string[]): Promise<string[]> {
    const { rows } = await sql<{ id: string }>`
      SELECT id FROM unnest(${[...ids]}::text[]) AS id ORDER BY id
    `.execute(db.kysely);
    return rows.map((row) => row.id);
  }

  const titled = (title: string, count: number, extra: Record<string, unknown> = {}) =>
    Array.from({ length: count }, () => ({ [F('title')]: title, ...extra }));

  /** Orders titled `title` and their `amount`, as u_admin. */
  async function amountsOf(title: string, fixture = fx): Promise<Map<string, unknown>> {
    const result = await query.query(
      orgScope(fixture.orgId),
      fixture.orders.id,
      await accessOf('u_admin', fixture),
      {
        field_key_type: 'id',
        cell_format: 'json',
        filter: { field: fixture.fld.title?.id, operator: 'eq', value: title },
        fields: [fixture.fld.amount?.id as string],
        limit: 1_000,
      },
    );
    return new Map(
      result.records.map((record) => [record.id, record.fields[fixture.fld.amount?.id as string]]),
    );
  }

  /** An enabled automation (run as `runAs`, the creator) and one `queued` run for `recordId`. */
  async function queuedRun(
    actions: object[],
    recordId: Id<'rec'> | null,
    options: { runAs?: FixtureUser; fixture?: RecordFixture; automationId?: Id<'aut'> } = {},
  ): Promise<{ automationId: Id<'aut'>; runId: Id<'run'> }> {
    const fixture = options.fixture ?? fx;
    const scope = orgScope(fixture.orgId);
    const automationId = options.automationId ?? newId('aut');
    const definition = {
      trigger: { type: 'record.created', table_id: fixture.orders.id, skip_bulk: false },
      condition: null,
      actions,
    } as unknown as JsonObject;
    if ((await new AutomationsRepository(db).get(scope, automationId)) === undefined) {
      await new AutomationsRepository(db).insert(scope, {
        id: automationId,
        baseId: fixture.baseId,
        name: automationId,
        description: '',
        enabled: true,
        definition,
        triggerType: 'record.created',
        triggerTableId: fixture.orders.id,
        createdBy: fixture.users[options.runAs ?? 'u_admin'].id,
      });
    }
    const runId = newId('run');
    await new AutomationRunsRepository(db).insert(scope, {
      id: runId,
      automationId,
      automationVersion: 1,
      triggerEventId: null,
      triggerUnit: newId('evt'),
      status: 'queued',
      depth: 0,
      input: {
        automation_version: 1,
        definition,
        trigger: {
          event_id: null,
          event_created_at: null,
          type: 'record.created',
          table_id: fixture.orders.id,
          record_id: recordId,
          bulk: false,
          batch: null,
        },
      },
    });
    return { automationId, runId };
  }

  const run = (id: Id<'run'>, fixture = fx) =>
    new AutomationRunsRepository(db).get(orgScope(fixture.orgId), id);
  const steps = (id: Id<'run'>, fixture = fx) =>
    new AutomationRunStepsRepository(db).listByRun(orgScope(fixture.orgId), id);

  const updateMany = (
    filter: unknown,
    fields: Record<string, unknown>,
    limit?: number,
    id = 'act_many',
  ) => ({
    id,
    type: 'update_records',
    config: {
      table_id: fx.orders.id,
      filter,
      fields,
      ...(limit === undefined ? {} : { limit }),
    },
  });
  const titleIs = (title: string) => ({ field: F('title'), operator: 'eq', value: title });

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    fx = await buildRecordFixture(t, db);
    other = await buildRecordFixture(t, db);
    records = t.app.get(RecordMutationService);
    query = t.app.get(RecordQueryService);
  });

  afterAll(async () => {
    await t.close();
    await db.destroy();
    await database.drop();
  });

  // --- update_records -----------------------------------------------------------------

  it('counts first: 10 001 matches over a limit of 10 000 fail too_many_records, nothing written', async () => {
    const [trigger] = await seedOrders(titled('Limit-A', 10_001));
    const { runId } = await queuedRun(
      [updateMany(titleIs('Limit-A'), { [F('amount')]: { literal: 7 } }, 10_000)],
      trigger ?? null,
    );
    expect(await execute(runId)).toEqual({
      status: 'failed',
      code: 'too_many_records',
      step: 'act_many',
    });
    expect(await run(runId)).toMatchObject({
      status: 'failed',
      error: { code: 'too_many_records', step: 'act_many', params: { limit: 10_000 } },
    });
    const [step] = await steps(runId);
    expect(step).toMatchObject({ status: 'failed', attempt: 1, output: null });
    expect([...(await amountsOf('Limit-A')).values()].filter((value) => value === 7)).toEqual([]);
  }, 180_000);

  it('writes ≤ 1 000 per batch with batch_id = run_…: bulk events, causation one level deeper', async () => {
    const ids = await seedOrders(titled('Batch-B', 2_500));
    const { runId, automationId } = await queuedRun(
      [updateMany(titleIs('Batch-B'), { [F('amount')]: { literal: 11 } }, 5_000)],
      ids[0] ?? null,
    );
    expect(await execute(runId)).toEqual({ status: 'succeeded' });
    const [step] = await steps(runId);
    expect(step?.output).toEqual({
      matched: 2_500,
      updated: 2_500,
      batches: 3,
      last_record_id: (await dbOrder(ids)).at(-1),
      skipped_not_editable: 0,
      done: true,
    });
    const amounts = await amountsOf('Batch-B');
    expect([...amounts.values()].every((value) => value === 11)).toBe(true);

    const rows = await db.kysely
      .selectFrom('meta.events')
      .selectAll()
      .where('organization_id', '=', fx.orgId)
      .where('type', '=', 'record.updated')
      .where(sql<string>`payload->'batch'->>'id'`, '=', runId)
      .execute();
    expect(rows).toHaveLength(2_500);
    const documents = rows.map((row) => toEventDocument(row));
    const sizes = documents.map((doc) => doc.batch?.size).sort();
    expect(new Set(sizes)).toEqual(new Set([1_000, 500]));
    expect(sizes.filter((size) => size === 500)).toHaveLength(500);
    for (const doc of documents.slice(0, 20)) {
      // What `events.dispatch` sees: a bulk change of the run, one level deeper.
      expect(isBulkEvent(doc)).toBe(true);
      expect(doc.via).toEqual({ automation_id: automationId, run_id: runId });
      expect(doc.actor).toEqual({ type: 'automation', id: automationId });
      expect(doc.causation.depth).toBe(1);
      expect(doc.causation.automation_chain).toEqual([automationId]);
    }
    // Audit entries of the run share its batch id too.
    const { rows: audit } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM meta.audit_logs
       WHERE organization_id = ${fx.orgId} AND batch_id = ${runId} AND action = 'record.updated'
    `.execute(db.kysely);
    expect(audit[0]?.n).toBe(2_500);
  }, 180_000);

  it('a batch failing (worker dying in batch 3): the retry resumes after the committed batches', async () => {
    const ids = await seedOrders(titled('Kill-C', 7));
    let calls = 0;
    const flaky = new Proxy(records, {
      get(target, property, receiver) {
        if (property !== 'update') return Reflect.get(target, property, receiver) as unknown;
        return (...args: Parameters<RecordMutationService['update']>) => {
          calls += 1;
          if (calls === 3) {
            return Promise.reject(new AppError('INTERNAL', { detail: 'worker killed' }));
          }
          return target.update(...args);
        };
      },
    });
    const actions = new Map([
      ['update_records', createUpdateRecordsAction({ records: flaky, query, batchSize: 2 })],
    ]);
    const { runId } = await queuedRun(
      [updateMany(titleIs('Kill-C'), { [F('amount')]: { literal: 21 } })],
      ids[0] ?? null,
    );
    const first = await execute(runId, engine({ actions }));
    expect(first).toMatchObject({ status: 'retry_scheduled', step: 'act_many' });
    const [failed] = await steps(runId);
    const sorted = await dbOrder(ids);
    expect(failed).toMatchObject({
      status: 'failed',
      attempt: 1,
      output: { matched: 7, updated: 4, batches: 2, last_record_id: sorted[3] },
    });
    expect([...(await amountsOf('Kill-C')).values()].filter((value) => value === 21)).toHaveLength(
      4,
    );

    clock += MINUTE;
    expect(await execute(runId, engine({ actions }))).toEqual({ status: 'succeeded' });
    const [done] = await steps(runId);
    expect(done).toMatchObject({
      status: 'succeeded',
      attempt: 2,
      output: { matched: 7, updated: 7, batches: 4, last_record_id: sorted[6], done: true },
    });
    // Each record was written once: batches 1–2 were not written again.
    const { rows } = await sql<{ entity_id: string; n: number }>`
      SELECT entity_id, count(*)::int AS n FROM meta.events
       WHERE organization_id = ${fx.orgId} AND type = 'record.updated'
         AND payload->'batch'->>'id' = ${runId}
       GROUP BY entity_id
    `.execute(db.kysely);
    expect(rows).toHaveLength(7);
    expect(rows.every((row) => row.n === 1)).toBe(true);
    expect(calls).toBe(5);
  });

  it('resolves values of SPEC §11.4 inside the filter (a field of the trigger record)', async () => {
    const [trigger] = await seedOrders(titled('Ref-D', 1));
    await seedOrders([...titled('Ref-D', 2), ...titled('Ref-X', 2)]);
    const { runId } = await queuedRun(
      [
        updateMany(
          { field: F('title'), operator: 'eq', value: { field: F('title') } },
          { [F('amount')]: { literal: 31 } },
        ),
      ],
      trigger ?? null,
    );
    expect(await execute(runId)).toEqual({ status: 'succeeded' });
    expect([...(await amountsOf('Ref-D')).values()]).toEqual([31, 31, 31]);
    expect([...(await amountsOf('Ref-X')).values()]).toEqual([null, null]);
    expect((await steps(runId))[0]?.output).toMatchObject({ matched: 3, updated: 3 });
  });

  it('an empty filter value fails the step (invalid_value), nothing written', async () => {
    const [trigger] = await seedOrders(titled('Empty-D2', 1));
    const { runId } = await queuedRun(
      [
        updateMany(
          { field: F('amount'), operator: 'eq', value: { field: F('amount') } },
          { [F('amount')]: { literal: 1 } },
        ),
      ],
      trigger ?? null,
    );
    expect(await execute(runId)).toEqual({
      status: 'failed',
      code: 'invalid_value',
      step: 'act_many',
    });
    expect((await run(runId))?.error).toMatchObject({ params: { field: 'filter', path: 'value' } });
  });

  it('changes only the records run_as may edit (Sales: its own orders)', async () => {
    const mine = await seedOrders(titled('Perm-E', 2, { [F('owner')]: fx.users.u_sales1.id }));
    const theirs = await seedOrders(titled('Perm-E', 2, { [F('owner')]: fx.users.u_sales2.id }));
    const { runId } = await queuedRun(
      [updateMany(titleIs('Perm-E'), { [F('amount')]: { literal: 41 } })],
      mine[0] ?? null,
      { runAs: 'u_sales1' },
    );
    expect(await execute(runId)).toEqual({ status: 'succeeded' });
    const amounts = await amountsOf('Perm-E');
    expect(mine.map((id) => amounts.get(id))).toEqual([41, 41]);
    expect(theirs.map((id) => amounts.get(id))).toEqual([null, null]);
    expect((await steps(runId))[0]?.output).toMatchObject({
      matched: 2,
      updated: 2,
      skipped_not_editable: 0,
    });
  });

  it('counts the matching records run_as reads but may not edit (skipped_not_editable)', async () => {
    // u_sales2 also gets a role reading every order but editing only its own.
    const scope = orgScope(fx.orgId);
    const role = await new BaseRolesRepository(db).create(scope, {
      baseId: fx.baseId,
      name: 'Read all, edit own',
      kind: 'custom',
      config: {
        base_rule: { copy: false, download: false, share_link: false },
        tables: {
          [fx.orders.id]: {
            perm: 'edit',
            view_rule: { allow_edit: false, visible_views: null },
            record_rule: {
              operations: ['add'],
              edit_filter: {
                op: 'and',
                items: [
                  { field: F('owner'), operator: 'has_any_of', value: [{ $var: 'current_user' }] },
                ],
              },
              read_scope: 'all',
              read_filter: null,
            },
            field_rule: {
              mode: 'specify',
              fields: { [F('cost')]: 'no_perm', [F('status')]: 'read' },
              option_edit_fields: [],
              file_download_fields: [],
            },
          },
        },
        dashboards: {},
      },
    });
    await new BaseRoleMembersRepository(db).assign(scope, {
      baseId: fx.baseId,
      roleId: role.id,
      principalType: 'user',
      principalId: fx.users.u_sales2.id,
    });
    const mine = await seedOrders(titled('Perm-E2', 2, { [F('owner')]: fx.users.u_sales2.id }));
    const theirs = await seedOrders(titled('Perm-E2', 3, { [F('owner')]: fx.users.u_sales1.id }));
    const { runId } = await queuedRun(
      [updateMany(titleIs('Perm-E2'), { [F('amount')]: { literal: 42 } })],
      mine[0] ?? null,
      { runAs: 'u_sales2' },
    );
    expect(await execute(runId)).toEqual({ status: 'succeeded' });
    const amounts = await amountsOf('Perm-E2');
    expect(mine.map((id) => amounts.get(id))).toEqual([42, 42]);
    expect(theirs.map((id) => amounts.get(id))).toEqual([null, null, null]);
    expect((await steps(runId))[0]?.output).toMatchObject({
      matched: 2,
      updated: 2,
      skipped_not_editable: 3,
      done: true,
    });
  });

  it('a field run_as cannot write fails as permission_denied (table), nothing written', async () => {
    const mine = await seedOrders(titled('Perm-F', 1, { [F('owner')]: fx.users.u_sales1.id }));
    const { runId } = await queuedRun(
      [updateMany(titleIs('Perm-F'), { [F('cost')]: { literal: 1 } })],
      mine[0] ?? null,
      { runAs: 'u_sales1' },
    );
    expect(await execute(runId)).toEqual({
      status: 'failed',
      code: 'permission_denied',
      step: 'act_many',
    });
    expect((await run(runId))?.error).toMatchObject({ params: { scope: 'table' } });
  });

  it('never reaches another organization: a table of another org is not found for run_as', async () => {
    const [foreign] = await seedOrders([{ [other.fld.title?.id as string]: 'Tenant-G' }], other);
    const [trigger] = await seedOrders(titled('Tenant-G', 1));
    const { runId } = await queuedRun(
      [
        {
          id: 'act_many',
          type: 'update_records',
          config: {
            table_id: other.orders.id,
            filter: { field: other.fld.title?.id, operator: 'eq', value: 'Tenant-G' },
            fields: { [other.fld.amount?.id as string]: { literal: 51 } },
          },
        },
      ],
      trigger ?? null,
    );
    expect(await execute(runId)).toEqual({
      status: 'failed',
      code: 'permission_denied',
      step: 'act_many',
    });
    expect((await amountsOf('Tenant-G', other)).get(foreign as string)).toBeNull();
  });

  it('analyzes the table after a large write (threshold reached), best effort', async () => {
    const ids = await seedOrders(titled('Analyze-H', 3));
    const analyzed: string[] = [];
    const actions = new Map([
      [
        'update_records',
        createUpdateRecordsAction({
          records,
          query,
          batchSize: 2,
          analyzeAfter: 3,
          schema: {
            analyzeComputedTable: (_scope, tableId) => {
              analyzed.push(tableId);
              return Promise.resolve();
            },
          },
        }),
      ],
    ]);
    const { runId } = await queuedRun(
      [updateMany(titleIs('Analyze-H'), { [F('amount')]: { literal: 61 } })],
      ids[0] ?? null,
    );
    expect(await execute(runId, engine({ actions }))).toEqual({ status: 'succeeded' });
    expect(analyzed).toEqual([fx.orders.id]);
    expect((await steps(runId))[0]?.output).toMatchObject({ updated: 3, analyzed: true });
  });

  // --- delay ----------------------------------------------------------------------------

  const wait = (config: Record<string, unknown>) => ({
    id: 'act_wait',
    type: 'delay',
    config,
  });
  const setAmount = (amount: number) => ({
    id: 'act_after',
    type: 'update_record',
    config: { table_id: fx.orders.id, fields: { [F('amount')]: { literal: amount } } },
  });

  async function waitJob(runId: Id<'run'>) {
    const { rows } = await sql<{ run_at: Date; key: string | null }>`
      SELECT j.run_at, j.key FROM graphile_worker._private_jobs j
        JOIN graphile_worker._private_tasks k ON k.id = j.task_id
       WHERE k.identifier = 'automation.run' AND j.payload->>'run_id' = ${runId}
       ORDER BY j.id DESC LIMIT 1
    `.execute(db.kysely);
    return rows[0];
  }

  it('parks the run waiting without counting it as running time, then resumes at the end', async () => {
    const [record] = await seedOrders(titled('Wait-I', 1, { [F('status')]: 'Mới' }));
    const { runId } = await queuedRun(
      [
        wait({
          minutes: 60,
          recheck_condition: { field: F('status'), operator: 'is', value: 'Mới' },
        }),
        setAmount(71),
      ],
      record ?? null,
    );
    const start = clock;
    const until = new Date(start + 60 * MINUTE).toISOString();
    expect(await execute(runId)).toEqual({ status: 'waiting', step: 'act_wait', until });
    expect(await run(runId)).toMatchObject({ status: 'waiting', running_since: null, error: null });
    expect((await steps(runId)).map((step) => [step.action_id, step.status, step.output])).toEqual([
      ['act_wait', 'waiting', { until }],
    ]);
    expect(await waitJob(runId)).toEqual({
      run_at: new Date(until),
      key: automationWaitJobKey(runId),
    });
    // A waiting run holds no slot of the organization.
    const { rows: running } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM meta.automation_runs WHERE id = ${runId} AND status = 'running'
    `.execute(db.kysely);
    expect(running[0]?.n).toBe(0);

    // A job delivered early is put back for the end of the delay.
    clock = start + 30 * MINUTE;
    expect(await execute(runId)).toEqual({ status: 'waiting', step: 'act_wait', until });
    expect((await run(runId))?.status).toBe('waiting');

    clock = start + 61 * MINUTE;
    expect(await execute(runId)).toEqual({ status: 'succeeded' });
    expect((await steps(runId)).map((step) => [step.action_id, step.status, step.attempt])).toEqual(
      [
        ['act_wait', 'succeeded', 1],
        ['act_after', 'succeeded', 1],
      ],
    );
    expect((await steps(runId))[0]?.output).toEqual({
      until,
      resumed_at: new Date(clock).toISOString(),
      recheck: 'matched',
    });
    expect((await amountsOf('Wait-I')).get(record as string)).toBe(71);
    // 61 minutes went by; the run only ran for an instant (pinned clock).
    expect(Number((await run(runId))?.active_ms)).toBeLessThan(MINUTE);
  });

  it('the recheck no longer matching skips the run (SLA): the remaining steps do not run', async () => {
    const [record] = await seedOrders(titled('Sla-J', 1, { [F('status')]: 'Mới' }));
    const { runId, automationId } = await queuedRun(
      [
        wait({
          minutes: 240,
          recheck_condition: { field: F('status'), operator: 'is_not', value: 'Xong' },
        }),
        setAmount(81),
      ],
      record ?? null,
    );
    expect(await execute(runId)).toMatchObject({ status: 'waiting' });
    // Done before the deadline.
    await records.update(
      orgScope(fx.orgId),
      fx.orders.id,
      await accessOf('u_admin'),
      {
        field_key_type: 'id',
        typecast: true,
        records: [{ id: record as Id<'rec'>, fields: { [F('status')]: 'Xong' } }],
      },
      adminContext(),
    );
    clock += 241 * MINUTE;
    expect(await execute(runId)).toEqual({
      status: 'skipped',
      code: 'recheck_not_matched',
      step: 'act_wait',
    });
    expect(await run(runId)).toMatchObject({
      status: 'skipped',
      error: { code: 'recheck_not_matched', step: 'act_wait' },
    });
    expect((await run(runId))?.finished_at).not.toBeNull();
    expect((await steps(runId)).map((step) => [step.action_id, step.status])).toEqual([
      ['act_wait', 'skipped'],
    ]);
    expect((await steps(runId))[0]?.output).toMatchObject({ recheck: 'not_matched' });
    expect((await amountsOf('Sla-J')).get(record as string)).toBeNull();
    // Not a failure: no run event, the automation stays on.
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM meta.events WHERE entity_id = ${runId}
    `.execute(db.kysely);
    expect(rows[0]?.n).toBe(0);
    expect(
      (await new AutomationsRepository(db).get(orgScope(fx.orgId), automationId))?.enabled,
    ).toBe(true);
  });

  it('the trigger record deleted while waiting skips the run (record_deleted)', async () => {
    const [record] = await seedOrders(titled('Gone-K', 1));
    const { runId } = await queuedRun([wait({ minutes: 5 }), setAmount(91)], record ?? null);
    expect(await execute(runId)).toMatchObject({ status: 'waiting' });
    await records.delete(
      orgScope(fx.orgId),
      fx.orders.id,
      await accessOf('u_admin'),
      { ids: [record as Id<'rec'>] },
      adminContext(),
    );
    clock += 6 * MINUTE;
    expect(await execute(runId)).toEqual({
      status: 'skipped',
      code: 'record_deleted',
      step: 'act_wait',
    });
    expect((await run(runId))?.error).toEqual({
      code: 'record_deleted',
      step: 'act_wait',
      params: { state: 'trashed' },
    });
  });

  it('turning the automation off cancels its waiting runs; the resume job then does nothing', async () => {
    const [record] = await seedOrders(titled('Off-L', 1));
    const { runId, automationId } = await queuedRun(
      [wait({ minutes: 5 }), setAmount(101)],
      record ?? null,
    );
    expect(await execute(runId)).toMatchObject({ status: 'waiting' });
    const response = await fx.call('u_admin', 'POST', `/automations/${automationId}/disable`);
    expect(response.statusCode, response.body).toBe(200);
    expect(await run(runId)).toMatchObject({
      status: 'cancelled',
      error: { code: 'automation_disabled' },
    });
    expect((await steps(runId)).map((step) => step.status)).toEqual(['cancelled']);
    clock += 6 * MINUTE;
    expect(await execute(runId)).toEqual({ status: 'not_runnable' });
    expect((await amountsOf('Off-L')).get(record as string)).toBeNull();
  });

  it('deleting the automation cancels its waiting runs too', async () => {
    const [record] = await seedOrders(titled('Del-L2', 1));
    const { runId, automationId } = await queuedRun([wait({ minutes: 5 })], record ?? null);
    expect(await execute(runId)).toMatchObject({ status: 'waiting' });
    const response = await fx.call('u_admin', 'DELETE', `/automations/${automationId}`);
    expect(response.statusCode, response.body).toBe(204);
    expect(await run(runId)).toMatchObject({
      status: 'cancelled',
      error: { code: 'automation_deleted' },
    });
  });

  it('an automation found off when the run resumes cancels it (automation_disabled)', async () => {
    const [record] = await seedOrders(titled('Off-M', 1));
    const { runId, automationId } = await queuedRun(
      [wait({ minutes: 5 }), setAmount(111)],
      record ?? null,
    );
    expect(await execute(runId)).toMatchObject({ status: 'waiting' });
    await db.kysely
      .updateTable('meta.automations')
      .set({ enabled: false })
      .where('id', '=', automationId)
      .execute();
    clock += 6 * MINUTE;
    expect(await execute(runId)).toEqual({ status: 'cancelled', code: 'automation_disabled' });
    expect((await steps(runId)).map((step) => step.status)).toEqual(['cancelled']);
    expect((await amountsOf('Off-M')).get(record as string)).toBeNull();
  });

  it('a waiting run keeps the definition snapshot it started with', async () => {
    const [record] = await seedOrders(titled('Snap-N', 1));
    const { runId, automationId } = await queuedRun(
      [wait({ minutes: 5 }), setAmount(121)],
      record ?? null,
    );
    expect(await execute(runId)).toMatchObject({ status: 'waiting' });
    await db.kysely
      .updateTable('meta.automations')
      .set({
        definition: sql<JsonObject>`${JSON.stringify({
          trigger: { type: 'record.created', table_id: fx.orders.id, skip_bulk: false },
          condition: null,
          actions: [setAmount(999)],
        })}::jsonb`,
      })
      .where('id', '=', automationId)
      .execute();
    clock += 6 * MINUTE;
    expect(await execute(runId)).toEqual({ status: 'succeeded' });
    expect((await amountsOf('Snap-N')).get(record as string)).toBe(121);
  });

  it('until: waits until a resolved date, refuses one past 30 days, does not wait for a past one', async () => {
    const [record] = await seedOrders(titled('Until-O', 1));
    const later = new Date(clock + 2 * 60 * MINUTE).toISOString();
    const { runId: waits } = await queuedRun(
      [wait({ until: { literal: later } }), setAmount(131)],
      record ?? null,
    );
    expect(await execute(waits)).toEqual({ status: 'waiting', step: 'act_wait', until: later });

    const tooFar = new Date(clock + 31 * 24 * 60 * MINUTE).toISOString();
    const { runId: refused } = await queuedRun(
      [wait({ until: { literal: tooFar } })],
      record ?? null,
    );
    expect(await execute(refused)).toEqual({
      status: 'failed',
      code: 'invalid_value',
      step: 'act_wait',
    });
    expect((await run(refused))?.error).toMatchObject({ params: { field: 'until' } });

    const past = new Date(clock - MINUTE).toISOString();
    const { runId: passed } = await queuedRun(
      [wait({ until: { literal: past } }), setAmount(132)],
      record ?? null,
    );
    expect(await execute(passed)).toEqual({ status: 'succeeded' });
    expect((await amountsOf('Until-O')).get(record as string)).toBe(132);

    const { runId: empty } = await queuedRun([wait({ until: { literal: null } })], record ?? null);
    expect(await execute(empty)).toMatchObject({ status: 'failed', code: 'invalid_value' });
  });
});
