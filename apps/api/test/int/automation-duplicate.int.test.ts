import { once } from 'node:events';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  automationEmailTestResultSchema,
  automationListSchema,
  automationSchema,
  createUploadResponseSchema,
  emailAssetSchema,
  fieldSchema,
  MAX_AUTOMATION_NAME_LENGTH,
  newId,
  type AutomationDto,
  type CreateUploadResponse,
  type EmailAssetDto,
  type Id,
  type ProblemErrorItem,
} from '@cellhive/contracts';
import {
  AutomationRunsRepository,
  BaseRolesRepository,
  EmailAssetsRepository,
  orgScope,
  type Db,
  type EmailAssetRow,
  type JsonObject,
  type StorageDriver,
} from '@cellhive/server-core';
import { createAttachmentsCleanupTask } from '@cellhive/worker';
import { sql } from 'kysely';
import { pino } from 'pino';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { STORAGE_DRIVER } from '../../src/common/tokens.js';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { realPng } from './images.js';
import {
  buildRecordFixture,
  expectProblem,
  type FixtureUser,
  type RecordFixture,
} from './record-fixture.js';
import { problemOf, startTestApp, type TestApp } from './support.js';

import type { AddressInfo } from 'node:net';
import type { Readable } from 'node:stream';

/** An in-process SMTP server keeping every raw message. */
async function startSmtp() {
  const messages: string[] = [];
  const server = new SMTPServer({
    logger: false,
    disabledCommands: ['STARTTLS', 'AUTH'],
    authOptional: true,
    closeTimeout: 100,
    onData(stream, _session, callback) {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        messages.push(Buffer.concat(chunks).toString('latin1'));
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

/** Content-ID (without `<>`) and decoded bytes of every inline part of a raw message. */
function inlineParts(raw: string): { cid: string; content: Buffer }[] {
  const boundaries = [...raw.matchAll(/boundary="?([^";\r\n]+)"?/gi)].map((match) => match[1]);
  const parts: { cid: string; content: Buffer }[] = [];
  for (const boundary of boundaries) {
    if (boundary === undefined) continue;
    for (const chunk of raw.split(`--${boundary}`).slice(1)) {
      const split = chunk.search(/\r?\n\r?\n/);
      if (split === -1) continue;
      const headers = chunk.slice(0, split).replace(/\r?\n[ \t]+/g, ' ');
      if (!/Content-Disposition:\s*inline/i.test(headers)) continue;
      parts.push({
        cid: /Content-ID:\s*<([^>]+)>/i.exec(headers)?.[1] ?? '',
        content: Buffer.from(
          chunk
            .slice(split)
            .trim()
            .replace(/[\r\n]/g, ''),
          'base64',
        ),
      });
    }
  }
  return parts;
}

function detailsOf(body: string): ProblemErrorItem[] {
  return [...((problemOf(body) as { errors?: readonly ProblemErrorItem[] }).errors ?? [])];
}

async function bytesOf(stream: Readable | null): Promise<Buffer | null> {
  if (stream === null) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Every file under `dir` (relative paths); `[]` when it does not exist. */
async function filesUnder(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))
      .sort();
  } catch {
    return [];
  }
}

const BANNER = realPng(300, 200);
const PHOTO = realPng(640, 480);
const HOUR_MS = 60 * 60 * 1000;

/**
 * BACKLOG T551 (CONTRACTS §21, "Quyết định S5b" #4, Tồn đọng S5 T534):
 * `POST /automations/:id/duplicate` — a copy in the same base, off, the
 * caller `run_as`, its definition checked with the caller's own permissions
 * like a create (P43), body images copied (rows + objects, same
 * organization) and `asset:<id>` replaced, `button.clicked` refused
 * (`BUTTON_IN_USE`), runs not copied, `automation.created`
 * (`after.duplicated_from`) + `automation.run_as_changed` (`created`), and
 * nothing left behind when the copy is refused or its save fails. Fixture
 * variant of P29/P32/P33: Sales `manage`s Orders.
 */
describe('duplicate an automation (T551)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let smtp: Awaited<ReturnType<typeof startSmtp>>;
  let storage: StorageDriver;
  let recordId: Id<'rec'>;

  const scope = () => orgScope(fx.orgId);
  const F = (name: string) => fx.fld[name]?.id as Id<'fld'>;
  const assetsOf = (id: Id<'aut'>) => `/automations/${id}/email-assets`;
  const orgObjects = () => filesUnder(join(t.storageRoot, 'objects'));

  function ok(response: { statusCode: number; body: string }, status = 200): AutomationDto {
    expect(response.statusCode, response.body).toBe(status);
    return automationSchema.parse(JSON.parse(response.body));
  }

  async function upload(user: FixtureUser, prefix: string, bytes: Buffer): Promise<EmailAssetDto> {
    const started = await fx.call(user, 'POST', `${prefix}/uploads`, {
      filename: 'Ảnh thân thư.png',
      size: bytes.length,
      mime: 'image/png',
    });
    expect(started.statusCode, started.body).toBe(201);
    const target: CreateUploadResponse = createUploadResponseSchema.parse(started.json());
    const url = new URL(target.upload.url);
    const put = await t.app.inject({
      method: 'PUT',
      url: url.pathname + url.search,
      headers: target.upload.headers,
      payload: bytes,
    });
    expect(put.statusCode, put.body).toBe(200);
    const done = await fx.call(user, 'POST', `${prefix}/uploads/${target.id}/complete`);
    expect(done.statusCode, done.body).toBe(200);
    return emailAssetSchema.parse(done.json());
  }

  function sendEmail(template: string): JsonObject {
    return {
      id: 'act_mail',
      type: 'send_email',
      config: {
        identity_id: null,
        to: [{ literal: 'khach@partner.test' }],
        subject: { template: 'Báo cáo' },
        body: { format: 'markdown', template, digest: null },
        include_signature: false,
        footer: 'minimal',
      },
    };
  }

  const onOrders = (actions: JsonObject[]) => ({
    trigger: { type: 'record.created', table_id: fx.orders.id, skip_bulk: false },
    condition: null,
    actions,
  });
  const setAmount = (field = F('amount')): JsonObject => ({
    id: 'act_set',
    type: 'update_record',
    config: { table_id: fx.orders.id, record_id: null, fields: { [field]: { literal: 1 } } },
  });

  async function create(
    user: FixtureUser,
    actions: JsonObject[],
    body: Record<string, unknown> = {},
  ): Promise<AutomationDto> {
    return ok(
      await fx.call(user, 'POST', `/bases/${fx.baseId}/automations`, {
        name: 'Báo cáo sự cố',
        definition: onOrders(actions),
        ...body,
      }),
      201,
    );
  }

  /** An automation of `user` whose `send_email` body shows two images uploaded for it. */
  async function withTwoImages(user: FixtureUser = 'u_admin', extra: JsonObject[] = []) {
    const automation = await create(user, [sendEmail('Xin chào')]);
    const banner = await upload(user, assetsOf(automation.id), BANNER);
    const photo = await upload(user, assetsOf(automation.id), PHOTO);
    const saved = ok(
      await fx.call(user, 'PATCH', `/automations/${automation.id}`, {
        definition: onOrders([
          sendEmail(
            `Chào **{{ [${F('title')}] }}**\n\n![Banner](asset:${banner.id} =300)\n\n![Ảnh](asset:${photo.id})`,
          ),
          ...extra,
        ]),
      }),
    );
    return { automation: saved, banner, photo };
  }

  const duplicate = (user: FixtureUser, id: Id<'aut'>, body?: unknown) =>
    fx.call(user, 'POST', `/automations/${id}/duplicate`, body);

  async function counts() {
    const { rows } = await sql<{ automations: number; assets: number }>`
      SELECT (SELECT count(*)::int FROM meta.automations) AS automations,
             (SELECT count(*)::int FROM meta.email_assets) AS assets
    `.execute(db.kysely);
    return { ...rows[0], objects: (await orgObjects()).length };
  }

  const templateOf = (automation: AutomationDto) => {
    const action = automation.definition.actions[0];
    return action?.type === 'send_email' ? action.config.body.template : '';
  };
  const assetIdsIn = (template: string) =>
    [...template.matchAll(/asset:(att_[0-9A-Za-z]{16})/gu)].map((match) => match[1] as Id<'att'>);

  async function auditOf(id: Id<'aut'>) {
    const { rows } = await sql<{
      action: string;
      actor_id: string;
      before: unknown;
      after: Record<string, unknown> | null;
      organization_id: string;
    }>`
      SELECT action, actor_id, before, after, organization_id FROM meta.audit_logs
       WHERE entity_type = 'automation' AND entity_id = ${id}
       ORDER BY created_at, action
    `.execute(db.kysely);
    return rows;
  }

  async function eventsOf(id: Id<'aut'>) {
    const { rows } = await sql<{ type: string; organization_id: string }>`
      SELECT type, organization_id FROM meta.events WHERE entity_id = ${id}
       ORDER BY created_at, type
    `.execute(db.kysely);
    return rows;
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
    storage = t.app.get<StorageDriver>(STORAGE_DRIVER);
    // The fixture variant of P29/P32/P33: Sales `manage`s Orders.
    const roles = new BaseRolesRepository(db);
    const sales = (await roles.listByBase(scope(), fx.baseId)).find(
      (role) => role.name === 'Sales',
    );
    if (sales === undefined) throw new Error('no Sales role');
    const config = sales.config as { tables: Record<string, { perm: string }> };
    const rule = config.tables[fx.orders.id];
    if (rule === undefined) throw new Error('no Sales rule');
    rule.perm = 'manage';
    await roles.update(scope(), fx.baseId, sales.id, { config });
    // u_sales1 reads English; everyone else the organization's Vietnamese.
    await sql`UPDATE meta.users SET locale = 'en' WHERE id = ${fx.users.u_sales1.id}`.execute(
      db.kysely,
    );
    const created = await fx.call(
      'u_admin',
      'POST',
      `/tables/${fx.orders.id}/records?field_key_type=id`,
      {
        records: [
          { fields: { [F('title')]: 'Sự cố', [F('owner')]: [{ id: fx.users.u_sales1.id }] } },
        ],
      },
    );
    expect(created.statusCode, created.body).toBe(201);
    recordId = created.json<{ records: { id: Id<'rec'> }[] }>().records[0]?.id as Id<'rec'>;
  });

  afterAll(async () => {
    await t.close();
    await db.destroy();
    await database.drop();
    await smtp.close();
  });

  it('copies an automation with two body images: off, caller run_as, images of its own', async () => {
    const { automation: source, banner, photo } = await withTwoImages();
    ok(await fx.call('u_admin', 'POST', `/automations/${source.id}/enable`));
    // A run of the source: runs, history and counters are not copied.
    await new AutomationRunsRepository(db).insert(scope(), {
      id: newId('run'),
      automationId: source.id,
      automationVersion: 1,
      triggerEventId: null,
      triggerUnit: newId('evt'),
      status: 'queued',
      depth: 0,
      input: {},
    });
    const before = await counts();

    const copy = ok(await duplicate('u_admin', source.id), 201);
    expect(copy).toMatchObject({
      base_id: fx.baseId,
      name: 'Báo cáo sự cố (bản sao)',
      description: source.description,
      enabled: false,
      disabled_reason: null,
      version: 1,
      run_as: { id: fx.users.u_admin.id },
      created_by: { id: fx.users.u_admin.id },
    });
    expect(copy.id).not.toBe(source.id);
    // The definition is the source's, its images replaced by two new ones.
    const copied = assetIdsIn(templateOf(copy));
    expect(copied).toHaveLength(2);
    expect(copied).not.toContain(banner.id);
    expect(copied).not.toContain(photo.id);
    expect(templateOf(copy)).toBe(
      templateOf(source)
        .replace(banner.id, copied[0] ?? '')
        .replace(photo.id, copied[1] ?? ''),
    );
    expect({ ...copy.definition, actions: [] }).toEqual({ ...source.definition, actions: [] });
    expect(await counts()).toEqual({
      automations: (before.automations ?? 0) + 1,
      assets: (before.assets ?? 0) + 2,
      objects: before.objects + 2,
    });
    const repo = new EmailAssetsRepository(db);
    for (const [index, sourceAsset] of [banner, photo].entries()) {
      const row = await repo.getById(scope(), copied[index] as Id<'att'>);
      const original = await repo.getById(scope(), sourceAsset.id);
      expect(row).toMatchObject({
        organization_id: fx.orgId,
        kind: 'automation',
        automation_id: copy.id,
        status: 'ready',
        object_key: `${fx.orgId}/${String(copied[index])}`,
        filename: original?.filename,
        size: original?.size,
        sha256: original?.sha256,
        created_by: fx.users.u_admin.id,
      });
      expect(await bytesOf(await storage.getStream(row?.object_key ?? ''))).toEqual(
        await bytesOf(await storage.getStream(original?.object_key ?? '')),
      );
    }

    // Event + audit of a create, with where it comes from; nothing about enabling.
    expect((await eventsOf(copy.id)).map((event) => event.type)).toEqual([
      'automation.created',
      'automation.run_as_changed',
    ]);
    const audit = await auditOf(copy.id);
    expect(audit.map((row) => [row.action, row.actor_id, row.organization_id])).toEqual([
      ['automation.created', fx.users.u_admin.id, fx.orgId],
      ['automation.run_as_changed', fx.users.u_admin.id, fx.orgId],
    ]);
    expect(audit[0]?.after).toMatchObject({
      duplicated_from: source.id,
      enabled: false,
      name: 'Báo cáo sự cố (bản sao)',
      run_as_user_id: fx.users.u_admin.id,
      definition: copy.definition,
    });
    expect(audit[1]?.after).toEqual({ run_as_user_id: fx.users.u_admin.id, reason: 'created' });

    // No run, no counters.
    const list = automationListSchema.parse(
      (await fx.call('u_admin', 'GET', `/bases/${fx.baseId}/automations?limit=200`)).json(),
    );
    const item = list.items.find((entry) => entry.id === copy.id);
    expect(item).toMatchObject({ last_run: null, errors_24h: 0 });
    expect(Object.values(item?.run_counts_7d ?? {}).every((count) => count === 0)).toBe(true);
    const sourceItem = list.items.find((entry) => entry.id === source.id);
    expect(sourceItem?.run_counts_7d.queued).toBe(1);

    // The copy saves (its images are its own, not EMAIL_IMAGE_NOT_FOUND) and turns on.
    const resaved = ok(
      await fx.call('u_admin', 'PATCH', `/automations/${copy.id}`, {
        definition: {
          ...copy.definition,
          actions: [sendEmail(`${templateOf(copy)}\n\nCảm ơn`)],
        },
      }),
    );
    expect(assetIdsIn(templateOf(resaved))).toEqual(copied);
    ok(await fx.call('u_admin', 'POST', `/automations/${copy.id}/enable`));

    // Deleting the source does not break the copy's images, not even after the cleanup.
    expect((await fx.call('u_admin', 'DELETE', `/automations/${source.id}`)).statusCode).toBe(204);
    await createAttachmentsCleanupTask({
      db,
      storage,
      logger: pino({ level: 'silent' }),
      now: () => new Date(Date.now() + 25 * HOUR_MS),
    })(undefined as never, {} as never);
    for (const id of copied) {
      const row = await repo.getById(scope(), id);
      expect(row?.automation_id).toBe(copy.id);
      expect(await storage.head(row?.object_key ?? '')).not.toBeNull();
    }
    ok(await fx.call('u_admin', 'POST', `/automations/${copy.id}/take-over`, { enable: true }));

    // A test send of the copy carries exactly its two images, as cid: parts.
    const sent = smtp.messages.length;
    const test = await fx.call(
      'u_admin',
      'POST',
      `/automations/${copy.id}/actions/act_mail/email-test`,
      { record_id: recordId },
    );
    expect(test.statusCode, test.body).toBe(200);
    expect(automationEmailTestResultSchema.parse(test.json())).toMatchObject({ status: 'sent' });
    const parts = inlineParts(smtp.messages[sent] ?? '');
    expect(parts.map((part) => part.cid).sort()).toEqual(
      copied.map((id) => `${id}@cellhive`).sort(),
    );
    expect(parts.find((part) => part.cid === `${String(copied[0])}@cellhive`)?.content.length).toBe(
      banner.size,
    );
  });

  it("names the copy in the caller's language, or as asked, within the name limit", async () => {
    // u_sales1 (English) copies an automation of u_admin it may run: run_as moves to it.
    const source = await create('u_admin', [setAmount()], { name: 'Set amount' });
    const copy = ok(await duplicate('u_sales1', source.id), 201);
    expect(copy).toMatchObject({
      name: 'Set amount (copy)',
      enabled: false,
      run_as: { id: fx.users.u_sales1.id },
      created_by: { id: fx.users.u_sales1.id },
    });
    expect(copy.definition).toEqual(source.definition);
    expect((await auditOf(copy.id)).map((row) => [row.action, row.actor_id])).toEqual([
      ['automation.created', fx.users.u_sales1.id],
      ['automation.run_as_changed', fx.users.u_sales1.id],
    ]);
    // The source keeps its run_as.
    expect(
      automationSchema.parse((await fx.call('u_admin', 'GET', `/automations/${source.id}`)).json())
        .run_as.id,
    ).toBe(fx.users.u_admin.id);

    const named = ok(await duplicate('u_admin', source.id, { name: '  Bản khác  ' }), 201);
    expect(named.name).toBe('Bản khác');

    const long = await create('u_admin', [setAmount()], {
      name: 'Đ'.repeat(MAX_AUTOMATION_NAME_LENGTH),
    });
    const cut = ok(await duplicate('u_admin', long.id), 201);
    expect(cut.name).toHaveLength(MAX_AUTOMATION_NAME_LENGTH);
    expect(cut.name.endsWith(' (bản sao)')).toBe(true);

    for (const body of [{ name: '' }, { name: 'x'.repeat(256) }, { enabled: true }]) {
      expectProblem(await duplicate('u_admin', source.id, body), 422, 'VALIDATION_FAILED');
    }
  });

  it('P43: u_sales1 copying what reaches cost or Customers gets 422 and nothing is created', async () => {
    const usesCost = await withTwoImages('u_admin', [setAmount(F('cost'))]);
    const usesCustomers = await create('u_admin', [
      {
        id: 'act_customer',
        type: 'create_record',
        config: { table_id: fx.customers.id, fields: {} },
      },
    ]);
    const before = await counts();

    const cost = await duplicate('u_sales1', usesCost.automation.id);
    expectProblem(cost, 422, 'AUTOMATION_INVALID');
    expect(detailsOf(cost.body)).toEqual([
      expect.objectContaining({
        path: `definition.actions[1].config.fields.${F('cost')}`,
        code: 'UNKNOWN_FIELD',
      }),
    ]);
    const customers = await duplicate('u_sales1', usesCustomers.id);
    expectProblem(customers, 422, 'AUTOMATION_INVALID');
    expect(detailsOf(customers.body)).toEqual([
      expect.objectContaining({
        path: 'definition.actions[0].config.table_id',
        code: 'UNKNOWN_TABLE',
      }),
    ]);
    // No automation, no image row, no object.
    expect(await counts()).toEqual(before);
    // The same copies are fine for u_admin.
    ok(await duplicate('u_admin', usesCustomers.id), 201);
  });

  it('403 for who sees but cannot manage, 404 for anyone else; nothing created', async () => {
    const { automation } = await withTwoImages();
    const before = await counts();
    // P43: an editor manages no automation; a reader neither.
    expectProblem(await duplicate('u_editor', automation.id), 403, 'PERMISSION_DENIED');
    expectProblem(await duplicate('u_reader', automation.id), 403, 'PERMISSION_DENIED');
    // Not a member of the base, another organization, an unknown or deleted automation.
    expectProblem(await duplicate('u_out', automation.id), 404, 'NOT_FOUND');
    expectProblem(await duplicate('stranger', automation.id), 404, 'NOT_FOUND');
    expectProblem(await duplicate('u_admin', newId('aut')), 404, 'NOT_FOUND');
    const gone = await create('u_admin', [setAmount()]);
    expect((await fx.call('u_admin', 'DELETE', `/automations/${gone.id}`)).statusCode).toBe(204);
    expectProblem(await duplicate('u_admin', gone.id), 404, 'NOT_FOUND');
    expectProblem(await duplicate('u_admin', 'aut_bad'), 422, 'VALIDATION_FAILED');
    // u_sales1 does not read Tickets: an automation triggered there is 404, not 403.
    const tickets = ok(
      await fx.call('u_admin', 'POST', `/bases/${fx.baseId}/automations`, {
        name: 'Tickets',
        definition: {
          trigger: { type: 'record.created', table_id: fx.tickets.id },
          actions: [],
        },
      }),
      201,
    );
    expectProblem(await duplicate('u_sales1', tickets.id), 404, 'NOT_FOUND');
    expect(await counts()).toEqual({
      ...before,
      automations: (before.automations ?? 0) + 2,
    });
  });

  it('a button automation cannot be copied: 422 BUTTON_IN_USE (reason duplicate)', async () => {
    const field = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
      name: 'Duyệt',
      type: 'button',
      options: { label: 'Duyệt' },
    });
    expect(field.statusCode, field.body).toBe(201);
    const button = fieldSchema.parse(field.json());
    const source = ok(
      await fx.call('u_admin', 'POST', `/bases/${fx.baseId}/automations`, {
        name: 'Duyệt đơn',
        definition: {
          trigger: { type: 'button.clicked', table_id: fx.orders.id, field_id: button.id },
          condition: null,
          actions: [setAmount()],
        },
      }),
      201,
    );
    const before = await counts();
    const refused = await duplicate('u_admin', source.id);
    expectProblem(refused, 422, 'AUTOMATION_INVALID');
    expect(detailsOf(refused.body)).toEqual([
      expect.objectContaining({
        path: 'definition.trigger.field_id',
        code: 'BUTTON_IN_USE',
        params: { automation_id: source.id, reason: 'duplicate' },
      }),
    ]);
    expect(await counts()).toEqual(before);
  });

  it('an image of the source gone from storage: 422 EMAIL_IMAGE_NOT_FOUND, nothing kept', async () => {
    const { automation, photo } = await withTwoImages();
    const row = await new EmailAssetsRepository(db).getById(scope(), photo.id);
    await storage.delete(row?.object_key ?? '');
    const before = await counts();
    const refused = await duplicate('u_admin', automation.id);
    expectProblem(refused, 422, 'AUTOMATION_INVALID');
    expect(detailsOf(refused.body)).toEqual([
      expect.objectContaining({
        path: 'definition.actions[0].config.body.template',
        code: 'EMAIL_IMAGE_NOT_FOUND',
        params: { asset_id: photo.id },
      }),
    ]);
    expect(await counts()).toEqual(before);
  });

  it('a failed save keeps no copied image (discarded at once)', async () => {
    const { automation } = await withTwoImages();
    // The insert of the copy fails inside its transaction, after the images were copied.
    await sql`
      CREATE FUNCTION meta.t551_refuse() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.name = 't551-refuse' THEN RAISE EXCEPTION 't551 refused'; END IF;
        RETURN NEW;
      END $$`.execute(db.kysely);
    await sql`
      CREATE TRIGGER t551_refuse BEFORE INSERT ON meta.automations
        FOR EACH ROW EXECUTE FUNCTION meta.t551_refuse()`.execute(db.kysely);
    try {
      const before = await counts();
      const failed = await duplicate('u_admin', automation.id, { name: 't551-refuse' });
      expect(failed.statusCode).toBe(500);
      expect(await counts()).toEqual(before);
    } finally {
      await sql`DROP TRIGGER t551_refuse ON meta.automations`.execute(db.kysely);
      await sql`DROP FUNCTION meta.t551_refuse()`.execute(db.kysely);
    }
  });

  it('copies stay in their organization; a staged copy left behind goes with the cleanup', async () => {
    const { automation } = await withTwoImages();
    const copy = ok(await duplicate('owner', automation.id), 201);
    const repo = new EmailAssetsRepository(db);
    for (const id of assetIdsIn(templateOf(copy))) {
      const row = await repo.getById(scope(), id);
      expect(row?.organization_id).toBe(fx.orgId);
      expect(row?.object_key.startsWith(`${fx.orgId}/`)).toBe(true);
    }
    const { rows } = await sql<{ organization_id: string }>`
      SELECT DISTINCT a.organization_id FROM meta.email_assets a
        JOIN meta.automations t ON t.id = a.automation_id
       WHERE a.organization_id <> t.organization_id`.execute(db.kysely);
    expect(rows).toEqual([]);
    expect(
      (await filesUnder(join(t.storageRoot, 'objects'))).every((file) =>
        file.startsWith(join(t.storageRoot, 'objects', fx.orgId)),
      ),
    ).toBe(true);

    // A copy staged but never attached (the process died before the save) is unreferenced:
    // the cleanup deletes its row and object 24 hours later.
    const source = (await repo.getReady(scope(), assetIdsIn(templateOf(automation))))[0];
    if (source === undefined) throw new Error('no source image');
    const staged: EmailAssetRow = await repo.insertCopy(scope(), source, fx.users.u_admin.id);
    await storage.put(staged.object_key, BANNER, { contentType: 'image/png' });
    await createAttachmentsCleanupTask({
      db,
      storage,
      logger: pino({ level: 'silent' }),
      now: () => new Date(Date.now() + 25 * HOUR_MS),
    })(undefined as never, {} as never);
    expect(await repo.getById(scope(), staged.id)).toBeUndefined();
    expect(await storage.head(staged.object_key)).toBeNull();
    // The copy's own images are kept.
    for (const id of assetIdsIn(templateOf(copy))) {
      expect(await repo.getById(scope(), id)).toBeDefined();
    }
  });

  it('logs no file name or storage key', () => {
    const raw = t.logs.raw();
    expect(raw).not.toContain('Ảnh thân thư');
    expect(raw).not.toContain(`${fx.orgId}/att_`);
  });
});
