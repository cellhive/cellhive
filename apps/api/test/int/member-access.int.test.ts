import {
  API_TOKEN_SCOPES,
  basePrincipalListSchema,
  baseDetailSchema,
  createdApiTokenSchema,
  memberAccessSchema,
  roleListSchema,
  type BasePrincipalDto,
  type Id,
  type MemberAccessDto,
  type RoleDto,
} from '@cellhive/contracts';
import {
  GroupsRepository,
  OrgMembersRepository,
  orgScope,
  RecordQueryService,
  type Db,
} from '@cellhive/server-core';
import { AppError } from '@cellhive/server-core/errors';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AccessService, type BaseAccess } from '../../src/common/access/access.service.js';
import { MemberAccessRepository } from '../../src/modules/role/member-access.repository.js';
import { MemberAccessService } from '../../src/modules/role/member-access.service.js';

import { seedOrg, seedUser, type SeededUser } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { buildRecordFixture, expectProblem, type RecordFixture } from './record-fixture.js';
import { problemOf, startTestApp, type TestApp } from './support.js';

const DAY = 86_400_000;

/**
 * BACKLOG T711 (CONTRACTS §5 P61, §5A, §14): a member's effective access with
 * its source and record counts, and the principals of the role picker, at
 * the service level and over HTTP, on the CONTRACTS §5 fixture (r1 owned by
 * u_sales1, r2 by u_sales2).
 */
describe('member access and base principals (T711)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let roles: RoleDto[];
  let groupId: Id<'grp'>;
  let leaver: SeededUser;
  let disabled: SeededUser;

  const roleId = (kind: string, name?: string): Id<'rol'> => {
    const role = roles.find(
      (item) => item.kind === kind && (name === undefined || item.name === name),
    );
    if (role === undefined) throw new Error(`no role ${kind}`);
    return role.id;
  };

  async function memberAccess(
    target: string,
    query = '?counts=true',
    as: Parameters<RecordFixture['call']>[0] = 'u_admin',
  ) {
    return fx.call(as, 'GET', `/bases/${fx.baseId}/members/${target}/access${query}`);
  }

  async function okAccess(target: Id<'usr'>, query = '?counts=true'): Promise<MemberAccessDto> {
    const response = await memberAccess(target, query);
    expect(response.statusCode, response.body).toBe(200);
    return memberAccessSchema.parse(response.json());
  }

  /** `access` of `GET /bases/:id` as the member themselves. */
  async function ownAccess(user: Parameters<RecordFixture['call']>[0]) {
    const response = await fx.call(user, 'GET', `/bases/${fx.baseId}`);
    expect(response.statusCode, response.body).toBe(200);
    return baseDetailSchema.parse(response.json()).access;
  }

  async function createOrder(title: string, owner: Id<'usr'>): Promise<void> {
    const response = await fx.call(
      'u_admin',
      'POST',
      `/tables/${fx.orders.id}/records?field_key_type=id`,
      {
        records: [
          {
            fields: {
              [fx.fld.title?.id as string]: title,
              [fx.fld.owner?.id as string]: [{ id: owner }],
            },
          },
        ],
      },
    );
    expect(response.statusCode, response.body).toBe(201);
  }

  async function allPrincipals(query = '', limit = 3): Promise<BasePrincipalDto[]> {
    const items: BasePrincipalDto[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 50; page += 1) {
      const params = new URLSearchParams(query);
      params.set('limit', String(limit));
      if (cursor !== null) params.set('cursor', cursor);
      const response = await fx.call(
        'u_admin',
        'GET',
        `/bases/${fx.baseId}/principals?${params.toString()}`,
      );
      expect(response.statusCode, response.body).toBe(200);
      const list = basePrincipalListSchema.parse(response.json());
      expect(list.items.length).toBeLessThanOrEqual(limit);
      items.push(...list.items);
      cursor = list.next_cursor;
      if (cursor === null) return items;
    }
    throw new Error('too many pages');
  }

  async function adminBase(): Promise<BaseAccess> {
    const base = await t.app
      .get(AccessService)
      .findBaseForUser(fx.orgId, fx.users.u_admin.id, fx.baseId);
    if (base === undefined) throw new Error('u_admin cannot open the base');
    return base;
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    fx = await buildRecordFixture(t, db);
    roles = roleListSchema.parse(
      (await fx.call('u_admin', 'GET', `/bases/${fx.baseId}/roles`)).json(),
    ).items;
    const group = await new GroupsRepository(db).findByName(orgScope(fx.orgId), 'g_sales');
    if (group === undefined) throw new Error('no g_sales');
    groupId = group.id;
    await createOrder('r1', fx.users.u_sales1.id);
    await createOrder('r2', fx.users.u_sales2.id);
    // A member who left the organization, and a disabled one.
    leaver = await seedUser(db, {
      memberships: [{ orgId: fx.orgId, role: 'member' }],
      displayName: 'Leaver',
    });
    await new OrgMembersRepository(db).remove(orgScope(fx.orgId), leaver.id);
    disabled = await seedUser(db, {
      memberships: [{ orgId: fx.orgId, role: 'member' }],
      displayName: 'Disabled',
    });
    await sql`UPDATE meta.users SET status = 'disabled' WHERE id = ${disabled.id}`.execute(
      db.kysely,
    );
  });

  afterAll(async () => {
    await t.close();
    await db.destroy();
    await database.drop();
  });

  describe('GET /bases/:id/members/:userId/access', () => {
    it('P61 u_admin views u_sales1: Sales through g_sales, Orders read 1 edit 1', async () => {
      const body = await okAccess(fx.users.u_sales1.id);
      expect(body.user).toEqual({ id: fx.users.u_sales1.id, display_name: 'User sales1' });
      expect(body.source).toEqual({
        kind: 'group_roles',
        role_ids: [roleId('custom', 'Sales')],
        group_ids: [groupId],
      });
      expect(body.access).toEqual(await ownAccess('u_sales1'));
      expect(body.access?.role?.name).toBe('Sales');
      // Only the tables u_sales1 sees are counted.
      expect(body.counts).toEqual({ [fx.orders.id]: { readable: 1, editable: 1 } });
    });

    it('counts are null unless asked for', async () => {
      expect((await okAccess(fx.users.u_sales1.id, '')).counts).toBeNull();
      expect((await okAccess(fx.users.u_sales1.id, '?counts=false')).counts).toBeNull();
      const invalid = await memberAccess(fx.users.u_sales1.id, '?counts=maybe');
      expectProblem(invalid, 422, 'VALIDATION_FAILED');
    });

    it('P25 a direct reader role wins: direct_role, reads r1 and r2, edits none', async () => {
      const assign = await fx.call('u_admin', 'PUT', `/bases/${fx.baseId}/role-assignments`, {
        principal_type: 'user',
        principal_id: fx.users.u_sales1.id,
        role_id: roleId('system_reader'),
      });
      expect(assign.statusCode, assign.body).toBe(200);
      try {
        const body = await okAccess(fx.users.u_sales1.id);
        expect(body.source).toEqual({
          kind: 'direct_role',
          role_ids: [roleId('system_reader')],
          group_ids: [],
        });
        expect(body.access).toEqual(await ownAccess('u_sales1'));
        expect(body.counts?.[fx.orders.id]).toEqual({ readable: 2, editable: 0 });
      } finally {
        const removed = await fx.call('u_admin', 'DELETE', `/bases/${fx.baseId}/role-assignments`, {
          principal_type: 'user',
          principal_id: fx.users.u_sales1.id,
        });
        expect(removed.statusCode, removed.body).toBe(204);
      }
    });

    it('sources of the other fixture users', async () => {
      const admin = await okAccess(fx.users.u_admin.id);
      expect(admin.source).toEqual({
        kind: 'direct_role',
        role_ids: [roleId('system_admin')],
        group_ids: [],
      });
      expect(admin.access).toEqual(await ownAccess('u_admin'));
      expect(admin.counts?.[fx.orders.id]).toEqual({ readable: 2, editable: 2 });
      expect(Object.keys(admin.counts ?? {}).sort()).toEqual(
        [fx.orders.id, fx.customers.id, fx.tickets.id].sort(),
      );

      const owner = await okAccess(fx.users.owner.id, '');
      expect(owner.source).toEqual({ kind: 'org_admin', role_ids: [], group_ids: [] });
      expect(owner.access).toEqual(await ownAccess('owner'));

      const editor = await okAccess(fx.users.u_editor.id);
      expect(editor.source.kind).toBe('direct_role');
      expect(editor.counts?.[fx.orders.id]).toEqual({ readable: 2, editable: 2 });
    });

    it('u_out (member without a role): source none, no access, no counts', async () => {
      const body = await okAccess(fx.users.u_out.id);
      expect(body).toEqual({
        user: { id: fx.users.u_out.id, display_name: 'User out' },
        access: null,
        source: { kind: 'none', role_ids: [], group_ids: [] },
        counts: null,
      });
      expectProblem(await fx.call('u_out', 'GET', `/bases/${fx.baseId}`), 404, 'NOT_FOUND');
    });

    it('a count that times out is null for that table only', async () => {
      const records = t.app.get(RecordQueryService);
      const original = records.countEditable.bind(records);
      const spy = vi
        .spyOn(records, 'countEditable')
        .mockImplementation(async (scope, tableId, ...rest) => {
          if (tableId === fx.orders.id) throw new AppError('QUERY_TIMEOUT');
          return original(scope, tableId, ...rest);
        });
      try {
        const body = await okAccess(fx.users.u_admin.id);
        expect(body.counts?.[fx.orders.id]).toBeNull();
        expect(body.counts?.[fx.customers.id]).toEqual({ readable: 0, editable: 0 });
      } finally {
        spy.mockRestore();
      }
    });

    it('u_editor (reads the base, not admin) → 403', async () => {
      expectProblem(
        await memberAccess(fx.users.u_sales1.id, '?counts=true', 'u_editor'),
        403,
        'PERMISSION_DENIED',
      );
      expectProblem(
        await memberAccess(fx.users.u_sales1.id, '', 'u_sales1'),
        403,
        'PERMISSION_DENIED',
      );
    });

    it('u_out and a user of another organization → 404', async () => {
      expectProblem(await memberAccess(fx.users.u_sales1.id, '', 'u_out'), 404, 'NOT_FOUND');
      expectProblem(await memberAccess(fx.users.u_sales1.id, '', 'stranger'), 404, 'NOT_FOUND');
    });

    it('a target who is not an active member of the organization → 404', async () => {
      for (const target of [
        fx.users.stranger.id,
        leaver.id,
        disabled.id,
        'usr_0000000000000000',
        'nope',
      ]) {
        expectProblem(await memberAccess(target, '?counts=true'), 404, 'NOT_FOUND');
      }
    });

    it('API tokens get 403 INSUFFICIENT_SCOPE (session only)', async () => {
      const created = await fx.call('u_admin', 'POST', `/orgs/${fx.orgId}/me/api-tokens`, {
        name: 'admin all',
        scopes: [...API_TOKEN_SCOPES],
        expires_at: new Date(Date.now() + 30 * DAY).toISOString(),
      });
      expect(created.statusCode, created.body).toBe(201);
      const { token } = createdApiTokenSchema.parse(created.json());
      for (const url of [
        `/bases/${fx.baseId}/members/${fx.users.u_sales1.id}/access`,
        `/bases/${fx.baseId}/principals`,
      ]) {
        const response = await t.app.inject({
          method: 'GET',
          url: `/api/v1${url}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expectProblem(response, 403, 'INSUFFICIENT_SCOPE');
        const problem = problemOf(response.body) as {
          errors?: { params?: { required?: unknown } }[];
        };
        expect(problem.errors?.[0]?.params?.required).toEqual(['session']);
      }
    });
  });

  describe('GET /bases/:id/principals', () => {
    it('active members and groups of the organization with their role, page by page', async () => {
      const items = await allPrincipals();
      const byId = new Map(items.map((item) => [item.principal_id, item]));
      expect(byId.size).toBe(items.length);
      const expectedUsers = [
        'owner',
        'u_admin',
        'u_editor',
        'u_reader',
        'u_sales1',
        'u_sales2',
        'u_out',
      ] as const;
      for (const key of expectedUsers) {
        expect(byId.get(fx.users[key].id)?.principal_type, key).toBe('user');
      }
      expect(byId.get(fx.users.u_admin.id)?.role_id).toBe(roleId('system_admin'));
      expect(byId.get(fx.users.u_editor.id)?.role_id).toBe(roleId('system_editor'));
      expect(byId.get(fx.users.u_sales1.id)?.role_id).toBeNull();
      expect(byId.get(fx.users.u_out.id)?.role_id).toBeNull();
      expect(byId.get(fx.users.u_out.id)?.email).toBe(fx.users.u_out.email);
      expect(byId.get(groupId)).toEqual({
        principal_type: 'group',
        principal_id: groupId,
        name: 'g_sales',
        email: null,
        role_id: roleId('custom', 'Sales'),
        full_access: null,
      });
      // (T713) Full access whatever the role: the organization owner (also the base owner).
      expect(byId.get(fx.users.owner.id)?.full_access).toBe('org_admin');
      for (const key of expectedUsers.filter((item) => item !== 'owner')) {
        expect(byId.get(fx.users[key].id)?.full_access, key).toBeNull();
      }
      // Left the organization, disabled, or of another organization: not listed.
      for (const user of [leaver, disabled, fx.users.stranger])
        expect(byId.has(user.id)).toBe(false);
      expect(items).toHaveLength(expectedUsers.length + 1);
      // Ordered by name, case-insensitive.
      const keys = items.map((item) => item.name.toLowerCase());
      expect(keys).toEqual([...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
      // Paging changes nothing.
      expect(await allPrincipals('', 200)).toEqual(items);
    });

    it('q narrows by name or email, case-insensitive', async () => {
      const sales = await allPrincipals('q=SALES', 2);
      expect(sales.map((item) => item.principal_id).sort()).toEqual(
        [fx.users.u_sales1.id, fx.users.u_sales2.id, groupId].sort(),
      );
      const byEmail = await allPrincipals(`q=${encodeURIComponent(fx.users.u_reader.email)}`);
      expect(byEmail.map((item) => item.principal_id)).toEqual([fx.users.u_reader.id]);
    });

    it('(T713) full_access: base owner, workspace admin directly or through a group', async () => {
      const { workspace_id: workspaceId, owner_id: ownerId } = await db.kysely
        .selectFrom('meta.bases')
        .select(['workspace_id', 'owner_id'])
        .where('id', '=', fx.baseId)
        .executeTakeFirstOrThrow();
      const fullAccess = async () =>
        new Map(
          (await allPrincipals('', 200)).map((item) => [item.principal_id, item.full_access]),
        );
      try {
        await sql`UPDATE meta.bases SET owner_id = ${fx.users.u_reader.id} WHERE id = ${fx.baseId}`.execute(
          db.kysely,
        );
        await sql`INSERT INTO meta.workspace_members
                    (organization_id, workspace_id, principal_type, principal_id, role)
                  VALUES (${fx.orgId}, ${workspaceId}, 'user', ${fx.users.u_editor.id}, 'admin'),
                         (${fx.orgId}, ${workspaceId}, 'group', ${groupId}, 'admin'),
                         (${fx.orgId}, ${workspaceId}, 'user', ${fx.users.u_out.id}, 'member')`.execute(
          db.kysely,
        );
        const byId = await fullAccess();
        expect(byId.get(fx.users.owner.id)).toBe('org_admin');
        expect(byId.get(fx.users.u_reader.id)).toBe('base_owner');
        expect(byId.get(fx.users.u_editor.id)).toBe('workspace_admin');
        // Members of g_sales, workspace admin through the group, and the group itself.
        expect(byId.get(fx.users.u_sales1.id)).toBe('workspace_admin');
        expect(byId.get(fx.users.u_sales2.id)).toBe('workspace_admin');
        expect(byId.get(groupId)).toBe('workspace_admin');
        // A workspace member (not admin) and someone with a role: no full access.
        expect(byId.get(fx.users.u_out.id)).toBeNull();
        expect(byId.get(fx.users.u_admin.id)).toBeNull();
      } finally {
        await sql`UPDATE meta.bases SET owner_id = ${ownerId} WHERE id = ${fx.baseId}`.execute(
          db.kysely,
        );
        await sql`DELETE FROM meta.workspace_members
                   WHERE workspace_id = ${workspaceId}
                     AND principal_id IN (${fx.users.u_editor.id}, ${groupId}, ${fx.users.u_out.id})`.execute(
          db.kysely,
        );
      }
      expect((await fullAccess()).get(fx.users.u_sales1.id)).toBeNull();
    });

    it('a malformed cursor → 422; u_editor → 403; u_out, other org → 404', async () => {
      const bad = await fx.call('u_admin', 'GET', `/bases/${fx.baseId}/principals?cursor=bm9wZQ`);
      expectProblem(bad, 422, 'VALIDATION_FAILED');
      const url = `/bases/${fx.baseId}/principals`;
      expectProblem(await fx.call('u_editor', 'GET', url), 403, 'PERMISSION_DENIED');
      expectProblem(await fx.call('u_out', 'GET', url), 404, 'NOT_FOUND');
      expectProblem(await fx.call('stranger', 'GET', url), 404, 'NOT_FOUND');
    });
  });

  describe('MemberAccessService (service level)', () => {
    it('P61 at the service level: sources, access as resolved for the member, counts', async () => {
      const service = t.app.get(MemberAccessService);
      const admin = await adminBase();
      const sales1 = await service.memberAccess(admin, fx.users.u_sales1.id, { counts: true });
      expect(sales1.source).toEqual({
        kind: 'group_roles',
        role_ids: [roleId('custom', 'Sales')],
        group_ids: [groupId],
      });
      const own = await t.app
        .get(AccessService)
        .findBaseForUser(fx.orgId, fx.users.u_sales1.id, fx.baseId);
      expect(sales1.access).toEqual(own?.access);
      expect(sales1.counts).toEqual({ [fx.orders.id]: { readable: 1, editable: 1 } });

      const out = await service.memberAccess(admin, fx.users.u_out.id, { counts: true });
      expect(out.source.kind).toBe('none');
      expect(out.access).toBeNull();
      await expect(
        service.memberAccess(admin, fx.users.stranger.id, { counts: false }),
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(service.memberAccess(admin, leaver.id, { counts: false })).rejects.toMatchObject(
        {
          code: 'NOT_FOUND',
        },
      );
    });

    it('listPrincipals pages without repeating or skipping', async () => {
      const service = t.app.get(MemberAccessService);
      const admin = await adminBase();
      const first = await service.listPrincipals(admin, { limit: 4 });
      expect(first.items).toHaveLength(4);
      expect(first.next_cursor).not.toBeNull();
      const second = await service.listPrincipals(admin, {
        limit: 200,
        cursor: first.next_cursor ?? undefined,
      });
      expect(second.next_cursor).toBeNull();
      const ids = [...first.items, ...second.items].map((item) => item.principal_id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toHaveLength(8);
    });
  });

  describe('MemberAccessRepository (tenant isolation)', () => {
    it('lists only principals of the scope organization, roles only of its bases', async () => {
      const repository = new MemberAccessRepository(db);
      const otherOrg = await seedOrg(db, 'Other T711');
      const otherUser = await seedUser(db, {
        memberships: [{ orgId: otherOrg, role: 'owner' }],
        displayName: 'User sales elsewhere',
      });
      await new GroupsRepository(db).create(orgScope(otherOrg), { name: 'g_sales' });

      const mine = await repository.listPrincipals(orgScope(fx.orgId), fx.baseId, {
        search: 'sales',
        cursor: null,
        limit: 50,
      });
      expect(mine.map((row) => row.principal_id).sort()).toEqual(
        [fx.users.u_sales1.id, fx.users.u_sales2.id, groupId].sort(),
      );

      // The other organization, even asked about this base: its own principals, no role here.
      const theirs = await repository.listPrincipals(orgScope(otherOrg), fx.baseId, {
        search: 'sales',
        cursor: null,
        limit: 50,
      });
      expect(theirs.map((row) => row.principal_type).sort()).toEqual(['group', 'user']);
      expect(theirs.find((row) => row.principal_type === 'user')?.principal_id).toBe(otherUser.id);
      expect(theirs.every((row) => row.role_id === null)).toBe(true);
      expect(theirs.some((row) => row.principal_id === groupId)).toBe(false);
    });
  });
});
