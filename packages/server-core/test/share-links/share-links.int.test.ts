import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  findShareLinkOrganization,
  orgScope,
  withTxScope,
  type Db,
  type OrgScope,
} from '../../src/db/index.js';
import {
  generateShareToken,
  hashShareToken,
  isShareTokenFormat,
  ShareLinksRepository,
  type InsertShareLinkInput,
} from '../../src/share-links/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { seedTenant, type SeededTenant } from '../support/tenant.js';

import type { Id } from '@cellhive/contracts';

const ORG_A = 'org_ShareRepoOrgA001';
const ORG_B = 'org_ShareRepoOrgB001';
const SHL_A = 'shl_ShareRepoLinkA01';
const SHL_B = 'shl_ShareRepoLinkB01';
const TBL_A = 'tbl_ShareRepoTblA001';
const TBL_B = 'tbl_ShareRepoTblB001';

function linkInput(
  tenant: SeededTenant,
  id: Id<'shl'>,
  tableId: Id<'tbl'>,
  targetId: string,
  tokenHash: string,
): InsertShareLinkInput {
  return {
    id,
    baseId: tenant.baseId,
    tableId,
    targetType: 'view',
    targetId,
    audience: 'public',
    tokenPrefix: 'abcdef',
    tokenHash,
    passwordHash: null,
    expiresAt: null,
    settings: {},
    enabled: true,
    createdBy: tenant.userId,
  };
}

describe('share tokens', () => {
  it('are 32 random bytes in base64url, stored as a SHA-256 and a 6-character prefix', () => {
    const first = generateShareToken();
    const second = generateShareToken();
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(first.token, 'base64url')).toHaveLength(32);
    expect(first.token).not.toBe(second.token);
    expect(first.hash).toBe(hashShareToken(first.token));
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.prefix).toBe(first.token.slice(0, 6));
    expect(isShareTokenFormat(first.token)).toBe(true);
    expect(isShareTokenFormat(`${first.token}x`)).toBe(false);
    expect(isShareTokenFormat(`${first.token.slice(0, 42)}!`)).toBe(false);
  });
});

describe('ShareLinksRepository tenant isolation (T304)', () => {
  let database: TestDatabase;
  let db: Db;
  let links: ShareLinksRepository;
  let a: SeededTenant;
  let b: SeededTenant;
  let scopeA: OrgScope;
  let scopeB: OrgScope;

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    a = await seedTenant(db, ORG_A);
    b = await seedTenant(db, ORG_B);
    scopeA = orgScope(ORG_A);
    scopeB = orgScope(ORG_B);
    links = new ShareLinksRepository(db);
    await links.insert(scopeA, linkInput(a, SHL_A, TBL_A, 'viw_ShareRepoViwA001', 'hash-a'));
    await links.insert(scopeB, linkInput(b, SHL_B, TBL_B, 'viw_ShareRepoViwB001', 'hash-b'));
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('finds the organization of a token hash, and only its id', async () => {
    expect(await findShareLinkOrganization(db.kysely, 'hash-a')).toBe(ORG_A);
    expect(await findShareLinkOrganization(db.kysely, 'hash-b')).toBe(ORG_B);
    expect(await findShareLinkOrganization(db.kysely, 'nope')).toBeUndefined();
  });

  it('reads only rows of the scope organization', async () => {
    expect(await links.getById(scopeA, SHL_A)).toMatchObject({ id: SHL_A, organization_id: ORG_A });
    expect(await links.getById(scopeB, SHL_A)).toBeUndefined();
    expect(await links.getLive(scopeB, SHL_A)).toBeUndefined();
    expect(await links.findByTokenHash(scopeB, 'hash-a')).toBeUndefined();
    expect(await links.findByTokenHash(scopeA, 'hash-a')).toMatchObject({ id: SHL_A });
    expect(await links.listLiveForTarget(scopeB, 'view', 'viw_ShareRepoViwA001')).toEqual([]);
    expect(await links.liveIdsForTarget(scopeB, 'view', 'viw_ShareRepoViwA001')).toEqual([]);
    expect(await links.listPage(scopeB, { baseId: a.baseId }, { offset: 0, limit: 50 })).toEqual({
      items: [],
      total: 0,
    });
    const pageA = await links.listPage(scopeA, {}, { offset: 0, limit: 50 });
    expect(pageA.total).toBe(1);
    expect(pageA.items.map((row) => row.id)).toEqual([SHL_A]);
    expect(pageA.items[0]).toMatchObject({ creator_name: a.userId.slice(4), target_name: null });
  });

  it('never changes rows of another organization', async () => {
    expect(await links.update(scopeB, SHL_A, { enabled: false })).toBeUndefined();
    await db.withTx(async (tx) => {
      expect(await links.lockLive(withTxScope(scopeB, tx), SHL_A)).toBeUndefined();
      expect(await links.revoke(withTxScope(scopeB, tx), [SHL_A], b.userId)).toEqual([]);
    });
    await links.recordAccess(scopeB, SHL_A, { count: 3, at: new Date() });
    expect(await links.getById(scopeA, SHL_A)).toMatchObject({
      enabled: true,
      revoked_at: null,
      access_count: 0n,
      last_accessed_at: null,
    });
    expect(await links.dailyStats(scopeB, SHL_A, '2000-01-01')).toEqual([]);
  });

  it('counts accesses per link and UTC day', async () => {
    const at = new Date('2026-09-24T23:30:00.000Z');
    await links.recordAccess(scopeA, SHL_A, { count: 2, at });
    await links.recordAccess(scopeA, SHL_A, { count: 3, at: new Date('2026-09-24T10:00:00.000Z') });
    await links.recordAccess(scopeA, SHL_A, { count: 1, at: new Date('2026-09-25T00:10:00.000Z') });
    expect(await links.getById(scopeA, SHL_A)).toMatchObject({
      access_count: 6n,
      last_accessed_at: new Date('2026-09-25T00:10:00.000Z'),
    });
    expect(await links.dailyStats(scopeA, SHL_A, '2026-09-01')).toEqual([
      { day: '2026-09-24', access_count: 5n },
      { day: '2026-09-25', access_count: 1n },
    ]);
    // `count = 0` (T305: a request that is not a page open) only moves `last_accessed_at`.
    await links.recordAccess(scopeA, SHL_A, { count: 0, at: new Date('2026-09-25T08:00:00.000Z') });
    expect(await links.getById(scopeA, SHL_A)).toMatchObject({
      access_count: 6n,
      last_accessed_at: new Date('2026-09-25T08:00:00.000Z'),
    });
    expect(await links.dailyStats(scopeA, SHL_A, '2026-09-25')).toEqual([
      { day: '2026-09-25', access_count: 1n },
    ]);
  });

  it('keeps at most one link per target that is not revoked, and revoked links for good', async () => {
    await expect(
      links.insert(
        scopeA,
        linkInput(a, 'shl_ShareRepoLinkA02', TBL_A, 'viw_ShareRepoViwA001', 'h2'),
      ),
    ).rejects.toMatchObject({ code: '23505' });
    const revoked = await db.withTx((tx) =>
      links.revoke(withTxScope(scopeA, tx), [SHL_A], a.userId),
    );
    expect(revoked.map((row) => row.id)).toEqual([SHL_A]);
    expect(await links.getLive(scopeA, SHL_A)).toBeUndefined();
    expect(await links.update(scopeA, SHL_A, { enabled: false })).toBeUndefined();
    expect(await links.getById(scopeA, SHL_A)).toMatchObject({ revoked_by: a.userId });
    await links.insert(
      scopeA,
      linkInput(a, 'shl_ShareRepoLinkA02', TBL_A, 'viw_ShareRepoViwA001', 'h2'),
    );
    expect(await links.liveIdsForTarget(scopeA, 'view', 'viw_ShareRepoViwA001')).toEqual([
      'shl_ShareRepoLinkA02',
    ]);
    await expect(
      sql`UPDATE meta.share_links SET revoked_at = now() WHERE id = 'shl_ShareRepoLinkA02'`.execute(
        db.kysely,
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
