import { newId, type Id } from '@cellhive/contracts';
import { sql } from 'kysely';

import { countOf, type Page, type PageRequest } from '../page.js';
import { TenantRepository, type OrgScope, type TenantRepositoryContract } from '../repository.js';

import type { Db } from '../create-db.js';
import type { Group, User } from '../schema.js';

/** A group with its number of members. */
export interface GroupWithCount extends Group {
  readonly member_count: number;
}

/** A member of a group with the user fields shown in lists. */
export interface GroupMemberWithUser {
  readonly group_id: Id<'grp'>;
  readonly user: Pick<User, 'id' | 'email' | 'display_name' | 'avatar_url'>;
  readonly created_at: Date;
}

/**
 * `meta.groups`. Every query is scoped by `organization_id`; a group of
 * another organization behaves exactly like a missing one.
 */
export class GroupsRepository
  extends TenantRepository<'groups'>
  implements TenantRepositoryContract<GroupsRepository>
{
  constructor(db: Db) {
    super(db, 'groups');
  }

  async create(scope: OrgScope, input: { id?: Id<'grp'>; name: string }): Promise<Group> {
    return this.executor(scope)
      .insertInto('meta.groups')
      .values({
        id: input.id ?? newId('grp'),
        organization_id: scope.organizationId,
        name: input.name,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  private withCountQuery(scope: OrgScope) {
    return this.executor(scope)
      .selectFrom('meta.groups as g')
      .selectAll('g')
      .select((eb) =>
        eb
          .selectFrom('meta.group_members as gm')
          .select((inner) => inner.fn.countAll().as('count'))
          .whereRef('gm.group_id', '=', 'g.id')
          .whereRef('gm.organization_id', '=', 'g.organization_id')
          .as('member_count'),
      )
      .where('g.organization_id', '=', scope.organizationId);
  }

  private static withCount(row: Group & { member_count: unknown }): GroupWithCount {
    return { ...row, member_count: Number(row.member_count ?? 0) };
  }

  async getById(scope: OrgScope, id: Id<'grp'>): Promise<GroupWithCount | undefined> {
    const row = await this.withCountQuery(scope).where('g.id', '=', id).executeTakeFirst();
    return row === undefined ? undefined : GroupsRepository.withCount(row);
  }

  /**
   * The groups of this organization among `ids` (batched lookup, e.g. to
   * name role assignments). IDs of other organizations are simply absent.
   */
  async listByIds(scope: OrgScope, ids: readonly Id<'grp'>[]): Promise<Group[]> {
    if (ids.length === 0) return [];
    return this.executor(scope)
      .selectFrom('meta.groups')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('id', 'in', [...new Set(ids)])
      .orderBy('id')
      .execute();
  }

  /** A group whose name equals `name` ignoring case, optionally other than `exceptId`. */
  async findByName(
    scope: OrgScope,
    name: string,
    exceptId?: Id<'grp'>,
  ): Promise<Group | undefined> {
    let query = this.executor(scope)
      .selectFrom('meta.groups')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where(sql<string>`lower(name)`, '=', name.toLowerCase());
    if (exceptId !== undefined) query = query.where('id', '<>', exceptId);
    return query.executeTakeFirst();
  }

  /** One page of groups, by name. */
  async list(scope: OrgScope, page: PageRequest): Promise<Page<GroupWithCount>> {
    const rows = await this.withCountQuery(scope)
      .orderBy(sql`lower(g.name)`)
      .orderBy('g.id')
      .offset(page.offset)
      .limit(page.limit)
      .execute();
    const total = await this.executor(scope)
      .selectFrom('meta.groups')
      .select((eb) => eb.fn.countAll().as('count'))
      .where('organization_id', '=', scope.organizationId)
      .executeTakeFirst();
    return {
      items: rows.map((row) => GroupsRepository.withCount(row)),
      total: countOf(total),
    };
  }

  async rename(scope: OrgScope, id: Id<'grp'>, name: string): Promise<Group | undefined> {
    return this.executor(scope)
      .updateTable('meta.groups')
      .set({ name })
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
  }

  /** Deletes a group; its member rows cascade. Returns the deleted row. */
  async delete(scope: OrgScope, id: Id<'grp'>): Promise<Group | undefined> {
    return this.executor(scope)
      .deleteFrom('meta.groups')
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
  }
}

/**
 * `meta.group_members`. Only members of the organization can be added (the
 * foreign key to `org_members` enforces it).
 */
export class GroupMembersRepository
  extends TenantRepository<'group_members'>
  implements TenantRepositoryContract<GroupMembersRepository>
{
  constructor(db: Db) {
    super(db, 'group_members');
  }

  /** Adds a member; `undefined` when already a member. */
  async add(
    scope: OrgScope,
    groupId: Id<'grp'>,
    userId: Id<'usr'>,
  ): Promise<{ created_at: Date } | undefined> {
    return this.executor(scope)
      .insertInto('meta.group_members')
      .values({ organization_id: scope.organizationId, group_id: groupId, user_id: userId })
      .onConflict((oc) => oc.columns(['group_id', 'user_id']).doNothing())
      .returning('created_at')
      .executeTakeFirst();
  }

  /** Removes a member; `false` when not a member. */
  async remove(scope: OrgScope, groupId: Id<'grp'>, userId: Id<'usr'>): Promise<boolean> {
    const result = await this.executor(scope)
      .deleteFrom('meta.group_members')
      .where('organization_id', '=', scope.organizationId)
      .where('group_id', '=', groupId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  async get(
    scope: OrgScope,
    groupId: Id<'grp'>,
    userId: Id<'usr'>,
  ): Promise<GroupMemberWithUser | undefined> {
    const row = await this.withUserQuery(scope)
      .where('gm.group_id', '=', groupId)
      .where('gm.user_id', '=', userId)
      .executeTakeFirst();
    return row === undefined ? undefined : GroupMembersRepository.toMember(row);
  }

  private withUserQuery(scope: OrgScope) {
    return this.executor(scope)
      .selectFrom('meta.group_members as gm')
      .innerJoin('meta.users as u', 'u.id', 'gm.user_id')
      .select(['gm.group_id', 'gm.created_at', 'u.id', 'u.email', 'u.display_name', 'u.avatar_url'])
      .where('gm.organization_id', '=', scope.organizationId);
  }

  private static toMember(row: {
    group_id: Id<'grp'>;
    created_at: Date;
    id: Id<'usr'>;
    email: string;
    display_name: string;
    avatar_url: string | null;
  }): GroupMemberWithUser {
    return {
      group_id: row.group_id,
      created_at: row.created_at,
      user: {
        id: row.id,
        email: row.email,
        display_name: row.display_name,
        avatar_url: row.avatar_url,
      },
    };
  }

  /** One page of a group's members, oldest first. */
  async list(
    scope: OrgScope,
    groupId: Id<'grp'>,
    page: PageRequest,
  ): Promise<Page<GroupMemberWithUser>> {
    const rows = await this.withUserQuery(scope)
      .where('gm.group_id', '=', groupId)
      .orderBy('gm.created_at')
      .orderBy('gm.user_id')
      .offset(page.offset)
      .limit(page.limit)
      .execute();
    const total = await this.executor(scope)
      .selectFrom('meta.group_members')
      .select((eb) => eb.fn.countAll().as('count'))
      .where('organization_id', '=', scope.organizationId)
      .where('group_id', '=', groupId)
      .executeTakeFirst();
    return {
      items: rows.map((row) => GroupMembersRepository.toMember(row)),
      total: countOf(total),
    };
  }

  /** Groups of this organization the user belongs to. */
  async groupIdsOfUser(scope: OrgScope, userId: Id<'usr'>): Promise<Id<'grp'>[]> {
    const rows = await this.executor(scope)
      .selectFrom('meta.group_members')
      .select('group_id')
      .where('organization_id', '=', scope.organizationId)
      .where('user_id', '=', userId)
      .orderBy('group_id')
      .execute();
    return rows.map((row) => row.group_id);
  }

  /**
   * Distinct members of these groups of the organization
   * (`current_user_groups`, SPEC §6.1).
   */
  async userIdsOfGroups(scope: OrgScope, groupIds: readonly Id<'grp'>[]): Promise<Id<'usr'>[]> {
    if (groupIds.length === 0) return [];
    const rows = await this.executor(scope)
      .selectFrom('meta.group_members')
      .select('user_id')
      .distinct()
      .where('organization_id', '=', scope.organizationId)
      .where('group_id', 'in', [...groupIds])
      .orderBy('user_id')
      .execute();
    return rows.map((row) => row.user_id);
  }
}
