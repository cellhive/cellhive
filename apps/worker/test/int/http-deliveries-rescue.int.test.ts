import { once } from 'node:events';
import { createServer, type Server } from 'node:http';

import { type Id } from '@cellhive/contracts';
import {
  HttpDeliveriesRepository,
  httpDeliverJobKey,
  HttpOutbox,
  listStuckHttpDeliveries,
  orgScope,
  rescueHttpDelivery,
  type Db,
  type Tx,
} from '@cellhive/server-core';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createWorker, type WorkerHandle } from '../../src/index.js';
import { buildTaskList, createHttpDeliveriesRescueTask } from '../../src/tasks/index.js';

import {
  captureLogger,
  createMigratedDatabase,
  createTestDb,
  queuedJobs,
  testConfig,
  waitFor,
  type CapturedLogger,
  type TestDatabase,
} from './support.js';

import type { JobHelpers } from 'graphile-worker';
import type { AddressInfo } from 'node:net';

const ORG_A: Id<'org'> = 'org_RescueOrgAAAAAA1';
const ORG_B: Id<'org'> = 'org_RescueOrgBBBBBB1';
const USER: Id<'usr'> = 'usr_RescueOwner00001';
const BODY_CANARY = 'never-logged-rescue-body';

/**
 * BACKLOG T702 with real workers (graphile-worker, Postgres Testcontainers):
 * the cron `http.deliveries_rescue` gives a delivery whose `http.deliver`
 * job was lost its job back (`job_key = http:<id>`, `preserve_run_at`) in
 * the organization's scope; the destination receives it once, a job
 * scheduled later or locked is left alone, two workers rescuing at once
 * deliver once, and one organization failing leaves the others alone.
 */
describe('worker: http.deliveries_rescue (T702)', () => {
  let database: TestDatabase;
  let db: Db;
  let workers: WorkerHandle[] = [];
  let captured: CapturedLogger;
  let server: Server;
  let port: number;
  /** `webhook-id` of every request the destination received. */
  const received: string[] = [];

  const config = () => testConfig(database.url);

  /**
   * A delivery whose job is lost: the row and its job are written, then the
   * job is deleted before commit (no worker ever sees it) and the row is
   * moved back in time by `overdueMs`. With `job`, the job is kept and
   * changed by `job` in the same transaction instead.
   */
  async function lostDelivery(
    org: Id<'org'>,
    options: {
      sending?: boolean;
      overdueMs?: number;
      job?: (tx: Tx, key: string) => Promise<unknown>;
    } = {},
  ): Promise<Id<'hdl'>> {
    const overdue = `${String((options.overdueMs ?? 120_000) / 1000)} seconds`;
    return db.withTx(async (tx) => {
      const { row } = await new HttpOutbox(db, {
        masterKey: config().security.appMasterKey,
      }).enqueue(tx, orgScope(org), {
        kind: 'test',
        automationId: null,
        actionId: null,
        requestedBy: USER,
        request: {
          method: 'POST',
          url: `http://hooks.test:${String(port)}/in`,
          headers: [['content-type', 'application/json']],
          body: JSON.stringify({ note: BODY_CANARY }),
          authHeaderName: null,
          causation: null,
        },
      });
      if (options.job === undefined) {
        await sql`DELETE FROM graphile_worker._private_jobs WHERE key = ${httpDeliverJobKey(row.id)}`.execute(
          tx,
        );
      } else {
        await options.job(tx, httpDeliverJobKey(row.id));
      }
      await sql`
        UPDATE meta.http_deliveries
           SET next_attempt_at = now() - ${overdue}::interval
         WHERE organization_id = ${org} AND id = ${row.id}
      `.execute(tx);
      if (options.sending === true) {
        // Leased 90 s ago (when it was due) by a worker that died, its safety job lost too.
        await sql`
          UPDATE meta.http_deliveries
             SET status = 'sending', attempts = 1, lease_until = now() - interval '60 seconds',
                 next_attempt_at = now() - interval '90 seconds'
           WHERE organization_id = ${org} AND id = ${row.id}
        `.execute(tx);
      }
      return row.id;
    });
  }

  async function deliveryOf(org: Id<'org'>, id: Id<'hdl'>) {
    return new HttpDeliveriesRepository(db).get(orgScope(org), id);
  }

  async function jobsOf(id: Id<'hdl'>) {
    return (await queuedJobs(db, 'http.deliver')).filter(
      (job) => job.payload['delivery_id'] === id,
    );
  }

  /** One run of the cron, in this process (the clock may be pinned). */
  async function rescueOnce(now?: () => Date): Promise<void> {
    await createHttpDeliveriesRescueTask({
      db,
      logger: captured.logger.child({ task: 'http.deliveries_rescue' }),
      ...(now === undefined ? {} : { now }),
    })({}, {} as JobHelpers);
  }

  async function delivered(org: Id<'org'>, id: Id<'hdl'>) {
    return waitFor(
      async () => {
        const row = await deliveryOf(org, id);
        return row?.status === 'succeeded' ? row : undefined;
      },
      { what: `delivery ${id}` },
    );
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    server = createServer((req, res) => {
      received.push(String(req.headers['webhook-id']));
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    port = (server.address() as AddressInfo).port;

    await db.kysely
      .insertInto('meta.users')
      .values({ id: USER, email: 'rescue@example.test', display_name: 'Owner' })
      .execute();
    for (const [org, slug, allow] of [
      [ORG_A, 'rescue-a', 'hal_RescueAllowAAAA1'],
      [ORG_B, 'rescue-b', 'hal_RescueAllowBBBB1'],
    ] as const) {
      await db.kysely
        .insertInto('meta.organizations')
        .values({ id: org, name: slug, slug })
        .execute();
      await db.kysely
        .insertInto('meta.org_members')
        .values({ organization_id: org, user_id: USER, role: 'owner' })
        .execute();
      await db.kysely
        .insertInto('meta.http_allowlist')
        .values({
          id: allow,
          organization_id: org,
          pattern: `hooks.test:${String(port)}`,
          host: 'hooks.test',
          wildcard: false,
          port,
          created_by: USER,
        })
        .execute();
    }
    captured = captureLogger();
    // Two worker processes (pools) on the same database, both running the cron's task.
    for (let i = 0; i < 2; i += 1) {
      workers.push(
        await createWorker(config(), {
          logger: captured.logger,
          pollIntervalMs: 200,
          taskList: buildTaskList({
            config: config(),
            db,
            logger: captured.logger,
            httpDelivery: { lookup: () => Promise.resolve(['127.0.0.1']) },
          }),
        }),
      );
    }
  });

  beforeEach(() => {
    received.length = 0;
  });

  afterAll(async () => {
    await Promise.all(workers.map((worker) => worker.close()));
    workers = [];
    server.close();
    await db.destroy();
    await database.drop();
  });

  it('lists pending rows 60 s past due and sending rows 30 s past their lease, ids only', async () => {
    const pending = await lostDelivery(ORG_A, { overdueMs: 0 });
    const sending = await lostDelivery(ORG_B, { sending: true, overdueMs: 0 });
    try {
      const at = (offsetMs: number) =>
        listStuckHttpDeliveries(db.kysely, { now: new Date(Date.now() + offsetMs), limit: 500 });
      // Due just now: not yet stuck.
      expect((await at(0)).map((row) => row.id)).not.toContain(pending);
      expect((await at(55_000)).map((row) => row.id)).not.toContain(pending);
      // > 60 s past due (the cron runs every minute: found ≤ 2 minutes after its job was lost).
      const later = await at(65_000);
      expect(later).toContainEqual({ organization_id: ORG_A, id: pending });
      // The sending row's lease ended 60 s ago (> 30 s): stuck already.
      expect(await at(0)).toContainEqual({ organization_id: ORG_B, id: sending });
      for (const row of later) expect(Object.keys(row).sort()).toEqual(['id', 'organization_id']);
      const capped = await listStuckHttpDeliveries(db.kysely, {
        now: new Date(Date.now() + 65_000),
        limit: 1,
      });
      expect(capped).toHaveLength(1);
    } finally {
      await rescueOnce(() => new Date(Date.now() + 65_000));
      await delivered(ORG_A, pending);
      await delivered(ORG_B, sending);
    }
  });

  it('a pending row whose job was deleted is delivered exactly once', async () => {
    const id = await lostDelivery(ORG_A);
    expect(await jobsOf(id)).toEqual([]);
    await rescueOnce();
    const row = await delivered(ORG_A, id);
    expect(row).toMatchObject({ attempts: 1, last_status: 200 });
    expect(received.filter((webhookId) => webhookId === id)).toHaveLength(1);
    // Running the cron again later finds nothing to do for it.
    await rescueOnce(() => new Date(Date.now() + 10 * 60_000));
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(received.filter((webhookId) => webhookId === id)).toHaveLength(1);
  });

  it('a sending row past its lease without a job is delivered, same webhook-id, attempt 2', async () => {
    const id = await lostDelivery(ORG_A, { sending: true });
    await rescueOnce();
    const row = await delivered(ORG_A, id);
    // The job leased it again (ADR-35 §4): the rescue itself changed no attempt.
    expect(row.attempts).toBe(2);
    expect(received).toEqual([id]);
  });

  it('a job scheduled later (Retry-After) is not pulled earlier', async () => {
    // The job was moved to an hour from now, as a `Retry-After` pause does.
    const id = await lostDelivery(ORG_A, {
      job: (tx, key) =>
        sql`
          UPDATE graphile_worker._private_jobs SET run_at = now() + interval '1 hour'
           WHERE key = ${key}
        `.execute(tx),
    });
    const [before] = await jobsOf(id);
    expect(before).toBeDefined();
    await rescueOnce();
    await new Promise((resolve) => setTimeout(resolve, 600));
    const after = await jobsOf(id);
    expect(after).toEqual([before]);
    expect(received).toEqual([]);
    expect((await deliveryOf(ORG_A, id))?.status).toBe('pending');
    await sql`DELETE FROM graphile_worker._private_jobs WHERE key = ${httpDeliverJobKey(id)}`.execute(
      db.kysely,
    );
    await rescueOnce();
    await delivered(ORG_A, id);
  });

  it('a locked job is not touched', async () => {
    // Taken by a worker of another host (alive, or dead and waiting for the 4-hour timeout).
    const id = await lostDelivery(ORG_A, {
      job: (tx, key) =>
        sql`
          UPDATE graphile_worker._private_jobs
             SET locked_at = now(), locked_by = 'ob-elsewhere-AAAAAAAA', attempts = 1
           WHERE key = ${key}
        `.execute(tx),
    });
    const before = await jobsOf(id);
    expect(before).toHaveLength(1);
    const result = await db.withTx((tx) => rescueHttpDelivery(db, tx, orgScope(ORG_A), id));
    expect(result).toBe('job_live');
    await rescueOnce();
    await new Promise((resolve) => setTimeout(resolve, 600));
    // Same job: key kept, attempts and lock unchanged, no second job.
    expect(await jobsOf(id)).toEqual(before);
    const { rows } = await sql<{ key: string | null }>`
      SELECT key FROM graphile_worker.jobs WHERE id = ${before[0]?.id ?? '0'}::bigint
    `.execute(db.kysely);
    expect(rows).toEqual([{ key: httpDeliverJobKey(id) }]);
    expect(received).toEqual([]);
    await sql`DELETE FROM graphile_worker._private_jobs WHERE key = ${httpDeliverJobKey(id)}`.execute(
      db.kysely,
    );
    await rescueOnce();
    await delivered(ORG_A, id);
  });

  it('a job that ran out of attempts is revived', async () => {
    const id = await lostDelivery(ORG_A, {
      job: (tx, key) =>
        sql`
          UPDATE graphile_worker._private_jobs
             SET attempts = max_attempts, last_error = 'database down'
           WHERE key = ${key}
        `.execute(tx),
    });
    await rescueOnce();
    await delivered(ORG_A, id);
    expect(received).toEqual([id]);
  });

  it('is scoped: a delivery of another organization is not_stuck in this scope', async () => {
    const id = await lostDelivery(ORG_B);
    const result = await db.withTx((tx) => rescueHttpDelivery(db, tx, orgScope(ORG_A), id));
    expect(result).toBe('not_stuck');
    expect(await jobsOf(id)).toEqual([]);
    await rescueOnce();
    await delivered(ORG_B, id);
  });

  it('a backlog of rows with a waiting job never starves a lost one', async () => {
    // More overdue rows than one run takes, each with a job merely waiting (backlog).
    const waiting = await Promise.all(
      Array.from({ length: 5 }, () =>
        lostDelivery(ORG_B, {
          job: (tx, key) =>
            sql`
              UPDATE graphile_worker._private_jobs SET run_at = now() + interval '1 hour'
               WHERE key = ${key}
            `.execute(tx),
        }),
      ),
    );
    const lost = await lostDelivery(ORG_B, { overdueMs: 60_500 });
    const listed = await listStuckHttpDeliveries(db.kysely, { now: new Date(), limit: 3 });
    expect(listed.map((row) => row.id)).toContain(lost);
    for (const id of waiting) expect(listed.map((row) => row.id)).not.toContain(id);
    await createHttpDeliveriesRescueTask({ db, logger: captured.logger, limit: 3 })(
      {},
      {} as JobHelpers,
    );
    await delivered(ORG_B, lost);
    expect(received).toEqual([lost]);
    for (const id of waiting) {
      await sql`DELETE FROM graphile_worker._private_jobs WHERE key = ${httpDeliverJobKey(id)}`.execute(
        db.kysely,
      );
    }
    await rescueOnce();
    for (const id of waiting) await delivered(ORG_B, id);
  });

  it('two workers running the cron at once deliver each row once', async () => {
    const ids = await Promise.all(Array.from({ length: 12 }, () => lostDelivery(ORG_B)));
    // Both workers pick a rescue job (cron on two processes), and this process runs one too.
    await sql`
      SELECT graphile_worker.add_job('http.deliveries_rescue', '{}'::json, max_attempts => 1)
        FROM generate_series(1, 2)
    `.execute(db.kysely);
    await rescueOnce();
    for (const id of ids) await delivered(ORG_B, id);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    for (const id of ids) expect(received.filter((webhookId) => webhookId === id)).toHaveLength(1);
    expect(received).toHaveLength(ids.length);
  });

  it('one organization failing does not stop the others; logs carry counts and org ids only', async () => {
    const a = await lostDelivery(ORG_A);
    const b = await lostDelivery(ORG_B);
    // Every job of ORG_A fails to be added (as a broken connection or constraint would).
    await sql`CREATE TABLE public.t702_failing_orgs (org text NOT NULL)`.execute(db.kysely);
    await sql`INSERT INTO public.t702_failing_orgs (org) VALUES (${ORG_A})`.execute(db.kysely);
    await sql`
      CREATE FUNCTION public.t702_fail_org_a() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM public.t702_failing_orgs
                    WHERE org = NEW.payload->>'organization_id') THEN
          RAISE EXCEPTION 't702 injected failure';
        END IF;
        RETURN NEW;
      END $$
    `.execute(db.kysely);
    await sql`
      CREATE TRIGGER t702_fail_org_a BEFORE INSERT OR UPDATE ON graphile_worker._private_jobs
        FOR EACH ROW EXECUTE FUNCTION public.t702_fail_org_a()
    `.execute(db.kysely);
    const mark = captured.lines.length;
    try {
      await rescueOnce();
      await delivered(ORG_B, b);
      expect(await deliveryOf(ORG_A, a)).toMatchObject({ status: 'pending', attempts: 0 });
      expect(await jobsOf(a)).toEqual([]);
      const lines = captured.lines
        .slice(mark)
        .filter((line) => line['task'] === 'http.deliveries_rescue');
      expect(lines).toContainEqual(
        expect.objectContaining({
          msg: 'http deliveries rescue failed',
          org_id: ORG_A,
          deliveries: 1,
          // `raise_exception`; never the error's message or detail.
          error_code: 'P0001',
        }),
      );
      expect(JSON.stringify(lines)).not.toContain('t702 injected failure');
      expect(lines).toContainEqual(
        expect.objectContaining({ msg: 'http deliveries rescued', org_id: ORG_B, queued: 1 }),
      );
      expect(lines).toContainEqual(
        expect.objectContaining({ msg: 'http deliveries rescue done', failed: 1 }),
      );
      const text = JSON.stringify(lines);
      expect(text).not.toContain(a);
      expect(text).not.toContain(b);
      expect(text).not.toContain(BODY_CANARY);
      expect(text).not.toContain('hooks.test');
    } finally {
      await sql`DROP TRIGGER t702_fail_org_a ON graphile_worker._private_jobs`.execute(db.kysely);
      await sql`DROP FUNCTION public.t702_fail_org_a()`.execute(db.kysely);
      await sql`DROP TABLE public.t702_failing_orgs`.execute(db.kysely);
    }
    // Next minute: ORG_A gets its delivery too.
    await rescueOnce();
    await delivered(ORG_A, a);
  });
});
