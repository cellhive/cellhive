import {
  BasesRepository,
  enqueueNotification,
  orgScope,
  type Db,
  type Mailer,
  type MailMessage,
  type MailSendResult,
} from '@cellhive/server-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createWorker, type WorkerHandle } from '../../src/index.js';
import { buildTaskList } from '../../src/tasks/index.js';

import {
  captureLogger,
  createMigratedDatabase,
  createTestDb,
  testConfig,
  waitFor,
  type CapturedLogger,
  type TestDatabase,
} from './support.js';

import type { Id } from '@cellhive/contracts';

const ORG: Id<'org'> = 'org_NtfEmailOrg00001';
const USER: Id<'usr'> = 'usr_NtfEmailUser0001';
const AUT: Id<'aut'> = 'aut_NtfEmailAuto0001';
const RUN: Id<'run'> = 'run_NtfEmailRun00001';
const SECRET = 'never-logged-body';

/** A mailer that keeps what it is asked to send (the SMTP side is tested in server-core). */
function recordingMailer(): Mailer & { readonly sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  return {
    sent,
    instanceConfigured: true,
    instance: { host: '***.test', port: 587, security: 'starttls' },
    send(message: MailMessage): Promise<MailSendResult> {
      sent.push(message);
      return Promise.resolve({
        messageId: message.messageId ?? '',
        accepted: ['n***@example.test'],
        rejected: [],
        bytes: null,
        smtp: { code: 250, enhanced: '2.0.0' },
      });
    },
    verify: () => Promise.resolve(),
    forgetIdentity: () => undefined,
    close: () => undefined,
  };
}

describe('worker: notification emails (T512)', () => {
  let database: TestDatabase;
  let db: Db;
  let worker: WorkerHandle;
  let captured: CapturedLogger;
  let baseId: Id<'bse'>;
  const mailer = recordingMailer();

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    await db.kysely
      .insertInto('meta.organizations')
      .values({ id: ORG, name: 'Acme', slug: 'acme' })
      .execute();
    await db.kysely
      .insertInto('meta.users')
      .values({ id: USER, email: 'notified@example.test', display_name: 'Notified' })
      .execute();
    await db.kysely
      .insertInto('meta.org_members')
      .values({ organization_id: ORG, user_id: USER, role: 'owner' })
      .execute();
    await db.kysely
      .insertInto('meta.workspaces')
      .values({ id: 'wsp_NtfEmailWsp00001', organization_id: ORG, name: 'Main', slug: 'main' })
      .execute();
    const base = await new BasesRepository(db).create(orgScope(ORG), {
      workspaceId: 'wsp_NtfEmailWsp00001',
      ownerId: USER,
      name: 'Sales',
    });
    baseId = base.id;
    captured = captureLogger();
    const config = testConfig(database.url, {
      SMTP_URL: 'smtp://127.0.0.1:2525',
      SMTP_FROM: 'Cellhive <no-reply@cellhive.test>',
      SMTP_ALLOW_INSECURE: 'true',
    });
    worker = await createWorker(config, {
      logger: captured.logger,
      pollIntervalMs: 200,
      taskList: buildTaskList({
        config,
        db,
        logger: captured.logger,
        notificationMailer: mailer,
        notificationEmailBatchMs: 1_500,
      }),
    });
  });

  afterAll(async () => {
    await worker.close();
    await db.destroy();
    await database.drop();
  });

  it('three notifications within the batch window → one email, deliveries sent', async () => {
    for (const title of ['One', 'Two', 'Three']) {
      await db.withTx((tx) =>
        enqueueNotification(tx, {
          organizationId: ORG,
          type: 'automation.message',
          baseId,
          entityType: 'automation',
          entityId: AUT,
          userIds: [USER],
          data: { automation_id: AUT, run_id: RUN, title, body: SECRET },
        }),
      );
    }
    await waitFor(() => Promise.resolve(mailer.sent.length > 0), {
      what: 'the notification email',
    });
    // The batch window is over: no second email follows.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(mailer.sent).toHaveLength(1);
    const [email] = mailer.sent;
    expect(email).toMatchObject({
      to: 'notified@example.test',
      subject: '3 new notifications',
      origin: { kind: 'notification', organizationId: ORG },
    });
    expect(email?.messageId).toMatch(/^<ob\.[0-9a-f]{40}@cellhive\.test>$/);
    expect(email?.text).toContain('Manage notifications');

    const rows = await db.kysely
      .selectFrom('meta.notification_deliveries')
      .select('status')
      .where('organization_id', '=', ORG)
      .execute();
    expect(rows.map((row) => row.status)).toEqual(['sent', 'sent', 'sent']);
    await waitFor(
      () => Promise.resolve(captured.lines.some((line) => line.msg === 'notification email sent')),
      { what: 'the delivery log' },
    );
    expect(captured.lines.find((line) => line.msg === 'notification email sent')).toMatchObject({
      org_id: ORG,
      user_id: USER,
      sent: 3,
    });
    expect(captured.raw()).not.toContain(SECRET);
    expect(captured.raw()).not.toContain('notified@example.test');
  });
});
