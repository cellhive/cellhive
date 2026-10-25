import { sql } from 'kysely';

import {
  TenantRepository,
  type OrgScope,
  type TenantRepositoryContract,
} from '../../../db/repository.js';

import type { Db } from '../../../db/create-db.js';
import type { Id } from '@cellhive/contracts';

/** An active member of the organization as an email recipient. */
export interface RecipientMember {
  readonly userId: Id<'usr'>;
  readonly email: string;
  readonly displayName: string;
}

/**
 * Members of an organization as recipients of `send_email` (BACKLOG T514):
 * a `user` value becomes the account email only while the user is
 * `active` and still a member (`meta.org_members` of this organization),
 * and the builder warns about addresses that are not members
 * (`EXTERNAL_RECIPIENTS`). Every query is scoped by `organization_id`.
 */
export class RecipientMembersRepository
  extends TenantRepository<'org_members'>
  implements TenantRepositoryContract<RecipientMembersRepository>
{
  constructor(db: Db) {
    super(db, 'org_members');
  }

  /** Active members among `userIds` (others are absent), by user id. */
  async activeMembers(
    scope: OrgScope,
    userIds: readonly Id<'usr'>[],
  ): Promise<Map<Id<'usr'>, RecipientMember>> {
    const result = new Map<Id<'usr'>, RecipientMember>();
    if (userIds.length === 0) return result;
    const rows = await this.executor(scope)
      .selectFrom('meta.org_members as m')
      .innerJoin('meta.users as u', 'u.id', 'm.user_id')
      .select(['u.id', 'u.email', 'u.display_name'])
      .where('m.organization_id', '=', scope.organizationId)
      .where('m.user_id', 'in', [...new Set(userIds)])
      .where('u.status', '=', 'active')
      .execute();
    for (const row of rows) {
      result.set(row.id, { userId: row.id, email: row.email, displayName: row.display_name });
    }
    return result;
  }

  /** The addresses (lower case) among `addresses` that belong to active members. */
  async memberAddresses(scope: OrgScope, addresses: readonly string[]): Promise<Set<string>> {
    const wanted = [...new Set(addresses.map((address) => address.toLowerCase()))];
    if (wanted.length === 0) return new Set();
    const rows = await this.executor(scope)
      .selectFrom('meta.org_members as m')
      .innerJoin('meta.users as u', 'u.id', 'm.user_id')
      .select(sql<string>`lower(u.email)`.as('email'))
      .where('m.organization_id', '=', scope.organizationId)
      .where('u.status', '=', 'active')
      .where(sql<string>`lower(u.email)`, 'in', wanted)
      .execute();
    return new Set(rows.map((row) => row.email));
  }
}
