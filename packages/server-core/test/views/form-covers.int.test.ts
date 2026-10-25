import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { systemAuditContext } from '../../src/audit/index.js';
import {
  listExpiredFormCovers,
  orgScope,
  withTxScope,
  type Db,
  type OrgScope,
} from '../../src/db/index.js';
import { SchemaService } from '../../src/schema/index.js';
import {
  formCoverObjectKey,
  FormCoversRepository,
  ViewsRepository,
} from '../../src/views/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { seedTenant, type SeededTenant } from '../support/tenant.js';

import type { Id } from '@cellhive/contracts';

const ORG_A: Id<'org'> = 'org_FormCoverOrgA001';
const ORG_B: Id<'org'> = 'org_FormCoverOrgB001';
const VIEW_A: Id<'viw'> = 'viw_FormCoverViewA01';
const VIEW_B: Id<'viw'> = 'viw_FormCoverViewB01';
const SHA = 'b'.repeat(64);
const LATER = () => new Date(Date.now() + 3_600_000);

interface Tenant extends SeededTenant {
  readonly scope: OrgScope;
  readonly tableId: Id<'tbl'>;
}

/**
 * `FormCoversRepository` (migration 0019, T419): every method is scoped by
 * organization (AGENTS.md rule 5), and the cleanup's cross-tenant lookup
 * keeps exactly the covers a form view names.
 */
describe('FormCoversRepository tenant isolation (T419)', () => {
  let database: TestDatabase;
  let db: Db;
  let repo: FormCoversRepository;
  let a: Tenant;
  let b: Tenant;

  async function tenant(orgId: Id<'org'>, viewId: Id<'viw'>): Promise<Tenant> {
    const seeded = await seedTenant(db, orgId);
    const scope = orgScope(orgId);
    const schema = new SchemaService(db, { maxFieldsPerTable: 500 });
    const { table } = await schema.createTable(
      scope,
      { baseId: seeded.baseId, name: 'Requests', primaryFieldName: 'Name' },
      systemAuditContext(),
    );
    await new ViewsRepository(db).insert(scope, {
      id: viewId,
      tableId: table.id,
      type: 'form',
      name: 'Form',
      config: { form: { cover_attachment_id: null } },
      position: 1,
      ownerId: null,
    });
    return { ...seeded, scope, tableId: table.id };
  }

  const create = (t: Tenant, viewId: Id<'viw'>) =>
    repo.create(t.scope, {
      baseId: t.baseId,
      tableId: t.tableId,
      viewId,
      createdBy: t.userId,
      filename: 'bìa.png',
      mime: 'image/png',
      size: 10,
    });

  const name = (viewId: Id<'viw'>, coverId: string | null) =>
    sql`UPDATE meta.views SET config = jsonb_build_object('form',
          jsonb_build_object('cover_attachment_id', ${coverId}::text))
        WHERE id = ${viewId}`.execute(db.kysely);

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    repo = new FormCoversRepository(db);
    a = await tenant(ORG_A, VIEW_A);
    b = await tenant(ORG_B, VIEW_B);
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('stores covers under {organization_id}/{attachment_id}, pending until complete', async () => {
    const row = await create(a, VIEW_A);
    expect(row).toMatchObject({
      object_key: formCoverObjectKey(ORG_A, row.id),
      status: 'pending_upload',
      view_id: VIEW_A,
      sha256: null,
      created_by: a.userId,
    });
    expect(await repo.markReady(a.scope, row.id, { size: 10, sha256: SHA })).toMatchObject({
      status: 'ready',
      sha256: SHA,
    });
    expect(await repo.markReady(a.scope, row.id, { size: 10, sha256: SHA })).toBeUndefined();
    expect(await repo.deleteByIds(a.scope, [row.id])).toBe(1);
  });

  it('never reads, changes, locks or deletes a cover of another organization', async () => {
    const other = await create(b, VIEW_B);
    expect(await repo.getById(a.scope, other.id)).toBeUndefined();
    expect(await repo.lockShared(a.scope, other.id)).toBeUndefined();
    expect(await repo.markReady(a.scope, other.id, { size: 10, sha256: SHA })).toBeUndefined();
    expect(await repo.lockUnused(a.scope, [other.id], LATER())).toEqual([]);
    expect(await repo.deleteByIds(a.scope, [other.id])).toBe(0);
    expect(await repo.getById(b.scope, other.id)).toMatchObject({ status: 'pending_upload' });
    expect(await repo.deleteByIds(b.scope, [other.id])).toBe(1);
  });

  it('lists and locks only covers no form view of their organization names', async () => {
    const named = await create(a, VIEW_A);
    const unused = await create(a, VIEW_A);
    const foreign = await create(b, VIEW_B);
    await name(VIEW_A, named.id);
    // A view of another organization naming the id does not keep it.
    await name(VIEW_B, unused.id);

    const expired = await listExpiredFormCovers(db.kysely, { createdBefore: LATER(), limit: 50 });
    const ids = expired.map((item) => item.id);
    expect(ids).toContain(unused.id);
    expect(ids).toContain(foreign.id);
    expect(ids).not.toContain(named.id);
    expect(expired.find((item) => item.id === foreign.id)?.organizationId).toBe(ORG_B);
    // Recent uploads are kept.
    expect(
      await listExpiredFormCovers(db.kysely, { createdBefore: new Date(0), limit: 50 }),
    ).toEqual([]);

    const locked = await db.withTx((tx) =>
      repo.lockUnused(withTxScope(a.scope, tx), [named.id, unused.id, foreign.id], LATER()),
    );
    expect(locked.map((row) => row.id)).toEqual([unused.id]);
    await name(VIEW_A, null);
    await name(VIEW_B, null);
    await repo.deleteByIds(a.scope, [named.id, unused.id]);
    await repo.deleteByIds(b.scope, [foreign.id]);
  });
});
