import { sql } from 'kysely';

import {
  TenantRepository,
  type OrgScope,
  type TenantRepositoryContract,
} from '../db/repository.js';

import type { StoredEvent } from './event.js';
import type { Db } from '../db/create-db.js';
import type { Id } from '@cellhive/contracts';

/** Key of an event row: the id plus `created_at`, which selects the partition. */
export interface EventKey {
  readonly id: Id<'evt'>;
  /** Exact `created_at` (ISO 8601 with microseconds, as in the dispatch payload). */
  readonly createdAt: string;
}

export interface EventRecord extends StoredEvent {
  readonly dispatched_at: Date | null;
}

/**
 * Reads of `meta.events` and the dispatcher's bookkeeping. Events are written
 * only by `EventWriter` (which also enqueues their dispatch). Every query is
 * scoped by `organization_id`.
 */
export class EventsRepository
  extends TenantRepository<'events'>
  implements TenantRepositoryContract<EventsRepository>
{
  constructor(db: Db) {
    super(db, 'events');
  }

  async getByKey(scope: OrgScope, key: EventKey): Promise<EventRecord | undefined> {
    return this.executor(scope)
      .selectFrom('meta.events')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', key.id)
      .where('created_at', '=', sql<Date>`${key.createdAt}::timestamptz`)
      .executeTakeFirst();
  }

  /**
   * `changes` of the `record.updated` events of one record written after
   * `afterVersion` (from `since`, the earlier event's `created_at`), oldest
   * first: what changed in the record after an event that is dispatched
   * late (T527, `record.matches`).
   */
  async laterRecordChanges(
    scope: OrgScope,
    input: {
      readonly recordId: string;
      readonly afterVersion: number;
      readonly since: string;
    },
  ): Promise<Record<string, { readonly from?: unknown; readonly to?: unknown }>[]> {
    const rows = await this.executor(scope)
      .selectFrom('meta.events')
      .select(['payload'])
      .where('organization_id', '=', scope.organizationId)
      .where('created_at', '>=', sql<Date>`${input.since}::timestamptz`)
      .where('entity_type', '=', 'record')
      .where('entity_id', '=', input.recordId)
      .where('type', '=', 'record.updated')
      .where(sql<number>`(payload->>'record_version')::int`, '>', input.afterVersion)
      .orderBy(sql`(payload->>'record_version')::int`)
      .execute();
    return rows.map((row) => {
      const changes = (row.payload as { changes?: unknown } | null)?.changes;
      return typeof changes === 'object' && changes !== null && !Array.isArray(changes)
        ? (changes as Record<string, { from?: unknown; to?: unknown }>)
        : {};
    });
  }

  /**
   * Sets `dispatched_at` once. Returns `false` when the event does not exist
   * in the organization or was already dispatched (a retried job).
   */
  async markDispatched(scope: OrgScope, key: EventKey): Promise<boolean> {
    const result = await this.executor(scope)
      .updateTable('meta.events')
      .set({ dispatched_at: sql<Date>`now()` })
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', key.id)
      .where('created_at', '=', sql<Date>`${key.createdAt}::timestamptz`)
      .where('dispatched_at', 'is', null)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }
}
