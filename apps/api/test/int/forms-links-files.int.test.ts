import {
  attachmentSchema,
  createdShareLinkSchema,
  createUploadResponseSchema,
  fieldSchema,
  formSubmitTokenSchema,
  recordListResponseSchema,
  recordsResponseSchema,
  shareFormUploadSchema,
  shareLinkCandidatesSchema,
  shareMetaSchema,
  viewSchema,
  type CreatedShareLinkDto,
  type CreateUploadResponse,
  type FieldDto,
  type Id,
  type ProblemErrorItem,
  type ViewDto,
} from '@cellhive/contracts';
import {
  AttachmentsRepository,
  BaseRolesRepository,
  orgScope,
  type Db,
  type StorageDriver,
} from '@cellhive/server-core';
import { createAttachmentsCleanupTask } from '@cellhive/worker';
import { sql } from 'kysely';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ShareRateLimits } from '../../src/common/rate-limit/share-rate-limits.js';
import { STORAGE_DRIVER } from '../../src/common/tokens.js';
import { FormSpamGuard } from '../../src/modules/form/form-spam-guard.js';

import { Browser } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { realPng } from './images.js';
import { buildRecordFixture, expectProblem, type RecordFixture } from './record-fixture.js';
import { problemOf, startTestApp, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';

interface Problem {
  readonly code: string;
  readonly errors?: readonly ProblemErrorItem[];
}

/** The problem document of a response body. */
function problem(body: string): Problem {
  return problemOf(body) as unknown as Problem;
}

const PDF = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n');
const MB = 1024 * 1024;

/**
 * T410: link and attachment questions of forms — members (picker of T402,
 * uploads of T406), `org` form links (a picker limited to `{ id, title }`
 * under the creator's access ∩ `record_filter`), public form links (link
 * questions hidden like `user` ones; anonymous uploads bound to the submit
 * token, with limits, rate limit and cleanup after 24 hours).
 */
describe('form questions: links and attachments (T410)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let storage: StorageDriver;
  let limits: ShareRateLimits;
  let customer: FieldDto;
  let files: FieldDto;
  let photos: FieldDto;
  let secret: FieldDto;
  let form: ViewDto;
  let publicLink: CreatedShareLinkDto;
  let orgLink: CreatedShareLinkDto;
  let salesLink: CreatedShareLinkDto;
  let anonymous: Browser;
  const c = {} as Record<'c1' | 'c2' | 'c3', Id<'rec'>>;

  const title = () => fx.fld.title?.id ?? '';

  async function field(body: object): Promise<FieldDto> {
    const response = await fx.call('owner', 'POST', `/tables/${fx.orders.id}/fields`, body);
    expect(response.statusCode, response.body).toBe(201);
    return fieldSchema.parse(response.json());
  }

  function share(
    token: string,
    method: 'GET' | 'POST',
    path: string,
    payload?: object,
    browser: Browser = anonymous,
  ): Promise<LightMyRequestResponse> {
    return browser.request({
      method,
      url: `/api/v1/shares/${token}${path}`,
      ...(payload === undefined ? {} : { payload }),
    });
  }

  async function submitToken(token: string, browser: Browser = anonymous): Promise<string> {
    const response = await share(token, 'GET', '/submit-token', undefined, browser);
    expect(response.statusCode, response.body).toBe(200);
    return formSubmitTokenSchema.parse(response.json()).submit_token;
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

  /** A finished upload through a form link. */
  async function uploadVia(
    token: string,
    submit: string,
    into: FieldDto,
    bytes: Buffer = PDF,
    mime = 'application/pdf',
    browser: Browser = anonymous,
  ) {
    const started = await share(
      token,
      'POST',
      '/uploads',
      { field_id: into.id, filename: 'Đơn.pdf', size: bytes.length, mime, submit_token: submit },
      browser,
    );
    expect(started.statusCode, started.body).toBe(201);
    const target = createUploadResponseSchema.parse(started.json());
    await put(target, bytes);
    const done = await share(
      token,
      'POST',
      `/uploads/${target.id}/complete`,
      { submit_token: submit },
      browser,
    );
    expect(done.statusCode, done.body).toBe(200);
    return shareFormUploadSchema.parse(done.json());
  }

  /** A finished upload of a member (T406). */
  async function uploadAsMember(into: FieldDto) {
    const started = await fx.call('u_editor', 'POST', '/files/uploads', {
      table_id: fx.orders.id,
      field_id: into.id,
      filename: 'Hợp đồng.pdf',
      size: PDF.length,
      mime: 'application/pdf',
    });
    expect(started.statusCode, started.body).toBe(201);
    const target = createUploadResponseSchema.parse(started.json());
    await put(target, PDF);
    const done = await fx.call('u_editor', 'POST', `/files/uploads/${target.id}/complete`);
    expect(done.statusCode, done.body).toBe(200);
    return attachmentSchema.parse(done.json());
  }

  async function createLink(
    user: 'owner' | 'u_sales1',
    body: object,
    viewId: Id<'viw'> = form.id,
  ): Promise<CreatedShareLinkDto> {
    const response = await fx.call(user, 'POST', `/views/${viewId}/share-links`, body);
    expect(response.statusCode, response.body).toBe(201);
    return createdShareLinkSchema.parse(response.json());
  }

  /** The record of Orders with this title, read by the owner (field ids). */
  async function orderTitled(name: string) {
    const response = await fx.call(
      'owner',
      'POST',
      `/tables/${fx.orders.id}/records/query?field_key_type=id`,
      { filter: { op: 'and', items: [{ field: title(), operator: 'eq', value: name }] } },
    );
    expect(response.statusCode, response.body).toBe(200);
    return recordListResponseSchema.parse(response.json()).records[0];
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    limits = t.app.get(ShareRateLimits);
    limits.read = { limit: 100_000, windowSeconds: 1 };
    limits.upload = { limit: 100_000, windowSeconds: 600 };
    const guard = t.app.get(FormSpamGuard);
    guard.minFillMs = 0;
    guard.perMinute = { limit: 100_000, windowSeconds: 60 };
    storage = t.app.get<StorageDriver>(STORAGE_DRIVER);
    fx = await buildRecordFixture(t, db);
    anonymous = new Browser(t.app);

    customer = await field({
      name: 'customer',
      type: 'link',
      options: {
        link_table: fx.customers.id,
        record_filter: {
          op: 'and',
          items: [{ field: fx.fld.customerCode?.id, operator: 'is_not_empty' }],
        },
      },
    });
    files = await field({ name: 'files', type: 'attachment' });
    photos = await field({
      name: 'photos',
      type: 'attachment',
      options: { accept: ['image/*'], max_files: 2 },
    });
    secret = await field({ name: 'secret files', type: 'attachment' });

    const created = await fx.call('owner', 'POST', `/tables/${fx.customers.id}/records`, {
      records: [
        { fields: { Tên: 'An Phát', 'Mã khách hàng': 'KH-1' } },
        { fields: { Tên: 'Bình Minh', 'Mã khách hàng': 'KH-2' } },
        { fields: { Tên: 'Chưa mã' } },
      ],
    });
    expect(created.statusCode, created.body).toBe(201);
    [c.c1, c.c2, c.c3] = recordsResponseSchema
      .parse(created.json())
      .records.map((record) => record.id) as [Id<'rec'>, Id<'rec'>, Id<'rec'>];

    // Sales may share (S3 decision 1) but reads no Customers (P20).
    const scope = orgScope(fx.orgId);
    const roles = new BaseRolesRepository(db);
    const salesRole = (await roles.listByBase(scope, fx.baseId)).find(
      (role) => role.name === 'Sales',
    );
    const config = structuredClone(salesRole?.config) as { base_rule: Record<string, boolean> };
    config.base_rule['share_link'] = true;
    await roles.update(scope, fx.baseId, salesRole?.id ?? 'rol_missing', { config });

    const response = await fx.call('owner', 'POST', `/tables/${fx.orders.id}/views`, {
      name: 'Order form',
      type: 'form',
      config: {
        form: {
          fields: [
            { field: title(), required: true },
            { field: customer.id },
            { field: files.id },
            { field: photos.id },
          ],
        },
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    form = viewSchema.parse(response.json());
    publicLink = await createLink('owner', { audience: 'public' });
    const orgForm = viewSchema.parse(
      (
        await fx.call('owner', 'POST', `/tables/${fx.orders.id}/views`, {
          name: 'Order form (org)',
          type: 'form',
          config: form.config,
        })
      ).json(),
    );
    orgLink = await createLink('owner', { audience: 'org' }, orgForm.id);
    const salesForm = viewSchema.parse(
      (
        await fx.call('owner', 'POST', `/tables/${fx.orders.id}/views`, {
          name: 'Order form (sales)',
          type: 'form',
          config: form.config,
        })
      ).json(),
    );
    salesLink = await createLink('u_sales1', { audience: 'org' }, salesForm.id);
  });

  afterAll(async () => {
    await t.close();
    await db.destroy();
    await database.drop();
  });

  describe('form settings', () => {
    it('accepts link and attachment questions; parent stays refused', async () => {
      expect(form.config.form?.fields.map((item) => item.field)).toEqual([
        title(),
        customer.id,
        files.id,
        photos.id,
      ]);
      const parent = await field({ name: 'Parent', type: 'parent' });
      expectProblem(
        await fx.call('owner', 'PATCH', `/views/${form.id}`, {
          config: { form: { fields: [{ field: title() }, { field: parent.id }] } },
        }),
        422,
        'VALIDATION_FAILED',
      );
      expect((await fx.call('owner', 'DELETE', `/fields/${parent.id}`)).statusCode).toBe(204);
    });
  });

  describe('members', () => {
    it('fill in a link and a file question: the record gets both', async () => {
      const file = await uploadAsMember(files);
      const response = await fx.call('u_editor', 'POST', `/views/${form.id}/submit`, {
        fields: { [title()]: 'm1', [customer.id]: [c.c1], [files.id]: [{ id: file.id }] },
      });
      expect(response.statusCode, response.body).toBe(200);
      const record = await orderTitled('m1');
      expect(record?.fields[title()]).toBe('m1');
      expect(record?.fields[customer.id]).toEqual([{ id: c.c1, title: 'An Phát' }]);
      expect(record?.fields[files.id]).toEqual([expect.objectContaining({ id: file.id })]);
    });

    it('refuse a linked record outside the record filter', async () => {
      expectProblem(
        await fx.call('u_editor', 'POST', `/views/${form.id}/submit`, {
          fields: { [title()]: 'm2', [customer.id]: [c.c3] },
        }),
        422,
        'LINK_TARGET_NOT_FOUND',
      );
    });
  });

  describe('public form link', () => {
    it('hides the link question: meta, picker and submission', async () => {
      const response = await share(publicLink.token, 'GET', '/meta');
      expect(response.statusCode, response.body).toBe(200);
      const meta = shareMetaSchema.parse(response.json());
      expect(meta.fields.map((item) => item.id)).not.toContain(customer.id);
      expect(meta.view.config.form?.fields.map((item) => item.field)).toEqual([
        title(),
        files.id,
        photos.id,
      ]);
      for (const leak of [customer.id, fx.customers.id, c.c1, 'An Phát']) {
        expect(response.body).not.toContain(leak);
      }
      expectProblem(
        await share(publicLink.token, 'GET', `/link-candidates/${customer.id}`),
        404,
        'NOT_FOUND',
      );

      // Same answer as a field of the table outside the form, for any value.
      const unknown = async (fields: Record<string, unknown>) => {
        const sent = await share(publicLink.token, 'POST', '/submit', {
          fields: { [title()]: 'p0', ...fields },
          submit_token: await submitToken(publicLink.token),
        });
        expect(sent.statusCode, sent.body).toBe(422);
        return problem(sent.body);
      };
      const viaLink = await unknown({ [customer.id]: [c.c1] });
      const outside = await unknown({ [fx.fld.cost?.id ?? '']: 1 });
      expect(viaLink.code).toBe(outside.code);
      expect(viaLink.errors?.[0]?.code).toBe('UNKNOWN_FIELD');
      expect(viaLink.errors?.[0]?.message).toBe(outside.errors?.[0]?.message);
      expect(viaLink.errors?.[0]?.path).toBe(`fields.${customer.id}`);
    });

    it('uploads anonymously with the submit token and submits the files', async () => {
      const submit = await submitToken(publicLink.token);
      const doc = await uploadVia(publicLink.token, submit, files);
      const photo = await uploadVia(publicLink.token, submit, photos, realPng(40, 30), 'image/png');
      expect(Object.keys(doc).sort()).toEqual(['id', 'mime', 'name', 'size']);
      const response = await share(publicLink.token, 'POST', '/submit', {
        fields: {
          [title()]: 'p1',
          [files.id]: [{ id: doc.id }],
          [photos.id]: [{ id: photo.id }],
        },
        submit_token: submit,
      });
      expect(response.statusCode, response.body).toBe(200);
      const record = await orderTitled('p1');
      expect(record?.fields[title()]).toBe('p1');
      expect(record?.fields[files.id]).toEqual([expect.objectContaining({ id: doc.id })]);
      expect(record?.fields[photos.id]).toEqual([expect.objectContaining({ id: photo.id })]);
      const row = await new AttachmentsRepository(db).getById(orgScope(fx.orgId), doc.id);
      expect(row).toMatchObject({
        created_by: null,
        share_link_id: publicLink.id,
        record_id: record?.id,
      });

      // The token is used: no more uploads with it.
      expectProblem(
        await share(publicLink.token, 'POST', '/uploads', {
          field_id: files.id,
          filename: 'late.pdf',
          size: PDF.length,
          mime: 'application/pdf',
          submit_token: submit,
        }),
        422,
        'VALIDATION_FAILED',
      );
    });

    it('refuses uploads without a valid submit token', async () => {
      const body = {
        field_id: files.id,
        filename: 'a.pdf',
        size: PDF.length,
        mime: 'application/pdf',
      };
      for (const extra of [{}, { submit_token: 'v1.1.forged.token' }]) {
        const response = await share(publicLink.token, 'POST', '/uploads', { ...body, ...extra });
        expect(response.statusCode, response.body).toBe(422);
        expect(problem(response.body).errors?.[0]).toMatchObject({
          path: 'submit_token',
          code: 'SUBMIT_TOKEN_INVALID',
        });
      }
      // A token of another link.
      const other = await submitToken(orgLink.token, await browserOf('u_reader'));
      expect(
        problem(
          (await share(publicLink.token, 'POST', '/uploads', { ...body, submit_token: other }))
            .body,
        ).errors?.[0]?.code,
      ).toBe('SUBMIT_TOKEN_INVALID');
    });

    it('takes only attachment questions of the form', async () => {
      const submit = await submitToken(publicLink.token);
      for (const into of [secret.id, customer.id, title(), 'fld_MissingFieldAAAA']) {
        expectProblem(
          await share(publicLink.token, 'POST', '/uploads', {
            field_id: into,
            filename: 'a.pdf',
            size: PDF.length,
            mime: 'application/pdf',
            submit_token: submit,
          }),
          404,
          'NOT_FOUND',
        );
      }
    });

    it('checks type, size, files per question and bytes per submission', async () => {
      const submit = await submitToken(publicLink.token);
      const start = (into: FieldDto, size: number, mime: string) =>
        share(publicLink.token, 'POST', '/uploads', {
          field_id: into.id,
          filename: mime === 'image/png' ? 'a.png' : 'a.pdf',
          size,
          mime,
          submit_token: submit,
        });
      const detail = (response: LightMyRequestResponse) => {
        expect(response.statusCode, response.body).toBe(422);
        return problem(response.body).errors?.[0];
      };
      expect(detail(await start(photos, 10, 'application/pdf'))?.code).toBe('MIME_NOT_ACCEPTED');
      expect(detail(await start(files, 101 * MB, 'application/pdf'))?.code).toBe('FILE_TOO_LARGE');
      expect((await start(photos, 10, 'image/png')).statusCode).toBe(201);
      expect((await start(photos, 10, 'image/png')).statusCode).toBe(201);
      expect(detail(await start(photos, 10, 'image/png'))).toMatchObject({
        code: 'TOO_MANY_VALUES',
        params: { limit: 2 },
      });
      expect((await start(files, 60 * MB, 'application/pdf')).statusCode).toBe(201);
      expect(detail(await start(files, 40 * MB, 'application/pdf'))).toMatchObject({
        code: 'UPLOAD_LIMIT_EXCEEDED',
        params: { limit: 100 * MB },
      });
    });

    it('binds only files of the submission’s own token', async () => {
      const first = await submitToken(publicLink.token);
      const second = await submitToken(publicLink.token);
      const mine = await uploadVia(publicLink.token, first, files);
      const theirs = await uploadVia(publicLink.token, second, files);
      const member = await uploadAsMember(files);
      const viaOrg = await uploadVia(
        orgLink.token,
        await submitToken(orgLink.token, await browserOf('u_reader')),
        files,
        PDF,
        'application/pdf',
        await browserOf('u_reader'),
      );
      // Completing an upload of another token is a `404`.
      expectProblem(
        await share(publicLink.token, 'POST', `/uploads/${mine.id}/complete`, {
          submit_token: second,
        }),
        404,
        'NOT_FOUND',
      );
      for (const id of [theirs.id, member.id, viaOrg.id]) {
        const response = await share(publicLink.token, 'POST', '/submit', {
          fields: { [title()]: 'p2', [files.id]: [{ id }] },
          submit_token: first,
        });
        expect(response.statusCode, response.body).toBe(422);
        expect(problem(response.body).errors?.[0]).toMatchObject({
          path: `fields.${files.id}`,
          code: 'ATTACHMENT_NOT_FOUND',
        });
      }
      // A member cannot write a form link upload either.
      expectProblem(
        await fx.call('u_editor', 'POST', `/views/${form.id}/submit`, {
          fields: { [title()]: 'm3', [files.id]: [{ id: mine.id }] },
        }),
        422,
        'INVALID_CELL_VALUE',
      );
      // The refused token stays usable: its own file goes through.
      const response = await share(publicLink.token, 'POST', '/submit', {
        fields: { [title()]: 'p3', [files.id]: [{ id: mine.id }] },
        submit_token: first,
      });
      expect(response.statusCode, response.body).toBe(200);
    });

    it('limits uploads per IP (429)', async () => {
      const saved = limits.upload;
      limits.upload = { limit: 2, windowSeconds: 600 };
      try {
        const browser = new Browser(t.app);
        const submit = await submitToken(publicLink.token, browser);
        const start = () =>
          share(
            publicLink.token,
            'POST',
            '/uploads',
            {
              field_id: files.id,
              filename: 'a.pdf',
              size: 10,
              mime: 'application/pdf',
              submit_token: submit,
            },
            browser,
          );
        expect((await start()).statusCode).toBe(201);
        expect((await start()).statusCode).toBe(201);
        const refused = await start();
        expectProblem(refused, 429, 'RATE_LIMITED');
        expect(refused.headers['retry-after']).toBeDefined();
        // Unknown tokens count too.
        const unknown = await browser.request({
          method: 'POST',
          url: `/api/v1/shares/${'x'.repeat(43)}/uploads`,
          payload: { field_id: files.id, filename: 'a', size: 1, mime: 'text/plain' },
        });
        expect(unknown.statusCode).toBe(429);
      } finally {
        limits.upload = saved;
      }
    });

    it('deletes files never submitted after 24 hours', async () => {
      const submit = await submitToken(publicLink.token);
      const orphan = await uploadVia(publicLink.token, submit, files);
      const repo = new AttachmentsRepository(db);
      const scope = orgScope(fx.orgId);
      const key = (await repo.getById(scope, orphan.id))?.object_key ?? '';
      expect(await storage.head(key)).not.toBeNull();
      await sql`UPDATE meta.attachments SET created_at = now() - interval '25 hours'
                 WHERE id = ${orphan.id}`.execute(db.kysely);
      const task = createAttachmentsCleanupTask({
        db,
        storage,
        logger: pino({ level: 'silent' }),
      });
      await task({}, {} as Parameters<typeof task>[1]);
      expect(await repo.getById(scope, orphan.id)).toBeUndefined();
      expect(await storage.head(key)).toBeNull();
    });
  });

  describe('org form link', () => {
    it('lists linked records as { id, title } within the creator’s scope and record filter', async () => {
      const reader = await browserOf('u_reader');
      const meta = shareMetaSchema.parse(
        (await share(orgLink.token, 'GET', '/meta', undefined, reader)).json(),
      );
      const question = meta.fields.find((item) => item.id === customer.id);
      expect(question?.options).toEqual({ allow_multiple: true });

      const response = await share(
        orgLink.token,
        'GET',
        `/link-candidates/${customer.id}`,
        undefined,
        reader,
      );
      expect(response.statusCode, response.body).toBe(200);
      const page = shareLinkCandidatesSchema.parse(response.json());
      expect(page.items).toEqual([
        { id: c.c1, title: 'An Phát' },
        { id: c.c2, title: 'Bình Minh' },
      ]);
      expect(response.body).not.toContain('KH-1');
      expect(response.body).not.toContain(c.c3);
      const searched = shareLinkCandidatesSchema.parse(
        (
          await share(
            orgLink.token,
            'GET',
            `/link-candidates/${customer.id}?search=binh`,
            undefined,
            reader,
          )
        ).json(),
      );
      expect(searched.items.map((item) => item.id)).toEqual([c.c2]);

      // Not signed in → 401; not a link question of the form → 404.
      expectProblem(
        await share(orgLink.token, 'GET', `/link-candidates/${customer.id}`),
        401,
        'UNAUTHENTICATED',
      );
      expectProblem(
        await share(orgLink.token, 'GET', `/link-candidates/${files.id}`, undefined, reader),
        404,
        'NOT_FOUND',
      );
      expectProblem(
        await share(fx.users.u_reader.id, 'GET', `/link-candidates/${customer.id}`),
        404,
        'NOT_FOUND',
      );
    });

    it('writes links the picker offers and refuses others', async () => {
      const reader = await browserOf('u_reader');
      const send = async (value: unknown) =>
        share(
          orgLink.token,
          'POST',
          '/submit',
          {
            fields: { [title()]: 'o1', [customer.id]: value },
            submit_token: await submitToken(orgLink.token, reader),
          },
          reader,
        );
      expectProblem(await send([c.c3]), 422, 'LINK_TARGET_NOT_FOUND');
      const ok = await send([c.c2]);
      expect(ok.statusCode, ok.body).toBe(200);
      const record = await orderTitled('o1');
      expect(record?.fields[customer.id]).toEqual([{ id: c.c2, title: 'Bình Minh' }]);
    });

    it('never offers records the creator cannot read', async () => {
      const reader = await browserOf('u_reader');
      const response = await share(
        salesLink.token,
        'GET',
        `/link-candidates/${customer.id}`,
        undefined,
        reader,
      );
      expectProblem(response, 404, 'NOT_FOUND');
      expect(response.body).not.toContain('An Phát');
      const sent = await share(
        salesLink.token,
        'POST',
        '/submit',
        {
          fields: { [title()]: 'o2', [customer.id]: [c.c1] },
          submit_token: await submitToken(salesLink.token, reader),
        },
        reader,
      );
      // Refused (the linked record is out of reach, or the field is not writable): never linked.
      expect([403, 422]).toContain(sent.statusCode);
      expect(sent.body).not.toContain('An Phát');
    });
  });

  async function browserOf(user: 'u_reader'): Promise<Browser> {
    const browser = new Browser(t.app);
    expect((await browser.login(fx.users[user].email)).statusCode).toBe(204);
    return browser;
  }
});
