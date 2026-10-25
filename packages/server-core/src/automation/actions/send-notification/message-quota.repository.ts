import { sql } from 'kysely';

import {
  TenantRepository,
  type OrgScope,
  type TenantRepositoryContract,
} from '../../../db/repository.js';

import type { Db } from '../../../db/create-db.js';
import type { JsonValue } from '../../../db/schema.js';
import type { Id } from '@cellhive/contracts';

/** `group_key` prefix of the summary of a recipient past the hourly cap. */
export const SUMMARY_GROUP_KEY_PREFIX = 'summary:';

/** A recipient's summary notification of one automation and hour. */
export interface MessageSummaryRow {
  readonly id: Id<'ntf'>;
  readonly payload: JsonValue;
}

/**
 * The hourly cap of `automation.message` per recipient (BACKLOG T515,
 * ADR-32 §1) over `meta.notifications`: how many messages each user
 * received in the past hour (summaries not counted), and the summary row
 * that stands for the messages past the cap (replaced, never updated). Every query is scoped by
 * `organization_id`.
 */
export class AutomationMessageQuotaRepository
  extends TenantRepository<'notifications'>
  implements TenantRepositoryContract<AutomationMessageQuotaRepository>
{
  constructor(db: Db) {
    super(db, 'notifications');
  }

  /** `automation.message` notifications of each user created after `since` (summaries excluded). */
  async countSince(
    scope: OrgScope,
    userIds: readonly Id<'usr'>[],
    since: Date,
  ): Promise<Map<Id<'usr'>, number>> {
    const counts = new Map<Id<'usr'>, number>();
    if (userIds.length === 0) return counts;
    const { rows } = await sql<{ user_id: Id<'usr'>; n: number }>`
      SELECT user_id, count(*)::int AS n
        FROM meta.notifications
       WHERE organization_id = ${scope.organizationId}
         AND user_id = ANY(${sql.val([...new Set(userIds)])}::text[])
         AND type = 'automation.message'
         AND created_at > ${since}
         AND (group_key IS NULL OR group_key NOT LIKE ${`${SUMMARY_GROUP_KEY_PREFIX}%`})
       GROUP BY user_id
    `.execute(this.executor(scope));
    for (const row of rows) counts.set(row.user_id, row.n);
    return counts;
  }

  /** The summary rows of `groupKey` for these users, locked for the update (`FOR UPDATE`). */
  async lockSummaries(
    scope: OrgScope,
    userIds: readonly Id<'usr'>[],
    groupKey: string,
  ): Promise<Map<Id<'usr'>, MessageSummaryRow>> {
    const found = new Map<Id<'usr'>, MessageSummaryRow>();
    if (userIds.length === 0) return found;
    const rows = await this.executor(scope)
      .selectFrom('meta.notifications')
      .select(['id', 'user_id', 'payload'])
      .where('organization_id', '=', scope.organizationId)
      .where('user_id', 'in', [...new Set(userIds)])
      .where('type', '=', 'automation.message')
      .where('group_key', '=', groupKey)
      .orderBy('id')
      .forUpdate()
      .execute();
    for (const row of rows) found.set(row.user_id, { id: row.id, payload: row.payload });
    return found;
  }

  /**
   * Deletes summaries about to be replaced by a newer one (notifications are
   * never updated: the new row carries the new count, is unread and is
   * announced like any new notification). Their pending email goes with
   * them (`ON DELETE CASCADE`).
   */
  async deleteSummaries(scope: OrgScope, ids: readonly Id<'ntf'>[]): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await this.executor(scope)
      .deleteFrom('meta.notifications')
      .where('organization_id', '=', scope.organizationId)
      .where('id', 'in', [...ids])
      .where('type', '=', 'automation.message')
      .where('group_key', 'like', `${SUMMARY_GROUP_KEY_PREFIX}%`)
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}
