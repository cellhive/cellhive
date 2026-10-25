import {
  attachmentSchema,
  createdShareLinkSchema,
  createUploadResponseSchema,
  fieldSchema,
  recordListResponseSchema,
  recordSchema,
  recordsResponseSchema,
  shareMetaSchema,
  viewSchema,
  type AttachmentDto,
  type CreatedShareLinkDto,
  type FieldDto,
  type Id,
  type RecordDto,
  type ViewDto,
} from '@cellhive/contracts';
import { BaseRolesRepository, orgScope, type Db, type StorageDriver } from '@cellhive/server-core';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ShareRateLimits } from '../../src/common/rate-limit/share-rate-limits.js';
import { STORAGE_DRIVER } from '../../src/common/tokens.js';

import { Browser } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { realPng, renderThumbnail } from './images.js';
import {
  buildRecordFixture,
  expectProblem,
  type FixtureUser,
  type RecordFixture,
} from './record-fixture.js';
import { problemOf, startTestApp, TEST_PUBLIC_URL, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';

const PDF = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n');

/**
 * T409: link and attachment fields through share links — `options` of
 * `meta` reduced to display keys, link titles under the creator's access
 * (never the id of a record out of reach), view filters on link fields,
 * file downloads (`allow_download`, creator's `file_download_fields`,
 * audit) and thumbnails (no flag) through the link, and the P30 sweep
 * extended with link, parent and attachment fields.
 */
describe('share links: links and attachments (T409)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let storage: StorageDriver;
  let customer: FieldDto;
  let reverse: string;
  let parent: FieldDto;
  let files: FieldDto;
  let images: FieldDto;
  let secret: FieldDto;
  let viewSales: ViewDto;
  let viewAdmin: ViewDto;
  let formView: ViewDto;
  const r = {} as Record<'r1' | 'r2' | 'r3' | 'r4', Id<'rec'>>;
  const c = {} as Record<'c1' | 'c2', Id<'rec'>>;
  const att = {} as Record<'doc' | 'photo' | 'onR2' | 'onR3' | 'hidden', AttachmentDto>;
  let sales: CreatedShareLinkDto;
  let admin: CreatedShareLinkDto;
  let anonymous: Browser;

  const orders = () => `/tables/${fx.orders.id}/records`;

  function records(response: LightMyRequestResponse): RecordDto[] {
    expect(response.statusCode, response.body).toBeLessThan(300);
    return recordsResponseSchema.parse(response.json()).records;
  }

  async function field(body: object, table = fx.orders.id): Promise<FieldDto> {
    const response = await fx.call('owner', 'POST', `/tables/${table}/fields`, body);
    expect(response.statusCode, response.body).toBe(201);
    return fieldSchema.parse(response.json());
  }

  async function upload(name: string, mime: string, bytes: Buffer, into: FieldDto) {
    const started = await fx.call('owner', 'POST', '/files/uploads', {
      table_id: fx.orders.id,
      field_id: into.id,
      filename: name,
      size: bytes.length,
      mime,
    });
    expect(started.statusCode, started.body).toBe(201);
    const { id, upload: target } = createUploadResponseSchema.parse(started.json());
    const put = await t.app.inject({
      method: 'PUT',
      url: new URL(target.url).pathname + new URL(target.url).search,
      headers: target.headers,
      payload: bytes,
    });
    expect(put.statusCode).toBe(200);
    const done = await fx.call('owner', 'POST', `/files/uploads/${id}/complete`);
    expect(done.statusCode, done.body).toBe(200);
    return attachmentSchema.parse(done.json());
  }

  async function createView(body: object): Promise<ViewDto> {
    const response = await fx.call('owner', 'POST', `/tables/${fx.orders.id}/views`, body);
    expect(response.statusCode, response.body).toBe(201);
    return viewSchema.parse(response.json());
  }

  async function createLink(
    user: FixtureUser,
    viewId: Id<'viw'>,
    body: object,
  ): Promise<CreatedShareLinkDto> {
    const response = await fx.call(user, 'POST', `/views/${viewId}/share-links`, body);
    expect(response.statusCode, response.body).toBe(201);
    return createdShareLinkSchema.parse(response.json());
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

  const query = (token: string, body: object = {}, params = '?field_key_type=id') =>
    share(token, 'POST', `/records/query${params}`, body);

  function page(response: LightMyRequestResponse): RecordDto[] {
    expect(response.statusCode, response.body).toBe(200);
    return recordListResponseSchema.parse(response.json()).records;
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    const limits = t.app.get(ShareRateLimits);
    limits.read = { limit: 100_000, windowSeconds: 1 };
    limits.file = { limit: 100_000, windowSeconds: 1 };
    storage = t.app.get<StorageDriver>(STORAGE_DRIVER);
    fx = await buildRecordFixture(t, db);
    anonymous = new Browser(t.app);

    // Customers: a code the link's record filter names.
    customer = await field({
      name: 'customer',
      type: 'link',
      options: {
        link_table: fx.customers.id,
        bidirectional: true,
        record_filter: {
          op: 'and',
          items: [{ field: fx.fld.customerCode?.id, operator: 'is_not_empty' }],
        },
      },
    });
    reverse = String(customer.options['symmetric_field_id']);
    parent = await field({ name: 'Parent', type: 'parent' });
    files = await field({ name: 'files', type: 'attachment' });
    images = await field({ name: 'images', type: 'attachment' });
    secret = await field({ name: 'secret files', type: 'attachment' });

    // Sales of C§5 may share (S3 decision 1) and download `files` only.
    const scope = orgScope(fx.orgId);
    const rolesRepository = new BaseRolesRepository(db);
    const salesRole = (await rolesRepository.listByBase(scope, fx.baseId)).find(
      (role) => role.name === 'Sales',
    );
    const config = structuredClone(salesRole?.config) as {
      base_rule: Record<string, boolean>;
      tables: Record<string, { field_rule: { file_download_fields: string[] } }>;
    };
    config.base_rule['share_link'] = true;
    const ordersRule = config.tables[fx.orders.id];
    if (ordersRule !== undefined) ordersRule.field_rule.file_download_fields = [files.id];
    await rolesRepository.update(scope, fx.baseId, salesRole?.id ?? 'rol_missing', {
      config,
    });

    [c.c1, c.c2] = records(
      await fx.call('owner', 'POST', `/tables/${fx.customers.id}/records`, {
        records: [
          { fields: { Tên: 'An Phát', 'Mã khách hàng': 'KH-1' } },
          { fields: { Tên: 'Bình Minh', 'Mã khách hàng': 'KH-2' } },
        ],
      }),
    ).map((record) => record.id) as [Id<'rec'>, Id<'rec'>];

    att.doc = await upload('Hợp đồng r1.pdf', 'application/pdf', PDF, files);
    att.photo = await upload('Ảnh r1.png', 'image/png', realPng(600, 400), images);
    att.onR2 = await upload('Hợp đồng r2.pdf', 'application/pdf', PDF, files);
    att.onR3 = await upload('Hợp đồng r3.pdf', 'application/pdf', PDF, files);
    att.hidden = await upload('Bí mật r1.pdf', 'application/pdf', PDF, secret);

    const sales1 = [{ id: fx.users.u_sales1.id }];
    const sales2 = [{ id: fx.users.u_sales2.id }];
    [r.r2] = records(
      await fx.call('owner', 'POST', `${orders()}?field_key_type=id`, {
        records: [
          {
            fields: {
              [fx.fld.title?.id ?? '']: 'r2',
              [fx.fld.amount?.id ?? '']: 20,
              [fx.fld.cost?.id ?? '']: 2,
              [fx.fld.owner?.id ?? '']: sales2,
              [customer.id]: [c.c2],
              [files.id]: [{ id: att.onR2.id }],
            },
          },
        ],
      }),
    ).map((record) => record.id) as [Id<'rec'>];
    [r.r1, r.r3, r.r4] = records(
      await fx.call('owner', 'POST', `${orders()}?field_key_type=id`, {
        records: [
          {
            parent_id: r.r2,
            fields: {
              [fx.fld.title?.id ?? '']: 'r1',
              [fx.fld.amount?.id ?? '']: 10,
              [fx.fld.cost?.id ?? '']: 1,
              [fx.fld.owner?.id ?? '']: sales1,
              [customer.id]: [c.c1],
              [files.id]: [{ id: att.doc.id }],
              [images.id]: [{ id: att.photo.id }],
              [secret.id]: [{ id: att.hidden.id }],
            },
          },
          {
            fields: {
              [fx.fld.title?.id ?? '']: 'r3',
              [fx.fld.amount?.id ?? '']: 0,
              [fx.fld.cost?.id ?? '']: 3,
              [fx.fld.owner?.id ?? '']: sales1,
              [customer.id]: [c.c2],
              [files.id]: [{ id: att.onR3.id }],
            },
          },
          {
            // In the creator's rule and amount > 0, but no customer: out of the view.
            fields: {
              [fx.fld.title?.id ?? '']: 'r4',
              [fx.fld.amount?.id ?? '']: 5,
              [fx.fld.owner?.id ?? '']: sales1,
            },
          },
        ],
      }),
    ).map((record) => record.id) as [Id<'rec'>, Id<'rec'>, Id<'rec'>];

    // The view filter names the link field (fail closed through links before T409).
    const config2 = {
      filter: {
        op: 'and',
        items: [
          { field: fx.fld.amount?.id, operator: 'gt', value: 0 },
          { field: customer.id, operator: 'is_not_empty' },
        ],
      },
      sort: [{ field: fx.fld.amount?.id, direction: 'desc' }],
      hidden_fields: [fx.fld.status?.id, secret.id],
    };
    viewSales = await createView({ name: 'Sales', type: 'grid', config: config2 });
    viewAdmin = await createView({ name: 'Sales (admin)', type: 'grid', config: config2 });
    formView = await createView({ name: 'Order form', type: 'form' });
    sales = await createLink('u_sales1', viewSales.id, {
      audience: 'public',
      settings: { allow_download: true },
    });
    admin = await createLink('u_admin', viewAdmin.id, { audience: 'public' });
  });

  afterAll(async () => {
    await t.close();
    await db.destroy();
    await database.drop();
  });

  describe('meta: options reduced to display keys', () => {
    it('never returns linked table or field ids, record filters or file rules', async () => {
      const response = await share(sales.token, 'GET', '/meta');
      expect(response.statusCode, response.body).toBe(200);
      const meta = shareMetaSchema.parse(response.json());
      const byId = new Map(meta.fields.map((item) => [item.id, item]));
      expect(byId.get(customer.id)?.options).toEqual({ allow_multiple: true });
      expect(byId.get(parent.id)?.options).toEqual({});
      expect(byId.get(files.id)?.options).toEqual({});
      expect(byId.has(secret.id)).toBe(false);
      expect(meta.settings.allow_download).toBe(true);
      for (const leak of [
        fx.customers.id,
        reverse,
        fx.fld.customerCode?.id ?? '',
        'record_filter',
        'link_table',
        'blocked_extensions',
      ]) {
        expect(response.body, `meta leaks ${leak}`).not.toContain(leak);
      }
    });

    it('keeps the question options a form needs', async () => {
      const form = await createView({
        name: 'Files form',
        type: 'form',
        config: { form: { fields: [{ field: fx.fld.title?.id }, { field: files.id }] } },
      });
      const link = await createLink('owner', form.id, { audience: 'public' });
      const meta = shareMetaSchema.parse((await share(link.token, 'GET', '/meta')).json());
      const options = meta.fields.find((item) => item.id === files.id)?.options;
      expect(options).toMatchObject({ max_files: 100, accept: null });
      expect(options).toHaveProperty('blocked_extensions');
    });
  });

  describe('link values', () => {
    it('shows titles the creator reads; others are locked without their id', async () => {
      const [r1, ...rest] = page(await query(sales.token));
      expect(rest).toEqual([]);
      expect(r1?.id).toBe(r.r1);
      // u_sales1 cannot read Customers (P20): no title, and no id either through a link.
      expect(r1?.fields[customer.id]).toEqual([{ id: null, title: null }]);
      // The parent r2 is outside the link (u_sales1's record rule).
      expect(r1?.fields[parent.id]).toEqual({ id: null, title: null });

      const byAdmin = page(await query(admin.token));
      expect(byAdmin.map((record) => record.id)).toEqual([r.r2, r.r1]);
      const adminR1 = byAdmin.find((record) => record.id === r.r1);
      expect(adminR1?.fields[customer.id]).toEqual([{ id: c.c1, title: 'An Phát' }]);
      expect(adminR1?.fields[parent.id]).toEqual({ id: r.r2, title: 'r2' });

      // Same on the record detail and as text.
      const detail = await share(sales.token, 'GET', `/records/${r.r1}?field_key_type=id`);
      expect(recordSchema.parse(detail.json()).fields[customer.id]).toEqual([
        { id: null, title: null },
      ]);
      const text = page(await query(admin.token, {}, '?field_key_type=id&cell_format=text'));
      expect(text.find((record) => record.id === r.r1)?.fields[customer.id]).toBe('An Phát');
    });

    it('applies a view filter on a link field and filters viewers by id only', async () => {
      // r4 (no customer) is left out by the view filter, not everything (T402 fail-closed).
      expect(page(await query(admin.token)).map((record) => record.id)).not.toContain(r.r4);
      const filtered = await query(admin.token, {
        filter: {
          op: 'and',
          items: [{ field: customer.id, operator: 'has_any_of', value: [c.c1] }],
        },
      });
      expect(page(filtered).map((record) => record.id)).toEqual([r.r1]);
      // A title is not an id: nothing matches (never a way to probe titles).
      const byTitle = await query(admin.token, {
        filter: {
          op: 'and',
          items: [{ field: customer.id, operator: 'has_any_of', value: ['An Phát'] }],
        },
      });
      expect(byTitle.statusCode).toBe(422);
    });
  });

  describe('files', () => {
    const file = (token: string, id: string, suffix = '') =>
      share(token, 'GET', `/files/${id}${suffix}`);

    it('downloads a file of the link with allow_download: 302, headers, audit', async () => {
      const [r1] = page(await query(sales.token));
      const cell = r1?.fields[files.id] as AttachmentDto[];
      expect(cell).toEqual([
        {
          ...att.doc,
          url: `/api/v1/shares/${sales.token}/files/${att.doc.id}`,
          thumbnail_url: null,
        },
      ]);
      const photo = (r1?.fields[images.id] as AttachmentDto[])[0];
      expect(photo?.thumbnail_url).toBe(
        `/api/v1/shares/${sales.token}/files/${att.photo.id}/thumbnail`,
      );

      const response = await file(sales.token, att.doc.id);
      expect(response.statusCode, response.body).toBe(302);
      const location = String(response.headers.location);
      expect(new URL(location).origin).toBe(TEST_PUBLIC_URL);
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      expect(response.headers['x-robots-tag']).toBe('noindex, nofollow');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      const stored = await t.app.inject({
        method: 'GET',
        url: new URL(location).pathname + new URL(location).search,
      });
      expect(stored.rawPayload.equals(PDF)).toBe(true);
      expect(String(stored.headers['content-disposition'])).toMatch(/^attachment;/);

      const { rows } = await sql<{ actor_type: string; actor_id: string; via: unknown }>`
        SELECT actor_type, actor_id, via FROM meta.audit_logs
         WHERE action = 'share_link.file_downloaded' AND entity_id = ${att.doc.id}
      `.execute(db.kysely);
      expect(rows).toEqual([
        { actor_type: 'share_link', actor_id: sales.id, via: { share_link_id: sales.id } },
      ]);
      expect(t.logs.raw()).not.toContain('Hợp đồng');
      expect(t.logs.raw()).not.toContain(sales.token);
    });

    it("refuses without allow_download or the creator's file_download_fields (403)", async () => {
      // `images` is not among u_sales1's file_download_fields.
      expectProblem(await file(sales.token, att.photo.id), 403, 'PERMISSION_DENIED');
      // The admin link does not allow downloads.
      expectProblem(await file(admin.token, att.doc.id), 403, 'PERMISSION_DENIED');
      // Turning it on works from S4 (open question S4 #3).
      const patched = await fx.call('u_admin', 'PATCH', `/share-links/${admin.id}`, {
        settings: { allow_download: true },
      });
      expect(patched.statusCode, patched.body).toBe(200);
      expect((await file(admin.token, att.doc.id)).statusCode).toBe(302);
      expect((await file(admin.token, att.onR2.id)).statusCode).toBe(302);
      await fx.call('u_admin', 'PATCH', `/share-links/${admin.id}`, {
        settings: { allow_download: false },
      });
    });

    it('answers 404 for files outside the link', async () => {
      for (const [label, id] of [
        ['r2: outside the creator rule', att.onR2.id],
        ['r3: outside the view filter', att.onR3.id],
        ['field hidden in the view', att.hidden.id],
        ['unknown', 'att_0000000000000000'],
      ] as const) {
        const response = await file(sales.token, id);
        expect(response.statusCode, `${label}: ${response.body}`).toBe(404);
        expect(problemOf(response.body).code).toBe('NOT_FOUND');
        expectProblem(await file(sales.token, id, '/thumbnail'), 404, 'NOT_FOUND');
      }
      expectProblem(await file(sales.token, 'nope'), 422, 'VALIDATION_FAILED');
      // A form link has no files.
      const form = await createLink('owner', formView.id, {
        audience: 'public',
        settings: { allow_download: true },
      });
      expectProblem(await file(form.token, att.doc.id), 404, 'NOT_FOUND');
      // Unknown tokens.
      expectProblem(await file('x'.repeat(43), att.doc.id), 404, 'NOT_FOUND');
    });

    it('serves thumbnails without allow_download; the original only when downloadable', async () => {
      // Not rendered yet: the admin link may not download → 404; u_sales1 may not download images → 404.
      expectProblem(await file(admin.token, att.photo.id, '/thumbnail'), 404, 'NOT_FOUND');
      expectProblem(await file(sales.token, att.photo.id, '/thumbnail'), 404, 'NOT_FOUND');
      await renderThumbnail(db, storage, fx.orgId, att.photo.id);
      for (const token of [admin.token, sales.token]) {
        const response = await file(token, att.photo.id, '/thumbnail?size=1280');
        expect(response.statusCode, response.body).toBe(200);
        expect(response.headers['content-type']).toBe('image/webp');
        expect(response.headers['x-content-type-options']).toBe('nosniff');
        expect(response.headers['referrer-policy']).toBe('no-referrer');
        expect(response.headers['x-robots-tag']).toBe('noindex, nofollow');
      }
      // Not an image.
      expectProblem(await file(sales.token, att.doc.id, '/thumbnail'), 404, 'NOT_FOUND');
    });

    it('needs the unlock of a password link, counts file requests per IP', async () => {
      const locked = await createLink('owner', viewAdmin.id, {
        audience: 'public',
        password: 'correct horse',
        settings: { allow_download: true },
      });
      expectProblem(await file(locked.token, att.doc.id), 403, 'SHARE_PASSWORD_REQUIRED');
      const limits = t.app.get(ShareRateLimits);
      limits.file = { limit: 2, windowSeconds: 60 };
      try {
        const ip = { remoteAddress: '203.0.113.9' };
        const hit = () =>
          t.app.inject({
            method: 'GET',
            url: `/api/v1/shares/${sales.token}/files/${att.doc.id}`,
            ...ip,
          });
        expect((await hit()).statusCode).toBe(302);
        expect((await hit()).statusCode).toBe(302);
        const limited = await hit();
        expectProblem(limited, 429, 'RATE_LIMITED');
        expect(limited.headers['retry-after']).toBeDefined();
      } finally {
        limits.file = { limit: 100_000, windowSeconds: 1 };
      }
    });
  });

  /**
   * The P30 sweep of T319 with link, parent and attachment fields: through
   * the link of u_sales1 no answer carries `cost`, a record outside the
   * link (r2, r3, r4 — as ids, titles or files), a Customers record (id or
   * title: u_sales1 cannot read Customers), the Customers table or its
   * fields, the reverse link field, an email, or the organization.
   */
  describe('P30 sweep with links, parents and attachments (T409)', () => {
    it('keeps every read route inside the link', async () => {
      const inScope = [fx.fld.title, fx.fld.amount, fx.fld.owner, customer, parent, files, images];
      const requests: [string, 'GET' | 'POST', string, object?][] = [
        ['meta', 'GET', '/meta'],
        ['query', 'POST', '/records/query', {}],
        ['query by id', 'POST', '/records/query?field_key_type=id', {}],
        ['query as text', 'POST', '/records/query?cell_format=text', {}],
        ['query ids', 'POST', '/records/query', { ids: [r.r1, r.r2, r.r3, r.r4] }],
        [
          'query field ids',
          'POST',
          '/records/query?field_key_type=id',
          { fields: inScope.map((item) => item?.id) },
        ],
        ['query search', 'POST', '/records/query', { search: 'r' }],
        [
          'query link filter',
          'POST',
          '/records/query?field_key_type=id',
          {
            filter: {
              op: 'or',
              items: [
                { field: customer.id, operator: 'has_any_of', value: [c.c1, c.c2] },
                { field: customer.id, operator: 'is_not_empty' },
              ],
            },
          },
        ],
        ['counts', 'POST', '/records/group-counts', { group: [{ field: 'owner' }] }],
        ['detail', 'GET', `/records/${r.r1}`],
        ['detail by id', 'GET', `/records/${r.r1}?field_key_type=id`],
        ['detail as text', 'GET', `/records/${r.r1}?cell_format=text`],
      ];
      const outside = [
        fx.fld.cost?.id ?? '',
        '"cost"',
        r.r2,
        r.r3,
        r.r4,
        '"r2"',
        c.c1,
        c.c2,
        'An Phát',
        'Bình Minh',
        fx.customers.id,
        fx.fld.customerCode?.id ?? '',
        reverse,
        att.onR2.id,
        att.onR3.id,
        att.hidden.id,
        'Hợp đồng r2',
        'Bí mật',
        fx.users.u_sales1.email,
        fx.users.u_sales2.email,
        fx.orgId,
        fx.baseId,
        '/api/v1/files/',
        'storage/local',
      ];
      for (const [label, method, path, payload] of requests) {
        const response = await share(sales.token, method, path, payload);
        expect(response.statusCode, `${label}: ${response.body}`).toBe(200);
        for (const leak of outside) {
          expect(response.body, `${label} leaks ${leak}`).not.toContain(leak);
        }
      }
    });
  });
});
