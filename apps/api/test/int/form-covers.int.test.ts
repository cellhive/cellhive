import {
  createdShareLinkSchema,
  createUploadResponseSchema,
  FORM_COVER_MAX_BYTES,
  formCoverSchema,
  viewSchema,
  type CreateUploadResponse,
  type FormCoverDto,
  type Id,
  type ProblemErrorItem,
  type ViewDto,
} from '@cellhive/contracts';
import { FormCoversRepository, orgScope, type Db, type StorageDriver } from '@cellhive/server-core';
import { createAttachmentsCleanupTask } from '@cellhive/worker';
import { sql } from 'kysely';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ShareRateLimits } from '../../src/common/rate-limit/share-rate-limits.js';
import { STORAGE_DRIVER } from '../../src/common/tokens.js';

import { Browser } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { realPng } from './images.js';
import {
  buildRecordFixture,
  expectProblem,
  type FixtureUser,
  type RecordFixture,
} from './record-fixture.js';
import { problemOf, startTestApp, type TestApp } from './support.js';

/** The detail items of a problem response. */
function detailsOf(body: string): readonly ProblemErrorItem[] {
  return (problemOf(body) as unknown as { errors?: readonly ProblemErrorItem[] }).errors ?? [];
}

const PNG = realPng(4, 3);
const PDF = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n');

/**
 * T419: cover images of forms (`config.form.cover_attachment_id`) — upload
 * by whoever may change the form view, naming it in the config (only one's
 * own upload), reading through the view and through the form's share link,
 * and the cleanup of covers no form view names.
 */
describe('form cover images (T419)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let storage: StorageDriver;
  let form: ViewDto;
  let anonymous: Browser;

  const title = () => fx.fld.title?.id ?? '';

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

  async function uploadCover(
    user: FixtureUser = 'owner',
    viewId: Id<'viw'> = form.id,
    bytes: Buffer = PNG,
    mime = 'image/png',
  ): Promise<FormCoverDto> {
    const started = await fx.call(user, 'POST', `/views/${viewId}/form-cover/uploads`, {
      filename: 'Bìa.png',
      size: bytes.length,
      mime,
    });
    expect(started.statusCode, started.body).toBe(201);
    const target = createUploadResponseSchema.parse(started.json());
    await put(target, bytes);
    const done = await fx.call(
      user,
      'POST',
      `/views/${viewId}/form-cover/uploads/${target.id}/complete`,
    );
    expect(done.statusCode, done.body).toBe(200);
    return formCoverSchema.parse(done.json());
  }

  async function setCover(user: FixtureUser, cover: string | null, viewId: Id<'viw'> = form.id) {
    return fx.call(user, 'PATCH', `/views/${viewId}`, {
      config: { form: { cover_attachment_id: cover } },
    });
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    const limits = t.app.get(ShareRateLimits);
    limits.read = { limit: 100_000, windowSeconds: 1 };
    limits.file = { limit: 100_000, windowSeconds: 10 };
    storage = t.app.get<StorageDriver>(STORAGE_DRIVER);
    fx = await buildRecordFixture(t, db);
    anonymous = new Browser(t.app);
    const response = await fx.call('owner', 'POST', `/tables/${fx.orders.id}/views`, {
      name: 'Request form',
      type: 'form',
      config: { form: { fields: [{ field: title(), required: true }] } },
    });
    expect(response.statusCode, response.body).toBe(201);
    form = viewSchema.parse(response.json());
    expect(form.config.form?.cover_attachment_id).toBeNull();
  });

  afterAll(async () => {
    await t.close();
    await db.destroy();
    await database.drop();
  });

  describe('upload', () => {
    it('checks the view: not visible 404, not editable 403, not a form 422', async () => {
      const body = { filename: 'a.png', size: PNG.length, mime: 'image/png' };
      expectProblem(
        await fx.call('stranger', 'POST', `/views/${form.id}/form-cover/uploads`, body),
        404,
        'NOT_FOUND',
      );
      expectProblem(
        await fx.call('u_reader', 'POST', `/views/${form.id}/form-cover/uploads`, body),
        403,
        'PERMISSION_DENIED',
      );
      const grid = (await fx.call('owner', 'GET', `/tables/${fx.orders.id}/views`)).json<{
        items: ViewDto[];
      }>().items[0];
      const refused = await fx.call(
        'owner',
        'POST',
        `/views/${grid?.id ?? ''}/form-cover/uploads`,
        body,
      );
      expect(refused.statusCode).toBe(422);
      expect(detailsOf(refused.body)[0]?.code).toBe('NOT_ALLOWED');
    });

    it('takes raster images up to 5 MB only', async () => {
      const tooLarge = await fx.call('owner', 'POST', `/views/${form.id}/form-cover/uploads`, {
        filename: 'big.png',
        size: FORM_COVER_MAX_BYTES + 1,
        mime: 'image/png',
      });
      expect(tooLarge.statusCode).toBe(422);
      expect(detailsOf(tooLarge.body)[0]).toMatchObject({
        code: 'FILE_TOO_LARGE',
        params: { limit: FORM_COVER_MAX_BYTES },
      });
      const svg = await fx.call('owner', 'POST', `/views/${form.id}/form-cover/uploads`, {
        filename: 'x.svg',
        size: 10,
        mime: 'image/svg+xml',
      });
      expect(detailsOf(svg.body)[0]?.code).toBe('MIME_NOT_ACCEPTED');
    });

    it('refuses content that is not the announced image and drops the upload', async () => {
      const started = await fx.call('owner', 'POST', `/views/${form.id}/form-cover/uploads`, {
        filename: 'fake.png',
        size: PDF.length,
        mime: 'image/png',
      });
      const target = createUploadResponseSchema.parse(started.json());
      const early = await fx.call(
        'owner',
        'POST',
        `/views/${form.id}/form-cover/uploads/${target.id}/complete`,
      );
      expect(detailsOf(early.body)[0]?.code).toBe('UPLOAD_INCOMPLETE');
      await put(target, PDF);
      const done = await fx.call(
        'owner',
        'POST',
        `/views/${form.id}/form-cover/uploads/${target.id}/complete`,
      );
      expect(detailsOf(done.body)[0]?.code).toBe('CONTENT_MISMATCH');
      const repo = new FormCoversRepository(db);
      expect(await repo.getById(orgScope(fx.orgId), target.id)).toBeUndefined();
    });

    it('lets only the uploader finish an upload', async () => {
      const started = await fx.call('owner', 'POST', `/views/${form.id}/form-cover/uploads`, {
        filename: 'a.png',
        size: PNG.length,
        mime: 'image/png',
      });
      const target = createUploadResponseSchema.parse(started.json());
      await put(target, PNG);
      expectProblem(
        await fx.call(
          'u_editor',
          'POST',
          `/views/${form.id}/form-cover/uploads/${target.id}/complete`,
        ),
        404,
        'NOT_FOUND',
      );
    });
  });

  describe('naming and reading', () => {
    it('shows a draft cover to its uploader only, then to everyone who sees the form', async () => {
      const cover = await uploadCover();
      expect(cover.url).toBe(`/api/v1/views/${form.id}/form-cover/${cover.id}`);
      const own = await fx.call('owner', 'GET', `/views/${form.id}/form-cover/${cover.id}`);
      expect(own.statusCode).toBe(302);
      expect(own.headers['cache-control']).toBe('private, no-store');
      expect(own.headers['referrer-policy']).toBe('no-referrer');
      expectProblem(
        await fx.call('u_editor', 'GET', `/views/${form.id}/form-cover/${cover.id}`),
        404,
        'NOT_FOUND',
      );

      const saved = await setCover('owner', cover.id);
      expect(saved.statusCode, saved.body).toBe(200);
      expect(viewSchema.parse(saved.json()).config.form?.cover_attachment_id).toBe(cover.id);
      for (const user of ['u_editor', 'u_reader'] as const) {
        expect(
          (await fx.call(user, 'GET', `/views/${form.id}/form-cover/${cover.id}`)).statusCode,
        ).toBe(302);
      }
      expectProblem(
        await fx.call('stranger', 'GET', `/views/${form.id}/form-cover/${cover.id}`),
        404,
        'NOT_FOUND',
      );
    });

    it('names only one’s own ready cover; an unchanged value saves as it is', async () => {
      const others = await uploadCover('owner');
      const refused = await setCover('u_editor', others.id);
      expect(refused.statusCode).toBe(422);
      expect(detailsOf(refused.body)[0]).toMatchObject({
        path: 'config.form.cover_attachment_id',
        code: 'ATTACHMENT_NOT_FOUND',
      });
      expect((await setCover('owner', 'att_NotACoverAtAll0001')).statusCode).toBe(422);

      const current = viewSchema.parse(
        (await fx.call('u_editor', 'GET', `/views/${form.id}`)).json(),
      );
      const kept = await fx.call('u_editor', 'PATCH', `/views/${form.id}`, {
        config: { form: { ...current.config.form, title: 'Gửi yêu cầu' } },
      });
      expect(kept.statusCode, kept.body).toBe(200);

      const mine = await uploadCover('u_editor');
      expect((await setCover('u_editor', mine.id)).statusCode).toBe(200);
      // Going back to someone else's cover is a new value again.
      const back = await setCover('u_editor', current.config.form?.cover_attachment_id ?? null);
      expect(back.statusCode).toBe(422);
    });

    it('serves the named cover through the form’s share link only', async () => {
      const cover = await uploadCover('owner');
      expect((await setCover('owner', cover.id)).statusCode).toBe(200);
      const link = createdShareLinkSchema.parse(
        (
          await fx.call('owner', 'POST', `/views/${form.id}/share-links`, { audience: 'public' })
        ).json(),
      );
      const read = await anonymous.request({
        method: 'GET',
        url: `/api/v1/shares/${link.token}/form-cover/${cover.id}`,
      });
      expect(read.statusCode, read.body).toBe(302);
      expect(read.headers['x-robots-tag']).toBe('noindex, nofollow');
      expect(read.headers['referrer-policy']).toBe('no-referrer');

      // A draft (or any other cover) is not reachable through the link.
      const draft = await uploadCover('owner');
      const hidden = await anonymous.request({
        method: 'GET',
        url: `/api/v1/shares/${link.token}/form-cover/${draft.id}`,
      });
      expect(hidden.statusCode).toBe(404);
      expect(
        (
          await anonymous.request({
            method: 'GET',
            url: `/api/v1/shares/${'x'.repeat(43)}/form-cover/${cover.id}`,
          })
        ).statusCode,
      ).toBe(404);

      expect((await setCover('owner', null)).statusCode).toBe(200);
      const removed = await anonymous.request({
        method: 'GET',
        url: `/api/v1/shares/${link.token}/form-cover/${cover.id}`,
      });
      expect(removed.statusCode).toBe(404);
    });
  });

  describe('cleanup', () => {
    it('deletes covers no form view names 24 hours after their upload', async () => {
      const kept = await uploadCover('owner');
      expect((await setCover('owner', kept.id)).statusCode).toBe(200);
      const unused = await uploadCover('owner');
      const repo = new FormCoversRepository(db);
      const scope = orgScope(fx.orgId);
      const key = (await repo.getById(scope, unused.id))?.object_key ?? '';
      expect(await storage.head(key)).not.toBeNull();
      await sql`UPDATE meta.form_covers SET created_at = now() - interval '25 hours'`.execute(
        db.kysely,
      );
      const task = createAttachmentsCleanupTask({ db, storage, logger: pino({ level: 'silent' }) });
      await task({}, {} as Parameters<typeof task>[1]);
      expect(await repo.getById(scope, unused.id)).toBeUndefined();
      expect(await storage.head(key)).toBeNull();
      expect(await repo.getById(scope, kept.id)).toMatchObject({ status: 'ready' });

      // Deleting the view leaves its cover to the next run.
      const copy = await fx.call('owner', 'POST', `/views/${form.id}/duplicate`, {});
      expect(copy.statusCode, copy.body).toBe(201);
      expect((await fx.call('owner', 'DELETE', `/views/${form.id}`)).statusCode).toBe(204);
      await task({}, {} as Parameters<typeof task>[1]);
      // The duplicate names the same cover: still kept.
      expect(await repo.getById(scope, kept.id)).toMatchObject({ status: 'ready' });
      const duplicate = viewSchema.parse(copy.json());
      expect((await fx.call('owner', 'DELETE', `/views/${duplicate.id}`)).statusCode).toBe(204);
      await task({}, {} as Parameters<typeof task>[1]);
      expect(await repo.getById(scope, kept.id)).toBeUndefined();
    });
  });
});
