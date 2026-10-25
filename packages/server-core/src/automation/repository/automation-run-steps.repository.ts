import { sql } from 'kysely';

import { jsonb } from '../../db/json.js';
import {
  TenantRepository,
  type OrgScope,
  type TenantRepositoryContract,
} from '../../db/repository.js';

import type { Db } from '../../db/create-db.js';
import type {
  AutomationRunStepRow,
  AutomationStepStatusKind,
  JsonObject,
} from '../../db/schema.js';
import type { Id } from '@cellhive/contracts';

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface BeginStepInput {
  readonly id: Id<'stp'>;
  readonly runId: Id<'run'>;
  readonly actionId: string;
  /** `automation_id:trigger_event_id:action_id` (SPEC §11.7). */
  readonly idempotencyKey: string;
  /** Configuration summary of the attempt (never record values). */
  readonly input?: JsonObject | null;
  /** Engine clock. */
  readonly at: Date;
}

/**
 * `meta.automation_run_steps` (SPEC §5.10, §11.7; BACKLOG T505): one row
 * per (run, action), keyed by `idempotency_key`, created **before** the
 * side effect. A step `succeeded` is never run again (a retried or resumed
 * run reads its output); any other state is attempted again with
 * `attempt + 1`. Every query is scoped by `organization_id`.
 */
export class AutomationRunStepsRepository
  extends TenantRepository<'automation_run_steps'>
  implements TenantRepositoryContract<AutomationRunStepsRepository>
{
  constructor(db: Db) {
    super(db, 'automation_run_steps');
  }

  /** Steps of a run, in the order they started. */
  async listByRun(scope: OrgScope, runId: Id<'run'>): Promise<AutomationRunStepRow[]> {
    return this.executor(scope)
      .selectFrom('meta.automation_run_steps')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('run_id', '=', runId)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
  }

  async findByKey(
    scope: OrgScope,
    idempotencyKey: string,
  ): Promise<AutomationRunStepRow | undefined> {
    return this.executor(scope)
      .selectFrom('meta.automation_run_steps')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirst();
  }

  /**
   * Starts an attempt: inserts the step (`running`, attempt 1) or, when the
   * key exists in this organization and is not `succeeded`, sets it
   * `running` again with `attempt + 1`. `undefined` when the step already
   * succeeded (nothing to do) or the key belongs to another organization.
   */
  async begin(scope: OrgScope, input: BeginStepInput): Promise<AutomationRunStepRow | undefined> {
    return this.executor(scope)
      .insertInto('meta.automation_run_steps')
      .values({
        id: input.id,
        organization_id: scope.organizationId,
        run_id: input.runId,
        action_id: input.actionId,
        idempotency_key: input.idempotencyKey,
        status: 'running',
        attempt: 1,
        started_at: input.at,
        ...(input.input == null ? {} : { input: jsonb(input.input) }),
      })
      .onConflict((oc) =>
        oc
          .column('idempotency_key')
          .doUpdateSet({
            status: 'running',
            attempt: sql<number>`meta.automation_run_steps.attempt + 1`,
            started_at: input.at,
            finished_at: null,
            error: null,
            ...(input.input == null ? {} : { input: jsonb(input.input) }),
          })
          .where('meta.automation_run_steps.organization_id', '=', scope.organizationId)
          .where('meta.automation_run_steps.status', '!=', 'succeeded'),
      )
      .returningAll()
      .executeTakeFirst();
  }

  // --- Run log (BACKLOG T518) ----------------------------------------------------------

  /**
   * Copies steps that succeeded in another run into a re-run, so the engine
   * reuses their output instead of running them again ("continue from the
   * failed step"): same status, attempt, times and output, `input.reused_from`
   * = the original step, the key given by `keyOf` (the re-run's own
   * idempotency key of that action).
   */
  async copySucceeded(
    scope: OrgScope,
    input: {
      readonly steps: readonly AutomationRunStepRow[];
      readonly toRunId: Id<'run'>;
      readonly keyOf: (actionId: string) => string;
      readonly newId: () => Id<'stp'>;
    },
  ): Promise<number> {
    const rows = input.steps.filter((step) => step.status === 'succeeded');
    if (rows.length === 0) return 0;
    await this.executor(scope)
      .insertInto('meta.automation_run_steps')
      .values(
        rows.map((step) => ({
          id: input.newId(),
          organization_id: scope.organizationId,
          run_id: input.toRunId,
          action_id: step.action_id,
          idempotency_key: input.keyOf(step.action_id),
          status: 'succeeded' as const,
          attempt: step.attempt,
          started_at: step.started_at,
          finished_at: step.finished_at,
          input: jsonb({
            ...(isJsonObject(step.input) ? step.input : {}),
            reused_from: step.id,
          }),
          ...(step.output === null ? {} : { output: jsonb(step.output) }),
        })),
      )
      .execute();
    return rows.length;
  }

  /** Steps of a cancelled run still `waiting` (a `delay`, T506) become `cancelled`. */
  async cancelWaiting(scope: OrgScope, runId: Id<'run'>, at: Date): Promise<void> {
    await this.executor(scope)
      .updateTable('meta.automation_run_steps')
      .set({ status: 'cancelled', finished_at: at })
      .where('organization_id', '=', scope.organizationId)
      .where('run_id', '=', runId)
      .where('status', '=', 'waiting')
      .execute();
  }

  /** Ends an attempt (`succeeded` with its output, `failed`/`skipped` with an error). */
  async finish(
    scope: OrgScope,
    stepId: Id<'stp'>,
    input: {
      readonly status: Exclude<AutomationStepStatusKind, 'running'>;
      readonly at: Date;
      readonly output?: JsonObject | null;
      readonly error?: JsonObject | null;
    },
  ): Promise<void> {
    await this.executor(scope)
      .updateTable('meta.automation_run_steps')
      .set({
        status: input.status,
        finished_at: input.at,
        ...(input.output === undefined
          ? {}
          : { output: input.output === null ? null : jsonb(input.output) }),
        ...(input.error === undefined
          ? {}
          : { error: input.error === null ? null : jsonb(input.error) }),
      })
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', stepId)
      .execute();
  }

  // --- `delay` and `update_records` (BACKLOG T506) -----------------------------------

  /**
   * Saves the output of a step still running (progress of `update_records`
   * after each batch), in the transaction of the batch it describes.
   */
  async saveProgress(scope: OrgScope, stepId: Id<'stp'>, output: JsonObject): Promise<void> {
    await this.executor(scope)
      .updateTable('meta.automation_run_steps')
      .set({ output: jsonb(output) })
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', stepId)
      .where('status', '=', 'running')
      .execute();
  }

  /** A `running` step goes `waiting` (inside a `delay`) with its output (`until`). */
  async wait(scope: OrgScope, stepId: Id<'stp'>, output: JsonObject): Promise<void> {
    await this.executor(scope)
      .updateTable('meta.automation_run_steps')
      .set({ status: 'waiting', output: jsonb(output), error: null })
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', stepId)
      .execute();
  }

  /**
   * The `waiting` step goes `running` again when its delay is over, without
   * counting an attempt (waiting is not a failure); `undefined` when it is
   * no longer `waiting`.
   */
  async resume(
    scope: OrgScope,
    stepId: Id<'stp'>,
    at: Date,
  ): Promise<AutomationRunStepRow | undefined> {
    return this.executor(scope)
      .updateTable('meta.automation_run_steps')
      .set({ status: 'running', started_at: at })
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', stepId)
      .where('status', '=', 'waiting')
      .returningAll()
      .executeTakeFirst();
  }

  /** The `waiting` step of a run (if any) is cancelled with its run. */
  async cancelWaitingOf(scope: OrgScope, runId: Id<'run'>): Promise<void> {
    await this.executor(scope)
      .updateTable('meta.automation_run_steps')
      .set({ status: 'cancelled', finished_at: sql<Date>`now()` })
      .where('organization_id', '=', scope.organizationId)
      .where('run_id', '=', runId)
      .where('status', 'in', ['waiting', 'running'])
      .execute();
  }

  /** The `waiting` step of a run (its `delay`), if any. */
  async findWaiting(scope: OrgScope, runId: Id<'run'>): Promise<AutomationRunStepRow | undefined> {
    return this.executor(scope)
      .selectFrom('meta.automation_run_steps')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('run_id', '=', runId)
      .where('status', '=', 'waiting')
      .executeTakeFirst();
  }
}
