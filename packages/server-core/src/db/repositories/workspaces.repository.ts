import { newId, type Id } from '@cellhive/contracts';
import { sql } from 'kysely';

import { countOf, type Page, type PageRequest } from '../page.js';
import { principalMatches, type PrincipalRef } from '../principal.js';
import { TenantRepository, type OrgScope, type TenantRepositoryContract } from '../repository.js';

import type { Db } from '../create-db.js';
import type { PrincipalType, Workspace, WorkspaceMember, WorkspaceRole } from '../schema.js';

/** A workspace member with a display name (user display name or group name). */
export interface WorkspaceMemberWithName extends WorkspaceMember {
  readonly name: string;
  /** The user's email; `null` for a group. */
  readonly email: string | null;
}

/**
 * `meta.workspaces`. Every query is scoped by `organization_id`; a workspace
 * of another organization behaves exactly like a missing one.
 */
export class WorkspacesRepository
  extends TenantRepository<'workspaces'>
  implements TenantRepositoryContract<WorkspacesRepository>
{
  constructor(db: Db) {
    super(db, 'workspaces');
  }

  async create(
    scope: OrgScope,
    input: { id?: Id<'wsp'>; name: string; slug: string },
  ): Promise<Workspace> {
    return this.executor(scope)
      .insertInto('meta.workspaces')
      .values({
        id: input.id ?? newId('wsp'),
        organization_id: scope.organizationId,
        name: input.name,
        slug: input.slug,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async getById(scope: OrgScope, id: Id<'wsp'>): Promise<Workspace | undefined> {
    return this.executor(scope)
      .selectFrom('meta.workspaces')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
  }

  async slugExists(scope: OrgScope, slug: string): Promise<boolean> {
    const row = await this.executor(scope)
      .selectFrom('meta.workspaces')
      .select('id')
      .where('organization_id', '=', scope.organizationId)
      .where('slug', '=', slug)
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * One page of workspaces by name. With `visibleTo`, only those where the
   * principal is a member (directly or through a group) or that contain a
   * base outside the trash the principal owns or has a role in. With
   * `containingBaseIds` (an API token's `base_ids`, ADR-36 §1), also only
   * those that contain one of these bases outside the trash; `[]` lists none.
   */
  async list(
    scope: OrgScope,
    page: PageRequest,
    visibleTo?: PrincipalRef,
    options: { readonly containingBaseIds?: readonly Id<'bse'>[] } = {},
  ): Promise<Page<Workspace>> {
    const { containingBaseIds } = options;
    if (containingBaseIds?.length === 0) return { items: [], total: 0 };
    const base = () => {
      let query = this.executor(scope)
        .selectFrom('meta.workspaces as w')
        .where('w.organization_id', '=', scope.organizationId);
      if (containingBaseIds !== undefined) {
        query = query.where((eb) =>
          eb.exists(
            eb
              .selectFrom('meta.bases as b')
              .select(sql<number>`1`.as('one'))
              .where('b.organization_id', '=', scope.organizationId)
              .whereRef('b.workspace_id', '=', 'w.id')
              .where('b.deleted_at', 'is', null)
              .where('b.id', 'in', containingBaseIds),
          ),
        );
      }
      if (visibleTo !== undefined) {
        query = query.where((eb) =>
          eb.or([
            eb.exists(
              eb
                .selectFrom('meta.workspace_members')
                .select(sql<number>`1`.as('one'))
                .where('organization_id', '=', scope.organizationId)
                .whereRef('workspace_id', '=', 'w.id')
                .where(principalMatches('meta.workspace_members', visibleTo)),
            ),
            eb.exists(
              eb
                .selectFrom('meta.bases as b')
                .select(sql<number>`1`.as('one'))
                .where('b.organization_id', '=', scope.organizationId)
                .whereRef('b.workspace_id', '=', 'w.id')
                .where('b.deleted_at', 'is', null)
                .where((inner) =>
                  inner.or([
                    inner('b.owner_id', '=', visibleTo.userId),
                    inner.exists(
                      inner
                        .selectFrom('meta.base_role_members')
                        .select(sql<number>`1`.as('one'))
                        .where('organization_id', '=', scope.organizationId)
                        .whereRef('base_id', '=', 'b.id')
                        .where(principalMatches('meta.base_role_members', visibleTo)),
                    ),
                  ]),
                ),
            ),
          ]),
        );
      }
      return query;
    };
    const rows = await base()
      .selectAll('w')
      .orderBy(sql`lower(w.name)`)
      .orderBy('w.id')
      .offset(page.offset)
      .limit(page.limit)
      .execute();
    const total = await base()
      .select((eb) => eb.fn.countAll().as('count'))
      .executeTakeFirst();
    return { items: rows, total: countOf(total) };
  }

  async rename(scope: OrgScope, id: Id<'wsp'>, name: string): Promise<Workspace | undefined> {
    return this.executor(scope)
      .updateTable('meta.workspaces')
      .set({ name })
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
  }

  /** Number of bases in the workspace, those in the trash included. */
  async countBases(scope: OrgScope, id: Id<'wsp'>): Promise<number> {
    const row = await this.executor(scope)
      .selectFrom('meta.bases')
      .select((eb) => eb.fn.countAll().as('count'))
      .where('organization_id', '=', scope.organizationId)
      .where('workspace_id', '=', id)
      .executeTakeFirst();
    return countOf(row);
  }

  /**
   * Deletes a workspace without bases (the foreign key refuses otherwise);
   * its members and invitations cascade. Returns the deleted row.
   */
  async delete(scope: OrgScope, id: Id<'wsp'>): Promise<Workspace | undefined> {
    return this.executor(scope)
      .deleteFrom('meta.workspaces')
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
  }
}

const WORKSPACE_ROLE_RANK: Record<WorkspaceRole, number> = { member: 0, admin: 1 };

/** The higher of two workspace roles. */
export function maxWorkspaceRole(
  a: WorkspaceRole | null,
  b: WorkspaceRole | null,
): WorkspaceRole | null {
  if (a === null) return b;
  if (b === null) return a;
  return WORKSPACE_ROLE_RANK[a] >= WORKSPACE_ROLE_RANK[b] ? a : b;
}

/**
 * `meta.workspace_members`: users and groups of the organization with a role
 * in a workspace. `principal_id` has no foreign key (it points at a user or
 * a group), so removing a member of the organization or deleting a group
 * must call `removeAllForPrincipal`.
 */
export class WorkspaceMembersRepository
  extends TenantRepository<'workspace_members'>
  implements TenantRepositoryContract<WorkspaceMembersRepository>
{
  constructor(db: Db) {
    super(db, 'workspace_members');
  }

  /** Adds a membership; `undefined` when the principal already is a member. */
  async add(
    scope: OrgScope,
    input: {
      workspaceId: Id<'wsp'>;
      principalType: PrincipalType;
      principalId: Id<'usr'> | Id<'grp'>;
      role: WorkspaceRole;
    },
  ): Promise<WorkspaceMember | undefined> {
    return this.executor(scope)
      .insertInto('meta.workspace_members')
      .values({
        organization_id: scope.organizationId,
        workspace_id: input.workspaceId,
        principal_type: input.principalType,
        principal_id: input.principalId,
        role: input.role,
      })
      .onConflict((oc) =>
        oc.columns(['workspace_id', 'principal_type', 'principal_id']).doNothing(),
      )
      .returningAll()
      .executeTakeFirst();
  }

  private withNameQuery(scope: OrgScope) {
    return this.executor(scope)
      .selectFrom('meta.workspace_members as wm')
      .leftJoin('meta.users as u', (join) =>
        join.onRef('u.id', '=', 'wm.principal_id').on('wm.principal_type', '=', 'user'),
      )
      .leftJoin('meta.groups as g', (join) =>
        join
          .onRef('g.id', '=', 'wm.principal_id')
          .onRef('g.organization_id', '=', 'wm.organization_id')
          .on('wm.principal_type', '=', 'group'),
      )
      .selectAll('wm')
      .select([sql<string>`coalesce(u.display_name, g.name, '')`.as('name'), 'u.email as email'])
      .where('wm.organization_id', '=', scope.organizationId);
  }

  async get(
    scope: OrgScope,
    workspaceId: Id<'wsp'>,
    principalType: PrincipalType,
    principalId: Id<'usr'> | Id<'grp'>,
  ): Promise<WorkspaceMemberWithName | undefined> {
    return this.withNameQuery(scope)
      .where('wm.workspace_id', '=', workspaceId)
      .where('wm.principal_type', '=', principalType)
      .where('wm.principal_id', '=', principalId)
      .executeTakeFirst();
  }

  /** One page of members of a workspace, oldest first. */
  async list(
    scope: OrgScope,
    workspaceId: Id<'wsp'>,
    page: PageRequest,
  ): Promise<Page<WorkspaceMemberWithName>> {
    const rows = await this.withNameQuery(scope)
      .where('wm.workspace_id', '=', workspaceId)
      .orderBy('wm.created_at')
      .orderBy('wm.principal_type')
      .orderBy('wm.principal_id')
      .offset(page.offset)
      .limit(page.limit)
      .execute();
    const total = await this.executor(scope)
      .selectFrom('meta.workspace_members')
      .select((eb) => eb.fn.countAll().as('count'))
      .where('organization_id', '=', scope.organizationId)
      .where('workspace_id', '=', workspaceId)
      .executeTakeFirst();
    return { items: rows, total: countOf(total) };
  }

  async updateRole(
    scope: OrgScope,
    workspaceId: Id<'wsp'>,
    principalType: PrincipalType,
    principalId: Id<'usr'> | Id<'grp'>,
    role: WorkspaceRole,
  ): Promise<WorkspaceMember | undefined> {
    return this.executor(scope)
      .updateTable('meta.workspace_members')
      .set({ role })
      .where('organization_id', '=', scope.organizationId)
      .where('workspace_id', '=', workspaceId)
      .where('principal_type', '=', principalType)
      .where('principal_id', '=', principalId)
      .returningAll()
      .executeTakeFirst();
  }

  async remove(
    scope: OrgScope,
    workspaceId: Id<'wsp'>,
    principalType: PrincipalType,
    principalId: Id<'usr'> | Id<'grp'>,
  ): Promise<WorkspaceMember | undefined> {
    return this.executor(scope)
      .deleteFrom('meta.workspace_members')
      .where('organization_id', '=', scope.organizationId)
      .where('workspace_id', '=', workspaceId)
      .where('principal_type', '=', principalType)
      .where('principal_id', '=', principalId)
      .returningAll()
      .executeTakeFirst();
  }

  /** Removes every workspace membership of a user or group; returns the removed rows. */
  async removeAllForPrincipal(
    scope: OrgScope,
    principalType: PrincipalType,
    principalId: Id<'usr'> | Id<'grp'>,
  ): Promise<WorkspaceMember[]> {
    return this.executor(scope)
      .deleteFrom('meta.workspace_members')
      .where('organization_id', '=', scope.organizationId)
      .where('principal_type', '=', principalType)
      .where('principal_id', '=', principalId)
      .returningAll()
      .execute();
  }

  /** Memberships of a group, e.g. to find the workspaces it administers. */
  async listForPrincipal(
    scope: OrgScope,
    principalType: PrincipalType,
    principalId: Id<'usr'> | Id<'grp'>,
  ): Promise<WorkspaceMember[]> {
    return this.executor(scope)
      .selectFrom('meta.workspace_members')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('principal_type', '=', principalType)
      .where('principal_id', '=', principalId)
      .execute();
  }

  /**
   * The principal's role in each workspace, directly or through a group
   * (the higher role wins). Only workspaces with a membership are present.
   */
  async rolesOf(
    scope: OrgScope,
    principal: PrincipalRef,
    workspaceIds?: readonly Id<'wsp'>[],
  ): Promise<Map<Id<'wsp'>, WorkspaceRole>> {
    if (workspaceIds?.length === 0) return new Map();
    let query = this.executor(scope)
      .selectFrom('meta.workspace_members')
      .select(['workspace_id', 'role'])
      .where('organization_id', '=', scope.organizationId)
      .where(principalMatches('meta.workspace_members', principal));
    if (workspaceIds !== undefined) query = query.where('workspace_id', 'in', workspaceIds);
    const rows = await query.execute();
    const roles = new Map<Id<'wsp'>, WorkspaceRole>();
    for (const row of rows) {
      roles.set(
        row.workspace_id,
        maxWorkspaceRole(roles.get(row.workspace_id) ?? null, row.role) ?? row.role,
      );
    }
    return roles;
  }
}
