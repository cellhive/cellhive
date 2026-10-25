import {
  automationDefinitionSchema,
  newId,
  type AutomationDefinition,
  type AutomationTrigger,
  type Id,
} from '@cellhive/contracts';
import {
  collectFieldIds,
  evaluate,
  FilterEvaluationError,
  foldTransition,
  isDateValue,
  isVariableValue,
  parseFilterInput,
  resolveVariables,
  type FilterCondition,
  type FilterFieldMeta,
  type FilterTableMeta,
  type ResolveContext,
} from '@cellhive/filter-dsl';

import { OrganizationsRepository } from '../../db/repositories/organizations.repository.js';
import { withTxScope, type OrgScope } from '../../db/repository.js';
import { AppError } from '../../errors/app-error.js';
import { toEventDocument, type EventDocument } from '../../events/event.js';
import { EventsRepository, type EventKey } from '../../events/events.repository.js';
import { resolveMemberBaseAccess, type AccessDefaults } from '../../import/member-access.js';
import { enqueue } from '../../jobs/enqueue.js';
import { RecordAssignedListener } from '../../notifications/listeners/assigned/record-assigned-listener.js';
import { FollowedChangeListener } from '../../notifications/listeners/followed/index.js';
import { computedFilterResultOf } from '../../records/computed/read/computed-fields.js';
import { RecordQueryService } from '../../records/record-query.service.js';
import { FieldsRepository } from '../../schema/fields.repository.js';
import {
  AutomationRunsRepository,
  BATCH_FANOUT_EXCEEDED,
} from '../repository/automation-runs.repository.js';
import { AutomationsRepository } from '../repository/automations.repository.js';
import { AutomationBatchCountersRepository } from '../repository/batch-counters.repository.js';

import {
  BREAKER_MAX_UNITS_PER_MINUTE,
  BREAKER_WINDOW_SECONDS,
  tripCircuitBreaker,
} from './circuit-breaker.js';
import { changeConditionsOf, foldChangeConditions } from './condition.js';
import {
  isBulkEvent,
  triggerMismatch,
  triggerRecordIdOf,
  triggerTypesFor,
  triggerUnitOf,
  webhookIdOf,
  type TriggerMismatch,
} from './event-match.js';
import { automationMaxDepthOf, loopGuard } from './loop-guard.js';
import { planTransition, transitionImagesOf, withLaterChanges } from './matches/transition.js';
import { AUTOMATION_NOTIFICATIONS, type AutomationNotifier } from './notifier.js';

import type { Db, Tx } from '../../db/create-db.js';
import type { AutomationRow, JsonObject, JsonValue } from '../../db/schema.js';
import type { FieldType } from '@cellhive/field-types';

/** Default of `AUTOMATION_MAX_RUNS_PER_BATCH` (ADR-26 §4). */
export const DEFAULT_MAX_RUNS_PER_BATCH = 1_000;

export interface AutomationDispatcherOptions {
  /** `AUTOMATION_MAX_RUNS_PER_BATCH` (ADR-26 §4). */
  readonly maxRunsPerBatch?: number;
  /** Instance defaults used to resolve the access of `run_as`. */
  readonly defaults: AccessDefaults;
  /** Reads records as `run_as` (conditions); default: a service on `db`. */
  readonly records?: RecordQueryService;
  /** `automation.disabled` / `automation.batch_overflow` notifications; default: T511's. */
  readonly notifier?: AutomationNotifier;
  /** `record.assigned` of the event (T544); default: one on `db` with `defaults` and `records`. */
  readonly assignedListener?: Pick<RecordAssignedListener, 'handle'>;
}

/** What happened to one automation for one event (logged by `events.dispatch`, ids only). */
export type AutomationDispatchOutcome =
  | 'queued'
  | 'fanout_skipped'
  | 'circuit_breaker'
  | 'condition_false'
  | 'already_matching'
  | 'duplicate'
  | 'turned_off'
  | 'invalid_definition'
  | 'run_as_without_access'
  | 'loop_max_depth'
  | 'loop_already_in_chain'
  | TriggerMismatch;

export interface AutomationDispatchResult {
  readonly automationId: Id<'aut'>;
  readonly outcome: AutomationDispatchOutcome;
  /** The run created (`queued`, or the `skipped` stand-in of a full batch). */
  readonly runId?: Id<'run'>;
}

export type DispatchResult =
  | { readonly status: 'missing' }
  | { readonly status: 'redelivered'; readonly event: EventDocument }
  | {
      readonly status: 'dispatched';
      readonly event: EventDocument;
      readonly automations: readonly AutomationDispatchResult[];
    };

/** The trigger part of `automation_runs.input` (T505 reads the event again by this key). */
interface RunTriggerInput {
  readonly event_id: Id<'evt'>;
  readonly event_created_at: string;
  readonly type: string;
  readonly table_id: Id<'tbl'> | null;
  readonly record_id: Id<'rec'> | null;
  readonly bulk: boolean;
  readonly batch: JsonObject | null;
  /** `webhook.received` (T604): the hook and the stored request the run reads. */
  readonly incoming_webhook_id?: Id<'hok'>;
  readonly request_id?: Id<'whr'>;
}

type RunAsAccess = Awaited<ReturnType<typeof resolveMemberBaseAccess>>;

interface EventContext {
  readonly scope: OrgScope;
  readonly tx: Tx;
  readonly key: EventKey;
  readonly event: EventDocument;
  readonly maxDepth: number;
  /** Filter metas of the event's table, loaded on first use. */
  tableMeta?: FilterTableMeta;
}

/**
 * `events.dispatch` (SPEC §11.1, ADR-26, BACKLOG T503): turns one stored
 * event into `queued` automation runs, never running an action itself.
 *
 * In **one transaction** with `dispatched_at`: an event is dispatched at
 * most once (a redelivered job finds `dispatched_at` set and does
 * nothing); a failure rolls everything back and the job retries. For each
 * enabled automation whose trigger matches (type + table; `record.updated`
 * only when a `watch_fields` field is in `changes`; `form.submitted` by
 * form view; `webhook.received` by hook, in the hook's base — T604), in id
 * order:
 *
 * 1. `skip_bulk` drops bulk events (ADR-26 §2–3): no run, no breaker count;
 * 2. loop guard (SPEC §11.6): causation `depth ≥ settings.automation_max_depth`
 *    of the organization, or the automation already in `automation_chain`;
 * 3. the automation row is locked; a `record.matches` trigger must see
 *    the record go from not matching to matching its condition (T510,
 *    {@link testTransition}); the condition is tested — `changed*`
 *    conditions on the event's storage-form `changes`, the rest on the
 *    latest record read as `run_as` through `RecordQueryService` (a
 *    `record.deleted` reads the record in the trash);
 * 4. circuit breaker (ADR-26 §5): a trigger unit (`batch.id` of a bulk
 *    event, a second of a hook for a `webhook.received` without causation
 *    — ADR-35 §5 —, else `root_event_id`) beyond 100 distinct units in the last
 *    minute turns the automation off (`circuit_breaker`) instead;
 * 5. fan-out cap (ADR-26 §4): at most `AUTOMATION_MAX_RUNS_PER_BATCH` runs
 *    per (automation, `batch.id`); the rest is counted on one `skipped` run
 *    (`error.code = batch_fanout_exceeded`), the automation stays on;
 * 6. a `queued` run (`trigger_unit`, `depth`, definition snapshot +
 *    `automation_version` in `input`) and its `automation.run` job.
 *
 * The condition is tested before the cap, so the cap counts runs, not
 * events (SPEC §11.1 lists the cap first; same result without condition).
 *
 * The notification listeners (ADR-34 §2) run in the same transaction:
 * `record.followed_changed` (T545, `notifications/listeners/followed`)
 * before the automation part, `record.assigned` (T544,
 * `notifications/listeners/assigned`) after it.
 */
export class AutomationDispatcher {
  private readonly events: EventsRepository;
  private readonly automations: AutomationsRepository;
  private readonly runs: AutomationRunsRepository;
  private readonly counters: AutomationBatchCountersRepository;
  private readonly fields: FieldsRepository;
  private readonly organizations: OrganizationsRepository;
  private readonly records: RecordQueryService;
  private readonly notifier: AutomationNotifier;
  private readonly assignedListener: Pick<RecordAssignedListener, 'handle'>;
  private readonly maxRunsPerBatch: number;

  constructor(
    private readonly db: Db,
    private readonly options: AutomationDispatcherOptions,
  ) {
    this.events = new EventsRepository(db);
    this.automations = new AutomationsRepository(db);
    this.runs = new AutomationRunsRepository(db);
    this.counters = new AutomationBatchCountersRepository(db);
    this.fields = new FieldsRepository(db);
    this.organizations = new OrganizationsRepository(db);
    this.records =
      options.records ?? new RecordQueryService(db, { defaultTimeZone: options.defaults.timeZone });
    this.notifier = options.notifier ?? AUTOMATION_NOTIFICATIONS;
    this.assignedListener =
      options.assignedListener ??
      new RecordAssignedListener(db, { defaults: options.defaults, records: this.records });
    this.maxRunsPerBatch = options.maxRunsPerBatch ?? DEFAULT_MAX_RUNS_PER_BATCH;
    if (!Number.isSafeInteger(this.maxRunsPerBatch) || this.maxRunsPerBatch < 1) {
      throw new RangeError('maxRunsPerBatch must be a positive integer');
    }
  }

  async dispatch(scope: OrgScope, key: EventKey): Promise<DispatchResult> {
    return this.db.withTx(async (tx) => {
      const txScope = withTxScope(scope, tx);
      const row = await this.events.getByKey(txScope, key);
      if (row === undefined) return { status: 'missing' };
      const event = toEventDocument(row);
      // Locks the event row: a concurrent copy of the job waits, then sees it dispatched.
      if (!(await this.events.markDispatched(txScope, key))) {
        return { status: 'redelivered', event };
      }
      // T545: buffer the change for the record's followers (ADR-34 §2), in this transaction.
      await new FollowedChangeListener(this.db).onEvent(txScope, event);
      const automations = await this.dispatchAutomations(txScope, tx, key, event);

      // Notifications of the event (ADR-34 §2), after the automation part, same transaction.
      await this.assignedListener.handle(txScope, event); // T544: record.assigned

      return { status: 'dispatched', event, automations };
    });
  }

  /** The automation part of {@link dispatch}: a run per matching automation, in id order. */
  private async dispatchAutomations(
    txScope: OrgScope,
    tx: Tx,
    key: EventKey,
    event: EventDocument,
  ): Promise<AutomationDispatchResult[]> {
    const triggerTypes = triggerTypesFor(event);
    const tableId = event.table_id;
    const hookId = webhookIdOf(event);
    const candidates: AutomationRow[] = [];
    if (hookId !== null) {
      // T604: automations of the hook's base listening to it (the trigger has no table).
      const listening = await this.automations.listEnabledForWebhook(txScope, hookId);
      candidates.push(...listening.filter((row) => row.base_id === event.base_id));
    } else {
      if (triggerTypes.length === 0 || tableId === undefined) return [];
      for (const triggerType of triggerTypes) {
        candidates.push(
          ...(await this.automations.listEnabledForTrigger(txScope, triggerType, tableId)),
        );
      }
    }
    if (candidates.length === 0) return [];
    const organization = await this.organizations.findById(txScope.organizationId, tx);
    const context: EventContext = {
      scope: txScope,
      tx,
      key,
      event,
      maxDepth: automationMaxDepthOf(organization?.settings ?? null),
    };
    const results: AutomationDispatchResult[] = [];
    // Id order: concurrent dispatches lock automations in the same order.
    for (const candidate of [...candidates].sort((a, b) => a.id.localeCompare(b.id))) {
      results.push(await this.dispatchOne(context, candidate));
    }
    return results;
  }

  private async dispatchOne(
    context: EventContext,
    listed: AutomationRow,
  ): Promise<AutomationDispatchResult> {
    const result = (outcome: AutomationDispatchOutcome, runId?: Id<'run'>) => ({
      automationId: listed.id,
      outcome,
      ...(runId === undefined ? {} : { runId }),
    });
    // Cheap checks first, without a lock: most events match no trigger.
    const early = this.precheck(context, listed);
    if (typeof early === 'string') return result(early);
    const { scope, tx, event } = context;
    const row = await this.automations.lockEnabled(scope, listed.id);
    if (row === undefined) return result('turned_off');
    const checked = row.version === listed.version ? early : this.precheck(context, row);
    if (typeof checked === 'string') return result(checked);
    const definition = checked;

    if ((await this.runs.findByEvent(scope, row.id, event.id)) !== undefined) {
      return result('duplicate');
    }
    let access: RunAsAccess | null = null;
    const accessOf = async (): Promise<RunAsAccess> => {
      access ??= await resolveMemberBaseAccess(
        this.db,
        scope,
        { userId: row.run_as_user_id, baseId: row.base_id },
        this.options.defaults,
      );
      return access;
    };
    if (definition.trigger.type === 'record.matches') {
      const entered = await this.testTransition(context, definition.trigger, accessOf);
      if (entered !== true) return result(entered);
    }
    const condition = await this.testCondition(context, row, definition, accessOf);
    if (condition !== true) return result(condition);

    // Circuit breaker (ADR-26 §5): a new unit beyond the per-minute limit turns it off.
    const unit = triggerUnitOf(event);
    const recent = await this.runs.recentUnits(scope, row.id, BREAKER_WINDOW_SECONDS, unit);
    if (!recent.includesUnit && recent.distinct + 1 > BREAKER_MAX_UNITS_PER_MINUTE) {
      await tripCircuitBreaker(this.db, tx, scope, row, this.notifier);
      return result('circuit_breaker');
    }

    const trigger = this.runTriggerInput(context);
    const batchId = event.batch?.id;
    if (
      batchId !== undefined &&
      !(await this.counters.claimRun(scope, row.id, batchId, this.maxRunsPerBatch))
    ) {
      return result('fanout_skipped', await this.recordOverflow(context, row, batchId, trigger));
    }
    const runId = newId('run');
    const inserted = await this.runs.insert(scope, {
      id: runId,
      automationId: row.id,
      automationVersion: row.version,
      triggerEventId: event.id,
      triggerUnit: unit,
      status: 'queued',
      depth: event.causation.depth,
      input: {
        automation_version: row.version,
        definition: row.definition,
        trigger: trigger as unknown as JsonObject,
      },
    });
    if (inserted === undefined) return result('duplicate');
    await enqueue(tx, 'automation.run', { organization_id: scope.organizationId, run_id: runId });
    return result('queued', runId);
  }

  /** Definition, trigger match and loop guard of a row; an outcome when it stops there. */
  private precheck(
    context: EventContext,
    row: AutomationRow,
  ): AutomationDefinition | AutomationDispatchOutcome {
    const parsed = automationDefinitionSchema.safeParse(row.definition);
    if (!parsed.success) return 'invalid_definition';
    const mismatch = triggerMismatch(parsed.data.trigger, context.event);
    if (mismatch !== null) return mismatch;
    const guard = loopGuard(context.event.causation, row.id, context.maxDepth);
    if (guard === 'max_depth') return 'loop_max_depth';
    if (guard === 'already_in_chain') return 'loop_already_in_chain';
    return parsed.data;
  }

  /**
   * The condition (SPEC §11.3): `changed*` decided on the event's
   * `changes`, the rest tested on the latest record as `run_as`. `true`,
   * or the outcome when it does not hold (or cannot be tested any more:
   * a field gone, `run_as` without access — T507 turns such automations
   * off; until then they start nothing).
   */
  private async testCondition(
    context: EventContext,
    row: AutomationRow,
    definition: AutomationDefinition,
    accessOf: () => Promise<RunAsAccess>,
  ): Promise<true | AutomationDispatchOutcome> {
    if (definition.condition === null) return true;
    const { event, scope } = context;
    const tableId = event.table_id;
    const recordId = triggerRecordIdOf(event);
    if (tableId === undefined || recordId === null) return 'condition_false';
    const meta = await this.tableMeta(context, tableId);
    const parsed = parseFilterInput(
      definition.condition,
      meta,
      meta.fields.map((field) => field.id),
      { fieldKeyType: 'id', mode: 'automation' },
    );
    if (!parsed.ok) return 'condition_false';

    const changes = event.changes ?? {};
    const before: Record<string, JsonValue> = {};
    const after: Record<string, JsonValue> = {};
    for (const [fieldId, change] of Object.entries(changes)) {
      before[fieldId] = change.from;
      after[fieldId] = change.to;
    }
    const decided = new Map<FilterCondition, boolean>();
    const resolveContext = await this.leafResolveContext(
      changeConditionsOf(parsed.ast),
      row,
      accessOf,
    );
    if (resolveContext === null) return 'run_as_without_access';
    for (const leaf of changeConditionsOf(parsed.ast)) {
      decided.set(leaf, decideChange(leaf, resolveContext, meta, before, after, changes));
    }
    const folded = foldChangeConditions(parsed.ast, (leaf) => decided.get(leaf) ?? false);
    if (folded.kind === 'constant') return folded.value ? true : 'condition_false';

    const runAs = await accessOf();
    if (runAs === undefined) return 'run_as_without_access';
    try {
      const matched = await this.records.matchRecord(
        scope,
        tableId,
        recordId,
        runAs.record,
        folded.filter,
        { trashed: event.type === 'record.deleted' },
      );
      return matched ? true : 'condition_false';
    } catch (error) {
      // Table or field `run_as` cannot read any more: as if the condition did not hold.
      if (error instanceof AppError) return 'condition_false';
      throw error;
    }
  }

  /**
   * `record.matches` (BACKLOG T510, "Quyết định S5" #7): `true` when the
   * event takes the record from not matching the trigger's condition to
   * matching it, as `run_as`. The before image is the event's own
   * storage-form `changes` (`from`; none for a new or restored record), no
   * extra read: conditions on changed fields are evaluated in memory on
   * `from`/`to` (`$var`/`$date` as `run_as` at the time of the event), the
   * others — same value on both sides — on the current record through
   * `RecordQueryService.matchRecord` (read rule, readable fields, live
   * record), at most twice (after must match, before must not). A field
   * `run_as` cannot read, a table gone or `run_as` without access start
   * nothing (T507 turns such automations off).
   */
  private async testTransition(
    context: EventContext,
    trigger: Extract<AutomationTrigger, { type: 'record.matches' }>,
    accessOf: () => Promise<RunAsAccess>,
  ): Promise<true | AutomationDispatchOutcome> {
    const { event, scope } = context;
    const recordId = triggerRecordIdOf(event);
    const eventImages = transitionImagesOf(event);
    if (recordId === null || eventImages === null) return 'condition_false';
    // Changes written after this event (dispatched late) must not be read as its own.
    const images =
      event.record_version === undefined
        ? eventImages
        : withLaterChanges(
            eventImages,
            await this.events.laterRecordChanges(scope, {
              recordId,
              afterVersion: event.record_version,
              since: event.created_at,
            }),
          );
    const meta = await this.tableMeta(context, trigger.table_id);
    const parsed = parseFilterInput(
      trigger.condition,
      meta,
      meta.fields.map((field) => field.id),
      { fieldKeyType: 'id' },
    );
    if (!parsed.ok) return 'condition_false';
    const runAs = await accessOf();
    if (runAs === undefined) return 'run_as_without_access';
    const plan = planTransition(
      foldTransition(parsed.ast, images, {
        table: meta,
        resolve: {
          userId: runAs.record.userId,
          groupMemberUserIds: runAs.record.groupMemberUserIds,
          timeZone: runAs.record.timeZone,
          now: new Date(event.created_at),
        },
      }),
    );
    if (plan.kind === 'decided') {
      return plan.outcome === 'already_matching' ? 'already_matching' : 'condition_false';
    }
    try {
      // Every field of the condition must be readable by `run_as`, even
      // those decided in memory.
      const matches = await this.records.matchRecord(
        scope,
        trigger.table_id,
        recordId,
        runAs.record,
        plan.after,
        { fields: collectFieldIds(parsed.ast) },
      );
      if (!matches) return 'condition_false';
      if (
        plan.before !== null &&
        (await this.records.matchRecord(
          scope,
          trigger.table_id,
          recordId,
          runAs.record,
          plan.before,
        ))
      ) {
        return 'already_matching';
      }
      return true;
    } catch (error) {
      if (error instanceof AppError) return 'condition_false';
      throw error;
    }
  }

  /**
   * How `$var`/`$date` operands of `changed*` conditions resolve: as
   * `run_as` (only loaded when such an operand exists). `null` when
   * `run_as` lost access to the base.
   */
  private async leafResolveContext(
    leaves: readonly FilterCondition[],
    row: AutomationRow,
    accessOf: () => Promise<RunAsAccess>,
  ): Promise<ResolveContext | null> {
    const now = new Date();
    if (!leaves.some((leaf) => hasDynamicOperand(leaf.value))) {
      return {
        userId: row.run_as_user_id,
        groupMemberUserIds: [],
        timeZone: this.options.defaults.timeZone,
        now,
      };
    }
    const access = await accessOf();
    if (access === undefined) return null;
    return {
      userId: access.record.userId,
      groupMemberUserIds: access.record.groupMemberUserIds,
      timeZone: access.record.timeZone,
      now,
    };
  }

  private async tableMeta(context: EventContext, tableId: Id<'tbl'>): Promise<FilterTableMeta> {
    if (context.tableMeta !== undefined) return context.tableMeta;
    const rows = await this.fields.listByTable(context.scope, tableId);
    const fields: FilterFieldMeta[] = rows.map((field) => ({
      id: field.id,
      name: field.name,
      type: field.type as FieldType,
      options: field.options,
      ...(field.type === 'formula' || field.type === 'lookup'
        ? computedFilterResultOf(field.result_type)
        : {}),
    }));
    context.tableMeta = { fields };
    return context.tableMeta;
  }

  private runTriggerInput(context: EventContext): RunTriggerInput {
    const { event, key } = context;
    return {
      event_id: event.id,
      event_created_at: key.createdAt,
      type: event.type,
      table_id: event.table_id ?? null,
      record_id: triggerRecordIdOf(event),
      bulk: isBulkEvent(event),
      batch: event.batch === undefined ? null : { id: event.batch.id, size: event.batch.size },
      ...webhookInputOf(event),
    };
  }

  /**
   * A record of a full batch (ADR-26 §4): counted in `skipped`; the first
   * one creates the `skipped` stand-in run and notifies, later ones update
   * its count.
   */
  private async recordOverflow(
    context: EventContext,
    row: AutomationRow,
    batchId: string,
    trigger: RunTriggerInput,
  ): Promise<Id<'run'>> {
    const { scope, tx, event } = context;
    const skipped = await this.counters.addSkipped(scope, row.id, batchId);
    const existing = await this.runs.findFanoutRun(scope, row.id, batchId);
    if (existing !== undefined) {
      await this.runs.setFanoutSkipped(scope, existing.id, skipped);
      return existing.id;
    }
    const runId = newId('run');
    await this.runs.insert(scope, {
      id: runId,
      automationId: row.id,
      automationVersion: row.version,
      triggerEventId: event.id,
      triggerUnit: triggerUnitOf(event),
      status: 'skipped',
      depth: event.causation.depth,
      input: {
        automation_version: row.version,
        definition: row.definition,
        trigger: trigger as unknown as JsonObject,
      },
      error: {
        code: BATCH_FANOUT_EXCEEDED,
        batch_id: batchId,
        limit: this.maxRunsPerBatch,
        skipped,
      },
    });
    await this.notifier.batchOverflow(tx, {
      organizationId: scope.organizationId,
      baseId: row.base_id,
      automationId: row.id,
      automationName: row.name,
      runAsUserId: row.run_as_user_id,
      runId,
      batchId,
      limit: this.maxRunsPerBatch,
    });
    return runId;
  }
}

/** `incoming_webhook_id` + `request_id` of a `webhook.received` event (T604), else nothing. */
function webhookInputOf(
  event: EventDocument,
): Pick<RunTriggerInput, 'incoming_webhook_id' | 'request_id'> {
  const hookId = webhookIdOf(event);
  const requestId = event.data?.['request_id'];
  if (hookId === null || typeof requestId !== 'string' || !requestId.startsWith('whr_')) return {};
  return { incoming_webhook_id: hookId, request_id: requestId as Id<'whr'> };
}

/** Whether a condition value needs a reader to resolve (`$var`, `$date`). */
function hasDynamicOperand(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasDynamicOperand);
  return isVariableValue(value) || isDateValue(value);
}

/**
 * One `changed*` condition on the event (SPEC §11.3): the field is in
 * `changes`; `changed_to`/`changed_from` also compare the new/old
 * storage-form value. A field the evaluator does not know any more is
 * `false`.
 */
function decideChange(
  leaf: FilterCondition,
  resolveContext: ResolveContext,
  meta: FilterTableMeta,
  before: Readonly<Record<string, JsonValue>>,
  after: Readonly<Record<string, JsonValue>>,
  changes: Readonly<Record<string, unknown>>,
): boolean {
  try {
    const resolved = resolveVariables(leaf, resolveContext);
    return evaluate(resolved, after, {
      table: meta,
      before,
      changedFieldIds: Object.keys(changes),
    });
  } catch (error) {
    if (error instanceof FilterEvaluationError) return false;
    throw error;
  }
}
