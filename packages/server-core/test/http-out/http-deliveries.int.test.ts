import { Buffer } from 'node:buffer';

import { newId, type Id } from '@cellhive/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AutomationRunsRepository } from '../../src/automation/repository/automation-runs.repository.js';
import { AutomationsRepository } from '../../src/automation/repository/automations.repository.js';
import {
  measureHttpDeliveryBacklog,
  orgScope,
  withTxScope,
  type Db,
  type JsonObject,
} from '../../src/db/index.js';
import {
  HttpDeliveriesRepository,
  HttpOutbox,
  httpDeliverJobKey,
  openDeliveryRequest,
  deriveDeliveryKey,
} from '../../src/http-out/index.js';
import { purgeExpiredOperationalRows } from '../../src/jobs/index.js';
import { OutboundHttpError } from '../../src/net/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { seedTenant, type SeededTenant } from '../support/tenant.js';

const ORG_A = 'org_HttpDelivOrgA001' as Id<'org'>;
const ORG_B = 'org_HttpDelivOrgB001' as Id<'org'>;
const MASTER = Buffer.alloc(32, 3);

const REQUEST = {
  method: 'POST' as const,
  url: 'https://hooks.example.com/in?token=canary',
  headers: [['content-type', 'application/json']] as [string, string][],
  body: '{"a":1}',
  authHeaderName: null,
  causation: null,
};

/**
 * `meta.http_deliveries` (BACKLOG T605, migration 0044): phase 1 of the
 * outbox (idempotent insert + job), the lease of phase 2 (`SKIP LOCKED`,
 * early, live and expired leases, fencing by attempt), cancellation by run,
 * tenant isolation, the request erased once final, the 24-hour retention of
 * `test` rows and the backlog gauge.
 */
describe('HTTP deliveries repository and outbox (T605)', () => {
  let database: TestDatabase;
  let db: Db;
  let a: SeededTenant;
  let b: SeededTenant;
  const repo = () => new HttpDeliveriesRepository(db);
  const outbox = () => new HttpOutbox(db, { masterKey: MASTER });

  async function runOf(
    tenant: SeededTenant,
  ): Promise<{ automationId: Id<'aut'>; runId: Id<'run'> }> {
    const scope = orgScope(tenant.orgId);
    const definition = {
      trigger: { type: 'schedule', cron: '0 8 * * *', timezone: null },
      condition: null,
      actions: [],
    } as unknown as JsonObject;
    const automationId = newId('aut');
    await new AutomationsRepository(db).insert(scope, {
      id: automationId,
      baseId: tenant.baseId,
      name: 'HTTP',
      description: '',
      enabled: true,
      definition,
      triggerType: 'schedule',
      triggerTableId: null,
      createdBy: tenant.userId,
    });
    const runId = newId('run');
    await new AutomationRunsRepository(db).insert(scope, {
      id: runId,
      automationId,
      automationVersion: 1,
      triggerEventId: null,
      triggerUnit: newId('evt'),
      status: 'queued',
      depth: 0,
      input: { automation_version: 1, definition, trigger: {} },
    });
    return { automationId, runId };
  }

  async function enqueueAction(tenant: SeededTenant, key = newId('evt')) {
    const { automationId, runId } = await runOf(tenant);
    const result = await db.withTx((tx) =>
      outbox().enqueue(tx, orgScope(tenant.orgId), {
        kind: 'action',
        automationId,
        runId,
        actionId: 'act_http',
        idempotencyKey: `${automationId}:${key}:act_http`,
        request: REQUEST,
      }),
    );
    return { ...result, automationId, runId };
  }

  const jobsOf = async (deliveryId: Id<'hdl'>) =>
    (
      await sql<{ key: string | null; task: string; run_at: Date }>`
        SELECT j.key, j.task_identifier AS task, j.run_at
          FROM graphile_worker.jobs j JOIN graphile_worker._private_jobs p USING (id)
         WHERE p.payload->>'delivery_id' = ${deliveryId}
      `.execute(db.kysely)
    ).rows;

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    a = await seedTenant(db, ORG_A);
    b = await seedTenant(db, ORG_B);
    for (const tenant of [a, b]) {
      await db.kysely
        .insertInto('meta.org_members')
        .values({ organization_id: tenant.orgId, user_id: tenant.userId, role: 'owner' })
        .onConflict((oc) => oc.doNothing())
        .execute();
    }
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('phase 1: a pending row with the sealed request, the host in clear and one keyed job', async () => {
    const { row, created } = await enqueueAction(a);
    expect(created).toBe(true);
    expect(row).toMatchObject({
      status: 'pending',
      attempts: 0,
      kind: 'action',
      method: 'POST',
      target_host: 'hooks.example.com',
      message_id: row.id,
    });
    expect(row.request_enc).not.toContain('canary');
    expect(openDeliveryRequest(deriveDeliveryKey(MASTER), row.request_enc ?? '')).toMatchObject({
      url: REQUEST.url,
      signed: false,
    });
    expect(await jobsOf(row.id)).toEqual([
      expect.objectContaining({ key: httpDeliverJobKey(row.id), task: 'http.deliver' }),
    ]);
  });

  it('phase 1 again with the same idempotency key returns the same row and adds no job', async () => {
    const { automationId, runId, row } = await enqueueAction(a, 'evt_SameKeyEvent0001');
    const again = await db.withTx((tx) =>
      outbox().enqueue(tx, orgScope(ORG_A), {
        kind: 'action',
        automationId,
        runId,
        actionId: 'act_http',
        idempotencyKey: `${automationId}:evt_SameKeyEvent0001:act_http`,
        request: { ...REQUEST, url: 'https://other.example.com/' },
      }),
    );
    expect(again.created).toBe(false);
    expect(again.row.id).toBe(row.id);
    expect(again.row.target_host).toBe('hooks.example.com');
    expect(await jobsOf(row.id)).toHaveLength(1);
  });

  it('phase 1 refuses a URL that can never be called (ssrf_blocked / invalid_url)', async () => {
    const { automationId, runId } = await runOf(a);
    const error = await db
      .withTx((tx) =>
        outbox().enqueue(tx, orgScope(ORG_A), {
          kind: 'action',
          automationId,
          runId,
          actionId: 'act_http',
          idempotencyKey: `${automationId}:${runId}:act_http`,
          request: { ...REQUEST, url: 'ftp://hooks.example.com/' },
        }),
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OutboundHttpError);
    expect((error as OutboundHttpError).params).toEqual({ reason: 'invalid_url' });
  });

  it('keeps every delivery inside its organization (tenant isolation)', async () => {
    const { row, runId } = await enqueueAction(a);
    const scopeB = orgScope(ORG_B);
    expect(await repo().get(scopeB, row.id)).toBeUndefined();
    expect(await repo().listForRun(scopeB, runId)).toEqual([]);
    expect(await repo().cancelPendingOfRuns(scopeB, [runId])).toBe(0);
    const leased = await db.withTx((tx) =>
      repo().lease(withTxScope(scopeB, tx), row.id, { now: new Date(), leaseMs: 30_000 }),
    );
    expect(leased.state).toBe('missing');
    expect(await repo().release(scopeB, row.id, 1, new Date())).toBe(false);
    expect(
      await repo().fail(scopeB, row.id, 1, { at: new Date(), lastStatus: null, lastError: null }),
    ).toBeUndefined();
    // Still pending for its own organization.
    expect((await repo().get(orgScope(ORG_A), row.id))?.status).toBe('pending');
    expect((await repo().listForRun(orgScope(ORG_A), runId)).map((item) => item.id)).toEqual([
      row.id,
    ]);
  });

  it('T617: a row leased in its organization cannot be finished or given back from another one', async () => {
    const { row } = await enqueueAction(a);
    const scopeA = orgScope(ORG_A);
    const scopeB = orgScope(ORG_B);
    const now = new Date();
    const leased = await db.withTx((tx) =>
      repo().lease(withTxScope(scopeA, tx), row.id, { now, leaseMs: 30_000 }),
    );
    expect(leased).toMatchObject({ state: 'acquired', row: { status: 'sending', attempts: 1 } });
    // The right attempt, the wrong organization: every write of phase 2 misses.
    const outcome = { at: now, lastStatus: 200, lastError: null };
    expect(await repo().release(scopeB, row.id, 1, new Date(now.getTime() + 60_000))).toBe(false);
    expect(
      await repo().succeed(scopeB, row.id, 1, { ...outcome, response: { status: 200 } }),
    ).toBeUndefined();
    expect(
      await repo().retryLater(scopeB, row.id, 1, {
        ...outcome,
        lastStatus: 503,
        nextAttemptAt: new Date(now.getTime() + 10_000),
      }),
    ).toBeUndefined();
    expect(await repo().fail(scopeB, row.id, 1, outcome)).toBeUndefined();
    expect(await repo().get(scopeA, row.id)).toMatchObject({ status: 'sending', attempts: 1 });
    // The same writes from the row's organization do apply.
    expect(
      await repo().retryLater(scopeA, row.id, 1, {
        ...outcome,
        lastStatus: 503,
        nextAttemptAt: new Date(now.getTime() + 10_000),
      }),
    ).toMatchObject({ status: 'pending', last_status: 503 });
  });

  it('T617: the same idempotency key in another organization is a row of its own', async () => {
    const { row } = await enqueueAction(a);
    const { automationId, runId } = await runOf(b);
    const other = await db.withTx((tx) =>
      outbox().enqueue(tx, orgScope(ORG_B), {
        kind: 'action',
        automationId,
        runId,
        actionId: 'act_http',
        idempotencyKey: row.idempotency_key,
        request: REQUEST,
      }),
    );
    expect(other.created).toBe(true);
    expect(other.row.id).not.toBe(row.id);
    expect(other.row.organization_id).toBe(ORG_B);
    expect((await repo().get(orgScope(ORG_A), row.id))?.idempotency_key).toBe(row.idempotency_key);
    expect(await repo().get(orgScope(ORG_A), other.row.id)).toBeUndefined();
  });

  it('phase 2 lease: due → sending + attempt; early, live lease, expired lease; SKIP LOCKED', async () => {
    const { row } = await enqueueAction(a);
    const scope = orgScope(ORG_A);
    const now = new Date();
    const lease = (at: Date) =>
      db.withTx((tx) => repo().lease(withTxScope(scope, tx), row.id, { now: at, leaseMs: 30_000 }));

    const first = await lease(now);
    expect(first.state).toBe('acquired');
    if (first.state !== 'acquired') return;
    expect(first.row).toMatchObject({ status: 'sending', attempts: 1 });
    expect(first.row.lease_until?.getTime()).toBe(now.getTime() + 30_000);

    // Another worker while the lease is live.
    expect(await lease(new Date(now.getTime() + 10_000))).toMatchObject({ state: 'leased' });
    // The worker died: once the lease expired the row is taken again (attempt 2).
    const second = await lease(new Date(now.getTime() + 31_000));
    expect(second).toMatchObject({ state: 'acquired', row: { attempts: 2 } });
    // The dead worker's late write is fenced off.
    expect(
      await repo().succeed(scope, row.id, 1, {
        at: now,
        lastStatus: 200,
        lastError: null,
        response: { status: 200 },
      }),
    ).toBeUndefined();

    // Given back (pacer wait): pending, attempt not counted, due later.
    const later = new Date(now.getTime() + 60_000);
    expect(await repo().release(scope, row.id, 2, later)).toBe(true);
    expect(await repo().get(scope, row.id)).toMatchObject({ status: 'pending', attempts: 1 });
    expect(await lease(new Date(now.getTime() + 40_000))).toMatchObject({ state: 'early' });

    // A row locked by another transaction is skipped, not waited for.
    await db.withTx(async (tx) => {
      await sql`SELECT 1 FROM meta.http_deliveries WHERE id = ${row.id} FOR UPDATE`.execute(tx);
      const other = createTestDb(database.url);
      try {
        const skipped = await other.withTx((inner) =>
          new HttpDeliveriesRepository(other).lease(withTxScope(scope, inner), row.id, {
            now: later,
            leaseMs: 30_000,
          }),
        );
        expect(skipped.state).toBe('missing');
      } finally {
        await other.destroy();
      }
    });
  });

  it('erases the request once final (CHECK) and keeps last status and error', async () => {
    const { row } = await enqueueAction(a);
    const scope = orgScope(ORG_A);
    await db.withTx((tx) =>
      repo().lease(withTxScope(scope, tx), row.id, { now: new Date(), leaseMs: 30_000 }),
    );
    const failed = await repo().fail(scope, row.id, 1, {
      at: new Date(),
      lastStatus: 404,
      lastError: { code: 'http_status', params: { status: 404 } },
      response: { status: 404, headers: { 'content-type': null }, body: null },
    });
    expect(failed).toMatchObject({
      status: 'failed',
      request_enc: null,
      last_status: 404,
      last_error: { code: 'http_status', params: { status: 404 } },
    });
    // A final row keeping its request is refused by the database.
    await expect(
      sql`UPDATE meta.http_deliveries SET request_enc = 'x' WHERE id = ${row.id}`.execute(
        db.kysely,
      ),
    ).rejects.toThrow(/http_deliveries_request_check/);
  });

  it('cancels the pending deliveries of cancelled runs, not the sending ones', async () => {
    const pending = await enqueueAction(a);
    const sending = await enqueueAction(a);
    const scope = orgScope(ORG_A);
    await db.withTx((tx) =>
      repo().lease(withTxScope(scope, tx), sending.row.id, { now: new Date(), leaseMs: 30_000 }),
    );
    expect(await repo().cancelPendingOfRuns(scope, [pending.runId, sending.runId])).toBe(1);
    expect(await repo().get(scope, pending.row.id)).toMatchObject({
      status: 'cancelled',
      request_enc: null,
    });
    expect((await repo().get(scope, sending.row.id))?.status).toBe('sending');
  });

  it('follows its run: deleting the run deletes its deliveries (CASCADE)', async () => {
    const { row, runId } = await enqueueAction(a);
    await db.kysely.deleteFrom('meta.automation_runs').where('id', '=', runId).execute();
    expect(await repo().get(orgScope(ORG_A), row.id)).toBeUndefined();
  });

  it('test deliveries: no run, kept 24 hours (maintenance.cleanup)', async () => {
    const created = await db.withTx((tx) =>
      outbox().enqueue(tx, orgScope(ORG_B), {
        kind: 'test',
        automationId: null,
        actionId: null,
        requestedBy: b.userId,
        request: REQUEST,
      }),
    );
    expect(created.row).toMatchObject({
      kind: 'test',
      run_id: null,
      idempotency_key: `test:${created.row.id}`,
      requested_by: b.userId,
    });
    const now = new Date();
    expect((await purgeExpiredOperationalRows(db, { now })).httpTestDeliveries).toBe(0);
    await sql`
      UPDATE meta.http_deliveries SET created_at = now() - interval '25 hours'
       WHERE id = ${created.row.id}
    `.execute(db.kysely);
    const action = await enqueueAction(b);
    await sql`
      UPDATE meta.http_deliveries SET created_at = now() - interval '25 hours'
       WHERE id = ${action.row.id}
    `.execute(db.kysely);
    expect((await purgeExpiredOperationalRows(db, { now })).httpTestDeliveries).toBe(1);
    expect(await repo().get(orgScope(ORG_B), created.row.id)).toBeUndefined();
    // Action deliveries follow their run, not this retention.
    expect(await repo().get(orgScope(ORG_B), action.row.id)).toBeDefined();
  });

  it('measures the instance-wide backlog (counts only)', async () => {
    const now = new Date();
    const before = await measureHttpDeliveryBacklog(db, { now });
    const { row } = await enqueueAction(b);
    await sql`
      UPDATE meta.http_deliveries SET created_at = now() - interval '700 seconds'
       WHERE id = ${row.id}
    `.execute(db.kysely);
    const after = await measureHttpDeliveryBacklog(db, { now: new Date() });
    expect(after.pending).toBe(before.pending + 1);
    expect(after.oldestPendingSeconds).toBeGreaterThanOrEqual(700);
  });
});
