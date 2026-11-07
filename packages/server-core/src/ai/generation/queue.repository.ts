import {
  AI_FAILURE_REASONS,
  AI_FIELD_LEASE_MS,
  AI_PAUSE_REASONS,
  AI_PROVIDER_PAUSE_DETAILS,
  type AiCellMetaDto,
  type AiCellState,
  type AiFieldStateDto,
  type AiPauseReason,
  type AiProviderPauseDetail,
  type Id,
} from '@cellhive/contracts';
import { sql, type RawBuilder } from 'kysely';

import {
  TenantRepository,
  type OrgScope,
  type TenantRepositoryContract,
} from '../../db/repository.js';

import type { Db } from '../../db/create-db.js';
import type { AiGenerationQueueRow, JsonValue } from '../../db/schema.js';

/** A row taken by a batch: its lease is the token that finishes it. */
export interface TakenAiRow {
  readonly recordId: Id<'rec'>;
  /** Tries so far, this one included. */
  readonly attempts: number;
  readonly leaseUntil: Date;
  readonly jobId: Id<'job'> | null;
  readonly causation: JsonValue | null;
}

/** Rows queued per insert (one statement each). */
const ENQUEUE_CHUNK = 5_000;

/**
 * `reason` of a `queued` row whose wait comes from the organization backing
 * off (a `429`, or temporary errors in a row): while such a row waits, no
 * row of the organization is taken.
 */
const BACKOFF = 'backoff';

/** `reason` of a `paused` row: the pause reason, `provider_error:<detail>` for a provider one. */
function storedPauseReason(reason: AiPauseReason, detail?: AiProviderPauseDetail | null): string {
  return reason === 'provider_error' && detail != null ? `${reason}:${detail}` : reason;
}

/** The pause reason and detail of a stored `reason` (unknown codes: `null`). */
function pauseOf(stored: string | null): {
  readonly reason: AiPauseReason | null;
  readonly detail: AiProviderPauseDetail | null;
} {
  const [reason, detail] = (stored ?? '').split(':', 2);
  const known = AI_PAUSE_REASONS.find((item) => item === reason) ?? null;
  return {
    reason: known,
    detail:
      known === 'provider_error'
        ? (AI_PROVIDER_PAUSE_DETAILS.find((item) => item === detail) ?? null)
        : null,
  };
}

/** `record.meta.ai.<fld>` of a queue row: `reason` with `failed` and `paused` (known codes only). */
export function aiCellMetaOf(row: {
  readonly status: AiCellState;
  readonly reason: string | null;
}): AiCellMetaDto {
  if (row.status === 'paused') {
    const { reason } = pauseOf(row.reason);
    return reason === null ? { state: 'paused' } : { state: 'paused', reason };
  }
  if (row.status === 'failed') {
    const reason = AI_FAILURE_REASONS.find((item) => item === row.reason);
    return reason === undefined ? { state: 'failed' } : { state: 'failed', reason };
  }
  return { state: row.status };
}

/** The instant SQL compares due rows with: the caller's clock, or the database's. */
function instant(now: Date | undefined): RawBuilder<unknown> {
  return now === undefined ? sql`now()` : sql`${now.toISOString()}::timestamptz`;
}

/**
 * `meta.ai_generation_queue` (BACKLOG T910, migration 0056): (AI field,
 * record) pairs to generate. Queueing merges with the row of the same pair
 * (back to `queued`, tries reset), so editing a source five times before the
 * worker runs costs one call. A batch takes rows with `FOR UPDATE SKIP
 * LOCKED` and leases them; only the holder of the lease (`running` +
 * `lease_until`, kept to the millisecond so it survives JavaScript dates)
 * may finish them — a row queued again meanwhile is generated again.
 * While the organization backs off (`backOff`: a `429`, or temporary errors
 * in a row) no row of it is taken. Every query is scoped by
 * `organization_id`.
 */
export class AiGenerationQueueRepository
  extends TenantRepository<'ai_generation_queue'>
  implements TenantRepositoryContract<AiGenerationQueueRepository>
{
  constructor(db: Db) {
    super(db, 'ai_generation_queue');
  }

  /** Queues `recordIds` of `fieldId` (merged); returns how many rows were written. */
  async enqueue(
    scope: OrgScope,
    fieldId: Id<'fld'>,
    recordIds: readonly string[],
    options: { readonly causation?: JsonValue | null; readonly jobId?: Id<'job'> | null } = {},
  ): Promise<number> {
    const ids = [...new Set(recordIds)];
    const causation = options.causation == null ? null : JSON.stringify(options.causation);
    let count = 0;
    for (let index = 0; index < ids.length; index += ENQUEUE_CHUNK) {
      const chunk = ids.slice(index, index + ENQUEUE_CHUNK);
      const result = await sql`
        INSERT INTO meta.ai_generation_queue AS q
               (organization_id, field_id, record_id, job_id, causation)
        SELECT ${scope.organizationId}, ${fieldId}, r.id, ${options.jobId ?? null},
               ${causation}::jsonb
          FROM unnest(${sql.val(chunk)}::text[]) AS r(id)
        ON CONFLICT (field_id, record_id) DO UPDATE
           SET status = 'queued', reason = NULL, attempts = 0, enqueued_at = now(),
               lease_until = NULL, causation = EXCLUDED.causation,
               job_id = coalesce(EXCLUDED.job_id, q.job_id)
         WHERE q.organization_id = ${scope.organizationId}
      `.execute(this.executor(scope));
      count += Number(result.numAffectedRows ?? 0);
    }
    return count;
  }

  /**
   * Up to `limit` queued rows of `fieldId` due at `now` (default: the
   * database's clock), oldest first, leased for `leaseMs` (`running`, one
   * more try). Rows another batch holds are skipped; none while the
   * organization backs off.
   */
  async take(
    scope: OrgScope,
    fieldId: Id<'fld'>,
    limit: number,
    leaseMs: number = AI_FIELD_LEASE_MS,
    now?: Date,
  ): Promise<TakenAiRow[]> {
    const at = instant(now);
    const { rows } = await sql<{
      record_id: Id<'rec'>;
      attempts: number;
      lease_until: Date;
      job_id: Id<'job'> | null;
      causation: JsonValue | null;
    }>`
      UPDATE meta.ai_generation_queue AS q
         SET status = 'running', attempts = q.attempts + 1, reason = NULL,
             lease_until = date_trunc('milliseconds', now() + ${`${String(leaseMs)} milliseconds`}::interval)
        FROM (
          SELECT field_id, record_id FROM meta.ai_generation_queue
           WHERE organization_id = ${scope.organizationId} AND field_id = ${fieldId}
             AND status = 'queued' AND (lease_until IS NULL OR lease_until <= ${at})
             AND NOT EXISTS (
               SELECT 1 FROM meta.ai_generation_queue AS b
                WHERE b.organization_id = ${scope.organizationId} AND b.status = 'queued'
                  AND b.reason = ${BACKOFF} AND b.lease_until > ${at})
           ORDER BY enqueued_at, record_id
           LIMIT ${limit}
             FOR UPDATE SKIP LOCKED
        ) AS t
       WHERE q.field_id = t.field_id AND q.record_id = t.record_id
      RETURNING q.record_id, q.attempts, q.lease_until, q.job_id, q.causation
    `.execute(this.executor(scope));
    return rows
      .map((row) => ({
        recordId: row.record_id,
        attempts: row.attempts,
        leaseUntil: row.lease_until,
        jobId: row.job_id,
        causation: row.causation,
      }))
      .sort((a, b) => (a.recordId < b.recordId ? -1 : 1));
  }

  /** Changes rows this batch still holds (`running` with their lease). */
  private async held(
    scope: OrgScope,
    fieldId: Id<'fld'>,
    rows: readonly TakenAiRow[],
    set: RawBuilder<unknown>,
  ): Promise<void> {
    if (rows.length === 0) return;
    await sql`
      UPDATE meta.ai_generation_queue AS q SET ${set}
        FROM unnest(${sql.val(rows.map((row) => row.recordId))}::text[],
                    ${sql.val(rows.map((row) => row.leaseUntil.toISOString()))}::timestamptz[])
             AS h(record_id, lease_until)
       WHERE q.organization_id = ${scope.organizationId} AND q.field_id = ${fieldId}
         AND q.record_id = h.record_id AND q.status = 'running' AND q.lease_until = h.lease_until
    `.execute(this.executor(scope));
  }

  /** Done (value written or nothing to write): the rows go away unless queued again meanwhile. */
  async finish(scope: OrgScope, fieldId: Id<'fld'>, rows: readonly TakenAiRow[]): Promise<void> {
    if (rows.length === 0) return;
    await sql`
      DELETE FROM meta.ai_generation_queue AS q
       USING unnest(${sql.val(rows.map((row) => row.recordId))}::text[],
                    ${sql.val(rows.map((row) => row.leaseUntil.toISOString()))}::timestamptz[])
             AS h(record_id, lease_until)
       WHERE q.organization_id = ${scope.organizationId} AND q.field_id = ${fieldId}
         AND q.record_id = h.record_id AND q.status = 'running' AND q.lease_until = h.lease_until
    `.execute(this.executor(scope));
  }

  /** Back to `queued`, due after `delayMs` (`0`: now); `refund` gives the try back. */
  async requeue(
    scope: OrgScope,
    fieldId: Id<'fld'>,
    rows: readonly TakenAiRow[],
    options: { readonly delayMs?: number; readonly refund?: boolean } = {},
  ): Promise<void> {
    const delayMs = options.delayMs ?? 0;
    const due =
      delayMs > 0 ? sql`now() + ${`${String(delayMs)} milliseconds`}::interval` : sql`NULL`;
    const attempts = options.refund === true ? sql`greatest(q.attempts - 1, 0)` : sql`q.attempts`;
    await this.held(
      scope,
      fieldId,
      rows,
      sql`status = 'queued', lease_until = ${due}, attempts = ${attempts}`,
    );
  }

  /** `failed` with an error code (never a value). */
  async fail(
    scope: OrgScope,
    fieldId: Id<'fld'>,
    rows: readonly TakenAiRow[],
    reason: string,
  ): Promise<void> {
    await this.held(
      scope,
      fieldId,
      rows,
      sql`status = 'failed', reason = ${reason}, lease_until = NULL`,
    );
  }

  /**
   * Every `queued` row of the organization (or of `fieldId`) → `paused`
   * with `reason` (and, for `provider_error`, what the provider rejected);
   * returns the fields that had some.
   */
  async pause(
    scope: OrgScope,
    reason: AiPauseReason,
    options: { readonly fieldId?: Id<'fld'>; readonly detail?: AiProviderPauseDetail | null } = {},
  ): Promise<Id<'fld'>[]> {
    const { fieldId } = options;
    const { rows } = await sql<{ field_id: Id<'fld'> }>`
      UPDATE meta.ai_generation_queue
         SET status = 'paused', reason = ${storedPauseReason(reason, options.detail)},
             lease_until = NULL
       WHERE organization_id = ${scope.organizationId} AND status = 'queued'
         ${fieldId === undefined ? sql`` : sql`AND field_id = ${fieldId}`}
      RETURNING field_id
    `.execute(this.executor(scope));
    return [...new Set(rows.map((row) => row.field_id))].sort();
  }

  /** `paused` rows with one of `reasons` → `queued`; returns the fields that had some. */
  async resume(
    scope: OrgScope,
    reasons: readonly AiPauseReason[],
    fieldId?: Id<'fld'>,
  ): Promise<Id<'fld'>[]> {
    if (reasons.length === 0) return [];
    const { rows } = await sql<{ field_id: Id<'fld'> }>`
      UPDATE meta.ai_generation_queue
         SET status = 'queued', reason = NULL, lease_until = NULL
       WHERE organization_id = ${scope.organizationId} AND status = 'paused'
         AND split_part(reason, ':', 1) = ANY(${sql.val([...reasons])}::text[])
         ${fieldId === undefined ? sql`` : sql`AND field_id = ${fieldId}`}
      RETURNING field_id
    `.execute(this.executor(scope));
    return [...new Set(rows.map((row) => row.field_id))].sort();
  }

  /**
   * The organization backs off until `until`: every `queued` row due before
   * then waits until then (tries unchanged), and no row is taken meanwhile
   * (rows queued later included). Returns the fields that had some.
   */
  async backOff(scope: OrgScope, until: Date): Promise<Id<'fld'>[]> {
    const at = sql`date_trunc('milliseconds', ${until.toISOString()}::timestamptz)`;
    const { rows } = await sql<{ field_id: Id<'fld'> }>`
      UPDATE meta.ai_generation_queue
         SET reason = ${BACKOFF}, lease_until = ${at}
       WHERE organization_id = ${scope.organizationId} AND status = 'queued'
         AND (lease_until IS NULL OR lease_until <= ${at})
      RETURNING field_id
    `.execute(this.executor(scope));
    return [...new Set(rows.map((row) => row.field_id))].sort();
  }

  /** When the organization's back-off ends, `null` when it does not back off at `now`. */
  async backOffUntil(scope: OrgScope, now?: Date): Promise<Date | null> {
    const { rows } = await sql<{ until: Date | null }>`
      SELECT max(lease_until) AS until FROM meta.ai_generation_queue
       WHERE organization_id = ${scope.organizationId} AND status = 'queued'
         AND reason = ${BACKOFF} AND lease_until > ${instant(now)}
    `.execute(this.executor(scope));
    return rows[0]?.until ?? null;
  }

  /** `running` rows whose lease ended (their worker died) → `queued`; returns their fields. */
  async releaseExpired(scope: OrgScope): Promise<Id<'fld'>[]> {
    const { rows } = await sql<{ field_id: Id<'fld'> }>`
      UPDATE meta.ai_generation_queue
         SET status = 'queued', lease_until = NULL
       WHERE organization_id = ${scope.organizationId} AND status = 'running'
         AND lease_until < now()
      RETURNING field_id
    `.execute(this.executor(scope));
    return [...new Set(rows.map((row) => row.field_id))].sort();
  }

  /** Drops the rows of `fieldId` (field no longer AI), or only `recordIds` of it. */
  async clear(scope: OrgScope, fieldId: Id<'fld'>, recordIds?: readonly string[]): Promise<void> {
    let query = this.executor(scope)
      .deleteFrom('meta.ai_generation_queue')
      .where('organization_id', '=', scope.organizationId)
      .where('field_id', '=', fieldId);
    if (recordIds !== undefined) {
      if (recordIds.length === 0) return;
      query = query.where('record_id', 'in', [...recordIds] as Id<'rec'>[]);
    }
    await query.execute();
  }

  /**
   * Fields of the organization with `queued` rows, and when the first is due
   * (not before the organization's back-off ends), compared with `now`
   * (default: the database's clock).
   */
  async dueFields(scope: OrgScope, now?: Date): Promise<{ fieldId: Id<'fld'>; dueAt: Date }[]> {
    const at = instant(now);
    const { rows } = await sql<{ field_id: Id<'fld'>; due_at: Date }>`
      SELECT field_id,
             greatest(min(coalesce(lease_until, ${at})),
                      (SELECT max(b.lease_until) FROM meta.ai_generation_queue AS b
                        WHERE b.organization_id = ${scope.organizationId} AND b.status = 'queued'
                          AND b.reason = ${BACKOFF} AND b.lease_until > ${at})) AS due_at
        FROM meta.ai_generation_queue
       WHERE organization_id = ${scope.organizationId} AND status = 'queued'
       GROUP BY field_id ORDER BY field_id
    `.execute(this.executor(scope));
    return rows.map((row) => ({ fieldId: row.field_id, dueAt: row.due_at }));
  }

  /**
   * Counts per field (field DTO, `schema.changed`): never record ids. A
   * field with queued rows while the organization backs off has `retry_at`.
   */
  async statesOf(
    scope: OrgScope,
    fieldIds: readonly Id<'fld'>[],
  ): Promise<Map<Id<'fld'>, AiFieldStateDto>> {
    const out = new Map<Id<'fld'>, AiFieldStateDto>();
    for (const id of fieldIds) {
      out.set(id, {
        queued: 0,
        failed: 0,
        paused: 0,
        paused_reason: null,
        paused_detail: null,
        retry_at: null,
      });
    }
    if (fieldIds.length === 0) return out;
    const rows = await this.executor(scope)
      .selectFrom('meta.ai_generation_queue')
      .select(['field_id', 'status', sql<string | null>`min(reason)`.as('reason')])
      .select(sql<string>`count(*)::text`.as('n'))
      .where('organization_id', '=', scope.organizationId)
      .where('field_id', 'in', [...fieldIds])
      .groupBy(['field_id', 'status'])
      .execute();
    let backOff: Date | null | undefined;
    for (const row of rows) {
      const state = out.get(row.field_id);
      if (state === undefined) continue;
      const n = Number(row.n);
      if (row.status === 'failed') state.failed += n;
      else if (row.status === 'paused') {
        state.paused += n;
        const pause = pauseOf(row.reason);
        state.paused_reason = pause.reason;
        state.paused_detail = pause.detail;
      } else {
        state.queued += n;
        backOff ??= await this.backOffUntil(scope);
        if (backOff !== null) state.retry_at = backOff.toISOString();
      }
    }
    return out;
  }

  /** The state (and its reason code) of each listed cell that has a row (`record.meta.ai`). */
  async cellStates(
    scope: OrgScope,
    fieldIds: readonly Id<'fld'>[],
    recordIds: readonly string[],
  ): Promise<Pick<AiGenerationQueueRow, 'field_id' | 'record_id' | 'status' | 'reason'>[]> {
    if (fieldIds.length === 0 || recordIds.length === 0) return [];
    return this.executor(scope)
      .selectFrom('meta.ai_generation_queue')
      .select(['field_id', 'record_id', 'status', 'reason'])
      .where('organization_id', '=', scope.organizationId)
      .where('field_id', 'in', [...fieldIds])
      .where('record_id', 'in', [...recordIds] as Id<'rec'>[])
      .execute();
  }

  /** Records of `fieldId` whose row has `status` (`failed`: what "generate failed cells" queues). */
  async recordIdsOf(
    scope: OrgScope,
    fieldId: Id<'fld'>,
    status: AiCellState,
  ): Promise<Id<'rec'>[]> {
    const rows = await this.executor(scope)
      .selectFrom('meta.ai_generation_queue')
      .select('record_id')
      .where('organization_id', '=', scope.organizationId)
      .where('field_id', '=', fieldId)
      .where('status', '=', status)
      .orderBy('record_id')
      .execute();
    return rows.map((row) => row.record_id);
  }

  /** Rows of a generate request still to do (queued, running or paused). */
  async pendingOfJob(scope: OrgScope, jobId: Id<'job'>): Promise<number> {
    const row = await this.executor(scope)
      .selectFrom('meta.ai_generation_queue')
      .select(sql<string>`count(*)::text`.as('n'))
      .where('organization_id', '=', scope.organizationId)
      .where('job_id', '=', jobId)
      .where('status', 'in', ['queued', 'running', 'paused'] satisfies AiCellState[])
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  /** Failed rows of a generate request. */
  async failedOfJob(scope: OrgScope, jobId: Id<'job'>): Promise<number> {
    const row = await this.executor(scope)
      .selectFrom('meta.ai_generation_queue')
      .select(sql<string>`count(*)::text`.as('n'))
      .where('organization_id', '=', scope.organizationId)
      .where('job_id', '=', jobId)
      .where('status', '=', 'failed')
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }
}
