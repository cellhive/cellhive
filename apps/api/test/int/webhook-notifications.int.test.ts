import {
  automationSchema,
  incomingWebhookWithSecretsSchema,
  newId,
  notificationListSchema,
  type Id,
  type IncomingWebhookWithSecretsDto,
  type NotificationDto,
} from '@cellhive/contracts';
import {
  scheduleNotificationFlush,
  webhookNotificationGroupKey,
  type Db,
} from '@cellhive/server-core';
import { buildTaskList, createWorker, type WorkerHandle } from '@cellhive/worker';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IncomingWebhookRateLimits } from '../../src/common/rate-limit/incoming-webhook-rate-limits.js';
import { DB } from '../../src/common/tokens.js';

import { startSmtpCapture, type SmtpCapture } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { buildRecordFixture, type FixtureUser, type RecordFixture } from './record-fixture.js';
import { captureLogger, startTestApp, type TestApp } from './support.js';

async function eventually<T>(
  probe: () => Promise<T | undefined | false>,
  label: string,
  timeoutMs = 90_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** The decoded `text/plain` part of a raw `multipart/alternative` message. */
function plainText(raw: string): string {
  const boundary = /boundary="?([^";\r\n]+)"?/u.exec(raw)?.[1] ?? '';
  for (const part of raw.split(`--${boundary}`)) {
    const split = part.search(/\r?\n\r?\n/u);
    if (split < 0 || !/content-type:\s*text\/plain/iu.test(part.slice(0, split))) continue;
    const head = part.slice(0, split);
    const body = part.slice(split).trim();
    if (/content-transfer-encoding:\s*base64/iu.test(head)) {
      return Buffer.from(body.replace(/\s+/gu, ''), 'base64').toString('utf8');
    }
    if (/content-transfer-encoding:\s*quoted-printable/iu.test(head)) {
      const bytes: number[] = [];
      const value = body.replace(/=\r?\n/gu, '');
      for (let i = 0; i < value.length; i += 1) {
        const hex = value.slice(i + 1, i + 3);
        if (value[i] === '=' && /^[0-9A-F]{2}$/iu.test(hex)) {
          bytes.push(parseInt(hex, 16));
          i += 2;
        } else {
          bytes.push(value.charCodeAt(i));
        }
      }
      return Buffer.from(bytes).toString('utf8');
    }
    return body;
  }
  return '';
}

/**
 * BACKLOG T608 (ADR-35 §6, CONTRACTS §22.1–22.2; P52) through the real API
 * and worker: requests to an incoming webhook whose automation assigns
 * u_sales1 to one record each give u_sales1 **one** `record.assigned` for
 * the window of (hook, table) — `count` = the records they read (r2, owned
 * by u_sales2, is never counted, listed, emailed) — and **one** email "via a
 * webhook". The 60 s window is ended by moving the pending flush to now
 * (the worker's own clock decides, as T545/T557).
 */
describe('notifications of incoming webhook writes over HTTP (T608, P52)', () => {
  let database: TestDatabase;
  let db: Db;
  let smtp: SmtpCapture;
  let t: TestApp;
  let fx: RecordFixture;
  let worker: WorkerHandle;
  let reviewers: Id<'fld'>;
  const { logger } = captureLogger();

  const F = (name: string) => fx.fld[name]?.id as Id<'fld'>;
  const U = (user: FixtureUser) => fx.users[user].id;

  async function inAppOf(user: FixtureUser): Promise<NotificationDto[]> {
    const response = await fx.call(user, 'GET', `/orgs/${fx.orgId}/me/notifications?limit=200`);
    expect(response.statusCode, response.body).toBe(200);
    return notificationListSchema.parse(response.json()).items;
  }

  function emailsOf(user: FixtureUser): string[] {
    return smtp.messages
      .filter((message) => message.to.includes(fx.users[user].email))
      .map((message) => plainText(message.raw));
  }

  async function settled(): Promise<void> {
    await eventually(async () => {
      const { rows } = await sql<{ events: number; runs: number; jobs: number; pending: number }>`
        SELECT (SELECT count(*)::int FROM meta.events WHERE dispatched_at IS NULL) AS events,
               (SELECT count(*)::int FROM meta.automation_runs
                 WHERE status IN ('queued', 'running')) AS runs,
               (SELECT count(*)::int FROM graphile_worker._private_jobs p
                  JOIN graphile_worker._private_tasks k ON k.id = p.task_id
                 WHERE k.identifier IN ('events.dispatch', 'automation.run',
                                        'notifications.fanout', 'notifications.deliver')
                    OR (k.identifier = 'notifications.flush'
                        AND p.run_at <= now() + interval '15 seconds')) AS jobs,
               (SELECT count(*)::int FROM meta.notification_deliveries
                 WHERE status = 'pending') AS pending
      `.execute(db.kysely);
      const row = rows[0];
      return row?.events === 0 && row.runs === 0 && row.jobs === 0 && row.pending === 0;
    }, 'events, runs, notifications and deliveries to settle');
  }

  async function createOrders(owners: readonly FixtureUser[]): Promise<Id<'rec'>[]> {
    const response = await fx.call(
      'u_admin',
      'POST',
      `/tables/${fx.orders.id}/records?field_key_type=id`,
      {
        records: owners.map((owner, i) => ({
          fields: {
            [F('title')]:
              `${owner === 'u_sales1' ? 'Hook order' : 'Secret order'} ${String(i + 1)}`,
            [F('owner')]: [{ id: U(owner) }],
          },
        })),
      },
    );
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ records: { id: Id<'rec'> }[] }>().records.map((record) => record.id);
  }

  async function hook(): Promise<IncomingWebhookWithSecretsDto> {
    const response = await fx.call('u_admin', 'POST', `/bases/${fx.baseId}/incoming-webhooks`, {
      name: `Hook ${newId('hok').slice(4, 12)}`,
      auth: 'none',
      rate_limit_per_sec: 1000,
    });
    expect(response.statusCode, response.body).toBe(201);
    return incomingWebhookWithSecretsSchema.parse(response.json());
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    smtp = await startSmtpCapture();
    t = await startTestApp({
      DATABASE_URL: database.url,
      WEBHOOK_MAX_RATE_PER_SEC: '1000',
      SMTP_URL: smtp.url,
      SMTP_FROM: 'Cellhive <noreply@cellhive.test>',
      SMTP_ALLOW_INSECURE: 'true',
    });
    fx = await buildRecordFixture(t, db);
    const limits = t.app.get(IncomingWebhookRateLimits);
    limits.ip = { limit: 100_000, windowSeconds: 1 };
    limits.base = { ratePerSec: 100_000, burst: 100_000 };
    const field = await fx.call('owner', 'POST', `/tables/${fx.orders.id}/fields`, {
      name: 'reviewers',
      type: 'user',
      options: { multiple: true, notify_on_assign: true },
    });
    expect(field.statusCode, field.body).toBe(201);
    reviewers = field.json<{ id: Id<'fld'> }>().id;
    worker = await createWorker(t.config, {
      logger,
      pollIntervalMs: 50,
      taskList: buildTaskList({
        config: t.config,
        db: t.app.get<Db>(DB),
        logger,
        notificationEmailBatchMs: 500,
      }),
    });
  }, 180_000);

  afterAll(async () => {
    await worker.close();
    await t.close();
    await smtp.close();
    await db.destroy();
    await database.drop();
  });

  it('26 requests assigning u_sales1 → one record.assigned (count 25, r2 never counted) and one email "qua webhook" (vi)', async () => {
    // One bulk create: nobody auto-follows (no `followed` window to wait for).
    const created25 = await createOrders([
      ...Array.from({ length: 25 }, () => 'u_sales1' as const),
      'u_sales2',
    ]);
    const owned = created25.slice(0, 25);
    const r2 = created25[25] as Id<'rec'>;
    const target = await hook();
    const created = await fx.call('u_admin', 'POST', `/bases/${fx.baseId}/automations`, {
      name: 'Assign the reviewer from the webhook',
      enabled: true,
      definition: {
        trigger: { type: 'webhook.received', incoming_webhook_id: target.id },
        actions: [
          {
            id: 'act_assign',
            type: 'update_record',
            config: {
              table_id: fx.orders.id,
              record_id: { trigger: 'body', path: 'record_id' },
              fields: { [reviewers]: { literal: [{ id: U('u_sales1') }] } },
            },
          },
        ],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const flow = automationSchema.parse(created.json());
    await settled();
    const inAppBefore = (await inAppOf('u_sales1')).length;
    const emailsBefore = emailsOf('u_sales1').length;

    const token = target.url.split('/api/v1/hooks/')[1] ?? '';
    for (const recordId of [...owned, r2]) {
      const response = await t.app.inject({
        method: 'POST',
        url: `/api/v1/hooks/${token}`,
        payload: JSON.stringify({ record_id: recordId }),
        headers: { 'content-type': 'application/json' },
        remoteAddress: '198.51.100.10',
      });
      expect(response.statusCode, response.body).toBe(202);
    }
    await settled();
    const { rows: runs } = await sql<{ status: string; n: number }>`
      SELECT status, count(*)::int AS n FROM meta.automation_runs
       WHERE automation_id = ${flow.id} GROUP BY status
    `.execute(db.kysely);
    expect(runs).toEqual([{ status: 'succeeded', n: 26 }]);

    // Nothing yet: the window of (hook, table) is still open, flushed 60 s after its first row.
    const key = webhookNotificationGroupKey(target.id, fx.orders.id);
    const { rows: pending } = await sql<{ run_at: Date }>`
      SELECT run_at FROM graphile_worker.jobs
       WHERE task_identifier = 'notifications.flush' AND key = ${`assigned:${key}`}
    `.execute(db.kysely);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.run_at.getTime()).toBeGreaterThan(Date.now() + 20_000);
    expect(await inAppOf('u_sales1')).toHaveLength(inAppBefore);

    await db.withTx((tx) =>
      scheduleNotificationFlush(
        tx,
        { organization_id: fx.orgId, kind: 'assigned', group_key: key },
        new Date(),
      ),
    );
    await eventually(async () => {
      const { rows } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM meta.notification_buffer WHERE group_key = ${key}
      `.execute(db.kysely);
      return rows[0]?.n === 0;
    }, 'the window to be flushed');
    await settled();
    await eventually(
      () => Promise.resolve(emailsOf('u_sales1').length > emailsBefore),
      'the email',
    );

    const fresh = (await inAppOf('u_sales1')).slice(0, -inAppBefore || undefined);
    const assigned = fresh.filter((item) => item.type === 'record.assigned');
    expect(assigned).toHaveLength(1);
    const [notice] = assigned;
    expect(notice?.entity).toMatchObject({ type: 'table', id: fx.orders.id });
    expect(notice?.data).toMatchObject({
      batch_id: null,
      count: 25,
      field_ids: [reviewers],
      source: { incoming_webhook_id: target.id },
    });
    expect(JSON.stringify(notice)).not.toContain(r2);
    // The first 20 in append order (runs finish in any order): readable ones only.
    const listed = (notice?.data['record_ids'] ?? []) as Id<'rec'>[];
    expect(listed).toHaveLength(20);
    expect(owned).toEqual(expect.arrayContaining(listed));

    const emails = emailsOf('u_sales1').slice(emailsBefore);
    expect(emails).toHaveLength(1);
    expect(emails[0]).toContain('Bạn được gán 25 bản ghi trong');
    expect(emails[0]).toContain('qua webhook');
    expect(emails[0]).toMatch(/Hook order \d+/u);
    expect(emails[0]).toContain('Và 5 bản ghi khác');
    expect(emails[0]).not.toContain('Secret order');
    expect(emails[0]).not.toContain(r2);
  }, 180_000);
});
