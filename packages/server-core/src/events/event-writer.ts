import { newId, type Id } from '@cellhive/contracts';
import { sql } from 'kysely';

import { jsonb } from '../db/json.js';
import { enqueue, type EnqueuedJob } from '../jobs/enqueue.js';

import { buildEventRow, type EventInput } from './event.js';

import type { Tx } from '../db/create-db.js';
import type { JsonValue } from '../db/schema.js';

export interface WrittenEvent {
  readonly id: Id<'evt'>;
  readonly organizationId: Id<'org'>;
  readonly createdAt: Date;
  /**
   * `created_at` with microseconds (`YYYY-MM-DDTHH:MM:SS.ffffffZ`): the partition key
   * that finds the row again (`EventsRepository.getByKey`). Set by `write`
   * only.
   */
  readonly createdAtExact?: string;
  /** The `events.dispatch` job added with the event. */
  readonly dispatchJob: EnqueuedJob;
}

/**
 * Writes internal events (SPEC §7.3 step 6). `write` inserts the row into
 * `meta.events` **and** enqueues `events.dispatch` for it, both on the
 * caller's transaction: after a rollback neither exists, after a commit the
 * worker is notified. There is no way to store an event without its
 * dispatch job.
 *
 * Every event must also be audited (CONTRACTS §8): services call
 * `AuditWriter.write` with the same `tx`, since the audit entry carries
 * `before`/`after` and request context that the event does not.
 *
 * Stateless; one instance can be shared.
 */
export class EventWriter {
  async write(tx: Tx, event: EventInput): Promise<WrittenEvent> {
    const row = buildEventRow(event, newId('evt'));
    const { created_at: createdAt, created_at_exact: createdAtExact } = await tx
      .insertInto('meta.events')
      .values({
        ...row,
        payload: row.payload,
        causation: jsonb(row.causation as unknown as JsonValue),
      })
      .returning([
        'created_at',
        // Microsecond precision (a JS Date keeps milliseconds): the dispatcher
        // matches the partition key exactly.
        sql<string>`to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
          'created_at_exact',
        ),
      ])
      .executeTakeFirstOrThrow();
    const dispatchJob = await enqueue(tx, 'events.dispatch', {
      event_id: row.id,
      organization_id: row.organization_id,
      created_at: createdAtExact,
    });
    return {
      id: row.id,
      organizationId: row.organization_id,
      createdAt,
      createdAtExact,
      dispatchJob,
    };
  }

  /**
   * `write` for many events in two statements (one multi-row insert, one
   * `graphile_worker.add_jobs` call for their dispatch jobs) instead of two per event: bulk
   * record writes of up to 1 000 records stay a handful of round trips.
   * Same guarantees: rows and dispatch jobs exist iff `tx` commits. `ids`
   * (optional) are the event ids to use, in input order.
   */
  async writeMany(
    tx: Tx,
    events: readonly EventInput[],
    ids?: readonly Id<'evt'>[],
  ): Promise<WrittenEvent[]> {
    if (ids !== undefined && ids.length !== events.length) {
      throw new RangeError('writeMany: one id per event');
    }
    const rows = events.map((event, index) => buildEventRow(event, ids?.[index] ?? newId('evt')));
    const written: WrittenEvent[] = [];
    for (let start = 0; start < rows.length; start += WRITE_MANY_CHUNK) {
      const chunk = rows.slice(start, start + WRITE_MANY_CHUNK);
      const inserted = await tx
        .insertInto('meta.events')
        .values(
          chunk.map((row) => ({
            ...row,
            payload: row.payload,
            causation: jsonb(row.causation as unknown as JsonValue),
          })),
        )
        .returning([
          'id',
          'created_at',
          sql<string>`to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
            'created_at_exact',
          ),
        ])
        .execute();
      const byId = new Map(inserted.map((row) => [row.id as string, row]));
      const stored = chunk.map((row) => {
        const found = byId.get(row.id);
        if (found === undefined) throw new Error('writeMany: an event row was not returned');
        return { row, createdAt: found.created_at, createdAtExact: found.created_at_exact };
      });
      // One `add_jobs` call per chunk (graphile-worker's batch API: one
      // task/queue check, one insert, one notification) rather than `add_job`
      // per event — a plpgsql call and a `pg_notify` each, which made bulk
      // writes cost ~1–4 ms per event (T423). Same jobs, same payloads,
      // built exactly like `enqueue(tx, 'events.dispatch', …)`.
      const { rows: added } = await sql<{ event_id: string; id: string; run_at: Date }>`
        SELECT j.payload->>'event_id' AS event_id, j.id::text AS id, j.run_at
          FROM graphile_worker.add_jobs(ARRAY(
                 SELECT ROW(
                          'events.dispatch',
                          json_build_object(
                            'event_id', e.event_id,
                            'organization_id', e.organization_id,
                            'created_at', e.created_at
                          ),
                          NULL, NULL, NULL, NULL, NULL, NULL
                        )::graphile_worker.job_spec
                   FROM unnest(
                          ${sql.val(stored.map((item) => item.row.id))}::text[],
                          ${sql.val(stored.map((item) => item.row.organization_id))}::text[],
                          ${sql.val(stored.map((item) => item.createdAtExact))}::text[]
                        ) WITH ORDINALITY AS e(event_id, organization_id, created_at, ord)
                  ORDER BY e.ord
               )) AS j
      `.execute(tx);
      const byEvent = new Map(added.map((job) => [job.event_id, job]));
      if (added.length !== stored.length) {
        throw new Error('writeMany: a dispatch job was not added');
      }
      stored.forEach((item) => {
        const job = byEvent.get(item.row.id);
        if (job === undefined) throw new Error('writeMany: a dispatch job was not added');
        written.push({
          id: item.row.id,
          organizationId: item.row.organization_id,
          createdAt: item.createdAt,
          dispatchJob: { id: job.id, runAt: job.run_at },
        });
      });
    }
    return written;
  }
}

/** Events per multi-row statement (9 parameters each, far below PostgreSQL's 65 535). */
const WRITE_MANY_CHUNK = 1_000;

const defaultWriter = new EventWriter();

/** `new EventWriter().write(tx, event)`: stores the event and enqueues its dispatch in `tx`. */
export function emit(tx: Tx, event: EventInput): Promise<WrittenEvent> {
  return defaultWriter.write(tx, event);
}
