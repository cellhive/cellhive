import {
  attachmentSchema,
  createUploadResponseSchema,
  type AttachmentDto,
  type Id,
} from '@cellhive/contracts';
import {
  contentDisposition,
  orgScope,
  SchemaService,
  systemAuditContext,
  type Db,
  type FieldRow,
  type StorageDriver,
  uploadStagingKey,
} from '@cellhive/server-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { STORAGE_DRIVER } from '../../src/common/tokens.js';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { garageEnv, startGarage, type StartedGarage } from './garage-support.js';
import { realPng, renderThumbnail } from './images.js';
import { buildRecordFixture, expectProblem, type RecordFixture } from './record-fixture.js';
import { startTestApp, type TestApp } from './support.js';

const PDF = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n');
const EXE = Buffer.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0, 4, 0, 0, 0, 0xff, 0xff]);

/**
 * T406 against a real Garage (ADR-0016, Testcontainers): presigned PUT/GET
 * signed for `S3_PUBLIC_ENDPOINT` (another host than `S3_ENDPOINT`), the
 * signed `Content-Length` enforced by Garage (BACKLOG S4 #13), `complete`
 * checks and the download redirect.
 */
describe('attachments API (T406, Garage)', () => {
  let garage: StartedGarage;
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let files: FieldRow;
  let storage: StorageDriver;
  let recordId: Id<'rec'>;

  async function start(name: string, mime: string, size: number) {
    const response = await fx.call('owner', 'POST', '/files/uploads', {
      table_id: fx.orders.id,
      field_id: files.id,
      filename: name,
      size,
      mime,
    });
    expect(response.statusCode, response.body).toBe(201);
    return createUploadResponseSchema.parse(response.json());
  }

  beforeAll(async () => {
    garage = await startGarage();
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url, ...garageEnv(garage) });
    storage = t.app.get<StorageDriver>(STORAGE_DRIVER);
    expect(storage.kind).toBe('s3');
    fx = await buildRecordFixture(t, db);
    files = await t.app
      .get(SchemaService)
      .addField(
        orgScope(fx.orgId),
        fx.orders.id,
        { name: 'files', type: 'attachment', options: {} },
        systemAuditContext(),
      );
    const created = await fx.call('owner', 'POST', `/tables/${fx.orders.id}/records`, {
      records: [{ fields: { title: 'r1' } }],
    });
    recordId = created.json<{ records: { id: Id<'rec'> }[] }>().records[0]?.id as Id<'rec'>;
  }, 240_000);

  afterAll(async () => {
    await t.close();
    await db.destroy();
    await database.drop();
    await garage.stop();
  });

  it('uploads through S3_PUBLIC_ENDPOINT; Garage enforces the signed type and size', async () => {
    const { id, upload } = await start('Báo cáo.pdf', 'application/pdf', PDF.length);
    expect(new URL(upload.url).origin).toBe(garage.publicEndpoint);
    expect(new URL(upload.url).searchParams.get('X-Amz-Expires')).toBe('600');
    expect(new URL(upload.url).searchParams.get('X-Amz-SignedHeaders')).toBe(
      'content-length;content-type;host',
    );

    const longer = await fetch(upload.url, {
      method: 'PUT',
      headers: upload.headers,
      body: Buffer.concat([PDF, PDF]),
    });
    expect(longer.status).toBe(403);
    const otherType = await fetch(upload.url, {
      method: 'PUT',
      headers: { 'content-type': 'text/html' },
      body: PDF,
    });
    expect(otherType.status).toBe(403);
    expect(await storage.head(`${fx.orgId}/${id}`)).toBeNull();

    const ok = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: PDF });
    expect(ok.status).toBe(200);
    const done = await fx.call('owner', 'POST', `/files/uploads/${id}/complete`);
    expect(done.statusCode, done.body).toBe(200);
    const file: AttachmentDto = attachmentSchema.parse(done.json());

    const written = await fx.call(
      'owner',
      'PATCH',
      `/tables/${fx.orders.id}/records?field_key_type=id`,
      {
        records: [{ id: recordId, fields: { [files.id]: [{ id: file.id }] } }],
      },
    );
    expect(written.statusCode, written.body).toBe(200);

    const redirect = await fx.call('owner', 'GET', `/files/${file.id}`);
    expect(redirect.statusCode).toBe(302);
    const location = new URL(String(redirect.headers.location));
    expect(location.origin).toBe(garage.publicEndpoint);
    expect(location.searchParams.get('X-Amz-Expires')).toBe('60');
    const downloaded = await fetch(location);
    expect(downloaded.status).toBe(200);
    expect(Buffer.from(await downloaded.arrayBuffer()).equals(PDF)).toBe(true);
    expect(downloaded.headers.get('content-disposition')).toBe(contentDisposition('Báo cáo.pdf'));

    // The PUT URL stays valid for 10 minutes: replaying it after `complete`
    // (an executable of the same size) must not replace the checked file.
    const swapped = Buffer.concat([EXE, Buffer.alloc(PDF.length - EXE.length)]);
    const replayed = await fetch(upload.url, {
      method: 'PUT',
      headers: upload.headers,
      body: swapped,
    });
    expect(replayed.status).toBe(200);
    const again = await fetch(
      new URL(String((await fx.call('owner', 'GET', `/files/${file.id}`)).headers.location)),
    );
    expect(Buffer.from(await again.arrayBuffer()).equals(PDF)).toBe(true);
  });

  it('deletes an executable renamed .png from Garage (422 BLOCKED_FILE_TYPE)', async () => {
    const { id, upload } = await start('photo.png', 'image/png', EXE.length);
    expect(
      (await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: EXE })).status,
    ).toBe(200);
    const key = `${fx.orgId}/${id}`;
    expect(await storage.head(uploadStagingKey(key))).not.toBeNull();
    const done = await fx.call('owner', 'POST', `/files/uploads/${id}/complete`);
    expectProblem(done, 422, 'VALIDATION_FAILED');
    expect(done.json()).toMatchObject({ errors: [{ code: 'BLOCKED_FILE_TYPE' }] });
    expect(await storage.head(key)).toBeNull();
  });

  it('renders thumbnails into Garage and serves them through the API (T407)', async () => {
    const png = realPng(800, 600);
    const { id, upload } = await start('photo.png', 'image/png', png.length);
    expect(
      (await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: png })).status,
    ).toBe(200);
    const done = await fx.call('owner', 'POST', `/files/uploads/${id}/complete`);
    const file = attachmentSchema.parse(done.json());
    expect(file.thumbnail_url).toBe(`/api/v1/files/${id}/thumbnail`);
    const written = await fx.call(
      'owner',
      'PATCH',
      `/tables/${fx.orders.id}/records?field_key_type=id`,
      { records: [{ id: recordId, fields: { [files.id]: [{ id }] } }] },
    );
    expect(written.statusCode, written.body).toBe(200);
    await renderThumbnail(db, storage, fx.orgId, id);
    expect(await storage.head(`${fx.orgId}/${id}_t256`)).toMatchObject({
      contentType: 'image/webp',
    });
    const thumbnail = await fx.call('owner', 'GET', `/files/${id}/thumbnail`);
    expect(thumbnail.statusCode).toBe(200);
    expect(thumbnail.headers['content-type']).toBe('image/webp');
    expect(thumbnail.rawPayload.subarray(8, 12).toString('ascii')).toBe('WEBP');
  });
});
