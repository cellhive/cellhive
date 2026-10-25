import { createHash } from 'node:crypto';
import { buffer } from 'node:stream/consumers';

import {
  attachmentSchema,
  createUploadResponseSchema,
  recordsResponseSchema,
  type AttachmentDto,
  type Id,
  type RecordDto,
} from '@cellhive/contracts';
import {
  AttachmentsRepository,
  orgScope,
  SchemaService,
  systemAuditContext,
  type Db,
  type FieldRow,
  type StorageDriver,
  uploadStagingKey,
} from '@cellhive/server-core';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
import { startTestApp, TEST_PUBLIC_URL, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';
import type { Readable } from 'node:stream';

const MAX_BYTES = 64 * 1024;

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3,
]);
const PDF = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n');
const EXE = Buffer.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0, 4, 0, 0, 0, 0xff, 0xff]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0]);
const MP4 = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from('ftypmp42'),
  Buffer.alloc(100, 7),
]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

function records(response: LightMyRequestResponse): RecordDto[] {
  expect(response.statusCode, response.body).toBeLessThan(300);
  return recordsResponseSchema.parse(response.json()).records;
}

/** Path + query of a URL signed by the local driver, for `app.inject`. */
function localPath(url: string): string {
  const parsed = new URL(url);
  expect(parsed.origin).toBe(TEST_PUBLIC_URL);
  return parsed.pathname + parsed.search;
}

/**
 * T406: attachment uploads, cell writes and downloads end to end with
 * `STORAGE_DRIVER=local` (the Garage flavour: `files-garage.int.test.ts`).
 */
describe('attachments API (T406, local driver)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let storage: StorageDriver;
  let files: FieldRow;
  let images: FieldRow;
  let otherFiles: FieldRow;
  let anything: FieldRow;
  let orders: string;
  const ids: Record<string, Id<'rec'>> = {};

  async function startUpload(
    user: FixtureUser,
    body: { name: string; mime: string; size: number; field?: FieldRow; table?: Id<'tbl'> },
  ): Promise<LightMyRequestResponse> {
    const field = body.field ?? files;
    return fx.call(user, 'POST', '/files/uploads', {
      table_id: body.table ?? field.table_id,
      field_id: field.id,
      filename: body.name,
      size: body.size,
      mime: body.mime,
    });
  }

  async function put(url: string, headers: Record<string, string>, bytes: Buffer) {
    return t.app.inject({ method: 'PUT', url: localPath(url), headers, payload: bytes });
  }

  /** Upload + PUT + complete; returns the completed attachment. */
  async function upload(
    user: FixtureUser,
    name: string,
    mime: string,
    bytes: Buffer,
    field: FieldRow = files,
  ): Promise<AttachmentDto> {
    const started = await startUpload(user, { name, mime, size: bytes.length, field });
    expect(started.statusCode, started.body).toBe(201);
    const { id, upload: target } = createUploadResponseSchema.parse(started.json());
    expect((await put(target.url, target.headers, bytes)).statusCode).toBe(200);
    const done = await fx.call(user, 'POST', `/files/uploads/${id}/complete`);
    expect(done.statusCode, done.body).toBe(200);
    return attachmentSchema.parse(done.json());
  }

  async function setFiles(user: FixtureUser, record: string, value: unknown) {
    return fx.call(user, 'PATCH', `${orders}?field_key_type=id`, {
      records: [{ id: ids[record], fields: { [files.id]: value } }],
    });
  }

  async function download(user: FixtureUser, id: string) {
    return fx.call(user, 'GET', `/files/${id}`);
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({
      DATABASE_URL: database.url,
      ATTACHMENT_MAX_FILE_BYTES: String(MAX_BYTES),
    });
    storage = t.app.get<StorageDriver>(STORAGE_DRIVER);
    fx = await buildRecordFixture(t, db);
    orders = `/tables/${fx.orders.id}/records`;
    const schema = t.app.get(SchemaService);
    const scope = orgScope(fx.orgId);
    files = await schema.addField(
      scope,
      fx.orders.id,
      { name: 'files', type: 'attachment', options: { max_files: 4 } },
      systemAuditContext(),
    );
    images = await schema.addField(
      scope,
      fx.orders.id,
      { name: 'images', type: 'attachment', options: { accept: ['image/*'] } },
      systemAuditContext(),
    );
    otherFiles = await schema.addField(
      scope,
      fx.customers.id,
      { name: 'files', type: 'attachment', options: {} },
      systemAuditContext(),
    );
    anything = await schema.addField(
      scope,
      fx.orders.id,
      { name: 'anything', type: 'attachment', options: { blocked_extensions: [] } },
      systemAuditContext(),
    );
    const created = records(
      await fx.call('owner', 'POST', orders, {
        records: [
          { fields: { title: 'r1', owner: [{ id: fx.users.u_sales1.id }] } },
          { fields: { title: 'r2', owner: [{ id: fx.users.u_sales2.id }] } },
        ],
      }),
    );
    for (const record of created) ids[record.fields.title as string] = record.id;
  });

  afterAll(async () => {
    await t.close();
    await db.destroy();
    await database.drop();
  });

  describe('upload', () => {
    it('uploads, completes with SHA-256 and writes the cell (CONTRACTS §2)', async () => {
      const file = await upload('u_editor', 'Hợp đồng "số 1".pdf', 'application/pdf', PDF);
      expect(file).toMatchObject({
        name: 'Hợp đồng "số 1".pdf',
        size: PDF.length,
        mime: 'application/pdf',
        url: `/api/v1/files/${file.id}`,
        thumbnail_url: null,
      });
      const row = await new AttachmentsRepository(db).getById(orgScope(fx.orgId), file.id);
      expect(row).toMatchObject({
        status: 'ready',
        record_id: null,
        sha256: createHash('sha256').update(PDF).digest('hex'),
      });
      // Completing again is idempotent.
      const again = await fx.call('u_editor', 'POST', `/files/uploads/${file.id}/complete`);
      expect(again.json()).toEqual(file);

      const [record] = records(await setFiles('u_editor', 'r1', [{ id: file.id }]));
      expect(record?.fields[files.id]).toEqual([file]);
      expect(
        (await new AttachmentsRepository(db).getById(orgScope(fx.orgId), file.id))?.record_id,
      ).toBe(ids.r1);
    });

    it('a PUT URL replayed after complete cannot replace the checked file', async () => {
      const started = await startUpload('u_editor', {
        name: 'contract.pdf',
        mime: 'application/pdf',
        size: PDF.length,
      });
      const { id, upload: target } = createUploadResponseSchema.parse(started.json());
      expect((await put(target.url, target.headers, PDF)).statusCode).toBe(200);
      const done = await fx.call('u_editor', 'POST', `/files/uploads/${id}/complete`);
      expect(done.statusCode, done.body).toBe(200);
      // Same signed URL (valid 10 minutes), same size, a Windows executable.
      const swapped = Buffer.concat([EXE, Buffer.alloc(PDF.length - EXE.length)]);
      expect((await put(target.url, target.headers, swapped)).statusCode).toBe(200);
      const again = await fx.call('u_editor', 'POST', `/files/uploads/${id}/complete`);
      expect(again.json()).toEqual(done.json());
      const row = await new AttachmentsRepository(db).getById(orgScope(fx.orgId), id);
      expect(row?.sha256).toBe(createHash('sha256').update(PDF).digest('hex'));
      const stored = await t.app
        .get<StorageDriver>(STORAGE_DRIVER)
        .getStream(row?.object_key ?? '');
      expect(stored).not.toBeNull();
      expect(Buffer.from(await buffer(stored as Readable)).equals(PDF)).toBe(true);
    });

    it('signs the PUT for the exact type and size', async () => {
      const started = await startUpload('u_editor', {
        name: 'a.pdf',
        mime: 'Application/PDF; charset=binary',
        size: PDF.length,
      });
      const { upload: target } = createUploadResponseSchema.parse(started.json());
      expect(target.headers).toEqual({ 'content-type': 'application/pdf' });
      const expiresIn = (Date.parse(target.expires_at) - Date.now()) / 1000;
      expect(expiresIn).toBeGreaterThan(590);
      expect(expiresIn).toBeLessThanOrEqual(600);
      // More bytes than announced never reach storage.
      expect((await put(target.url, target.headers, Buffer.concat([PDF, PDF]))).statusCode).toBe(
        413,
      );
      expect((await put(target.url, { 'content-type': 'text/html' }, PDF)).statusCode).toBe(403);
    });

    it('refuses a file over ATTACHMENT_MAX_FILE_BYTES or of a type the field does not accept', async () => {
      const big = await startUpload('u_editor', {
        name: 'big.pdf',
        mime: 'application/pdf',
        size: MAX_BYTES + 1,
      });
      expectProblem(big, 422, 'VALIDATION_FAILED');
      expect(big.json()).toMatchObject({
        errors: [{ path: 'size', code: 'FILE_TOO_LARGE', params: { limit: MAX_BYTES } }],
      });
      const pdf = await startUpload('u_editor', {
        name: 'a.pdf',
        mime: 'application/pdf',
        size: 10,
        field: images,
      });
      expectProblem(pdf, 422, 'VALIDATION_FAILED');
      expect(pdf.json()).toMatchObject({ errors: [{ path: 'mime', code: 'MIME_NOT_ACCEPTED' }] });
      const bad = await startUpload('u_editor', { name: 'a', mime: 'pdf', size: 10 });
      expect(bad.json()).toMatchObject({ errors: [{ path: 'mime', code: 'INVALID_FORMAT' }] });
      const notAttachment = await fx.call('u_editor', 'POST', '/files/uploads', {
        table_id: fx.orders.id,
        field_id: fx.fld.amount?.id,
        filename: 'a.pdf',
        size: 1,
        mime: 'application/pdf',
      });
      expect(notAttachment.json()).toMatchObject({
        errors: [{ path: 'field_id', code: 'INVALID_FIELD_TYPE' }],
      });
    });

    it('lets an admin unblock executables per field (blocked_extensions: [])', async () => {
      expect(
        (
          await startUpload('u_editor', {
            name: 'run.sh',
            mime: 'text/x-shellscript',
            size: 5,
            field: anything,
          })
        ).statusCode,
      ).toBe(201);
      const exe = await upload('u_editor', 'tool.exe', 'application/octet-stream', EXE, anything);
      expect(exe).toMatchObject({ name: 'tool.exe', mime: 'application/octet-stream' });
      records(
        await fx.call('u_editor', 'PATCH', `${orders}?field_key_type=id`, {
          records: [{ id: ids.r1, fields: { [anything.id]: [{ id: exe.id }] } }],
        }),
      );
      // Served as a download, never inline.
      const location = String((await download('u_editor', exe.id)).headers.location);
      const file = await t.app.inject({ method: 'GET', url: localPath(location) });
      expect(String(file.headers['content-disposition'])).toMatch(/^attachment;/);
      expect(file.headers['x-content-type-options']).toBe('nosniff');
    });

    it('refuses the default blocked types (executables) by name or MIME type (S4 decision #6)', async () => {
      for (const [name, mime, path] of [
        ['setup.EXE', 'application/octet-stream', 'filename'],
        ['run.sh ', 'text/plain', 'filename'],
        ['lib.jar', 'application/zip', 'filename'],
        ['photo.png', 'application/x-msdownload', 'mime'],
      ] as const) {
        const response = await startUpload('u_editor', { name, mime, size: 10 });
        expectProblem(response, 422, 'VALIDATION_FAILED');
        expect(response.json()).toMatchObject({ errors: [{ path, code: 'BLOCKED_FILE_TYPE' }] });
      }
    });

    it('deletes an executable renamed .png, a JPEG declared PNG and a short file (422)', async () => {
      for (const [bytes, size, mime, code] of [
        [EXE, EXE.length, 'image/png', 'BLOCKED_FILE_TYPE'],
        [EXE, EXE.length, 'application/octet-stream', 'BLOCKED_FILE_TYPE'],
        [JPEG, JPEG.length, 'image/png', 'CONTENT_MISMATCH'],
        [PDF.subarray(0, 5), PDF.length, 'application/pdf', 'SIZE_MISMATCH'],
      ] as const) {
        const started = await startUpload('u_editor', { name: 'photo.png', mime, size });
        const { id, upload: target } = createUploadResponseSchema.parse(started.json());
        expect((await put(target.url, target.headers, bytes)).statusCode).toBe(200);
        const key = `${fx.orgId}/${id}`;
        expect(await storage.head(uploadStagingKey(key))).not.toBeNull();
        const done = await fx.call('u_editor', 'POST', `/files/uploads/${id}/complete`);
        expectProblem(done, 422, 'VALIDATION_FAILED');
        expect(done.json()).toMatchObject({ errors: [{ code }] });
        expect(await storage.head(key)).toBeNull();
        expectProblem(
          await fx.call('u_editor', 'POST', `/files/uploads/${id}/complete`),
          404,
          'NOT_FOUND',
        );
      }
    });

    it('answers UPLOAD_INCOMPLETE before the PUT, and keeps the upload', async () => {
      const started = await startUpload('u_editor', {
        name: 'a.pdf',
        mime: 'application/pdf',
        size: PDF.length,
      });
      const { id, upload: target } = createUploadResponseSchema.parse(started.json());
      const early = await fx.call('u_editor', 'POST', `/files/uploads/${id}/complete`);
      expect(early.json()).toMatchObject({ errors: [{ code: 'UPLOAD_INCOMPLETE' }] });
      expect((await put(target.url, target.headers, PDF)).statusCode).toBe(200);
      expect((await fx.call('u_editor', 'POST', `/files/uploads/${id}/complete`)).statusCode).toBe(
        200,
      );
    });

    it('checks field write permission: 404 when not visible, 403 when visible but not writable', async () => {
      const body = { name: 'a.pdf', mime: 'application/pdf', size: 10 };
      expectProblem(await startUpload('u_out', body), 404, 'NOT_FOUND');
      expectProblem(await startUpload('stranger', body), 404, 'NOT_FOUND');
      expectProblem(await startUpload('u_reader', body), 403, 'PERMISSION_DENIED');
      // Sales: Customers is no_perm; `cost` is no_perm; `status` is read.
      expectProblem(
        await startUpload('u_sales1', { ...body, field: otherFiles }),
        404,
        'NOT_FOUND',
      );
      expectProblem(
        await startUpload('u_editor', { ...body, table: fx.orders.id, field: otherFiles }),
        404,
        'NOT_FOUND',
      );
      expect((await startUpload('u_sales1', body)).statusCode).toBe(201);
    });

    it('completes only for the uploader (404 for anyone else)', async () => {
      const started = await startUpload('u_editor', {
        name: 'a.pdf',
        mime: 'application/pdf',
        size: 5,
      });
      const { id } = createUploadResponseSchema.parse(started.json());
      for (const user of ['u_admin', 'owner', 'stranger'] as const) {
        expectProblem(
          await fx.call(user, 'POST', `/files/uploads/${id}/complete`),
          404,
          'NOT_FOUND',
        );
      }
    });
  });

  describe('cells', () => {
    it('accepts only ready uploads of the caller for this table and field (422 otherwise)', async () => {
      const mine = await upload('owner', 'mine.pdf', 'application/pdf', PDF);
      const someoneElses = await upload('u_editor', 'theirs.pdf', 'application/pdf', PDF);
      const otherField = await upload('owner', 'img.png', 'image/png', PNG, images);
      const otherTable = await upload('owner', 'c.pdf', 'application/pdf', PDF, otherFiles);
      const pending = createUploadResponseSchema.parse(
        (await startUpload('owner', { name: 'p.pdf', mime: 'application/pdf', size: 5 })).json(),
      );

      // Another organization: its owner uploads into their own base.
      const stranger = new Browser(t.app);
      expect((await stranger.login(fx.users.stranger.email)).statusCode).toBe(204);
      const strangerOrg = (
        await db.kysely
          .selectFrom('meta.org_members')
          .select('organization_id')
          .where('user_id', '=', fx.users.stranger.id)
          .executeTakeFirstOrThrow()
      ).organization_id;
      const workspace = await stranger.request({
        method: 'POST',
        url: `/api/v1/orgs/${strangerOrg}/workspaces`,
        payload: { name: 'W' },
      });
      const base = await stranger.request({
        method: 'POST',
        url: `/api/v1/workspaces/${workspace.json<{ id: string }>().id}/bases`,
        payload: { name: 'B' },
      });
      const schema = t.app.get(SchemaService);
      const { table } = await schema.createTable(
        orgScope(strangerOrg),
        { baseId: base.json<{ id: Id<'bse'> }>().id, name: 'T', primaryFieldName: 'Name' },
        systemAuditContext(),
      );
      const foreignField = await schema.addField(
        orgScope(strangerOrg),
        table.id,
        { name: 'files', type: 'attachment', options: {} },
        systemAuditContext(),
      );
      const foreign = await upload('stranger', 'x.pdf', 'application/pdf', PDF, foreignField);

      for (const id of [
        someoneElses.id,
        otherField.id,
        otherTable.id,
        pending.id,
        foreign.id,
        'att_0000000000000000',
      ]) {
        const response = await setFiles('owner', 'r2', [{ id: mine.id }, { id }]);
        expectProblem(response, 422, 'INVALID_CELL_VALUE');
        expect(response.json()).toMatchObject({
          errors: [{ code: 'ATTACHMENT_NOT_FOUND', params: { id } }],
        });
      }
      // Nothing was bound by the failed writes.
      expect(
        (await new AttachmentsRepository(db).getById(orgScope(fx.orgId), mine.id))?.record_id,
      ).toBeNull();

      const tooMany = await setFiles('owner', 'r2', [
        { id: mine.id },
        { id: 'att_1000000000000000' },
        { id: 'att_2000000000000000' },
        { id: 'att_3000000000000000' },
        { id: 'att_4000000000000000' },
      ]);
      expect(tooMany.json()).toMatchObject({
        code: 'INVALID_CELL_VALUE',
        errors: [{ code: 'TOO_MANY_VALUES', params: { max: 4 } }],
      });
      const [record] = records(await setFiles('owner', 'r2', [{ id: mine.id }]));
      expect(record?.fields[files.id]).toEqual([mine]);
    });

    it('copies a file pasted from another record: new id, same object (S4 #12)', async () => {
      const source = await upload('owner', 'shared.pdf', 'application/pdf', PDF);
      const [r1] = records(await setFiles('owner', 'r1', [{ id: source.id }]));
      expect(r1?.fields[files.id]).toEqual([source]);
      const [r2] = records(await setFiles('owner', 'r2', [{ id: source.id }]));
      const copy = (r2?.fields[files.id] as AttachmentDto[])[0];
      expect(copy?.id).not.toBe(source.id);
      expect(copy).toMatchObject({ name: 'shared.pdf', size: PDF.length, mime: 'application/pdf' });
      const repo = new AttachmentsRepository(db);
      const [a, b] = await Promise.all([
        repo.getById(orgScope(fx.orgId), source.id),
        repo.getById(orgScope(fx.orgId), copy?.id as Id<'att'>),
      ]);
      expect(b?.object_key).toBe(a?.object_key);
      expect(b?.record_id).toBe(ids.r2);
      expect((await download('owner', source.id)).statusCode).toBe(302);
      expect((await download('owner', copy?.id ?? '')).statusCode).toBe(302);

      // Sales can read r1 only: pasting a file of r2 (not readable) is refused.
      const sales = await fx.call('u_sales1', 'PATCH', `${orders}?field_key_type=id`, {
        records: [{ id: ids.r1, fields: { [files.id]: [{ id: copy?.id }] } }],
      });
      expect(sales.json()).toMatchObject({ errors: [{ code: 'ATTACHMENT_NOT_FOUND' }] });
    });

    it('detaches removed files (kept for undo) and a history revert puts them back', async () => {
      const file = await upload('owner', 'undo.pdf', 'application/pdf', PDF);
      records(await setFiles('owner', 'r1', [{ id: file.id }]));
      records(await setFiles('owner', 'r1', null));
      const repo = new AttachmentsRepository(db);
      expect((await repo.getById(orgScope(fx.orgId), file.id))?.detached_at).not.toBeNull();
      expectProblem(await download('owner', file.id), 404, 'NOT_FOUND');

      // Audit (ADR-23): before/after carry the files.
      const entries = await db.kysely
        .selectFrom('meta.audit_logs')
        .select(['id', 'before', 'after'])
        .where('entity_id', '=', ids.r1 as string)
        .where('action', '=', 'record.updated')
        .orderBy('created_at', 'desc')
        .limit(1)
        .execute();
      const removal = entries[0];
      expect(removal?.before).toEqual({
        [files.id]: [{ id: file.id, name: 'undo.pdf', size: PDF.length, mime: 'application/pdf' }],
      });
      expect(removal?.after).toEqual({ [files.id]: null });

      const reverted = await fx.call('owner', 'POST', `${orders}/${ids.r1 ?? ''}/revert`, {
        audit_id: removal?.id,
      });
      expect(reverted.statusCode, reverted.body).toBe(200);
      expect(reverted.json<RecordDto>().fields.files).toEqual([file]);
      expect((await repo.getById(orgScope(fx.orgId), file.id))?.detached_at).toBeNull();
      expect((await download('owner', file.id)).statusCode).toBe(302);
    });

    it('filters by emptiness; never sorts by an attachment field', async () => {
      const empty = await fx.call('owner', 'POST', `${orders}/query?field_key_type=id`, {
        filter: { op: 'and', items: [{ field: files.id, operator: 'is_empty' }] },
      });
      expect(empty.statusCode, empty.body).toBe(200);
      const sorted = await fx.call('owner', 'POST', `${orders}/query?field_key_type=id`, {
        sort: [{ field: files.id, direction: 'asc' }],
      });
      expectProblem(sorted, 422, 'INVALID_SORT');
      expect(sorted.json()).toMatchObject({
        errors: [{ path: 'sort[0].field', code: 'FIELD_NOT_SORTABLE' }],
      });
    });
  });

  describe('download', () => {
    let pdf: AttachmentDto;
    let png: AttachmentDto;
    let svg: AttachmentDto;
    let mp4: AttachmentDto;
    let onR2: AttachmentDto;

    beforeAll(async () => {
      pdf = await upload('owner', 'Báo cáo tháng 9.pdf', 'application/pdf', PDF);
      png = await upload('owner', 'ảnh.png', 'image/png', PNG);
      svg = await upload('owner', 'logo.svg', 'image/svg+xml', SVG);
      records(await setFiles('owner', 'r1', [{ id: pdf.id }, { id: png.id }, { id: svg.id }]));
      mp4 = await upload('owner', 'clip.mp4', 'video/mp4', MP4);
      records(
        await setFiles('owner', 'r1', [
          { id: pdf.id },
          { id: png.id },
          { id: svg.id },
          { id: mp4.id },
        ]),
      );
      onR2 = await upload('owner', 'r2.pdf', 'application/pdf', PDF);
      records(await setFiles('owner', 'r2', [{ id: onR2.id }]));
    });

    it('redirects to a URL valid 60 seconds with safe headers', async () => {
      const response = await download('u_editor', pdf.id);
      expect(response.statusCode).toBe(302);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      const location = String(response.headers.location);
      const exp = Number(new URL(location).searchParams.get('exp'));
      expect(exp - Date.now() / 1000).toBeGreaterThan(55);
      expect(exp - Date.now() / 1000).toBeLessThanOrEqual(60);

      const file = await t.app.inject({ method: 'GET', url: localPath(location) });
      expect(file.statusCode).toBe(200);
      expect(file.rawPayload.equals(PDF)).toBe(true);
      expect(file.headers['content-disposition']).toBe(
        `attachment; filename="Bao cao thang 9.pdf"; filename*=UTF-8''B%C3%A1o%20c%C3%A1o%20th%C3%A1ng%209.pdf`,
      );
      expect(file.headers['x-content-type-options']).toBe('nosniff');
      expect(file.headers['content-security-policy']).toBe('sandbox');
    });

    it('serves only raster images inline; SVG is an attachment in a CSP sandbox', async () => {
      const image = await t.app.inject({
        method: 'GET',
        url: localPath(String((await download('owner', png.id)).headers.location)),
      });
      expect(String(image.headers['content-disposition'])).toMatch(/^inline;/);
      const vector = await t.app.inject({
        method: 'GET',
        url: localPath(String((await download('owner', svg.id)).headers.location)),
      });
      expect(String(vector.headers['content-disposition'])).toMatch(/^attachment;/);
      expect(vector.headers['content-security-policy']).toBe('sandbox');
      expect(vector.headers['x-content-type-options']).toBe('nosniff');
    });

    it('serves video inline with its type and byte ranges (native <video>, S4 decision #6)', async () => {
      const url = localPath(String((await download('owner', mp4.id)).headers.location));
      const whole = await t.app.inject({ method: 'GET', url });
      expect(String(whole.headers['content-disposition'])).toMatch(/^inline;/);
      expect(whole.headers['content-type']).toBe('video/mp4');
      expect(whole.headers['accept-ranges']).toBe('bytes');
      const part = await t.app.inject({ method: 'GET', url, headers: { range: 'bytes=4-11' } });
      expect(part.statusCode).toBe(206);
      expect(part.headers['content-range']).toBe(`bytes 4-11/${String(MP4.length)}`);
      expect(part.headers['content-length']).toBe('8');
      expect(part.body).toBe('ftypmp42');
      const tail = await t.app.inject({ method: 'GET', url, headers: { range: 'bytes=-10' } });
      expect(tail.rawPayload.equals(MP4.subarray(-10))).toBe(true);
      const beyond = await t.app.inject({ method: 'GET', url, headers: { range: 'bytes=5000-' } });
      expect(beyond.statusCode).toBe(416);
      expect(beyond.headers['content-range']).toBe(`bytes */${String(MP4.length)}`);
    });

    it('404 without read access to the record or field, 403 without file_download_fields', async () => {
      // u_sales1 reads r1 only (read_scope editable) and has no file_download_fields.
      expectProblem(await download('u_sales1', onR2.id), 404, 'NOT_FOUND');
      expectProblem(await download('u_sales1', pdf.id), 403, 'PERMISSION_DENIED');
      expectProblem(await download('u_out', pdf.id), 404, 'NOT_FOUND');
      expectProblem(await download('stranger', pdf.id), 404, 'NOT_FOUND');
      expectProblem(await download('owner', 'att_0000000000000000'), 404, 'NOT_FOUND');
      expect((await download('u_reader', pdf.id)).statusCode).toBe(302);
      // A record in the trash is not readable.
      expect((await fx.call('owner', 'DELETE', orders, { ids: [ids.r2] })).statusCode).toBe(200);
      expectProblem(await download('owner', onR2.id), 404, 'NOT_FOUND');
      expect(
        (await fx.call('owner', 'POST', `${orders}/restore`, { ids: [ids.r2] })).statusCode,
      ).toBe(200);
      expect((await download('owner', onR2.id)).statusCode).toBe(302);
    });

    it('logs no file name, storage key or signed URL', async () => {
      await download('owner', pdf.id);
      const raw = t.logs.raw();
      expect(raw).not.toContain('Báo cáo');
      expect(raw).not.toContain(`${fx.orgId}/${pdf.id}`);
      expect(raw).not.toContain('sig=');
    });
  });

  describe('thumbnails (T407)', () => {
    let photo: AttachmentDto;
    let onR2: AttachmentDto;
    let doc: AttachmentDto;
    const png = realPng(1600, 900);

    async function thumbnail(user: FixtureUser, id: string, query = '') {
      return fx.call(user, 'GET', `/files/${id}/thumbnail${query}`);
    }

    const render = (id: string) => renderThumbnail(db, storage, fx.orgId, id);

    beforeAll(async () => {
      photo = await upload('owner', 'Ảnh sản phẩm.png', 'image/png', png, anything);
      doc = await upload('owner', 'hd.pdf', 'application/pdf', PDF, anything);
      onR2 = await upload('owner', 'r2.png', 'image/png', png, anything);
      for (const [record, value] of [
        ['r1', [{ id: photo.id }, { id: doc.id }]],
        ['r2', [{ id: onR2.id }]],
      ] as const) {
        records(
          await fx.call('owner', 'PATCH', `${orders}?field_key_type=id`, {
            records: [{ id: ids[record], fields: { [anything.id]: value } }],
          }),
        );
      }
    });

    it('announces a thumbnail for raster images and enqueues its job with complete', async () => {
      expect(photo.thumbnail_url).toBe(`/api/v1/files/${photo.id}/thumbnail`);
      expect(doc.thumbnail_url).toBeNull();
      const row = await new AttachmentsRepository(db).getById(orgScope(fx.orgId), photo.id);
      expect(row?.thumbnail_status).toBe('pending');
      const { rows } = await sql<{ payload: unknown; max_attempts: number }>`
        SELECT p.payload, p.max_attempts FROM graphile_worker._private_jobs p
          JOIN graphile_worker._private_tasks t ON t.id = p.task_id
         WHERE t.identifier = 'file.thumbnail'
      `.execute(db.kysely);
      expect(rows.map((job) => job.payload)).toContainEqual({
        organization_id: fx.orgId,
        attachment_id: photo.id,
      });
      expect(
        (await new AttachmentsRepository(db).getById(orgScope(fx.orgId), doc.id))?.thumbnail_status,
      ).toBeNull();
      // Not rendered yet: the original for those who may download it, else 404.
      expectProblem(await thumbnail('u_sales1', photo.id), 404, 'NOT_FOUND');
      const fallback = await thumbnail('owner', photo.id);
      expect(fallback.statusCode).toBe(302);
      expect(fallback.headers['cache-control']).toBe('private, no-store');
      const original = await t.app.inject({
        method: 'GET',
        url: localPath(String(fallback.headers.location)),
      });
      expect(original.rawPayload.equals(png)).toBe(true);
      expect(String(original.headers['content-disposition'])).toMatch(/^inline;/);
    });

    it('serves the WebP to readers without file_download_fields, never to others', async () => {
      await render(photo.id);
      await render(onR2.id);
      // u_sales1 reads r1 but has no file_download_fields: may view, not download.
      expectProblem(await download('u_sales1', photo.id), 403, 'PERMISSION_DENIED');
      const small = await thumbnail('u_sales1', photo.id);
      expect(small.statusCode, small.body).toBe(200);
      expect(small.headers['content-type']).toBe('image/webp');
      expect(small.headers['cache-control']).toBe('private, max-age=60');
      expect(small.headers['x-content-type-options']).toBe('nosniff');
      expect(small.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
      expect(small.rawPayload.subarray(0, 4).toString('ascii')).toBe('RIFF');
      expect(small.rawPayload.subarray(8, 12).toString('ascii')).toBe('WEBP');
      const large = await thumbnail('u_sales1', photo.id, '?size=1280');
      expect(large.statusCode).toBe(200);
      expect(large.rawPayload.length).toBeGreaterThan(small.rawPayload.length);
      // Width in the VP8 header of a lossy WebP (bytes 26–27, 14 bits).
      expect(small.rawPayload.readUInt16LE(26) & 0x3fff).toBe(256);
      expect(large.rawPayload.readUInt16LE(26) & 0x3fff).toBe(1280);
      expectProblem(await thumbnail('u_sales1', photo.id, '?size=999'), 422, 'VALIDATION_FAILED');

      // Not readable: record outside the read rule, no access, another organization.
      expectProblem(await thumbnail('u_sales1', onR2.id), 404, 'NOT_FOUND');
      expect((await thumbnail('owner', onR2.id)).statusCode).toBe(200);
      expectProblem(await thumbnail('u_out', photo.id), 404, 'NOT_FOUND');
      expectProblem(await thumbnail('stranger', photo.id), 404, 'NOT_FOUND');
      expectProblem(await thumbnail('owner', 'att_0000000000000000'), 404, 'NOT_FOUND');
      // No thumbnail for a PDF.
      expectProblem(await thumbnail('owner', doc.id), 404, 'NOT_FOUND');
      // A record in the trash is not readable.
      expect((await fx.call('owner', 'DELETE', orders, { ids: [ids.r2] })).statusCode).toBe(200);
      expectProblem(await thumbnail('owner', onR2.id), 404, 'NOT_FOUND');
      expect(
        (await fx.call('owner', 'POST', `${orders}/restore`, { ids: [ids.r2] })).statusCode,
      ).toBe(200);
      // A file removed from its cell is not served.
      records(
        await fx.call('owner', 'PATCH', `${orders}?field_key_type=id`, {
          records: [{ id: ids.r2, fields: { [anything.id]: null } }],
        }),
      );
      expectProblem(await thumbnail('owner', onR2.id), 404, 'NOT_FOUND');
    });

    it("serves the uploader's own upload before it is in a cell, nobody else's (T421b)", async () => {
      // The panel asks for the thumbnail as soon as `complete` answers, before the cell write.
      const mine = await upload('owner', 'mới.png', 'image/png', png, anything);
      const early = await thumbnail('owner', mine.id);
      expect(early.statusCode, early.body).toBe(302);
      expect(early.headers['cache-control']).toBe('private, no-store');
      // The client's retries add a query of their own (a distinct URL): ignored.
      expect((await thumbnail('owner', mine.id, '?size=256&retry=2')).statusCode).toBe(302);
      // Anyone else: as if it did not exist (even an admin of the organization).
      expectProblem(await thumbnail('u_admin', mine.id), 404, 'NOT_FOUND');
      expectProblem(await thumbnail('u_editor', mine.id), 404, 'NOT_FOUND');
      expectProblem(await thumbnail('stranger', mine.id), 404, 'NOT_FOUND');
      await render(mine.id);
      const rendered = await thumbnail('owner', mine.id);
      expect(rendered.statusCode).toBe(200);
      expect(rendered.headers['content-type']).toBe('image/webp');
      // The download itself still needs the file in a cell.
      expectProblem(await download('owner', mine.id), 404, 'NOT_FOUND');

      // Same scope rules as a download: without file_download_fields, only the WebP.
      const theirs = await upload('u_sales1', 'sales.png', 'image/png', png, anything);
      expectProblem(await thumbnail('u_sales1', theirs.id), 404, 'NOT_FOUND');
      await render(theirs.id);
      expect((await thumbnail('u_sales1', theirs.id)).statusCode).toBe(200);
      expectProblem(await thumbnail('owner', theirs.id), 404, 'NOT_FOUND');

      // A file removed from its cell stays hidden, also from its uploader.
      records(
        await fx.call('owner', 'PATCH', `${orders}?field_key_type=id`, {
          records: [{ id: ids.r2, fields: { [anything.id]: [{ id: mine.id }] } }],
        }),
      );
      expect((await thumbnail('owner', mine.id)).statusCode).toBe(200);
      records(
        await fx.call('owner', 'PATCH', `${orders}?field_key_type=id`, {
          records: [{ id: ids.r2, fields: { [anything.id]: null } }],
        }),
      );
      expectProblem(await thumbnail('owner', mine.id), 404, 'NOT_FOUND');
    });

    it('shares the thumbnails of a copied file (same object)', async () => {
      const [r2] = records(
        await fx.call('owner', 'PATCH', `${orders}?field_key_type=id`, {
          records: [{ id: ids.r2, fields: { [anything.id]: [{ id: photo.id }] } }],
        }),
      );
      const copy = (r2?.fields[anything.id] as AttachmentDto[])[0];
      expect(copy?.id).not.toBe(photo.id);
      expect(copy?.thumbnail_url).toBe(`/api/v1/files/${copy?.id ?? ''}/thumbnail`);
      expect((await thumbnail('owner', copy?.id ?? '')).statusCode).toBe(200);
    });

    it('logs no file name or storage key', async () => {
      await thumbnail('owner', photo.id);
      const raw = t.logs.raw();
      expect(raw).not.toContain('Ảnh sản phẩm');
      expect(raw).not.toContain(`${fx.orgId}/${photo.id}`);
    });
  });

  it('keeps the unattached upload table consistent after all writes (no stray bindings)', async () => {
    const { rows } = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM meta.attachments
       WHERE organization_id = ${fx.orgId} AND record_id IS NOT NULL AND status <> 'ready'
    `.execute(db.kysely);
    expect(rows[0]?.n).toBe('0');
  });
});
