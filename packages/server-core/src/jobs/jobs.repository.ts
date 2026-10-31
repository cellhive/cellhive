import { newId, type Id } from '@cellhive/contracts';
import { sql } from 'kysely';

import {
  orgScope,
  TenantRepository,
  type OrgScope,
  type TenantRepositoryContract,
} from '../db/repository.js';
import { publishJobProgress } from '../realtime/publishers.js';

import type { Db, Tx } from '../db/create-db.js';
import type { JobsTable, JobStatus, JsonObject } from '../db/schema.js';
import type { Selectable } from 'kysely';

/** A row of `meta.jobs`: a background job users can follow (`GET /jobs/:id`, CONTRACTS §12.2). */
export type JobRecord = Selectable<JobsTable>;

/** Statuses a job cannot leave. */
export const FINAL_JOB_STATUSES = [
  'succeeded',
  'failed',
  'cancelled',
] as const satisfies readonly JobStatus[];

/** `error` of a failed job: problem+json (CONTRACTS §12.2), never a stack trace. */
export type JobProblem = JsonObject & { readonly code: string };

export interface CreateJobInput {
  readonly id?: Id<'job'>;
  /** e.g. `base.export`, `base.import`, `audit.export`. */
  readonly type: string;
  /** `null` = started by the system. */
  readonly createdBy: Id<'usr'> | null;
  /** Details known at the start (e.g. the rows of an AI generate request, T910). */
  readonly result?: JsonObject | null;
}

function assertProgress(progress: number): void {
  if (!Number.isFinite(progress) || progress < 0 || progress > 1) {
    throw new RangeError('JobsRepository: progress must be between 0 and 1');
  }
}

/**
 * `meta.jobs` (SPEC §5.10): status of user-visible background jobs.
 * graphile-worker deletes its own row when a job ends, so this table keeps
 * the outcome. Transitions: `queued → running → succeeded | failed`, and
 * `queued | running → cancelled`; an update that does not match the current
 * status returns `undefined` instead of overwriting a final state.
 *
 * Every state or progress change is also published as `job.progress` to
 * the creator's `user:` channel (CONTRACTS §7) on the realtime bus attached
 * to the `Db` (`attachRealtimePublisher`), after the transaction commits.
 */
export class JobsRepository
  extends TenantRepository<'jobs'>
  implements TenantRepositoryContract<JobsRepository>
{
  constructor(db: Db) {
    super(db, 'jobs');
  }

  async create(scope: OrgScope, input: CreateJobInput): Promise<JobRecord> {
    const row = await this.executor(scope)
      .insertInto('meta.jobs')
      .values({
        id: input.id ?? newId('job'),
        organization_id: scope.organizationId,
        type: input.type,
        created_by: input.createdBy,
        ...(input.result === undefined ? {} : { result: input.result }),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await publishJobProgress(this.db, scope.tx, row);
    return row;
  }

  async getById(scope: OrgScope, id: Id<'job'>): Promise<JobRecord | undefined> {
    return this.executor(scope)
      .selectFrom('meta.jobs')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
  }

  /**
   * The row locked `FOR UPDATE` until the caller's transaction ends (`scope`
   * must carry it): a state change that depends on the current status (e.g.
   * cancelling an import that has not started, T548) cannot race another
   * transition such as `markRunning`.
   */
  async lockById(scope: OrgScope, id: Id<'job'>): Promise<JobRecord | undefined> {
    const executor = this.executor(scope);
    if (scope.tx === undefined) throw new TypeError('JobsRepository.lockById needs a transaction');
    return executor
      .selectFrom('meta.jobs')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
  }

  /** `queued → running`; call it in the transaction that acquired the org slot. */
  async markRunning(scope: OrgScope, id: Id<'job'>): Promise<JobRecord | undefined> {
    const row = await this.executor(scope)
      .updateTable('meta.jobs')
      .set({ status: 'running', started_at: sql<Date>`now()` })
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .where('status', '=', 'queued')
      .returningAll()
      .executeTakeFirst();
    await publishJobProgress(this.db, scope.tx, row);
    return row;
  }

  async setProgress(
    scope: OrgScope,
    id: Id<'job'>,
    progress: number,
  ): Promise<JobRecord | undefined> {
    assertProgress(progress);
    const row = await this.executor(scope)
      .updateTable('meta.jobs')
      .set({ progress })
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .where('status', '=', 'running')
      .returningAll()
      .executeTakeFirst();
    await publishJobProgress(this.db, scope.tx, row);
    return row;
  }

  async markSucceeded(
    scope: OrgScope,
    id: Id<'job'>,
    result: JsonObject | null = null,
  ): Promise<JobRecord | undefined> {
    const row = await this.executor(scope)
      .updateTable('meta.jobs')
      .set({ status: 'succeeded', progress: 1, result, finished_at: sql<Date>`now()` })
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .where('status', '=', 'running')
      .returningAll()
      .executeTakeFirst();
    await publishJobProgress(this.db, scope.tx, row);
    return row;
  }

  async markFailed(
    scope: OrgScope,
    id: Id<'job'>,
    error: JobProblem,
  ): Promise<JobRecord | undefined> {
    const row = await this.executor(scope)
      .updateTable('meta.jobs')
      .set({ status: 'failed', error, finished_at: sql<Date>`now()` })
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .where('status', 'in', ['queued', 'running'])
      .returningAll()
      .executeTakeFirst();
    await publishJobProgress(this.db, scope.tx, row);
    return row;
  }

  /**
   * The export file of a succeeded job was deleted (its link expired):
   * `result.download_url` is removed and `result.file_deleted` set.
   * `undefined` when the job is not a succeeded job of the organization.
   */
  async clearDownload(scope: OrgScope, id: Id<'job'>): Promise<JobRecord | undefined> {
    return this.executor(scope)
      .updateTable('meta.jobs')
      .set({
        result: sql<JsonObject>`(coalesce(result, '{}'::jsonb) - 'download_url') || '{"file_deleted": true}'::jsonb`,
      })
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .where('status', '=', 'succeeded')
      .returningAll()
      .executeTakeFirst();
  }

  async markCancelled(scope: OrgScope, id: Id<'job'>): Promise<JobRecord | undefined> {
    const row = await this.executor(scope)
      .updateTable('meta.jobs')
      .set({ status: 'cancelled', finished_at: sql<Date>`now()` })
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .where('status', 'in', ['queued', 'running'])
      .returningAll()
      .executeTakeFirst();
    await publishJobProgress(this.db, scope.tx, row);
    return row;
  }

  /** The oldest queued or running job of `type` in the organization, if any. */
  async findActive(scope: OrgScope, type: string): Promise<JobRecord | undefined> {
    return this.executor(scope)
      .selectFrom('meta.jobs')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('type', '=', type)
      .where('status', 'in', ['queued', 'running'])
      .orderBy('created_at')
      .orderBy('id')
      .executeTakeFirst();
  }

  /**
   * The base a job works on, when the job is tied to one: an import
   * (`meta.imports.job_id`) or a field conversion (`meta.field_conversions`
   * → its table). `null` when the job names no base (BACKLOG T704: API
   * tokens limited to bases only see jobs of those bases).
   */
  async baseIdOf(scope: OrgScope, id: Id<'job'>): Promise<Id<'bse'> | null> {
    const row = await this.executor(scope)
      .selectFrom('meta.jobs as j')
      .leftJoin('meta.imports as i', (join) =>
        join.onRef('i.organization_id', '=', 'j.organization_id').onRef('i.job_id', '=', 'j.id'),
      )
      .leftJoin('meta.field_conversions as c', (join) =>
        join.onRef('c.organization_id', '=', 'j.organization_id').onRef('c.job_id', '=', 'j.id'),
      )
      .leftJoin('meta.tables as t', (join) =>
        join.onRef('t.organization_id', '=', 'c.organization_id').onRef('t.id', '=', 'c.table_id'),
      )
      .select(['i.base_id as import_base_id', 't.base_id as conversion_base_id'])
      .where('j.organization_id', '=', scope.organizationId)
      .where('j.id', '=', id)
      .executeTakeFirst();
    return row?.import_base_id ?? row?.conversion_base_id ?? null;
  }

  /** Running jobs of `type` in the organization (ADR-18 `countRunning`). */
  async countRunning(scope: OrgScope, type: string): Promise<number> {
    const row = await this.executor(scope)
      .selectFrom('meta.jobs')
      .select((eb) => eb.fn.countAll<bigint>().as('count'))
      .where('organization_id', '=', scope.organizationId)
      .where('type', '=', type)
      .where('status', '=', 'running')
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }
}

/**
 * `countRunning` for `acquireOrgSlot` backed by `meta.jobs` of one type, the
 * default for generic background jobs (ADR-18 §2).
 */
export function countRunningJobsOf(
  jobs: JobsRepository,
  type: string,
): (tx: Tx, orgId: Id<'org'>) => Promise<number> {
  return (tx, orgId) => jobs.countRunning(orgScope(orgId, tx), type);
}
