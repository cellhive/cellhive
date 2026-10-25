import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  BasesRepository,
  migrateToLatest,
  orgScope,
  withTxScope,
  type Base,
  type Db,
  type OrgScope,
} from '../../src/db/index.js';
import { createTestDatabase, createTestDb, type TestDatabase } from '../support/postgres.js';

const ORG_A = 'org_BasesOrgA0000001';
const ORG_B = 'org_BasesOrgB0000001';
const USER_A = 'usr_BasesUserA000001';
const USER_B = 'usr_BasesUserB000001';
const WSP_A = 'wsp_BasesWspA0000001';
const WSP_B = 'wsp_BasesWspB0000001';

describe('BasesRepository tenant isolation', () => {
  let database: TestDatabase;
  let db: Db;
  let repo: BasesRepository;
  let scopeA: OrgScope;
  let scopeB: OrgScope;
  let baseA: Base;
  let baseB: Base;

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateToLatest(db.kysely);

    await db.withTx(async (tx) => {
      await tx
        .insertInto('meta.organizations')
        .values([
          { id: ORG_A, name: 'A', slug: 'org-a' },
          { id: ORG_B, name: 'B', slug: 'org-b' },
        ])
        .execute();
      await tx
        .insertInto('meta.users')
        .values([
          { id: USER_A, email: 'a@example.test', display_name: 'A' },
          { id: USER_B, email: 'b@example.test', display_name: 'B' },
        ])
        .execute();
      await tx
        .insertInto('meta.workspaces')
        .values([
          { id: WSP_A, organization_id: ORG_A, name: 'A', slug: 'main' },
          { id: WSP_B, organization_id: ORG_B, name: 'B', slug: 'main' },
        ])
        .execute();
    });

    repo = new BasesRepository(db);
    scopeA = orgScope(ORG_A);
    scopeB = orgScope(ORG_B);
    baseA = await repo.create(scopeA, { workspaceId: WSP_A, ownerId: USER_A, name: 'Sales' });
    baseB = await repo.create(scopeB, {
      workspaceId: WSP_B,
      ownerId: USER_B,
      name: 'Secret',
      settings: { color: 'red' },
    });
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('creates bases with the scope organization and defaults', () => {
    expect(baseA).toMatchObject({
      organization_id: ORG_A,
      workspace_id: WSP_A,
      owner_id: USER_A,
      name: 'Sales',
      icon: null,
      description: null,
      settings: {},
      permission_version: 1n,
      deleted_at: null,
    });
    expect(baseA.id).toMatch(/^bse_[0-9A-Za-z]{16}$/);
    expect(baseB.settings).toEqual({ color: 'red' });
  });

  it('reads a base of its own organization', async () => {
    expect(await repo.getById(scopeA, baseA.id)).toEqual(baseA);
    expect(await repo.listByWorkspace(scopeA, WSP_A)).toEqual([baseA]);
  });

  it('org A cannot read org B’s base', async () => {
    expect(await repo.getById(scopeA, baseB.id)).toBeUndefined();
    expect(await repo.getById(scopeA, baseB.id, { includeDeleted: true })).toBeUndefined();
    expect(await repo.listByWorkspace(scopeA, WSP_B)).toEqual([]);
  });

  it('org A cannot update org B’s base', async () => {
    expect(await repo.update(scopeA, baseB.id, { name: 'Hacked' })).toBeUndefined();
    expect(await repo.getById(scopeB, baseB.id)).toMatchObject({ name: 'Secret' });
  });

  it('updates a base of its own organization', async () => {
    const updated = await repo.update(scopeA, baseA.id, { name: 'Sales 2026', icon: '📈' });
    expect(updated).toMatchObject({ name: 'Sales 2026', icon: '📈', organization_id: ORG_A });
    expect(updated?.updated_at.getTime()).toBeGreaterThanOrEqual(baseA.updated_at.getTime());
  });

  it('cannot create a base in a workspace of another organization', async () => {
    await expect(
      repo.create(scopeA, { workspaceId: WSP_B, ownerId: USER_A, name: 'Cross-tenant' }),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('runs inside the transaction bound to the scope', async () => {
    await expect(
      db.withTx(async (tx) => {
        await repo.create(withTxScope(scopeA, tx), {
          workspaceId: WSP_A,
          ownerId: USER_A,
          name: 'Rolled back',
        });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    const names = (await repo.listByWorkspace(scopeA, WSP_A)).map((base) => base.name);
    expect(names).not.toContain('Rolled back');
  });

  it('hides bases in the trash unless asked', async () => {
    const trashed = await repo.create(scopeA, { workspaceId: WSP_A, ownerId: USER_A, name: 'Old' });
    await db.kysely
      .updateTable('meta.bases')
      .set({ deleted_at: new Date() })
      .where('id', '=', trashed.id)
      .execute();
    expect(await repo.getById(scopeA, trashed.id)).toBeUndefined();
    expect(await repo.getById(scopeA, trashed.id, { includeDeleted: true })).toMatchObject({
      id: trashed.id,
    });
    expect((await repo.listByWorkspace(scopeA, WSP_A)).map((base) => base.id)).not.toContain(
      trashed.id,
    );
    expect(await repo.update(scopeA, trashed.id, { name: 'x' })).toBeUndefined();
  });
});
