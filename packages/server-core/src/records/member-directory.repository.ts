import { sql } from 'kysely';

import {
  TenantRepository,
  type OrgScope,
  type TenantRepositoryContract,
} from '../db/repository.js';

import type { Db } from '../db/create-db.js';
import type { Id } from '@cellhive/contracts';

/** Display data of a user as shown in `user`/`created_by`/`updated_by` cells (CONTRACTS §2). */
export interface MemberDisplay {
  readonly id: Id<'usr'>;
  readonly name: string;
  readonly email: string;
}

/**
 * Display data of the organization's members, for serializing user cells.
 * Joined through `meta.org_members`, so a stored id of a user outside the
 * organization (e.g. removed, or of another tenant) resolves to nothing.
 */
export class MemberDirectoryRepository
  extends TenantRepository<'org_members'>
  implements TenantRepositoryContract<MemberDirectoryRepository>
{
  constructor(db: Db) {
    super(db, 'org_members');
  }

  /** Members among `userIds` (unknown ids and non-members are left out). */
  async findMembers(scope: OrgScope, userIds: readonly string[]): Promise<MemberDisplay[]> {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return [];
    return this.executor(scope)
      .selectFrom('meta.org_members as m')
      .innerJoin('meta.users as u', 'u.id', 'm.user_id')
      .select(['u.id as id', 'u.display_name as name', 'u.email as email'])
      .where('m.organization_id', '=', scope.organizationId)
      .where(sql<boolean>`u.id = ANY(${sql.val(ids)}::text[])`)
      .execute();
  }

  /**
   * Members whose email is among `emails` (case-insensitive, `citext`), for
   * user cells written as `[{ email }]` (CONTRACTS §2). Users outside the
   * organization are left out, so they read as `USER_NOT_FOUND`.
   */
  async findMembersByEmail(scope: OrgScope, emails: readonly string[]): Promise<MemberDisplay[]> {
    const wanted = [...new Set(emails)];
    if (wanted.length === 0) return [];
    return this.executor(scope)
      .selectFrom('meta.org_members as m')
      .innerJoin('meta.users as u', 'u.id', 'm.user_id')
      .select(['u.id as id', 'u.display_name as name', 'u.email as email'])
      .where('m.organization_id', '=', scope.organizationId)
      .where(sql<boolean>`u.email = ANY(${sql.val(wanted)}::public.citext[])`)
      .execute();
  }
}
