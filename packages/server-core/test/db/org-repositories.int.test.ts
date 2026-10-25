import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  BaseRoleMembersRepository,
  BaseRolesRepository,
  BasesRepository,
  findInvitationOrganization,
  GroupMembersRepository,
  GroupsRepository,
  invitationStateOf,
  InvitationsRepository,
  migrateToLatest,
  OrganizationsRepository,
  OrgMembersRepository,
  orgScope,
  UsersRepository,
  WorkspaceMembersRepository,
  WorkspacesRepository,
  type Base,
  type Db,
  type OrgScope,
} from '../../src/db/index.js';
import { createTestDatabase, createTestDb, type TestDatabase } from '../support/postgres.js';

import type { Id } from '@cellhive/contracts';

const ORG_A = 'org_TenantOrgA000001';
const ORG_B = 'org_TenantOrgB000001';
const USER_A = 'usr_TenantUserA00001';
const USER_A2 = 'usr_TenantUserA20001';
const USER_B = 'usr_TenantUserB00001';
const WSP_A = 'wsp_TenantWspA000001';
const WSP_B = 'wsp_TenantWspB000001';
const GRP_A = 'grp_TenantGrpA000001';
const GRP_B = 'grp_TenantGrpB000001';
const ROL_A = 'rol_TenantRolA000001';
const ROL_B = 'rol_TenantRolB000001';
const PAGE = { offset: 0, limit: 50 } as const;

/**
 * Tenant isolation of the organization, group, workspace, base role and
 * invitation repositories (AGENTS.md rule 5): a scope of organization A
 * never reads or changes rows of organization B, even with B's IDs.
 */
describe('organization repositories tenant isolation', () => {
  let database: TestDatabase;
  let db: Db;
  let a: OrgScope;
  let b: OrgScope;
  let members: OrgMembersRepository;
  let groups: GroupsRepository;
  let groupMembers: GroupMembersRepository;
  let workspaces: WorkspacesRepository;
  let workspaceMembers: WorkspaceMembersRepository;
  let bases: BasesRepository;
  let roles: BaseRolesRepository;
  let roleMembers: BaseRoleMembersRepository;
  let invitations: InvitationsRepository;
  let baseA: Base;
  let baseB: Base;

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateToLatest(db.kysely);
    a = orgScope(ORG_A);
    b = orgScope(ORG_B);
    const organizations = new OrganizationsRepository(db);
    const users = new UsersRepository(db);
    members = new OrgMembersRepository(db);
    groups = new GroupsRepository(db);
    groupMembers = new GroupMembersRepository(db);
    workspaces = new WorkspacesRepository(db);
    workspaceMembers = new WorkspaceMembersRepository(db);
    bases = new BasesRepository(db);
    roles = new BaseRolesRepository(db);
    roleMembers = new BaseRoleMembersRepository(db);
    invitations = new InvitationsRepository(db);

    await organizations.create({ id: ORG_A, name: 'A', slug: 'tenant-a' });
    await organizations.create({ id: ORG_B, name: 'B', slug: 'tenant-b' });
    for (const [id, email] of [
      [USER_A, 'a@example.test'],
      [USER_A2, 'a2@example.test'],
      [USER_B, 'b@example.test'],
    ] as const) {
      await users.create({ id, email, displayName: email, passwordHash: null });
    }
    await members.add(a, USER_A, 'owner');
    await members.add(a, USER_A2, 'member');
    await members.add(b, USER_B, 'owner');
    await groups.create(a, { id: GRP_A, name: 'Sales' });
    await groups.create(b, { id: GRP_B, name: 'Sales' });
    await groupMembers.add(a, GRP_A, USER_A2);
    await groupMembers.add(b, GRP_B, USER_B);
    await workspaces.create(a, { id: WSP_A, name: 'Main', slug: 'main' });
    await workspaces.create(b, { id: WSP_B, name: 'Main', slug: 'main' });
    await workspaceMembers.add(a, {
      workspaceId: WSP_A,
      principalType: 'group',
      principalId: GRP_A,
      role: 'admin',
    });
    await workspaceMembers.add(b, {
      workspaceId: WSP_B,
      principalType: 'user',
      principalId: USER_B,
      role: 'admin',
    });
    baseA = await bases.create(a, { workspaceId: WSP_A, ownerId: USER_A, name: 'Base A' });
    baseB = await bases.create(b, { workspaceId: WSP_B, ownerId: USER_B, name: 'Base B' });
    await roles.create(a, {
      id: ROL_A,
      baseId: baseA.id,
      name: 'reader',
      kind: 'system_reader',
      config: {},
    });
    await roles.create(b, {
      id: ROL_B,
      baseId: baseB.id,
      name: 'reader',
      kind: 'system_reader',
      config: {},
    });
    await roleMembers.assign(a, {
      baseId: baseA.id,
      roleId: ROL_A,
      principalType: 'group',
      principalId: GRP_A,
    });
    await roleMembers.assign(b, {
      baseId: baseB.id,
      roleId: ROL_B,
      principalType: 'user',
      principalId: USER_B,
    });
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('OrgMembersRepository: pages, role changes, removal and owner locks stay in the scope', async () => {
    const pageA = await members.listPage(a, PAGE);
    expect(pageA.total).toBe(2);
    expect(pageA.items.map((m) => m.user.id).sort()).toEqual([USER_A, USER_A2].sort());
    expect(await members.getWithUser(a, USER_B)).toBeUndefined();
    expect(await members.updateRole(a, USER_B, 'member')).toBeUndefined();
    expect(await members.remove(a, USER_B)).toBeUndefined();
    expect(await members.roleOf(b, USER_B)).toBe('owner');
    expect(await db.withTx((tx) => members.lockOwners(orgScope(ORG_A, tx)))).toEqual([USER_A]);
  });

  it('GroupsRepository: reads and writes only groups of the scope', async () => {
    expect(await groups.getById(a, GRP_B)).toBeUndefined();
    expect((await groups.getById(a, GRP_A))?.member_count).toBe(1);
    const listA = await groups.list(a, PAGE);
    expect(listA.items.map((g) => g.id)).toEqual([GRP_A]);
    expect(listA.total).toBe(1);
    expect(await groups.findByName(a, 'SALES')).toMatchObject({ id: GRP_A });
    expect(await groups.rename(a, GRP_B, 'Hacked')).toBeUndefined();
    expect(await groups.delete(a, GRP_B)).toBeUndefined();
    expect(await groups.getById(b, GRP_B)).toMatchObject({ name: 'Sales' });
  });

  it('OrgMembersRepository.listWithUserByIds / GroupsRepository.listByIds: only rows of the scope', async () => {
    const found = await members.listWithUserByIds(a, [USER_A, USER_B, USER_A, USER_A2]);
    // Deduplicated, ordered by user ID (USER_A < USER_A2); USER_B is of B.
    expect(found.map((m) => [m.user.id, m.user.email])).toEqual([
      [USER_A, 'a@example.test'],
      [USER_A2, 'a2@example.test'],
    ]);
    expect(await members.listWithUserByIds(a, [USER_B])).toEqual([]);
    expect(await members.listWithUserByIds(a, [])).toEqual([]);
    expect((await groups.listByIds(a, [GRP_A, GRP_B])).map((g) => g.id)).toEqual([GRP_A]);
    expect(await groups.listByIds(a, [GRP_B])).toEqual([]);
    expect(await groups.listByIds(b, [])).toEqual([]);
  });

  it('GroupMembersRepository: members of another organization are invisible', async () => {
    expect((await groupMembers.list(a, GRP_B, PAGE)).items).toEqual([]);
    expect(await groupMembers.get(a, GRP_B, USER_B)).toBeUndefined();
    expect(await groupMembers.groupIdsOfUser(a, USER_B)).toEqual([]);
    expect(await groupMembers.remove(a, GRP_B, USER_B)).toBe(false);
    expect(await groupMembers.groupIdsOfUser(b, USER_B)).toEqual([GRP_B]);
    // A user of B cannot be put into a group of A (foreign key to org_members).
    await expect(groupMembers.add(a, GRP_A, USER_B)).rejects.toMatchObject({ code: '23503' });
    // Nor into B's group through A's scope.
    await expect(groupMembers.add(a, GRP_B, USER_A)).rejects.toMatchObject({ code: '23503' });
  });

  it('WorkspacesRepository: reads and writes only workspaces of the scope', async () => {
    expect(await workspaces.getById(a, WSP_B)).toBeUndefined();
    expect((await workspaces.list(a, PAGE)).items.map((w) => w.id)).toEqual([WSP_A]);
    expect((await workspaces.list(a, PAGE, { userId: USER_B, groupIds: [GRP_B] })).items).toEqual(
      [],
    );
    expect(
      (await workspaces.list(a, PAGE, { userId: USER_A2, groupIds: [GRP_A] })).items.map(
        (w) => w.id,
      ),
    ).toEqual([WSP_A]);
    expect(await workspaces.rename(a, WSP_B, 'Hacked')).toBeUndefined();
    expect(await workspaces.countBases(a, WSP_B)).toBe(0);
    expect(await workspaces.delete(a, WSP_B)).toBeUndefined();
    expect(await workspaces.slugExists(a, 'main')).toBe(true);
    expect(await workspaces.getById(b, WSP_B)).toMatchObject({ name: 'Main' });
  });

  it('GroupsRepository.create and WorkspacesRepository.create write into the scope only', async () => {
    const countOf = async (table: 'meta.groups' | 'meta.workspaces', org: string) =>
      Number(
        (
          await db.kysely
            .selectFrom(table)
            .select((eb) => eb.fn.countAll<string>().as('n'))
            .where('organization_id', '=', org as typeof ORG_A)
            .executeTakeFirstOrThrow()
        ).n,
      );
    const groupsOfB = await countOf('meta.groups', ORG_B);
    const workspacesOfB = await countOf('meta.workspaces', ORG_B);

    const group = await groups.create(a, { name: 'Created in A' });
    expect(group.organization_id).toBe(ORG_A);
    // The name exists only in A: B can use it, and A's scope never sees B's copy.
    const groupB = await groups.create(b, { name: 'Created in A' });
    expect(groupB.organization_id).toBe(ORG_B);
    expect(await groups.getById(a, groupB.id)).toBeUndefined();
    expect(await groups.findByName(a, 'created in a')).toMatchObject({ id: group.id });

    const workspace = await workspaces.create(a, { name: 'Second', slug: 'second' });
    expect(workspace.organization_id).toBe(ORG_A);
    expect(await workspaces.getById(b, workspace.id)).toBeUndefined();
    expect(await workspaces.slugExists(b, 'second')).toBe(false);

    expect(await countOf('meta.groups', ORG_B)).toBe(groupsOfB + 1);
    expect(await countOf('meta.workspaces', ORG_B)).toBe(workspacesOfB);
    await groups.delete(b, groupB.id);
    await groups.delete(a, group.id);
    await workspaces.delete(a, workspace.id);
  });

  it('WorkspaceMembersRepository: memberships of another organization are invisible', async () => {
    expect(await workspaceMembers.get(a, WSP_B, 'user', USER_B)).toBeUndefined();
    expect((await workspaceMembers.list(a, WSP_B, PAGE)).total).toBe(0);
    const listA = await workspaceMembers.list(a, WSP_A, PAGE);
    expect(listA.items).toEqual([
      expect.objectContaining({ principal_id: GRP_A, name: 'Sales', email: null, role: 'admin' }),
    ]);
    expect(await workspaceMembers.updateRole(a, WSP_B, 'user', USER_B, 'member')).toBeUndefined();
    expect(await workspaceMembers.remove(a, WSP_B, 'user', USER_B)).toBeUndefined();
    expect(await workspaceMembers.removeAllForPrincipal(a, 'user', USER_B)).toEqual([]);
    expect(await workspaceMembers.listForPrincipal(a, 'user', USER_B)).toEqual([]);
    expect(await workspaceMembers.rolesOf(a, { userId: USER_B, groupIds: [GRP_B] })).toEqual(
      new Map(),
    );
    expect(await workspaceMembers.rolesOf(a, { userId: USER_A2, groupIds: [GRP_A] })).toEqual(
      new Map([[WSP_A, 'admin']]),
    );
    // Cannot add a membership pointing at B's workspace through A's scope.
    await expect(
      workspaceMembers.add(a, {
        workspaceId: WSP_B,
        principalType: 'user',
        principalId: USER_A,
        role: 'admin',
      }),
    ).rejects.toMatchObject({ code: '23503' });
    expect(await workspaceMembers.get(b, WSP_B, 'user', USER_B)).toMatchObject({ role: 'admin' });
  });

  it('BasesRepository: pages, trash, ownership and permission versions stay in the scope', async () => {
    expect((await bases.listPage(a, WSP_B, PAGE)).items).toEqual([]);
    expect(
      (await bases.listPage(a, WSP_A, PAGE, { userId: USER_A2, groupIds: [GRP_A] })).items.map(
        (x) => x.id,
      ),
    ).toEqual([baseA.id]);
    expect((await bases.listPage(a, WSP_A, PAGE, { userId: USER_A2, groupIds: [] })).items).toEqual(
      [],
    );
    expect(await bases.softDelete(a, baseB.id)).toBeUndefined();
    expect(await bases.update(a, baseB.id, { ownerId: USER_A })).toBeUndefined();
    expect(await bases.idsOwnedBy(a, USER_B)).toEqual([]);
    expect(await bases.bumpPermissionVersion(a, { baseIds: [baseB.id] })).toBe(0);
    expect(await bases.bumpPermissionVersion(a, { workspaceIds: [WSP_B] })).toBe(0);
    expect(await bases.bumpPermissionVersion(a, { all: true })).toBe(1);
    expect((await bases.getById(b, baseB.id))?.permission_version).toBe(1n);
    expect((await bases.getById(a, baseA.id))?.permission_version).toBe(2n);
    const transferred = await bases.update(a, baseA.id, { ownerId: USER_A2 });
    expect(transferred).toMatchObject({ owner_id: USER_A2, permission_version: 3n });
  });

  it('BasesRepository.restore / listPage(includeDeleted): only bases of the scope', async () => {
    const trashedA = await bases.create(a, { workspaceId: WSP_A, ownerId: USER_A2, name: 'Old A' });
    const otherA = await bases.create(a, { workspaceId: WSP_A, ownerId: USER_A, name: 'Old A2' });
    const trashedB = await bases.create(b, { workspaceId: WSP_B, ownerId: USER_B, name: 'Old B' });
    for (const [scope, id] of [
      [a, trashedA.id],
      [a, otherA.id],
      [b, trashedB.id],
    ] as const) {
      await bases.softDelete(scope, id);
    }
    const ids = async (scope: OrgScope, workspaceId: Id<'wsp'>, visibleTo?: Id<'usr'>) =>
      (
        await bases.listPage(
          scope,
          workspaceId,
          PAGE,
          visibleTo === undefined ? undefined : { userId: visibleTo, groupIds: [] },
          { includeDeleted: true },
        )
      ).items.map((item) => item.id);
    expect(await ids(a, WSP_B)).toEqual([]);
    expect((await ids(a, WSP_A)).sort()).toEqual([baseA.id, trashedA.id, otherA.id].sort());
    // A non-admin sees the trashed bases they own only.
    expect(await ids(a, WSP_A, USER_A2)).toContain(trashedA.id);
    expect(await ids(a, WSP_A, USER_A2)).not.toContain(otherA.id);
    expect((await bases.listPage(a, WSP_A, PAGE)).items.map((item) => item.id)).toEqual([baseA.id]);

    expect(await bases.restore(a, trashedB.id)).toBeUndefined();
    expect((await bases.getById(b, trashedB.id, { includeDeleted: true }))?.deleted_at).not.toBe(
      null,
    );
    const restored = await bases.restore(a, trashedA.id);
    expect(restored).toMatchObject({ id: trashedA.id, deleted_at: null, permission_version: 2n });
    // Outside the trash: nothing to restore.
    expect(await bases.restore(a, trashedA.id)).toBeUndefined();
    expect(await bases.restore(b, trashedB.id)).toMatchObject({ deleted_at: null });
  });

  it('BasesRepository.lockIdsOwnedBy / transferOwnership: only bases of the scope, trash included', async () => {
    const trashed = await bases.create(a, { workspaceId: WSP_A, ownerId: USER_B, name: 'Trashed' });
    await bases.softDelete(a, trashed.id);
    const inB = await bases.create(b, { workspaceId: WSP_B, ownerId: USER_B, name: 'In B' });
    const locked = await db.withTx((tx) => bases.lockIdsOwnedBy(orgScope(ORG_A, tx), USER_B));
    expect(locked).toEqual([trashed.id]);
    const moved = await bases.transferOwnership(a, USER_B, USER_A);
    expect(moved.map((base) => [base.id, base.owner_id])).toEqual([[trashed.id, USER_A]]);
    expect(moved[0]?.permission_version).toBe(trashed.permission_version + 1n);
    expect((await bases.getById(b, inB.id))?.owner_id).toBe(USER_B);
    expect(await bases.transferOwnership(a, USER_B, USER_A)).toEqual([]);
    await db.kysely
      .deleteFrom('meta.base_roles')
      .where('base_id', 'in', [trashed.id, inB.id])
      .execute();
    await db.kysely.deleteFrom('meta.bases').where('id', 'in', [trashed.id, inB.id]).execute();
  });

  it('BaseRolesRepository and BaseRoleMembersRepository: roles of another organization are invisible', async () => {
    expect(await roles.listByBase(a, baseB.id)).toEqual([]);
    expect((await roles.listByBase(a, baseA.id)).map((r) => r.id)).toEqual([ROL_A]);
    expect(await roleMembers.listByBase(a, baseB.id)).toEqual([]);
    expect(await roleMembers.baseIdsForPrincipal(a, { userId: USER_B, groupIds: [GRP_B] })).toEqual(
      [],
    );
    expect(await roleMembers.baseIdsForGroup(a, GRP_B)).toEqual([]);
    expect(await roleMembers.baseIdsForGroup(a, GRP_A)).toEqual([baseA.id]);
    expect(await roleMembers.removeAllForPrincipal(a, 'user', USER_B)).toEqual([]);
    expect(await roleMembers.listByBase(b, baseB.id)).toHaveLength(1);
    // A role of B cannot be assigned or created through A's scope.
    await expect(
      roleMembers.assign(a, {
        baseId: baseB.id,
        roleId: ROL_B,
        principalType: 'user',
        principalId: USER_A,
      }),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      roles.create(a, { baseId: baseB.id, name: 'x', kind: 'custom', config: {} }),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('BaseRolesRepository.baseIdsUsingGroupsVariable: only roles of the scope that use the variable', async () => {
    const groupsFilter = {
      tables: {
        tbl_x: {
          perm: 'read',
          record_rule: {
            read_scope: 'filter',
            read_filter: {
              op: 'and',
              items: [
                {
                  field: 'fld_x',
                  operator: 'has_any_of',
                  value: [{ $var: 'current_user_groups' }],
                },
              ],
            },
          },
        },
      },
    };
    const textOnly = { note: 'current_user_groups', $var: 'current_user' };
    const roleB = await roles.create(b, {
      baseId: baseB.id,
      name: 'Groups B',
      kind: 'custom',
      config: groupsFilter,
    });
    const plainA = await roles.create(a, {
      baseId: baseA.id,
      name: 'Plain A',
      kind: 'custom',
      config: textOnly,
    });
    expect(await roles.baseIdsUsingGroupsVariable(a)).toEqual([]);
    expect(await roles.baseIdsUsingGroupsVariable(b)).toEqual([baseB.id]);
    const roleA = await roles.create(a, {
      baseId: baseA.id,
      name: 'Groups A',
      kind: 'custom',
      config: groupsFilter,
    });
    expect(await roles.baseIdsUsingGroupsVariable(a)).toEqual([baseA.id]);
    for (const [scope, baseId, roleId] of [
      [a, baseA.id, roleA.id],
      [a, baseA.id, plainA.id],
      [b, baseB.id, roleB.id],
    ] as const) {
      await roles.delete(scope, baseId, roleId);
    }
  });

  it('BasesRepository.lockForUpdate: only bases of the scope', async () => {
    expect(await bases.lockForUpdate(a, baseB.id)).toBeUndefined();
    await db.withTx(async (tx) => {
      expect(await bases.lockForUpdate(orgScope(ORG_A, tx), baseA.id)).toMatchObject({
        id: baseA.id,
      });
      expect(await bases.lockForUpdate(orgScope(ORG_A, tx), baseB.id)).toBeUndefined();
    });
  });

  it('BaseRolesRepository and BaseRoleMembersRepository (T109 methods): another organization is invisible and untouched', async () => {
    // Reads through A's scope never see B's role or assignment, even with B's IDs.
    expect(await roles.getById(a, baseB.id, ROL_B)).toBeUndefined();
    expect(await roles.getById(a, baseA.id, ROL_B)).toBeUndefined();
    expect(await roles.getById(a, baseA.id, ROL_A)).toMatchObject({ id: ROL_A });
    expect(await roles.findByName(a, baseB.id, 'READER')).toBeUndefined();
    expect(await roles.findByName(a, baseA.id, 'READER')).toMatchObject({ id: ROL_A });
    expect(await roles.findByName(a, baseA.id, 'reader', ROL_A)).toBeUndefined();
    expect(await roles.nextPosition(a, baseB.id)).toBe(0);
    expect(await roleMembers.getForPrincipal(a, baseB.id, 'user', USER_B)).toBeUndefined();
    expect(await roleMembers.countByRole(a, baseB.id, ROL_B)).toBe(0);
    expect(await roleMembers.countByRole(b, baseB.id, ROL_B)).toBe(1);

    // Writes through A's scope leave B's rows alone.
    expect(await roles.update(a, baseB.id, ROL_B, { name: 'hijacked' })).toBeUndefined();
    expect(await roleMembers.remove(a, baseB.id, 'user', USER_B)).toBeUndefined();
    expect(await roles.delete(a, baseB.id, ROL_B)).toBeUndefined();
    expect(await roles.getById(b, baseB.id, ROL_B)).toMatchObject({ name: 'reader' });
    expect(await roleMembers.getForPrincipal(b, baseB.id, 'user', USER_B)).toMatchObject({
      role_id: ROL_B,
    });

    // Within the own organization they work.
    const custom = await roles.create(a, {
      baseId: baseA.id,
      name: 'Custom',
      kind: 'custom',
      config: {},
      position: await roles.nextPosition(a, baseA.id),
    });
    expect(custom.position).toBe(1);
    expect(await roles.update(a, baseA.id, custom.id, { name: 'Renamed' })).toMatchObject({
      name: 'Renamed',
    });
    await roleMembers.assign(a, {
      baseId: baseA.id,
      roleId: custom.id,
      principalType: 'user',
      principalId: USER_A2,
    });
    expect(await roleMembers.countByRole(a, baseA.id, custom.id)).toBe(1);
    expect(await roleMembers.remove(a, baseA.id, 'user', USER_A2)).toMatchObject({
      role_id: custom.id,
    });
    expect(await roles.delete(a, baseA.id, custom.id)).toMatchObject({ id: custom.id });
    expect(await roles.getById(a, baseA.id, custom.id)).toBeUndefined();
  });

  it('InvitationsRepository: invitations of another organization are invisible', async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const invA = await invitations.create(a, {
      email: 'new@example.test',
      inviterId: USER_A,
      orgRole: 'member',
      workspaceId: WSP_A,
      tokenHash: 'hash-a',
      expiresAt,
    });
    const invB = await invitations.create(b, {
      email: 'new@example.test',
      inviterId: USER_B,
      orgRole: 'admin',
      workspaceId: null,
      tokenHash: 'hash-b',
      expiresAt,
    });
    expect(await invitations.getById(a, invB.id)).toBeUndefined();
    expect(await invitations.findByTokenHash(a, 'hash-b')).toBeUndefined();
    expect((await invitations.list(a, PAGE)).items.map((i) => i.id)).toEqual([invA.id]);
    expect(await invitations.revoke(a, invB.id)).toBeUndefined();
    expect(await invitations.markAccepted(a, invB.id)).toBeUndefined();
    expect(invitationStateOf((await invitations.getById(b, invB.id)) as typeof invB)).toBe(
      'pending',
    );
    // The token lookup is the documented cross-tenant exception: it returns the organization only.
    expect(await findInvitationOrganization(db.kysely, 'hash-b')).toBe(ORG_B);
    expect(await findInvitationOrganization(db.kysely, 'nope')).toBeUndefined();
    // A's invitation cannot reference B's workspace.
    await expect(
      invitations.create(a, {
        email: 'x@example.test',
        inviterId: USER_A,
        orgRole: 'member',
        workspaceId: WSP_B,
        tokenHash: 'hash-x',
        expiresAt,
      }),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('InvitationsRepository.revokePendingByInviter: only pending invitations of the scope', async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const create = (scope: OrgScope, tokenHash: string, expires = expiresAt) =>
      invitations.create(scope, {
        email: `${tokenHash}@example.test`,
        inviterId: USER_B,
        orgRole: 'admin',
        workspaceId: null,
        tokenHash,
        expiresAt: expires,
      });
    const pendingA = await create(a, 'by-b-in-a');
    const expiredA = await create(a, 'by-b-in-a-expired', new Date(Date.now() - 1000));
    const pendingB = await create(b, 'by-b-in-b');
    const revoked = await invitations.revokePendingByInviter(a, USER_B);
    expect(revoked.map((row) => row.id)).toEqual([pendingA.id]);
    expect(await invitations.revokePendingByInviter(a, USER_B)).toEqual([]);
    const stateOf = async (scope: OrgScope, id: typeof pendingA.id) =>
      invitationStateOf((await invitations.getById(scope, id)) as typeof pendingA);
    expect(await stateOf(a, pendingA.id)).toBe('revoked');
    expect(await stateOf(a, expiredA.id)).toBe('expired');
    expect(await stateOf(b, pendingB.id)).toBe('pending');
    // Leave no rows behind for the state filters below.
    await db.kysely
      .deleteFrom('meta.invitations')
      .where('id', 'in', [pendingA.id, expiredA.id, pendingB.id])
      .execute();
  });

  it('InvitationsRepository: states, filters, accept and revoke', async () => {
    const make = (tokenHash: string, expiresAt: Date) =>
      invitations.create(a, {
        email: `${tokenHash}@example.test`,
        inviterId: USER_A,
        orgRole: 'member',
        workspaceId: null,
        tokenHash,
        expiresAt,
      });
    const expired = await make('s-expired', new Date(Date.now() - 1000));
    const toAccept = await make('s-accept', new Date(Date.now() + 60_000));
    const toRevoke = await make('s-revoke', new Date(Date.now() + 60_000));
    expect(await invitations.markAccepted(a, expired.id)).toBeUndefined();
    expect(await invitations.markAccepted(a, toAccept.id)).toMatchObject({ id: toAccept.id });
    expect(await invitations.markAccepted(a, toAccept.id)).toBeUndefined();
    expect(await invitations.revoke(a, toAccept.id)).toBeUndefined();
    expect(await invitations.revoke(a, toRevoke.id)).toMatchObject({ id: toRevoke.id });
    const ids = async (state: 'pending' | 'accepted' | 'revoked' | 'expired') =>
      (await invitations.list(a, PAGE, state)).items.map((i) => i.id);
    expect(await ids('expired')).toEqual([expired.id]);
    expect(await ids('accepted')).toEqual([toAccept.id]);
    expect(await ids('revoked')).toEqual([toRevoke.id]);
    expect(await ids('pending')).not.toContain(toAccept.id);
    const locked = await db.withTx((tx) =>
      invitations.findByTokenHash(orgScope(ORG_A, tx), 's-accept', { forUpdate: true }),
    );
    expect(locked?.id).toBe(toAccept.id);
  });
});
