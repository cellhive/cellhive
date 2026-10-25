import {
  baseDetailSchema,
  baseListSchema,
  effectiveAccessSchema,
  groupMemberSchema,
  groupSchema,
  organizationListSchema,
  organizationSchema,
  orgMemberListSchema,
  workspaceListSchema,
  workspaceMemberListSchema,
  workspaceMemberSchema,
  workspaceSchema,
  type BaseDetail,
  type Id,
} from '@cellhive/contracts';
import {
  BaseRoleMembersRepository,
  BaseRolesRepository,
  BasesRepository,
  orgScope,
  type Db,
} from '@cellhive/server-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Browser, seedOrg, seedUser, type SeededUser } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { problemOf, startTestApp, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';

/**
 * T008: organizations, members, groups, workspaces and bases, with the
 * permission rules of SPEC §14.1 and CONTRACTS §5 (P01).
 */
describe('organizations, workspaces and bases (T008)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let org: Id<'org'>;
  let otherOrg: Id<'org'>;
  /** Owner of `org`. */
  let owner: SeededUser;
  /** Admin of `org`. */
  let admin: SeededUser;
  /** Member of `org`, made workspace admin through the API. */
  let wsAdmin: SeededUser;
  /** Member of `org`, workspace member without a base role. */
  let wsMember: SeededUser;
  /** Member of `org` with the system reader role on the base. */
  let reader: SeededUser;
  /** Member of `org` in a group that has the editor role. */
  let grouped: SeededUser;
  /** Member of `org` without anything else (u_out of CONTRACTS §5). */
  let outsider: SeededUser;
  /** Owner of another organization. */
  let stranger: SeededUser;
  const browsers = new Map<string, Browser>();
  let workspaceId: Id<'wsp'>;
  let base: BaseDetail;

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    org = await seedOrg(db, 'Alpha');
    otherOrg = await seedOrg(db, 'Other');
    const member = (role: 'owner' | 'admin' | 'member') => ({
      memberships: [{ orgId: org, role }],
    });
    owner = await seedUser(db, member('owner'));
    admin = await seedUser(db, member('admin'));
    wsAdmin = await seedUser(db, member('member'));
    wsMember = await seedUser(db, member('member'));
    reader = await seedUser(db, member('member'));
    grouped = await seedUser(db, member('member'));
    outsider = await seedUser(db, member('member'));
    stranger = await seedUser(db, { memberships: [{ orgId: otherOrg, role: 'owner' }] });
  });

  afterAll(async () => {
    await t.close();
    await db.destroy();
    await database.drop();
  });

  async function as(user: SeededUser): Promise<Browser> {
    let browser = browsers.get(user.id);
    if (browser === undefined) {
      browser = new Browser(t.app);
      expect((await browser.login(user.email)).statusCode).toBe(204);
      browsers.set(user.id, browser);
    }
    return browser;
  }

  async function call(
    user: SeededUser,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object,
  ): Promise<LightMyRequestResponse> {
    const browser = await as(user);
    return browser.request({
      method,
      url: `/api/v1${url}`,
      ...(payload === undefined ? {} : { payload }),
    });
  }

  function expectProblem(response: LightMyRequestResponse, status: number, code: string): void {
    expect({ status: response.statusCode, code: problemOf(response.body).code }).toEqual({
      status,
      code,
    });
  }

  async function permissionVersion(baseId: Id<'bse'>): Promise<bigint> {
    const row = await db.kysely
      .selectFrom('meta.bases')
      .select('permission_version')
      .where('id', '=', baseId)
      .executeTakeFirstOrThrow();
    return row.permission_version;
  }

  async function assignRole(
    baseId: Id<'bse'>,
    kind: 'system_admin' | 'system_editor' | 'system_reader',
    principalType: 'user' | 'group',
    principalId: Id<'usr'> | Id<'grp'>,
  ): Promise<void> {
    const scope = orgScope(org);
    const roles = await new BaseRolesRepository(db).listByBase(scope, baseId);
    const role = roles.find((row) => row.kind === kind);
    if (role === undefined) throw new Error(`no ${kind} role`);
    await new BaseRoleMembersRepository(db).assign(scope, {
      baseId,
      roleId: role.id,
      principalType,
      principalId,
    });
  }

  describe('organizations', () => {
    it('lists the caller’s organizations and reads one', async () => {
      const list = await call(owner, 'GET', '/orgs');
      expect(list.statusCode).toBe(200);
      const parsed = organizationListSchema.parse(list.json());
      expect(parsed).toMatchObject({ total: 1, offset: 0, limit: 50 });
      expect(parsed.items[0]).toMatchObject({ id: org, role: 'owner' });

      const one = await call(admin, 'GET', `/orgs/${org}`);
      expect(one.statusCode).toBe(200);
      expect(organizationSchema.parse(one.json())).toMatchObject({
        id: org,
        role: 'admin',
        settings: { locale: 'vi', timezone: 'Asia/Ho_Chi_Minh', currency: 'VND' },
      });
    });

    it('hides organizations of others (404) and lets only owners/admins change one (403)', async () => {
      expectProblem(await call(stranger, 'GET', `/orgs/${org}`), 404, 'NOT_FOUND');
      expectProblem(
        await call(stranger, 'PATCH', `/orgs/${org}`, { name: 'Hacked' }),
        404,
        'NOT_FOUND',
      );
      expectProblem(
        await call(outsider, 'PATCH', `/orgs/${org}`, { name: 'Nope' }),
        403,
        'PERMISSION_DENIED',
      );
      const patched = await call(admin, 'PATCH', `/orgs/${org}`, {
        name: 'Alpha Co',
        settings: { currency: 'USD' },
      });
      expect(patched.statusCode).toBe(200);
      expect(organizationSchema.parse(patched.json())).toMatchObject({
        name: 'Alpha Co',
        settings: { currency: 'USD', locale: 'vi' },
      });
      const event = await db.kysely
        .selectFrom('meta.events')
        .selectAll()
        .where('type', '=', 'org.updated')
        .executeTakeFirstOrThrow();
      expect(event).toMatchObject({ organization_id: org, actor_id: admin.id, entity_id: org });
    });

    it('refuses POST /orgs while ALLOW_ORG_CREATION is false', async () => {
      expectProblem(await call(owner, 'POST', '/orgs', { name: 'New' }), 403, 'PERMISSION_DENIED');
    });

    it('lets a signed-in user create an organization when ALLOW_ORG_CREATION is true', async () => {
      const open = await startTestApp({ DATABASE_URL: database.url, ALLOW_ORG_CREATION: 'true' });
      try {
        const browser = new Browser(open.app);
        expect((await browser.login(stranger.email)).statusCode).toBe(204);
        const created = await browser.request({
          method: 'POST',
          url: '/api/v1/orgs',
          payload: { name: 'Công ty Mới', locale: 'en' },
        });
        expect(created.statusCode).toBe(201);
        const body = organizationSchema.parse(created.json());
        expect(body).toMatchObject({ name: 'Công ty Mới', slug: 'cong-ty-moi', role: 'owner' });
        expect(body.settings.locale).toBe('en');
        const list = organizationListSchema.parse(
          (await browser.request({ method: 'GET', url: '/api/v1/orgs' })).json(),
        );
        expect(list.items.map((item) => item.id)).toContain(body.id);
        const types = await db.kysely
          .selectFrom('meta.events')
          .select('type')
          .where('organization_id', '=', body.id)
          .execute();
        expect(types.map((row) => row.type).sort()).toEqual(['org.created', 'org_member.added']);
      } finally {
        await open.close();
      }
    });
  });

  describe('workspaces', () => {
    it('lets an org admin create a workspace; members cannot (403); CSRF is enforced', async () => {
      expectProblem(
        await call(outsider, 'POST', `/orgs/${org}/workspaces`, { name: 'Nope' }),
        403,
        'PERMISSION_DENIED',
      );
      const browser = await as(owner);
      const noCsrf = await browser.request({
        method: 'POST',
        url: `/api/v1/orgs/${org}/workspaces`,
        payload: { name: 'Sales' },
        csrf: false,
      });
      expectProblem(noCsrf, 403, 'CSRF_INVALID');

      const created = await call(owner, 'POST', `/orgs/${org}/workspaces`, { name: 'Kinh doanh' });
      expect(created.statusCode).toBe(201);
      const workspace = workspaceSchema.parse(created.json());
      expect(workspace).toMatchObject({ name: 'Kinh doanh', slug: 'kinh-doanh', role: null });
      workspaceId = workspace.id;
      // Same name, unique slug.
      const again = workspaceSchema.parse(
        (await call(owner, 'POST', `/orgs/${org}/workspaces`, { name: 'Kinh doanh' })).json(),
      );
      expect(again.slug).toMatch(/^kinh-doanh-[0-9a-f]{6}$/);
      expect((await call(owner, 'DELETE', `/orgs/${org}/workspaces/${again.id}`)).statusCode).toBe(
        204,
      );
    });

    it('adds workspace members; only workspace/org admins manage them', async () => {
      const addAdmin = await call(owner, 'POST', `/workspaces/${workspaceId}/members`, {
        principal_id: wsAdmin.id,
        role: 'admin',
      });
      expect(addAdmin.statusCode).toBe(201);
      expect(workspaceMemberSchema.parse(addAdmin.json())).toMatchObject({
        principal_type: 'user',
        principal_id: wsAdmin.id,
        role: 'admin',
        email: wsAdmin.email,
      });
      // The workspace admin now manages members.
      const addMember = await call(wsAdmin, 'POST', `/workspaces/${workspaceId}/members`, {
        principal_id: wsMember.id,
      });
      expect(addMember.statusCode).toBe(201);
      expect(workspaceMemberSchema.parse(addMember.json()).role).toBe('member');
      // A plain member sees the workspace but cannot manage it.
      expectProblem(
        await call(wsMember, 'POST', `/workspaces/${workspaceId}/members`, {
          principal_id: outsider.id,
        }),
        403,
        'PERMISSION_DENIED',
      );
      // Invisible to users without any link to it.
      expectProblem(
        await call(outsider, 'GET', `/workspaces/${workspaceId}/members`),
        404,
        'NOT_FOUND',
      );
      expectProblem(
        await call(stranger, 'GET', `/workspaces/${workspaceId}/members`),
        404,
        'NOT_FOUND',
      );
      // Already a member / not in the organization.
      const duplicate = await call(owner, 'POST', `/workspaces/${workspaceId}/members`, {
        principal_id: wsMember.id,
      });
      expectProblem(duplicate, 422, 'VALIDATION_FAILED');
      expect(problemOf(duplicate.body).errors).toEqual([
        expect.objectContaining({ code: 'ALREADY_MEMBER' }),
      ]);
      const foreign = await call(owner, 'POST', `/workspaces/${workspaceId}/members`, {
        principal_id: stranger.id,
      });
      expect(problemOf(foreign.body).errors).toEqual([
        expect.objectContaining({ code: 'UNKNOWN_PRINCIPAL' }),
      ]);
      const list = workspaceMemberListSchema.parse(
        (await call(wsMember, 'GET', `/workspaces/${workspaceId}/members`)).json(),
      );
      expect(list.total).toBe(2);
    });

    it('lists workspaces by visibility', async () => {
      const forAdmin = workspaceListSchema.parse(
        (await call(admin, 'GET', `/orgs/${org}/workspaces`)).json(),
      );
      expect(forAdmin.items.map((w) => w.id)).toEqual([workspaceId]);
      const forMember = workspaceListSchema.parse(
        (await call(wsMember, 'GET', `/orgs/${org}/workspaces`)).json(),
      );
      expect(forMember.items).toEqual([
        expect.objectContaining({ id: workspaceId, role: 'member' }),
      ]);
      const forOutsider = workspaceListSchema.parse(
        (await call(outsider, 'GET', `/orgs/${org}/workspaces`)).json(),
      );
      expect(forOutsider.items).toEqual([]);
      expectProblem(
        await call(outsider, 'GET', `/orgs/${org}/workspaces/${workspaceId}`),
        404,
        'NOT_FOUND',
      );
      expectProblem(await call(stranger, 'GET', `/orgs/${org}/workspaces`), 404, 'NOT_FOUND');
    });
  });

  describe('bases', () => {
    it('creates a base with exactly the 3 system roles and the creator as owner', async () => {
      // Workspace members cannot create bases.
      expectProblem(
        await call(wsMember, 'POST', `/workspaces/${workspaceId}/bases`, { name: 'Nope' }),
        403,
        'PERMISSION_DENIED',
      );
      const created = await call(wsAdmin, 'POST', `/workspaces/${workspaceId}/bases`, {
        name: 'Chăm sóc khách hàng',
        icon: '📞',
      });
      expect(created.statusCode).toBe(201);
      base = baseDetailSchema.parse(created.json());
      expect(base).toMatchObject({
        owner_id: wsAdmin.id,
        workspace_id: workspaceId,
        permission_version: 1,
        access: { role: null, is_admin: true, tables: {}, dashboards: {} },
      });
      const roles = await db.kysely
        .selectFrom('meta.base_roles')
        .select(['kind', 'name', 'config', 'position'])
        .where('base_id', '=', base.id)
        .orderBy('position')
        .execute();
      expect(roles.map((role) => role.kind)).toEqual([
        'system_admin',
        'system_editor',
        'system_reader',
      ]);
      expect(roles[1]?.config).toMatchObject({
        base_rule: { copy: true, download: true, share_link: true },
      });
      expect(roles[2]?.config).toMatchObject({
        base_rule: { copy: true, download: true, share_link: false },
      });
      const events = (
        await db.kysely.selectFrom('meta.events').select(['type', 'payload']).execute()
      ).filter((event) => (event.payload as { base_id?: string }).base_id === base.id);
      expect(events.map((event) => event.type).sort()).toEqual([
        'base.created',
        'role.created',
        'role.created',
        'role.created',
      ]);
    });

    it('GET /bases/:id returns permission_version and an access shape valid for C§5A', async () => {
      const response = await call(wsAdmin, 'GET', `/bases/${base.id}`);
      expect(response.statusCode).toBe(200);
      const body = baseDetailSchema.parse(response.json());
      expect(effectiveAccessSchema.safeParse(body.access).success).toBe(true);
      expect(body.permission_version).toBe(1);
    });

    it('P01: a user without access gets 404, never 403', async () => {
      expectProblem(await call(outsider, 'GET', `/bases/${base.id}`), 404, 'NOT_FOUND');
      expectProblem(await call(stranger, 'GET', `/bases/${base.id}`), 404, 'NOT_FOUND');
      expectProblem(
        await call(outsider, 'PATCH', `/bases/${base.id}`, { name: 'x' }),
        404,
        'NOT_FOUND',
      );
      expectProblem(await call(outsider, 'DELETE', `/bases/${base.id}`), 404, 'NOT_FOUND');
      expectProblem(await call(outsider, 'GET', '/bases/not-an-id'), 404, 'NOT_FOUND');
      expectProblem(await call(outsider, 'GET', '/bases/bse_0000000000000000'), 404, 'NOT_FOUND');
    });

    it('a workspace member without a base role gets 404 and sees no base', async () => {
      expectProblem(await call(wsMember, 'GET', `/bases/${base.id}`), 404, 'NOT_FOUND');
      const list = baseListSchema.parse(
        (await call(wsMember, 'GET', `/workspaces/${workspaceId}/bases`)).json(),
      );
      expect(list).toMatchObject({ items: [], total: 0 });
    });

    it('a workspace admin sees and manages every base of the workspace', async () => {
      const other = baseDetailSchema.parse(
        (await call(owner, 'POST', `/workspaces/${workspaceId}/bases`, { name: 'Kho' })).json(),
      );
      expect(other.owner_id).toBe(owner.id);
      const list = baseListSchema.parse(
        (await call(wsAdmin, 'GET', `/workspaces/${workspaceId}/bases`)).json(),
      );
      expect(list.items.map((item) => item.id).sort()).toEqual([base.id, other.id].sort());
      const read = baseDetailSchema.parse(
        (await call(wsAdmin, 'GET', `/bases/${other.id}`)).json(),
      );
      expect(read.access.is_admin).toBe(true);
      const renamed = await call(wsAdmin, 'PATCH', `/bases/${other.id}`, { name: 'Kho hàng' });
      expect(renamed.statusCode).toBe(200);
      expect(baseDetailSchema.parse(renamed.json()).name).toBe('Kho hàng');
      expect((await call(wsAdmin, 'DELETE', `/bases/${other.id}`)).statusCode).toBe(204);
      expectProblem(await call(owner, 'GET', `/bases/${other.id}`), 404, 'NOT_FOUND');
      const trashed = await db.kysely
        .selectFrom('meta.bases')
        .select('deleted_at')
        .where('id', '=', other.id)
        .executeTakeFirstOrThrow();
      expect(trashed.deleted_at).not.toBeNull();
    });

    it('an org owner/admin has full access to every base', async () => {
      for (const user of [owner, admin]) {
        const response = await call(user, 'GET', `/bases/${base.id}`);
        expect(response.statusCode).toBe(200);
        expect(baseDetailSchema.parse(response.json()).access).toMatchObject({
          is_admin: true,
          role: null,
        });
      }
    });

    it('a reader reads (403 on admin actions); the workspace becomes visible through the base', async () => {
      await assignRole(base.id, 'system_reader', 'user', reader.id);
      const response = await call(reader, 'GET', `/bases/${base.id}`);
      expect(response.statusCode).toBe(200);
      const body = baseDetailSchema.parse(response.json());
      expect(body.access).toMatchObject({
        is_admin: false,
        role: { kind: 'system_reader', name: 'Reader' },
        base_rule: { copy: true, download: true, share_link: false },
      });
      expectProblem(
        await call(reader, 'PATCH', `/bases/${base.id}`, { name: 'x' }),
        403,
        'PERMISSION_DENIED',
      );
      expectProblem(
        await call(reader, 'PATCH', `/bases/${base.id}`, { owner_id: reader.id }),
        403,
        'PERMISSION_DENIED',
      );
      expectProblem(await call(reader, 'DELETE', `/bases/${base.id}`), 403, 'PERMISSION_DENIED');
      const workspaces = workspaceListSchema.parse(
        (await call(reader, 'GET', `/orgs/${org}/workspaces`)).json(),
      );
      expect(workspaces.items).toEqual([expect.objectContaining({ id: workspaceId, role: null })]);
      const bases = baseListSchema.parse(
        (await call(reader, 'GET', `/workspaces/${workspaceId}/bases`)).json(),
      );
      expect(bases.items.map((item) => item.id)).toEqual([base.id]);
      // Cannot see workspace members? A reader sees the workspace, so it may list them.
      expect((await call(reader, 'GET', `/workspaces/${workspaceId}/members`)).statusCode).toBe(
        200,
      );
    });

    it('transfers ownership (owner or org admin only) and bumps permission_version', async () => {
      const before = await permissionVersion(base.id);
      const response = await call(wsAdmin, 'PATCH', `/bases/${base.id}`, { owner_id: owner.id });
      expect(response.statusCode).toBe(200);
      const body = baseDetailSchema.parse(response.json());
      expect(body.owner_id).toBe(owner.id);
      expect(BigInt(body.permission_version)).toBe(before + 1n);
      // A non-member cannot become owner.
      const foreign = await call(owner, 'PATCH', `/bases/${base.id}`, { owner_id: stranger.id });
      expect(problemOf(foreign.body).errors).toEqual([
        expect.objectContaining({ path: 'owner_id', code: 'UNKNOWN_PRINCIPAL' }),
      ]);
      const audit = await db.kysely
        .selectFrom('meta.audit_logs')
        .selectAll()
        .where('action', '=', 'base.updated')
        .where('entity_id', '=', base.id)
        .orderBy('created_at', 'desc')
        .executeTakeFirstOrThrow();
      expect(audit).toMatchObject({
        base_id: base.id,
        actor_id: wsAdmin.id,
        before: { owner_id: wsAdmin.id },
        after: { owner_id: owner.id },
      });
      expect(audit.batch_id).toBe(audit.request_id);
      expect(audit.request_id).toMatch(/^req_/);
    });

    it('restores a base from the trash (owner, workspace admin, org admin); others get 404', async () => {
      // A plain member who owns a base (and reads the main one, so the workspace is visible).
      const trashOwner = await seedUser(db, { memberships: [{ orgId: org, role: 'member' }] });
      await assignRole(base.id, 'system_reader', 'user', trashOwner.id);
      const created = baseDetailSchema.parse(
        (await call(owner, 'POST', `/workspaces/${workspaceId}/bases`, { name: 'Lưu trữ' })).json(),
      );
      expect(created.deleted_at).toBeNull();
      await call(owner, 'PATCH', `/bases/${created.id}`, { owner_id: trashOwner.id });
      await assignRole(created.id, 'system_reader', 'user', reader.id);
      expect((await call(trashOwner, 'DELETE', `/bases/${created.id}`)).statusCode).toBe(204);
      const versionInTrash = await permissionVersion(created.id);

      const listed = async (user: SeededUser, query: string) =>
        baseListSchema
          .parse((await call(user, 'GET', `/workspaces/${workspaceId}/bases${query}`)).json())
          .items.filter((item) => item.id === created.id);
      // Not listed by default; with include_deleted only for those who may restore it.
      expect(await listed(trashOwner, '')).toEqual([]);
      expect(await listed(wsAdmin, '')).toEqual([]);
      const [asOwner] = await listed(trashOwner, '?include_deleted=true');
      expect(asOwner?.deleted_at).not.toBeNull();
      expect(await listed(wsAdmin, '?include_deleted=true')).toHaveLength(1);
      expect(await listed(admin, '?include_deleted=1')).toHaveLength(1);
      // The reader has a role in it but cannot restore it.
      expect(await listed(reader, '?include_deleted=true')).toEqual([]);
      expectProblem(
        await call(reader, 'GET', `/workspaces/${workspaceId}/bases?include_deleted=yes`),
        422,
        'VALIDATION_FAILED',
      );

      // Everyone else: 404 (a trashed base is invisible), also for malformed IDs.
      for (const user of [reader, wsMember, outsider, stranger]) {
        expectProblem(await call(user, 'POST', `/bases/${created.id}/restore`), 404, 'NOT_FOUND');
      }
      expectProblem(await call(owner, 'POST', '/bases/not-an-id/restore'), 404, 'NOT_FOUND');
      expectProblem(
        await call(owner, 'POST', '/bases/bse_0000000000000000/restore'),
        404,
        'NOT_FOUND',
      );
      expect(await permissionVersion(created.id)).toBe(versionInTrash);

      // The base owner restores it.
      const restored = await call(trashOwner, 'POST', `/bases/${created.id}/restore`);
      expect(restored.statusCode).toBe(200);
      const body = baseDetailSchema.parse(restored.json());
      expect(body).toMatchObject({ id: created.id, owner_id: trashOwner.id, deleted_at: null });
      expect(BigInt(body.permission_version)).toBe(versionInTrash + 1n);
      expect((await call(reader, 'GET', `/bases/${created.id}`)).statusCode).toBe(200);
      const events = await db.kysely
        .selectFrom('meta.events')
        .select(['type', 'actor_id'])
        .where('type', '=', 'base.restored')
        .where('entity_id', '=', created.id)
        .execute();
      expect(events).toEqual([{ type: 'base.restored', actor_id: trashOwner.id }]);
      const audit = await db.kysely
        .selectFrom('meta.audit_logs')
        .select(['actor_id', 'base_id', 'after'])
        .where('action', '=', 'base.restored')
        .where('entity_id', '=', created.id)
        .execute();
      expect(audit).toEqual([
        {
          actor_id: trashOwner.id,
          base_id: created.id,
          after: { name: 'Lưu trữ', workspace_id: workspaceId },
        },
      ]);

      // Outside the trash: returned as it is, nothing recorded.
      const again = await call(trashOwner, 'POST', `/bases/${created.id}/restore`);
      expect(again.statusCode).toBe(200);
      expect(baseDetailSchema.parse(again.json()).permission_version).toBe(body.permission_version);
      expectProblem(await call(outsider, 'POST', `/bases/${created.id}/restore`), 404, 'NOT_FOUND');

      // Workspace admins and org owners/admins restore any base of the workspace.
      for (const user of [wsAdmin, admin]) {
        expect((await call(owner, 'DELETE', `/bases/${created.id}`)).statusCode).toBe(204);
        const response = await call(user, 'POST', `/bases/${created.id}/restore`);
        expect(response.statusCode).toBe(200);
        expect(baseDetailSchema.parse(response.json()).deleted_at).toBeNull();
      }
      // Leave it in the trash for the later workspace tests.
      expect((await call(owner, 'DELETE', `/bases/${created.id}`)).statusCode).toBe(204);
    });
  });

  describe('groups', () => {
    let groupId: Id<'grp'>;

    it('lets owners/admins manage groups; members read them', async () => {
      expectProblem(
        await call(outsider, 'POST', `/orgs/${org}/groups`, { name: 'Sales' }),
        403,
        'PERMISSION_DENIED',
      );
      const created = await call(admin, 'POST', `/orgs/${org}/groups`, { name: 'Sales' });
      expect(created.statusCode).toBe(201);
      groupId = groupSchema.parse(created.json()).id;
      expectProblem(
        await call(admin, 'POST', `/orgs/${org}/groups`, { name: 'sales' }),
        409,
        'NAME_CONFLICT',
      );
      const renamed = await call(admin, 'PATCH', `/orgs/${org}/groups/${groupId}`, {
        name: 'Kinh doanh',
      });
      expect(groupSchema.parse(renamed.json()).name).toBe('Kinh doanh');
      expect((await call(outsider, 'GET', `/orgs/${org}/groups/${groupId}`)).statusCode).toBe(200);
      expectProblem(await call(stranger, 'GET', `/groups/${groupId}/members`), 404, 'NOT_FOUND');
    });

    it('group membership drives base access and bumps permission_version', async () => {
      await assignRole(base.id, 'system_editor', 'group', groupId);
      expectProblem(await call(grouped, 'GET', `/bases/${base.id}`), 404, 'NOT_FOUND');
      const before = await permissionVersion(base.id);
      const added = await call(admin, 'POST', `/groups/${groupId}/members`, {
        user_id: grouped.id,
      });
      expect(added.statusCode).toBe(201);
      expect(groupMemberSchema.parse(added.json()).user.id).toBe(grouped.id);
      expect(await permissionVersion(base.id)).toBe(before + 1n);
      // New request, fresh access.
      browsers.delete(grouped.id);
      const read = await call(grouped, 'GET', `/bases/${base.id}`);
      expect(read.statusCode).toBe(200);
      expect(baseDetailSchema.parse(read.json()).access.role).toMatchObject({
        kind: 'system_editor',
      });
      expectProblem(
        await call(admin, 'POST', `/groups/${groupId}/members`, { user_id: stranger.id }),
        422,
        'VALIDATION_FAILED',
      );
      const removed = await call(admin, 'DELETE', `/groups/${groupId}/members/${grouped.id}`);
      expect(removed.statusCode).toBe(204);
      expect(await permissionVersion(base.id)).toBe(before + 2n);
      expectProblem(await call(grouped, 'GET', `/bases/${base.id}`), 404, 'NOT_FOUND');
    });

    it('deleting a group removes its role assignments', async () => {
      await call(admin, 'POST', `/groups/${groupId}/members`, { user_id: grouped.id });
      expect((await call(grouped, 'GET', `/bases/${base.id}`)).statusCode).toBe(200);
      expect((await call(admin, 'DELETE', `/orgs/${org}/groups/${groupId}`)).statusCode).toBe(204);
      const assignments = await db.kysely
        .selectFrom('meta.base_role_members')
        .select('principal_id')
        .where('principal_id', '=', groupId)
        .execute();
      expect(assignments).toEqual([]);
      expectProblem(await call(grouped, 'GET', `/bases/${base.id}`), 404, 'NOT_FOUND');
    });
  });

  describe('workspace member changes', () => {
    it('demoting the workspace admin removes access and bumps permission_version', async () => {
      // wsAdmin gave the base to the owner above: access now comes from the workspace role only.
      expect((await call(wsAdmin, 'GET', `/bases/${base.id}`)).statusCode).toBe(200);
      const before = await permissionVersion(base.id);
      const demoted = await call(
        owner,
        'PATCH',
        `/workspaces/${workspaceId}/members/${wsAdmin.id}`,
        {
          role: 'member',
        },
      );
      expect(demoted.statusCode).toBe(200);
      expect(workspaceMemberSchema.parse(demoted.json()).role).toBe('member');
      expect(await permissionVersion(base.id)).toBe(before + 1n);
      expectProblem(await call(wsAdmin, 'GET', `/bases/${base.id}`), 404, 'NOT_FOUND');
      expect(
        (await call(owner, 'DELETE', `/workspaces/${workspaceId}/members/${wsAdmin.id}`))
          .statusCode,
      ).toBe(204);
      expectProblem(
        await call(owner, 'DELETE', `/workspaces/${workspaceId}/members/${wsAdmin.id}`),
        404,
        'NOT_FOUND',
      );
    });

    it('renames a workspace; refuses to delete one that still has bases', async () => {
      const renamed = await call(owner, 'PATCH', `/orgs/${org}/workspaces/${workspaceId}`, {
        name: 'Bán hàng',
      });
      expect(workspaceSchema.parse(renamed.json()).name).toBe('Bán hàng');
      expectProblem(
        await call(wsMember, 'PATCH', `/orgs/${org}/workspaces/${workspaceId}`, { name: 'x' }),
        403,
        'PERMISSION_DENIED',
      );
      const refused = await call(owner, 'DELETE', `/orgs/${org}/workspaces/${workspaceId}`);
      expectProblem(refused, 422, 'VALIDATION_FAILED');
      expect(problemOf(refused.body).errors).toEqual([
        expect.objectContaining({ code: 'WORKSPACE_NOT_EMPTY' }),
      ]);
    });
  });

  describe('organization members', () => {
    it('lists members with pagination', async () => {
      const page = orgMemberListSchema.parse(
        (await call(outsider, 'GET', `/orgs/${org}/members?limit=3&offset=1`)).json(),
      );
      // The 7 seeded members plus the base owner of the restore test.
      expect(page).toMatchObject({ total: 8, offset: 1, limit: 3 });
      expect(page.items).toHaveLength(3);
      expectProblem(await call(stranger, 'GET', `/orgs/${org}/members`), 404, 'NOT_FOUND');
    });

    it('protects owners: only owners change owners, and the last owner stays', async () => {
      expectProblem(
        await call(outsider, 'PATCH', `/orgs/${org}/members/${reader.id}`, { role: 'admin' }),
        403,
        'PERMISSION_DENIED',
      );
      expectProblem(
        await call(admin, 'PATCH', `/orgs/${org}/members/${owner.id}`, { role: 'member' }),
        403,
        'PERMISSION_DENIED',
      );
      expectProblem(
        await call(admin, 'PATCH', `/orgs/${org}/members/${reader.id}`, { role: 'owner' }),
        403,
        'PERMISSION_DENIED',
      );
      expectProblem(
        await call(admin, 'DELETE', `/orgs/${org}/members/${owner.id}`),
        403,
        'PERMISSION_DENIED',
      );
      const demoteSelf = await call(owner, 'PATCH', `/orgs/${org}/members/${owner.id}`, {
        role: 'admin',
      });
      expectProblem(demoteSelf, 422, 'VALIDATION_FAILED');
      expect(problemOf(demoteSelf.body).errors).toEqual([
        expect.objectContaining({ code: 'LAST_OWNER' }),
      ]);
      const leave = await call(owner, 'DELETE', `/orgs/${org}/members/${owner.id}`);
      expect(problemOf(leave.body).errors).toEqual([
        expect.objectContaining({ code: 'LAST_OWNER' }),
      ]);
      // With a second owner, the first may step down.
      const promoted = await call(owner, 'PATCH', `/orgs/${org}/members/${admin.id}`, {
        role: 'owner',
      });
      expect(promoted.statusCode).toBe(200);
      const stepDown = await call(owner, 'PATCH', `/orgs/${org}/members/${owner.id}`, {
        role: 'admin',
      });
      expect(stepDown.statusCode).toBe(200);
      // Restore.
      expect(
        (await call(admin, 'PATCH', `/orgs/${org}/members/${owner.id}`, { role: 'owner' }))
          .statusCode,
      ).toBe(200);
      expect(
        (await call(owner, 'PATCH', `/orgs/${org}/members/${admin.id}`, { role: 'admin' }))
          .statusCode,
      ).toBe(200);
    });

    it('an org role change bumps permission_version of every base', async () => {
      const before = await permissionVersion(base.id);
      const changed = await call(owner, 'PATCH', `/orgs/${org}/members/${reader.id}`, {
        role: 'admin',
      });
      expect(changed.statusCode).toBe(200);
      expect(await permissionVersion(base.id)).toBe(before + 1n);
      await call(owner, 'PATCH', `/orgs/${org}/members/${reader.id}`, { role: 'member' });
    });

    it('removing a member drops their workspace memberships and base roles', async () => {
      expect((await call(admin, 'DELETE', `/orgs/${org}/members/${reader.id}`)).statusCode).toBe(
        204,
      );
      const roles = await db.kysely
        .selectFrom('meta.base_role_members')
        .select('principal_id')
        .where('principal_id', '=', reader.id)
        .execute();
      expect(roles).toEqual([]);
      browsers.delete(reader.id);
      expectProblem(await call(reader, 'GET', `/bases/${base.id}`), 404, 'NOT_FOUND');
      expectProblem(await call(reader, 'GET', `/orgs/${org}`), 404, 'NOT_FOUND');
      // A member may leave by themselves.
      expect(
        (await call(wsMember, 'DELETE', `/orgs/${org}/members/${wsMember.id}`)).statusCode,
      ).toBe(204);
      const memberships = await db.kysely
        .selectFrom('meta.workspace_members')
        .select('principal_id')
        .where('principal_id', '=', wsMember.id)
        .execute();
      expect(memberships).toEqual([]);
    });
  });

  describe('removing a member who owns bases', () => {
    async function ownerOf(baseId: Id<'bse'>): Promise<string> {
      const row = await db.kysely
        .selectFrom('meta.bases')
        .select('owner_id')
        .where('id', '=', baseId)
        .executeTakeFirstOrThrow();
      return row.owner_id;
    }

    async function isMember(userId: Id<'usr'>): Promise<boolean> {
      const row = await db.kysely
        .selectFrom('meta.org_members')
        .select('user_id')
        .where('organization_id', '=', org)
        .where('user_id', '=', userId)
        .executeTakeFirst();
      return row !== undefined;
    }

    function ownsBasesError(response: LightMyRequestResponse) {
      expectProblem(response, 422, 'VALIDATION_FAILED');
      const errors = problemOf(response.body).errors as {
        path: string;
        code: string;
        params?: { base_ids: string[]; total: number };
      }[];
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ path: 'transfer_bases_to', code: 'OWNS_BASES' });
      const params = errors[0]?.params;
      // Postgres collation order of mixed-case ids differs from JS sort: compare as a set.
      return params === undefined
        ? undefined
        : { ...params, base_ids: [...params.base_ids].sort() };
    }

    it('422 OWNS_BASES without transfer_bases_to; with it, bases move in the same transaction', async () => {
      const leaver = await seedUser(db, { memberships: [{ orgId: org, role: 'admin' }] });
      const created: Id<'bse'>[] = [];
      for (const name of ['Owned 1', 'Owned 2']) {
        const response = await call(leaver, 'POST', `/workspaces/${workspaceId}/bases`, { name });
        expect(response.statusCode).toBe(201);
        created.push(baseDetailSchema.parse(response.json()).id);
      }
      const [kept, trashed] = created as [Id<'bse'>, Id<'bse'>];
      // Bases in the trash count too: they can be restored.
      expect((await call(leaver, 'DELETE', `/bases/${trashed}`)).statusCode).toBe(204);

      const refused = await call(owner, 'DELETE', `/orgs/${org}/members/${leaver.id}`);
      expect(ownsBasesError(refused)).toEqual({ base_ids: [...created].sort(), total: 2 });
      expect(await isMember(leaver.id)).toBe(true);

      // The new owner must be another owner/admin of this organization.
      const outsiderMember = await seedUser(db, { memberships: [{ orgId: org, role: 'member' }] });
      for (const target of [outsiderMember.id, stranger.id, leaver.id, 'usr_Nobody0000000000']) {
        const invalid = await call(owner, 'DELETE', `/orgs/${org}/members/${leaver.id}`, {
          transfer_bases_to: target,
        });
        expectProblem(invalid, 422, 'VALIDATION_FAILED');
        expect(problemOf(invalid.body).errors).toEqual([
          expect.objectContaining({ path: 'transfer_bases_to', code: 'UNKNOWN_PRINCIPAL' }),
        ]);
      }
      expectProblem(
        await call(owner, 'DELETE', `/orgs/${org}/members/${leaver.id}`, {
          transfer_bases_to: 'not-an-id',
        }),
        422,
        'VALIDATION_FAILED',
      );
      expect(await isMember(leaver.id)).toBe(true);
      expect(await ownerOf(kept)).toBe(leaver.id);

      const versionBefore = await permissionVersion(kept);
      const removed = await call(owner, 'DELETE', `/orgs/${org}/members/${leaver.id}`, {
        transfer_bases_to: admin.id,
      });
      expect(removed.statusCode).toBe(204);
      expect(await isMember(leaver.id)).toBe(false);
      expect(await ownerOf(kept)).toBe(admin.id);
      expect(await ownerOf(trashed)).toBe(admin.id);
      // Transfer and the membership change both invalidate cached permissions.
      expect(await permissionVersion(kept)).toBeGreaterThan(versionBefore);

      const audits = await db.kysely
        .selectFrom('meta.audit_logs')
        .select(['entity_id', 'actor_id', 'before', 'after', 'batch_id'])
        .where('organization_id', '=', org)
        .where('action', '=', 'base.updated')
        .where('entity_id', 'in', created)
        .orderBy('entity_id')
        .execute();
      expect(
        audits
          .map((entry) => ({
            entity_id: entry.entity_id,
            actor_id: entry.actor_id,
            before: entry.before,
            after: entry.after,
          }))
          // Postgres collation order of mixed-case ids differs from JS sort.
          .sort((x, y) => ((x.entity_id ?? '') < (y.entity_id ?? '') ? -1 : 1)),
      ).toEqual(
        [...created].sort().map((id) => ({
          entity_id: id,
          actor_id: owner.id,
          before: { owner_id: leaver.id },
          after: { owner_id: admin.id },
        })),
      );
      const removal = await db.kysely
        .selectFrom('meta.audit_logs')
        .select('batch_id')
        .where('action', '=', 'org_member.removed')
        .where('entity_id', '=', leaver.id)
        .executeTakeFirstOrThrow();
      expect(removal.batch_id).toMatch(/^req_/);
      expect(audits.every((entry) => entry.batch_id === removal.batch_id)).toBe(true);
      const events = await db.kysely
        .selectFrom('meta.events')
        .select('entity_id')
        .where('type', '=', 'base.updated')
        .where('entity_id', 'in', created)
        .execute();
      expect(events).toHaveLength(2);
    });

    it('the same rule applies when leaving; at most 50 base IDs are listed', async () => {
      const leaver = await seedUser(db, { memberships: [{ orgId: org, role: 'member' }] });
      const bases = new BasesRepository(db);
      for (let i = 0; i < 51; i += 1) {
        await bases.create(orgScope(org), {
          workspaceId,
          ownerId: leaver.id,
          name: `Many ${String(i)}`,
        });
      }
      const refused = await call(leaver, 'DELETE', `/orgs/${org}/members/${leaver.id}`);
      const params = ownsBasesError(refused);
      expect(params?.total).toBe(51);
      expect(params?.base_ids).toHaveLength(50);
      expect(await isMember(leaver.id)).toBe(true);

      const left = await call(leaver, 'DELETE', `/orgs/${org}/members/${leaver.id}`, {
        transfer_bases_to: owner.id,
      });
      expect(left.statusCode).toBe(204);
      const remaining = await db.kysely
        .selectFrom('meta.bases')
        .select('id')
        .where('owner_id', '=', leaver.id)
        .execute();
      expect(remaining).toEqual([]);
    });
  });

  it('writes an event with a matching audit entry (same tx, request batch) for every mutation', async () => {
    const events = await db.kysely
      .selectFrom('meta.events')
      .select(['id', 'type', 'entity_id', 'organization_id', 'actor_id'])
      .where('organization_id', '=', org)
      .execute();
    const audits = await db.kysely
      .selectFrom('meta.audit_logs')
      .select(['action', 'entity_id', 'actor_id', 'batch_id', 'request_id', 'ip'])
      .where('organization_id', '=', org)
      .execute();
    const types = new Set(events.map((event) => event.type));
    for (const type of [
      'org.updated',
      'org_member.role_changed',
      'org_member.removed',
      'group.created',
      'group.updated',
      'group.deleted',
      'group_member.added',
      'group_member.removed',
      'workspace.created',
      'workspace.updated',
      'workspace.deleted',
      'workspace_member.added',
      'workspace_member.role_changed',
      'workspace_member.removed',
      'base.created',
      'base.updated',
      'base.deleted',
      'base.restored',
      'role.created',
    ]) {
      expect(types, type).toContain(type);
    }
    for (const event of events) {
      const matching = audits.filter(
        (entry) => entry.action === event.type && entry.entity_id === event.entity_id,
      );
      expect(matching.length, `${event.type} ${event.entity_id}`).toBeGreaterThan(0);
    }
    const userAudits = audits.filter(
      (entry) => entry.actor_id !== null && !entry.action.startsWith('auth.'),
    );
    for (const entry of userAudits) {
      expect(entry.request_id).toMatch(/^req_/);
      expect(entry.batch_id).toBe(entry.request_id);
      expect(entry.ip).not.toBeNull();
    }
  });
});
