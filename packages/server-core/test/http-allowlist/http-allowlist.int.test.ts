import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { orgScope, type Db } from '../../src/db/index.js';
import { httpAllowlistSource, HttpAllowlistRepository } from '../../src/http-allowlist/index.js';
import { resolveOutboundTarget } from '../../src/net/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { seedTenant, type SeededTenant } from '../support/tenant.js';

import type { Id } from '@cellhive/contracts';

const ORG_A = 'org_HttpAllowOrgA001';
const ORG_B = 'org_HttpAllowOrgB001';

/**
 * `meta.http_allowlist` (BACKLOG T600, migration 0042): tenant isolation of
 * the repository and of the SSRF guard's allowlist source, the unique
 * canonical pattern, and the creator cleared when the member leaves.
 */
describe('HTTP allowlist repository (T600)', () => {
  let database: TestDatabase;
  let db: Db;
  let a: SeededTenant;
  let b: SeededTenant;
  const repo = () => new HttpAllowlistRepository(db);

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
        .onConflict((oc) => oc.doNothing())
        .execute();
    }
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('keeps every entry inside its organization (tenant isolation)', async () => {
    const scopeA = orgScope(ORG_A);
    const scopeB = orgScope(ORG_B);
    const entryA = await repo().create(scopeA, {
      id: 'hal_HttpAllowEntryA1',
      pattern: 'n8n.internal:5678',
      host: 'n8n.internal',
      wildcard: false,
      port: 5678,
      note: 'n8n',
      created_by: a.userId,
    });
    await repo().create(scopeB, {
      id: 'hal_HttpAllowEntryB1',
      pattern: '*.corp.example',
      host: 'corp.example',
      wildcard: true,
      port: null,
      created_by: b.userId,
    });

    expect((await repo().list(scopeA)).map((row) => row.id)).toEqual([entryA.id]);
    expect((await repo().list(scopeA))[0]?.created_by_name).toBe(a.userId.replace('usr_', ''));
    expect(await repo().count(scopeA)).toBe(1);
    expect(await repo().findById(scopeB, entryA.id)).toBeUndefined();
    expect(await repo().entries(scopeA)).toEqual([
      { host: 'n8n.internal', wildcard: false, port: 5678 },
    ]);
    // Another organization cannot delete it.
    expect(await repo().delete(scopeB, entryA.id)).toBe(false);
    expect(await repo().findById(scopeA, entryA.id)).toBeDefined();

    // The SSRF guard of org B never sees org A's entry.
    const source = httpAllowlistSource(db);
    const lookup = () => Promise.resolve(['10.0.0.20']);
    const options = (organizationId: Id<'org'>) =>
      ({ organizationId, allowlist: source, privateAllowlist: 'org', lookup }) as const;
    expect((await resolveOutboundTarget('http://n8n.internal:5678/', options(ORG_A))).address).toBe(
      '10.0.0.20',
    );
    await expect(
      resolveOutboundTarget('http://n8n.internal:5678/', options(ORG_B)),
    ).rejects.toMatchObject({ code: 'ssrf_blocked', params: { reason: 'port_not_allowed' } });
  });

  it('refuses the same canonical pattern twice in one organization only', async () => {
    const insert = (orgId: Id<'org'>, id: Id<'hal'>, userId: Id<'usr'>) =>
      repo().create(orgScope(orgId), {
        id,
        pattern: 'hooks.example.com',
        host: 'hooks.example.com',
        wildcard: false,
        port: null,
        created_by: userId,
      });
    await insert(ORG_A, 'hal_HttpAllowDupA001', a.userId);
    await expect(insert(ORG_A, 'hal_HttpAllowDupA002', a.userId)).rejects.toMatchObject({
      code: '23505',
    });
    await expect(insert(ORG_B, 'hal_HttpAllowDupB001', b.userId)).resolves.toBeDefined();
  });

  it('refuses a creator who is not a member of the organization', async () => {
    await expect(
      repo().create(orgScope(ORG_A), {
        id: 'hal_HttpAllowForeign1',
        pattern: 'x.example.com',
        host: 'x.example.com',
        wildcard: false,
        port: null,
        created_by: b.userId,
      }),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('keeps the entry and clears its creator when the member leaves', async () => {
    const entry = await repo().create(orgScope(ORG_B), {
      id: 'hal_HttpAllowLeave01',
      pattern: 'leave.example.com',
      host: 'leave.example.com',
      wildcard: false,
      port: null,
      created_by: b.userId,
    });
    await sql`
      DELETE FROM meta.org_members WHERE organization_id = ${ORG_B} AND user_id = ${b.userId}
    `.execute(db.kysely);
    expect((await repo().findById(orgScope(ORG_B), entry.id))?.created_by).toBeNull();
  });
});
