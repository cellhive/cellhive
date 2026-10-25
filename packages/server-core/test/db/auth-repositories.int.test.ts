import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  lockUserMemberships,
  migrateToLatest,
  OrganizationsRepository,
  OrgMembersRepository,
  orgScope,
  PasswordResetsRepository,
  SessionsRepository,
  UsersRepository,
  type Db,
} from '../../src/db/index.js';
import { createTestDatabase, createTestDb, type TestDatabase } from '../support/postgres.js';

const ORG_A = 'org_AuthOrgA00000001';
const ORG_B = 'org_AuthOrgB00000001';
const USER_A = 'usr_AuthUserA0000001';
const USER_B = 'usr_AuthUserB0000001';
const USER_AB = 'usr_AuthUserAB000001';

describe('repositories for users, sessions, password resets and memberships', () => {
  let database: TestDatabase;
  let db: Db;
  let users: UsersRepository;
  let sessions: SessionsRepository;
  let resets: PasswordResetsRepository;
  let organizations: OrganizationsRepository;
  let members: OrgMembersRepository;

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateToLatest(db.kysely);
    users = new UsersRepository(db);
    sessions = new SessionsRepository(db);
    resets = new PasswordResetsRepository(db);
    organizations = new OrganizationsRepository(db);
    members = new OrgMembersRepository(db);

    expect(await users.hasAny()).toBe(false);
    await organizations.create({ id: ORG_A, name: 'A', slug: 'a' });
    await organizations.create({ id: ORG_B, name: 'B', slug: 'b', settings: { locale: 'vi' } });
    await users.create({
      id: USER_A,
      email: 'A@Example.test',
      displayName: 'A',
      passwordHash: 'h',
    });
    await users.create({
      id: USER_B,
      email: 'b@example.test',
      displayName: 'B',
      passwordHash: null,
    });
    await users.create({
      id: USER_AB,
      email: 'ab@example.test',
      displayName: 'AB',
      passwordHash: 'h',
    });
    await members.add(orgScope(ORG_A), USER_A, 'owner');
    await members.add(orgScope(ORG_A), USER_AB, 'member');
    await members.add(orgScope(ORG_B), USER_B, 'admin');
    await members.add(orgScope(ORG_B), USER_AB, 'owner');
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  describe('UsersRepository', () => {
    it('finds users by email ignoring case (citext)', async () => {
      expect(await users.hasAny()).toBe(true);
      expect((await users.findByEmail('a@example.TEST'))?.id).toBe(USER_A);
      expect(await users.findByEmail('missing@example.test')).toBeUndefined();
    });

    it('rejects a second user with the same email in another case', async () => {
      await expect(
        users.create({ email: 'a@EXAMPLE.test', displayName: 'dup', passwordHash: null }),
      ).rejects.toThrow(/users_email_key/);
    });

    it('locks and returns the memberships of a user across organizations', async () => {
      const memberships = await db.withTx((tx) => lockUserMemberships(tx, USER_AB));
      expect(memberships).toEqual([
        { organizationId: ORG_A, role: 'member' },
        { organizationId: ORG_B, role: 'owner' },
      ]);
      expect(await db.withTx((tx) => lockUserMemberships(tx, 'usr_Nobody0000000000'))).toEqual([]);
    });

    it('sets the password hash', async () => {
      expect(await users.setPasswordHash(USER_B, 'new-hash')).toBe(true);
      expect((await users.findById(USER_B))?.password_hash).toBe('new-hash');
      expect(await users.setPasswordHash('usr_Missing000000000', 'x')).toBe(false);
      expect(await users.hasExternalIdentity(USER_B)).toBe(false);
    });
  });

  describe('SessionsRepository', () => {
    it('finds only unexpired sessions of active users', async () => {
      const live = await sessions.create({
        userId: USER_A,
        tokenHash: 'hash-live',
        expiresAt: new Date(Date.now() + 60_000),
        ip: '203.0.113.5',
        userAgent: 'x'.repeat(600),
      });
      expect(live.user_agent).toHaveLength(512);
      await sessions.create({
        userId: USER_A,
        tokenHash: 'hash-expired',
        expiresAt: new Date(Date.now() - 1),
        ip: null,
        userAgent: null,
      });
      const found = await sessions.findActiveByTokenHash('hash-live');
      expect(found?.session.id).toBe(live.id);
      expect(found?.user).toMatchObject({ id: USER_A, email: 'A@Example.test', status: 'active' });
      expect(await sessions.findActiveByTokenHash('hash-expired')).toBeUndefined();

      await db.kysely
        .updateTable('meta.users')
        .set({ status: 'disabled' })
        .where('id', '=', USER_A)
        .execute();
      expect(await sessions.findActiveByTokenHash('hash-live')).toBeUndefined();
      await db.kysely
        .updateTable('meta.users')
        .set({ status: 'active' })
        .where('id', '=', USER_A)
        .execute();
    });

    it('touches, deletes one, deletes by user and deletes expired', async () => {
      const session = await sessions.create({
        userId: USER_B,
        tokenHash: 'hash-b',
        expiresAt: new Date(Date.now() + 60_000),
        ip: null,
        userAgent: null,
      });
      const later = new Date(Date.now() + 3_600_000);
      await sessions.touch(session.id, later);
      expect((await sessions.findActiveByTokenHash('hash-b'))?.session.expires_at).toEqual(later);
      expect(await sessions.deleteById(session.id)).toBe(true);
      expect(await sessions.deleteById(session.id)).toBe(false);
      expect(await sessions.deleteExpired(new Date())).toBe(1);
      expect(await sessions.deleteByUserId(USER_A)).toBe(1);
    });
  });

  describe('PasswordResetsRepository', () => {
    it('returns usable resets only, and deletes unused ones', async () => {
      const usable = await db.withTx(async (tx) => {
        const created = await resets.create(
          {
            userId: USER_B,
            tokenHash: 'reset-1',
            source: 'admin',
            createdBy: USER_AB,
            expiresAt: new Date(Date.now() + 60_000),
          },
          tx,
        );
        expect((await resets.findUsableForUpdate('reset-1', tx))?.id).toBe(created.id);
        await resets.markUsed(created.id, tx);
        expect(await resets.findUsableForUpdate('reset-1', tx)).toBeUndefined();
        await resets.create(
          {
            userId: USER_B,
            tokenHash: 'reset-2',
            source: 'self_service',
            createdBy: null,
            expiresAt: new Date(Date.now() - 1),
          },
          tx,
        );
        expect(await resets.findUsableForUpdate('reset-2', tx)).toBeUndefined();
        return created;
      });
      expect(usable).toMatchObject({ created_by: USER_AB, source: 'admin' });
      // Only the unused one goes; the used one stays as a record.
      expect(await resets.deleteUnusedForUser(USER_B)).toBe(1);
      const rows = await db.kysely
        .selectFrom('meta.password_resets')
        .select('token_hash')
        .execute();
      expect(rows).toEqual([{ token_hash: 'reset-1' }]);
    });
  });

  describe('PasswordResetsRepository.deleteUnusedForUser (by source)', () => {
    it('deletes unused links of one source only, keeping admin and CLI links', async () => {
      const expiresAt = new Date(Date.now() + 60_000);
      const link = (tokenHash: string, source: 'self_service' | 'admin' | 'cli') =>
        resets.create({
          userId: USER_A,
          tokenHash,
          source,
          createdBy: source === 'admin' ? USER_B : null,
          expiresAt,
        });
      await link('self-1', 'self_service');
      await link('admin-1', 'admin');
      await link('cli-1', 'cli');
      expect(await resets.deleteUnusedForUser(USER_A, undefined, { source: 'self_service' })).toBe(
        1,
      );
      const hashes = async () =>
        (
          await db.kysely
            .selectFrom('meta.password_resets')
            .select('token_hash')
            .where('user_id', '=', USER_A)
            .execute()
        ).map((row) => row.token_hash);
      expect((await hashes()).sort()).toEqual(['admin-1', 'cli-1']);
      expect(await resets.deleteUnusedForUser(USER_A)).toBe(2);
      expect(await hashes()).toEqual([]);
    });
  });

  describe('OrganizationsRepository', () => {
    it('lists the memberships of a user, oldest first, across organizations', async () => {
      const memberships = await organizations.listMembershipsOfUser(USER_AB);
      expect(memberships.map((m) => [m.organizationId, m.role])).toEqual([
        [ORG_A, 'member'],
        [ORG_B, 'owner'],
      ]);
      expect(memberships[1]?.settings).toEqual({ locale: 'vi' });
      expect(await organizations.listMembershipsOfUser('usr_Nobody0000000000')).toEqual([]);
      expect(await organizations.slugExists('a')).toBe(true);
      expect(await organizations.slugExists('zzz')).toBe(false);
    });
  });

  describe('OrgMembersRepository tenant isolation', () => {
    it('sees members of its own organization only', async () => {
      expect(await members.roleOf(orgScope(ORG_A), USER_A)).toBe('owner');
      // USER_B is a member of B only: invisible from A.
      expect(await members.roleOf(orgScope(ORG_A), USER_B)).toBeUndefined();
      expect(await members.get(orgScope(ORG_B), USER_A)).toBeUndefined();
      // Same user, different role per organization.
      expect(await members.roleOf(orgScope(ORG_A), USER_AB)).toBe('member');
      expect(await members.roleOf(orgScope(ORG_B), USER_AB)).toBe('owner');
      expect((await members.list(orgScope(ORG_A))).map((m) => m.user_id).sort()).toEqual(
        [USER_A, USER_AB].sort(),
      );
      expect((await members.list(orgScope(ORG_B))).every((m) => m.organization_id === ORG_B)).toBe(
        true,
      );
    });

    it('writes into the scope organization only and uses the scope transaction', async () => {
      await expect(
        db.withTx(async (tx) => {
          const scope = orgScope(ORG_B, tx);
          const added = await members.add(scope, USER_A, 'member');
          expect(added.organization_id).toBe(ORG_B);
          expect(await members.roleOf(scope, USER_A)).toBe('member');
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect(await members.roleOf(orgScope(ORG_B), USER_A)).toBeUndefined();
    });

    it('lockRole reads the role in the scope organization only', async () => {
      await db.withTx(async (tx) => {
        expect(await members.lockRole(orgScope(ORG_A, tx), USER_AB)).toBe('member');
        expect(await members.lockRole(orgScope(ORG_B, tx), USER_AB)).toBe('owner');
        expect(await members.lockRole(orgScope(ORG_A, tx), USER_B)).toBeUndefined();
      });
    });

    it('rejects a forged scope', async () => {
      const forged = { organizationId: ORG_A, tx: undefined } as unknown as ReturnType<
        typeof orgScope
      >;
      await expect(members.list(forged)).rejects.toThrow(TypeError);
    });
  });
});
