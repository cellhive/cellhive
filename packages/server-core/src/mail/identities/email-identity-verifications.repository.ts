import { sql } from 'kysely';

import {
  TenantRepository,
  type OrgScope,
  type TenantRepositoryContract,
} from '../../db/repository.js';

import type { Db } from '../../db/create-db.js';
import type { EmailIdentityVerificationRow } from '../../db/schema.js';
import type { Id } from '@cellhive/contracts';

export interface IssueVerificationInput {
  readonly identityId: Id<'eid'>;
  /** The address the email went to (the identity's at that time). */
  readonly email: string;
  /** SHA-256 (hex) of the secret part of the link token. */
  readonly tokenHash: string;
  /** HMAC (hex) of the 6-digit code. */
  readonly codeHash: string;
  readonly requestedBy: Id<'usr'> | null;
  readonly expiresAt: Date;
}

/**
 * `meta.email_identity_verifications` (T530): at most one live
 * verification per identity; issuing a new one replaces the previous link
 * and code. Looked up by the token hash **within the organization** named
 * by the token (`<org_id>.<secret>`), never across organizations.
 */
export class EmailIdentityVerificationsRepository
  extends TenantRepository<'email_identity_verifications'>
  implements TenantRepositoryContract<EmailIdentityVerificationsRepository>
{
  constructor(db: Db) {
    super(db, 'email_identity_verifications');
  }

  async issue(
    scope: OrgScope,
    input: IssueVerificationInput,
  ): Promise<EmailIdentityVerificationRow> {
    return this.executor(scope)
      .insertInto('meta.email_identity_verifications')
      .values({
        organization_id: scope.organizationId,
        identity_id: input.identityId,
        email: input.email,
        token_hash: input.tokenHash,
        code_hash: input.codeHash,
        failed_attempts: 0,
        requested_by: input.requestedBy,
        expires_at: input.expiresAt,
        created_at: sql<Date>`now()`,
      })
      .onConflict((oc) =>
        oc.column('identity_id').doUpdateSet({
          email: input.email,
          token_hash: input.tokenHash,
          code_hash: input.codeHash,
          failed_attempts: 0,
          requested_by: input.requestedBy,
          expires_at: input.expiresAt,
          created_at: sql<Date>`now()`,
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async findByIdentity(
    scope: OrgScope,
    identityId: Id<'eid'>,
    options: { forUpdate?: boolean } = {},
  ): Promise<EmailIdentityVerificationRow | undefined> {
    let query = this.executor(scope)
      .selectFrom('meta.email_identity_verifications')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('identity_id', '=', identityId);
    if (options.forUpdate === true) query = query.forUpdate();
    return query.executeTakeFirst();
  }

  async findByIdentities(
    scope: OrgScope,
    identityIds: readonly Id<'eid'>[],
  ): Promise<Map<Id<'eid'>, EmailIdentityVerificationRow>> {
    if (identityIds.length === 0) return new Map();
    const rows = await this.executor(scope)
      .selectFrom('meta.email_identity_verifications')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('identity_id', 'in', [...identityIds])
      .execute();
    return new Map(rows.map((row) => [row.identity_id, row]));
  }

  async findByTokenHash(
    scope: OrgScope,
    tokenHash: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<EmailIdentityVerificationRow | undefined> {
    let query = this.executor(scope)
      .selectFrom('meta.email_identity_verifications')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('token_hash', '=', tokenHash);
    if (options.forUpdate === true) query = query.forUpdate();
    return query.executeTakeFirst();
  }

  /** One more wrong code; returns the new count. */
  async recordFailedAttempt(scope: OrgScope, identityId: Id<'eid'>): Promise<number> {
    const row = await this.executor(scope)
      .updateTable('meta.email_identity_verifications')
      .set({ failed_attempts: sql<number>`failed_attempts + 1` })
      .where('organization_id', '=', scope.organizationId)
      .where('identity_id', '=', identityId)
      .returning('failed_attempts')
      .executeTakeFirst();
    return row?.failed_attempts ?? 0;
  }

  /** Used, replaced by a change of address/transport, or the identity verified. */
  async delete(scope: OrgScope, identityId: Id<'eid'>): Promise<void> {
    await this.executor(scope)
      .deleteFrom('meta.email_identity_verifications')
      .where('organization_id', '=', scope.organizationId)
      .where('identity_id', '=', identityId)
      .execute();
  }
}
