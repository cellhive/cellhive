import { newId, type Id } from '@cellhive/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  GroupMembersRepository,
  GroupsRepository,
  IdempotencyKeysRepository,
  orgScope,
  type Db,
  type OrgScope,
} from '../../src/db/index.js';
import { purgeExpiredOperationalRows } from '../../src/jobs/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { seedTenant } from '../support/tenant.js';

const ORG_A: Id<'org'> = 'org_IdemOrgA00000001';
const ORG_B: Id<'org'> = 'org_IdemOrgB00000001';

/**
 * `meta.idempotency_keys` (CONTRACTS §1.1) and the hourly maintenance
 * purge; tenant isolation of `IdempotencyKeysRepository` (AGENTS.md rule 5).
 */
describe('IdempotencyKeysRepository', () => {
  let database: TestDatabase;
  let db: Db;
  let keys: IdempotencyKeysRepository;
  let a: OrgScope;
  let b: OrgScope;
  let userA: Id<'usr'>;
  let userB: Id<'usr'>;

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    userA = (await seedTenant(db, ORG_A)).userId;
    userB = (await seedTenant(db, ORG_B)).userId;
    keys = new IdempotencyKeysRepository(db);
    a = orgScope(ORG_A);
    b = orgScope(ORG_B);
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  async function age(key: string, hours: number): Promise<void> {
    await sql`UPDATE meta.idempotency_keys SET created_at = now() - make_interval(hours => ${hours})
               WHERE key = ${key}`.execute(db.kysely);
  }

  it('claims a key once, stores the response and releases only in-progress keys', async () => {
    const ref = { principalKey: userA, key: 'k-claim' };
    const claimId = await keys.claim(a, { ...ref, requestHash: 'h1' });
    expect(claimId).toEqual(expect.any(String));
    expect(await keys.claim(a, { ...ref, requestHash: 'h1' })).toBeUndefined();
    expect(await keys.find(a, ref)).toMatchObject({ request_hash: 'h1', status_code: null });
    const claim = { ...ref, claimId: claimId ?? '' };

    expect(
      await keys.complete(a, { ...claim, statusCode: 201, response: { json: '{"a":1}' } }),
    ).toBe(true);
    // A completed key is never completed again nor released.
    expect(await keys.complete(a, { ...claim, statusCode: 500, response: null })).toBe(false);
    expect(await keys.release(a, claim)).toBe(false);
    expect(await keys.find(a, ref)).toMatchObject({
      status_code: 201,
      response: { json: '{"a":1}' },
    });

    const failing = { principalKey: userA, key: 'k-release' };
    const failingClaim = await keys.claim(a, { ...failing, requestHash: 'h2' });
    expect(await keys.release(a, { ...failing, claimId: 'someone-else' })).toBe(false);
    expect(await keys.release(a, { ...failing, claimId: failingClaim ?? '' })).toBe(true);
    expect(await keys.find(a, failing)).toBeUndefined();
    expect(await keys.claim(a, { ...failing, requestHash: 'h3' })).toEqual(expect.any(String));
  });

  it('a taken-over claim can neither complete nor release the new claim', async () => {
    const ref = { principalKey: userA, key: 'k-race' };
    const first = await keys.claim(a, { ...ref, requestHash: 'first' });
    await sql`UPDATE meta.idempotency_keys SET created_at = now() - interval '61 seconds'
               WHERE key = 'k-race'`.execute(db.kysely);
    const second = await keys.claim(a, { ...ref, requestHash: 'second' });
    expect(second).toEqual(expect.any(String));
    expect(second).not.toBe(first);

    // The abandoned first request finishes late: nothing it does sticks.
    const late = { ...ref, claimId: first ?? '' };
    expect(await keys.complete(a, { ...late, statusCode: 201, response: { json: '"late"' } })).toBe(
      false,
    );
    expect(await keys.release(a, late)).toBe(false);
    expect(await keys.find(a, ref)).toMatchObject({
      request_hash: 'second',
      claim_id: second,
      status_code: null,
      response: null,
    });

    // The new claim completes normally.
    const current = { ...ref, claimId: second ?? '' };
    expect(
      await keys.complete(a, { ...current, statusCode: 200, response: { json: '"second"' } }),
    ).toBe(true);
    expect(await keys.find(a, ref)).toMatchObject({
      status_code: 200,
      response: { json: '"second"' },
    });
  });

  it('keys are per principal', async () => {
    expect(
      await keys.claim(a, { principalKey: userA, key: 'shared', requestHash: 'x' }),
    ).toBeDefined();
    expect(
      await keys.claim(a, { principalKey: newId('usr'), key: 'shared', requestHash: 'y' }),
    ).toBeDefined();
  });

  it('ignores and replaces keys older than 24 hours', async () => {
    const ref = { principalKey: userA, key: 'k-expired' };
    const claimId = (await keys.claim(a, { ...ref, requestHash: 'old' })) ?? '';
    await keys.complete(a, { ...ref, claimId, statusCode: 200, response: { json: null } });
    await age('k-expired', 25);
    expect(await keys.find(a, ref)).toBeUndefined();
    expect(await keys.claim(a, { ...ref, requestHash: 'new' })).toBeDefined();
    expect(await keys.find(a, ref)).toMatchObject({ request_hash: 'new', status_code: null });
  });

  it('takes over a key left in progress for more than 60 seconds', async () => {
    const ref = { principalKey: userA, key: 'k-abandoned' };
    expect(await keys.claim(a, { ...ref, requestHash: 'first' })).toBeDefined();
    await sql`UPDATE meta.idempotency_keys SET created_at = now() - interval '59 seconds'
               WHERE key = 'k-abandoned'`.execute(db.kysely);
    expect(await keys.claim(a, { ...ref, requestHash: 'second' })).toBeUndefined();
    await sql`UPDATE meta.idempotency_keys SET created_at = now() - interval '61 seconds'
               WHERE key = 'k-abandoned'`.execute(db.kysely);
    const claimId = (await keys.claim(a, { ...ref, requestHash: 'second' })) ?? '';
    expect(claimId).not.toBe('');
    expect(await keys.find(a, ref)).toMatchObject({ request_hash: 'second', status_code: null });

    // A completed key is never taken over, however old its last update.
    await keys.complete(a, { ...ref, claimId, statusCode: 201, response: { json: null } });
    await sql`UPDATE meta.idempotency_keys SET created_at = now() - interval '1 hour'
               WHERE key = 'k-abandoned'`.execute(db.kysely);
    expect(await keys.claim(a, { ...ref, requestHash: 'third' })).toBeUndefined();
  });

  it('never reads, completes, releases or replaces a key of another organization', async () => {
    const ref = { principalKey: userB, key: 'k-tenant' };
    const claimId = (await keys.claim(b, { ...ref, requestHash: 'b' })) ?? '';
    expect(claimId).not.toBe('');

    expect(await keys.find(a, ref)).toBeUndefined();
    expect(await keys.claim(a, { ...ref, requestHash: 'a' })).toBeUndefined();
    // Even with the right claim id, another organization's scope matches nothing.
    expect(await keys.complete(a, { ...ref, claimId, statusCode: 200, response: null })).toBe(
      false,
    );
    expect(await keys.release(a, { ...ref, claimId })).toBe(false);
    // Even once expired, organization A cannot take over B's row.
    await age('k-tenant', 30);
    expect(await keys.claim(a, { ...ref, requestHash: 'a' })).toBeUndefined();

    const row = await db.kysely
      .selectFrom('meta.idempotency_keys')
      .selectAll()
      .where('key', '=', 'k-tenant')
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ organization_id: ORG_B, request_hash: 'b', status_code: null });
  });

  it('purges keys older than 24 hours and jobs finished more than 30 days ago', async () => {
    const fresh = { principalKey: userA, key: 'k-fresh' };
    await keys.claim(a, { ...fresh, requestHash: 'f' });
    const stale = { principalKey: userA, key: 'k-stale' };
    await keys.claim(a, { ...stale, requestHash: 's' });
    await age('k-stale', 48);

    const jobs = {
      oldDone: newId('job'),
      oldFailed: newId('job'),
      recentDone: newId('job'),
      oldRunning: newId('job'),
    };
    const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);
    await db.kysely
      .insertInto('meta.jobs')
      .values([
        {
          id: jobs.oldDone,
          organization_id: ORG_A,
          type: 't',
          status: 'succeeded',
          finished_at: daysAgo(31),
        },
        {
          id: jobs.oldFailed,
          organization_id: ORG_B,
          type: 't',
          status: 'failed',
          finished_at: daysAgo(40),
        },
        {
          id: jobs.recentDone,
          organization_id: ORG_A,
          type: 't',
          status: 'succeeded',
          finished_at: daysAgo(29),
        },
        { id: jobs.oldRunning, organization_id: ORG_A, type: 't', status: 'running' },
      ])
      .execute();

    const result = await purgeExpiredOperationalRows(db, { now: new Date(), batchSize: 1 });
    expect(result.jobs).toBe(2);
    expect(result.idempotencyKeys).toBeGreaterThanOrEqual(2); // k-stale and k-tenant

    const remainingKeys = (
      await db.kysely.selectFrom('meta.idempotency_keys').select('key').execute()
    ).map((row) => row.key);
    expect(remainingKeys).toContain('k-fresh');
    expect(remainingKeys).not.toContain('k-stale');
    expect(remainingKeys).not.toContain('k-tenant');
    const remainingJobs = (await db.kysely.selectFrom('meta.jobs').select('id').execute()).map(
      (row) => row.id,
    );
    expect(remainingJobs.sort()).toEqual([jobs.recentDone, jobs.oldRunning].sort());
  });
});

describe('GroupMembersRepository.userIdsOfGroups', () => {
  let database: TestDatabase;
  let db: Db;

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('lists distinct members of the given groups of the organization only', async () => {
    const orgA: Id<'org'> = 'org_GrpOrgA000000001';
    const orgB: Id<'org'> = 'org_GrpOrgB000000001';
    const tenantA = await seedTenant(db, orgA);
    const tenantB = await seedTenant(db, orgB);
    const scopeA = orgScope(orgA);
    const scopeB = orgScope(orgB);
    const groups = new GroupsRepository(db);
    const members = new GroupMembersRepository(db);
    const g1 = await groups.create(scopeA, { name: 'One' });
    const g2 = await groups.create(scopeA, { name: 'Two' });
    const gB = await groups.create(scopeB, { name: 'B' });
    const other: Id<'usr'> = newId('usr');
    await db.kysely
      .insertInto('meta.users')
      .values({ id: other, email: 'other@example.test', display_name: 'Other' })
      .execute();
    await db.kysely
      .insertInto('meta.org_members')
      .values([
        { organization_id: orgA, user_id: tenantA.userId, role: 'member' },
        { organization_id: orgA, user_id: other, role: 'member' },
        { organization_id: orgB, user_id: tenantB.userId, role: 'member' },
      ])
      .execute();
    await members.add(scopeA, g1.id, tenantA.userId);
    await members.add(scopeA, g2.id, tenantA.userId);
    await members.add(scopeA, g2.id, other);
    await members.add(scopeB, gB.id, tenantB.userId);

    expect(await members.userIdsOfGroups(scopeA, [])).toEqual([]);
    expect(await members.userIdsOfGroups(scopeA, [g1.id])).toEqual([tenantA.userId]);
    // Distinct ids; the order follows the database collation, so compare as sets.
    const both = await members.userIdsOfGroups(scopeA, [g1.id, g2.id]);
    expect([...both].sort()).toEqual([tenantA.userId, other].sort());
    // Organization B's group is invisible through A's scope.
    expect(await members.userIdsOfGroups(scopeA, [gB.id])).toEqual([]);
  });
});
