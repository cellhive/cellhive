import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ApiTokensRepository,
  apiTokenPolicyOf,
  generateApiToken,
  hashApiToken,
  type NewApiToken,
} from '../../src/api-tokens/index.js';
import { findApiTokenByHash, orgScope, type Db } from '../../src/db/index.js';
import { purgeExpiredOperationalRows } from '../../src/jobs/index.js';
import { JobsRepository } from '../../src/jobs/jobs.repository.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { seedTenant, type SeededTenant } from '../support/tenant.js';

import type { Id } from '@cellhive/contracts';

const ORG_A = 'org_ApiTokRepoOrgA01';
const ORG_B = 'org_ApiTokRepoOrgB01';
const DAY = 86_400_000;

/**
 * `meta.api_tokens` (BACKLOG T703, migration 0049): tenant isolation of the
 * repository, the cross-tenant lookup by hash, the table's checks, the
 * cascade when the owner leaves, and the 90-day cleanup.
 */
describe('API tokens repository (T703)', () => {
  let database: TestDatabase;
  let db: Db;
  let a: SeededTenant;
  let b: SeededTenant;
  const repo = () => new ApiTokensRepository(db);
  let counter = 0;

  function newToken(owner: Id<'usr'>, overrides: Partial<NewApiToken> = {}): NewApiToken {
    counter += 1;
    const { prefix, hash } = generateApiToken();
    return {
      id: `tok_ApiTokenRepo${String(counter).padStart(4, '0')}`,
      user_id: owner,
      name: `Token ${String(counter)}`,
      token_prefix: prefix,
      token_hash: hash,
      scopes: ['records:read'],
      base_ids: null,
      expires_at: null,
      ...overrides,
    };
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    a = await seedTenant(db, ORG_A);
    b = await seedTenant(db, ORG_B);
    for (const tenant of [a, b]) {
      await db.kysely
        .insertInto('meta.org_members')
        .values({ organization_id: tenant.orgId, user_id: tenant.userId, role: 'owner' })
        .execute();
    }
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('keeps every token inside its organization (tenant isolation)', async () => {
    const scopeA = orgScope(ORG_A);
    const scopeB = orgScope(ORG_B);
    const tokenA = await repo().create(scopeA, newToken(a.userId));
    const tokenB = await repo().create(scopeB, newToken(b.userId));

    expect(await repo().findById(scopeA, tokenA.id)).toMatchObject({ id: tokenA.id });
    expect(await repo().findById(scopeB, tokenA.id)).toBeUndefined();
    expect(await repo().countNotRevoked(scopeA, a.userId)).toBe(1);
    expect(await repo().countNotRevoked(scopeB, a.userId)).toBe(0);
    expect(await repo().idsOfUser(scopeA, a.userId)).toEqual([tokenA.id]);
    expect(await repo().idsOfUser(scopeB, a.userId)).toEqual([]);
    const listA = await repo().listPage(scopeA, {}, { cursor: null, limit: 50 });
    expect(listA.items.map((row) => row.id)).toEqual([tokenA.id]);
    expect(listA.items[0]?.user_display_name).toBe(a.userId.replace('usr_', ''));
    // Another organization can neither rename nor revoke it.
    expect(await repo().rename(scopeB, tokenA.id, 'Hijacked')).toBeUndefined();
    expect(await repo().revoke(scopeB, tokenA.id, b.userId)).toBeUndefined();
    expect(await repo().findById(scopeA, tokenA.id)).toMatchObject({
      name: tokenA.name,
      revoked_at: null,
    });
    expect(await repo().lockOwner(scopeB, a.userId)).toBe(false);
    expect(await repo().lockOwner(scopeA, a.userId)).toBe(true);
    await repo().revoke(scopeB, tokenB.id, b.userId);
  });

  it('reads what authentication needs and touches last_used_at at most every 5 minutes, inside its organization (T704)', async () => {
    const scopeA = orgScope(ORG_A);
    const scopeB = orgScope(ORG_B);
    const token = await repo().create(
      scopeA,
      newToken(a.userId, {
        scopes: ['records:read', 'schema:read'],
        base_ids: ['bse_ApiTokRepoBase01'],
        expires_at: new Date(Date.now() + DAY),
      }),
    );
    // Tenant isolation: another organization neither reads nor touches it.
    expect(await repo().findForAuthentication(scopeB, token.id)).toBeUndefined();
    expect(await repo().touchLastUsed(scopeB, token.id)).toBe(false);

    const found = await repo().findForAuthentication(scopeA, token.id);
    expect(found).toMatchObject({
      id: token.id,
      scopes: ['records:read', 'schema:read'],
      baseIds: ['bse_ApiTokRepoBase01'],
      revoked: false,
      expired: false,
      lastUsedAt: null,
      isMember: true,
      user: { id: a.userId, status: 'active' },
    });
    expect(found?.orgSettings).toBeDefined();

    expect(await repo().touchLastUsed(scopeA, token.id)).toBe(true);
    expect(await repo().touchLastUsed(scopeA, token.id)).toBe(false);
    const touched = (await repo().findForAuthentication(scopeA, token.id))?.lastUsedAt;
    expect(touched).toBeInstanceOf(Date);
    await sql`
      UPDATE meta.api_tokens SET last_used_at = now() - interval '6 minutes' WHERE id = ${token.id}
    `.execute(db.kysely);
    expect(await repo().touchLastUsed(scopeA, token.id)).toBe(true);

    await sql`
      UPDATE meta.api_tokens SET expires_at = now() - interval '1 second' WHERE id = ${token.id}
    `.execute(db.kysely);
    await repo().revoke(scopeA, token.id, a.userId);
    expect(await repo().findForAuthentication(scopeA, token.id)).toMatchObject({
      revoked: true,
      expired: true,
    });
    // Leave organization A as the next tests expect it.
    await sql`DELETE FROM meta.api_tokens WHERE id = ${token.id}`.execute(db.kysely);
  });

  it('finds the base of a job (imports) inside its organization only (T704)', async () => {
    const jobs = new JobsRepository(db);
    const scopeA = orgScope(ORG_A);
    const job = await jobs.create(scopeA, { type: 'table.import', createdBy: a.userId });
    const loose = await jobs.create(scopeA, { type: 'computed.backfill', createdBy: null });
    await sql`
      INSERT INTO meta.imports
        (id, organization_id, base_id, created_by, filename, format, size, job_id, expires_at)
      VALUES ('imp_ApiTokRepoImp0001', ${ORG_A}, ${a.baseId}, ${a.userId}, 'a.csv', 'csv', 1,
              ${job.id}, now() + interval '1 day')
    `.execute(db.kysely);
    expect(await jobs.baseIdOf(scopeA, job.id)).toBe(a.baseId);
    expect(await jobs.baseIdOf(scopeA, loose.id)).toBeNull();
    // Tenant isolation: organization B does not see it.
    expect(await jobs.baseIdOf(orgScope(ORG_B), job.id)).toBeNull();
  });

  it('finds a token across organizations by its hash only, with its two ids', async () => {
    const generated = generateApiToken();
    const created = await repo().create(
      orgScope(ORG_B),
      newToken(b.userId, { token_prefix: generated.prefix, token_hash: generated.hash }),
    );
    expect(await findApiTokenByHash(db.kysely, hashApiToken(generated.token))).toEqual({
      organization_id: ORG_B,
      id: created.id,
    });
    expect(await findApiTokenByHash(db.kysely, generateApiToken().hash)).toBeUndefined();
    // Revoked tokens are found too: the guard tells revoked from unknown.
    await repo().revoke(orgScope(ORG_B), created.id, b.userId);
    expect(await findApiTokenByHash(db.kysely, generated.hash)).toMatchObject({ id: created.id });
  });

  it('revokes once, filters by status and pages newest first', async () => {
    const scope = orgScope(ORG_A);
    const expired = await repo().create(
      scope,
      newToken(a.userId, { expires_at: new Date(Date.now() - DAY) }),
    );
    const active = await repo().create(
      scope,
      newToken(a.userId, { expires_at: new Date(Date.now() + DAY) }),
    );
    const revoked = await repo().create(scope, newToken(a.userId));
    expect(await repo().revoke(scope, revoked.id, a.userId)).toMatchObject({
      revoked_by: a.userId,
    });
    expect(await repo().revoke(scope, revoked.id, a.userId)).toBeUndefined();

    const ids = async (status: 'active' | 'revoked' | 'expired') =>
      (await repo().listPage(scope, { status }, { cursor: null, limit: 50 })).items.map(
        (row) => row.id,
      );
    expect(await ids('expired')).toEqual([expired.id]);
    expect(await ids('revoked')).toEqual([revoked.id]);
    expect(await ids('active')).toContain(active.id);
    expect(await ids('active')).not.toContain(expired.id);

    const first = await repo().listPage(scope, { userId: a.userId }, { cursor: null, limit: 2 });
    expect(first.items.map((row) => row.id)).toEqual([revoked.id, active.id]);
    expect(first.nextCursor).not.toBeNull();
  });

  it('revokes every unrevoked token of a member in one organization only (T802)', async () => {
    const both = 'usr_ApiTokenBoth0001';
    await db.kysely
      .insertInto('meta.users')
      .values({ id: both, email: 'both@example.test', display_name: 'Both' })
      .execute();
    await db.kysely
      .insertInto('meta.org_members')
      .values([
        { organization_id: ORG_A, user_id: both, role: 'member' },
        { organization_id: ORG_B, user_id: both, role: 'member' },
      ])
      .execute();
    const scopeA = orgScope(ORG_A);
    const scopeB = orgScope(ORG_B);
    const first = await repo().create(scopeA, newToken(both));
    const expired = await repo().create(
      scopeA,
      newToken(both, { expires_at: new Date(Date.now() - DAY) }),
    );
    const earlier = await repo().create(scopeA, newToken(both));
    await sql`
      UPDATE meta.api_tokens SET revoked_at = now() - interval '1 day', revoked_by = ${a.userId}
       WHERE id = ${earlier.id}
    `.execute(db.kysely);
    const earlierAt = (await repo().findById(scopeA, earlier.id))?.revoked_at;
    const otherMember = await repo().create(scopeA, newToken(a.userId));
    const inB = await repo().create(scopeB, newToken(both));

    const revoked = await repo().revokeAllOfUser(scopeA, both, both);
    expect(revoked.map((row) => row.id)).toEqual([first.id, expired.id]);
    expect(revoked.every((row) => row.revoked_by === both)).toBe(true);
    // Tenant isolation: organization B's token and another member's are untouched.
    expect(await repo().findById(scopeB, inB.id)).toMatchObject({ revoked_at: null });
    expect(await repo().findById(scopeA, otherMember.id)).toMatchObject({ revoked_at: null });
    // An earlier revocation keeps its time and author.
    expect(await repo().findById(scopeA, earlier.id)).toMatchObject({
      revoked_at: earlierAt,
      revoked_by: a.userId,
    });
    expect(await repo().revokeAllOfUser(scopeA, both, both)).toEqual([]);
    // Scope B revokes nothing of A.
    expect((await repo().revokeAllOfUser(scopeB, both, both)).map((row) => row.id)).toEqual([
      inB.id,
    ]);
    await sql`DELETE FROM meta.org_members WHERE user_id = ${both}`.execute(db.kysely);
    await sql`DELETE FROM meta.api_tokens WHERE id = ${otherMember.id}`.execute(db.kysely);
  });

  it('refuses unknown scopes, empty scopes, empty base lists and malformed hashes', async () => {
    const scope = orgScope(ORG_A);
    await expect(
      repo().create(scope, newToken(a.userId, { scopes: ['admin:all' as never] })),
    ).rejects.toThrow(/api_tokens_scopes_check/);
    await expect(repo().create(scope, newToken(a.userId, { scopes: [] }))).rejects.toThrow(
      /api_tokens_scopes_check/,
    );
    await expect(repo().create(scope, newToken(a.userId, { base_ids: [] }))).rejects.toThrow(
      /api_tokens_base_ids_check/,
    );
    await expect(
      repo().create(scope, newToken(a.userId, { token_hash: Buffer.alloc(16) })),
    ).rejects.toThrow(/api_tokens_token_hash_check/);
    // A token of a user who is not a member of the organization.
    await expect(repo().create(orgScope(ORG_B), newToken(a.userId))).rejects.toThrow(
      /api_tokens_owner_fkey/,
    );
  });

  it("deletes a member's tokens when they leave and clears revoked_by of a leaving revoker", async () => {
    const scope = orgScope(ORG_A);
    const leaver = 'usr_ApiTokenLeaver01';
    await db.kysely
      .insertInto('meta.users')
      .values({ id: leaver, email: 'leaver@example.test', display_name: 'Leaver' })
      .execute();
    await db.kysely
      .insertInto('meta.org_members')
      .values({ organization_id: ORG_A, user_id: leaver, role: 'admin' })
      .execute();
    const owned = await repo().create(scope, newToken(leaver));
    const revokedByLeaver = await repo().create(scope, newToken(a.userId));
    await repo().revoke(scope, revokedByLeaver.id, leaver);

    await db.kysely
      .deleteFrom('meta.org_members')
      .where('organization_id', '=', ORG_A)
      .where('user_id', '=', leaver)
      .execute();
    expect(await repo().findById(scope, owned.id)).toBeUndefined();
    expect(await repo().findById(scope, revokedByLeaver.id)).toMatchObject({
      revoked_by: null,
      revoked_at: expect.any(Date) as Date,
    });
  });

  it('deletes tokens revoked or expired more than 90 days ago, keeps younger ones', async () => {
    const scope = orgScope(ORG_B);
    const now = new Date();
    const ago = (days: number) => new Date(now.getTime() - days * DAY);
    const revoked91 = await repo().create(scope, newToken(b.userId));
    const revoked89 = await repo().create(scope, newToken(b.userId));
    const expired91 = await repo().create(scope, newToken(b.userId, { expires_at: ago(91) }));
    const expired89 = await repo().create(scope, newToken(b.userId, { expires_at: ago(89) }));
    const active = await repo().create(scope, newToken(b.userId));
    for (const [token, days] of [
      [revoked91, 91],
      [revoked89, 89],
    ] as const) {
      await sql`
        UPDATE meta.api_tokens SET revoked_at = ${ago(days)}, revoked_by = ${b.userId}
         WHERE id = ${token.id}
      `.execute(db.kysely);
    }

    const result = await purgeExpiredOperationalRows(db, { now, batchSize: 1 });
    expect(result.apiTokens).toBeGreaterThanOrEqual(2);
    const left = new Set(
      (await db.kysely.selectFrom('meta.api_tokens').select('id').execute()).map((row) => row.id),
    );
    expect(left.has(revoked91.id)).toBe(false);
    expect(left.has(expired91.id)).toBe(false);
    expect(left.has(revoked89.id)).toBe(true);
    expect(left.has(expired89.id)).toBe(true);
    expect(left.has(active.id)).toBe(true);
  });

  it('reads the organization policy with defaults', () => {
    expect(apiTokenPolicyOf(null)).toEqual({ enabled: true, max_lifetime_days: null });
    expect(apiTokenPolicyOf({ api_tokens: 'nope' })).toEqual({
      enabled: true,
      max_lifetime_days: null,
    });
    expect(apiTokenPolicyOf({ api_tokens: { enabled: false, max_lifetime_days: 30 } })).toEqual({
      enabled: false,
      max_lifetime_days: 30,
    });
  });
});
