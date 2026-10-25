import {
  AUTOMATION_RUN_ERROR_CODES,
  httpRequestConfigSchema,
  httpRequestValuesOf,
  isId,
  type AutomationRunDetailDto,
  type AutomationRunDto,
  type AutomationRunError,
  type AutomationRunList,
  type AutomationRunListQuery,
  type AutomationRunStepDto,
  type AutomationRunTriggerDto,
  type BaseAutomationRunListQuery,
  type Id,
} from '@cellhive/contracts';
import {
  actionsOf,
  AutomationRunLog,
  delayUntilRecordRefs,
  delayUntilVisible,
  AutomationRunsRepository,
  decodeCursor,
  GroupMembersRepository,
  HttpDeliveriesRepository,
  httpDeliverySummaryOf,
  managedTableIds,
  managesAnyAutomation,
  orgScope,
  RecordQueryService,
  redactStepOutput,
  runDefinitionOf,
  stepRecordRefs,
  valuesRecordRefs,
  valuesVisible,
  type AppConfig,
  type AutomationRunStepRow,
  type Db,
  type DelayUntilContext,
  type HttpDeliveryRow,
  type OrgScope,
  type RecordAccessContext,
  type RunLogFilter,
  type RunLogRow,
  type StepReadability,
  type StepRecordRefs,
} from '@cellhive/server-core';
import { Inject, Injectable } from '@nestjs/common';

import {
  AccessService,
  notFound,
  permissionDenied,
  type BaseAccess,
} from '../../../common/access/access.service.js';
import { mutationContextOf } from '../../../common/access/change-log.js';
import { recordAccessContextOf } from '../../../common/access/record-access-context.js';
import { iso } from '../../../common/dto.js';
import { APP_CONFIG, DB } from '../../../common/tokens.js';
import { AutomationService, type Located } from '../automation.service.js';

import type { Principal } from '../../../common/auth/principal.js';
import type { RequestMeta } from '../../../common/auth/request-meta.js';

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const RUN_ERROR_KEYS = new Set(['code', 'step', 'params']);
const STEP_ERROR_KEYS = new Set(['code', 'step', 'params', 'attempt', 'retry_at']);

/**
 * `error` of a run or step as stored → the API shape: known keys kept, any
 * other key (`batch_id`, `limit`, `skipped` of a fan-out run; `retry_at` of
 * a run waiting for a retry) moved into `params`. Codes and ids only by
 * construction (T503/T505 never store values there).
 */
function errorOf(value: unknown, keep: ReadonlySet<string>): Record<string, unknown> | null {
  if (!isObject(value)) return null;
  const code = (AUTOMATION_RUN_ERROR_CODES as readonly unknown[]).includes(value['code'])
    ? value['code']
    : 'internal_error';
  const params: Record<string, unknown> = isObject(value['params']) ? { ...value['params'] } : {};
  const out: Record<string, unknown> = { code };
  for (const [key, item] of Object.entries(value)) {
    if (key === 'code' || key === 'params') continue;
    if (keep.has(key)) out[key] = item;
    else params[key] = item;
  }
  if (typeof out['step'] !== 'string') delete out['step'];
  if (typeof out['attempt'] !== 'number') delete out['attempt'];
  if (typeof out['retry_at'] !== 'string') delete out['retry_at'];
  if (Object.keys(params).length > 0) out['params'] = params;
  return out;
}

function triggerOf(input: unknown): AutomationRunTriggerDto {
  const trigger = isObject(input) && isObject(input['trigger']) ? input['trigger'] : {};
  const text = (key: string): string | null =>
    typeof trigger[key] === 'string' ? trigger[key] : null;
  const eventId = text('event_id');
  const tableId = text('table_id');
  const recordId = text('record_id');
  const batch = isObject(trigger['batch']) ? trigger['batch'] : null;
  return {
    event_type: text('type'),
    event_id: eventId !== null && isId('evt', eventId) ? eventId : null,
    table_id: tableId !== null && isId('tbl', tableId) ? tableId : null,
    record_id: recordId !== null && isId('rec', recordId) ? recordId : null,
    bulk: trigger['bulk'] === true,
    batch:
      batch !== null && typeof batch['id'] === 'string' && typeof batch['size'] === 'number'
        ? { id: batch['id'], size: batch['size'] }
        : null,
  };
}

function runDtoOf(row: RunLogRow): AutomationRunDto {
  return {
    id: row.id,
    automation_id: row.automation_id,
    automation_version: row.automation_version,
    status: row.status,
    error: errorOf(row.error, RUN_ERROR_KEYS) as AutomationRunError | null,
    trigger: triggerOf(row.input),
    trigger_unit: row.trigger_unit,
    depth: row.depth,
    rerun_of: row.rerun_of_run_id,
    rerun_by:
      row.rerun_by_user_id === null
        ? null
        : { id: row.rerun_by_user_id, name: row.rerun_by_name ?? '' },
    active_ms: Number(row.active_ms),
    started_at: row.started_at === null ? null : iso(row.started_at),
    finished_at: row.finished_at === null ? null : iso(row.finished_at),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

/**
 * The run log (SPEC §11.1, §11.7; CONTRACTS §21 "Lịch sử chạy"; BACKLOG
 * T518).
 *
 * - Only people who manage the automation (ADR-25 §3) see its runs; anyone
 *   else gets `404` — also someone who sees the automation but cannot
 *   manage it, since runs carry record data ("Quy ước S5"). The base-wide
 *   list answers like the automation list: a reader of the base who manages
 *   no automation gets `403`.
 * - Step outputs are shown with the caller's **current** permissions:
 *   values of fields they cannot read, and records outside their read rule,
 *   are `null` (`redacted`).
 * - Re-run and cancel are the run log service's (`AutomationRunLog`),
 *   audited as `automation.run.rerun` / `automation.run.cancelled`.
 */
@Injectable()
export class AutomationRunsService {
  private readonly log: AutomationRunLog;
  private readonly deliveries: HttpDeliveriesRepository;

  constructor(
    @Inject(DB) db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AutomationService) private readonly automations: AutomationService,
    @Inject(AutomationRunsRepository) private readonly runs: AutomationRunsRepository,
    @Inject(GroupMembersRepository) private readonly groupMembers: GroupMembersRepository,
    @Inject(RecordQueryService) private readonly query: RecordQueryService,
  ) {
    this.log = new AutomationRunLog(db);
    this.deliveries = new HttpDeliveriesRepository(db);
  }

  async listForAutomation(
    principal: Principal,
    automationId: Id<'aut'>,
    query: AutomationRunListQuery,
  ): Promise<AutomationRunList> {
    const { base, row } = await this.automations.locate(principal, automationId, true);
    return this.list(base.org.scope, { baseId: base.base.id, automationId: row.id }, query);
  }

  async listForBase(
    principal: Principal,
    baseId: Id<'bse'>,
    query: BaseAutomationRunListQuery,
  ): Promise<AutomationRunList> {
    const base = await this.access.requireBase(principal, baseId, 'read');
    if (!managesAnyAutomation(base.access)) {
      throw permissionDenied(
        'Run history is for base admins and people with manage rights on a trigger table.',
      );
    }
    return this.list(
      base.org.scope,
      {
        baseId: base.base.id,
        ...(base.access.is_admin ? {} : { triggerTableIds: managedTableIds(base.access) }),
        ...(query.automation_id === undefined ? {} : { automationId: query.automation_id }),
      },
      query,
    );
  }

  async get(principal: Principal, runId: Id<'run'>): Promise<AutomationRunDetailDto> {
    const located = await this.locateRun(principal, runId);
    const detail = await this.log.detail(located.base.org.scope, runId);
    if (detail === undefined) throw notFound();
    // HTTP steps (T605): their delivery, by action id (host and codes only).
    const deliveries = new Map<string, HttpDeliveryRow>();
    for (const row of await this.deliveries.listForRun(located.base.org.scope, runId)) {
      if (row.action_id !== null) deliveries.set(row.action_id, row);
    }
    const definition = runDefinitionOf(detail.run);
    const actions = actionsOf(definition);
    const delays = delayContextsOf(detail.run, definition, actions, detail.steps);
    const httpValues = httpStepValuesOf(actions);
    const valueContext = valueContextOf(detail.run, definition, actions, detail.steps);
    const readability = await this.readabilityFor(principal, located.base, detail.steps, actions, [
      ...[...delays.values()].flatMap(delayUntilRecordRefs),
      ...[...httpValues.values()].flatMap((values) =>
        values === null ? [] : valuesRecordRefs(values, valueContext),
      ),
    ]);
    return {
      ...runDtoOf(detail.run),
      automation: { id: located.row.id, name: located.row.name, version: located.row.version },
      definition,
      steps: detail.steps.map((step) => {
        const delay = delays.get(step.action_id);
        const values = httpValues.get(step.action_id);
        const dto = this.stepDtoOf(step, actions, readability, {
          hideDelayTimes: delay !== undefined && !delayUntilVisible(delay, readability),
          // T606: the response body only to a viewer who reads every value the request used.
          showHttpBody:
            values !== undefined &&
            values !== null &&
            valuesVisible(values, valueContext, readability),
        });
        const delivery = deliveries.get(step.action_id);
        return delivery === undefined ? dto : { ...dto, delivery: httpDeliverySummaryOf(delivery) };
      }),
      reruns: detail.reruns.map((rerun) => ({
        id: rerun.id,
        status: rerun.status,
        created_at: iso(rerun.created_at),
      })),
    };
  }

  async rerun(
    principal: Principal,
    runId: Id<'run'>,
    meta: RequestMeta,
  ): Promise<AutomationRunDto> {
    const { base } = await this.locateRun(principal, runId);
    const id = await this.log.rerun(base.org.scope, runId, {
      userId: principal.userId,
      context: mutationContextOf(meta, principal.userId),
    });
    return this.summary(base.org.scope, id);
  }

  async cancel(
    principal: Principal,
    runId: Id<'run'>,
    meta: RequestMeta,
  ): Promise<AutomationRunDto> {
    const { base } = await this.locateRun(principal, runId);
    await this.log.cancel(base.org.scope, runId, {
      userId: principal.userId,
      context: mutationContextOf(meta, principal.userId),
    });
    return this.summary(base.org.scope, runId);
  }

  // --- Internals --------------------------------------------------------------------

  private async list(
    scope: OrgScope,
    filter: RunLogFilter,
    query: AutomationRunListQuery,
  ): Promise<AutomationRunList> {
    const page = await this.log.list(
      scope,
      {
        ...filter,
        ...(query.status === undefined ? {} : { statuses: query.status }),
        ...(query.from === undefined ? {} : { from: new Date(query.from) }),
        ...(query.to === undefined ? {} : { to: new Date(query.to) }),
        ...(query.event_id === undefined ? {} : { eventId: query.event_id }),
      },
      { cursor: decodeCursor(query.cursor), limit: query.limit },
    );
    return { items: page.items.map(runDtoOf), next_cursor: page.nextCursor };
  }

  private async summary(scope: OrgScope, runId: Id<'run'>): Promise<AutomationRunDto> {
    const row = await this.runs.getForLog(scope, runId);
    if (row === undefined) throw notFound();
    return runDtoOf(row);
  }

  /** The run and its automation, when the caller manages it; `404` otherwise. */
  private async locateRun(principal: Principal, runId: Id<'run'>): Promise<Located> {
    for (const membership of await this.access.memberships(principal)) {
      const automationId = await this.runs.automationIdOf(
        orgScope(membership.organizationId),
        runId,
      );
      if (automationId === undefined) continue;
      return this.automations.locate(principal, automationId, true);
    }
    throw notFound();
  }

  /**
   * What the caller reads now, for the records of the value-carrying steps:
   * readable fields per table, and which of those records they read
   * (`RecordQueryService` with their own access — read rules, trash).
   * An API token without `records:read` reads no record value here
   * (`automations:read` never implies it, CONTRACTS §26.2 — QA S6).
   */
  private async readabilityFor(
    principal: Principal,
    base: BaseAccess,
    steps: readonly AutomationRunStepRow[],
    actions: ReturnType<typeof actionsOf>,
    extra: readonly StepRecordRefs[] = [],
  ): Promise<StepReadability> {
    if (principal.kind === 'api_token' && !principal.scopes.includes('records:read')) {
      return { fieldsOf: () => undefined, recordVisible: () => false };
    }
    const wanted = new Map<string, Set<string>>();
    const refsOf = steps.map((step) => {
      const action = actions.get(step.action_id);
      return stepRecordRefs(
        actionTypeOf(step, action?.type ?? null),
        action?.tableId ?? null,
        step.output,
      );
    });
    for (const refs of [...refsOf, ...extra]) {
      if (refs === undefined || refs.recordIds.length === 0) continue;
      const ids = wanted.get(refs.tableId) ?? new Set<string>();
      for (const id of refs.recordIds) ids.add(id);
      wanted.set(refs.tableId, ids);
    }
    const fields =
      wanted.size === 0
        ? new Map<string, ReadonlySet<string>>()
        : await this.automations.readableFieldsOf(base);
    const visible = new Map<string, ReadonlySet<string>>();
    let context: RecordAccessContext | undefined;
    for (const [tableId, ids] of wanted) {
      if (!fields.has(tableId) || !isId('tbl', tableId)) continue;
      context ??= await recordAccessContextOf(
        { groupMembers: this.groupMembers, config: this.config },
        principal.user,
        base,
      );
      visible.set(tableId, await this.visibleRecords(base.org.scope, tableId, [...ids], context));
    }
    return {
      fieldsOf: (tableId) => fields.get(tableId),
      recordVisible: (tableId, recordId) => visible.get(tableId)?.has(recordId) ?? false,
    };
  }

  /** Ids among `ids` the caller reads now (a table they lost, or in the trash: none). */
  private async visibleRecords(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    ids: readonly string[],
    access: RecordAccessContext,
  ): Promise<ReadonlySet<string>> {
    try {
      const records = await this.query.getRecords(scope, tableId, ids, access, {
        field_key_type: 'id',
        fields: [],
      });
      return new Set(records.map((record) => record.id as string));
    } catch (error) {
      if (isNotFound(error)) return new Set();
      throw error;
    }
  }

  private stepDtoOf(
    step: AutomationRunStepRow,
    actions: ReturnType<typeof actionsOf>,
    readability: StepReadability,
    options: { readonly hideDelayTimes: boolean; readonly showHttpBody: boolean },
  ): AutomationRunStepDto {
    const action = actions.get(step.action_id);
    const type = actionTypeOf(step, action?.type ?? null);
    const shown = redactStepOutput(
      type,
      action?.tableId ?? null,
      step.output,
      readability,
      options,
    );
    const input = isObject(step.input) ? step.input : {};
    return {
      id: step.id,
      action_id: step.action_id,
      action_type: type,
      status: step.status,
      attempt: step.attempt,
      started_at: iso(step.started_at),
      finished_at: step.finished_at === null ? null : iso(step.finished_at),
      reused: typeof input['reused_from'] === 'string',
      output: shown.output,
      redacted: shown.redacted,
      error: errorOf(step.error, STEP_ERROR_KEYS) as AutomationRunStepDto['error'],
    };
  }
}

/** Records of a step output: `{ id }` of a record action, `records[].id` of `find_records`. */
function outputRecordIds(output: unknown): string[] {
  if (!isObject(output)) return [];
  if (typeof output['id'] === 'string') return [output['id']];
  const records = output['records'];
  return Array.isArray(records)
    ? records.flatMap((record) =>
        isObject(record) && typeof record['id'] === 'string' ? [record['id']] : [],
      )
    : [];
}

/**
 * What decides whether each `delay` step's times may be shown: its `until`
 * value, the trigger record (and the date field of `record.date_reached`),
 * the records of the earlier steps.
 */
function delayContextsOf(
  run: RunLogRow,
  definition: ReturnType<typeof runDefinitionOf>,
  actions: ReturnType<typeof actionsOf>,
  steps: readonly AutomationRunStepRow[],
): Map<string, DelayUntilContext> {
  const context = valueContextOf(run, definition, actions, steps);
  const contexts = new Map<string, DelayUntilContext>();
  for (const [actionId, action] of actions) {
    if (action.type !== 'delay') continue;
    const config = isObject(action.config) ? action.config : {};
    contexts.set(actionId, { ...context, until: config['until'] ?? null });
  }
  return contexts;
}

/**
 * The values of each `http_request` step of the run's definition (T606),
 * whose readability decides whether its response body is shown; `null`
 * when the stored config no longer parses (the body stays hidden).
 */
function httpStepValuesOf(
  actions: ReturnType<typeof actionsOf>,
): Map<string, readonly unknown[] | null> {
  const values = new Map<string, readonly unknown[] | null>();
  for (const [actionId, action] of actions) {
    if (action.type !== 'http_request') continue;
    const config = httpRequestConfigSchema.safeParse(action.config);
    values.set(actionId, config.success ? httpRequestValuesOf(config.data) : null);
  }
  return values;
}

/**
 * What the values of a run's steps were read from: the trigger record (and
 * the date field of `record.date_reached`) and the records of the earlier
 * steps.
 */
function valueContextOf(
  run: RunLogRow,
  definition: ReturnType<typeof runDefinitionOf>,
  actions: ReturnType<typeof actionsOf>,
  steps: readonly AutomationRunStepRow[],
): Omit<DelayUntilContext, 'until'> {
  const trigger = triggerOf(run.input);
  const definitionTrigger: unknown = definition?.trigger;
  const dueFieldId =
    isObject(definitionTrigger) &&
    definitionTrigger['type'] === 'record.date_reached' &&
    typeof definitionTrigger['field_id'] === 'string'
      ? definitionTrigger['field_id']
      : null;
  const stepRecords = new Map(
    steps.map((step) => [
      step.action_id,
      {
        tableId: actions.get(step.action_id)?.tableId ?? null,
        recordIds: outputRecordIds(step.output),
      },
    ]),
  );
  return {
    trigger: { tableId: trigger.table_id, recordId: trigger.record_id, dueFieldId },
    steps: stepRecords,
  };
}

/** The step's own record of its action type, else the definition's. */
function actionTypeOf(step: AutomationRunStepRow, fallback: string | null): string | null {
  const type = isObject(step.input) ? step.input['type'] : undefined;
  return typeof type === 'string' ? type : fallback;
}

function isNotFound(error: unknown): boolean {
  return isObject(error) && error['code'] === 'NOT_FOUND';
}
