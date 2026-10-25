import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  GLOBAL_TABLES,
  migrateToLatest,
  OrganizationsRepository,
  UserIdentitiesRepository,
  UsersRepository,
  type Db,
} from '../../src/db/index.js';
import { createTestDatabase, createTestDb, type TestDatabase } from '../support/postgres.js';

const USER_A = 'usr_IdentUserA000001';
const USER_B = 'usr_IdentUserB000001';

/** `meta.<table>` names in a SQL text. */
function metaTablesOf(sqlText: string): string[] {
  return [...sqlText.matchAll(/"meta"\."([a-z_]+)"/g)].map((match) => match[1] ?? '');
}

/**
 * `UserIdentitiesRepository` (BACKLOG T707, SPEC §5.10) and the OIDC
 * additions of `UsersRepository`/`OrganizationsRepository`: global tables
 * only — every statement they send touches nothing but the closed list.
 */
describe('UserIdentitiesRepository (global table, migration 0050)', () => {
  let database: TestDatabase;
  let db: Db;
  const statements: string[] = [];
  let identities: UserIdentitiesRepository;
  let users: UsersRepository;
  let organizations: OrganizationsRepository;

  beforeAll(async () => {
    database = await createTestDatabase();
    const migrator = createTestDb(database.url);
    await migrateToLatest(migrator.kysely);
    await migrator.destroy();
    db = createTestDb(database.url, {
      onQuery: (sqlText) => {
        statements.push(sqlText);
      },
    });
    identities = new UserIdentitiesRepository(db);
    users = new UsersRepository(db);
    organizations = new OrganizationsRepository(db);
    await users.create({
      id: USER_A,
      email: 'a@example.test',
      displayName: 'A',
      passwordHash: null,
    });
    await users.create({
      id: USER_B,
      email: 'b@example.test',
      displayName: 'B',
      passwordHash: 'h',
    });
    await organizations.create({ name: 'Acme', slug: 'acme-identities' });
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('creates, finds by (provider, subject) and records sign-ins', async () => {
    const created = await identities.create({
      userId: USER_A,
      provider: 'keycloak',
      subject: 'sub-1',
      email: 'A@Example.test',
      signedIn: true,
    });
    expect(created).toMatchObject({
      user_id: USER_A,
      provider: 'keycloak',
      subject: 'sub-1',
      email: 'A@Example.test',
    });
    expect(created.id).toMatch(/^idn_/);
    expect(created.last_login_at).toBeInstanceOf(Date);

    const other = await identities.create({
      userId: USER_A,
      provider: 'entra',
      subject: 'sub-1',
      email: null,
    });
    expect(other.last_login_at).toBeNull();

    expect(await identities.findByProviderSubject('keycloak', 'sub-1')).toEqual(created);
    expect(await identities.findByProviderSubject('keycloak', 'SUB-1')).toBeUndefined();
    expect(await identities.findByProviderSubject('entra', 'sub-2')).toBeUndefined();
    expect((await identities.listByUser(USER_A)).map((row) => row.id)).toEqual([
      created.id,
      other.id,
    ]);
    expect(await identities.listByUser(USER_B)).toEqual([]);
    expect(await users.hasExternalIdentity(USER_A)).toBe(true);
    expect(await users.hasExternalIdentity(USER_B)).toBe(false);

    await identities.recordLogin(other.id, 'new@example.test');
    const updated = await identities.findByProviderSubject('entra', 'sub-1');
    expect(updated?.email).toBe('new@example.test');
    expect(updated?.last_login_at).toBeInstanceOf(Date);
    // Without an email from the provider the last one is kept.
    await identities.recordLogin(other.id, null);
    expect((await identities.findByProviderSubject('entra', 'sub-1'))?.email).toBe(
      'new@example.test',
    );
  });

  it('keeps (provider, subject) unique', async () => {
    await expect(
      identities.create({ userId: USER_B, provider: 'keycloak', subject: 'sub-1', email: null }),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('finds, refreshes and deletes an identity only for its own user (T708)', async () => {
    const own = await identities.create({
      userId: USER_B,
      provider: 'gitlab',
      subject: 'sub-b',
      email: 'b@idp.test',
    });
    expect(await identities.findOfUser(USER_B, own.id)).toEqual(own);
    expect(await identities.findOfUser(USER_A, own.id)).toBeUndefined();

    await identities.refreshEmail(own.id, null);
    expect((await identities.findOfUser(USER_B, own.id))?.email).toBe('b@idp.test');
    await identities.refreshEmail(own.id, 'b2@idp.test');
    const refreshed = await identities.findOfUser(USER_B, own.id);
    expect(refreshed?.email).toBe('b2@idp.test');
    expect(refreshed?.last_login_at).toBeNull();

    expect(await identities.deleteOfUser(USER_A, own.id)).toBe(false);
    expect(await identities.findOfUser(USER_B, own.id)).toBeDefined();
    expect(await identities.deleteOfUser(USER_B, own.id)).toBe(true);
    expect(await identities.findOfUser(USER_B, own.id)).toBeUndefined();
  });

  it('locks a user row inside a transaction', async () => {
    const locked = await db.withTx((tx) => users.lockById(USER_A, tx));
    expect(locked?.id).toBe(USER_A);
    expect(await db.withTx((tx) => users.lockById('usr_IdentMissing000001', tx))).toBeUndefined();
  });

  it('finds organizations by slug', async () => {
    expect((await organizations.findBySlug('acme-identities'))?.name).toBe('Acme');
    expect(await organizations.findBySlug('missing')).toBeUndefined();
  });

  it('only ever touches global tables (SPEC §5.10)', () => {
    const touched = new Set(statements.flatMap(metaTablesOf));
    expect(touched.size).toBeGreaterThan(0);
    expect(
      [...touched].filter((table) => !(GLOBAL_TABLES as readonly string[]).includes(table)),
    ).toEqual([]);
    expect(touched.has('user_identities')).toBe(true);
  });
});
