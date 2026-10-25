import { newId, type Id } from '@cellhive/contracts';
import { sql } from 'kysely';

import { principalMatches, type PrincipalRef } from '../principal.js';
import { TenantRepository, type OrgScope, type TenantRepositoryContract } from '../repository.js';

import type { Db } from '../create-db.js';
import type {
  BaseRole,
  BaseRoleKind,
  BaseRoleMember,
  JsonbInput,
  PrincipalType,
} from '../schema.js';

export interface CreateBaseRoleInput {
  readonly id?: Id<'rol'>;
  readonly baseId: Id<'bse'>;
  readonly name: string;
  readonly kind: BaseRoleKind;
  readonly config: JsonbInput;
  readonly position?: number;
}

/**
 * `meta.base_roles` (SPEC §14.1). Every query is scoped by
 * `organization_id`; a role of another organization behaves exactly like a
 * missing one.
 */
export class BaseRolesRepository
  extends TenantRepository<'base_roles'>
  implements TenantRepositoryContract<BaseRolesRepository>
{
  constructor(db: Db) {
    super(db, 'base_roles');
  }

  async create(scope: OrgScope, input: CreateBaseRoleInput): Promise<BaseRole> {
    return this.executor(scope)
      .insertInto('meta.base_roles')
      .values({
        id: input.id ?? newId('rol'),
        organization_id: scope.organizationId,
        base_id: input.baseId,
        name: input.name,
        kind: input.kind,
        config: input.config,
        ...(input.position === undefined ? {} : { position: input.position }),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** Roles of a base by position. */
  async listByBase(scope: OrgScope, baseId: Id<'bse'>): Promise<BaseRole[]> {
    return this.executor(scope)
      .selectFrom('meta.base_roles')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('base_id', '=', baseId)
      .orderBy('position')
      .orderBy('id')
      .execute();
  }

  /** A role of the base; `undefined` when missing, of another base or organization. */
  async getById(
    scope: OrgScope,
    baseId: Id<'bse'>,
    roleId: Id<'rol'>,
  ): Promise<BaseRole | undefined> {
    return this.executor(scope)
      .selectFrom('meta.base_roles')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('base_id', '=', baseId)
      .where('id', '=', roleId)
      .executeTakeFirst();
  }

  /** A role of the base with this name, ignoring case (optionally except one role). */
  async findByName(
    scope: OrgScope,
    baseId: Id<'bse'>,
    name: string,
    exceptId?: Id<'rol'>,
  ): Promise<BaseRole | undefined> {
    let query = this.executor(scope)
      .selectFrom('meta.base_roles')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('base_id', '=', baseId)
      .where(sql<string>`lower(name)`, '=', name.toLowerCase());
    if (exceptId !== undefined) query = query.where('id', '<>', exceptId);
    return query.executeTakeFirst();
  }

  /**
   * Bases with a role whose config uses the `current_user_groups` filter
   * variable anywhere (`{ "$var": "current_user_groups" }`, SPEC §6.1): what
   * those roles grant depends on the membership of every group of the
   * organization, not only of the groups assigned in the base.
   */
  async baseIdsUsingGroupsVariable(scope: OrgScope): Promise<Id<'bse'>[]> {
    const rows = await this.executor(scope)
      .selectFrom('meta.base_roles')
      .select('base_id')
      .distinct()
      .where('organization_id', '=', scope.organizationId)
      .where(
        sql<boolean>`jsonb_path_exists(config, 'strict $.**."$var" ? (@ == "current_user_groups")')`,
      )
      .execute();
    return rows.map((row) => row.base_id);
  }

  /** Position after the last role of the base. */
  async nextPosition(scope: OrgScope, baseId: Id<'bse'>): Promise<number> {
    const row = await this.executor(scope)
      .selectFrom('meta.base_roles')
      .select((eb) => eb.fn.max('position').as('max'))
      .where('organization_id', '=', scope.organizationId)
      .where('base_id', '=', baseId)
      .executeTakeFirst();
    return row?.max == null ? 0 : row.max + 1;
  }

  /** Renames a role and/or replaces its config; `undefined` when not found. */
  async update(
    scope: OrgScope,
    baseId: Id<'bse'>,
    roleId: Id<'rol'>,
    patch: UpdateBaseRoleInput,
  ): Promise<BaseRole | undefined> {
    const values = {
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.config === undefined ? {} : { config: patch.config }),
    };
    if (Object.keys(values).length === 0) return this.getById(scope, baseId, roleId);
    return this.executor(scope)
      .updateTable('meta.base_roles')
      .set(values)
      .where('organization_id', '=', scope.organizationId)
      .where('base_id', '=', baseId)
      .where('id', '=', roleId)
      .returningAll()
      .executeTakeFirst();
  }

  /**
   * Deletes a role (its assignments go with it: `ON DELETE CASCADE`); the
   * deleted row, or `undefined` when not found.
   */
  async delete(
    scope: OrgScope,
    baseId: Id<'bse'>,
    roleId: Id<'rol'>,
  ): Promise<BaseRole | undefined> {
    return this.executor(scope)
      .deleteFrom('meta.base_roles')
      .where('organization_id', '=', scope.organizationId)
      .where('base_id', '=', baseId)
      .where('id', '=', roleId)
      .returningAll()
      .executeTakeFirst();
  }
}

export interface UpdateBaseRoleInput {
  readonly name?: string;
  readonly config?: JsonbInput;
}

export interface AssignBaseRoleInput {
  readonly baseId: Id<'bse'>;
  readonly roleId: Id<'rol'>;
  readonly principalType: PrincipalType;
  readonly principalId: Id<'usr'> | Id<'grp'>;
}

/**
 * `meta.base_role_members`: which user or group has which role in a base
 * (exactly one per principal and base). `principal_id` has no foreign key, so
 * removing an organization member or deleting a group must call
 * `removeAllForPrincipal`.
 */
export class BaseRoleMembersRepository
  extends TenantRepository<'base_role_members'>
  implements TenantRepositoryContract<BaseRoleMembersRepository>
{
  constructor(db: Db) {
    super(db, 'base_role_members');
  }

  /** Gives the principal `roleId` in the base, replacing a previous role. */
  async assign(scope: OrgScope, input: AssignBaseRoleInput): Promise<BaseRoleMember> {
    return this.executor(scope)
      .insertInto('meta.base_role_members')
      .values({
        organization_id: scope.organizationId,
        base_id: input.baseId,
        role_id: input.roleId,
        principal_type: input.principalType,
        principal_id: input.principalId,
      })
      .onConflict((oc) =>
        oc
          .columns(['base_id', 'principal_type', 'principal_id'])
          // The conflicting row can only be of the same organization: IDs are global.
          .doUpdateSet({ role_id: input.roleId })
          .where('meta.base_role_members.organization_id', '=', scope.organizationId),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** Every assignment of a base. */
  async listByBase(scope: OrgScope, baseId: Id<'bse'>): Promise<BaseRoleMember[]> {
    return this.executor(scope)
      .selectFrom('meta.base_role_members')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('base_id', '=', baseId)
      .orderBy('principal_type')
      .orderBy('principal_id')
      .execute();
  }

  /** The assignment of one principal in a base, or `undefined`. */
  async getForPrincipal(
    scope: OrgScope,
    baseId: Id<'bse'>,
    principalType: PrincipalType,
    principalId: Id<'usr'> | Id<'grp'>,
  ): Promise<BaseRoleMember | undefined> {
    return this.executor(scope)
      .selectFrom('meta.base_role_members')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('base_id', '=', baseId)
      .where('principal_type', '=', principalType)
      .where('principal_id', '=', principalId)
      .executeTakeFirst();
  }

  /** Removes the role of one principal in a base; the removed row or `undefined`. */
  async remove(
    scope: OrgScope,
    baseId: Id<'bse'>,
    principalType: PrincipalType,
    principalId: Id<'usr'> | Id<'grp'>,
  ): Promise<BaseRoleMember | undefined> {
    return this.executor(scope)
      .deleteFrom('meta.base_role_members')
      .where('organization_id', '=', scope.organizationId)
      .where('base_id', '=', baseId)
      .where('principal_type', '=', principalType)
      .where('principal_id', '=', principalId)
      .returningAll()
      .executeTakeFirst();
  }

  /** Number of principals that have `roleId` in the base. */
  async countByRole(scope: OrgScope, baseId: Id<'bse'>, roleId: Id<'rol'>): Promise<number> {
    const row = await this.executor(scope)
      .selectFrom('meta.base_role_members')
      .select((eb) => eb.fn.countAll().as('count'))
      .where('organization_id', '=', scope.organizationId)
      .where('base_id', '=', baseId)
      .where('role_id', '=', roleId)
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }

  /** Bases where any of the given principals has a role. */
  async baseIdsForPrincipal(scope: OrgScope, principal: PrincipalRef): Promise<Id<'bse'>[]> {
    const rows = await this.executor(scope)
      .selectFrom('meta.base_role_members')
      .select('base_id')
      .distinct()
      .where('organization_id', '=', scope.organizationId)
      .where(principalMatches('meta.base_role_members', principal))
      .execute();
    return rows.map((row) => row.base_id);
  }

  /** Bases where a group has a role. */
  async baseIdsForGroup(scope: OrgScope, groupId: Id<'grp'>): Promise<Id<'bse'>[]> {
    const rows = await this.executor(scope)
      .selectFrom('meta.base_role_members')
      .select('base_id')
      .distinct()
      .where('organization_id', '=', scope.organizationId)
      .where('principal_type', '=', 'group')
      .where('principal_id', '=', groupId)
      .execute();
    return rows.map((row) => row.base_id);
  }

  /** Removes every assignment of a user or group; returns the affected bases. */
  async removeAllForPrincipal(
    scope: OrgScope,
    principalType: PrincipalType,
    principalId: Id<'usr'> | Id<'grp'>,
  ): Promise<Id<'bse'>[]> {
    const rows = await this.executor(scope)
      .deleteFrom('meta.base_role_members')
      .where('organization_id', '=', scope.organizationId)
      .where('principal_type', '=', principalType)
      .where('principal_id', '=', principalId)
      .returning('base_id')
      .execute();
    return [...new Set(rows.map((row) => row.base_id))];
  }
}
