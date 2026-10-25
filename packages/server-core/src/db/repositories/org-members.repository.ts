import { countOf, type Page, type PageRequest } from '../page.js';
import { TenantRepository, type OrgScope, type TenantRepositoryContract } from '../repository.js';

import type { Db } from '../create-db.js';
import type { OrgMember, OrgRole, User } from '../schema.js';
import type { Id } from '@cellhive/contracts';

/** A member with the user fields shown in member lists. */
export interface OrgMemberWithUser extends OrgMember {
  readonly user: Pick<User, 'id' | 'email' | 'display_name' | 'avatar_url'>;
}

/**
 * `meta.org_members`. Every query is scoped by `organization_id`; a member of
 * another organization behaves exactly like a missing one.
 */
export class OrgMembersRepository
  extends TenantRepository<'org_members'>
  implements TenantRepositoryContract<OrgMembersRepository>
{
  constructor(db: Db) {
    super(db, 'org_members');
  }

  async add(scope: OrgScope, userId: Id<'usr'>, role: OrgRole): Promise<OrgMember> {
    return this.executor(scope)
      .insertInto('meta.org_members')
      .values({ organization_id: scope.organizationId, user_id: userId, role })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async get(scope: OrgScope, userId: Id<'usr'>): Promise<OrgMember | undefined> {
    return this.executor(scope)
      .selectFrom('meta.org_members')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
  }

  /** The user's role in this organization, or `undefined` when not a member. */
  async roleOf(scope: OrgScope, userId: Id<'usr'>): Promise<OrgRole | undefined> {
    return (await this.get(scope, userId))?.role;
  }

  /**
   * The user's role, with the membership row locked `FOR SHARE` until the
   * end of the scope's transaction (a concurrent demotion or removal
   * waits); `undefined` when not a member.
   */
  async lockRole(scope: OrgScope, userId: Id<'usr'>): Promise<OrgRole | undefined> {
    const row = await this.executor(scope)
      .selectFrom('meta.org_members')
      .select('role')
      .where('organization_id', '=', scope.organizationId)
      .where('user_id', '=', userId)
      .forShare()
      .executeTakeFirst();
    return row?.role;
  }

  /** Members of this organization, oldest first. */
  async list(scope: OrgScope): Promise<OrgMember[]> {
    return this.executor(scope)
      .selectFrom('meta.org_members')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .orderBy('created_at')
      .orderBy('user_id')
      .execute();
  }

  private withUserQuery(scope: OrgScope) {
    return this.executor(scope)
      .selectFrom('meta.org_members as m')
      .innerJoin('meta.users as u', 'u.id', 'm.user_id')
      .select([
        'm.organization_id',
        'm.user_id',
        'm.role',
        'm.created_at',
        'm.updated_at',
        'u.email',
        'u.display_name',
        'u.avatar_url',
      ])
      .where('m.organization_id', '=', scope.organizationId);
  }

  private static toMemberWithUser(row: {
    organization_id: Id<'org'>;
    user_id: Id<'usr'>;
    role: OrgRole;
    created_at: Date;
    updated_at: Date;
    email: string;
    display_name: string;
    avatar_url: string | null;
  }): OrgMemberWithUser {
    return {
      organization_id: row.organization_id,
      user_id: row.user_id,
      role: row.role,
      created_at: row.created_at,
      updated_at: row.updated_at,
      user: {
        id: row.user_id,
        email: row.email,
        display_name: row.display_name,
        avatar_url: row.avatar_url,
      },
    };
  }

  /** One page of members with their user, oldest first. */
  async listPage(scope: OrgScope, page: PageRequest): Promise<Page<OrgMemberWithUser>> {
    const rows = await this.withUserQuery(scope)
      .orderBy('m.created_at')
      .orderBy('m.user_id')
      .offset(page.offset)
      .limit(page.limit)
      .execute();
    const total = await this.executor(scope)
      .selectFrom('meta.org_members')
      .select((eb) => eb.fn.countAll().as('count'))
      .where('organization_id', '=', scope.organizationId)
      .executeTakeFirst();
    return {
      items: rows.map((row) => OrgMembersRepository.toMemberWithUser(row)),
      total: countOf(total),
    };
  }

  async getWithUser(scope: OrgScope, userId: Id<'usr'>): Promise<OrgMemberWithUser | undefined> {
    const row = await this.withUserQuery(scope).where('m.user_id', '=', userId).executeTakeFirst();
    return row === undefined ? undefined : OrgMembersRepository.toMemberWithUser(row);
  }

  /**
   * Members of this organization among `userIds`, with their user (batched
   * lookup, e.g. to name role assignments). IDs that are not members of this
   * organization are simply absent.
   */
  async listWithUserByIds(
    scope: OrgScope,
    userIds: readonly Id<'usr'>[],
  ): Promise<OrgMemberWithUser[]> {
    if (userIds.length === 0) return [];
    const rows = await this.withUserQuery(scope)
      .where('m.user_id', 'in', [...new Set(userIds)])
      .orderBy('m.user_id')
      .execute();
    return rows.map((row) => OrgMembersRepository.toMemberWithUser(row));
  }

  /**
   * Locks every owner row of the organization (`FOR UPDATE`) and returns the
   * owners' user IDs. Call it in the transaction that demotes or removes a
   * member, before checking "last owner": concurrent changes then serialise.
   */
  async lockOwners(scope: OrgScope): Promise<Id<'usr'>[]> {
    const rows = await this.executor(scope)
      .selectFrom('meta.org_members')
      .select('user_id')
      .where('organization_id', '=', scope.organizationId)
      .where('role', '=', 'owner')
      .orderBy('user_id')
      .forUpdate()
      .execute();
    return rows.map((row) => row.user_id);
  }

  /** Changes a member's role; `undefined` when not a member. */
  async updateRole(
    scope: OrgScope,
    userId: Id<'usr'>,
    role: OrgRole,
  ): Promise<OrgMember | undefined> {
    return this.executor(scope)
      .updateTable('meta.org_members')
      .set({ role })
      .where('organization_id', '=', scope.organizationId)
      .where('user_id', '=', userId)
      .returningAll()
      .executeTakeFirst();
  }

  /**
   * Removes a member; group memberships of the user in this organization
   * cascade. Returns the removed row, `undefined` when not a member.
   */
  async remove(scope: OrgScope, userId: Id<'usr'>): Promise<OrgMember | undefined> {
    return this.executor(scope)
      .deleteFrom('meta.org_members')
      .where('organization_id', '=', scope.organizationId)
      .where('user_id', '=', userId)
      .returningAll()
      .executeTakeFirst();
  }
}
