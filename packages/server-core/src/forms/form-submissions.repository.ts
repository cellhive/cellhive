import { sql } from 'kysely';

import {
  TenantRepository,
  type OrgScope,
  type TenantRepositoryContract,
} from '../db/repository.js';

import type { Db } from '../db/create-db.js';
import type { Id } from '@cellhive/contracts';

export interface InsertFormSubmissionInput {
  readonly baseId: Id<'bse'>;
  readonly viewId: Id<'viw'>;
  readonly userId: Id<'usr'>;
  /** The link submitted through; `null` for the member route. */
  readonly shareLinkId: Id<'shl'> | null;
  readonly recordId: Id<'rec'>;
  /** Default: the transaction time. */
  readonly submittedAt?: Date;
}

/**
 * `meta.form_submissions` (migration 0009, BACKLOG T306): records created
 * through a form by a signed-in person, for the per-person submission limit.
 * Every query is scoped by `organization_id`. No cell value is stored.
 */
export class FormSubmissionsRepository
  extends TenantRepository<'form_submissions'>
  implements TenantRepositoryContract<FormSubmissionsRepository>
{
  constructor(db: Db) {
    super(db, 'form_submissions');
  }

  /**
   * Serialises submissions of one person to one form until the transaction
   * of `scope` ends, so that two concurrent submissions cannot both pass the
   * limit.
   */
  async lockPerson(scope: OrgScope, viewId: Id<'viw'>, userId: Id<'usr'>): Promise<void> {
    if (scope.tx === undefined) throw new TypeError('lockPerson needs a transaction scope');
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`form-submissions:${scope.organizationId}:${viewId}:${userId}`}, 0))`.execute(
      this.executor(scope),
    );
  }

  async insert(scope: OrgScope, input: InsertFormSubmissionInput): Promise<void> {
    await this.executor(scope)
      .insertInto('meta.form_submissions')
      .values({
        organization_id: scope.organizationId,
        base_id: input.baseId,
        view_id: input.viewId,
        user_id: input.userId,
        share_link_id: input.shareLinkId,
        record_id: input.recordId,
        ...(input.submittedAt === undefined ? {} : { submitted_at: input.submittedAt }),
      })
      .execute();
  }

  /** Submissions of `userId` to the form `viewId` at or after `since`. */
  async countSince(
    scope: OrgScope,
    viewId: Id<'viw'>,
    userId: Id<'usr'>,
    since: Date,
  ): Promise<number> {
    const row = await this.executor(scope)
      .selectFrom('meta.form_submissions')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('organization_id', '=', scope.organizationId)
      .where('view_id', '=', viewId)
      .where('user_id', '=', userId)
      .where('submitted_at', '>=', since)
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }
}
