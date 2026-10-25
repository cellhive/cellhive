import {
  canonicalTimeZone,
  AUTOMATION_RUN_TIMEOUT_MS,
  AUTOMATION_STEP_ERROR_CODES,
  automationDefinitionSchema,
  newId,
  type AutomationAction,
  type AutomationBranchAction,
  type AutomationDefinition,
  type AutomationRunErrorCode,
  type AutomationRunSkipCode,
  type AutomationStepErrorCode,
  type Id,
} from '@cellhive/contracts';

import { AuditWriter } from '../../audit/audit-writer.js';
import { OrganizationsRepository } from '../../db/repositories/organizations.repository.js';
import { withTxScope, type OrgScope } from '../../db/repository.js';
import { emit } from '../../events/event-writer.js';
import {
  childCausation,
  outboundHttpCausation,
  toEventDocument,
  type Causation,
} from '../../events/event.js';
import { EventsRepository } from '../../events/events.repository.js';
import {
  loadMemberAccessBase,
  resolveMemberBaseAccess,
  type AccessDefaults,
  MemberBaseAccess,
} from '../../import/member-access.js';
import { enqueue } from '../../jobs/enqueue.js';
import { acquireOrgSlot, type DeferrableJob } from '../../jobs/org-slot.js';
import { isOutboundHttpError } from '../../net/errors.js';
import {
  IncomingWebhookRequestsRepository,
  IncomingWebhooksRepository,
} from '../../webhooks/incoming/incoming-webhooks.repository.js';
import { RecipientMembersRepository } from '../actions/send-email/recipient-members.repository.js';
import { flattenActions } from '../definition/validate.js';
import { tripOnConsecutiveFailures } from '../dispatch/circuit-breaker.js';
import { AUTOMATION_NOTIFICATIONS, type AutomationNotifier } from '../dispatch/notifier.js';
import { AutomationRunStepsRepository } from '../repository/automation-run-steps.repository.js';
import { AutomationRunsRepository } from '../repository/automation-runs.repository.js';
import { AutomationsRepository } from '../repository/automations.repository.js';
import { runAsRevalidation } from '../revalidate/request.js';
import { publishButtonRunFinished } from '../triggers/button/run-finished.js';
import { AutomationValueEvaluator, refusedFunctionsIn } from '../values/evaluator.js';
import { eventActorId, previousValues } from '../values/event-data.js';
import { recordQueryReader } from '../values/record-reader.js';
import { type WebhookRequestData } from '../values/webhook-data.js';

import { classifyStepError, retryDelayMs, type StepFailure } from './errors.js';
import {
  deliveryFailureOf,
  deliveryIdOf,
  parkOnDelivery,
  waitsForDelivery,
  type HttpDeliveryWait,
} from './http-wait.js';
import { loadAutomationSchema } from './schema-context.js';

import type {
  AutomationActionContext,
  AutomationActionRegistry,
  AutomationActionResult,
  AutomationRunInfo,
} from './action-registry.js';
import type { AuditContext } from '../../audit/audit-entry.js';
import type { Db, Tx } from '../../db/create-db.js';
import type {
  AutomationRunRow,
  AutomationRunStepRow,
  JsonObject,
  JsonValue,
} from '../../db/schema.js';
import type { HttpOutbox } from '../../http-out/http-outbox.js';
import type { RecordQueryService } from '../../records/record-query.service.js';
import type { AutomationValidationContext } from '../definition/validate.js';

/** Lock kind of the per-organization slot (ADR-18: `hashtext('automation-org:' || org_id)`). */
export const AUTOMATION_ORG_SLOT = 'automation-org';

/** Default of `AUTOMATION_MAX_RUNNING_PER_ORG` (ADR-18). */
export const DEFAULT_MAX_RUNNING_PER_ORG = 5;

/**
 * `idempotency_key` of a step (SPEC §11.7):
 * `automation_id:trigger_event_id:action_id`, the run id standing in for a
 * run without event (`schedule`, a re-run of T518).
 */
export function stepIdempotencyKey(
  run: Pick<AutomationRunRow, 'automation_id' | 'trigger_event_id' | 'id'>,
  actionId: string,
): string {
  return `${run.automation_id}:${run.trigger_event_id ?? run.id}:${actionId}`;
}

/**
 * Told when an action found that `run_as` lost access to a table, field or
 * the base (ADR-25 §5 b): T507 enqueues `automation.revalidate_run_as` and
 * turns the automation off. Called in the transaction that fails the run.
 */
export interface RunAsAccessCheck {
  requestCheck(
    tx: Tx,
    input: {
      readonly organizationId: Id<'org'>;
      readonly automationId: Id<'aut'>;
      readonly runId: Id<'run'>;
    },
  ): Promise<void>;
}

/** Nothing more than the failed run (the automation stays on): tests of the engine alone. */
export const NO_RUN_AS_ACCESS_CHECK: RunAsAccessCheck = { requestCheck: () => Promise.resolve() };

export interface AutomationRunEngineOptions {
  readonly defaults: AccessDefaults;
  /** `RecordQueryService` for the reads of templates (`run_as`). */
  readonly query: RecordQueryService;
  readonly actions: AutomationActionRegistry;
  /** `AUTOMATION_MAX_RUNNING_PER_ORG`. */
  readonly maxRunningPerOrg?: number;
  /** `PUBLIC_URL`: record links of `[@url]`. */
  readonly publicUrl: string;
  readonly notifier?: AutomationNotifier;
  /** Default: the T507 check (`automation.revalidate_run_as` of the base). */
  readonly runAsAccess?: RunAsAccessCheck;
  /**
   * Outbox of HTTP actions (T605): a handler returning `{ delivery }` parks
   * its step on a delivery row; without it such a step fails with
   * `unsupported_action`.
   */
  readonly httpOutbox?: HttpOutbox;
  /** Engine clock: run time, timeout, retry times (tests pin it). */
  readonly now?: () => Date;
  /** Randomness of the retry and deferral jitter. */
  readonly random?: () => number;
  readonly runTimeoutMs?: number;
  /** Test hook: after a step committed, before the next one (simulates a dying worker). */
  readonly afterStep?: (step: {
    readonly runId: Id<'run'>;
    readonly actionId: string;
  }) => Promise<void>;
}

/** Job key of the job that resumes a `waiting` run (one pending per run, T506). */
export function automationWaitJobKey(runId: Id<'run'>): string {
  return `automation.run:wait:${runId}`;
}

/** What one `automation.run` job did with its run. */
export type RunEngineResult =
  | { readonly status: 'missing' | 'not_runnable' | 'deferred' }
  | { readonly status: 'retry_scheduled'; readonly step: string; readonly delayMs: number }
  | {
      /** Inside a `delay` (T506): the job resuming it is scheduled for `until` (ISO). */
      readonly status: 'waiting';
      readonly step?: string;
      readonly until: string;
    }
  | {
      /** Waiting for an outbound HTTP delivery (T605): the delivery wakes the run. */
      readonly status: 'waiting_delivery';
      readonly step: string;
      readonly deliveryId: Id<'hdl'>;
    }
  | {
      /** A `delay` recheck ended the run (T506). */
      readonly status: 'skipped';
      readonly code: AutomationRunSkipCode;
      readonly step: string;
    }
  | {
      readonly status: 'succeeded' | 'failed' | 'cancelled';
      readonly code?: AutomationRunErrorCode;
      readonly step?: string;
    };

type AnyAction = AutomationAction | AutomationBranchAction;

/** Trigger part of `automation_runs.input` (T503 `RunTriggerInput`; T508/T517 add `data`). */
interface RunTrigger {
  readonly event_id: Id<'evt'> | null;
  readonly event_created_at: string | null;
  readonly type: string;
  readonly table_id: Id<'tbl'> | null;
  readonly record_id: Id<'rec'> | null;
  readonly data: Readonly<Record<string, unknown>>;
  /** `webhook.received` (T604): the hook and the stored request the run reads. */
  readonly incoming_webhook_id: Id<'hok'> | null;
  readonly request_id: Id<'whr'> | null;
}

/** `trigger.type` of a run started by an incoming webhook (T604). */
const WEBHOOK_TRIGGER = 'webhook.received';

/** Everything a running run needs, loaded once per job. */
interface RunState {
  readonly scope: OrgScope;
  run: AutomationRunRow;
  readonly info: AutomationRunInfo;
  readonly automationVersion: number;
  readonly definition: AutomationDefinition;
  readonly access: MemberBaseAccess;
  readonly schema: AutomationValidationContext;
  readonly values: AutomationValueEvaluator;
  readonly audit: AuditContext;
  readonly causation: Causation;
  readonly steps: Map<string, AutomationRunStepRow>;
  readonly job: DeferrableJob;
  stepsRun: number;
}

/** How a run stops early. */
interface Stop {
  readonly kind: 'failed' | 'retry' | 'stop' | 'cancelled' | 'waiting' | 'skipped' | 'delivery';
  readonly failure?: StepFailure;
  readonly code?: AutomationRunErrorCode;
  readonly skip?: AutomationRunSkipCode;
  readonly step?: string;
  readonly delayMs?: number;
  readonly until?: Date;
  readonly deliveryId?: Id<'hdl'>;
}

const audit = new AuditWriter();

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function settingOf(settings: unknown, key: string): unknown {
  return isObject(settings) ? settings[key] : undefined;
}

/**
 * The run engine of `automation.run` (SPEC §11.1, §11.7; ADR-18, ADR-25,
 * ADR-26; BACKLOG T505). One call executes one job of one run:
 *
 * 1. **Slot** (ADR-18): a `queued` run takes one of the organization's
 *    `AUTOMATION_MAX_RUNNING_PER_ORG` slots under
 *    `pg_advisory_xact_lock(hashtext('automation-org:' || org))`, or the job
 *    is added again for `now + 5 s + jitter` (not a retry). A `running` run
 *    (its worker died) resumes with its slot; any other state is left alone,
 *    so a job delivered twice does nothing.
 * 2. **`run_as` now** (ADR-25 §1): its effective access resolved again (lost
 *    access to the base → `failed` `permission_denied`, T507 told); the
 *    definition is the snapshot of `input`; `REGEX*` in any template fails
 *    the run before any step (`unsupported_function`).
 * 3. **Steps**, in order, `if` one level: each step row is created with
 *    `idempotency_key = automation_id:trigger_event_id:action_id` **before**
 *    the side effect; a `succeeded` step is never run again (its output is
 *    reused); writes commit the step with the record change. Temporary
 *    errors are retried 5 times (10 s, 30 s, 2 min, 10 min, 30 min +
 *    jitter): the run goes back to `queued` and the job is added for later;
 *    other errors fail the step and the run at once.
 * 4. **Timeout**: 15 minutes of running (`active_ms` + the current segment;
 *    retry waits and `delay` do not count) → `failed` `run_timeout`.
 * 4b. **`delay`** (T506): the step goes `waiting`, the run `waiting` (its
 *    running segment ends, it holds no slot) and the job is added for the
 *    end of the delay (job key {@link automationWaitJobKey}). That job takes
 *    a slot like a `queued` run and resumes from the `waiting` step (no
 *    attempt counted); a job arriving early is put back for `until`. An
 *    automation turned off meanwhile → `cancelled` `automation_disabled`
 *    (`cancelWaitingRuns` also does it when it is turned off). The step can
 *    end the run `skipped` (recheck) — no event, no breaker.
 * 5. **End**: `succeeded` / `failed` with event + audit
 *    `automation.run.succeeded|failed` in one transaction; a failed run may
 *    trip the breaker (`tripOnConsecutiveFailures`, ADR-26 §5) and, when
 *    `run_as` lost a table or field, asks for the `run_as` check (T507).
 *
 * Writes go through `RecordMutationService` as `run_as` with
 * `actor_type = automation`, `via = { automation_id, run_id }` (plus
 * `incoming_webhook_id` for a `webhook.received` run, T604),
 * `batch_id = run_…` and `causation` one level deeper (SPEC §11.6), so the
 * loop guard of `events.dispatch` sees them. Never logs or stores record
 * values outside step outputs.
 */
export class AutomationRunEngine {
  private readonly runs: AutomationRunsRepository;
  private readonly steps: AutomationRunStepsRepository;
  private readonly automations: AutomationsRepository;
  private readonly events: EventsRepository;
  private readonly members: RecipientMembersRepository;
  private readonly organizations: OrganizationsRepository;
  private readonly hooks: IncomingWebhooksRepository;
  private readonly hookRequests: IncomingWebhookRequestsRepository;
  private readonly notifier: AutomationNotifier;
  private readonly runAsAccess: RunAsAccessCheck;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly cap: number;
  private readonly timeoutMs: number;

  constructor(
    private readonly db: Db,
    private readonly options: AutomationRunEngineOptions,
  ) {
    this.runs = new AutomationRunsRepository(db);
    this.steps = new AutomationRunStepsRepository(db);
    this.automations = new AutomationsRepository(db);
    this.events = new EventsRepository(db);
    this.members = new RecipientMembersRepository(db);
    this.organizations = new OrganizationsRepository(db);
    this.hooks = new IncomingWebhooksRepository(db);
    this.hookRequests = new IncomingWebhookRequestsRepository(db);
    this.notifier = options.notifier ?? AUTOMATION_NOTIFICATIONS;
    this.runAsAccess = options.runAsAccess ?? runAsRevalidation(db);
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
    this.cap = options.maxRunningPerOrg ?? DEFAULT_MAX_RUNNING_PER_ORG;
    this.timeoutMs = options.runTimeoutMs ?? AUTOMATION_RUN_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.cap) || this.cap < 1) {
      throw new RangeError('maxRunningPerOrg must be a positive integer');
    }
  }

  async execute(scope: OrgScope, runId: Id<'run'>, job: DeferrableJob): Promise<RunEngineResult> {
    const begun = await this.db.withTx(async (tx) => {
      const txScope = withTxScope(scope, tx);
      const run = await this.runs.lockById(txScope, runId);
      if (run === undefined) return { status: 'missing' as const };
      if (run.status === 'running') return { status: 'resume' as const, run };
      if (run.status === 'waiting') {
        // Inside a `delay` (T506): not before its end, whatever delivered this job.
        const waiting = await this.steps.findWaiting(txScope, runId);
        // Waiting for an HTTP delivery (T605): the delivery wakes the run.
        if (waitsForDelivery(waiting) && waiting !== undefined) {
          return {
            status: 'delivery' as const,
            step: waiting.action_id,
            deliveryId: deliveryIdOf(waiting.output) as Id<'hdl'>,
          };
        }
        const until = untilOf(waiting?.output ?? null);
        if (until !== null && until.getTime() > this.now().getTime()) {
          await this.scheduleResume(tx, scope, runId, until);
          return { status: 'early' as const, until, step: waiting?.action_id };
        }
      } else if (run.status !== 'queued') {
        return { status: 'not_runnable' as const };
      }
      const resumed = run.status === 'waiting';
      const slot = await acquireOrgSlot(tx, {
        orgId: scope.organizationId,
        kind: AUTOMATION_ORG_SLOT,
        cap: this.cap,
        countRunning: (inner) => this.runs.countRunning(withTxScope(scope, inner), this.timeoutMs),
        job,
        random: this.random,
      });
      if (!slot.acquired) return { status: 'deferred' as const };
      return {
        status: 'start' as const,
        resumed,
        run: await this.runs.startSegment(txScope, runId, this.now()),
      };
    });
    if (begun.status === 'delivery') {
      return { status: 'waiting_delivery', step: begun.step, deliveryId: begun.deliveryId };
    }
    if (begun.status === 'early') {
      return {
        status: 'waiting',
        until: begun.until.toISOString(),
        ...(begun.step === undefined ? {} : { step: begun.step }),
      };
    }
    if (begun.status !== 'start' && begun.status !== 'resume') return { status: begun.status };
    return this.process(scope, begun.run, job, begun.status === 'start' && begun.resumed);
  }

  /** Adds the job that resumes a `waiting` run at `until` (one per run: job key). */
  private async scheduleResume(
    tx: Tx,
    scope: OrgScope,
    runId: Id<'run'>,
    until: Date,
  ): Promise<void> {
    await enqueue(
      tx,
      'automation.run',
      { organization_id: scope.organizationId, run_id: runId },
      { runAt: until, jobKey: automationWaitJobKey(runId) },
    );
  }

  // --- Run --------------------------------------------------------------------------

  private async process(
    scope: OrgScope,
    run: AutomationRunRow,
    job: DeferrableJob,
    resumed = false,
  ): Promise<RunEngineResult> {
    const automation = await this.automations.get(scope, run.automation_id);
    if (automation === undefined || (resumed && !automation.enabled)) {
      // Deleted, or turned off while the run waited in a `delay` (T506).
      const code = automation === undefined ? 'automation_deleted' : 'automation_disabled';
      await this.finishRun(scope, run, null, 'cancelled', { code }, false, async (tx) => {
        await this.steps.cancelWaitingOf(withTxScope(scope, tx), run.id);
      });
      return { status: 'cancelled', code };
    }
    const input = isObject(run.input) ? run.input : {};
    const parsed = automationDefinitionSchema.safeParse(input['definition']);
    if (!parsed.success) {
      await this.finishRun(scope, run, null, 'failed', { code: 'invalid_definition' });
      return { status: 'failed', code: 'invalid_definition' };
    }
    const definition = parsed.data;
    const trigger = triggerOf(input['trigger']);
    const flat = flattenActions(definition.actions);

    // T604: the incoming webhook was deleted while the run waited (queue, `delay`):
    // nothing more runs; a waiting step ends with the run.
    if (trigger.type === WEBHOOK_TRIGGER && !(await this.hookIsLive(scope, trigger))) {
      await this.finishRun(
        scope,
        run,
        null,
        'failed',
        { code: 'webhook_deleted' },
        false,
        async (tx) => {
          await this.steps.cancelWaitingOf(withTxScope(scope, tx), run.id);
        },
      );
      return { status: 'failed', code: 'webhook_deleted' };
    }

    // REGEX in a stored template (written before the rule, or put in the database):
    // the step fails before anything runs (S4b-followup §1.4).
    const [refused] = refusedFunctionsIn(definition);
    if (refused !== undefined) {
      const action = flat
        .filter((item) => refused.path.startsWith(item.path))
        .sort((a, b) => b.path.length - a.path.length)[0]?.action;
      const failure: StepFailure = {
        code: 'unsupported_function',
        transient: null,
        params: { function: refused.function },
      };
      if (action !== undefined) {
        const step = await this.beginStep(scope, run, action);
        if (step !== undefined) {
          await this.failStepAndRun(scope, run, null, step, action.id, failure);
          return { status: 'failed', code: 'unsupported_function', step: action.id };
        }
      }
      await this.finishRun(scope, run, null, 'failed', { code: 'unsupported_function' });
      return { status: 'failed', code: 'unsupported_function' };
    }

    const loaded = await loadMemberAccessBase(this.db, scope, automation.base_id);
    const access =
      loaded === undefined
        ? undefined
        : await resolveMemberBaseAccess(
            this.db,
            scope,
            { userId: automation.run_as_user_id, baseId: automation.base_id },
            this.options.defaults,
            loaded,
          );
    if (access === undefined || loaded === undefined) {
      const failure: StepFailure = {
        code: 'permission_denied',
        transient: null,
        params: { scope: 'base' },
      };
      await this.finishRun(
        scope,
        run,
        null,
        'failed',
        { code: 'permission_denied', params: failure.params },
        true,
      );
      return { status: 'failed', code: 'permission_denied' };
    }

    const organization = await this.organizations.findById(scope.organizationId);
    const timeZone =
      canonicalTimeZone(settingOf(organization?.settings, 'timezone')) ??
      this.options.defaults.timeZone;
    const localeSetting = settingOf(organization?.settings, 'locale');
    const locale =
      typeof localeSetting === 'string' && localeSetting !== ''
        ? localeSetting
        : this.options.defaults.locale;
    const schema = await loadAutomationSchema(
      this.db,
      scope,
      automation.base_id,
      access.record.resolved.access,
      loaded.base.settings,
    );
    const existing = await this.steps.listByRun(scope, run.id);
    const steps = new Map(existing.map((step) => [step.action_id, step]));
    const outputs = new Map<string, unknown>();
    for (const step of existing) {
      if (step.status === 'succeeded') outputs.set(step.action_id, step.output);
    }
    const publicUrl = this.options.publicUrl.replace(/\/+$/u, '');
    const baseId = automation.base_id;
    const fromEvent = await this.eventData(scope, trigger, schema);
    const values = new AutomationValueEvaluator({
      context: schema,
      definition,
      reader: recordQueryReader(this.options.query, scope, access.record),
      trigger: {
        tableId: trigger.table_id,
        recordId: trigger.record_id,
        data: {
          ...(trigger.event_created_at === null ? {} : { fired_at: trigger.event_created_at }),
          ...fromEvent.data,
          ...trigger.data,
        },
      },
      userNames: fromEvent.userNames,
      ...(trigger.type === WEBHOOK_TRIGGER
        ? { webhook: { load: this.webhookLoader(scope, trigger) } }
        : {}),
      steps: outputs,
      timeZone,
      locale,
      now: this.now(),
      recordUrl: (tableId, recordId) =>
        `${publicUrl}/b/${encodeURIComponent(baseId)}/t/${encodeURIComponent(tableId)}?record=${encodeURIComponent(recordId)}`,
    });
    const state: RunState = {
      scope,
      run,
      info: {
        id: run.id,
        automationId: run.automation_id,
        baseId,
        triggerTableId: trigger.table_id,
        triggerRecordId: trigger.record_id,
        triggerEventId: run.trigger_event_id,
        triggerType: trigger.type,
        timeZone,
        locale,
        triggerEventCreatedAt: trigger.event_created_at,
        automationName: automation.name,
        baseName: loaded.base.name,
      },
      automationVersion: run.automation_version,
      definition,
      access,
      schema,
      values,
      audit: {
        actor: { type: 'automation', id: run.automation_id },
        // T604 (ADR-35 §6): writes of a run started by a hook name it, for the
        // notification listeners to group them (T608).
        via: {
          automation_id: run.automation_id,
          run_id: run.id,
          ...(trigger.type === WEBHOOK_TRIGGER && trigger.incoming_webhook_id !== null
            ? { incoming_webhook_id: trigger.incoming_webhook_id }
            : {}),
        },
        batch_id: run.id,
        request_id: null,
        ip: null,
        user_agent: null,
      },
      causation: await this.causationOf(scope, run, trigger),
      steps,
      job,
      stepsRun: existing.filter((step) => step.status === 'succeeded').length,
    };

    const stop = await this.runActions(state, definition.actions);
    if (stop === null || stop.kind === 'stop') {
      await this.finishRun(scope, state.run, state, 'succeeded', null);
      return { status: 'succeeded' };
    }
    if (stop.kind === 'retry') {
      return { status: 'retry_scheduled', step: stop.step ?? '', delayMs: stop.delayMs ?? 0 };
    }
    if (stop.kind === 'cancelled') return { status: 'cancelled' };
    if (stop.kind === 'waiting') {
      return {
        status: 'waiting',
        until: (stop.until ?? this.now()).toISOString(),
        ...(stop.step === undefined ? {} : { step: stop.step }),
      };
    }
    if (stop.kind === 'delivery' && stop.deliveryId !== undefined) {
      return { status: 'waiting_delivery', step: stop.step ?? '', deliveryId: stop.deliveryId };
    }
    if (stop.kind === 'skipped' && stop.skip !== undefined) {
      return { status: 'skipped', code: stop.skip, step: stop.step ?? '' };
    }
    return {
      status: 'failed',
      ...(stop.code === undefined ? {} : { code: stop.code }),
      ...(stop.step === undefined ? {} : { step: stop.step }),
    };
  }

  /** Runs `actions` in order; `null` when all ran, else why it stopped. */
  private async runActions(state: RunState, actions: readonly AnyAction[]): Promise<Stop | null> {
    for (const action of actions) {
      const stop = await this.runAction(state, action);
      if (stop !== null) return stop;
    }
    return null;
  }

  private async runAction(state: RunState, action: AnyAction): Promise<Stop | null> {
    const done = state.steps.get(action.id);
    if (done?.status === 'succeeded') {
      // Already done by an earlier job of this run: never again (SPEC §11.7).
      state.values.setStepOutput(action.id, done.output);
      return this.afterAction(state, action, branchOf(done.output));
    }
    const gate = await this.checkRunning(state, action.id);
    if (gate !== null) return gate;
    // The outbox made its attempts and failed the step (T605): the run fails, no retry.
    const undelivered = deliveryFailureOf(done);
    if (undelivered !== null && done !== undefined) {
      const failure: StepFailure = {
        code: stepErrorCodeOf(undelivered.code),
        transient: null,
        params: undelivered.params,
      };
      await this.failStepAndRun(state.scope, state.run, state, done, action.id, failure);
      return { kind: 'failed', code: failure.code, step: action.id };
    }

    // A `delay` whose wait is over resumes without counting an attempt (T506).
    const step =
      done?.status === 'waiting'
        ? await this.steps.resume(state.scope, done.id, this.now())
        : await this.beginStep(state.scope, state.run, action);
    if (step === undefined) {
      // Another job finished it meanwhile: take its output.
      const current = await this.steps.findByKey(state.scope, this.keyOf(state.run, action.id));
      if (current?.status !== 'succeeded') return { kind: 'cancelled' };
      state.steps.set(action.id, current);
      state.values.setStepOutput(action.id, current.output);
      return this.afterAction(state, action, branchOf(current.output));
    }
    state.steps.set(action.id, step);

    const handler = this.options.actions.get(action.type);
    let result: AutomationActionResult;
    const effect = { completed: false };
    try {
      if (handler === undefined) {
        return await this.stepFailed(state, step, action.id, {
          code: 'unsupported_action',
          transient: null,
          params: { type: action.type },
        });
      }
      const context: AutomationActionContext = {
        db: this.db,
        scope: state.scope,
        run: state.info,
        action,
        access: state.access,
        schema: state.schema,
        values: state.values,
        audit: state.audit,
        causation: state.causation,
        idempotencyKey: step.idempotency_key,
        attempt: step.attempt,
        previous: isObject(step.output) ? step.output : null,
        now: () => this.now(),
        saveProgress: (tx, output) =>
          this.steps.saveProgress(withTxScope(state.scope, tx), step.id, output),
        complete: async (tx, output) => {
          await this.steps.finish(withTxScope(state.scope, tx), step.id, {
            status: 'succeeded',
            at: this.now(),
            output,
            error: null,
          });
          effect.completed = true;
        },
      };
      result = await handler.execute(context);
    } catch (error) {
      // The effect may have committed with its step before the error (e.g. a read back).
      const current = await this.steps.findByKey(state.scope, step.idempotency_key);
      if (current?.status === 'succeeded') {
        state.steps.set(action.id, current);
        state.values.setStepOutput(action.id, current.output);
        state.stepsRun += 1;
        return this.afterAction(state, action, branchOf(current.output));
      }
      return this.stepFailed(state, step, action.id, classifyStepError(error));
    }
    if (result.wait !== undefined && !effect.completed) {
      return this.waitStep(state, step, action.id, result.output, result.wait.until);
    }
    if (result.delivery !== undefined && !effect.completed) {
      return this.waitForDelivery(state, step, action.id, result.delivery);
    }
    if (result.skip !== undefined && !effect.completed) {
      return this.skipRun(state, step, action.id, result.output, result.skip);
    }
    if (!effect.completed) {
      await this.steps.finish(state.scope, step.id, {
        status: 'succeeded',
        at: this.now(),
        output: result.output,
        error: null,
      });
    }
    state.stepsRun += 1;
    state.values.setStepOutput(action.id, result.output);
    await this.options.afterStep?.({ runId: state.run.id, actionId: action.id });
    return this.afterAction(state, action, result.branch);
  }

  /** After a step: the `if` branch, then the timeout. */
  private async afterAction(
    state: RunState,
    action: AnyAction,
    branch: 'then' | 'else' | 'stop' | undefined,
  ): Promise<Stop | null> {
    if (action.type === 'if') {
      if (branch === 'stop') return { kind: 'stop' };
      const next = branch === 'then' ? action.config.then : action.config.else;
      const stop = await this.runActions(state, next);
      if (stop !== null) return stop;
    }
    return null;
  }

  /**
   * Before a step: the run is still ours (`running` — T507 may have
   * cancelled it) and within its running time.
   */
  private async checkRunning(state: RunState, actionId: string): Promise<Stop | null> {
    const current = await this.runs.get(state.scope, state.run.id);
    if (current?.status !== 'running') return { kind: 'cancelled' };
    state.run = current;
    if (this.elapsedMs(current) > this.timeoutMs) {
      await this.finishRun(state.scope, current, state, 'failed', {
        code: 'run_timeout',
        step: actionId,
        params: { limit_ms: this.timeoutMs },
      });
      return { kind: 'failed', code: 'run_timeout', step: actionId };
    }
    return null;
  }

  private elapsedMs(run: AutomationRunRow): number {
    const since =
      run.running_since === null ? 0 : this.now().getTime() - run.running_since.getTime();
    return Number(run.active_ms) + Math.max(0, since);
  }

  // --- Steps ------------------------------------------------------------------------

  private keyOf(run: AutomationRunRow, actionId: string): string {
    return stepIdempotencyKey(run, actionId);
  }

  private async beginStep(
    scope: OrgScope,
    run: AutomationRunRow,
    action: AnyAction,
  ): Promise<AutomationRunStepRow | undefined> {
    return this.steps.begin(scope, {
      id: newId('stp'),
      runId: run.id,
      actionId: action.id,
      idempotencyKey: this.keyOf(run, action.id),
      input: { type: action.type },
      at: this.now(),
    });
  }

  /**
   * What earlier jobs of this run recorded about waiting in `actionId`
   * (`run.error` of a step scheduled again): how many waits, and since when
   * the step waits for the same reason.
   */
  private waitsOf(
    state: RunState,
    actionId: string,
  ): { readonly waits: number; readonly since: Date | null; readonly code: unknown } {
    const error = isObject(state.run.error) ? state.run.error : {};
    if (error['step'] !== actionId) return { waits: 0, since: null, code: null };
    const waits = typeof error['waits'] === 'number' ? error['waits'] : 0;
    const since =
      typeof error['waiting_since'] === 'string' ? new Date(error['waiting_since']) : null;
    return {
      waits,
      since: since === null || Number.isNaN(since.getTime()) ? null : since,
      code: error['code'],
    };
  }

  /**
   * A failed step: wait when it asks to (`StepFailure.wait`), retry later
   * when temporary and attempts are left, else fail the run. Waits do not
   * use retries: the retry number is the attempt minus the waits.
   */
  private async stepFailed(
    state: RunState,
    step: AutomationRunStepRow,
    actionId: string,
    failure: StepFailure,
  ): Promise<Stop> {
    const previous = this.waitsOf(state, actionId);
    if (failure.wait !== undefined) {
      return this.stepWaits(state, step, actionId, failure, failure.wait, previous);
    }
    const scheduled =
      failure.transient === null
        ? null
        : retryDelayMs(Math.max(1, step.attempt - previous.waits), this.random);
    // A server that said when to come back (`429 retry_after`, T516) is
    // retried then; the number of retries stays the schedule's.
    const delayMs =
      scheduled === null || failure.retryAfterMs === undefined ? scheduled : failure.retryAfterMs;
    if (delayMs === null) {
      const final: StepFailure =
        failure.transient === null
          ? failure
          : { ...failure, params: { ...failure.params, attempts: step.attempt } };
      await this.failStepAndRun(state.scope, state.run, state, step, actionId, final);
      return { kind: 'failed', code: final.code, step: actionId };
    }
    const at = this.now();
    return this.scheduleAgain(state, step, actionId, failure, new Date(at.getTime() + delayMs), {
      ...(previous.waits === 0 ? {} : { waits: previous.waits }),
    });
  }

  /** The step waits until `wait.until` (or fails once it waited longer than `wait.maxWaitMs`). */
  private async stepWaits(
    state: RunState,
    step: AutomationRunStepRow,
    actionId: string,
    failure: StepFailure,
    wait: NonNullable<StepFailure['wait']>,
    previous: ReturnType<AutomationRunEngine['waitsOf']>,
  ): Promise<Stop> {
    const at = this.now();
    const since = previous.code === failure.code && previous.since !== null ? previous.since : at;
    const until = wait.until.getTime() > at.getTime() ? wait.until : at;
    if (until.getTime() - since.getTime() > wait.maxWaitMs) {
      const final: StepFailure = {
        code: failure.code,
        transient: null,
        params: { ...failure.params, waited_ms: at.getTime() - since.getTime() },
      };
      await this.failStepAndRun(state.scope, state.run, state, step, actionId, final);
      return { kind: 'failed', code: final.code, step: actionId };
    }
    // A little jitter: the runs waiting for the same hour do not all start at once.
    const jitterMs = Math.floor(Math.min(Math.max(this.random(), 0), 0.999_999) * 30_000);
    const retryAt = new Date(until.getTime() + jitterMs);
    return this.scheduleAgain(state, step, actionId, failure, retryAt, {
      waits: previous.waits + 1,
      waiting_since: since.toISOString(),
    });
  }

  /** The step failed this attempt; the run goes back to `queued` and its job runs at `retryAt`. */
  private async scheduleAgain(
    state: RunState,
    step: AutomationRunStepRow,
    actionId: string,
    failure: StepFailure,
    retryAt: Date,
    extra: JsonObject,
  ): Promise<Stop> {
    const at = this.now();
    const delayMs = Math.max(0, retryAt.getTime() - at.getTime());
    await this.db.withTx(async (tx) => {
      const txScope = withTxScope(state.scope, tx);
      await this.steps.finish(txScope, step.id, {
        status: 'failed',
        at,
        error: {
          code: failure.code,
          params: failure.params as JsonObject,
          attempt: step.attempt,
          retry_at: retryAt.toISOString(),
        },
      });
      await this.runs.endSegment(txScope, state.run.id, {
        status: 'queued',
        at,
        error: { code: failure.code, step: actionId, retry_at: retryAt.toISOString(), ...extra },
      });
      await enqueue(
        tx,
        'automation.run',
        { organization_id: state.scope.organizationId, run_id: state.run.id },
        { runAt: retryAt },
      );
    });
    return { kind: 'retry', step: actionId, delayMs };
  }

  /**
   * `delay` (T506): the step `waiting` with `output`, the run `waiting` (its
   * running segment ends), the job resuming it added for `until`.
   */
  private async waitStep(
    state: RunState,
    step: AutomationRunStepRow,
    actionId: string,
    output: JsonObject,
    until: Date,
  ): Promise<Stop> {
    const at = this.now();
    await this.db.withTx(async (tx) => {
      const txScope = withTxScope(state.scope, tx);
      await this.steps.wait(txScope, step.id, output);
      await this.runs.endSegment(txScope, state.run.id, { status: 'waiting', at, error: null });
      await this.scheduleResume(tx, state.scope, state.run.id, until);
    });
    return { kind: 'waiting', step: actionId, until };
  }

  /**
   * An HTTP action (T605, `http-wait.ts`): the delivery row, the step
   * `waiting` and the run `waiting` in one transaction; the outbox wakes the
   * run once the delivery is final. A URL that can never be called fails
   * the step (`ssrf_blocked`).
   */
  private async waitForDelivery(
    state: RunState,
    step: AutomationRunStepRow,
    actionId: string,
    delivery: HttpDeliveryWait,
  ): Promise<Stop> {
    const outbox = this.options.httpOutbox;
    if (outbox === undefined) {
      return this.stepFailed(state, step, actionId, {
        code: 'unsupported_action',
        transient: null,
        params: { type: isObject(step.input) ? (step.input['type'] ?? null) : null },
      });
    }
    const at = this.now();
    let parked: Awaited<ReturnType<typeof parkOnDelivery>>;
    try {
      parked = await this.db.withTx(async (tx) => {
        const result = await parkOnDelivery(this.db, outbox, tx, {
          scope: state.scope,
          runId: state.run.id,
          automationId: state.run.automation_id,
          step,
          // One hop to a hook = one level (ADR-27 §2): the hook adds it.
          causation: outboundHttpCausation(state.causation),
          delivery,
          at,
        });
        if (result.settled) await this.scheduleResume(tx, state.scope, state.run.id, at);
        return result;
      });
    } catch (error) {
      if (isOutboundHttpError(error)) {
        return this.stepFailed(state, step, actionId, {
          code: error.code,
          transient: null,
          params: { ...error.params },
        });
      }
      return this.stepFailed(state, step, actionId, classifyStepError(error));
    }
    return { kind: 'delivery', step: actionId, deliveryId: parked.deliveryId };
  }

  /** A `delay` recheck (T506): the step and the run `skipped`, the rest not run. */
  private async skipRun(
    state: RunState,
    step: AutomationRunStepRow,
    actionId: string,
    output: JsonObject,
    skip: NonNullable<AutomationActionResult['skip']>,
  ): Promise<Stop> {
    const params = skip.params ?? {};
    await this.finishRun(
      state.scope,
      state.run,
      state,
      'skipped',
      { code: skip.code, step: actionId, params },
      false,
      async (tx) => {
        await this.steps.finish(withTxScope(state.scope, tx), step.id, {
          status: 'skipped',
          at: this.now(),
          output,
          error: { code: skip.code, params: params as JsonObject },
        });
      },
    );
    return { kind: 'skipped', skip: skip.code, step: actionId };
  }

  private async failStepAndRun(
    scope: OrgScope,
    run: AutomationRunRow,
    state: RunState | null,
    step: AutomationRunStepRow,
    actionId: string,
    failure: StepFailure,
  ): Promise<void> {
    const lostAccess = failure.code === 'permission_denied' && failure.params['scope'] !== 'record';
    await this.finishRun(
      scope,
      run,
      state,
      'failed',
      { code: failure.code, step: actionId, params: failure.params },
      lostAccess,
      async (tx) => {
        await this.steps.finish(withTxScope(scope, tx), step.id, {
          status: 'failed',
          at: this.now(),
          error: {
            code: failure.code,
            params: failure.params as JsonObject,
            attempt: step.attempt,
          },
        });
      },
    );
  }

  // --- End ------------------------------------------------------------------------------

  /**
   * Ends the run in one transaction: status, `error`, `active_ms`; event +
   * audit `automation.run.succeeded|failed`; on failure the consecutive
   * failure breaker and, when `run_as` lost access, the T507 check.
   */
  private async finishRun(
    scope: OrgScope,
    run: AutomationRunRow,
    state: RunState | null,
    status: 'succeeded' | 'failed' | 'skipped' | 'cancelled',
    error: {
      readonly code: AutomationRunErrorCode;
      readonly step?: string;
      readonly params?: Readonly<Record<string, unknown>>;
    } | null,
    lostAccess = false,
    before?: (tx: Tx) => Promise<void>,
  ): Promise<void> {
    const at = this.now();
    await this.db.withTx(async (tx) => {
      const txScope = withTxScope(scope, tx);
      if (before !== undefined) await before(tx);
      await this.runs.endSegment(txScope, run.id, {
        status,
        at,
        error:
          error === null
            ? null
            : {
                code: error.code,
                ...(error.step === undefined ? {} : { step: error.step }),
                ...(error.params === undefined || Object.keys(error.params).length === 0
                  ? {}
                  : { params: error.params as JsonObject }),
              },
      });
      // The clicker of a button learns that its run ended (T517), whatever the status.
      await publishButtonRunFinished(this.db, tx, scope.organizationId, run, status);
      // Skipped (a `delay` recheck, T506) and cancelled runs: no event, no breaker.
      if (status === 'cancelled' || status === 'skipped') return;
      const ended = await this.runs.get(txScope, run.id);
      const automation = await this.automations.get(txScope, run.automation_id);
      const data: JsonObject = {
        automation_id: run.automation_id,
        automation_version: run.automation_version,
        trigger_event_id: run.trigger_event_id,
        status,
        error_code: error?.code ?? null,
        step: error?.step ?? null,
        steps: state?.stepsRun ?? 0,
        active_ms: Number(ended?.active_ms ?? 0),
      };
      const type = status === 'succeeded' ? 'automation.run.succeeded' : 'automation.run.failed';
      const actor = { type: 'automation' as const, id: run.automation_id };
      await emit(tx, {
        type,
        organizationId: scope.organizationId,
        entityId: run.id,
        actor,
        ...(automation === undefined ? {} : { baseId: automation.base_id }),
        ...(automation?.trigger_table_id == null ? {} : { tableId: automation.trigger_table_id }),
        data,
      });
      await audit.write(tx, {
        action: type,
        organizationId: scope.organizationId,
        ...(automation === undefined ? {} : { baseId: automation.base_id }),
        ...(automation?.trigger_table_id == null ? {} : { tableId: automation.trigger_table_id }),
        entityType: 'automation_run',
        entityId: run.id,
        before: null,
        after: data,
        context: {
          actor,
          via: { automation_id: run.automation_id, run_id: run.id },
          batch_id: run.id,
          request_id: null,
          ip: null,
          user_agent: null,
        },
      });
      if (status !== 'failed') return;
      await tripOnConsecutiveFailures(this.db, tx, scope, run.automation_id, this.notifier);
      if (lostAccess) {
        await this.runAsAccess.requestCheck(tx, {
          organizationId: scope.organizationId,
          automationId: run.automation_id,
          runId: run.id,
        });
      }
    });
  }

  /**
   * `actor` and `previous` of the trigger data (SPEC §11.4, `[@actor]`,
   * `[@previous]`) from the trigger event: who caused it (a user still in
   * the organization, with their name) and, for `record.updated`, the values
   * before the change. The event gone (dropped partition) → none.
   */
  private async eventData(
    scope: OrgScope,
    trigger: RunTrigger,
    schema: AutomationValidationContext,
  ): Promise<{ data: Record<string, unknown>; userNames: Map<string, string> }> {
    const userNames = new Map<string, string>();
    if (trigger.event_id === null || trigger.event_created_at === null) {
      return { data: {}, userNames };
    }
    const row = await this.events.getByKey(scope, {
      id: trigger.event_id,
      createdAt: trigger.event_created_at,
    });
    if (row === undefined) return { data: {}, userNames };
    const event = toEventDocument(row);
    const actorId = eventActorId(event.actor);
    const data: Record<string, unknown> = { actor: null };
    if (actorId !== null) {
      const members = await this.members.activeMembers(scope, [actorId as Id<'usr'>]);
      const member = members.get(actorId as Id<'usr'>);
      if (member !== undefined) {
        data['actor'] = actorId;
        userNames.set(actorId, member.displayName);
      }
    }
    if (trigger.type === 'record.updated' && trigger.table_id !== null) {
      const previous = previousValues(event.changes, schema.fields, trigger.table_id);
      if (previous !== null) data['previous'] = previous;
    }
    return { data, userNames };
  }

  /** Whether the incoming webhook of a `webhook.received` run still exists (not deleted). */
  private async hookIsLive(scope: OrgScope, trigger: RunTrigger): Promise<boolean> {
    if (trigger.incoming_webhook_id === null) return false;
    return (await this.hooks.findById(scope, trigger.incoming_webhook_id)) !== undefined;
  }

  /**
   * Loads the stored request of a `webhook.received` run once (T604): body,
   * headers, query; `null` when it was purged (7 days) or is not this hook's.
   */
  private webhookLoader(
    scope: OrgScope,
    trigger: RunTrigger,
  ): () => Promise<WebhookRequestData | null> {
    let loaded: Promise<WebhookRequestData | null> | undefined;
    return () => {
      loaded ??= (async () => {
        if (trigger.request_id === null) return null;
        const row = await this.hookRequests.findById(scope, trigger.request_id);
        if (
          row === undefined ||
          row.duplicate ||
          row.incoming_webhook_id !== trigger.incoming_webhook_id
        ) {
          return null;
        }
        return { body: row.body, headers: row.headers, query: row.query };
      })();
      return loaded;
    };
  }

  /** Causation of the run's writes: one level below the trigger event (SPEC §11.6). */
  private async causationOf(
    scope: OrgScope,
    run: AutomationRunRow,
    trigger: RunTrigger,
  ): Promise<Causation> {
    if (trigger.event_id !== null && trigger.event_created_at !== null) {
      const row = await this.events.getByKey(scope, {
        id: trigger.event_id,
        createdAt: trigger.event_created_at,
      });
      if (row !== undefined) return childCausation(toEventDocument(row), run.automation_id);
    }
    // The event is gone (dropped partition) or there is none (`schedule`, T508):
    // the run's own depth, its automation as the chain.
    return {
      root_event_id: trigger.event_id ?? newId('evt'),
      depth: run.depth + 1,
      automation_chain: [run.automation_id],
    };
  }
}

function triggerOf(value: unknown): RunTrigger {
  const trigger = isObject(value) ? value : {};
  const text = (key: string): string | null =>
    typeof trigger[key] === 'string' ? trigger[key] : null;
  return {
    event_id: text('event_id') as Id<'evt'> | null,
    event_created_at: text('event_created_at'),
    type: text('type') ?? '',
    table_id: text('table_id') as Id<'tbl'> | null,
    record_id: text('record_id') as Id<'rec'> | null,
    data: isObject(trigger['data']) ? trigger['data'] : {},
    incoming_webhook_id: text('incoming_webhook_id') as Id<'hok'> | null,
    request_id: text('request_id') as Id<'whr'> | null,
  };
}

/** A stored step error code as the engine's type (`internal_error` when unknown). */
function stepErrorCodeOf(code: string): AutomationStepErrorCode {
  return (AUTOMATION_STEP_ERROR_CODES as readonly string[]).includes(code)
    ? (code as AutomationStepErrorCode)
    : 'internal_error';
}

function branchOf(output: JsonValue | null): 'then' | 'else' | 'stop' | undefined {
  if (!isObject(output)) return undefined;
  const branch = output['branch'];
  return branch === 'then' || branch === 'else' || branch === 'stop' ? branch : undefined;
}

/** `until` of a `delay` step output (ISO instant), if any. */
export function untilOf(output: JsonValue | null): Date | null {
  if (!isObject(output) || typeof output['until'] !== 'string') return null;
  const at = new Date(output['until']);
  return Number.isNaN(at.getTime()) ? null : at;
}
