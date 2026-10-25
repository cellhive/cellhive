import {
  automationSchema,
  newId,
  type AutomationDto,
  type Id,
  type RealtimeServerMessage,
} from '@cellhive/contracts';
import {
  AutomationRunsRepository,
  AutomationsRepository,
  orgScope,
  RunAsRevalidator,
  type Db,
  type JsonObject,
} from '@cellhive/server-core';
import { createWorker, type WorkerHandle } from '@cellhive/worker';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { closeSockets, listen, TestSocket } from './realtime-support.js';
import { buildRecordFixture, type FixtureUser, type RecordFixture } from './record-fixture.js';
import { captureLogger, startTestApp, TEST_PUBLIC_URL, type TestApp } from './support.js';

async function eventually<T>(
  probe: () => Promise<T | undefined | false>,
  label: string,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

interface AutomationState {
  readonly enabled: boolean;
  readonly disabled_reason: string | null;
  readonly run_as_user_id: string;
  readonly version: number;
}

/**
 * BACKLOG T507 (ADR-25 §5, CONTRACTS §5 P33) through the real API and
 * worker: a permission change queues `automation.revalidate_run_as` in its
 * transaction; the job turns off the automations whose `run_as` lost
 * access (`run_as_lost_access`), cancels their queued/waiting runs, writes
 * event + audit `automation.disabled` and notifies `run_as` + base
 * owner/admins (realtime); take over turns it back on. Also: a member
 * removed from the organization, an unrelated change (stays on), the run
 * engine's hook (a table lost at run time), a schema problem (not a
 * permission one: left alone), idempotency and batching. Fixture variant
 * of P29/P32/P33: the Sales role has `manage` on Orders.
 */
describe('run_as loses access (T507, P33)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let url: string;
  let fx: RecordFixture;
  let worker: WorkerHandle;
  let salesGroup: Id<'grp'>;
  let salesRole: Id<'rol'>;
  const sockets: TestSocket[] = [];

  const F = (name: string) => fx.fld[name]?.id as Id<'fld'>;
  const revalidator = () =>
    new RunAsRevalidator(db, { defaults: { timeZone: 'UTC', locale: 'en' } });

  /** An automation saved through the API by `user` (its `run_as`), enabled. */
  async function automationAs(user: FixtureUser, name: string): Promise<AutomationDto> {
    const response = await fx.call(user, 'POST', `/bases/${fx.baseId}/automations`, {
      name,
      enabled: true,
      definition: {
        trigger: { type: 'record.created', table_id: fx.orders.id },
        actions: [
          {
            id: 'act_1',
            type: 'update_record',
            config: { table_id: fx.orders.id, fields: { [F('amount')]: { literal: 1 } } },
          },
        ],
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    return automationSchema.parse(response.json());
  }

  /** An automation stored as is (`run_as` = `runAs`), enabled. */
  async function storedAutomation(
    definition: Record<string, unknown>,
    runAs: FixtureUser,
  ): Promise<Id<'aut'>> {
    const id = newId('aut');
    const trigger = definition['trigger'] as { type: string; table_id: Id<'tbl'> | null };
    await new AutomationsRepository(db).insert(orgScope(fx.orgId), {
      id,
      baseId: fx.baseId,
      name: id,
      description: '',
      enabled: true,
      definition: definition as JsonObject,
      triggerType: trigger.type,
      triggerTableId: trigger.table_id,
      createdBy: fx.users[runAs].id,
    });
    return id;
  }

  async function stateOf(id: Id<'aut'>): Promise<AutomationState> {
    const { rows } = await sql<AutomationState>`
      SELECT enabled, disabled_reason, run_as_user_id, version
        FROM meta.automations WHERE id = ${id}
    `.execute(db.kysely);
    if (rows[0] === undefined) throw new Error(`no automation ${id}`);
    return rows[0];
  }

  async function disabledOf(id: Id<'aut'>): Promise<AutomationState> {
    return eventually(async () => {
      const state = await stateOf(id);
      return state.enabled ? undefined : state;
    }, `automation ${id} turned off`);
  }

  async function pendingChecks(): Promise<number> {
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM graphile_worker.jobs
       WHERE task_identifier = 'automation.revalidate_run_as'
    `.execute(db.kysely);
    return rows[0]?.n ?? 0;
  }

  /** Every queued `run_as` check done. */
  async function checksDone(): Promise<void> {
    await eventually(async () => (await pendingChecks()) === 0, 'run_as checks done');
  }

  async function auditOf(id: Id<'aut'>, action: string) {
    const { rows } = await sql<{ actor_type: string; before: unknown; after: unknown }>`
      SELECT actor_type, before, after FROM meta.audit_logs
       WHERE entity_type = 'automation' AND entity_id = ${id} AND action = ${action}
       ORDER BY created_at
    `.execute(db.kysely);
    return rows;
  }

  async function notifiedUsers(id: Id<'aut'>): Promise<string[]> {
    const { rows } = await sql<{ user_id: string }>`
      SELECT user_id FROM meta.notifications
       WHERE type = 'automation.disabled' AND entity_id = ${id}
       ORDER BY user_id
    `.execute(db.kysely);
    return rows.map((row) => row.user_id).sort();
  }

  async function assignSales(): Promise<void> {
    const response = await fx.call('owner', 'PUT', `/bases/${fx.baseId}/role-assignments`, {
      principal_type: 'group',
      principal_id: salesGroup,
      role_id: salesRole,
    });
    expect(response.statusCode, response.body).toBe(200);
  }

  async function own(user: FixtureUser): Promise<TestSocket> {
    const socket = await TestSocket.connect(url, {
      origin: TEST_PUBLIC_URL,
      cookie: await fx.cookie(user),
    });
    sockets.push(socket);
    expect(await socket.subscribe(`user:${fx.users[user].id}`)).toMatchObject({
      type: 'subscribed',
    });
    return socket;
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    url = await listen(t.app);
    fx = await buildRecordFixture(t, db);
    const { rows: groups } = await sql<{ id: Id<'grp'> }>`
      SELECT id FROM meta.groups WHERE organization_id = ${fx.orgId} AND name = 'g_sales'
    `.execute(db.kysely);
    salesGroup = groups[0]?.id as Id<'grp'>;
    // CONTRACTS §5 role Sales, variant of P29/P32/P33: `manage` on Orders.
    const { rows: roles } = await sql<{ id: Id<'rol'> }>`
      UPDATE meta.base_roles
         SET config = jsonb_set(config, ${`{tables,${fx.orders.id},perm}`}::text[], '"manage"')
       WHERE organization_id = ${fx.orgId} AND base_id = ${fx.baseId} AND name = 'Sales'
       RETURNING id
    `.execute(db.kysely);
    salesRole = roles[0]?.id as Id<'rol'>;
    worker = await createWorker(t.config, { logger: captureLogger().logger, pollIntervalMs: 50 });
  });

  afterAll(async () => {
    await closeSockets(sockets);
    await worker.close();
    await t.close();
    await db.destroy();
    await database.drop();
  });

  it('P33: removing the role of g_sales turns the automation of u_sales1 off before its next run; take over turns it back on', async () => {
    const admin = await own('u_admin');
    const automation = await automationAs('u_sales1', 'P33');
    expect(automation).toMatchObject({ enabled: true, run_as: { id: fx.users.u_sales1.id } });
    // Runs not started yet (no job) and one waiting inside a `delay`.
    const runs = new AutomationRunsRepository(db);
    const queued = newId('run');
    const waiting = newId('run');
    for (const id of [queued, waiting]) {
      await runs.insert(orgScope(fx.orgId), {
        id,
        automationId: automation.id,
        automationVersion: automation.version,
        triggerEventId: null,
        triggerUnit: id,
        status: 'queued',
        depth: 0,
        input: {},
      });
    }
    await sql`UPDATE meta.automation_runs SET status = 'waiting' WHERE id = ${waiting}`.execute(
      db.kysely,
    );

    const removed = await fx.call('u_admin', 'DELETE', `/bases/${fx.baseId}/role-assignments`, {
      principal_type: 'group',
      principal_id: salesGroup,
    });
    expect(removed.statusCode, removed.body).toBe(204);
    // Queued with the change (same transaction), debounced.
    expect(await pendingChecks()).toBeGreaterThan(0);

    const notified = await admin.next(
      (message: RealtimeServerMessage) =>
        message.type === 'notification.created' &&
        message.notification_type === 'automation.disabled',
    );
    expect(notified).toMatchObject({ organization_id: fx.orgId, base_id: fx.baseId });
    expect(await disabledOf(automation.id)).toMatchObject({
      enabled: false,
      disabled_reason: 'run_as_lost_access',
      // `run_as` is kept until someone takes over.
      run_as_user_id: fx.users.u_sales1.id,
    });
    const { rows: ended } = await sql<{ id: string; status: string; error: unknown }>`
      SELECT id, status, error FROM meta.automation_runs WHERE automation_id = ${automation.id}
    `.execute(db.kysely);
    expect(ended).toHaveLength(2);
    for (const run of ended) {
      expect(run).toMatchObject({ status: 'cancelled', error: { code: 'automation_disabled' } });
    }
    expect(await auditOf(automation.id, 'automation.disabled')).toEqual([
      {
        actor_type: 'system',
        before: { enabled: true },
        after: { enabled: false, disabled_reason: 'run_as_lost_access', cause: 'no_base_access' },
      },
    ]);
    const { rows: events } = await sql<{ data: unknown }>`
      SELECT payload -> 'data' AS data FROM meta.events
       WHERE type = 'automation.disabled' AND entity_id = ${automation.id}
    `.execute(db.kysely);
    expect(events).toEqual([
      { data: { run_as_user_id: fx.users.u_sales1.id, disabled_reason: 'run_as_lost_access' } },
    ]);
    // Base owner + base admins (u_sales1 no longer sees the base: dropped at send time).
    await eventually(
      async () => (await notifiedUsers(automation.id)).length >= 2,
      'notifications written',
    );
    expect(await notifiedUsers(automation.id)).toEqual(
      [fx.users.owner.id, fx.users.u_admin.id].sort(),
    );

    // The job again (a retry): nothing more.
    const again = await revalidator().revalidate(orgScope(fx.orgId), {
      baseId: fx.baseId,
      after: null,
    });
    expect(again.disabled).toEqual([]);
    expect(await auditOf(automation.id, 'automation.disabled')).toHaveLength(1);

    // Take over by u_admin: run_as = u_admin, on again.
    const taken = await fx.call('u_admin', 'POST', `/automations/${automation.id}/take-over`, {
      enable: true,
    });
    expect(taken.statusCode, taken.body).toBe(200);
    expect(automationSchema.parse(taken.json())).toMatchObject({
      enabled: true,
      disabled_reason: null,
      run_as: { id: fx.users.u_admin.id },
    });
    await assignSales();
    await checksDone();
    expect(await stateOf(automation.id)).toMatchObject({ enabled: true });
  });

  it('an unrelated permission change leaves the automation on', async () => {
    const automation = await automationAs('u_sales1', 'Unrelated');
    const changed = await fx.call('owner', 'PUT', `/bases/${fx.baseId}/role-assignments`, {
      principal_type: 'user',
      principal_id: fx.users.u_out.id,
      role_id: salesRole,
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(await pendingChecks()).toBeGreaterThan(0);
    await checksDone();
    expect(await stateOf(automation.id)).toMatchObject({
      enabled: true,
      disabled_reason: null,
      version: automation.version,
    });
    expect(await auditOf(automation.id, 'automation.disabled')).toEqual([]);
  });

  it('a table lost at run time turns the automation off (definition no longer valid for run_as)', async () => {
    const id = await storedAutomation(
      {
        trigger: {
          type: 'record.updated',
          table_id: fx.orders.id,
          watch_fields: [F('title')],
          skip_bulk: false,
        },
        condition: null,
        actions: [
          {
            id: 'act_lost',
            type: 'create_record',
            config: {
              table_id: fx.customers.id,
              fields: { [F('customerName')]: { literal: 'x' } },
            },
          },
        ],
      },
      'u_sales1',
    );
    const created = await fx.call(
      'u_admin',
      'POST',
      `/tables/${fx.orders.id}/records?field_key_type=id`,
      { records: [{ fields: { [F('title')]: 'r1' } }] },
    );
    expect(created.statusCode, created.body).toBe(201);
    const recordId = created.json<{ records: { id: Id<'rec'> }[] }>().records[0]?.id as Id<'rec'>;
    const patched = await fx.call(
      'u_admin',
      'PATCH',
      `/tables/${fx.orders.id}/records/${recordId}?field_key_type=id`,
      { fields: { [F('title')]: 'r1 sửa' } },
    );
    expect(patched.statusCode, patched.body).toBe(200);
    expect(await disabledOf(id)).toMatchObject({ disabled_reason: 'run_as_lost_access' });
    const { rows: failed } = await sql<{ status: string; error: unknown }>`
      SELECT status, error FROM meta.automation_runs WHERE automation_id = ${id}
    `.execute(db.kysely);
    expect(failed).toEqual([
      {
        status: 'failed',
        error: expect.objectContaining({ code: 'permission_denied', step: 'act_lost' }) as unknown,
      },
    ]);
    const [entry] = await auditOf(id, 'automation.disabled');
    expect(entry?.after).toEqual({
      enabled: false,
      disabled_reason: 'run_as_lost_access',
      cause: 'definition_invalid',
      issues: [{ path: 'definition.actions[0].config.table_id', code: 'UNKNOWN_TABLE' }],
    });
    // Never a record value in the audit entry.
    expect(JSON.stringify(entry)).not.toContain('r1');
  });

  it('a schema problem is not a permission problem: left on', async () => {
    const id = await storedAutomation(
      {
        trigger: { type: 'record.created', table_id: fx.orders.id },
        condition: null,
        actions: [
          {
            id: 'act_1',
            type: 'update_record',
            config: {
              table_id: fx.orders.id,
              record_id: null,
              fields: { [newId('fld')]: { literal: 1 } },
            },
          },
        ],
      },
      'u_sales1',
    );
    const row = await new AutomationsRepository(db).get(orgScope(fx.orgId), id);
    expect(await revalidator().check(orgScope(fx.orgId), row as NonNullable<typeof row>)).toEqual({
      kind: 'skip',
      reason: 'schema_changed',
    });
    const result = await revalidator().revalidate(orgScope(fx.orgId), {
      baseId: fx.baseId,
      after: null,
    });
    expect(result.disabled).not.toContain(id);
    expect(await stateOf(id)).toMatchObject({ enabled: true });
    await sql`UPDATE meta.automations SET enabled = false WHERE id = ${id}`.execute(db.kysely);
  });

  it('a large organization is checked in batches that hand over to a new job', async () => {
    const ids = [
      await automationAs('u_admin', 'Batch 1'),
      await automationAs('u_admin', 'Batch 2'),
      await automationAs('u_admin', 'Batch 3'),
    ].map((dto) => dto.id);
    const result = await new RunAsRevalidator(db, {
      defaults: { timeZone: 'UTC', locale: 'en' },
      pageSize: 1,
      maxPerJob: 2,
    }).revalidate(orgScope(fx.orgId), { baseId: null, after: null });
    expect(result).toMatchObject({ checked: 2, disabled: [] });
    expect(result.continuedAfter).not.toBeNull();
    await checksDone();
    for (const id of ids) expect(await stateOf(id)).toMatchObject({ enabled: true });
  });

  it('removing u_sales1 from the organization turns its automation off', async () => {
    const automation = await automationAs('u_sales1', 'Leaver');
    const removed = await fx.call(
      'owner',
      'DELETE',
      `/orgs/${fx.orgId}/members/${fx.users.u_sales1.id}`,
      {},
    );
    expect(removed.statusCode, removed.body).toBe(204);
    expect(await disabledOf(automation.id)).toMatchObject({
      disabled_reason: 'run_as_lost_access',
    });
    const [entry] = await auditOf(automation.id, 'automation.disabled');
    expect(entry?.after).toMatchObject({ cause: 'no_base_access' });
    // Other automations of the base whose run_as kept access stay on.
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM meta.automations
       WHERE base_id = ${fx.baseId} AND enabled AND run_as_user_id <> ${fx.users.u_sales1.id}
    `.execute(db.kysely);
    expect(rows[0]?.n).toBeGreaterThan(0);
  });
});
