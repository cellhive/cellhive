import { Buffer } from 'node:buffer';

import {
  automationBatchOverflowViewDataSchema,
  automationSchema,
  importUploadSchema,
  jobSchema,
  notificationListSchema,
  type AutomationDto,
  type Id,
  type NotificationDto,
} from '@cellhive/contracts';
import { NotificationWriter, type Db } from '@cellhive/server-core';
import { buildTaskList, createWorker, type WorkerHandle } from '@cellhive/worker';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startSmtpCapture, type SmtpCapture } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { buildRecordFixture, type FixtureUser, type RecordFixture } from './record-fixture.js';
import { captureLogger, startTestApp, type TestApp } from './support.js';

const BOUNDARY = 'cellhive-overflow-boundary';

function multipart(filename: string, bytes: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        'Content-Type: text/csv\r\n\r\n',
    ),
    bytes,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);
}

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

/** The decoded `text/plain` part of a raw `multipart/alternative` message. */
function plainText(raw: string): string {
  const boundary = /boundary="?([^";\r\n]+)"?/.exec(raw)?.[1] ?? '';
  for (const part of raw.split(`--${boundary}`)) {
    const split = part.search(/\r?\n\r?\n/);
    if (split < 0 || !/content-type:\s*text\/plain/i.test(part.slice(0, split))) continue;
    const head = part.slice(0, split);
    const body = part.slice(split).trim();
    if (/content-transfer-encoding:\s*base64/i.test(head)) {
      return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
    }
    if (/content-transfer-encoding:\s*quoted-printable/i.test(head)) {
      const bytes: number[] = [];
      const value = body.replace(/=\r?\n/g, '');
      for (let i = 0; i < value.length; i += 1) {
        const hex = value.slice(i + 1, i + 3);
        if (value[i] === '=' && /^[0-9A-F]{2}$/i.test(hex)) {
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
 * QA S5 L6 (BACKLOG T542): an `automation.batch_overflow` notification shows
 * how many records the automation left out — `data.skipped`, computed when
 * read from the stand-in run (API, CONTRACTS §22.3) and when the email is
 * sent (§22.4), never stored on the row — and `null` for a reader who
 * cannot see the automation. Import of 5 000 rows through the real API and
 * worker (runs stay `queued`: the engine is left out).
 */
describe('automation.batch_overflow shows the records left out (T542, QA S5 L6)', () => {
  let database: TestDatabase;
  let db: Db;
  let smtp: SmtpCapture;
  let t: TestApp;
  let fx: RecordFixture;
  let worker: WorkerHandle;

  const F = (name: string) => fx.fld[name]?.id as Id<'fld'>;
  const me = (path: string) => `/orgs/${fx.orgId}/me${path}`;

  async function list(user: FixtureUser): Promise<NotificationDto[]> {
    const response = await fx.call(user, 'GET', me('/notifications'));
    expect(response.statusCode, response.body).toBe(200);
    return notificationListSchema.parse(response.json()).items;
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    smtp = await startSmtpCapture();
    t = await startTestApp({
      DATABASE_URL: database.url,
      SMTP_URL: smtp.url,
      SMTP_FROM: 'Cellhive <noreply@cellhive.test>',
      SMTP_ALLOW_INSECURE: 'true',
    });
    fx = await buildRecordFixture(t, db);
    const { logger } = captureLogger();
    // Emails wait for the test to release them (once every event is dispatched).
    const taskList = Object.fromEntries(
      Object.entries(
        buildTaskList({ config: t.config, db, logger, notificationEmailBatchMs: 3_600_000 }),
      ).filter(([name]) => name !== 'automation.run'),
    );
    worker = await createWorker(t.config, { logger, pollIntervalMs: 50, taskList });
  });

  afterAll(async () => {
    await worker.close();
    await t.close();
    await smtp.close();
    await db.destroy();
    await database.drop();
  });

  it('import of 5 000 rows: skipped 4 000 through the API and in the email; null when not visible', async () => {
    // On Customers, which Sales cannot read: u_sales1 cannot see the automation.
    const created = await fx.call('u_admin', 'POST', `/bases/${fx.baseId}/automations`, {
      name: 'Overflow watcher',
      enabled: true,
      definition: {
        trigger: { type: 'record.created', table_id: fx.customers.id },
        actions: [
          {
            id: 'act_1',
            type: 'create_record',
            config: {
              table_id: fx.orders.id,
              fields: { [F('title')]: { literal: 'From automation' } },
            },
          },
        ],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const automation: AutomationDto = automationSchema.parse(created.json());

    const lines = ['name'];
    for (let i = 0; i < 5000; i += 1) lines.push(`Khách ${String(i)}`);
    const upload = await fx.call(
      'u_admin',
      'POST',
      `/bases/${fx.baseId}/imports/uploads`,
      multipart('customers.csv', Buffer.from(`${lines.join('\r\n')}\r\n`)),
      { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    );
    expect(upload.statusCode, upload.body).toBe(201);
    const start = await fx.call('u_admin', 'POST', `/bases/${fx.baseId}/imports`, {
      upload_id: importUploadSchema.parse(upload.json()).id,
      mode: 'append',
      table_id: fx.customers.id,
      mapping: [{ column: 0, field_id: F('customerName') }],
    });
    expect(start.statusCode, start.body).toBe(202);
    const jobId = start.json<{ job_id: Id<'job'> }>().job_id;
    const job = await eventually(
      async () => {
        const dto = jobSchema.parse((await fx.call('u_admin', 'GET', `/jobs/${jobId}`)).json());
        return ['succeeded', 'failed', 'cancelled'].includes(dto.status) ? dto : undefined;
      },
      'the import',
      300_000,
    );
    expect(job.status).toBe('succeeded');
    await eventually(
      async () => {
        const { rows } = await sql<{ n: number }>`
          SELECT count(*)::int AS n FROM meta.events WHERE dispatched_at IS NULL
        `.execute(db.kysely);
        return rows[0]?.n === 0;
      },
      'every event to be dispatched',
      600_000,
    );

    // The API: computed when read from the stand-in run.
    const item = await eventually(
      async () =>
        (await list('u_admin')).find(
          (n) => n.type === 'automation.batch_overflow' && n.entity.id === automation.id,
        ),
      'the overflow notification',
    );
    const data = automationBatchOverflowViewDataSchema.parse(item.data);
    expect(data).toMatchObject({ automation_id: automation.id, batch_id: jobId, limit: 1000 });
    expect(data.skipped).toBe(4000);
    expect(item.entity.title).toBe('Overflow watcher');
    // Never stored on the row.
    const stored = await db.kysely
      .selectFrom('meta.notifications')
      .select('payload')
      .where('id', '=', item.id)
      .executeTakeFirstOrThrow();
    expect(stored.payload).not.toHaveProperty('skipped');

    // A reader who cannot see the automation (no access to Customers): `null`.
    await db.withTx((tx) =>
      new NotificationWriter(db, { emailEnabled: false }).write(tx, fx.orgId, [
        {
          userId: fx.users.u_sales1.id,
          type: 'automation.batch_overflow',
          baseId: fx.baseId,
          tableId: null,
          entityType: 'automation',
          entityId: automation.id,
          actor: null,
          groupKey: null,
          data: stored.payload as Record<string, never>,
        },
      ]),
    );
    const hidden = (await list('u_sales1')).find((n) => n.type === 'automation.batch_overflow');
    expect(hidden?.entity.title).toBeNull();
    expect(hidden?.data).toMatchObject({ batch_id: jobId, skipped: null });

    // The email (released now that the batch is over): the same number.
    const key = `notifications.deliver:${fx.orgId}:${fx.users.u_admin.id}`;
    await sql`
      SELECT graphile_worker.add_job('notifications.deliver',
        json_build_object('organization_id', ${fx.orgId}::text,
                          'user_id', ${fx.users.u_admin.id}::text, 'reason', 'immediate'),
        job_key => ${key}::text, run_at => now())
    `.execute(db.kysely);
    const mail = await eventually(
      () =>
        Promise.resolve(
          smtp.messages.find((message) => message.to.includes(fx.users.u_admin.email)),
        ),
      'the notification email',
    );
    // In the recipient's language (the fixture organization is `vi`).
    const text = plainText(mail.raw);
    expect(text).toContain(
      'Automation “Overflow watcher” đã bỏ qua 4.000 bản ghi của một thay đổi hàng loạt (giới hạn 1.000 lần chạy mỗi thay đổi)',
    );
  }, 900_000);
});
