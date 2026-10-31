import { isId } from '@cellhive/contracts';
import { sql } from 'kysely';

import {
  TenantRepository,
  type OrgScope,
  type TenantRepositoryContract,
} from '../../db/repository.js';
import { mergeCausations, MAX_CAUSATION_CHAIN, type Causation } from '../../events/event.js';

import type { Db } from '../../db/create-db.js';
import type { JsonValue } from '../../db/schema.js';
import type { Id } from '@cellhive/contracts';

/** `record_id` of the queue row standing for every record of the field's table. */
export const EVERY_RECORD = '*';

/** A batch taken from the queue (see {@link ComputedRecomputeQueueRepository.take}). */
export type QueuedBatch =
  | {
      readonly kind: 'records';
      readonly recordIds: readonly Id<'rec'>[];
      /** Merged causation of the rows (T509), `undefined` when none was known. */
      readonly causation?: Causation;
      /** Records whose rows only compute their first value (`created`, T509). */
      readonly created: ReadonlySet<string>;
    }
  /** The every-record row: the job continues after `afterAuto`. */
  | { readonly kind: 'every'; readonly afterAuto: bigint; readonly causation?: Causation }
  | { readonly kind: 'empty' };

/** What a write tells the queue about the rows it adds (T509). */
export interface QueuedOrigin {
  /** Causation of the write; merged into existing rows conservatively. */
  readonly causation?: Causation;
  /** Records just created/restored by the write (their first values: no event). */
  readonly created?: ReadonlySet<string>;
}

/**
 * A stored causation read back leniently (merged rows may name more
 * automations than an event would); `undefined` when absent or malformed.
 */
export function queuedCausationOf(value: JsonValue | null | undefined): Causation | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const root = value.root_event_id;
  const depth = value.depth;
  const chain = value.automation_chain;
  if (!isId('evt', root) || typeof depth !== 'number' || !Number.isInteger(depth) || depth < 0) {
    return undefined;
  }
  return {
    root_event_id: root,
    depth,
    automation_chain: (Array.isArray(chain) ? chain : [])
      .filter((id): id is Id<'aut'> => isId('aut', id))
      .slice(0, MAX_CAUSATION_CHAIN),
  };
}

/**
 * `meta.computed_recompute_queue` (migration 0024, BACKLOG T458): records
 * of stored computed fields left for the `computed.recompute` job. Rows
 * merge on `(field_id, record_id)`; `'*'` = every record. Every query is
 * scoped by `organization_id`.
 */
export class ComputedRecomputeQueueRepository
  extends TenantRepository<'computed_recompute_queue'>
  implements TenantRepositoryContract<ComputedRecomputeQueueRepository>
{
  constructor(db: Db) {
    super(db, 'computed_recompute_queue');
  }

  /**
   * Queues `recordIds` of `fieldId`, or every record (`'all'`): the
   * every-record row starts over from the first record when it exists.
   * Nothing is queued for a field of another organization: the queue's
   * key is `(field_id, record_id)`, so such a row would block (or restart)
   * that organization's own work (T471).
   */
  async add(
    scope: OrgScope,
    fieldId: Id<'fld'>,
    records: readonly string[] | 'all',
    origin: QueuedOrigin = {},
  ): Promise<void> {
    const executor = this.executor(scope);
    const causation = origin.causation === undefined ? null : JSON.stringify(origin.causation);
    if (records === 'all') {
      await sql`
        INSERT INTO meta.computed_recompute_queue AS q
               (organization_id, field_id, record_id, causation)
        SELECT f.organization_id, f.id, ${EVERY_RECORD}, ${causation}::jsonb
          FROM meta.fields AS f
         WHERE f.organization_id = ${scope.organizationId} AND f.id = ${fieldId}
        ON CONFLICT (field_id, record_id)
          DO UPDATE SET after_auto = 0, enqueued_at = now(),
                        causation = meta.merge_recompute_causation(q.causation, excluded.causation)
      `.execute(executor);
      return;
    }
    // Sorted: concurrent writers lock overlapping rows in the same order.
    const ids = [...new Set(records)].filter((id) => id !== EVERY_RECORD).sort();
    if (ids.length === 0) return;
    const created = ids.map((id) => origin.created?.has(id) === true);
    // A row already queued keeps waiting; it learns the causation of this
    // write too, and stays `created` only if this write also created it.
    await sql`
      INSERT INTO meta.computed_recompute_queue AS q
             (organization_id, field_id, record_id, causation, created)
      SELECT f.organization_id, f.id, r.id, ${causation}::jsonb, r.created
        FROM meta.fields AS f
       CROSS JOIN unnest(${sql.val(ids)}::text[], ${sql.val(created)}::boolean[])
             WITH ORDINALITY AS r(id, created, ord)
       WHERE f.organization_id = ${scope.organizationId} AND f.id = ${fieldId}
       ORDER BY r.ord
      ON CONFLICT (field_id, record_id) DO UPDATE
         SET causation = meta.merge_recompute_causation(q.causation, excluded.causation),
             created = q.created AND excluded.created
       WHERE q.created AND NOT excluded.created
          OR q.causation IS DISTINCT FROM
             meta.merge_recompute_causation(q.causation, excluded.causation)
    `.execute(executor);
  }

  /**
   * The next batch of `fieldId` in the scope's transaction, rows locked by
   * another run skipped: the every-record row first (locked until commit;
   * the caller moves it with {@link advance}), else up to `limit` record
   * ids, deleted from the queue (back on rollback).
   */
  async take(scope: OrgScope, fieldId: Id<'fld'>, limit: number): Promise<QueuedBatch> {
    const executor = this.executor(scope);
    const every = await executor
      .selectFrom('meta.computed_recompute_queue')
      .select(['after_auto', 'causation'])
      .where('organization_id', '=', scope.organizationId)
      .where('field_id', '=', fieldId)
      .where('record_id', '=', EVERY_RECORD)
      .forUpdate()
      .skipLocked()
      .executeTakeFirst();
    if (every !== undefined) {
      const causation = queuedCausationOf(every.causation);
      return {
        kind: 'every',
        afterAuto: every.after_auto,
        ...(causation === undefined ? {} : { causation }),
      };
    }
    // Lock, then delete by id: as one `DELETE … IN (SELECT … LIMIT … FOR
    // UPDATE SKIP LOCKED)`, a queue whose statistics say it is empty (it is
    // usually drained) is planned as a nested loop re-running the locking
    // subquery for every queued row — O(queued × limit), past the job's
    // statement timeout once an import queues 10 000 records.
    const locked = await executor
      .selectFrom('meta.computed_recompute_queue')
      .select('record_id')
      .where('organization_id', '=', scope.organizationId)
      .where('field_id', '=', fieldId)
      .where('record_id', '<>', EVERY_RECORD)
      .orderBy('record_id')
      .limit(limit)
      .forUpdate()
      .skipLocked()
      .execute();
    if (locked.length === 0) return { kind: 'empty' };
    const { rows } = await sql<{
      record_id: Id<'rec'>;
      causation: JsonValue | null;
      created: boolean;
    }>`
      DELETE FROM meta.computed_recompute_queue AS q
       WHERE q.organization_id = ${scope.organizationId}
         AND q.field_id = ${fieldId}
         AND q.record_id = ANY(${sql.val(locked.map((row) => row.record_id))}::text[])
      RETURNING q.record_id, q.causation, q.created
    `.execute(executor);
    // "Root of the first row": the first record in id order.
    const sorted = [...rows].sort((a, b) => (a.record_id < b.record_id ? -1 : 1));
    let causation: Causation | undefined;
    for (const row of sorted) {
      causation = mergeCausations(causation, queuedCausationOf(row.causation));
    }
    return {
      kind: 'records',
      recordIds: sorted.map((row) => row.record_id),
      ...(causation === undefined ? {} : { causation }),
      created: new Set(sorted.filter((row) => row.created).map((row) => row.record_id)),
    };
  }

  /** Moves the every-record row of `fieldId` past `afterAuto`, or removes it when `done`. */
  async advance(
    scope: OrgScope,
    fieldId: Id<'fld'>,
    afterAuto: bigint,
    done: boolean,
  ): Promise<void> {
    const executor = this.executor(scope);
    if (done) {
      await executor
        .deleteFrom('meta.computed_recompute_queue')
        .where('organization_id', '=', scope.organizationId)
        .where('field_id', '=', fieldId)
        .where('record_id', '=', EVERY_RECORD)
        .execute();
      return;
    }
    await executor
      .updateTable('meta.computed_recompute_queue')
      .set({ after_auto: afterAuto.toString() })
      .where('organization_id', '=', scope.organizationId)
      .where('field_id', '=', fieldId)
      .where('record_id', '=', EVERY_RECORD)
      .execute();
  }

  /** Rows still queued for `fieldId` (locked ones included). */
  async count(scope: OrgScope, fieldId: Id<'fld'>): Promise<number> {
    const row = await this.executor(scope)
      .selectFrom('meta.computed_recompute_queue')
      .select((eb) => eb.fn.countAll<bigint>().as('count'))
      .where('organization_id', '=', scope.organizationId)
      .where('field_id', '=', fieldId)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  /** Forgets every queued row of `fieldId` (the field is gone or no longer stored). */
  async clear(scope: OrgScope, fieldId: Id<'fld'>): Promise<void> {
    await this.executor(scope)
      .deleteFrom('meta.computed_recompute_queue')
      .where('organization_id', '=', scope.organizationId)
      .where('field_id', '=', fieldId)
      .execute();
  }

  /**
   * `compute_state` of stored computed fields of the organization: `ready`
   * → `recomputing` (queued work), or `recomputing` → `ready` (caught up).
   * Other states (`backfilling`, `error`) are left alone. Returns the ids
   * that changed.
   */
  async setComputeState(
    scope: OrgScope,
    fieldIds: readonly Id<'fld'>[],
    from: 'ready' | 'recomputing',
    to: 'ready' | 'recomputing',
  ): Promise<Id<'fld'>[]> {
    if (fieldIds.length === 0) return [];
    const rows = await this.executor(scope)
      .updateTable('meta.fields')
      .set({ compute_state: to })
      .where('organization_id', '=', scope.organizationId)
      .where('id', 'in', [...new Set(fieldIds)].sort())
      .where('type', 'in', ['formula', 'lookup'])
      .where('compute_state', '=', from)
      .returning('id')
      .execute();
    return rows.map((row) => row.id);
  }
}
