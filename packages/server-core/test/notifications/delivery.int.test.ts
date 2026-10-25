/**
 * Notification emails (BACKLOG T512): `NotificationEmailDelivery` and the
 * daily summary sweep against PostgreSQL and an in-process SMTP server,
 * with an injected clock.
 */
import { Buffer } from 'node:buffer';

import { newId, type Id } from '@cellhive/contracts';
import { roleConfigSchema, systemRoleConfig } from '@cellhive/permissions';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { systemAuditContext } from '../../src/audit/index.js';
import {
  BaseRoleMembersRepository,
  BaseRolesRepository,
  listPendingEmailRecipients,
  orgScope,
  type Db,
  type OrgScope,
} from '../../src/db/index.js';
import { JobsRepository } from '../../src/jobs/index.js';
import {
  createMailService,
  deterministicMessageId,
  type EmailQuota,
  type Mailer,
  type QuotaDecision,
} from '../../src/mail/index.js';
import {
  NotificationBaseMutesRepository,
  NotificationEmailDelivery,
  NotificationEmailOutboxRepository,
  NotificationPreferencesRepository,
  NotificationSettingsRepository,
  NotificationWriter,
  sweepDailyDigests,
  type PreparedNotification,
} from '../../src/notifications/index.js';
import { RecordQueryService } from '../../src/records/index.js';
import { SchemaService } from '../../src/schema/index.js';
import { insertRows } from '../records/fixtures.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { headerOf, startTestSmtp, type TestSmtpServer } from '../support/smtp-test-server.js';
import { seedTenant, type SeededTenant } from '../support/tenant.js';

import type { EmailLimits, MailConfig } from '../../src/config/index.js';
import type { FieldRow, JsonObject, TableRow } from '../../src/db/schema.js';

const ORG_A: Id<'org'> = 'org_DeliverOrgA00001';
const ORG_B: Id<'org'> = 'org_DeliverOrgB00001';
const AUT: Id<'aut'> = 'aut_DeliverAuto00001';
const RUN: Id<'run'> = 'run_DeliverRun000001';
const PUBLIC_URL = 'https://ob.example.test/';
const SECRET = 'TOPSECRET';

const LIMITS: EmailLimits = {
  maxPerHourPerOrg: 500,
  maxRecipients: 50,
  maxPerSecond: 1000,
  testSendsPerMinute: 5,
  maxHtmlBytes: 100_000,
  allowPrivateSmtpHosts: true,
  maxPerHourPerIdentity: 100,
  automationFooter: 'required',
  maxAttachments: 10,
  maxAttachmentBytes: 15 * 1024 * 1024,
  maxInlineImages: 5,
};

function mailConfig(url: string): MailConfig {
  return {
    url,
    from: 'Cellhive <no-reply@cellhive.test>',
    fromAddress: 'no-reply@cellhive.test',
    fromName: 'Cellhive',
    allowedFromDomains: ['cellhive.test'],
    allowInsecure: true,
  };
}

/** In-memory hourly quota with a switchable limit. */
function memoryQuota(): EmailQuota & { limit: number } {
  const counts = new Map<string, number>();
  const quota = {
    limit: 1_000,
    take(key: string, now = new Date()): Promise<QuotaDecision> {
      const used = counts.get(key) ?? 0;
      if (used >= quota.limit) {
        const next = new Date(Math.floor(now.getTime() / 3_600_000 + 1) * 3_600_000);
        return Promise.resolve({ allowed: false, used, retryAt: next });
      }
      counts.set(key, used + 1);
      return Promise.resolve({ allowed: true, used: used + 1 });
    },
    release(key: string) {
      counts.set(key, Math.max(0, (counts.get(key) ?? 0) - 1));
      return Promise.resolve();
    },
    used(key: string) {
      return Promise.resolve({ used: counts.get(key) ?? 0, resetsAt: new Date() });
    },
  };
  return quota;
}

/** Bytes of a quoted-printable or `Q` encoded string. */
function qpBytes(value: string): Buffer {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const hex = value.slice(i + 1, i + 3);
    if (value[i] === '=' && /^[0-9A-F]{2}$/i.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(value.charCodeAt(i));
    }
  }
  return Buffer.from(bytes);
}

/** RFC 2047 encoded words of a header. */
function decodeHeader(value: string): string {
  return value
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?UTF-8\?([QB])\?([^?]*)\?=/gi, (_match, encoding: string, data: string) =>
      encoding.toUpperCase() === 'B'
        ? Buffer.from(data, 'base64').toString('utf8')
        : qpBytes(data.replace(/_/g, ' ')).toString('utf8'),
    );
}

interface ParsedMail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  header(name: string): string | null;
}

/** Subject and decoded text/HTML parts of a raw `multipart/alternative` message. */
function parseMail(raw: string): ParsedMail {
  const contentType = headerOf(raw, 'Content-Type') ?? '';
  const boundary = /boundary="?([^";]+)"?/.exec(contentType)?.[1] ?? '';
  const parts: Record<string, string> = {};
  for (const part of raw.split(`--${boundary}`).slice(1)) {
    const split = part.search(/\r?\n\r?\n/);
    if (split < 0) continue;
    const head = part.slice(0, split);
    const body = part.slice(split).trim();
    const type = /content-type:\s*([^;\r\n]+)/i.exec(head)?.[1]?.trim() ?? '';
    const encoding = /content-transfer-encoding:\s*(\S+)/i.exec(head)?.[1]?.toLowerCase() ?? '';
    parts[type] =
      encoding === 'base64'
        ? Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8')
        : encoding === 'quoted-printable'
          ? qpBytes(body.replace(/=\r?\n/g, '')).toString('utf8')
          : body;
  }
  return {
    subject: decodeHeader(headerOf(raw, 'Subject') ?? ''),
    text: (parts['text/plain'] ?? '').replace(/\r\n/g, '\n'),
    html: parts['text/html'] ?? '',
    header: (name) => headerOf(raw, name),
  };
}

describe('notification emails (T512)', () => {
  let database: TestDatabase;
  let db: Db;
  let pool: pg.Pool;
  let smtp: TestSmtpServer;
  let mailer: Mailer;
  let quota: ReturnType<typeof memoryQuota>;
  let a: SeededTenant;
  let b: SeededTenant;
  let scopeA: OrgScope;
  let scopeB: OrgScope;
  let table: TableRow;
  let title: FieldRow;
  let secretField: FieldRow;
  let r1: Id<'rec'>;
  let r2: Id<'rec'>;
  let readerRole: Id<'rol'>;
  let clock = new Date('2026-10-05T01:00:00.000Z');
  let delivery: NotificationEmailDelivery;
  const writer = () => new NotificationWriter(db, { emailEnabled: true });
  const outbox = () => new NotificationEmailOutboxRepository(db);

  interface Member {
    readonly id: Id<'usr'>;
    readonly email: string;
  }

  /** A member of A with the base `reader` role. */
  async function newReader(
    key: string,
    profile: { locale?: string; timezone?: string } = {},
  ): Promise<Member> {
    const id = newId('usr');
    const email = `${key}.${id.slice(4, 10).toLowerCase()}@example.test`;
    await db.kysely
      .insertInto('meta.users')
      .values({
        id,
        email,
        display_name: `User ${key}`,
        locale: profile.locale ?? null,
        timezone: profile.timezone ?? null,
      })
      .execute();
    await db.kysely
      .insertInto('meta.org_members')
      .values({ organization_id: ORG_A, user_id: id, role: 'member' })
      .execute();
    await new BaseRoleMembersRepository(db).assign(scopeA, {
      baseId: a.baseId,
      roleId: readerRole,
      principalType: 'user',
      principalId: id,
    });
    return { id, email };
  }

  const message = (
    userId: Id<'usr'>,
    text: string,
    overrides: Partial<PreparedNotification> = {},
  ): PreparedNotification => ({
    userId,
    type: 'automation.message',
    baseId: a.baseId,
    tableId: table.id,
    entityType: 'record',
    entityId: r1,
    actor: null,
    groupKey: null,
    data: { automation_id: AUT, run_id: RUN, title: text, body: `Body of ${text}` },
    ...overrides,
  });

  const disabled = (userId: Id<'usr'>, baseId: Id<'bse'> | null = null): PreparedNotification => ({
    userId,
    type: 'automation.disabled',
    baseId: baseId ?? a.baseId,
    tableId: null,
    entityType: 'automation',
    entityId: AUT,
    actor: null,
    groupKey: null,
    data: { automation_id: AUT, reason: 'circuit_breaker' },
  });

  async function notify(items: readonly PreparedNotification[], org: Id<'org'> = ORG_A) {
    const written = await db.withTx((tx) => writer().write(tx, org, items));
    return written.map((row) => row.id as Id<'ntf'>);
  }

  async function statuses(ids: readonly Id<'ntf'>[]) {
    const rows = await db.kysely
      .selectFrom('meta.notification_deliveries')
      .select(['notification_id', 'status', 'error_code', 'attempts'])
      .where('notification_id', 'in', [...ids])
      .execute();
    return ids.map((id) => {
      const row = rows.find((item) => item.notification_id === id);
      return row === undefined ? null : [row.status, row.error_code];
    });
  }

  async function deliverJobs(userId: Id<'usr'>) {
    const { rows } = await sql<{ payload: Record<string, unknown>; run_at: Date }>`
      SELECT payload, jobs.run_at
        FROM graphile_worker.jobs JOIN graphile_worker._private_jobs USING (id)
       WHERE jobs.task_identifier = 'notifications.deliver'
         AND jobs.key = ${`notifications.deliver:${ORG_A}:${userId}`}
    `.execute(db.kysely);
    return rows;
  }

  async function clearJobs(userId: Id<'usr'>) {
    await sql`SELECT graphile_worker.remove_job(${`notifications.deliver:${ORG_A}:${userId}`})`.execute(
      db.kysely,
    );
  }

  const mailsTo = (member: Member) =>
    smtp.messages.filter((mail) => mail.to.includes(member.email)).map((mail) => mail.raw);

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    pool = new pg.Pool({ connectionString: database.url, max: 2 });
    a = await seedTenant(db, ORG_A);
    b = await seedTenant(db, ORG_B);
    scopeA = orgScope(ORG_A);
    scopeB = orgScope(ORG_B);
    await db.kysely
      .insertInto('meta.org_members')
      .values([
        { organization_id: ORG_A, user_id: a.userId, role: 'owner' },
        { organization_id: ORG_B, user_id: b.userId, role: 'owner' },
      ])
      .execute();

    const schema = new SchemaService(db, { maxFieldsPerTable: 500 });
    const created = await schema.createTable(
      scopeA,
      { baseId: a.baseId, name: 'Orders', primaryFieldName: 'title' },
      systemAuditContext(),
    );
    table = created.table;
    title = created.primaryField;
    const secret = await schema.addField(
      scopeA,
      table.id,
      { name: 'secret', type: 'text', options: {} },
      systemAuditContext(),
    );
    secretField = secret;
    [r1, r2] = (await insertRows(pool, table, [
      {
        [title.db_column_name as string]: 'Order R1',
        [secret.db_column_name as string]: `${SECRET}-1`,
      },
      {
        [title.db_column_name as string]: 'Order R2',
        [secret.db_column_name as string]: `${SECRET}-2`,
      },
    ])) as [Id<'rec'>, Id<'rec'>];
    const role = await new BaseRolesRepository(db).create(scopeA, {
      baseId: a.baseId,
      name: 'Reader',
      kind: 'system_reader',
      config: systemRoleConfig('reader', {
        tables: [
          {
            id: table.id,
            fields: [title, secret].map((field) => ({ id: field.id, type: field.type })),
          },
        ],
        dashboards: [],
      }) as unknown as JsonObject,
    });
    readerRole = role.id;

    smtp = await startTestSmtp();
    quota = memoryQuota();
    mailer = createMailService({ mail: mailConfig(smtp.url), email: LIMITS }, { orgQuota: quota });
    delivery = new NotificationEmailDelivery(db, new RecordQueryService(db), mailer, {
      publicUrl: PUBLIC_URL,
      messageIdDomain: 'cellhive.test',
      maxHtmlBytes: LIMITS.maxHtmlBytes,
      defaults: { timeZone: 'UTC', locale: 'en' },
      now: () => clock,
    });
  });

  afterAll(async () => {
    mailer.close();
    await smtp.close();
    await pool.end();
    await db.destroy();
    await database.drop();
  });

  it('immediate: 3 notifications within 5 minutes → one job, one email with the mandatory headers', async () => {
    const reader = await newReader('batch', { locale: 'vi', timezone: 'Asia/Ho_Chi_Minh' });
    const before = Date.now();
    const ids = [
      ...(await notify([message(reader.id, 'Tin A')])),
      ...(await notify([message(reader.id, 'Tin B')])),
      ...(await notify([message(reader.id, 'Tin C')])),
    ];
    // One job per recipient, 5 minutes after the first queued email.
    const jobs = await deliverJobs(reader.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toEqual({
      organization_id: ORG_A,
      user_id: reader.id,
      reason: 'immediate',
    });
    const runAt = jobs[0]?.run_at.getTime() ?? 0;
    expect(runAt).toBeGreaterThanOrEqual(before + 5 * 60_000 - 1_000);
    expect(runAt).toBeLessThanOrEqual(before + 5 * 60_000 + 30_000);

    const outcome = await delivery.deliver({
      organization_id: ORG_A,
      user_id: reader.id,
      reason: 'immediate',
    });
    expect(outcome).toMatchObject({ status: 'sent', sent: 3, more: false });
    const mails = mailsTo(reader);
    expect(mails).toHaveLength(1);
    const mail = parseMail(mails[0] ?? '');
    expect(mail.header('Auto-Submitted')).toBe('auto-generated');
    expect(mail.header('X-Auto-Response-Suppress')).toBe('OOF, AutoReply');
    expect(mail.header('X-Cellhive-Automation')).toBeNull();
    expect(mail.header('Sender')).toBeNull();
    expect(mail.header('From')).toContain('no-reply@cellhive.test');
    expect(mail.header('Content-Type')).toContain('multipart/alternative');
    expect(mail.header('Message-ID')).toBe(
      deterministicMessageId(
        [...ids]
          .sort()
          .map((id) => `${id}:email`)
          .join(','),
        'cellhive.test',
      ),
    );
    // Recipient's language and content: rendered messages, primary field only.
    expect(mail.subject).toBe('3 thông báo mới');
    for (const part of [
      'Tin A',
      'Tin B',
      'Body of Tin C',
      'Bản ghi: Order R1',
      'Quản lý thông báo',
    ]) {
      expect(mail.text).toContain(part);
    }
    // "Manage notifications": the recipient's settings in this organization (T524).
    const { rows } = await pool.query<{ slug: string }>(
      'SELECT slug FROM meta.organizations WHERE id = $1',
      [ORG_A],
    );
    expect(mail.text).toContain(
      `https://ob.example.test/o/${rows[0]?.slug ?? ''}/settings/notifications`,
    );
    expect(mail.html).toContain(
      `href="https://ob.example.test/b/${a.baseId}/t/${table.id}?record=${r1}"`,
    );
    expect(mails[0]).not.toContain(SECRET);
    expect(await statuses(ids)).toEqual([
      ['sent', null],
      ['sent', null],
      ['sent', null],
    ]);

    // Idempotent: a second run (retry, duplicate job) sends nothing.
    expect(
      await delivery.deliver({ organization_id: ORG_A, user_id: reader.id, reason: 'immediate' }),
    ).toEqual({ status: 'nothing' });
    expect(mailsTo(reader)).toHaveLength(1);
  });

  it('daily at 08:00 Asia/Ho_Chi_Minh → one summary, nothing when nothing is pending', async () => {
    const reader = await newReader('daily', { timezone: 'Asia/Ho_Chi_Minh' });
    await new NotificationSettingsRepository(db).upsert(scopeA, reader.id, {
      emailFrequency: 'daily',
      dailyHour: 8,
    });
    const ids = [
      ...(await notify([message(reader.id, 'Morning')])),
      ...(await notify([disabled(reader.id)])),
    ];
    // A daily recipient gets no 5-minute batch job.
    expect(await deliverJobs(reader.id)).toEqual([]);
    // An immediate run (e.g. scheduled before the switch) leaves them for the summary.
    expect(
      await delivery.deliver({ organization_id: ORG_A, user_id: reader.id, reason: 'immediate' }),
    ).toEqual({ status: 'waiting_for_digest', pending: 2 });

    const defaults = { timeZone: 'UTC', locale: 'en' };
    // 07:00 in Ho Chi Minh City: not yet.
    await sweepDailyDigests(db, { now: new Date('2026-10-05T00:00:00.000Z'), defaults });
    expect(await deliverJobs(reader.id)).toEqual([]);
    // 08:00: the summary is due.
    clock = new Date('2026-10-05T01:00:00.000Z');
    await sweepDailyDigests(db, { now: clock, defaults });
    const jobs = await deliverJobs(reader.id);
    expect(jobs.map((job) => job.payload)).toEqual([
      { organization_id: ORG_A, user_id: reader.id, reason: 'daily' },
    ]);
    await clearJobs(reader.id);

    expect(
      await delivery.deliver({ organization_id: ORG_A, user_id: reader.id, reason: 'daily' }),
    ).toMatchObject({ status: 'sent', sent: 2 });
    const mails = mailsTo(reader);
    expect(mails).toHaveLength(1);
    const mail = parseMail(mails[0] ?? '');
    expect(mail.subject).toBe('Daily summary for 5 Oct 2026: 2 notifications');
    expect(mail.text).toContain('Morning');
    expect(mail.text).toContain('turned off after failing repeatedly');
    expect(await statuses(ids)).toEqual([
      ['sent', null],
      ['sent', null],
    ]);

    // Nothing pending: no job, no email.
    await sweepDailyDigests(db, { now: clock, defaults });
    expect(await deliverJobs(reader.id)).toEqual([]);
    expect(
      await delivery.deliver({ organization_id: ORG_A, user_id: reader.id, reason: 'daily' }),
    ).toEqual({ status: 'nothing' });
    expect(mailsTo(reader)).toHaveLength(1);

    // A missed hour: the summary goes out once the oldest email waited 25 hours.
    const [late] = await notify([message(reader.id, 'Late')]);
    await sweepDailyDigests(db, { now: new Date('2026-10-05T05:00:00.000Z'), defaults });
    expect(await deliverJobs(reader.id)).toEqual([]);
    await db.kysely
      .updateTable('meta.notification_deliveries')
      .set({ created_at: new Date('2026-10-04T03:00:00.000Z') } as never)
      .where('notification_id', '=', late as Id<'ntf'>)
      .execute();
    await sweepDailyDigests(db, { now: new Date('2026-10-05T05:00:00.000Z'), defaults });
    expect((await deliverJobs(reader.id)).map((job) => job.payload['reason'])).toEqual(['daily']);
    await clearJobs(reader.id);
  });

  it('off → no email; the email preference turned off later → skipped', async () => {
    const reader = await newReader('off');
    const [first] = await notify([message(reader.id, 'Before off')]);
    await new NotificationSettingsRepository(db).upsert(scopeA, reader.id, {
      emailFrequency: 'off',
      dailyHour: 8,
    });
    expect(
      await delivery.deliver({ organization_id: ORG_A, user_id: reader.id, reason: 'immediate' }),
    ).toEqual({ status: 'skipped', skipped: { email_off: 1 }, more: false });
    // While off, nothing is even queued (T511 writer).
    expect(await notify([message(reader.id, 'While off')])).toHaveLength(1);
    expect(
      await delivery.deliver({ organization_id: ORG_A, user_id: reader.id, reason: 'immediate' }),
    ).toEqual({ status: 'nothing' });

    await new NotificationSettingsRepository(db).upsert(scopeA, reader.id, {
      emailFrequency: 'immediate',
      dailyHour: 8,
    });
    const [second] = await notify([message(reader.id, 'Pref')]);
    await new NotificationPreferencesRepository(db).upsert(scopeA, reader.id, [
      { type: 'automation.message', channel: 'email', enabled: false },
    ]);
    expect(
      await delivery.deliver({ organization_id: ORG_A, user_id: reader.id, reason: 'immediate' }),
    ).toEqual({ status: 'skipped', skipped: { preference_off: 1 }, more: false });
    expect(mailsTo(reader)).toEqual([]);
    expect(await statuses([first as Id<'ntf'>, second as Id<'ntf'>])).toEqual([
      ['skipped', 'email_off'],
      ['skipped', 'preference_off'],
    ]);
  });

  it('a muted base → nothing from that base; organization-level and mandatory ones still sent', async () => {
    const reader = await newReader('mute');
    const ids = await notify([
      message(reader.id, 'From the base'),
      message(reader.id, 'Org level', {
        baseId: null,
        tableId: null,
        entityType: 'automation',
        entityId: AUT,
      }),
      disabled(reader.id),
    ]);
    await new NotificationBaseMutesRepository(db).mute(scopeA, reader.id, a.baseId);
    expect(
      await delivery.deliver({ organization_id: ORG_A, user_id: reader.id, reason: 'immediate' }),
    ).toMatchObject({ status: 'sent', sent: 2, skipped: { muted: 1 } });
    const mail = parseMail(mailsTo(reader)[0] ?? '');
    expect(mail.text).not.toContain('From the base');
    expect(mail.text).toContain('Org level');
    expect(mail.text).toContain('turned off');
    expect(await statuses(ids)).toEqual([
      ['skipped', 'muted'],
      ['sent', null],
      ['sent', null],
    ]);
  });

  it('access lost before sending → the item is left out (record trashed, role removed)', async () => {
    const reader = await newReader('lost');
    const ids = await notify([
      message(reader.id, 'About R1'),
      message(reader.id, 'About R2', { entityId: r2 }),
    ]);
    await pool.query(
      `UPDATE data.${pg.escapeIdentifier(table.db_table_name)} SET __deleted_at = now() WHERE __id = $1`,
      [r2],
    );
    expect(
      await delivery.deliver({ organization_id: ORG_A, user_id: reader.id, reason: 'immediate' }),
    ).toMatchObject({ status: 'sent', sent: 1, skipped: { cannot_read_record: 1 } });
    const mail = parseMail(mailsTo(reader)[0] ?? '');
    expect(mail.text).toContain('About R1');
    expect(mail.text).not.toContain('About R2');
    expect(mail.text).not.toContain('Order R2');
    expect(await statuses(ids)).toEqual([
      ['sent', null],
      ['skipped', 'cannot_read_record'],
    ]);
    await pool.query(
      `UPDATE data.${pg.escapeIdentifier(table.db_table_name)} SET __deleted_at = NULL WHERE __id = $1`,
      [r2],
    );

    // The role is removed: nothing of the base is sent, no empty email.
    const gone = await newReader('gone');
    const goneIds = await notify([message(gone.id, 'Gone'), disabled(gone.id)]);
    await new BaseRoleMembersRepository(db).remove(scopeA, a.baseId, 'user', gone.id);
    expect(
      await delivery.deliver({ organization_id: ORG_A, user_id: gone.id, reason: 'immediate' }),
    ).toEqual({ status: 'skipped', skipped: { cannot_read_base: 2 }, more: false });
    expect(mailsTo(gone)).toEqual([]);
    expect(await statuses(goneIds)).toEqual([
      ['skipped', 'cannot_read_base'],
      ['skipped', 'cannot_read_base'],
    ]);

    // Not a member any more: rows go with the membership (FK cascade).
    const left = await newReader('left');
    const [leftId] = await notify([message(left.id, 'Left')]);
    await db.kysely
      .deleteFrom('meta.org_members')
      .where('organization_id', '=', ORG_A)
      .where('user_id', '=', left.id)
      .execute();
    expect(await statuses([leftId as Id<'ntf'>])).toEqual([null]);
  });

  it('S5b types (T542): grouped assignment, follow, reminder, import; fields checked now', async () => {
    const reader = await newReader('s5b', { locale: 'en', timezone: 'Asia/Ho_Chi_Minh' });
    // A member whose role hides `secret` (title readable).
    const partialRole = await new BaseRolesRepository(db).create(scopeA, {
      baseId: a.baseId,
      name: 'No secret',
      kind: 'custom',
      config: roleConfigSchema.parse({
        tables: {
          [table.id]: {
            perm: 'read_only',
            field_rule: {
              mode: 'specify',
              fields: { [secretField.id]: 'no_perm' },
              option_edit_fields: [],
              file_download_fields: [],
            },
          },
        },
      }) as unknown as JsonObject,
    });
    const partialId = newId('usr');
    const partial = {
      id: partialId,
      email: `partial.${partialId.slice(4, 10).toLowerCase()}@example.test`,
    };
    await db.kysely
      .insertInto('meta.users')
      .values({ id: partial.id, email: partial.email, display_name: 'Partial' })
      .execute();
    await db.kysely
      .insertInto('meta.org_members')
      .values({ organization_id: ORG_A, user_id: partial.id, role: 'member' })
      .execute();
    await new BaseRoleMembersRepository(db).assign(scopeA, {
      baseId: a.baseId,
      roleId: partialRole.id,
      principalType: 'user',
      principalId: partial.id,
    });

    const JOB: Id<'job'> = 'job_DeliverImport001';
    const GONE: Id<'rec'> = 'rec_DeliverGoneRec01';
    const s5b = (userId: Id<'usr'>): PreparedNotification[] => [
      {
        userId,
        type: 'record.assigned',
        baseId: a.baseId,
        tableId: table.id,
        entityType: 'table',
        entityId: table.id,
        actor: null,
        groupKey: null,
        data: { batch_id: JOB, count: 3, record_ids: [r1, r2, GONE], field_ids: [title.id] },
      },
      {
        userId,
        type: 'record.assigned',
        baseId: a.baseId,
        tableId: table.id,
        entityType: 'record',
        entityId: r1,
        actor: null,
        groupKey: null,
        data: { batch_id: null, count: 1, record_ids: [r1], field_ids: [title.id] },
      },
      {
        userId,
        type: 'record.assigned',
        baseId: a.baseId,
        tableId: table.id,
        entityType: 'table',
        entityId: table.id,
        actor: null,
        groupKey: null,
        // None of the records can be read any more.
        data: { batch_id: 'req_x', count: 1, record_ids: [GONE], field_ids: [title.id] },
      },
      {
        userId,
        type: 'record.followed_changed',
        baseId: a.baseId,
        tableId: table.id,
        entityType: 'record',
        entityId: r1,
        actor: null,
        groupKey: null,
        data: { field_ids: [secretField.id], change_count: 2, actor_ids: [] },
      },
      {
        userId,
        type: 'date.reminder',
        baseId: a.baseId,
        tableId: table.id,
        entityType: 'record',
        entityId: r2,
        actor: null,
        groupKey: null,
        data: { field_id: secretField.id, due_at: '2026-10-20T02:00:00.000Z', value: '2026-10-20' },
      },
      {
        userId,
        type: 'import.finished',
        baseId: a.baseId,
        tableId: table.id,
        entityType: 'job',
        entityId: JOB,
        actor: null,
        groupKey: null,
        data: { job_id: JOB, status: 'succeeded', created: 5, updated: 1, failed_rows: 2 },
      },
    ];

    // Email of these two types is off by default (CONTRACTS §22.1): turned on.
    for (const userId of [reader.id, partial.id]) {
      await new NotificationPreferencesRepository(db).upsert(scopeA, userId, [
        { type: 'record.followed_changed', channel: 'email', enabled: true },
        { type: 'import.finished', channel: 'email', enabled: true },
      ]);
    }
    const readerIds = await notify(s5b(reader.id));
    expect(
      await delivery.deliver({ organization_id: ORG_A, user_id: reader.id, reason: 'immediate' }),
    ).toEqual({ status: 'sent', sent: 5, skipped: { cannot_read_record: 1 }, more: false });
    const mail = parseMail(mailsTo(reader)[0] ?? '');
    const tableUrl = `https://ob.example.test/b/${a.baseId}/t/${table.id}`;
    for (const part of [
      'You were assigned 3 records in “Orders”',
      `Order R1 (${tableUrl}?record=${r1})`,
      `Order R2 (${tableUrl}?record=${r2})`,
      'And 1 more',
      'You were assigned a record in “Orders”',
      'A record you follow was changed (2 changes)',
      'Reminder: “secret” is due 20 Oct 2026',
      'Import into “Orders” finished: 5 created, 1 updated, 2 rows failed',
      `Open in Cellhive (${tableUrl})`,
    ]) {
      expect(mail.text).toContain(part);
    }
    // Only primary fields: never another value of the record.
    expect(mail.text).not.toContain(SECRET);
    expect(mail.html).not.toContain(SECRET);
    expect(await statuses(readerIds)).toEqual([
      ['sent', null],
      ['sent', null],
      ['skipped', 'cannot_read_record'],
      ['sent', null],
      ['sent', null],
      ['sent', null],
    ]);

    // Without the date field / any changed field: those two are left out.
    const partialIds = await notify(s5b(partial.id));
    expect(
      await delivery.deliver({ organization_id: ORG_A, user_id: partial.id, reason: 'immediate' }),
    ).toMatchObject({
      status: 'sent',
      sent: 3,
      skipped: { cannot_read_record: 1, cannot_read_field: 2 },
    });
    const partialMail = parseMail(mailsTo(partial)[0] ?? '');
    expect(partialMail.text).not.toContain('follow');
    expect(partialMail.text).not.toContain('Reminder');
    expect(partialMail.text).not.toContain('“secret”');
    expect(await statuses(partialIds)).toEqual([
      ['sent', null],
      ['sent', null],
      ['skipped', 'cannot_read_record'],
      ['skipped', 'cannot_read_field'],
      ['skipped', 'cannot_read_field'],
      ['sent', null],
    ]);
  });

  it('import.finished (T548) links the report of failed rows only for its importer, while it lasts', async () => {
    const importer = await newReader('importer');
    const jobs = new JobsRepository(db);
    /** A succeeded import job with a report of failed rows expiring at `expiresAt`. */
    const importJob = async (createdBy: Id<'usr'>, expiresAt: Date, type = 'table.import') => {
      const job = await jobs.create(scopeA, { type, createdBy });
      await jobs.markRunning(scopeA, job.id);
      await jobs.markSucceeded(scopeA, job.id, {
        mode: 'append',
        table_id: table.id,
        rows: 12,
        imported: 10,
        failed: 2,
        errors: [],
        errors_truncated: false,
        download_url: `/api/v1/files/exports/${job.id}`,
        expires_at: expiresAt.toISOString(),
      });
      return job.id;
    };
    const later = new Date(clock.getTime() + 24 * 3_600_000);
    const own = await importJob(importer.id, later);
    const someoneElses = await importJob(a.userId, later);
    const expired = await importJob(importer.id, new Date(clock.getTime() - 1));
    const notAnImport = await importJob(importer.id, later, 'base.export');
    const finished = (jobId: Id<'job'>): PreparedNotification => ({
      userId: importer.id,
      type: 'import.finished',
      baseId: a.baseId,
      tableId: table.id,
      entityType: 'job',
      entityId: jobId,
      actor: { type: 'user', id: importer.id },
      groupKey: jobId,
      data: { job_id: jobId, status: 'succeeded', created: 10, updated: 0, failed_rows: 2 },
    });
    // Email of import.finished is off by default (CONTRACTS §22.1).
    const off = await notify([finished(own)]);
    expect(off).toEqual([expect.stringMatching(/^ntf_/)]);
    expect(await statuses(off)).toEqual([null]);
    await db.kysely.deleteFrom('meta.notifications').where('id', 'in', off).execute();

    await new NotificationPreferencesRepository(db).upsert(scopeA, importer.id, [
      { type: 'import.finished', channel: 'email', enabled: true },
    ]);
    const ids = await notify([own, someoneElses, expired, notAnImport].map(finished));
    expect(
      await delivery.deliver({ organization_id: ORG_A, user_id: importer.id, reason: 'immediate' }),
    ).toEqual({ status: 'sent', sent: 4, skipped: {}, more: false });
    expect(await statuses(ids)).toEqual(ids.map(() => ['sent', null]));
    const mail = parseMail(mailsTo(importer)[0] ?? '');
    const report = (jobId: Id<'job'>) => `https://ob.example.test/api/v1/files/exports/${jobId}`;
    expect(mail.text).toContain(
      `Download the report of the rows that failed (available for 24 hours) (${report(own)})`,
    );
    expect(mail.html).toContain(`href="${report(own)}"`);
    for (const jobId of [someoneElses, expired, notAnImport]) {
      expect(mail.text).not.toContain(report(jobId));
    }
    expect(mail.text.match(/Download the report/g)).toHaveLength(1);
    expect(mail.text).toContain(
      'Import into “Orders” finished: 10 created, 0 updated, 2 rows failed',
    );
  });

  it('without SMTP every pending email is skipped silently', async () => {
    const reader = await newReader('nosmtp');
    const ids = await notify([message(reader.id, 'No SMTP')]);
    const noSmtp = new NotificationEmailDelivery(db, new RecordQueryService(db), null, {
      publicUrl: PUBLIC_URL,
      messageIdDomain: null,
      maxHtmlBytes: LIMITS.maxHtmlBytes,
      defaults: { timeZone: 'UTC', locale: 'en' },
    });
    expect(
      await noSmtp.deliver({ organization_id: ORG_A, user_id: reader.id, reason: 'immediate' }),
    ).toEqual({ status: 'skipped', skipped: { smtp_not_configured: 1 }, more: false });
    expect(await statuses(ids)).toEqual([['skipped', 'smtp_not_configured']]);
    // In-app is untouched.
    const row = await db.kysely
      .selectFrom('meta.notifications')
      .select(['in_app', 'read_at'])
      .where('id', '=', ids[0] as Id<'ntf'>)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ in_app: true, read_at: null });
  });

  it('SMTP 5xx fails at once; 4xx is retried and fails after 5 attempts', async () => {
    let reply: { code: number; message: string } | null = { code: 550, message: 'No' };
    const failing = await startTestSmtp({ data: () => reply });
    const failingMailer = createMailService({ mail: mailConfig(failing.url), email: LIMITS });
    const failingDelivery = new NotificationEmailDelivery(
      db,
      new RecordQueryService(db),
      failingMailer,
      {
        publicUrl: PUBLIC_URL,
        messageIdDomain: 'cellhive.test',
        maxHtmlBytes: LIMITS.maxHtmlBytes,
        defaults: { timeZone: 'UTC', locale: 'en' },
      },
    );
    try {
      const rejected = await newReader('rejected');
      const ids = await notify([message(rejected.id, 'Rejected')]);
      const outcome = await failingDelivery.deliver({
        organization_id: ORG_A,
        user_id: rejected.id,
        reason: 'immediate',
      });
      expect(outcome).toMatchObject({ status: 'failed', failed: 1 });
      expect(outcome.status === 'failed' && outcome.error.code).toBe('smtp_rejected');
      expect(await statuses(ids)).toEqual([['failed', 'smtp_rejected']]);

      reply = { code: 451, message: 'Later' };
      const temporary = await newReader('temporary');
      const tempIds = await notify([message(temporary.id, 'Temporary')]);
      for (let attempt = 1; attempt < 5; attempt += 1) {
        expect(
          await failingDelivery.deliver({
            organization_id: ORG_A,
            user_id: temporary.id,
            reason: 'immediate',
          }),
        ).toMatchObject({ status: 'retry', attempts: attempt });
      }
      expect(await statuses(tempIds)).toEqual([['pending', 'smtp_temporary']]);
      expect(
        await failingDelivery.deliver({
          organization_id: ORG_A,
          user_id: temporary.id,
          reason: 'immediate',
        }),
      ).toMatchObject({ status: 'failed', failed: 1 });
      expect(await statuses(tempIds)).toEqual([['failed', 'smtp_temporary']]);
      expect(failing.messages).toEqual([]);
    } finally {
      failingMailer.close();
      await failing.close();
    }
  });

  it('the hourly organization quota defers the email to the next hour, up to 24 hours', async () => {
    const reader = await newReader('quota');
    const ids = await notify([message(reader.id, 'Over quota')]);
    await clearJobs(reader.id);
    quota.limit = 0;
    try {
      const outcome = await delivery.deliver({
        organization_id: ORG_A,
        user_id: reader.id,
        reason: 'immediate',
      });
      expect(outcome.status).toBe('deferred');
      const jobs = await deliverJobs(reader.id);
      expect(jobs).toHaveLength(1);
      expect((jobs[0]?.run_at.getTime() ?? 1) % 3_600_000).toBe(0);
      expect(await statuses(ids)).toEqual([['pending', null]]);

      // Waiting more than 24 hours: the delivery fails.
      await db.kysely
        .updateTable('meta.notification_deliveries')
        .set({ created_at: new Date(Date.now() - 25 * 3_600_000) } as never)
        .where('notification_id', '=', ids[0] as Id<'ntf'>)
        .execute();
      expect(
        await delivery.deliver({ organization_id: ORG_A, user_id: reader.id, reason: 'immediate' }),
      ).toMatchObject({ status: 'failed', failed: 1 });
      expect(await statuses(ids)).toEqual([['failed', 'email_quota_exceeded']]);
    } finally {
      quota.limit = 1_000;
      await clearJobs(reader.id);
    }
    expect(mailsTo(reader)).toEqual([]);
  });

  it('isolates the outbox by organization; the sweep lookup returns ids only', async () => {
    const [inB] = await notify(
      [
        {
          ...disabled(b.userId, b.baseId),
        },
      ],
      ORG_B,
    );
    const idB = inB as Id<'ntf'>;
    const repo = outbox();
    // Scope A never sees, locks or changes a row of B.
    await db.withTx(async (tx) => {
      expect(await repo.lockPending(orgScope(ORG_A, tx), b.userId, 10)).toEqual([]);
    });
    expect(await repo.oldestPending(scopeA, [b.userId])).toEqual(new Map());
    expect(await repo.markSent(scopeA, [idB], new Date())).toBe(0);
    expect(await repo.markSkipped(scopeA, [idB], 'muted')).toBe(0);
    expect(await repo.markFailed(scopeA, [idB], 'smtp_rejected')).toBe(0);
    expect(await repo.recordAttempt(scopeA, [idB], 'smtp_temporary')).toBe(0);
    expect(await statuses([idB])).toEqual([['pending', null]]);
    await db.withTx(async (tx) => {
      const rows = await repo.lockPending(orgScope(ORG_B, tx), b.userId, 10);
      expect(rows.map((row) => row.notification_id)).toEqual([idB]);
    });
    expect((await repo.oldestPending(scopeB, [b.userId])).has(b.userId)).toBe(true);

    const pending = await listPendingEmailRecipients(db.kysely, { after: null, limit: 1_000 });
    expect(pending).toContainEqual({ organizationId: ORG_B, userId: b.userId });
    expect(Object.keys(pending[0] ?? {}).sort()).toEqual(['organizationId', 'userId']);
    const afterB = await listPendingEmailRecipients(db.kysely, {
      after: { organizationId: ORG_B, userId: b.userId },
      limit: 1_000,
    });
    expect(afterB).not.toContainEqual({ organizationId: ORG_B, userId: b.userId });

    // The owner of B (immediate, waiting longer than the batch): the sweep queues a run.
    await db.kysely
      .updateTable('meta.notification_deliveries')
      .set({ created_at: new Date(Date.now() - 10 * 60_000) } as never)
      .where('notification_id', '=', idB)
      .execute();
    const result = await sweepDailyDigests(db, {
      now: new Date(),
      defaults: { timeZone: 'UTC', locale: 'en' },
    });
    expect(result.immediate).toBeGreaterThanOrEqual(1);
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM graphile_worker.jobs
       WHERE key = ${`notifications.deliver:${ORG_B}:${b.userId}`}
    `.execute(db.kysely);
    expect(rows[0]?.n).toBe(1);
  });
});
