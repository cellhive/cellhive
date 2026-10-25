import { sql } from 'kysely';

import {
  TenantRepository,
  type OrgScope,
  type TenantRepositoryContract,
} from '../../db/repository.js';

import type { Db } from '../../db/create-db.js';
import type { Id, RecordFollowSource } from '@cellhive/contracts';

/** Whether a member follows a record, and why (`source = null` when not following). */
export interface RecordFollowState {
  readonly following: boolean;
  readonly source: RecordFollowSource | null;
}

/** One record of a table a member may follow. */
export interface RecordFollowTarget {
  readonly tableId: Id<'tbl'>;
  readonly recordId: Id<'rec'>;
  readonly userId: Id<'usr'>;
}

/**
 * `meta.record_follows` (migration 0039, BACKLOG T543; ADR-34 §2): who
 * follows a record. A row with `muted = true` is a record the member
 * unfollowed by hand: automatic sources never follow it again for them
 * (CONTRACTS §22.5). Every query is scoped by `organization_id`; access to
 * the record is checked by the callers (`RecordFollowService`, the
 * notification fan-out at send time).
 */
export class RecordFollowsRepository
  extends TenantRepository<'record_follows'>
  implements TenantRepositoryContract<RecordFollowsRepository>
{
  constructor(db: Db) {
    super(db, 'record_follows');
  }

  /**
   * Serialises the follows of one member until the transaction of `scope`
   * ends, so that two concurrent follows cannot both pass the cap.
   */
  async lockUser(scope: OrgScope, userId: Id<'usr'>): Promise<void> {
    if (scope.tx === undefined) throw new TypeError('lockUser needs a transaction scope');
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`record-follows:${scope.organizationId}:${userId}`}, 0))`.execute(
      this.executor(scope),
    );
  }

  /**
   * Follows one record. `manual`: follows it whatever came before (a muted
   * row is un-muted and becomes `manual`; an existing follow keeps its
   * source). Any other source: only when the member has no row for the
   * record yet — an existing follow keeps its source and a record the member
   * unfollowed by hand stays unfollowed. Returns whether the member was not
   * following the record before and is now.
   */
  async follow(
    scope: OrgScope,
    target: RecordFollowTarget,
    source: RecordFollowSource,
  ): Promise<boolean> {
    const values = {
      organization_id: scope.organizationId,
      table_id: target.tableId,
      record_id: target.recordId,
      user_id: target.userId,
      source,
    };
    const query = this.executor(scope).insertInto('meta.record_follows').values(values);
    const result =
      source === 'manual'
        ? await query
            .onConflict((oc) =>
              oc
                .columns(['organization_id', 'table_id', 'record_id', 'user_id'])
                .doUpdateSet({ muted: false, source: 'manual' })
                .where('meta.record_follows.muted', '=', true),
            )
            .executeTakeFirst()
        : await query.onConflict((oc) => oc.doNothing()).executeTakeFirst();
    return Number(result.numInsertedOrUpdatedRows ?? 0) > 0;
  }

  /**
   * Automatic follows of several records of one table by one member: records
   * the member has any row for (followed, or unfollowed by hand) are left as
   * they are; at most `limit` new rows are written, in the order given.
   * Returns the records now followed because of this call.
   */
  async followMany(
    scope: OrgScope,
    input: {
      readonly tableId: Id<'tbl'>;
      readonly userId: Id<'usr'>;
      readonly recordIds: readonly Id<'rec'>[];
      readonly source: Exclude<RecordFollowSource, 'manual'>;
      readonly limit: number;
    },
  ): Promise<Id<'rec'>[]> {
    const wanted = [...new Set(input.recordIds)];
    if (wanted.length === 0 || input.limit <= 0) return [];
    const known = new Set<string>(
      (
        await this.executor(scope)
          .selectFrom('meta.record_follows')
          .select('record_id')
          .where('organization_id', '=', scope.organizationId)
          .where('table_id', '=', input.tableId)
          .where('user_id', '=', input.userId)
          .where('record_id', 'in', wanted)
          .execute()
      ).map((row) => row.record_id),
    );
    const fresh = wanted.filter((id) => !known.has(id)).slice(0, input.limit);
    if (fresh.length === 0) return [];
    const rows = await this.executor(scope)
      .insertInto('meta.record_follows')
      .values(
        fresh.map((recordId) => ({
          organization_id: scope.organizationId,
          table_id: input.tableId,
          record_id: recordId,
          user_id: input.userId,
          source: input.source,
        })),
      )
      .onConflict((oc) => oc.doNothing())
      .returning('record_id')
      .execute();
    return rows.map((row) => row.record_id);
  }

  /**
   * Unfollows one record by hand: a follow becomes a muted row (no automatic
   * source follows the record again for the member). No row, or a muted
   * one, is left alone. Returns whether the member was following it.
   */
  async unfollow(scope: OrgScope, target: RecordFollowTarget): Promise<boolean> {
    const result = await this.executor(scope)
      .updateTable('meta.record_follows')
      .set({ muted: true })
      .where('organization_id', '=', scope.organizationId)
      .where('table_id', '=', target.tableId)
      .where('record_id', '=', target.recordId)
      .where('user_id', '=', target.userId)
      .where('muted', '=', false)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  /** Whether the member follows the record, and why. */
  async isFollowing(scope: OrgScope, target: RecordFollowTarget): Promise<RecordFollowState> {
    const row = await this.executor(scope)
      .selectFrom('meta.record_follows')
      .select(['source', 'muted'])
      .where('organization_id', '=', scope.organizationId)
      .where('table_id', '=', target.tableId)
      .where('record_id', '=', target.recordId)
      .where('user_id', '=', target.userId)
      .executeTakeFirst();
    if (row === undefined || row.muted) return { following: false, source: null };
    return { following: true, source: row.source as RecordFollowSource };
  }

  /**
   * Members following each of these records of one table (muted rows left
   * out), by record id, members in id order (code units): the followers
   * T545 notifies. Records nobody follows are absent from the map.
   */
  async followersOf(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    recordIds: readonly Id<'rec'>[],
  ): Promise<Map<Id<'rec'>, Id<'usr'>[]>> {
    const out = new Map<Id<'rec'>, Id<'usr'>[]>();
    const wanted = [...new Set(recordIds)];
    if (wanted.length === 0) return out;
    const rows = await this.executor(scope)
      .selectFrom('meta.record_follows')
      .select(['record_id', 'user_id'])
      .where('organization_id', '=', scope.organizationId)
      .where('table_id', '=', tableId)
      .where('record_id', 'in', wanted)
      .where('muted', '=', false)
      .orderBy('record_id')
      .orderBy('user_id')
      .execute();
    for (const row of rows) {
      const list = out.get(row.record_id) ?? [];
      list.push(row.user_id);
      out.set(row.record_id, list);
    }
    // Code-unit order, whatever the database collation.
    for (const list of out.values()) list.sort();
    return out;
  }

  /** Records the member follows in the organization (muted rows do not count). */
  async countForUser(scope: OrgScope, userId: Id<'usr'>): Promise<number> {
    const row = await this.executor(scope)
      .selectFrom('meta.record_follows')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('organization_id', '=', scope.organizationId)
      .where('user_id', '=', userId)
      .where('muted', '=', false)
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }

  /**
   * Deletes every row of these records (followed or muted): purging records
   * (CONTRACTS §22.5), in the purge transaction. Returns the rows deleted.
   */
  async deleteForRecords(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    recordIds: readonly Id<'rec'>[],
  ): Promise<number> {
    if (recordIds.length === 0) return 0;
    const result = await this.executor(scope)
      .deleteFrom('meta.record_follows')
      .where('organization_id', '=', scope.organizationId)
      .where('table_id', '=', tableId)
      .where('record_id', 'in', [...recordIds])
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  /**
   * Deletes every row of the table's records: purging a table, in the purge
   * transaction (its meta row stays with `purged_at`, so the foreign key does
   * not cascade then). Returns the rows deleted.
   */
  async deleteForTable(scope: OrgScope, tableId: Id<'tbl'>): Promise<number> {
    const result = await this.executor(scope)
      .deleteFrom('meta.record_follows')
      .where('organization_id', '=', scope.organizationId)
      .where('table_id', '=', tableId)
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}
