import { sql } from 'kysely';

import { jsonb } from '../db/json.js';
import {
  TenantRepository,
  type OrgScope,
  type TenantRepositoryContract,
} from '../db/repository.js';

import type { Db } from '../db/create-db.js';
import type { HttpDeliveriesTable, HttpDeliveryRow, JsonObject } from '../db/schema.js';
import type { Id } from '@cellhive/contracts';
import type { Insertable } from 'kysely';

export type NewHttpDelivery = Omit<
  Insertable<HttpDeliveriesTable>,
  'organization_id' | 'created_at' | 'status' | 'attempts' | 'completed_at' | 'lease_until'
>;

/** What leasing a row found (phase 2, TX-a). */
export type HttpDeliveryLease =
  /** No row, or another transaction holds it right now (`SKIP LOCKED`). */
  | { readonly state: 'missing' }
  | { readonly state: 'final'; readonly row: HttpDeliveryRow }
  /** `pending` but not due yet: the job came early. */
  | { readonly state: 'early'; readonly row: HttpDeliveryRow; readonly at: Date }
  /** `sending` under a live lease of another worker. */
  | { readonly state: 'leased'; readonly row: HttpDeliveryRow; readonly at: Date }
  /** Ours now: `sending`, `attempts + 1`, `lease_until` set. */
  | { readonly state: 'acquired'; readonly row: HttpDeliveryRow };

/** The outcome written by phase 2 (TX-b) for the attempt it leased. */
export interface HttpDeliveryOutcome {
  readonly at: Date;
  readonly lastStatus: number | null;
  readonly lastError: JsonObject | null;
}

const FINAL = ['succeeded', 'failed', 'cancelled'] as const;

/**
 * `meta.http_deliveries` (BACKLOG T605, ADR-35 §4). Every query is scoped
 * by `organization_id`. Phase-2 writes are fenced by the attempt number
 * they leased (`status = 'sending' AND attempts = :attempt`): a worker
 * whose lease expired and was taken over never overwrites the newer
 * attempt.
 */
export class HttpDeliveriesRepository
  extends TenantRepository<'http_deliveries'>
  implements TenantRepositoryContract<HttpDeliveriesRepository>
{
  constructor(db: Db) {
    super(db, 'http_deliveries');
  }

  /**
   * Inserts a `pending` row, or returns the row that already has this
   * `idempotency_key` in the organization (a step run again).
   */
  async insertOrGet(
    scope: OrgScope,
    input: NewHttpDelivery,
  ): Promise<{ readonly row: HttpDeliveryRow; readonly created: boolean }> {
    const inserted = await this.executor(scope)
      .insertInto('meta.http_deliveries')
      .values({ ...input, organization_id: scope.organizationId })
      .onConflict((oc) => oc.columns(['organization_id', 'idempotency_key']).doNothing())
      .returningAll()
      .executeTakeFirst();
    if (inserted !== undefined) return { row: inserted, created: true };
    const existing = await this.executor(scope)
      .selectFrom('meta.http_deliveries')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('idempotency_key', '=', input.idempotency_key)
      .executeTakeFirstOrThrow();
    return { row: existing, created: false };
  }

  async get(scope: OrgScope, id: Id<'hdl'>): Promise<HttpDeliveryRow | undefined> {
    return this.executor(scope)
      .selectFrom('meta.http_deliveries')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
  }

  /**
   * TX-a of phase 2 (`scope.tx` required): locks the row `FOR UPDATE SKIP
   * LOCKED` and takes it when it is `pending` and due, or `sending` with an
   * expired lease (its worker died) — `sending`, `attempts + 1`,
   * `lease_until = now + leaseMs`.
   */
  async lease(
    scope: OrgScope,
    id: Id<'hdl'>,
    input: { readonly now: Date; readonly leaseMs: number },
  ): Promise<HttpDeliveryLease> {
    if (scope.tx === undefined) throw new TypeError('lease needs a transaction scope');
    const row = await this.executor(scope)
      .selectFrom('meta.http_deliveries')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .forUpdate()
      .skipLocked()
      .executeTakeFirst();
    if (row === undefined) return { state: 'missing' };
    if ((FINAL as readonly string[]).includes(row.status)) return { state: 'final', row };
    const now = input.now.getTime();
    if (row.status === 'pending' && row.next_attempt_at.getTime() > now) {
      return { state: 'early', row, at: row.next_attempt_at };
    }
    if (row.status === 'sending' && row.lease_until !== null && row.lease_until.getTime() > now) {
      return { state: 'leased', row, at: row.lease_until };
    }
    const acquired = await this.executor(scope)
      .updateTable('meta.http_deliveries')
      .set({
        status: 'sending',
        attempts: sql<number>`attempts + 1`,
        lease_until: new Date(now + input.leaseMs),
      })
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return { state: 'acquired', row: acquired };
  }

  /**
   * Gives a leased attempt back without counting it (the pacer said "wait"):
   * `pending` again, `attempts - 1`, due at `nextAttemptAt`. `false` when
   * the lease is no longer ours.
   */
  async release(
    scope: OrgScope,
    id: Id<'hdl'>,
    attempt: number,
    nextAttemptAt: Date,
  ): Promise<boolean> {
    const result = await this.leased(scope, id, attempt)
      .set({
        status: 'pending',
        attempts: sql<number>`attempts - 1`,
        lease_until: null,
        next_attempt_at: nextAttemptAt,
      })
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /** `succeeded` with its response; the request is erased. `undefined` when not ours any more. */
  async succeed(
    scope: OrgScope,
    id: Id<'hdl'>,
    attempt: number,
    input: HttpDeliveryOutcome & { readonly response: JsonObject },
  ): Promise<HttpDeliveryRow | undefined> {
    return this.leased(scope, id, attempt)
      .set({
        status: 'succeeded',
        request_enc: null,
        lease_until: null,
        completed_at: input.at,
        last_status: input.lastStatus,
        last_error: null,
        response: jsonb(input.response),
      })
      .returningAll()
      .executeTakeFirst();
  }

  /** Back to `pending` for the next attempt at `nextAttemptAt`. */
  async retryLater(
    scope: OrgScope,
    id: Id<'hdl'>,
    attempt: number,
    input: HttpDeliveryOutcome & { readonly nextAttemptAt: Date },
  ): Promise<HttpDeliveryRow | undefined> {
    return this.leased(scope, id, attempt)
      .set({
        status: 'pending',
        lease_until: null,
        next_attempt_at: input.nextAttemptAt,
        last_status: input.lastStatus,
        last_error: input.lastError === null ? null : jsonb(input.lastError),
      })
      .returningAll()
      .executeTakeFirst();
  }

  /** `failed` for good (with the last response, if any); the request is erased. */
  async fail(
    scope: OrgScope,
    id: Id<'hdl'>,
    attempt: number,
    input: HttpDeliveryOutcome & { readonly response?: JsonObject | null },
  ): Promise<HttpDeliveryRow | undefined> {
    return this.leased(scope, id, attempt)
      .set({
        status: 'failed',
        request_enc: null,
        lease_until: null,
        completed_at: input.at,
        last_status: input.lastStatus,
        last_error: input.lastError === null ? null : jsonb(input.lastError),
        ...(input.response === undefined || input.response === null
          ? {}
          : { response: jsonb(input.response) }),
      })
      .returningAll()
      .executeTakeFirst();
  }

  /**
   * The `pending` deliveries of these runs become `cancelled` (run
   * cancelled or its automation turned off — T518, T506); a `sending` one
   * finishes and its result is ignored. Returns how many.
   */
  async cancelPendingOfRuns(scope: OrgScope, runIds: readonly Id<'run'>[]): Promise<number> {
    if (runIds.length === 0) return 0;
    const result = await this.executor(scope)
      .updateTable('meta.http_deliveries')
      .set({
        status: 'cancelled',
        request_enc: null,
        lease_until: null,
        completed_at: sql<Date>`now()`,
      })
      .where('organization_id', '=', scope.organizationId)
      .where('run_id', 'in', [...runIds])
      .where('status', '=', 'pending')
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  /** Deliveries of a run (run detail), oldest first. */
  async listForRun(scope: OrgScope, runId: Id<'run'>): Promise<HttpDeliveryRow[]> {
    return this.executor(scope)
      .selectFrom('meta.http_deliveries')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('run_id', '=', runId)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
  }

  private leased(scope: OrgScope, id: Id<'hdl'>, attempt: number) {
    return this.executor(scope)
      .updateTable('meta.http_deliveries')
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .where('status', '=', 'sending')
      .where('attempts', '=', attempt);
  }
}
