import { once } from 'node:events';

import {
  automationEmailPreviewSchema,
  automationEmailTestResultSchema,
  automationRunDetailSchema,
  emailIdentityUsagesSchema,
  emailSettingsSchema,
  newId,
  SEND_EMAIL_ERROR_MAX_REJECTED,
  sendEmailRecipientErrorParamsSchema,
  type Id,
} from '@cellhive/contracts';
import {
  AutomationRunEngine,
  AutomationTimeTriggers,
  AutomationRunsRepository,
  AutomationRunStepsRepository,
  AutomationsRepository,
  BaseRolesRepository,
  createMailService,
  createSendEmailAction,
  createValkeyEmailQuota,
  defaultActionRegistry,
  defaultTransportFactory,
  deriveSecretKey,
  deterministicMessageId,
  EmailIdentitiesRepository,
  NO_AUTOMATION_NOTIFICATIONS,
  OrganizationsRepository,
  orgScope,
  RecordMutationService,
  RecordQueryService,
  SchemaService,
  sealSecret,
  systemAuditContext,
  valkeyQuotaClient,
  type AutomationRunEngineOptions,
  type Db,
  type DeferrableJob,
  type EmailQuota,
  type FieldRow,
  type JsonObject,
  type Mailer,
  type TransportFactory,
} from '@cellhive/server-core';
import { sql } from 'kysely';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createCacheClient } from '../../src/common/infra/connections.js';

import { decodeQuotedPrintable } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import {
  buildRecordFixture,
  expectProblem,
  type FixtureUser,
  type RecordFixture,
} from './record-fixture.js';
import {
  captureLogger,
  problemOf,
  startTestApp,
  TEST_PUBLIC_URL,
  type TestApp,
} from './support.js';

import type { AddressInfo } from 'node:net';

interface ReceivedMail {
  readonly from: string;
  readonly to: readonly string[];
  readonly raw: string;
  readonly user: string | null;
}

/**
 * An in-process SMTP server (no TLS); `failData` answers the next DATA
 * commands with `451`; `RCPT TO` a mailbox whose local part starts with
 * `gone` is refused `550 5.1.1` (QA S5 L1).
 */
async function startSmtp(auth?: { user: string; pass: string }) {
  const messages: ReceivedMail[] = [];
  const control = { failData: 0 };
  const server = new SMTPServer({
    logger: false,
    disabledCommands: auth === undefined ? ['STARTTLS', 'AUTH'] : ['STARTTLS'],
    authOptional: auth === undefined,
    allowInsecureAuth: true,
    closeTimeout: 100,
    onRcptTo(address, _session, callback) {
      if (address.address.startsWith('gone')) {
        callback(
          Object.assign(new Error(`5.1.1 <${address.address}>: no such user`), {
            responseCode: 550,
          }),
        );
        return;
      }
      callback();
    },
    onAuth(input, _session, callback) {
      if (auth !== undefined && input.username === auth.user && input.password === auth.pass) {
        callback(null, { user: input.username });
        return;
      }
      callback(Object.assign(new Error('Invalid credentials'), { responseCode: 535 }));
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        if (control.failData > 0) {
          control.failData -= 1;
          callback(Object.assign(new Error('Try again later'), { responseCode: 451 }));
          return;
        }
        messages.push({
          from: session.envelope.mailFrom === false ? '' : session.envelope.mailFrom.address,
          to: session.envelope.rcptTo.map((rcpt) => rcpt.address),
          raw: Buffer.concat(chunks).toString('utf8'),
          user: typeof session.user === 'string' ? session.user : null,
        });
        callback();
      });
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server.server, 'listening');
  const { port } = server.server.address() as AddressInfo;
  return {
    port,
    url: `smtp://127.0.0.1:${String(port)}`,
    messages,
    control,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

function headerOf(raw: string, name: string): string | null {
  const head = raw.split(/\r?\n\r?\n/)[0] ?? '';
  const unfolded = head.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon > 0 && line.slice(0, colon).toLowerCase() === name.toLowerCase()) {
      return line.slice(colon + 1).trim();
    }
  }
  return null;
}

/** RFC 2047 encoded words of a header, decoded. */
function decodeHeader(value: string | null): string {
  return (value ?? '')
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?utf-8\?([qb])\?([^?]*)\?=/gi, (_match, kind: string, text: string) =>
      kind.toLowerCase() === 'b'
        ? Buffer.from(text, 'base64').toString('utf8')
        : Buffer.from(decodeQuotedPrintable(text.replaceAll('_', ' ')), 'latin1').toString('utf8'),
    );
}

/** The decoded text of a raw message (both parts, quoted-printable undone). */
function bodyOf(raw: string): string {
  const body = raw
    .split(/\r?\n\r?\n/)
    .slice(1)
    .join('\n\n');
  return Buffer.from(decodeQuotedPrintable(body), 'latin1').toString('utf8');
}

/** The decoded `text/html` part of a raw `multipart/alternative` message. */
function htmlOf(raw: string): string {
  const start = raw.search(/Content-Type: text\/html/i);
  if (start === -1) return '';
  const rest = raw.slice(start);
  const bodyStart = rest.search(/\r?\n\r?\n/);
  const end = rest.indexOf('\n--', bodyStart);
  const part = rest.slice(bodyStart, end === -1 ? undefined : end);
  return Buffer.from(decodeQuotedPrintable(part), 'latin1').toString('utf8');
}

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

const IDENTITY_HOST = 'smtp.corp.test';
const IT_PASSWORD = 'It-Mailbox-Secret-77';

/**
 * BACKLOG T514 (`send_email`, ADR-32 §3, ADR-33, CONTRACTS §21/§23): the
 * handler of the run engine against in-process SMTP servers (instance SMTP
 * and a sender identity's own SMTP), the save-time checks through the API,
 * preview and "Send a test to me" with the editor's permissions, identity
 * usages and the system-sender count.
 */
describe('send_email (T514)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let other: RecordFixture;
  let instance: Awaited<ReturnType<typeof startSmtp>>;
  let identitySmtp: Awaited<ReturnType<typeof startSmtp>>;
  let records: RecordMutationService;
  let query: RecordQueryService;
  let mailer: Mailer;
  let contact: FieldRow;
  const ids = {} as Record<
    'onBehalf' | 'sendAs' | 'own' | 'ownBadPassword' | 'pending' | 'toDisable',
    Id<'eid'>
  >;

  const F = (name: string) => fx.fld[name]?.id as Id<'fld'>;
  const scope = () => orgScope(fx.orgId);

  /** Identity SMTP connections go to the test server (whatever port the row says). */
  const transportFactory: TransportFactory = (endpoint, credentials, options) =>
    endpoint.host === IDENTITY_HOST
      ? defaultTransportFactory(
          { ...endpoint, host: '127.0.0.1', port: identitySmtp.port },
          credentials,
          { pool: options.pool },
        )
      : defaultTransportFactory(endpoint, credentials, options);

  function engine(
    overrides: Partial<AutomationRunEngineOptions> = {},
    send: { mailer?: Mailer; mail?: null } = {},
  ): AutomationRunEngine {
    const config = send.mail === null ? { ...t.config, mail: null } : t.config;
    return new AutomationRunEngine(db, {
      defaults: { timeZone: 'Asia/Ho_Chi_Minh', locale: 'vi' },
      query,
      actions: defaultActionRegistry({ records, query }, [
        ['send_email', createSendEmailAction({ db, mailer: send.mailer ?? mailer, config })],
      ]),
      publicUrl: TEST_PUBLIC_URL,
      notifier: NO_AUTOMATION_NOTIFICATIONS,
      random: () => 0,
      ...overrides,
    });
  }

  async function identity(input: {
    email: string;
    name: string;
    mode: 'send_as' | 'on_behalf';
    own?: { password: string };
    signature?: string;
    status?: 'verified' | 'pending';
  }): Promise<Id<'eid'>> {
    const id = newId('eid');
    const key = deriveSecretKey(t.config.security.appMasterKey, 'email-identity-smtp');
    const verified = (input.status ?? 'verified') === 'verified';
    await new EmailIdentitiesRepository(db).create(scope(), {
      id,
      email: input.email,
      display_name: input.name,
      reply_to: null,
      transport: input.own === undefined ? 'system' : 'smtp',
      mode: input.mode,
      status: input.status ?? 'verified',
      verified_at: verified ? new Date() : null,
      verified_via: verified ? 'code' : null,
      base_scope: 'all',
      signature_md: input.signature ?? null,
      ...(input.own === undefined
        ? {}
        : {
            smtp_host: IDENTITY_HOST,
            smtp_port: 2525,
            smtp_security: 'none',
            smtp_username: input.email,
            smtp_password_enc: sealSecret(key, input.own.password),
          }),
      created_by: fx.users.owner.id,
    });
    return id;
  }

  async function createOrder(fields: Record<string, unknown>): Promise<Id<'rec'>> {
    const response = await fx.call(
      'u_admin',
      'POST',
      `/tables/${fx.orders.id}/records?field_key_type=id`,
      {
        records: [{ fields }],
      },
    );
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ records: { id: Id<'rec'> }[] }>().records[0]?.id as Id<'rec'>;
  }

  function sendEmail(config: Record<string, unknown>, id = 'act_mail'): JsonObject {
    return {
      id,
      type: 'send_email',
      config: {
        identity_id: null,
        to: [{ field: F('owner') }],
        cc: [],
        bcc: [],
        reply_to: null,
        subject: { template: 'Đơn {{ [' + F('title') + '] }}' },
        body: { format: 'markdown', template: 'Xin chào', digest: null },
        include_signature: true,
        footer: 'minimal',
        ...config,
      },
    };
  }

  /** An enabled automation (run as u_admin) and one `queued` run for `recordId`. */
  async function queuedRun(
    actions: JsonObject[],
    recordId: Id<'rec'>,
  ): Promise<{ automationId: Id<'aut'>; runId: Id<'run'> }> {
    const automationId = newId('aut');
    const definition = {
      trigger: { type: 'record.created', table_id: fx.orders.id, skip_bulk: false },
      condition: null,
      actions,
    } as unknown as JsonObject;
    await new AutomationsRepository(db).insert(scope(), {
      id: automationId,
      baseId: fx.baseId,
      name: 'Báo đơn khẩn',
      description: '',
      enabled: true,
      definition,
      triggerType: 'record.created',
      triggerTableId: fx.orders.id,
      createdBy: fx.users.u_admin.id,
    });
    const runId = newId('run');
    await new AutomationRunsRepository(db).insert(scope(), {
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
          table_id: fx.orders.id,
          record_id: recordId,
          bulk: false,
          batch: null,
        },
      },
    });
    return { automationId, runId };
  }

  const execute = (runId: Id<'run'>, e = engine()) =>
    e.execute(scope(), runId, jobOf(fx.orgId, runId));
  const stepOf = async (runId: Id<'run'>) =>
    (await new AutomationRunStepsRepository(db).listByRun(scope(), runId))[0];
  const automationOf = (id: Id<'aut'>) => new AutomationsRepository(db).get(scope(), id);
  const sentTo = (address: string) =>
    instance.messages.filter((message) => message.to.includes(address));

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    instance = await startSmtp();
    identitySmtp = await startSmtp({ user: 'it@corp.test', pass: IT_PASSWORD });
    t = await startTestApp({
      DATABASE_URL: database.url,
      SMTP_URL: instance.url,
      SMTP_FROM: 'Cellhive <noreply@cellhive.test>',
      SMTP_ALLOWED_FROM_DOMAINS: 'cellhive.test,corp.test',
      SMTP_ALLOW_INSECURE: 'true',
      SMTP_ALLOW_PRIVATE_HOSTS: 'true',
    });
    fx = await buildRecordFixture(t, db);
    other = await buildRecordFixture(t, db);
    records = t.app.get(RecordMutationService);
    query = t.app.get(RecordQueryService);
    mailer = createMailService(t.config, { transportFactory });
    contact = await t.app
      .get(SchemaService)
      .addField(
        scope(),
        fx.orders.id,
        { name: 'contact', type: 'text', options: { style: { type: 'email' } } },
        systemAuditContext(),
      );

    // CONTRACTS §5 role Sales, variant of P32: `manage` on Orders (cost hidden).
    const roles = new BaseRolesRepository(db);
    const sales = (await roles.listByBase(scope(), fx.baseId)).find(
      (role) => role.name === 'Sales',
    );
    const config = sales?.config as { tables: Record<string, { perm: string }> };
    const ordersRule = config.tables[fx.orders.id];
    if (sales === undefined || ordersRule === undefined) throw new Error('no Sales role');
    ordersRule.perm = 'manage';
    await roles.update(scope(), fx.baseId, sales.id, { config: config });

    ids.onBehalf = await identity({
      email: 'hr@partner.test',
      name: 'Phòng Nhân sự',
      mode: 'on_behalf',
      signature: '**Phòng Nhân sự** · 028 1234 5678',
    });
    ids.sendAs = await identity({
      email: 'hr@corp.test',
      name: 'Phòng Nhân sự',
      mode: 'send_as',
      signature: '**Phòng Nhân sự** · 028 1234 5678',
    });
    ids.own = await identity({
      email: 'it@corp.test',
      name: 'Phòng IT',
      mode: 'send_as',
      own: { password: IT_PASSWORD },
    });
    ids.ownBadPassword = await identity({
      email: 'it-old@corp.test',
      name: 'IT cũ',
      mode: 'send_as',
      own: { password: 'Wrong-Password-1' },
    });
    ids.pending = await identity({
      email: 'pending@corp.test',
      name: 'Chưa xác minh',
      mode: 'send_as',
      status: 'pending',
    });
    ids.toDisable = await identity({ email: 'ops@corp.test', name: 'Ops', mode: 'send_as' });
  });

  afterAll(async () => {
    mailer.close();
    await t.close();
    await db.destroy();
    await database.drop();
    await instance.close();
    await identitySmtp.close();
  });

  describe('run (handler)', () => {
    it('emails the user field + a cc literal, with signature, minimal footer and mandatory headers', async () => {
      const recordId = await createOrder({
        [F('title')]: 'Khẩn: máy chủ hỏng',
        [F('owner')]: [{ id: fx.users.u_sales1.id }],
      });
      const { automationId, runId } = await queuedRun(
        [
          sendEmail({
            identity_id: ids.sendAs,
            cc: [{ literal: 'boss@partner.test' }],
            body: {
              format: 'markdown',
              template: `Ticket **{{ [${F('title')}] }}** cần xử lý.`,
              digest: null,
            },
          }),
        ],
        recordId,
      );
      expect(await execute(runId)).toEqual({ status: 'succeeded' });
      const [mail] = sentTo(fx.users.u_sales1.email);
      expect(mail).toBeDefined();
      if (mail === undefined) return;
      expect([...mail.to].sort()).toEqual(['boss@partner.test', fx.users.u_sales1.email].sort());
      expect(headerOf(mail.raw, 'Cc')).toContain('boss@partner.test');
      expect(decodeHeader(headerOf(mail.raw, 'From'))).toContain('<hr@corp.test>');
      expect(headerOf(mail.raw, 'Auto-Submitted')).toBe('auto-generated');
      expect(headerOf(mail.raw, 'X-Auto-Response-Suppress')).toBe('OOF, AutoReply');
      expect(headerOf(mail.raw, 'X-Cellhive-Automation')).toBe(automationId);
      expect(headerOf(mail.raw, 'Sender')).toBeNull();
      expect(headerOf(mail.raw, 'Message-ID')).toBe(
        deterministicMessageId(`${automationId}:${runId}:act_mail`, 'corp.test'),
      );
      expect(headerOf(mail.raw, 'Content-Type')).toContain('multipart/alternative');
      expect(decodeHeader(headerOf(mail.raw, 'Subject'))).toBe('Đơn Khẩn: máy chủ hỏng');
      const body = bodyOf(mail.raw);
      expect(body).toContain('Phòng Nhân sự');
      expect(body).toContain('028 1234 5678');
      expect(body).toContain('Email được gửi tự động bởi Cellhive của');
      expect(body).not.toContain('Báo đơn khẩn');

      const step = await stepOf(runId);
      expect(step?.status).toBe('succeeded');
      const output = step?.output as Record<string, unknown>;
      expect(output).toMatchObject({
        identity_id: ids.sendAs,
        mode: 'send_as',
        footer: 'minimal',
        attachment_count: 0,
        smtp: { code: 250 },
      });
      expect(JSON.stringify(output)).not.toContain('máy chủ hỏng');
      expect(JSON.stringify(output)).not.toContain(fx.users.u_sales1.email);
      expect((output['recipients'] as { accepted: string[] }).accepted).toHaveLength(2);
    });

    it('on_behalf: From "<name> (qua Cellhive)" <SMTP_FROM>, Reply-To the identity', async () => {
      const recordId = await createOrder({
        [F('title')]: 'Nghỉ phép',
        [contact.id]: 'nhanvien@partner.test',
      });
      const { runId } = await queuedRun(
        [sendEmail({ identity_id: ids.onBehalf, to: [{ field: contact.id }] })],
        recordId,
      );
      expect(await execute(runId)).toEqual({ status: 'succeeded' });
      const [mail] = sentTo('nhanvien@partner.test');
      const from = decodeHeader(headerOf(mail?.raw ?? '', 'From'));
      expect(from).toContain('Phòng Nhân sự (qua Cellhive)');
      expect(from).toContain('<noreply@cellhive.test>');
      expect(headerOf(mail?.raw ?? '', 'Reply-To')).toContain('hr@partner.test');
      expect((await stepOf(runId))?.output).toMatchObject({ mode: 'on_behalf' });
    });

    it('a display name saved before T540 is still used, quoted/encoded: one From address only', async () => {
      // Rows saved before the rule are kept (CONTRACTS §23.3); the header must
      // still carry exactly the identity (or SMTP_FROM) as its address.
      const legacy = 'Bank <a@evil.com> https://x';
      const cases = [
        { email: 'legacy@corp.test', mode: 'send_as', address: 'legacy@corp.test' },
        { email: 'legacy@partner.test', mode: 'on_behalf', address: 'noreply@cellhive.test' },
      ] as const;
      for (const item of cases) {
        const identityId = await identity({ email: item.email, name: legacy, mode: item.mode });
        const to = `legacy-${item.mode}@partner.test`;
        const recordId = await createOrder({ [F('title')]: 'Legacy', [contact.id]: to });
        const { runId } = await queuedRun(
          [sendEmail({ identity_id: identityId, to: [{ field: contact.id }] })],
          recordId,
        );
        expect(await execute(runId)).toEqual({ status: 'succeeded' });
        const [mail] = sentTo(to);
        const raw = headerOf(mail?.raw ?? '', 'From') ?? '';
        // Without the quoted string / encoded words of the name, only the address is left.
        const bare = raw
          .replace(/"(?:[^"\\]|\\.)*"/g, '')
          .replace(/=\?[^?]+\?[qb]\?[^?]*\?=/gi, '')
          .trim();
        expect(bare).toBe(`<${item.address}>`);
        expect(decodeHeader(raw)).toContain(legacy);
        expect(mail?.from).toBe(item.mode === 'send_as' ? item.email : 'noreply@cellhive.test');
        expect(headerOf(mail?.raw ?? '', 'Reply-To') ?? '').not.toContain('evil.com');
      }
    });

    it('an identity with its own SMTP sends through it, not the instance SMTP', async () => {
      const before = instance.messages.length;
      const recordId = await createOrder({
        [F('title')]: 'IT',
        [contact.id]: 'staff@partner.test',
      });
      const { runId } = await queuedRun(
        [sendEmail({ identity_id: ids.own, to: [{ field: contact.id }] })],
        recordId,
      );
      expect(await execute(runId)).toEqual({ status: 'succeeded' });
      expect(instance.messages.length).toBe(before);
      const mail = identitySmtp.messages.at(-1);
      expect(mail?.user).toBe('it@corp.test');
      expect(mail?.to).toEqual(['staff@partner.test']);
      const from = decodeHeader(headerOf(mail?.raw ?? '', 'From'));
      expect(from).toContain('Phòng IT');
      expect(from).toContain('<it@corp.test>');
    });

    it('three 535 in a row put the identity in error; its steps fail email_identity_auth_failed', async () => {
      const recordId = await createOrder({ [F('title')]: 'Auth', [contact.id]: 'a@partner.test' });
      const codes: unknown[] = [];
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const { runId, automationId } = await queuedRun(
          [sendEmail({ identity_id: ids.ownBadPassword, to: [{ field: contact.id }] })],
          recordId,
        );
        const result = await execute(runId);
        codes.push('code' in result ? result.code : result.status);
        expect((await automationOf(automationId))?.enabled).toBe(true);
      }
      expect(codes).toEqual([
        'smtp_rejected',
        'smtp_rejected',
        'email_identity_auth_failed',
        'email_identity_auth_failed',
      ]);
      const row = await new EmailIdentitiesRepository(db).findById(scope(), ids.ownBadPassword);
      expect(row).toMatchObject({ status: 'error', error_reason: 'auth_failed' });
    });

    it('record values stay text: no link, image, bold or heading from a value (table)', async () => {
      const values = [
        '[x](javascript:alert(1))',
        '<img src=x onerror=alert(1)>',
        '**đậm**',
        '# Tiêu đề',
        '<script>alert(1)</script>',
      ];
      for (const value of values) {
        const recordId = await createOrder({
          [F('title')]: value,
          [contact.id]: 'safe@partner.test',
        });
        const { runId } = await queuedRun(
          [
            sendEmail({
              to: [{ field: contact.id }],
              body: {
                format: 'markdown',
                template: `Giá trị: {{ [${F('title')}] }}`,
                digest: null,
              },
            }),
          ],
          recordId,
        );
        expect(await execute(runId)).toEqual({ status: 'succeeded' });
        const html = htmlOf(instance.messages.at(-1)?.raw ?? '');
        expect(html).toContain('<html');
        expect(html).not.toContain('href="javascript');
        expect(html).not.toMatch(/<img/i);
        expect(html).not.toMatch(/<script/i);
        expect(html).not.toContain('<strong>đậm</strong>');
        expect(html).not.toContain('<h1');
      }
    });

    it('a subject with CR/LF cannot add a header', async () => {
      const recordId = await createOrder({
        [F('title')]: 'Hi\r\nBcc: evil@attacker.test',
        [contact.id]: 'victim@partner.test',
      });
      const { runId } = await queuedRun([sendEmail({ to: [{ field: contact.id }] })], recordId);
      expect(await execute(runId)).toEqual({ status: 'succeeded' });
      const mail = instance.messages.at(-1);
      expect(mail?.to).toEqual(['victim@partner.test']);
      expect(headerOf(mail?.raw ?? '', 'Bcc')).toBeNull();
      expect(decodeHeader(headerOf(mail?.raw ?? '', 'Subject'))).toBe(
        'Đơn Hi Bcc: evil@attacker.test',
      );
    });

    it('51 recipients: failed too_many_recipients, nothing sent', async () => {
      const before = instance.messages.length;
      const fifty = Array.from({ length: 50 }, (_, i) => `r${String(i)}@partner.test`);
      const recordId = await createOrder({ [F('title')]: 'Nhiều người' });
      const { runId } = await queuedRun(
        [sendEmail({ to: [{ literal: fifty }], cc: [{ literal: 'one-more@partner.test' }] })],
        recordId,
      );
      expect(await execute(runId)).toMatchObject({ status: 'failed', code: 'too_many_recipients' });
      expect(instance.messages.length).toBe(before);
    });

    it('an identity disabled after the save: the step fails, the automation stays on', async () => {
      const recordId = await createOrder({ [F('title')]: 'Tắt', [contact.id]: 'x@partner.test' });
      const { runId, automationId } = await queuedRun(
        [sendEmail({ identity_id: ids.toDisable, to: [{ field: contact.id }] })],
        recordId,
      );
      await new EmailIdentitiesRepository(db).update(scope(), ids.toDisable, {
        status: 'disabled',
        status_before_disable: 'verified',
      });
      expect(await execute(runId)).toMatchObject({
        status: 'failed',
        code: 'email_identity_unavailable',
      });
      expect((await automationOf(automationId))?.enabled).toBe(true);
    });

    it('a temporary SMTP failure is retried with the same Message-ID', async () => {
      const recordId = await createOrder({
        [F('title')]: 'Thử lại',
        [contact.id]: 'retry@partner.test',
      });
      const { automationId, runId } = await queuedRun(
        [sendEmail({ to: [{ field: contact.id }] })],
        recordId,
      );
      instance.control.failData = 1;
      expect(await execute(runId)).toMatchObject({ status: 'retry_scheduled', step: 'act_mail' });
      expect(await stepOf(runId)).toMatchObject({
        status: 'failed',
        error: { code: 'smtp_temporary', params: { reason: 'temporary', smtp: { code: 451 } } },
      });
      expect(await execute(runId)).toEqual({ status: 'succeeded' });
      const mails = sentTo('retry@partner.test');
      expect(mails).toHaveLength(1);
      expect(headerOf(mails[0]?.raw ?? '', 'Message-ID')).toBe(
        deterministicMessageId(`${automationId}:${runId}:act_mail`, 'cellhive.test'),
      );
      // The system sender shows the organization's name.
      const from = decodeHeader(headerOf(mails[0]?.raw ?? '', 'From'));
      expect(from).toContain((await new OrganizationsRepository(db).findById(fx.orgId))?.name);
      expect(from).toContain('<noreply@cellhive.test>');
    });

    it('the hourly quota: the step waits (not a retry), then fails after 24 hours', async () => {
      const full: EmailQuota = {
        take: () =>
          Promise.resolve({
            allowed: false,
            used: 500,
            retryAt: new Date(Date.now() + 60 * 60 * 1000),
          }),
        release: () => Promise.resolve(),
        used: () => Promise.resolve({ used: 500, resetsAt: new Date() }),
      };
      const limited = createMailService(t.config, { orgQuota: full });
      const recordId = await createOrder({
        [F('title')]: 'Hết lượt',
        [contact.id]: 'q@partner.test',
      });
      const { runId } = await queuedRun([sendEmail({ to: [{ field: contact.id }] })], recordId);
      const start = Date.now();
      let clock = new Date(start);
      const quotaEngine = engine({ now: () => clock }, { mailer: limited });
      const first = await execute(runId, quotaEngine);
      expect(first).toMatchObject({ status: 'retry_scheduled', step: 'act_mail' });
      const run = await new AutomationRunsRepository(db).get(scope(), runId);
      expect(run?.error).toMatchObject({ code: 'email_quota_exceeded', waits: 1 });
      clock = new Date(start + 25 * 60 * 60 * 1000);
      expect(await execute(runId, quotaEngine)).toMatchObject({
        status: 'failed',
        code: 'email_quota_exceeded',
      });
      limited.close();
    });

    it('no SMTP: failed smtp_not_configured', async () => {
      const recordId = await createOrder({
        [F('title')]: 'Không SMTP',
        [contact.id]: 'n@partner.test',
      });
      const { runId } = await queuedRun([sendEmail({ to: [{ field: contact.id }] })], recordId);
      const unconfigured = createMailService({ ...t.config, mail: null });
      expect(await execute(runId, engine({}, { mailer: unconfigured, mail: null }))).toMatchObject({
        status: 'failed',
        code: 'smtp_not_configured',
      });
      unconfigured.close();
    });

    it('S5 milestone: schedule 08:00 → find_records overdue → one digest email (T528)', async () => {
      const schema = t.app.get(SchemaService);
      const due = await schema.addField(
        scope(),
        fx.orders.id,
        { name: 'due', type: 'datetime', options: { style: { format: 'yyyy-MM-dd' } } },
        systemAuditContext(),
      );
      const day = 24 * 60 * 60 * 1000;
      const tag = `Mốc ${newId('rec').slice(-6)}`;
      await createOrder({
        [F('title')]: `${tag} quá hạn A`,
        [due.id]: new Date(Date.now() - 3 * day).toISOString().slice(0, 10),
      });
      await createOrder({
        [F('title')]: `${tag} quá hạn B`,
        [due.id]: new Date(Date.now() - day).toISOString().slice(0, 10),
      });
      await createOrder({
        [F('title')]: `${tag} còn hạn`,
        [due.id]: new Date(Date.now() + 5 * day).toISOString().slice(0, 10),
      });
      // Schedules fire from the moment the automation is created: the first 08:00 after it.
      const createdAt = Date.now();
      const created = await fx.call('u_admin', 'POST', `/bases/${fx.baseId}/automations`, {
        name: 'Ticket quá hạn lúc 08:00',
        enabled: true,
        definition: {
          trigger: { type: 'schedule', cron: '0 8 * * *', timezone: 'Asia/Ho_Chi_Minh' },
          actions: [
            {
              id: 'act_find',
              type: 'find_records',
              config: {
                table_id: fx.orders.id,
                filter: {
                  op: 'and',
                  items: [
                    { field: F('title'), operator: 'contains', value: tag },
                    { field: due.id, operator: 'before', value: { $date: { relative: 'today' } } },
                  ],
                },
                sort: [{ field: due.id, direction: 'asc' }],
                fields: [F('title')],
                limit: 200,
              },
            },
            sendEmail({
              to: [{ literal: 'manager@partner.test' }],
              subject: { template: 'Ticket quá hạn chưa xong' },
              body: {
                format: 'markdown',
                template: 'Các ticket quá hạn:\n\n{{ [@digest] }}',
                digest: { step: 'act_find', row_template: `- {{ [${F('title')}] }}` },
              },
            }),
          ],
        },
      });
      expect(created.statusCode, created.body).toBe(201);
      const automationId = created.json<{ id: Id<'aut'> }>().id;

      // 08:00 in Ho Chi Minh City is 01:00 UTC: the first one after the creation. Not one
      // further away: an 08:00 in between fires at the tick before it (run at 00:55 UTC).
      const hour = 60 * 60 * 1000;
      const eight = Math.floor((createdAt - hour) / day + 1) * day + hour;
      const triggers = new AutomationTimeTriggers(db, {
        defaults: { timeZone: t.config.defaults.timezone, locale: t.config.defaults.locale },
        schema,
      });
      const item = { organizationId: fx.orgId, automationId };
      expect(await triggers.tickSchedule(item, new Date(eight - 60_000))).toMatchObject({
        runs: 0,
      });
      expect(await triggers.tickSchedule(item, new Date(eight))).toMatchObject({
        outcome: 'fired',
        runs: 1,
      });
      const [run] = (
        await sql<{ id: Id<'run'> }>`
          SELECT id FROM meta.automation_runs WHERE automation_id = ${automationId}
        `.execute(db.kysely)
      ).rows;
      if (run === undefined) throw new Error('no run');
      const before = sentTo('manager@partner.test').length;
      expect(await execute(run.id)).toEqual({ status: 'succeeded' });
      const mails = sentTo('manager@partner.test').slice(before);
      expect(mails).toHaveLength(1);
      const raw = mails[0]?.raw ?? '';
      expect(decodeHeader(headerOf(raw, 'Subject'))).toBe('Ticket quá hạn chưa xong');
      expect(headerOf(raw, 'Auto-Submitted')).toBe('auto-generated');
      expect(headerOf(raw, 'X-Cellhive-Automation')).toBe(automationId);
      const text = bodyOf(raw);
      expect(text).toContain(`${tag} quá hạn A`);
      expect(text).toContain(`${tag} quá hạn B`);
      expect(text).not.toContain(`${tag} còn hạn`);
      // Oldest due first.
      expect(text.indexOf(`${tag} quá hạn A`)).toBeLessThan(text.indexOf(`${tag} quá hạn B`));
    });
  });

  describe('refused recipients in the run detail (T541, QA S5 L1)', () => {
    const detail = async (user: FixtureUser, runId: Id<'run'>) => {
      const response = await fx.call(user, 'GET', `/automation-runs/${runId}`);
      expect(response.statusCode, response.body).toBe(200);
      return { body: response.body, run: automationRunDetailSchema.parse(response.json()) };
    };

    it('1 of 3 refused 550 5.1.1: the step succeeds, its output lists it masked with the code', async () => {
      const recordId = await createOrder({ [F('title')]: 'Một người sai' });
      const { runId } = await queuedRun(
        [
          sendEmail({
            to: [
              { literal: ['keep-a@partner.test', 'gone-1@partner.test', 'keep-b@partner.test'] },
            ],
          }),
        ],
        recordId,
      );
      expect(await execute(runId)).toEqual({ status: 'succeeded' });
      expect(sentTo('keep-a@partner.test').at(-1)?.to).toEqual([
        'keep-a@partner.test',
        'keep-b@partner.test',
      ]);
      const { run } = await detail('u_admin', runId);
      const [step] = run.steps;
      expect(step).toMatchObject({ status: 'succeeded', error: null, redacted: false });
      expect(step?.output).toMatchObject({
        recipients: {
          accepted: ['k***@partner.test', 'k***@partner.test'],
          rejected: [
            {
              masked: 'g***@partner.test',
              code: 'smtp_rejected',
              smtp: { code: 550, enhanced: '5.1.1' },
            },
          ],
        },
      });
      // Steps hold masked addresses and codes only (the definition shows its own literals).
      expect(JSON.stringify(run.steps)).not.toMatch(/gone-1@|keep-a@|keep-b@|no such user/);
    });

    it('every recipient refused: failed smtp_rejected, error.params lists them masked + codes', async () => {
      const recordId = await createOrder({ [F('title')]: 'Tất cả sai' });
      const { runId } = await queuedRun(
        [
          sendEmail({
            to: [{ literal: ['gone-a@partner.test', 'gone-b@corp.test'] }],
            cc: [{ literal: 'gone-c@partner.test' }],
          }),
        ],
        recordId,
      );
      expect(await execute(runId)).toMatchObject({ status: 'failed', code: 'smtp_rejected' });
      const { run } = await detail('u_admin', runId);
      expect(run.status).toBe('failed');
      const [step] = run.steps;
      expect(step).toMatchObject({ status: 'failed', output: null });
      expect(step?.error?.code).toBe('smtp_rejected');
      const params = sendEmailRecipientErrorParamsSchema.parse(step?.error?.params);
      expect(params).toEqual({
        reason: 'rejected',
        smtp: { code: 550, enhanced: '5.1.1' },
        rejected: [
          {
            masked: 'g***@partner.test',
            code: 'smtp_rejected',
            smtp: { code: 550, enhanced: '5.1.1' },
          },
          {
            masked: 'g***@corp.test',
            code: 'smtp_rejected',
            smtp: { code: 550, enhanced: '5.1.1' },
          },
          {
            masked: 'g***@partner.test',
            code: 'smtp_rejected',
            smtp: { code: 550, enhanced: '5.1.1' },
          },
        ],
        rejected_count: 3,
        accepted_count: 0,
      });
      // The run's own error points at the step with the same parameters.
      expect(run.error).toMatchObject({ code: 'smtp_rejected', step: 'act_mail' });
      // Never a full address nor the server's text in the steps or the run error.
      expect(JSON.stringify([run.steps, run.error])).not.toMatch(/gone-[abc]@|no such user/);
    });

    it('more than 50 refused → the first 50 in RCPT order and the count', async () => {
      const wide = { ...t.config, email: { ...t.config.email, maxRecipients: 60 } };
      const wideMailer = createMailService(wide, { transportFactory });
      const wideEngine = new AutomationRunEngine(db, {
        defaults: { timeZone: 'Asia/Ho_Chi_Minh', locale: 'vi' },
        query,
        actions: defaultActionRegistry({ records, query }, [
          ['send_email', createSendEmailAction({ db, mailer: wideMailer, config: wide })],
        ]),
        publicUrl: TEST_PUBLIC_URL,
        notifier: NO_AUTOMATION_NOTIFICATIONS,
        random: () => 0,
      });
      const many = Array.from({ length: 60 }, (_, i) => `gone-${String(i)}@p${String(i)}.test`);
      const recordId = await createOrder({ [F('title')]: 'Sáu mươi' });
      const { runId } = await queuedRun(
        [
          sendEmail({
            to: [{ literal: many.slice(0, 30) }],
            cc: [{ literal: many.slice(30) }],
          }),
        ],
        recordId,
      );
      expect(await execute(runId, wideEngine)).toMatchObject({
        status: 'failed',
        code: 'smtp_rejected',
      });
      wideMailer.close();
      const { run } = await detail('u_admin', runId);
      const params = sendEmailRecipientErrorParamsSchema.parse(run.steps[0]?.error?.params);
      expect(params.rejected).toHaveLength(SEND_EMAIL_ERROR_MAX_REJECTED);
      expect(params.rejected.map((item) => item.masked)).toEqual(
        many.slice(0, SEND_EMAIL_ERROR_MAX_REJECTED).map((_, i) => `g***@p${String(i)}.test`),
      );
      expect(
        params.rejected.every(
          (item) =>
            item.code === 'smtp_rejected' &&
            item.smtp?.code === 550 &&
            item.smtp.enhanced === '5.1.1',
        ),
      ).toBe(true);
      expect(params).toMatchObject({ rejected_count: 60, accepted_count: 0 });
    });

    it('people who do not manage the automation still get 404', async () => {
      const recordId = await createOrder({ [F('title')]: 'Ai xem' });
      const { runId } = await queuedRun(
        [sendEmail({ to: [{ literal: 'gone-x@partner.test' }] })],
        recordId,
      );
      expect(await execute(runId)).toMatchObject({ status: 'failed', code: 'smtp_rejected' });
      for (const user of ['u_editor', 'u_reader', 'u_out', 'stranger'] as const) {
        expectProblem(await fx.call(user, 'GET', `/automation-runs/${runId}`), 404, 'NOT_FOUND');
      }
      expectProblem(
        await other.call('owner', 'GET', `/automation-runs/${runId}`),
        404,
        'NOT_FOUND',
      );
    });

    it('Valkey not reachable for the quota: smtp_temporary, retried (S5-review §4 #14)', async () => {
      const offline = createCacheClient(
        { ...t.config, cache: { ...t.config.cache, url: 'redis://127.0.0.1:1' } },
        captureLogger().logger,
      );
      const quota = createValkeyEmailQuota(valkeyQuotaClient(offline, 200), {
        limit: 500,
        scope: 'org',
      });
      const unready = createMailService(t.config, { orgQuota: quota });
      const recordId = await createOrder({
        [F('title')]: 'Valkey',
        [contact.id]: 'v@partner.test',
      });
      const { runId } = await queuedRun([sendEmail({ to: [{ field: contact.id }] })], recordId);
      expect(await execute(runId, engine({}, { mailer: unready }))).toMatchObject({
        status: 'retry_scheduled',
        step: 'act_mail',
      });
      expect(await stepOf(runId)).toMatchObject({
        status: 'failed',
        error: { code: 'smtp_temporary', params: { reason: 'temporary' } },
      });
      expect(sentTo('v@partner.test')).toHaveLength(0);
      unready.close();
      offline.disconnect();
    });
  });

  describe('save (API)', () => {
    const definition = (action: JsonObject) => ({
      name: 'Email',
      definition: {
        trigger: { type: 'record.created', table_id: fx.orders.id },
        actions: [action],
      },
    });
    const create = (action: JsonObject, user: 'u_admin' | 'u_sales1' = 'u_admin') =>
      fx.call(user, 'POST', `/bases/${fx.baseId}/automations`, definition(action));
    const codesOf = (body: string) =>
      ((problemOf(body)['errors'] ?? []) as { code: string; path: string }[]).map((e) => [
        e.path,
        e.code,
      ]);

    it('Reply-To literal → 422; a text field → EMAIL_REPLY_TO_INVALID', async () => {
      expectProblem(
        await create(sendEmail({ reply_to: { literal: 'phish@evil.test' } })),
        422,
        'VALIDATION_FAILED',
      );
      const response = await create(sendEmail({ reply_to: { field: F('title') } }));
      expectProblem(response, 422, 'AUTOMATION_INVALID');
      expect(codesOf(response.body)).toEqual([
        ['definition.actions[0].config.reply_to.field', 'EMAIL_REPLY_TO_INVALID'],
      ]);
    });

    it('REGEX in the subject, a bad literal address, a number field as recipient → 422', async () => {
      const response = await create(
        sendEmail({
          subject: { template: `{{ REGEXMATCH([${F('title')}], "a") }}` },
          to: [{ literal: 'not-an-email' }, { field: F('amount') }],
        }),
      );
      expectProblem(response, 422, 'AUTOMATION_INVALID');
      expect(codesOf(response.body)).toEqual([
        ['definition.actions[0].config.to[0].literal', 'INVALID_EMAIL'],
        ['definition.actions[0].config.to[1].field', 'INVALID_FIELD_TYPE'],
        ['definition.actions[0].config.subject.template', 'UNSUPPORTED_FUNCTION'],
      ]);
    });

    it('identities not usable (pending, other organization) and footer none → 422', async () => {
      const otherIdentity = newId('eid');
      await new EmailIdentitiesRepository(db).create(orgScope(other.orgId), {
        id: otherIdentity,
        email: 'hr@corp.test',
        display_name: 'HR',
        reply_to: null,
        transport: 'system',
        mode: 'send_as',
        status: 'verified',
        verified_at: new Date(),
        verified_via: 'code',
        base_scope: 'all',
        signature_md: null,
        created_by: other.users.owner.id,
      });
      for (const identityId of [ids.pending, otherIdentity]) {
        const response = await create(sendEmail({ identity_id: identityId }));
        expect(codesOf(response.body)).toEqual([
          ['definition.actions[0].config.identity_id', 'EMAIL_IDENTITY_NOT_USABLE'],
        ]);
      }
      const footer = await create(sendEmail({ footer: 'none' }));
      expect(codesOf(footer.body)).toEqual([
        ['definition.actions[0].config.footer', 'EMAIL_FOOTER_NOT_ALLOWED'],
      ]);
      const replyTo = await create(sendEmail({ reply_to: { identity_id: ids.pending } }));
      expect(codesOf(replyTo.body)).toEqual([
        ['definition.actions[0].config.reply_to.identity_id', 'EMAIL_IDENTITY_NOT_USABLE'],
      ]);
    });

    it('a valid step saves; identity usages and the system sender count are real', async () => {
      const viaIdentity = await create(
        sendEmail({ identity_id: ids.sendAs, reply_to: { run_as: true } }),
      );
      expect(viaIdentity.statusCode, viaIdentity.body).toBe(201);
      const system = await create(sendEmail({ reply_to: { field: F('owner') } }));
      expect(system.statusCode, system.body).toBe(201);

      const usages = emailIdentityUsagesSchema.parse(
        (await fx.call('owner', 'GET', `/email-identities/${ids.sendAs}/usages`)).json(),
      );
      expect(usages.items).toContainEqual({
        automation_id: viaIdentity.json<{ id: Id<'aut'> }>().id,
        base_id: fx.baseId,
        name: 'Email',
      });
      const settings = emailSettingsSchema.parse(
        (await fx.call('owner', 'GET', `/orgs/${fx.orgId}/email-settings`)).json(),
      );
      expect(settings.automation.system_sender_usage.automations).toBeGreaterThanOrEqual(1);
      // Another organization's admin: the identity does not exist.
      expect(
        (await other.call('owner', 'GET', `/email-identities/${ids.sendAs}/usages`)).statusCode,
      ).toBe(404);
    });
  });

  describe('preview and test email (API)', () => {
    let automationId: Id<'aut'>;
    let salesRecord: Id<'rec'>;
    let sales2Record: Id<'rec'>;
    const url = (action = 'act_mail', kind = 'email-preview') =>
      `/automations/${automationId}/actions/${action}/${kind}`;

    beforeAll(async () => {
      const response = await fx.call('u_admin', 'POST', `/bases/${fx.baseId}/automations`, {
        name: 'Preview',
        definition: {
          trigger: { type: 'record.created', table_id: fx.orders.id },
          actions: [
            sendEmail({
              cc: [{ literal: 'boss@external.test' }],
              body: {
                format: 'markdown',
                template: `Đơn {{ [${F('title')}] }}, giá vốn {{ [${F('cost')}] }}`,
                digest: null,
              },
            }),
          ],
        },
      });
      expect(response.statusCode, response.body).toBe(201);
      automationId = response.json<{ id: Id<'aut'> }>().id;
      salesRecord = await createOrder({
        [F('title')]: 'Của Sales 1',
        [F('cost')]: 777_123,
        [F('owner')]: [{ id: fx.users.u_sales1.id }],
      });
      sales2Record = await createOrder({
        [F('title')]: 'Của Sales 2',
        [F('owner')]: [{ id: fx.users.u_sales2.id }],
      });
    });

    it('renders as the caller: run_as reads cost, the editor u_sales1 does not', async () => {
      const admin = await fx.call('u_admin', 'POST', url(), { record_id: salesRecord });
      expect(admin.statusCode, admin.body).toBe(200);
      const preview = automationEmailPreviewSchema.parse(admin.json());
      expect(preview.text).toContain('777');
      expect(preview.headers.from).toContain('<noreply@cellhive.test>');
      expect(preview.recipients.count).toBe(2);
      expect(preview.recipients.to[0]).toMatch(/^.\*\*\*@/u);
      expect(preview.warnings).toContainEqual({
        code: 'RECIPIENT_MAY_NOT_READ',
        params: { field_ids: [F('cost')], recipients: 1 },
      });
      expect(preview.warnings).toContainEqual({
        code: 'EXTERNAL_RECIPIENTS',
        params: { count: 1 },
      });

      // u_sales1 (manage on Orders, cost hidden): the saved step names cost → like a save.
      const saved = await fx.call('u_sales1', 'POST', url(), { record_id: salesRecord });
      expectProblem(saved, 422, 'AUTOMATION_INVALID');
      expect(saved.body).not.toContain('777');
      const draft = await fx.call('u_sales1', 'POST', url(), {
        record_id: salesRecord,
        draft: sendEmail({
          body: { format: 'markdown', template: `Đơn {{ [${F('title')}] }}`, digest: null },
        })['config'],
      });
      expect(draft.statusCode, draft.body).toBe(200);
      expect(draft.body).toContain('Của Sales 1');
      expect(draft.body).not.toContain('777');
      // A record outside u_sales1's read rule.
      expectProblem(
        await fx.call('u_sales1', 'POST', url(), {
          record_id: sales2Record,
          draft: sendEmail({})['config'],
        }),
        404,
        'NOT_FOUND',
      );
    });

    it('who may preview: editor 403, another organization 404, unknown step 404', async () => {
      expectProblem(
        await fx.call('u_editor', 'POST', url(), { record_id: salesRecord }),
        403,
        'PERMISSION_DENIED',
      );
      expectProblem(
        await other.call('owner', 'POST', url(), { record_id: salesRecord }),
        404,
        'NOT_FOUND',
      );
      expectProblem(
        await fx.call('u_admin', 'POST', url('act_none'), { record_id: salesRecord }),
        404,
        'NOT_FOUND',
      );
    });

    it('test email: only to the caller, "[Thử]" subject, audited, 6th in a minute → 429', async () => {
      expectProblem(
        await fx.call('u_admin', 'POST', url('act_mail', 'email-test'), {
          record_id: salesRecord,
          to: 'someone@else.test',
        }),
        422,
        'VALIDATION_FAILED',
      );
      const before = instance.messages.length;
      for (let i = 0; i < 5; i += 1) {
        const response = await fx.call('u_admin', 'POST', url('act_mail', 'email-test'), {
          record_id: salesRecord,
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(automationEmailTestResultSchema.parse(response.json())).toMatchObject({
          status: 'sent',
          to: fx.users.u_admin.email,
        });
      }
      expectProblem(
        await fx.call('u_admin', 'POST', url('act_mail', 'email-test'), { record_id: salesRecord }),
        429,
        'RATE_LIMITED',
      );
      const sent = instance.messages.slice(before);
      expect(sent).toHaveLength(5);
      for (const mail of sent) {
        expect(mail.to).toEqual([fx.users.u_admin.email]);
        expect(decodeHeader(headerOf(mail.raw, 'Subject'))).toBe('[Thử] Đơn Của Sales 1');
        expect(headerOf(mail.raw, 'X-Cellhive-Automation')).toBe(automationId);
      }
      const audit = await sql<{ after: Record<string, unknown> }>`
        SELECT after FROM meta.audit_logs
         WHERE organization_id = ${fx.orgId} AND action = 'automation.test_email_sent'
           AND entity_id = ${automationId}`.execute(db.kysely);
      expect(audit.rows).toHaveLength(5);
      expect(JSON.stringify(audit.rows)).not.toContain('Của Sales 1');
      expect(JSON.stringify(audit.rows)).not.toContain(fx.users.u_admin.email);
    });
  });
});
