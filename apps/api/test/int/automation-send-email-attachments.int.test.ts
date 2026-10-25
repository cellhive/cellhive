import { once } from 'node:events';
import { Readable } from 'node:stream';

import {
  automationEmailPreviewSchema,
  automationEmailTestResultSchema,
  newId,
  type Id,
} from '@cellhive/contracts';
import {
  AttachmentsRepository,
  AutomationRunEngine,
  AutomationRunsRepository,
  AutomationRunStepsRepository,
  AutomationsRepository,
  BaseRolesRepository,
  createMailService,
  createSendEmailAction,
  defaultActionRegistry,
  NO_AUTOMATION_NOTIFICATIONS,
  orgScope,
  RecordMutationService,
  RecordQueryService,
  SchemaService,
  systemAuditContext,
  type AppConfig,
  type Db,
  type DeferrableJob,
  type FieldRow,
  type JsonObject,
  type Mailer,
  type StorageDriver,
} from '@cellhive/server-core';
import { sql } from 'kysely';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { STORAGE_DRIVER } from '../../src/common/tokens.js';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { buildRecordFixture, expectProblem, type RecordFixture } from './record-fixture.js';
import { problemOf, startTestApp, TEST_PUBLIC_URL, type TestApp } from './support.js';

import type { AddressInfo } from 'node:net';

const MIB = 1024 * 1024;

interface ReceivedMail {
  readonly to: readonly string[];
  readonly raw: string;
  readonly size: number;
}

/** An in-process SMTP server; `discard` only counts the bytes (memory test). */
async function startSmtp(options: { discard?: boolean } = {}) {
  const messages: ReceivedMail[] = [];
  /** Bytes of DATA received so far (all messages). */
  const received = { bytes: 0 };
  const server = new SMTPServer({
    logger: false,
    disabledCommands: ['STARTTLS', 'AUTH'],
    authOptional: true,
    closeTimeout: 100,
    size: 100 * MIB,
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length;
        received.bytes += chunk.length;
        if (options.discard !== true) chunks.push(chunk);
      });
      stream.on('end', () => {
        messages.push({
          to: session.envelope.rcptTo.map((rcpt) => rcpt.address),
          raw: Buffer.concat(chunks).toString('latin1'),
          size,
        });
        callback();
      });
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server.server, 'listening');
  const { port } = server.server.address() as AddressInfo;
  return {
    url: `smtp://127.0.0.1:${String(port)}`,
    messages,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** The MIME parts of a raw message with their headers (one level of nesting is enough here). */
function partsOf(raw: string): { headers: string; body: string }[] {
  const boundaries = [...raw.matchAll(/boundary="?([^";\r\n]+)"?/gi)].map((match) => match[1]);
  const parts: { headers: string; body: string }[] = [];
  for (const boundary of boundaries) {
    if (boundary === undefined) continue;
    for (const chunk of raw.split(`--${boundary}`).slice(1)) {
      const split = chunk.search(/\r?\n\r?\n/);
      if (split === -1) continue;
      parts.push({ headers: chunk.slice(0, split), body: chunk.slice(split).trim() });
    }
  }
  return parts;
}

function attachmentsOf(raw: string) {
  return partsOf(raw)
    .filter((part) => /Content-Disposition:\s*attachment/i.test(part.headers))
    .map((part) => {
      const unfolded = part.headers.replace(/\r?\n[ \t]+/g, ' ');
      const type = /Content-Type:\s*([^;\r\n]+)/i.exec(unfolded)?.[1]?.trim() ?? '';
      // RFC 2231: filename*0*=utf-8''…; filename*1*=… (or a plain filename="…").
      const pieces = [...unfolded.matchAll(/filename\*(?:\d+)?\*?=(?:utf-8'')?([^;\r\n]+)/gi)].map(
        (match) => (match[1] ?? '').replace(/^"|"$/g, ''),
      );
      const plain = /filename=("?)([^";\r\n]+)\1/i.exec(unfolded)?.[2];
      const name = pieces.length > 0 ? decodeURIComponent(pieces.join('')) : (plain ?? '');
      const content = Buffer.from(part.body.replace(/[\r\n]/g, ''), 'base64');
      return { type, name, content };
    });
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

/** `size` bytes produced in 64 KiB chunks, never held at once. */
function generated(size: number): Readable {
  let left = size;
  const chunk = Buffer.alloc(64 * 1024, 0x41);
  return new Readable({
    read() {
      if (left <= 0) {
        this.push(null);
        return;
      }
      const next = Math.min(left, chunk.length);
      left -= next;
      this.push(next === chunk.length ? chunk : chunk.subarray(0, next));
    },
  });
}

/**
 * BACKLOG T532 (`send_email` attachments, CONTRACTS §21/§23.2): files of an
 * attachment field of the trigger record through the run engine to an
 * in-process SMTP server (local storage driver), the save-time checks,
 * preview and test send, the organization limits, `pending_scan`,
 * permissions of `run_as` and streaming of a 30 MiB file.
 */
describe('send_email attachments (T532)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let smtp: Awaited<ReturnType<typeof startSmtp>>;
  let records: RecordMutationService;
  let query: RecordQueryService;
  let storage: StorageDriver;
  let mailer: Mailer;
  let files: FieldRow;
  let salesRoleId: Id<'rol'>;

  const scope = () => orgScope(fx.orgId);
  const F = (name: string) => fx.fld[name]?.id as Id<'fld'>;

  function engine(config: AppConfig = t.config, send: Mailer = mailer): AutomationRunEngine {
    return new AutomationRunEngine(db, {
      defaults: { timeZone: 'Asia/Ho_Chi_Minh', locale: 'vi' },
      query,
      actions: defaultActionRegistry({ records, query }, [
        ['send_email', createSendEmailAction({ db, mailer: send, config, storage })],
      ]),
      publicUrl: TEST_PUBLIC_URL,
      notifier: NO_AUTOMATION_NOTIFICATIONS,
      random: () => 0,
    });
  }

  /** A ready attachment of `files` (no cell yet), stored under its own key. */
  async function stored(
    name: string,
    mime: string,
    body: Buffer | number,
    createdBy: Id<'usr'> = fx.users.u_admin.id,
  ): Promise<Id<'att'>> {
    const repo = new AttachmentsRepository(db);
    const size = typeof body === 'number' ? body : body.length;
    const row = await repo.create(scope(), {
      baseId: fx.baseId,
      tableId: fx.orders.id,
      fieldId: files.id,
      createdBy,
      filename: name,
      mime,
      size,
    });
    await storage.putStream(
      row.object_key,
      typeof body === 'number' ? generated(body) : Readable.from([body]),
      { contentType: mime, contentLength: size },
    );
    await repo.markReady(scope(), row.id, { size, sha256: '0'.repeat(64) });
    return row.id;
  }

  /** An order of `owner` whose `files` cell holds `attachments` (written by u_admin). */
  async function order(
    attachments: Id<'att'>[],
    owner: Id<'usr'> = fx.users.u_sales1.id,
  ): Promise<Id<'rec'>> {
    const response = await fx.call(
      'u_admin',
      'POST',
      `/tables/${fx.orders.id}/records?field_key_type=id`,
      {
        records: [
          {
            fields: {
              [F('title')]: 'Hợp đồng',
              [F('owner')]: [{ id: owner }],
              [files.id]: attachments.map((id) => ({ id })),
            },
          },
        ],
      },
    );
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ records: { id: Id<'rec'> }[] }>().records[0]?.id as Id<'rec'>;
  }

  function sendEmail(config: Record<string, unknown> = {}): JsonObject {
    return {
      id: 'act_mail',
      type: 'send_email',
      config: {
        identity_id: null,
        to: [{ literal: 'nhanvien@partner.test' }],
        cc: [],
        bcc: [],
        reply_to: null,
        subject: { template: 'Quyết định' },
        body: { format: 'markdown', template: 'Gửi bạn quyết định.', digest: null },
        include_signature: true,
        footer: 'minimal',
        attachments: [{ field: files.id }],
        on_missing_attachment: 'fail',
        ...config,
      },
    };
  }

  async function queuedRun(
    action: JsonObject,
    recordId: Id<'rec'>,
    runAs: Id<'usr'> = fx.users.u_admin.id,
  ): Promise<Id<'run'>> {
    const automationId = newId('aut');
    const definition = {
      trigger: { type: 'record.created', table_id: fx.orders.id, skip_bulk: false },
      condition: null,
      actions: [action],
    } as unknown as JsonObject;
    await new AutomationsRepository(db).insert(scope(), {
      id: automationId,
      baseId: fx.baseId,
      name: 'Gửi quyết định',
      description: '',
      enabled: true,
      definition,
      triggerType: 'record.created',
      triggerTableId: fx.orders.id,
      createdBy: runAs,
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
    return runId;
  }

  const execute = (runId: Id<'run'>, e = engine()) =>
    e.execute(scope(), runId, jobOf(fx.orgId, runId));
  const stepOf = async (runId: Id<'run'>) =>
    (await new AutomationRunStepsRepository(db).listByRun(scope(), runId))[0];

  async function setSalesDownload(download: boolean): Promise<void> {
    const roles = new BaseRolesRepository(db);
    const sales = (await roles.listByBase(scope(), fx.baseId)).find(
      (role) => role.id === salesRoleId,
    );
    const config = sales?.config as {
      tables: Record<string, { perm: string; field_rule: { file_download_fields: string[] } }>;
    };
    const rule = config.tables[fx.orders.id];
    if (rule === undefined) throw new Error('no Sales rule');
    rule.field_rule.file_download_fields = download ? [files.id] : [];
    await roles.update(scope(), fx.baseId, salesRoleId, {
      config: config,
    });
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    smtp = await startSmtp();
    t = await startTestApp({
      DATABASE_URL: database.url,
      SMTP_URL: smtp.url,
      SMTP_FROM: 'Cellhive <noreply@cellhive.test>',
      SMTP_ALLOW_INSECURE: 'true',
    });
    fx = await buildRecordFixture(t, db);
    records = t.app.get(RecordMutationService);
    query = t.app.get(RecordQueryService);
    storage = t.app.get<StorageDriver>(STORAGE_DRIVER);
    mailer = createMailService(t.config);
    files = await t.app
      .get(SchemaService)
      .addField(
        scope(),
        fx.orders.id,
        { name: 'Quyết định', type: 'attachment', options: { blocked_extensions: [] } },
        systemAuditContext(),
      );
    // CONTRACTS §5 Sales, with `manage` on Orders and the right to download `files`.
    const roles = new BaseRolesRepository(db);
    const sales = (await roles.listByBase(scope(), fx.baseId)).find(
      (role) => role.name === 'Sales',
    );
    if (sales === undefined) throw new Error('no Sales role');
    salesRoleId = sales.id;
    const config = sales.config as { tables: Record<string, { perm: string }> };
    const rule = config.tables[fx.orders.id];
    if (rule === undefined) throw new Error('no Sales rule');
    rule.perm = 'manage';
    await roles.update(scope(), fx.baseId, sales.id, { config: config });
    await setSalesDownload(true);
  });

  afterAll(async () => {
    mailer.close();
    await t.close();
    await db.destroy();
    await database.drop();
    await smtp.close();
  });

  describe('run', () => {
    it('sends a 2 MB PDF with its sniffed type and Vietnamese name; output counts only', async () => {
      const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2 * 1000 * 1000, 0x20)]);
      const att = await stored('Quyết định số 12.pdf', 'application/pdf', pdf);
      const runId = await queuedRun(sendEmail(), await order([att]));
      const before = smtp.messages.length;
      expect(await execute(runId)).toEqual({ status: 'succeeded' });
      const mail = smtp.messages[before];
      expect(mail?.to).toEqual(['nhanvien@partner.test']);
      const [file] = attachmentsOf(mail?.raw ?? '');
      expect(file?.type).toBe('application/pdf');
      expect(file?.name).toBe('Quyết định số 12.pdf');
      expect(file?.content.equals(pdf)).toBe(true);
      const step = await stepOf(runId);
      expect(step?.output).toMatchObject({
        attachment_count: 1,
        attachment_bytes: pdf.length,
        attachment_skipped: 0,
      });
      const output = JSON.stringify(step?.output);
      expect(output).not.toContain('Quyết định số 12');
      expect(output).not.toContain(att);
    });

    it('11 files over the limit of 10 → too_many_attachments, no email', async () => {
      const ids: Id<'att'>[] = [];
      for (let index = 0; index < 11; index += 1) {
        ids.push(await stored(`file-${String(index)}.txt`, 'text/plain', Buffer.from('x')));
      }
      const runId = await queuedRun(sendEmail(), await order(ids));
      const before = smtp.messages.length;
      expect(await execute(runId)).toMatchObject({ status: 'failed' });
      expect(smtp.messages.length).toBe(before);
      expect((await stepOf(runId))?.error).toMatchObject({
        code: 'too_many_attachments',
        params: { count: 11, limit: 10 },
      });
    });

    it('16 MiB over 15 MiB → attachments_too_large before any read', async () => {
      const att = await stored('big.pdf', 'application/pdf', Buffer.from('%PDF-1.7'));
      // The limits are checked on `meta.attachments.size`: the object is never read.
      await sql`UPDATE meta.attachments SET size = ${16 * MIB} WHERE id = ${att}`.execute(
        db.kysely,
      );
      const runId = await queuedRun(sendEmail(), await order([att]));
      const before = smtp.messages.length;
      expect(await execute(runId)).toMatchObject({ status: 'failed' });
      expect(smtp.messages.length).toBe(before);
      expect((await stepOf(runId))?.error).toMatchObject({
        code: 'attachments_too_large',
        params: { bytes: 16 * MIB, limit: 15 * MIB },
      });
    });

    it('.svg → attachment_type_blocked', async () => {
      const att = await stored('logo.svg', 'image/svg+xml', Buffer.from('<svg/>'));
      const runId = await queuedRun(sendEmail(), await order([att]));
      expect(await execute(runId)).toMatchObject({ status: 'failed' });
      expect((await stepOf(runId))?.error).toMatchObject({
        code: 'attachment_type_blocked',
        params: { extension: 'svg' },
      });
    });

    it('pending_scan → attachment_not_ready; with skip the email goes without it, counted', async () => {
      const scanned = await stored('scan.pdf', 'application/pdf', Buffer.from('%PDF-1.7'));
      const ok = await stored('ok.txt', 'text/plain', Buffer.from('hello'));
      const recordId = await order([scanned, ok]);
      await sql`UPDATE meta.attachments SET status = 'pending_scan' WHERE id = ${scanned}`.execute(
        db.kysely,
      );
      const failed = await queuedRun(sendEmail(), recordId);
      const before = smtp.messages.length;
      expect(await execute(failed)).toMatchObject({ status: 'failed' });
      expect(smtp.messages.length).toBe(before);
      expect((await stepOf(failed))?.error).toMatchObject({
        code: 'attachment_not_ready',
        params: { field_id: files.id, status: 'pending_scan' },
      });

      const skipped = await queuedRun(sendEmail({ on_missing_attachment: 'skip' }), recordId);
      expect(await execute(skipped)).toEqual({ status: 'succeeded' });
      const mail = smtp.messages[before];
      expect(attachmentsOf(mail?.raw ?? '').map((file) => file.name)).toEqual(['ok.txt']);
      expect((await stepOf(skipped))?.output).toMatchObject({
        attachment_count: 1,
        attachment_bytes: 5,
        attachment_skipped: 1,
      });
    });

    it('run_as losing the right to download → attachment_access_denied, no email', async () => {
      const att = await stored('hd.pdf', 'application/pdf', Buffer.from('%PDF-1.7'));
      const recordId = await order([att]);
      const runId = await queuedRun(sendEmail(), recordId, fx.users.u_sales1.id);
      await setSalesDownload(false);
      try {
        const before = smtp.messages.length;
        expect(await execute(runId)).toMatchObject({ status: 'failed' });
        expect(smtp.messages.length).toBe(before);
        expect((await stepOf(runId))?.error).toMatchObject({
          code: 'attachment_access_denied',
          params: { field_id: files.id },
        });
      } finally {
        await setSalesDownload(true);
      }
      // With the right back, the same configuration sends.
      const again = await queuedRun(sendEmail(), recordId, fx.users.u_sales1.id);
      expect(await execute(again)).toEqual({ status: 'succeeded' });
    });

    it('a record run_as cannot read (read rule) → attachment_access_denied', async () => {
      const att = await stored('hd2.pdf', 'application/pdf', Buffer.from('%PDF-1.7'));
      // Sales reads only the orders it owns.
      const recordId = await order([att], fx.users.u_sales2.id);
      const runId = await queuedRun(sendEmail(), recordId, fx.users.u_sales1.id);
      expect(await execute(runId)).toMatchObject({ status: 'failed' });
      expect((await stepOf(runId))?.error).toMatchObject({
        code: 'attachment_access_denied',
        params: { reason: 'record' },
      });
    });

    it('applies the lower limits of the organization', async () => {
      const patch = await fx.call('owner', 'PATCH', `/orgs/${fx.orgId}/email-settings`, {
        max_attachments: 1,
      });
      expect(patch.statusCode, patch.body).toBe(200);
      try {
        const a = await stored('a.txt', 'text/plain', Buffer.from('a'));
        const b = await stored('b.txt', 'text/plain', Buffer.from('b'));
        const runId = await queuedRun(sendEmail(), await order([a, b]));
        expect(await execute(runId)).toMatchObject({ status: 'failed' });
        expect((await stepOf(runId))?.error).toMatchObject({
          code: 'too_many_attachments',
          params: { count: 2, limit: 1 },
        });
      } finally {
        await fx.call('owner', 'PATCH', `/orgs/${fx.orgId}/email-settings`, {
          max_attachments: null,
        });
      }
    });

    it('streams a 30 MiB file from storage into SMTP, never holding it whole', async () => {
      const sink = await startSmtp({ discard: true });
      const config: AppConfig = {
        ...t.config,
        mail: t.config.mail === null ? null : { ...t.config.mail, url: sink.url },
        email: { ...t.config.email, maxAttachmentBytes: 30 * MIB },
      };
      const sinkMailer = createMailService(config);
      // How far reading the file ever got ahead of what SMTP received (in
      // original bytes; base64 sends 4 bytes for 3). Buffering the file whole
      // would read all 30 MiB before the first byte of the message is sent.
      const progress = { read: 0, lead: 0 };
      const watched = Object.create(storage) as StorageDriver;
      watched.getStream = async (key: string) => {
        const source = await storage.getStream(key);
        source?.on('data', (chunk: Buffer) => {
          progress.read += chunk.length;
          progress.lead = Math.max(
            progress.lead,
            progress.read - Math.floor((sink.received.bytes * 3) / 4),
          );
        });
        return source;
      };
      const streaming = new AutomationRunEngine(db, {
        defaults: { timeZone: 'Asia/Ho_Chi_Minh', locale: 'vi' },
        query,
        actions: defaultActionRegistry({ records, query }, [
          [
            'send_email',
            createSendEmailAction({ db, mailer: sinkMailer, config, storage: watched }),
          ],
        ]),
        publicUrl: TEST_PUBLIC_URL,
        notifier: NO_AUTOMATION_NOTIFICATIONS,
        random: () => 0,
      });
      try {
        const size = 30 * MIB;
        const att = await stored('ban-ve.pdf', 'application/pdf', size);
        const runId = await queuedRun(sendEmail(), await order([att]));
        expect(await execute(runId, streaming)).toEqual({ status: 'succeeded' });
        expect(progress.read).toBe(size);
        // base64 of 30 MiB is 40 MiB.
        expect(sink.messages[0]?.size).toBeGreaterThan(40 * MIB);
        expect(progress.lead).toBeLessThan(8 * MIB);
        expect((await stepOf(runId))?.output).toMatchObject({
          attachment_count: 1,
          attachment_bytes: size,
        });
      } finally {
        sinkMailer.close();
        await sink.close();
      }
    });
  });

  describe('save, preview and test (API)', () => {
    const create = (action: JsonObject, user: 'u_admin' | 'u_sales1' = 'u_admin') =>
      fx.call(user, 'POST', `/bases/${fx.baseId}/automations`, {
        name: 'Email',
        definition: {
          trigger: { type: 'record.created', table_id: fx.orders.id },
          actions: [action],
        },
      });
    const codesOf = (body: string) =>
      ((problemOf(body)['errors'] ?? []) as { code: string; path: string }[]).map((e) => [
        e.path,
        e.code,
      ]);

    it('checks the field type and the download right of the person saving', async () => {
      expect((await create(sendEmail())).statusCode).toBe(201);
      const text = await create(sendEmail({ attachments: [{ field: F('title') }] }));
      expect(text.statusCode).toBe(422);
      expect(codesOf(text.body)).toEqual([
        ['definition.actions[0].config.attachments[0].field', 'ATTACHMENT_FIELD_INVALID'],
      ]);
      await setSalesDownload(false);
      try {
        const sales = await create(sendEmail(), 'u_sales1');
        expect(sales.statusCode).toBe(422);
        expect(codesOf(sales.body)).toEqual([
          [
            'definition.actions[0].config.attachments[0].field',
            'ATTACHMENT_FIELD_NOT_DOWNLOADABLE',
          ],
        ]);
      } finally {
        await setSalesDownload(true);
      }
      expect((await create(sendEmail(), 'u_sales1')).statusCode).toBe(201);
    });

    it('previews the files, warns when they would fail, and test-sends the real files', async () => {
      const created = await create(sendEmail());
      expect(created.statusCode, created.body).toBe(201);
      const automationId = created.json<{ id: Id<'aut'> }>().id;
      const url = (kind: string) => `/automations/${automationId}/actions/act_mail/${kind}`;
      const contract = Buffer.from('%PDF-1.7 hợp đồng');
      const att = await stored('Hợp đồng.pdf', 'application/pdf', contract);
      const recordId = await order([att]);

      const preview = await fx.call('u_admin', 'POST', url('email-preview'), {
        record_id: recordId,
      });
      expect(preview.statusCode, preview.body).toBe(200);
      const body = automationEmailPreviewSchema.parse(preview.json());
      expect(body.attachments).toEqual([{ name: 'Hợp đồng.pdf', size: contract.length }]);
      expect(body.warnings.map((warning) => warning.code)).not.toContain('ATTACHMENTS_UNAVAILABLE');

      const before = smtp.messages.length;
      const test = await fx.call('u_admin', 'POST', url('email-test'), { record_id: recordId });
      expect(test.statusCode, test.body).toBe(200);
      expect(automationEmailTestResultSchema.parse(test.json())).toMatchObject({ status: 'sent' });
      const [file] = attachmentsOf(smtp.messages[before]?.raw ?? '');
      expect(file?.name).toBe('Hợp đồng.pdf');
      expect(file?.content.equals(contract)).toBe(true);

      // A file still being scanned: the preview warns, the test send refuses.
      await sql`UPDATE meta.attachments SET status = 'pending_scan' WHERE id = ${att}`.execute(
        db.kysely,
      );
      const warned = automationEmailPreviewSchema.parse(
        (await fx.call('u_admin', 'POST', url('email-preview'), { record_id: recordId })).json(),
      );
      expect(warned.attachments).toEqual([]);
      expect(warned.warnings).toContainEqual({
        code: 'ATTACHMENTS_UNAVAILABLE',
        params: { code: 'attachment_not_ready', field_id: files.id, status: 'pending_scan' },
      });
      const refused = await fx.call('u_admin', 'POST', url('email-test'), {
        record_id: recordId,
      });
      expectProblem(refused, 422, 'AUTOMATION_INVALID');
      expect(codesOf(refused.body)).toEqual([
        ['definition.actions[0].config.attachments', 'ATTACHMENTS_UNAVAILABLE'],
      ]);
      expect(smtp.messages.length).toBe(before + 1);
    });

    it('logs no file name or storage key', () => {
      const raw = t.logs.raw();
      expect(raw).not.toContain('Hợp đồng');
      expect(raw).not.toContain('Quyết định số 12');
      expect(raw).not.toContain(`${fx.orgId}/att_`);
    });
  });
});
