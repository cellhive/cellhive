import {
  automationDefinitionSchema,
  CANCELLABLE_RUN_STATUSES,
  newId,
  RERUNNABLE_RUN_STATUSES,
  type AutomationDefinition,
  type Id,
} from '@cellhive/contracts';

import { AuditWriter } from '../../audit/audit-writer.js';
import { withTxScope, type OrgScope } from '../../db/repository.js';
import { AppError } from '../../errors/app-error.js';
import { enqueue } from '../../jobs/enqueue.js';
import { flattenActions } from '../definition/validate.js';
import { cancelWaitingRun } from '../engine/cancel.js';
import { stepIdempotencyKey } from '../engine/run-engine.js';
import { AutomationRunStepsRepository } from '../repository/automation-run-steps.repository.js';
import {
  AutomationRunsRepository,
  type RunLogFilter,
  type RunLogRow,
} from '../repository/automation-runs.repository.js';
import { AutomationsRepository } from '../repository/automations.repository.js';
import { publishButtonRunFinished } from '../triggers/button/run-finished.js';

import type { AuditContext } from '../../audit/audit-entry.js';
import type { Db } from '../../db/create-db.js';
import type { KeysetCursor } from '../../db/cursor.js';
import type { AutomationRunRow, AutomationRunStepRow, JsonObject } from '../../db/schema.js';

/** A run with its steps and re-runs (`GET /automation-runs/:id`). */
export interface RunLogDetail {
  readonly run: RunLogRow;
  readonly steps: AutomationRunStepRow[];
  readonly reruns: Pick<AutomationRunRow, 'id' | 'status' | 'created_at'>[];
}

/** Who stops or repeats a run, and the audit context of the request. */
export interface RunLogActor {
  readonly userId: Id<'usr'>;
  readonly context: AuditContext;
}

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const includes = <T extends string>(list: readonly T[], value: string): value is T =>
  (list as readonly string[]).includes(value);

function runStateConflict(detail: string): AppError {
  return new AppError('RUN_STATE_CONFLICT', { detail });
}

/** The definition of a run's snapshot (`input.definition`), or `null` when it no longer parses. */
export function runDefinitionOf(run: Pick<AutomationRunRow, 'input'>): AutomationDefinition | null {
  const input = isObject(run.input) ? run.input : {};
  const parsed = automationDefinitionSchema.safeParse(input['definition']);
  return parsed.success ? parsed.data : null;
}

/** An action of a run's definition, as the run log needs it. */
export interface RunAction {
  readonly type: string;
  readonly tableId: string | null;
  readonly config: unknown;
}

/** Action id → `{ type, table_id, config }` of a definition (actions inside `if` included). */
export function actionsOf(definition: AutomationDefinition | null): Map<string, RunAction> {
  const actions = new Map<string, RunAction>();
  if (definition === null) return actions;
  for (const { action } of flattenActions(definition.actions)) {
    const config: unknown = 'config' in action ? action.config : undefined;
    const tableId =
      isObject(config) && typeof config['table_id'] === 'string' ? config['table_id'] : null;
    actions.set(action.id, { type: action.type, tableId, config });
  }
  return actions;
}

/**
 * The run log of automations (SPEC §11.1, §11.7; CONTRACTS §21; BACKLOG
 * T518): lists, details, re-runs and cancellation. Callers check that the
 * person manages the automation (ADR-25 §3) and hide values they cannot read
 * (`redactStepOutput`); everything here is scoped to one organization.
 *
 * - **Re-run** ("Quyết định S5 thiết kế" #4): a **new** run of a `failed` or
 *   `cancelled` run, with the automation's **current** definition and
 *   version and the original trigger; the steps that succeeded in the
 *   original (same action id and type in the current definition) are copied
 *   as `succeeded`, so the engine reuses their output and never repeats
 *   their side effects ("continue from the failed step"). Only one re-run of
 *   a run may be unfinished at a time.
 * - **Cancel**: a `queued` run or one `waiting` in a `delay` (T506) becomes
 *   `cancelled` (`cancelled_by_user`); a job still scheduled for it then
 *   finds nothing to do. `waiting` steps become `cancelled`.
 */
export class AutomationRunLog {
  private readonly runs: AutomationRunsRepository;
  private readonly steps: AutomationRunStepsRepository;
  private readonly automations: AutomationsRepository;
  private readonly audit = new AuditWriter();

  constructor(
    private readonly db: Db,
    private readonly options: { readonly now?: () => Date } = {},
  ) {
    this.runs = new AutomationRunsRepository(db);
    this.steps = new AutomationRunStepsRepository(db);
    this.automations = new AutomationsRepository(db);
  }

  list(
    scope: OrgScope,
    filter: RunLogFilter,
    page: { readonly cursor: KeysetCursor | null; readonly limit: number },
  ): Promise<{ items: RunLogRow[]; nextCursor: string | null }> {
    return this.runs.listPage(scope, filter, page);
  }

  async detail(scope: OrgScope, runId: Id<'run'>): Promise<RunLogDetail | undefined> {
    const run = await this.runs.getForLog(scope, runId);
    if (run === undefined) return undefined;
    const [steps, reruns] = await Promise.all([
      this.steps.listByRun(scope, runId),
      this.runs.listReruns(scope, runId),
    ]);
    return { run, steps, reruns };
  }

  /**
   * Repeats a `failed`/`cancelled` run as a new `queued` run (see the class
   * comment). `404` when the run or its automation is gone; `409
   * RUN_STATE_CONFLICT` in another state or while a re-run of it is
   * unfinished; `422 AUTOMATION_INVALID` when the stored definition no
   * longer parses.
   */
  async rerun(scope: OrgScope, runId: Id<'run'>, actor: RunLogActor): Promise<Id<'run'>> {
    return this.db.withTx(async (tx) => {
      const txScope = withTxScope(scope, tx);
      // Automation first, then the run: the order of every other writer (T507).
      const automationId = await this.runs.automationIdOf(txScope, runId);
      if (automationId === undefined) throw new AppError('NOT_FOUND');
      const automation = await this.automations.lockForUpdate(txScope, automationId);
      if (automation === undefined) throw new AppError('NOT_FOUND');
      const original = await this.runs.lockById(txScope, runId);
      if (original === undefined) throw new AppError('NOT_FOUND');
      if (!includes(RERUNNABLE_RUN_STATUSES, original.status)) {
        throw runStateConflict('Only a failed or cancelled run can be run again.');
      }
      if (await this.runs.hasActiveRerun(txScope, runId)) {
        throw runStateConflict('A re-run of this run has not finished yet.');
      }
      const parsed = automationDefinitionSchema.safeParse(automation.definition);
      const definition = parsed.success ? parsed.data : null;
      if (definition === null) {
        throw new AppError('AUTOMATION_INVALID', {
          detail: 'The automation definition is outdated: save it again before running it.',
          errors: [
            { path: 'definition', code: 'INVALID', message: 'The stored definition is outdated' },
          ],
        });
      }
      const input = isObject(original.input) ? original.input : {};
      const trigger = isObject(input['trigger']) ? input['trigger'] : {};
      const id = newId('run');
      const created = await this.runs.insert(txScope, {
        id,
        automationId: automation.id,
        automationVersion: automation.version,
        triggerEventId: null,
        triggerUnit: original.trigger_unit,
        status: 'queued',
        depth: original.depth,
        input: {
          automation_version: automation.version,
          definition: definition as unknown as JsonObject,
          trigger,
          rerun_of: original.id,
        },
        rerun: { of: original.id, by: actor.userId },
      });
      if (created === undefined) throw new AppError('INTERNAL');
      // Steps the original finished that are still the same action (type and
      // table) in the current definition: reused, never run again.
      const current = actionsOf(definition);
      const before = actionsOf(runDefinitionOf(original));
      const done = (await this.steps.listByRun(txScope, original.id)).filter((step) => {
        const now = current.get(step.action_id);
        const then = before.get(step.action_id);
        const type = isObject(step.input) ? step.input['type'] : undefined;
        return (
          step.status === 'succeeded' &&
          now !== undefined &&
          then !== undefined &&
          now.type === type &&
          then.type === type &&
          now.tableId === then.tableId
        );
      });
      await this.steps.copySucceeded(txScope, {
        steps: done,
        toRunId: id,
        keyOf: (actionId) => stepIdempotencyKey(created, actionId),
        newId: () => newId('stp'),
      });
      await enqueue(tx, 'automation.run', { organization_id: scope.organizationId, run_id: id });
      await this.audit.write(tx, {
        action: 'automation.run.rerun',
        organizationId: scope.organizationId,
        baseId: automation.base_id,
        tableId: automation.trigger_table_id,
        entityType: 'automation_run',
        entityId: id,
        before: null,
        after: {
          automation_id: automation.id,
          automation_version: automation.version,
          rerun_of: original.id,
          original_status: original.status,
          original_version: original.automation_version,
          reused_steps: done.map((step) => step.action_id),
        },
        context: actor.context,
      });
      return id;
    });
  }

  /**
   * Cancels a `queued` or `waiting` run (`cancelled_by_user`). `404` when it
   * is gone; `409 RUN_STATE_CONFLICT` in another state (running, finished).
   */
  async cancel(scope: OrgScope, runId: Id<'run'>, actor: RunLogActor): Promise<void> {
    await this.db.withTx(async (tx) => {
      const txScope = withTxScope(scope, tx);
      const run = await this.runs.lockById(txScope, runId);
      if (run === undefined) throw new AppError('NOT_FOUND');
      if (!includes(CANCELLABLE_RUN_STATUSES, run.status)) {
        throw runStateConflict(
          'Only a run that has not started or waits in a delay can be cancelled.',
        );
      }
      const error = { code: 'cancelled_by_user', params: { user_id: actor.userId } };
      // A run inside a `delay`: T506's hook (its waiting step is cancelled too).
      const cancelled =
        run.status === 'waiting'
          ? await cancelWaitingRun(this.db, txScope, runId, error)
          : (await this.runs.cancelQueued(txScope, runId, {
              at: this.options.now?.() ?? new Date(),
              error,
            })) !== undefined;
      if (!cancelled) throw runStateConflict('The run started meanwhile.');
      // The clicker of a button learns that its run ended (T517).
      await publishButtonRunFinished(this.db, tx, scope.organizationId, run, 'cancelled');
      const automation = await this.automations.get(txScope, run.automation_id);
      await this.audit.write(tx, {
        action: 'automation.run.cancelled',
        organizationId: scope.organizationId,
        ...(automation === undefined
          ? {}
          : { baseId: automation.base_id, tableId: automation.trigger_table_id }),
        entityType: 'automation_run',
        entityId: runId,
        before: { status: run.status },
        after: { status: 'cancelled', automation_id: run.automation_id },
        context: actor.context,
      });
    });
  }

  /** Latest run and run counts of automations (the automation list). */
  stats(scope: OrgScope, automationIds: readonly Id<'aut'>[]) {
    return this.runs.statsOf(scope, automationIds);
  }
}
