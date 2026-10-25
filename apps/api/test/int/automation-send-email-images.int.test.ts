import { once } from 'node:events';
import { Readable } from 'node:stream';

import {
  automationEmailPreviewSchema,
  automationEmailTestResultSchema,
  createUploadResponseSchema,
  emailAssetSchema,
  newId,
  type CreateUploadResponse,
  type EmailAssetDto,
  type Id,
  type ProblemErrorItem,
} from '@cellhive/contracts';
import {
  AttachmentsRepository,
  AutomationRunEngine,
  AutomationRunsRepository,
  AutomationRunStepsRepository,
  BaseRolesRepository,
  createMailService,
  createSendEmailAction,
  defaultActionRegistry,
  EmailAssetsRepository,
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
import { createAttachmentsCleanupTask, transcodeEmailImage } from '@cellhive/worker';
import { sql } from 'kysely';
import { pino } from 'pino';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { STORAGE_DRIVER } from '../../src/common/tokens.js';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { realPng, renderThumbnail } from './images.js';
import {
  buildRecordFixture,
  expectProblem,
  type FixtureUser,
  type RecordFixture,
} from './record-fixture.js';
import { problemOf, startTestApp, TEST_PUBLIC_URL, type TestApp } from './support.js';

import type { AddressInfo } from 'node:net';

interface ReceivedMail {
  readonly to: readonly string[];
  readonly raw: string;
}

/** An in-process SMTP server keeping every message. */
async function startSmtp() {
  const messages: ReceivedMail[] = [];
  const server = new SMTPServer({
    logger: false,
    disabledCommands: ['STARTTLS', 'AUTH'],
    authOptional: true,
    closeTimeout: 100,
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        messages.push({
          to: session.envelope.rcptTo.map((rcpt) => rcpt.address),
          raw: Buffer.concat(chunks).toString('latin1'),
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
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

interface MimePart {
  readonly headers: string;
  readonly body: string;
}

/** Every MIME part of a raw message, with unfolded headers. */
function partsOf(raw: string): MimePart[] {
  const boundaries = [...raw.matchAll(/boundary="?([^";\r\n]+)"?/gi)].map((match) => match[1]);
  const parts: MimePart[] = [];
  for (const boundary of boundaries) {
    if (boundary === undefined) continue;
    for (const chunk of raw.split(`--${boundary}`).slice(1)) {
      const split = chunk.search(/\r?\n\r?\n/);
      if (split === -1) continue;
      parts.push({
        headers: chunk.slice(0, split).replace(/\r?\n[ \t]+/g, ' '),
        body: chunk.slice(split).trim(),
      });
    }
  }
  return parts;
}

/** Inline image parts: Content-ID (without `<>`), type and decoded bytes. */
function inlineParts(raw: string) {
  return partsOf(raw)
    .filter((part) => /Content-Disposition:\s*inline/i.test(part.headers))
    .map((part) => ({
      cid: /Content-ID:\s*<([^>]+)>/i.exec(part.headers)?.[1] ?? '',
      type: /Content-Type:\s*([^;\r\n]+)/i.exec(part.headers)?.[1]?.trim() ?? '',
      content: Buffer.from(part.body.replace(/[\r\n]/g, ''), 'base64'),
    }));
}

/** The decoded HTML part (quoted-printable or base64). */
function htmlOf(raw: string): string {
  const part = partsOf(raw).find((item) => /Content-Type:\s*text\/html/i.test(item.headers));
  if (part === undefined) return '';
  if (/Content-Transfer-Encoding:\s*base64/i.test(part.headers)) {
    return Buffer.from(part.body.replace(/[\r\n]/g, ''), 'base64').toString('utf8');
  }
  const bytes = part.body
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return Buffer.from(bytes, 'latin1').toString('utf8');
}

function textOf(raw: string): string {
  const part = partsOf(raw).find((item) => /Content-Type:\s*text\/plain/i.test(item.headers));
  if (part === undefined) return '';
  if (/Content-Transfer-Encoding:\s*base64/i.test(part.headers)) {
    return Buffer.from(part.body.replace(/[\r\n]/g, ''), 'base64').toString('utf8');
  }
  const bytes = part.body
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return Buffer.from(bytes, 'latin1').toString('utf8');
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

function detailsOf(body: string): [string, string][] {
  const errors = (problemOf(body) as unknown as { errors?: readonly ProblemErrorItem[] }).errors;
  return (errors ?? []).map((item) => [item.path, item.code]);
}

const LOGO = realPng(2000, 100);
const BANNER = realPng(300, 200);
const PHOTO = realPng(640, 480);

/**
 * BACKLOG T534 (inline CID images, CONTRACTS §21/§23.5): signature and body
 * images uploaded as email assets (organization owners/admins, automation
 * managers), checked when saved, sent as inline `cid:` parts through the
 * run engine to an in-process SMTP server, images of an attachment field of
 * the trigger record (thumbnails, `ready` only, `run_as` download right),
 * the limits, preview and test send, and the cleanup of unused assets.
 */
describe('send_email inline images (T534)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let smtp: Awaited<ReturnType<typeof startSmtp>>;
  let records: RecordMutationService;
  let query: RecordQueryService;
  let storage: StorageDriver;
  let mailer: Mailer;
  let photos: FieldRow;
  let salesRoleId: Id<'rol'>;
  let automationId: Id<'aut'>;
  let logo: EmailAssetDto;
  let banner: EmailAssetDto;

  const scope = () => orgScope(fx.orgId);
  const F = (name: string) => fx.fld[name]?.id as Id<'fld'>;
  const orgAssets = () => `/orgs/${fx.orgId}/email-assets`;
  const automationAssets = (id: Id<'aut'> = automationId) => `/automations/${id}/email-assets`;

  function engine(config: AppConfig = t.config): AutomationRunEngine {
    return new AutomationRunEngine(db, {
      defaults: { timeZone: 'Asia/Ho_Chi_Minh', locale: 'vi' },
      query,
      actions: defaultActionRegistry({ records, query }, [
        [
          'send_email',
          createSendEmailAction({
            db,
            mailer,
            config,
            storage,
            transcodeImage: transcodeEmailImage,
          }),
        ],
      ]),
      publicUrl: TEST_PUBLIC_URL,
      notifier: NO_AUTOMATION_NOTIFICATIONS,
      random: () => 0,
    });
  }

  async function put(target: CreateUploadResponse, bytes: Buffer): Promise<void> {
    const url = new URL(target.upload.url);
    const response = await t.app.inject({
      method: 'PUT',
      url: url.pathname + url.search,
      headers: target.upload.headers,
      payload: bytes,
    });
    expect(response.statusCode, response.body).toBe(200);
  }

  async function startUpload(user: FixtureUser, prefix: string, bytes: Buffer, mime = 'image/png') {
    return fx.call(user, 'POST', `${prefix}/uploads`, {
      filename: 'Logo công ty.png',
      size: bytes.length,
      mime,
    });
  }

  async function upload(
    user: FixtureUser,
    prefix: string,
    bytes: Buffer,
    mime = 'image/png',
  ): Promise<EmailAssetDto> {
    const started = await startUpload(user, prefix, bytes, mime);
    expect(started.statusCode, started.body).toBe(201);
    const target = createUploadResponseSchema.parse(started.json());
    await put(target, bytes);
    const done = await fx.call(user, 'POST', `${prefix}/uploads/${target.id}/complete`);
    expect(done.statusCode, done.body).toBe(200);
    return emailAssetSchema.parse(done.json());
  }

  /** A ready image attachment of `photos` (no cell yet), with its thumbnails rendered. */
  async function photo(
    bytes: Buffer = PHOTO,
    options: { thumbnail?: boolean } = {},
  ): Promise<Id<'att'>> {
    const repo = new AttachmentsRepository(db);
    const row = await repo.create(scope(), {
      baseId: fx.baseId,
      tableId: fx.orders.id,
      fieldId: photos.id,
      createdBy: fx.users.u_admin.id,
      filename: 'Ảnh hiện trường.png',
      mime: 'image/png',
      size: bytes.length,
    });
    await storage.putStream(row.object_key, Readable.from([bytes]), {
      contentType: 'image/png',
      contentLength: bytes.length,
    });
    await repo.markReady(scope(), row.id, { size: bytes.length, sha256: '0'.repeat(64) });
    if (options.thumbnail !== false) {
      await sql`UPDATE meta.attachments SET thumbnail_status = 'pending' WHERE id = ${row.id}`.execute(
        db.kysely,
      );
      await renderThumbnail(db, storage, fx.orgId, row.id);
    }
    return row.id;
  }

  async function order(images: Id<'att'>[], title = 'Sự cố'): Promise<Id<'rec'>> {
    const response = await fx.call(
      'u_admin',
      'POST',
      `/tables/${fx.orders.id}/records?field_key_type=id`,
      {
        records: [
          {
            fields: {
              [F('title')]: title,
              [F('owner')]: [{ id: fx.users.u_sales1.id }],
              [photos.id]: images.map((id) => ({ id })),
            },
          },
        ],
      },
    );
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ records: { id: Id<'rec'> }[] }>().records[0]?.id as Id<'rec'>;
  }

  function sendEmail(template: string, config: Record<string, unknown> = {}): JsonObject {
    return {
      id: 'act_mail',
      type: 'send_email',
      config: {
        identity_id: null,
        to: [{ literal: 'khach@partner.test' }],
        subject: { template: 'Báo cáo sự cố' },
        body: { format: 'markdown', template, digest: null },
        include_signature: true,
        footer: 'minimal',
        ...config,
      },
    };
  }

  const definitionOf = (action: JsonObject) => ({
    trigger: { type: 'record.created', table_id: fx.orders.id, skip_bulk: false },
    condition: null,
    actions: [action],
  });

  /** Saves `action` in the automation through the API (as `user`). */
  async function save(action: JsonObject, user: FixtureUser = 'u_admin') {
    return fx.call(user, 'PATCH', `/automations/${automationId}`, {
      definition: definitionOf(action),
    });
  }

  /** A queued run of the automation's saved definition on `recordId`, as `runAs`. */
  async function queuedRun(recordId: Id<'rec'>, runAs: Id<'usr'> = fx.users.u_admin.id) {
    await sql`UPDATE meta.automations SET run_as_user_id = ${runAs} WHERE id = ${automationId}`.execute(
      db.kysely,
    );
    const row = await sql<{ definition: JsonObject }>`
      SELECT definition FROM meta.automations WHERE id = ${automationId}`.execute(db.kysely);
    const definition = row.rows[0]?.definition ?? {};
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
    rule.field_rule.file_download_fields = download ? [photos.id] : [];
    await roles.update(scope(), fx.baseId, salesRoleId, { config });
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
    photos = await t.app
      .get(SchemaService)
      .addField(
        scope(),
        fx.orders.id,
        { name: 'Ảnh', type: 'attachment', options: { blocked_extensions: [] } },
        systemAuditContext(),
      );
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
    await roles.update(scope(), fx.baseId, sales.id, { config });
    await setSalesDownload(true);

    const created = await fx.call('u_admin', 'POST', `/bases/${fx.baseId}/automations`, {
      name: 'Báo cáo',
      definition: definitionOf(sendEmail('Xin chào')),
    });
    expect(created.statusCode, created.body).toBe(201);
    automationId = created.json<{ id: Id<'aut'> }>().id;
  });

  afterAll(async () => {
    mailer.close();
    await t.close();
    await db.destroy();
    await database.drop();
    await smtp.close();
  });

  describe('signature images (organization owners/admins)', () => {
    it('uploads, re-encodes within 1280 px and previews through a signed URL', async () => {
      logo = await upload('owner', orgAssets(), LOGO);
      expect(logo).toMatchObject({
        kind: 'signature',
        name: 'Logo công ty.png',
        mime: 'image/png',
        width: 1280,
        height: 64,
        markdown: `![Logo công ty](asset:${logo.id} =552)`,
        url: `/api/v1/orgs/${fx.orgId}/email-assets/${logo.id}`,
      });
      expect(logo.size).toBeLessThanOrEqual(2 * 1024 * 1024);
      const row = await new EmailAssetsRepository(db).getById(scope(), logo.id);
      expect(row?.status).toBe('ready');
      const stored = await storage.head(row?.object_key ?? '');
      expect(stored?.size).toBe(logo.size);

      const read = await fx.call('owner', 'GET', `${orgAssets()}/${logo.id}`);
      expect(read.statusCode).toBe(302);
      expect(read.headers['cache-control']).toBe('private, no-store');
    });

    it('is for owners/admins only: members 403, other organizations 404', async () => {
      const body = { filename: 'a.png', size: LOGO.length, mime: 'image/png' };
      expectProblem(
        await fx.call('u_admin', 'POST', `${orgAssets()}/uploads`, body),
        403,
        'PERMISSION_DENIED',
      );
      expectProblem(
        await fx.call('stranger', 'POST', `${orgAssets()}/uploads`, body),
        404,
        'NOT_FOUND',
      );
      expectProblem(
        await fx.call('u_admin', 'GET', `${orgAssets()}/${logo.id}`),
        403,
        'PERMISSION_DENIED',
      );
      expectProblem(
        await fx.call('stranger', 'GET', `${orgAssets()}/${logo.id}`),
        404,
        'NOT_FOUND',
      );
    });

    it('refuses SVG and content that is not the announced image', async () => {
      const svg = await startUpload('owner', orgAssets(), Buffer.from('<svg/>'), 'image/svg+xml');
      expectProblem(svg, 422, 'VALIDATION_FAILED');
      expect(detailsOf(svg.body)).toEqual([['mime', 'MIME_NOT_ACCEPTED']]);

      const pdf = Buffer.from('%PDF-1.7\n%%EOF\n');
      const started = await startUpload('owner', orgAssets(), pdf, 'image/png');
      const target = createUploadResponseSchema.parse(started.json());
      await put(target, pdf);
      const done = await fx.call('owner', 'POST', `${orgAssets()}/uploads/${target.id}/complete`);
      expectProblem(done, 422, 'VALIDATION_FAILED');
      expect(detailsOf(done.body)).toEqual([['', 'CONTENT_MISMATCH']]);
      expect(await new EmailAssetsRepository(db).getById(scope(), target.id)).toBeUndefined();
    });

    it('saves signatures with organization signature images only', async () => {
      const patch = (markdown: string) =>
        fx.call('owner', 'PATCH', `/orgs/${fx.orgId}/email-settings`, {
          default_signature_md: markdown,
        });
      const remote = await patch('![x](https://evil.example/p.png)');
      expectProblem(remote, 422, 'VALIDATION_FAILED');
      expect(detailsOf(remote.body)).toEqual([
        ['default_signature_md', 'IMAGE_SOURCE_NOT_ALLOWED'],
      ]);
      const data = await patch('![x](data:image/png;base64,AAAA)');
      expect(detailsOf(data.body)).toEqual([['default_signature_md', 'IMAGE_SOURCE_NOT_ALLOWED']]);
      const three = await patch(
        `![a](asset:${logo.id})\n![b](asset:${logo.id})\n![c](asset:${logo.id})`,
      );
      expect(detailsOf(three.body)).toEqual([['default_signature_md', 'TOO_MANY_IMAGES']]);
      const unknown = await patch('![a](asset:att_Unknown000000001)');
      expect(detailsOf(unknown.body)).toEqual([['default_signature_md', 'EMAIL_IMAGE_NOT_FOUND']]);

      const saved = await patch(`**Phòng Kỹ thuật**\n![Logo](asset:${logo.id} =160)`);
      expect(saved.statusCode, saved.body).toBe(200);

      // Sender identities take the same images.
      const identity = await fx.call('owner', 'POST', `/orgs/${fx.orgId}/email-identities`, {
        email: 'kythuat@cellhive.test',
        display_name: 'Kỹ thuật',
        transport: 'system',
        signature_md: `![Logo](asset:${logo.id})`,
      });
      expect(identity.statusCode, identity.body).toBe(201);
    });

    it('deletes only an image nothing shows', async () => {
      expectProblem(
        await fx.call('owner', 'DELETE', `${orgAssets()}/${logo.id}`),
        422,
        'VALIDATION_FAILED',
      );
      const spare = await upload('owner', orgAssets(), BANNER);
      expect((await fx.call('owner', 'DELETE', `${orgAssets()}/${spare.id}`)).statusCode).toBe(204);
      expect(await new EmailAssetsRepository(db).getById(scope(), spare.id)).toBeUndefined();
    });
  });

  describe('body images (automation managers)', () => {
    it('uploads for managers only', async () => {
      const body = { filename: 'a.png', size: BANNER.length, mime: 'image/png' };
      expectProblem(
        await fx.call('u_reader', 'POST', `${automationAssets()}/uploads`, body),
        403,
        'PERMISSION_DENIED',
      );
      expectProblem(
        await fx.call('stranger', 'POST', `${automationAssets()}/uploads`, body),
        404,
        'NOT_FOUND',
      );
      banner = await upload('u_admin', automationAssets(), BANNER);
      expect(banner).toMatchObject({ kind: 'automation', width: 300, height: 200 });
      // The organization route does not serve an automation's image, nor the reverse.
      expectProblem(await fx.call('owner', 'GET', `${orgAssets()}/${banner.id}`), 404, 'NOT_FOUND');
      expectProblem(
        await fx.call('u_admin', 'GET', `${automationAssets()}/${logo.id}`),
        404,
        'NOT_FOUND',
      );
    });

    it('checks body images when the automation is saved', async () => {
      const path = 'definition.actions[0].config.body.template';
      const remote = await save(sendEmail('![x](https://evil.example/p.png)'));
      expectProblem(remote, 422, 'AUTOMATION_INVALID');
      expect(detailsOf(remote.body)).toEqual([[path, 'IMAGE_SOURCE_NOT_ALLOWED']]);
      const signatureImage = await save(sendEmail(`![x](asset:${logo.id})`));
      expect(detailsOf(signatureImage.body)).toEqual([[path, 'EMAIL_IMAGE_NOT_FOUND']]);
      const notAttachment = await save(sendEmail(`![x](field:${F('title')})`));
      expect(detailsOf(notAttachment.body)).toEqual([[path, 'ATTACHMENT_FIELD_INVALID']]);
      const six = await save(
        sendEmail(
          `![a](asset:${banner.id}) ![b](field:${photos.id}) ` +
            Array.from(
              { length: 4 },
              (_, i) => `![${String(i)}](asset:att_Other0000000000${String(i)})`,
            ).join(' '),
        ),
      );
      expect(detailsOf(six.body)).toContainEqual([path, 'TOO_MANY_IMAGES']);
      // Someone who may not download the field's files cannot show them.
      await setSalesDownload(false);
      try {
        const sales = await save(sendEmail(`![p](field:${photos.id})`), 'u_sales1');
        expect(detailsOf(sales.body)).toEqual([[path, 'ATTACHMENT_FIELD_NOT_DOWNLOADABLE']]);
      } finally {
        await setSalesDownload(true);
      }
      const ok = await save(
        sendEmail(
          `Chào **{{ [${F('title')}] }}**\n\n![Banner](asset:${banner.id})\n\n![Ảnh](field:${photos.id})`,
        ),
      );
      expect(ok.statusCode, ok.body).toBe(200);
    });
  });

  describe('run', () => {
    it('sends signature, body and field images as inline cid: parts only', async () => {
      const ready = await photo();
      const scanning = await photo();
      const pdf = await new AttachmentsRepository(db).create(scope(), {
        baseId: fx.baseId,
        tableId: fx.orders.id,
        fieldId: photos.id,
        createdBy: fx.users.u_admin.id,
        filename: 'biên bản.pdf',
        mime: 'application/pdf',
        size: 10,
      });
      await new AttachmentsRepository(db).markReady(scope(), pdf.id, {
        size: 10,
        sha256: '0'.repeat(64),
      });
      // A record value that looks like an image stays text.
      const recordId = await order(
        [ready, scanning, pdf.id],
        `![x](cid:${banner.id}@cellhive) <img src="https://evil.example/p.png">`,
      );
      // Scanned again after it was attached (virus scanning, Phase 2): not sent.
      await sql`UPDATE meta.attachments SET status = 'pending_scan' WHERE id = ${scanning}`.execute(
        db.kysely,
      );
      const runId = await queuedRun(recordId);
      const before = smtp.messages.length;
      expect(await execute(runId)).toEqual({ status: 'succeeded' });
      const raw = smtp.messages[before]?.raw ?? '';
      const html = htmlOf(raw);
      const parts = inlineParts(raw);
      expect(parts.map((part) => part.cid).sort()).toEqual(
        [`${banner.id}@cellhive`, `${ready}@cellhive`, `${logo.id}@cellhive`].sort(),
      );
      // Field images: the WebP thumbnail re-encoded as JPEG (Outlook for Windows renders no WebP).
      const field = parts.find((part) => part.cid === `${ready}@cellhive`);
      expect(field?.type).toBe('image/jpeg');
      expect([...(field?.content.subarray(0, 3) ?? [])]).toEqual([0xff, 0xd8, 0xff]);
      expect(raw).not.toMatch(/image\/webp/u);
      expect(parts.find((part) => part.cid === `${banner.id}@cellhive`)?.content.length).toBe(
        banner.size,
      );
      // Every <img> is a cid: of a part of this message; nothing remote.
      const sources = [...html.matchAll(/<img src="([^"]+)"/gu)].map((match) => match[1]);
      expect(sources.sort()).toEqual(parts.map((part) => `cid:${part.cid}`).sort());
      expect(html).not.toMatch(/<img[^>]+(?:https?:|data:)/u);
      expect(html).toContain('&lt;img src="https://evil.example/p.png"&gt;');
      expect(html).toContain(`alt="Logo" width="160"`);
      const text = textOf(raw);
      expect(text).toContain('[Banner]');
      expect(text).toContain('[Logo]');
      const step = await stepOf(runId);
      expect(step?.output).toMatchObject({
        inline_image_count: 3,
        inline_image_skipped: 1,
        attachment_count: 0,
        warnings: [{ code: 'inline_image_skipped', field_id: photos.id }],
      });
      expect(JSON.stringify(step?.output)).not.toContain('Ảnh hiện trường');
    });

    it('leaves out field images run_as may not download, with a warning', async () => {
      const recordId = await order([await photo()]);
      await setSalesDownload(false);
      try {
        const runId = await queuedRun(recordId, fx.users.u_sales1.id);
        const before = smtp.messages.length;
        expect(await execute(runId)).toEqual({ status: 'succeeded' });
        const parts = inlineParts(smtp.messages[before]?.raw ?? '');
        expect(parts.map((part) => part.cid).sort()).toEqual(
          [`${banner.id}@cellhive`, `${logo.id}@cellhive`].sort(),
        );
        expect((await stepOf(runId))?.output).toMatchObject({
          inline_image_count: 2,
          warnings: [{ code: 'inline_image_skipped', field_id: photos.id }],
        });
      } finally {
        await setSalesDownload(true);
      }
    });

    it('fails without sending over EMAIL_MAX_INLINE_IMAGES or the byte limit', async () => {
      const ids: Id<'att'>[] = [];
      for (let index = 0; index < 4; index += 1) ids.push(await photo());
      const recordId = await order(ids);
      const before = smtp.messages.length;
      // 4 field images + banner + logo = 6 > 5.
      const many = await queuedRun(recordId);
      expect(await execute(many), JSON.stringify((await stepOf(many))?.output)).toMatchObject({
        status: 'failed',
      });
      expect((await stepOf(many))?.error).toMatchObject({
        code: 'too_many_attachments',
        params: { scope: 'inline_images', count: 6, limit: 5 },
      });
      // Bytes: the images count toward the attachment byte limit.
      const small = { ...t.config, email: { ...t.config.email, maxAttachmentBytes: 10 } };
      const bytes = await queuedRun(await order([]));
      expect(await execute(bytes, engine(small))).toMatchObject({ status: 'failed' });
      expect((await stepOf(bytes))?.error).toMatchObject({
        code: 'attachments_too_large',
        params: { limit: 10 },
      });
      expect(smtp.messages.length).toBe(before);
    });
  });

  describe('preview and test send', () => {
    it('previews images through signed URLs of the viewer and test-sends them inline', async () => {
      const recordId = await order([await photo()]);
      const url = (kind: string) => `/automations/${automationId}/actions/act_mail/${kind}`;
      const preview = await fx.call('u_admin', 'POST', url('email-preview'), {
        record_id: recordId,
      });
      expect(preview.statusCode, preview.body).toBe(200);
      const body = automationEmailPreviewSchema.parse(preview.json());
      expect(body.images.map((image) => image.cid)).toHaveLength(3);
      for (const image of body.images) {
        expect(body.html).toContain(`src="cid:${image.cid}"`);
        expect(image.url).toMatch(/^https?:\/\//u);
        expect(body.html).not.toContain(image.url);
      }

      const before = smtp.messages.length;
      const test = await fx.call('u_admin', 'POST', url('email-test'), { record_id: recordId });
      expect(test.statusCode, test.body).toBe(200);
      expect(automationEmailTestResultSchema.parse(test.json())).toMatchObject({ status: 'sent' });
      const parts = inlineParts(smtp.messages[before]?.raw ?? '');
      expect(parts.map((part) => part.cid)).toContain(`${logo.id}@cellhive`);
    });
  });

  describe('cleanup', () => {
    it('deletes assets nothing references after 24 hours, with their object', async () => {
      const unused = await upload('owner', orgAssets(), BANNER);
      const unusedRow = await new EmailAssetsRepository(db).getById(scope(), unused.id);
      const task = createAttachmentsCleanupTask({
        db,
        storage,
        logger: pino({ level: 'silent' }),
        now: () => new Date(Date.now() + 25 * 60 * 60 * 1000),
      });
      await task(undefined as never, {} as never);
      expect(await new EmailAssetsRepository(db).getById(scope(), unused.id)).toBeUndefined();
      expect(await storage.head(unusedRow?.object_key ?? '')).toBeNull();
      // Referenced ones stay: the default signature's logo, the automation's banner.
      expect(await new EmailAssetsRepository(db).getById(scope(), logo.id)).toBeDefined();
      expect(await new EmailAssetsRepository(db).getById(scope(), banner.id)).toBeDefined();
    });

    it('logs no file name or storage key', () => {
      const raw = t.logs.raw();
      expect(raw).not.toContain('Logo công ty');
      expect(raw).not.toContain('Ảnh hiện trường');
      expect(raw).not.toContain(`${fx.orgId}/att_`);
    });
  });
});
