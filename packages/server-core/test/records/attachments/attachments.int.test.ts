import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { systemAuditContext } from '../../../src/audit/index.js';
import {
  listExpiredAttachments,
  orgScope,
  withTxScope,
  type Db,
  type OrgScope,
} from '../../../src/db/index.js';
import {
  attachmentObjectKey,
  AttachmentsRepository,
} from '../../../src/records/attachments/index.js';
import { SchemaService } from '../../../src/schema/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../../support/postgres.js';
import { seedTenant, type SeededTenant } from '../../support/tenant.js';

import type { Id } from '@cellhive/contracts';

const ORG_A: Id<'org'> = 'org_AttachRepoOrgA01';
const ORG_B: Id<'org'> = 'org_AttachRepoOrgB01';
const ATT_A: Id<'att'> = 'att_AttachRepoAttA01';
const ATT_B: Id<'att'> = 'att_AttachRepoAttB01';
const REC: Id<'rec'> = 'rec_AttachRepoRec0001';
const SHA = 'a'.repeat(64);

interface Tenant extends SeededTenant {
  readonly scope: OrgScope;
  readonly tableId: Id<'tbl'>;
  readonly fieldId: Id<'fld'>;
}

/**
 * `AttachmentsRepository` (migration 0012, T406): every method is scoped by
 * organization (AGENTS.md rule 5), plus the cleanup's cross-tenant lookup.
 */
describe('AttachmentsRepository tenant isolation (T406)', () => {
  let database: TestDatabase;
  let db: Db;
  let repo: AttachmentsRepository;
  let a: Tenant;
  let b: Tenant;

  async function tenant(orgId: Id<'org'>): Promise<Tenant> {
    const seeded = await seedTenant(db, orgId);
    const scope = orgScope(orgId);
    const schema = new SchemaService(db, { maxFieldsPerTable: 500 });
    const { table } = await schema.createTable(
      scope,
      { baseId: seeded.baseId, name: 'Files', primaryFieldName: 'Name' },
      systemAuditContext(),
    );
    const field = await schema.addField(
      scope,
      table.id,
      { name: 'Docs', type: 'attachment', options: {} },
      systemAuditContext(),
    );
    return { ...seeded, scope, tableId: table.id, fieldId: field.id };
  }

  const create = (t: Tenant, id: Id<'att'>) =>
    repo.create(t.scope, {
      id,
      baseId: t.baseId,
      tableId: t.tableId,
      fieldId: t.fieldId,
      createdBy: t.userId,
      filename: 'hợp đồng.pdf',
      mime: 'application/pdf',
      size: 10,
    });

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    repo = new AttachmentsRepository(db);
    a = await tenant(ORG_A);
    b = await tenant(ORG_B);
    await create(a, ATT_A);
    await create(b, ATT_B);
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('stores new uploads under {organization_id}/{attachment_id}', async () => {
    const row = await repo.getById(a.scope, ATT_A);
    expect(row).toMatchObject({
      object_key: attachmentObjectKey(ORG_A, ATT_A),
      status: 'pending_upload',
      record_id: null,
      sha256: null,
      created_by: a.userId,
    });
  });

  it('never reads, changes, copies or deletes an attachment of another organization', async () => {
    expect(await repo.getById(a.scope, ATT_B)).toBeUndefined();
    // `send_email` attachments (T532) look files up by id within the organization.
    expect((await repo.getByIds(a.scope, [ATT_A, ATT_B])).map((row) => row.id)).toEqual([ATT_A]);
    expect(await repo.getByIds(b.scope, [ATT_A])).toEqual([]);
    expect(await repo.getByIds(a.scope, [])).toEqual([]);
    expect(await repo.lockByIds(a.scope, [ATT_B])).toEqual([]);
    expect(await repo.markReady(a.scope, ATT_B, { size: 10, sha256: SHA })).toBeUndefined();
    await repo.attach(a.scope, [ATT_B], REC);
    await repo.detach(a.scope, [ATT_B], REC, new Date());
    expect(await repo.countOtherReferences(a.scope, attachmentObjectKey(ORG_B, ATT_B), [])).toBe(0);
    expect(
      await repo.lockExpired(a.scope, [ATT_B], {
        unattachedBefore: new Date(Date.now() + 3_600_000),
        detachedBefore: new Date(Date.now() + 3_600_000),
      }),
    ).toEqual([]);
    expect(await repo.deleteByIds(a.scope, [ATT_B])).toBe(0);
    // Thumbnails (T407): state changes and the running count stay in the organization.
    const keyB = attachmentObjectKey(ORG_B, ATT_B);
    expect(await repo.setThumbnailStatus(a.scope, keyB, 'running')).toBe(0);
    expect(await repo.setThumbnailStatus(b.scope, keyB, 'running')).toBe(1);
    expect(await repo.countRunningThumbnails(a.scope, new Date(0))).toBe(0);
    expect(await repo.countRunningThumbnails(b.scope, new Date(0))).toBe(1);
    expect(await repo.setThumbnailStatus(b.scope, keyB, 'failed', { from: ['pending'] })).toBe(0);
    expect(await repo.setThumbnailStatus(b.scope, keyB, 'failed', { from: ['running'] })).toBe(1);
    expect(await repo.getById(b.scope, ATT_B)).toMatchObject({
      status: 'pending_upload',
      record_id: null,
      detached_at: null,
      thumbnail_status: 'failed',
      thumbnail_started_at: null,
    });
    await repo.setThumbnailStatus(b.scope, keyB, 'failed', { from: [] });
  });

  it('counts form link uploads per session and organization only (T410)', async () => {
    const session = 'a'.repeat(64);
    const formUpload = { shareLinkId: 'shl_FormLinkAAAAAAAAA' as Id<'shl'>, session };
    const upload = (t: Tenant, size: number) =>
      repo.create(t.scope, {
        baseId: t.baseId,
        tableId: t.tableId,
        fieldId: t.fieldId,
        createdBy: null,
        filename: 'ảnh.png',
        mime: 'image/png',
        size,
        formUpload,
      });
    const mine = await upload(a, 100);
    const second = await upload(a, 50);
    const other = await upload(b, 1000);
    expect(mine).toMatchObject({ created_by: null, share_link_id: formUpload.shareLinkId });
    const usage = await repo.formUploadUsage(a.scope, formUpload);
    expect(usage.bytes).toBe(150);
    expect(usage.files.get(a.fieldId)).toBe(2);
    expect(
      (await repo.formUploadUsage(a.scope, { ...formUpload, session: 'b'.repeat(64) })).bytes,
    ).toBe(0);
    expect(await repo.deleteByIds(a.scope, [mine.id, second.id, other.id])).toBe(2);
    expect(await repo.deleteByIds(b.scope, [other.id])).toBe(1);
  });

  it('marks ready once, attaches, detaches and copies with a shared object', async () => {
    const ready = await repo.markReady(a.scope, ATT_A, { size: 10, sha256: SHA });
    expect(ready).toMatchObject({ status: 'ready', sha256: SHA });
    expect(await repo.markReady(a.scope, ATT_A, { size: 10, sha256: SHA })).toBeUndefined();

    await repo.attach(a.scope, [ATT_A], REC);
    expect((await repo.getById(a.scope, ATT_A))?.record_id).toBe(REC);
    const detachedAt = new Date('2026-01-01T00:00:00.000Z');
    await repo.detach(a.scope, [ATT_A], REC, detachedAt);
    expect((await repo.getById(a.scope, ATT_A))?.detached_at).toEqual(detachedAt);

    const source = await repo.getById(a.scope, ATT_A);
    if (source === undefined) throw new Error('missing');
    const copy = await repo.copyTo(a.scope, source, {
      recordId: 'rec_AttachRepoRec0002',
      createdBy: a.userId,
    });
    expect(copy.id).not.toBe(ATT_A);
    expect(copy).toMatchObject({
      object_key: source.object_key,
      status: 'ready',
      sha256: SHA,
      detached_at: null,
      thumbnail_status: null,
    });
    // One state for the shared object: its rows move together (T407).
    expect(await repo.setThumbnailStatus(a.scope, source.object_key, 'ready')).toBe(2);
    expect((await repo.getById(a.scope, copy.id))?.thumbnail_status).toBe('ready');
    expect(await repo.countOtherReferences(a.scope, source.object_key, [ATT_A])).toBe(1);
    expect(await repo.countOtherReferences(a.scope, source.object_key, [ATT_A, copy.id])).toBe(0);
    await repo.deleteByIds(a.scope, [copy.id]);
  });

  it('lists expired rows across tenants for the cleanup only by their rule', async () => {
    const late = new Date(Date.now() + 3_600_000);
    const early = new Date('2000-01-01T00:00:00.000Z');
    // ATT_A was detached on 2026-01-01; ATT_B is an unattached upload.
    expect(
      await listExpiredAttachments(db.kysely, {
        unattachedBefore: early,
        detachedBefore: early,
        limit: 10,
      }),
    ).toEqual([]);
    const both = await listExpiredAttachments(db.kysely, {
      unattachedBefore: late,
      detachedBefore: late,
      limit: 10,
    });
    expect(both.map((item) => item.id).sort()).toEqual([ATT_A, ATT_B].sort());
    expect(both.find((item) => item.id === ATT_B)?.organizationId).toBe(ORG_B);
    expect(
      (
        await listExpiredAttachments(db.kysely, {
          unattachedBefore: late,
          detachedBefore: early,
          limit: 10,
        })
      ).map((item) => item.id),
    ).toEqual([ATT_B]);
  });

  it('lists files of a purged field, and re-checks under the lock', async () => {
    const early = new Date('2000-01-01T00:00:00.000Z');
    await repo.attach(a.scope, [ATT_A], REC);
    const cutoffs = { unattachedBefore: early, detachedBefore: early };
    expect(await listExpiredAttachments(db.kysely, { ...cutoffs, limit: 10 })).toEqual([]);
    await sql`UPDATE meta.fields SET purged_at = now(), deleted_at = now() WHERE id = ${a.fieldId}`.execute(
      db.kysely,
    );
    expect(await listExpiredAttachments(db.kysely, { ...cutoffs, limit: 10 })).toEqual([
      { organizationId: ORG_A, id: ATT_A },
    ]);
    await db.withTx(async (tx) => {
      const locked = await repo.lockExpired(withTxScope(a.scope, tx), [ATT_A], cutoffs);
      expect(locked.map((row) => row.id)).toEqual([ATT_A]);
    });
  });

  it('marks files of purged records in its own organization only (T408, T422)', async () => {
    const own: Id<'att'> = 'att_AttachRepoAttB02';
    await create(b, own);
    await repo.attach(b.scope, [own], REC);
    const at = new Date('2026-02-01T00:00:00.000Z');
    // Another organization naming B's table and record marks nothing.
    expect(await repo.markRecordsPurged(a.scope, b.tableId, [REC], at)).toBe(0);
    expect(await repo.markRecordsPurged(b.scope, a.tableId, [REC], at)).toBe(0);
    expect(await repo.getById(b.scope, own)).toMatchObject({
      record_purged_at: null,
      detached_at: null,
    });
    expect(await repo.markRecordsPurged(b.scope, b.tableId, [REC], at)).toBe(1);
    expect(await repo.getById(b.scope, own)).toMatchObject({
      record_purged_at: at,
      detached_at: at,
    });
    // Once only.
    expect(await repo.markRecordsPurged(b.scope, b.tableId, [REC], at)).toBe(0);
    expect(await repo.deleteByIds(b.scope, [own])).toBe(1);
  });
});
