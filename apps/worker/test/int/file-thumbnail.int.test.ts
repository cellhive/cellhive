import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AttachmentsRepository,
  attachmentThumbnailKey,
  BasesRepository,
  LocalStorageDriver,
  orgScope,
  SchemaService,
  systemAuditContext,
  type AttachmentRow,
  type Db,
  type FieldRow,
  type StorageDriver,
} from '@cellhive/server-core';
import { sql } from 'kysely';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createFileThumbnailTask,
  FILE_THUMBNAIL_STALE_MS,
} from '../../src/tasks/file-thumbnail.js';
import { pngBomb } from '../unit/png-bomb.js';

import {
  captureLogger,
  createMigratedDatabase,
  createTestDb,
  queuedJobs,
  type TestDatabase,
} from './support.js';

import type { Id } from '@cellhive/contracts';
import type { JobHelpers } from 'graphile-worker';

const ORG_A: Id<'org'> = 'org_ThumbTaskOrgA001';
const ORG_B: Id<'org'> = 'org_ThumbTaskOrgB001';
const SHA = 'c'.repeat(64);

function helpersFor(payload: unknown): JobHelpers {
  return {
    job: {
      id: '1',
      task_identifier: 'file.thumbnail',
      payload,
      priority: 0,
      attempts: 1,
      max_attempts: 3,
      key: null,
      flags: null,
      job_queue_id: null,
    },
    getQueueName: () => Promise.resolve(null),
  } as unknown as JobHelpers;
}

/**
 * `file.thumbnail` (BACKLOG T407): renders the WebP thumbnails of a ready
 * image into storage and marks every row of the object; bombs and garbage
 * are skipped with the attachment still `ready`; at most two renders per
 * organization run at once (ADR-18), without holding other organizations.
 */
describe('file.thumbnail', () => {
  let database: TestDatabase;
  let db: Db;
  let repo: AttachmentsRepository;
  let root: string;
  let storage: LocalStorageDriver;
  const fields = new Map<Id<'org'>, FieldRow>();
  const bases = new Map<Id<'org'>, Id<'bse'>>();

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    repo = new AttachmentsRepository(db);
    root = await mkdtemp(join(tmpdir(), 'cellhive-thumbs-'));
    storage = new LocalStorageDriver({
      root,
      publicUrl: 'https://cellhive.test',
      sessionSecret: 'test-session-secret-0123456789abcdef',
    });
    const schema = new SchemaService(db, { maxFieldsPerTable: 500 });
    for (const org of [ORG_A, ORG_B]) {
      const user: Id<'usr'> = `usr_${org.slice(4)}`;
      const workspace: Id<'wsp'> = `wsp_${org.slice(4)}`;
      await db.withTx(async (tx) => {
        await tx
          .insertInto('meta.organizations')
          .values({ id: org, name: org, slug: org.toLowerCase() })
          .execute();
        await tx
          .insertInto('meta.users')
          .values({ id: user, email: `${org.toLowerCase()}@example.test`, display_name: 'U' })
          .execute();
        await tx
          .insertInto('meta.workspaces')
          .values({ id: workspace, organization_id: org, name: 'W', slug: 'main' })
          .execute();
      });
      const base = await new BasesRepository(db).create(orgScope(org), {
        workspaceId: workspace,
        ownerId: user,
        name: 'B',
      });
      const { table } = await schema.createTable(
        orgScope(org),
        { baseId: base.id, name: 'T', primaryFieldName: 'Name' },
        systemAuditContext(),
      );
      fields.set(
        org,
        await schema.addField(
          orgScope(org),
          table.id,
          { name: 'files', type: 'attachment', options: {} },
          systemAuditContext(),
        ),
      );
      bases.set(org, base.id);
    }
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
    await rm(root, { recursive: true, force: true });
  });

  /** A ready image attachment of `org` whose object holds `bytes`, waiting for its thumbnail. */
  async function image(org: Id<'org'>, bytes: Buffer, mime = 'image/png'): Promise<AttachmentRow> {
    const field = fields.get(org) as FieldRow;
    const row = await repo.create(orgScope(org), {
      baseId: bases.get(org) as Id<'bse'>,
      tableId: field.table_id,
      fieldId: field.id,
      createdBy: `usr_${org.slice(4)}`,
      filename: 'ảnh bí mật.png',
      mime,
      size: bytes.length,
    });
    await storage.put(row.object_key, bytes, { contentType: mime });
    const ready = await repo.markReady(orgScope(org), row.id, {
      size: bytes.length,
      sha256: SHA,
      thumbnailStatus: 'pending',
    });
    return ready as AttachmentRow;
  }

  function task(overrides: Partial<Pick<StorageDriver, 'put'>> = {}) {
    const captured = captureLogger();
    const run = createFileThumbnailTask({
      db,
      storage: {
        getStream: (key) => storage.getStream(key),
        put: overrides.put ?? ((key, body, options) => storage.put(key, body, options)),
        delete: (key) => storage.delete(key),
      },
      logger: captured.logger,
    });
    return {
      captured,
      run: (org: Id<'org'>, id: Id<'att'>) => {
        const payload = { organization_id: org, attachment_id: id };
        return run(payload, helpersFor(payload));
      },
    };
  }

  const photo = () =>
    sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#0ea5e9' } })
      .png()
      .toBuffer();

  it('renders both sizes under {object_key}_t<size> and marks every copy ready', async () => {
    const row = await image(ORG_A, await photo());
    const copy = await repo.copyTo(orgScope(ORG_A), row, {
      recordId: 'rec_ThumbTaskRec00001',
      createdBy: null,
    });
    expect(copy.thumbnail_status).toBe('pending');
    const { run, captured } = task();
    await run(ORG_A, row.id);

    for (const [size, width] of [
      [256, 256],
      [1280, 1280],
    ] as const) {
      const info = await storage.head(attachmentThumbnailKey(row.object_key, size));
      expect(info?.contentType).toBe('image/webp');
      const stream = await storage.getStream(attachmentThumbnailKey(row.object_key, size));
      const chunks: Buffer[] = [];
      for await (const chunk of stream ?? []) chunks.push(chunk as Buffer);
      expect((await sharp(Buffer.concat(chunks)).metadata()).width).toBe(width);
    }
    expect((await repo.getById(orgScope(ORG_A), row.id))?.thumbnail_status).toBe('ready');
    expect((await repo.getById(orgScope(ORG_A), copy.id))?.thumbnail_status).toBe('ready');
    expect(captured.lines.at(-1)).toMatchObject({ msg: 'file.thumbnail rendered' });
    // Ids and counters only: no file name, key or URL.
    expect(captured.raw()).not.toContain('bí mật');
    expect(captured.raw()).not.toContain(row.object_key);

    // A second job for the same file does nothing.
    const again = task();
    await again.run(ORG_A, row.id);
    expect(again.captured.lines.at(-1)).toMatchObject({ state: 'skip' });
  });

  it('skips a decompression bomb and garbage: the attachment stays ready', async () => {
    const bomb = await image(ORG_A, pngBomb(30_000, 30_000));
    const garbage = await image(ORG_A, Buffer.from('\x89PNG\r\n\x1a\n but not really'));
    const { run, captured } = task();
    await run(ORG_A, bomb.id);
    await run(ORG_A, garbage.id);
    for (const row of [bomb, garbage]) {
      const current = await repo.getById(orgScope(ORG_A), row.id);
      expect(current).toMatchObject({ status: 'ready', thumbnail_status: 'skipped' });
      expect(await storage.head(attachmentThumbnailKey(row.object_key, 256))).toBeNull();
    }
    expect(captured.lines.map((line) => line.reason)).toEqual(
      expect.arrayContaining(['too_many_pixels', 'unreadable']),
    );
  });

  it('defers past two renders of the organization, without holding another organization', async () => {
    const busy = [await image(ORG_A, await photo()), await image(ORG_A, await photo())];
    const recent = new Date();
    for (const row of busy) {
      await repo.setThumbnailStatus(orgScope(ORG_A), row.object_key, 'running', {
        startedAt: recent,
      });
    }
    const waiting = await image(ORG_A, await photo());
    const other = await image(ORG_B, await photo());
    const { run } = task();
    await run(ORG_A, waiting.id);
    expect((await repo.getById(orgScope(ORG_A), waiting.id))?.thumbnail_status).toBe('pending');
    const requeued = await queuedJobs(db, 'file.thumbnail');
    expect(requeued.map((job) => job.payload)).toEqual([
      { organization_id: ORG_A, attachment_id: waiting.id },
    ]);
    await run(ORG_B, other.id);
    expect((await repo.getById(orgScope(ORG_B), other.id))?.thumbnail_status).toBe('ready');

    // Renders interrupted long ago (worker crash) do not hold a slot.
    const stale = new Date(Date.now() - FILE_THUMBNAIL_STALE_MS - 1_000);
    for (const row of busy) {
      await repo.setThumbnailStatus(orgScope(ORG_A), row.object_key, 'running', {
        startedAt: stale,
      });
    }
    await run(ORG_A, waiting.id);
    expect((await repo.getById(orgScope(ORG_A), waiting.id))?.thumbnail_status).toBe('ready');
    await sql`DELETE FROM graphile_worker._private_jobs`.execute(db.kysely);
  });

  it('marks a storage failure failed and rethrows for a retry', async () => {
    const row = await image(ORG_B, await photo());
    const failing = task({ put: () => Promise.reject(new Error('storage down')) });
    await expect(failing.run(ORG_B, row.id)).rejects.toThrow('storage down');
    expect((await repo.getById(orgScope(ORG_B), row.id))?.thumbnail_status).toBe('failed');
    // The retry renders it.
    await task().run(ORG_B, row.id);
    expect((await repo.getById(orgScope(ORG_B), row.id))?.thumbnail_status).toBe('ready');
  });

  it('never renders an attachment of another organization than the payload says', async () => {
    const row = await image(ORG_A, await photo());
    const { run, captured } = task();
    await run(ORG_B, row.id);
    expect((await repo.getById(orgScope(ORG_A), row.id))?.thumbnail_status).toBe('pending');
    expect(captured.lines.at(-1)).toMatchObject({ state: 'skip' });
  });
});
