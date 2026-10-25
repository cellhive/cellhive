import {
  automationDefinitionSchema,
  newId,
  type AutomationDefinition,
  type AutomationTrigger,
  type Id,
} from '@cellhive/contracts';

import {
  listTimeTriggerAutomations,
  type TimeTriggerAutomation,
} from '../../db/cross-tenant-lookups.js';
import { OrganizationsRepository } from '../../db/repositories/organizations.repository.js';
import { orgScope, withTxScope, type OrgScope } from '../../db/repository.js';
import { AppError } from '../../errors/app-error.js';
import { resolveMemberBaseAccess, type AccessDefaults } from '../../import/member-access.js';
import { enqueue } from '../../jobs/enqueue.js';
import { RecordQueryService } from '../../records/record-query.service.js';
import { FieldsRepository } from '../../schema/fields.repository.js';
import { openWindow, type TimeScanWindow } from '../../time-scan/cursor-store.js';
import { dueRuleOf } from '../../time-scan/rule.js';
import { TimeScanCore } from '../../time-scan/scan-core.js';
import { changeConditionsOf, foldChangeConditions } from '../dispatch/condition.js';
import { DEFAULT_MAX_RUNS_PER_BATCH } from '../dispatch/dispatcher.js';
import { AutomationRunsRepository } from '../repository/automation-runs.repository.js';
import { AutomationsRepository } from '../repository/automations.repository.js';
import { AutomationTimeCursorsRepository } from '../repository/time-cursors.repository.js';

import { fireTimesBetween, parseCron } from './cron.js';
import { AutomationTimeCursorStore } from './cursor-store.js';
import { firstTimeZone } from './due.js';

import type { Db, Tx } from '../../db/create-db.js';
import type { AutomationRow, JsonObject } from '../../db/schema.js';
import type { DueScanRow } from '../../records/due/due-scan.js';
import type { SchemaService } from '../../schema/schema.service.js';
import type { FilterNode } from '@cellhive/filter-dsl';

/** Automations listed per page by a tick. */
export const TIME_TRIGGER_PAGE = 500;
/** Records read per page by the date scan. */
export const DATE_SCAN_PAGE = 500;
/** Missed `schedule` fire times counted at most (`missed` of the run). */
export const SCHEDULE_MISSED_COUNT_LIMIT = 10_000;

/** What happened to one automation in one tick (logged, ids and codes only). */
export type TimeTriggerOutcome =
  | 'fired'
  | 'idle'
  | 'duplicate'
  | 'turned_off'
  | 'invalid_definition'
  | 'run_as_without_access'
  | 'field_unavailable'
  | 'condition_false'
  | 'capped'
  /**
   * The tick of this automation failed (statement timeout, database
   * error…): its cursor did not move, the next tick tries again; the other
   * automations (other organizations) are handled anyway (QA T559 H2).
   */
  | 'error';

export interface TimeTriggerResult {
  readonly organizationId: Id<'org'>;
  readonly automationId: Id<'aut'>;
  readonly outcome: TimeTriggerOutcome;
  /** Runs created. */
  readonly runs: number;
  /** `schedule`: fire times of the window not fired (downtime). */
  readonly missed?: number;
  /** `error`: the code of the failure (`AppError` code or `internal`) — never its message. */
  readonly errorCode?: string;
}

export interface TimeTriggerTick {
  readonly automations: number;
  readonly runs: number;
  readonly results: readonly TimeTriggerResult[];
}

export interface AutomationTimeTriggersOptions {
  readonly defaults: AccessDefaults;
  /** Reads records as `run_as` (the date scan); default: a service on `db`. */
  readonly records?: RecordQueryService;
  /**
   * Creates the scan index of a date column (`SchemaService.ensureDueIndex`);
   * without it the scan reads without one (tests).
   */
  readonly schema?: Pick<SchemaService, 'ensureDueIndex'>;
  /** Runs one date scan creates per automation at most (`AUTOMATION_MAX_RUNS_PER_BATCH`). */
  readonly maxRunsPerScan?: number;
  /** Called when the scan index cannot be created (the scan goes on without it). */
  readonly onIndexError?: (error: unknown, fieldId: Id<'fld'>) => void;
}

type ScheduleTrigger = Extract<AutomationTrigger, { type: 'schedule' }>;
type DateTrigger = Extract<AutomationTrigger, { type: 'record.date_reached' }>;

/** The trigger part of `automation_runs.input` of a time trigger (read by the engine). */
interface TimeRunTrigger {
  readonly event_id: null;
  readonly event_created_at: null;
  readonly type: 'schedule' | 'record.date_reached';
  readonly table_id: Id<'tbl'> | null;
  readonly record_id: Id<'rec'> | null;
  readonly bulk: false;
  readonly batch: null;
  /** `fired_at` (both), `due_at` (`record.date_reached`): `[@fired_at]`, `[@due_at]`. */
  readonly data: { readonly fired_at: string; readonly due_at?: string };
  /** `schedule`: fire times of the window that were not fired. */
  readonly missed?: number;
}

function settingOf(settings: unknown, key: string): unknown {
  return typeof settings === 'object' && settings !== null && !Array.isArray(settings)
    ? (settings as Record<string, unknown>)[key]
    : undefined;
}

/**
 * The time triggers of SPEC §11.2 (BACKLOG T508): `schedule` and
 * `record.date_reached`, run by two crons every minute
 * (`automation.schedule_tick`, `automation.date_scan`). Both find the
 * enabled automations of every organization through
 * `listTimeTriggerAutomations` (ids only), then handle each automation in
 * its own transaction, in its organization's scope:
 *
 * - the automation row is locked (`enabled`, not deleted) and its cursor
 *   (`meta.automation_time_cursors`) too; the window is
 *   `(max(scanned_until, trigger_armed_at), now]` — only moments after the
 *   automation was turned on fire, and a stopped worker resumes where it
 *   stopped;
 * - runs are `queued` with a dedupe key (`automation_runs.trigger_key`), an
 *   `automation.run` job each, and no event (`depth` 0, `trigger_event_id`
 *   `NULL`); the cursor moves in the same transaction.
 *
 * `schedule`: the latest fire time of the window fires **once**
 * (`automation_id:fired_at`); earlier ones (worker stopped) are counted in
 * `missed`, not fired. `record.date_reached`: every live record whose date
 * (+ offset, date-only at `time_of_day` in the field's zone, ADR-21) falls
 * in the window and that `run_as` reads (read rule, field readable,
 * condition) fires once per value (`automation_id:record_id:<value>`), so a
 * changed value fires again; at most `maxRunsPerScan` runs per automation
 * per tick, the rest the next tick. The scan reads by range on the column
 * (index from `SchemaService.ensureDueIndex`).
 *
 * The window, the paged range read, the due filter and the cap come from
 * the shared time scan core (`time-scan/**`, ADR-34 §1, BACKLOG T546); this
 * class is its automation consumer: cursor store `automation_time_cursors`,
 * access of `run_as`, the automation `condition` as filter, one run per hit.
 *
 * The clock is the caller's `now` (tests inject it). Never logs values.
 */
export class AutomationTimeTriggers {
  private readonly automations: AutomationsRepository;
  private readonly runs: AutomationRunsRepository;
  private readonly cursors: AutomationTimeCursorStore;
  private readonly fields: FieldsRepository;
  private readonly organizations: OrganizationsRepository;
  private readonly core: TimeScanCore;
  private readonly maxRunsPerScan: number;

  constructor(
    private readonly db: Db,
    private readonly options: AutomationTimeTriggersOptions,
  ) {
    this.automations = new AutomationsRepository(db);
    this.runs = new AutomationRunsRepository(db);
    this.cursors = new AutomationTimeCursorStore(new AutomationTimeCursorsRepository(db));
    this.fields = new FieldsRepository(db);
    this.organizations = new OrganizationsRepository(db);
    this.core = new TimeScanCore(
      options.records ?? new RecordQueryService(db, { defaultTimeZone: options.defaults.timeZone }),
      {
        ...(options.schema === undefined ? {} : { schema: options.schema }),
        ...(options.onIndexError === undefined ? {} : { onIndexError: options.onIndexError }),
      },
    );
    this.maxRunsPerScan = options.maxRunsPerScan ?? DEFAULT_MAX_RUNS_PER_BATCH;
    if (!Number.isSafeInteger(this.maxRunsPerScan) || this.maxRunsPerScan < 1) {
      throw new RangeError('maxRunsPerScan must be a positive integer');
    }
  }

  /** `automation.schedule_tick`: every enabled `schedule` automation once. */
  async tickSchedules(now: Date): Promise<TimeTriggerTick> {
    return this.forEach('schedule', (item) => this.tickSchedule(item, now));
  }

  /** `automation.date_scan`: every enabled `record.date_reached` automation once. */
  async scanDates(now: Date): Promise<TimeTriggerTick> {
    return this.forEach('record.date_reached', (item) => this.scanDate(item, now));
  }

  /** One `schedule` automation (also for tests). */
  async tickSchedule(item: TimeTriggerAutomation, now: Date): Promise<TimeTriggerResult> {
    const scope = orgScope(item.organizationId);
    return this.db.withTx(async (tx) => {
      const txScope = withTxScope(scope, tx);
      const result = (outcome: TimeTriggerOutcome, runs = 0, missed?: number) => ({
        ...item,
        outcome,
        runs,
        ...(missed === undefined ? {} : { missed }),
      });
      const row = await this.automations.lockEnabled(txScope, item.automationId);
      if (row?.trigger_type !== 'schedule') return result('turned_off');
      const definition = definitionOf(row);
      if (definition?.trigger.type !== 'schedule') return result('invalid_definition');
      const window = await openWindow(this.cursors, txScope, row, now);
      if (window === null) return result('idle');
      await this.cursors.advance(txScope, row, now);
      const trigger: ScheduleTrigger = definition.trigger;
      const parsed = parseCron(trigger.cron);
      if (!parsed.ok) return result('invalid_definition');
      const timeZone = firstTimeZone(
        trigger.timezone,
        await this.organizationTimeZone(txScope),
        this.options.defaults.timeZone,
      );
      const fires = fireTimesBetween(
        parsed.schedule,
        timeZone,
        window.from,
        window.to,
        SCHEDULE_MISSED_COUNT_LIMIT + 1,
      );
      const latest = fires[0];
      if (latest === undefined) return result('idle');
      const missed = fires.length - 1;
      const access = await resolveMemberBaseAccess(
        this.db,
        txScope,
        { userId: row.run_as_user_id, baseId: row.base_id },
        this.options.defaults,
      );
      if (access === undefined) return result('run_as_without_access', 0, missed);
      const firedAt = new Date(latest).toISOString();
      const runTrigger: TimeRunTrigger = {
        event_id: null,
        event_created_at: null,
        type: 'schedule',
        table_id: null,
        record_id: null,
        bulk: false,
        batch: null,
        data: { fired_at: firedAt },
        missed,
      };
      const created = await this.createRun(tx, txScope, row, {
        key: `${row.id}:${firedAt}`,
        unit: `schedule:${firedAt}`,
        trigger: runTrigger,
      });
      return result(created ? 'fired' : 'duplicate', created ? 1 : 0, missed);
    });
  }

  /** One `record.date_reached` automation (also for tests). */
  async scanDate(item: TimeTriggerAutomation, now: Date): Promise<TimeTriggerResult> {
    const scope = orgScope(item.organizationId);
    const result = (outcome: TimeTriggerOutcome, runs = 0) => ({ ...item, outcome, runs });
    // The scan index first, outside the transaction (it takes the table's schema lock).
    const listed = await this.automations.get(scope, item.automationId);
    const listedDefinition = listed === undefined ? null : definitionOf(listed);
    if (listedDefinition?.trigger.type === 'record.date_reached') {
      await this.core.ensureIndex(scope, listedDefinition.trigger.field_id);
    }
    return this.db.withTx(async (tx) => {
      const txScope = withTxScope(scope, tx);
      const row = await this.automations.lockEnabled(txScope, item.automationId);
      if (row?.trigger_type !== 'record.date_reached') return result('turned_off');
      const definition = definitionOf(row);
      if (definition?.trigger.type !== 'record.date_reached') {
        return result('invalid_definition');
      }
      const trigger: DateTrigger = definition.trigger;
      const window = await openWindow(this.cursors, txScope, row, now);
      if (window === null) return result('idle');
      // Whatever happens below, this window is handled (nothing fires late).
      const done = async (outcome: TimeTriggerOutcome, runs = 0, until: Date = now) => {
        await this.cursors.advance(txScope, row, until);
        return result(outcome, runs);
      };

      const access = await resolveMemberBaseAccess(
        this.db,
        txScope,
        { userId: row.run_as_user_id, baseId: row.base_id },
        this.options.defaults,
      );
      if (access === undefined) return done('run_as_without_access');
      const field = await this.fields.getById(txScope, trigger.field_id);
      const rule =
        field === undefined || field.table_id !== trigger.table_id
          ? null
          : dueRuleOf(
              field,
              { offsetMinutes: trigger.offset_minutes, timeOfDay: trigger.time_of_day },
              {
                organization: await this.organizationTimeZone(txScope),
                fallback: this.options.defaults.timeZone,
              },
            );
      if (rule === null) return done('field_unavailable');
      const filter = conditionFilterOf(definition);
      if (filter === false) return done('condition_false');

      // Read as `run_as` in its own read transactions (statement timeout,
      // read lock of the table); runs are created in this transaction.
      const scanned = await this.core.scan(scope, {
        tx,
        tableId: trigger.table_id,
        fieldId: trigger.field_id,
        rule,
        window,
        access: access.record,
        ...(filter === true ? {} : { filter }),
        pageSize: DATE_SCAN_PAGE,
        maxHits: this.maxRunsPerScan,
        onDue: (runTx, record, due) =>
          this.fireDate(runTx, txScope, row, trigger, window, record, due),
      });
      switch (scanned.outcome) {
        // Table or field `run_as` cannot read any more (T507 turns it off).
        case 'unavailable':
          return done('field_unavailable', scanned.hits, scanned.until);
        // The rest next tick: from just before the last due time (same-time
        // records already fired are deduplicated by their key).
        case 'capped':
          return done('capped', scanned.hits, scanned.until);
        case 'done':
          return done(scanned.hits > 0 ? 'fired' : 'idle', scanned.hits, scanned.until);
      }
    });
  }

  /** One `record.date_reached` run for a record due in the window; `false` when a duplicate. */
  private async fireDate(
    tx: Tx,
    scope: OrgScope,
    row: AutomationRow,
    trigger: DateTrigger,
    window: TimeScanWindow,
    record: DueScanRow,
    due: number,
  ): Promise<boolean> {
    const dueIso = new Date(due).toISOString();
    return this.createRun(tx, scope, row, {
      key: `${row.id}:${record.id}:${record.value}`,
      unit: `date:${new Date(window.to).toISOString()}`,
      trigger: {
        event_id: null,
        event_created_at: null,
        type: 'record.date_reached',
        table_id: trigger.table_id,
        record_id: record.id,
        bulk: false,
        batch: null,
        data: { fired_at: dueIso, due_at: dueIso },
      },
    });
  }

  private async forEach(
    type: 'schedule' | 'record.date_reached',
    handle: (item: TimeTriggerAutomation) => Promise<TimeTriggerResult>,
  ): Promise<TimeTriggerTick> {
    const results: TimeTriggerResult[] = [];
    let after: TimeTriggerAutomation | null = null;
    for (;;) {
      const page = await listTimeTriggerAutomations(this.db.kysely, {
        type,
        after,
        limit: TIME_TRIGGER_PAGE,
      });
      for (const item of page) {
        try {
          results.push(await handle(item));
        } catch (error) {
          results.push({
            organizationId: item.organizationId,
            automationId: item.automationId,
            outcome: 'error',
            runs: 0,
            errorCode: error instanceof AppError ? error.code : 'internal',
          });
        }
      }
      after = page.at(-1) ?? null;
      if (page.length < TIME_TRIGGER_PAGE) break;
    }
    return {
      automations: results.length,
      runs: results.reduce((sum, item) => sum + item.runs, 0),
      results,
    };
  }

  private async createRun(
    tx: Tx,
    scope: OrgScope,
    row: AutomationRow,
    run: { readonly key: string; readonly unit: string; readonly trigger: TimeRunTrigger },
  ): Promise<boolean> {
    const runId = newId('run');
    const inserted = await this.runs.insertKeyed(scope, {
      id: runId,
      automationId: row.id,
      automationVersion: row.version,
      triggerKey: run.key,
      triggerUnit: run.unit,
      depth: 0,
      input: {
        automation_version: row.version,
        definition: row.definition,
        trigger: run.trigger as unknown as JsonObject,
      },
    });
    if (inserted === undefined) return false;
    await enqueue(tx, 'automation.run', { organization_id: scope.organizationId, run_id: runId });
    return true;
  }

  private async organizationTimeZone(scope: OrgScope): Promise<unknown> {
    const organization = await this.organizations.findById(scope.organizationId, scope.tx);
    return settingOf(organization?.settings, 'timezone');
  }
}

function definitionOf(row: AutomationRow): AutomationDefinition | null {
  const parsed = automationDefinitionSchema.safeParse(row.definition);
  return parsed.success ? parsed.data : null;
}

/**
 * The condition of a time trigger as a record filter: `true` (none),
 * `false` (never holds), or a Filter DSL tree. There is no change behind a
 * time trigger, so `changed*` conditions are false.
 */
function conditionFilterOf(definition: AutomationDefinition): unknown {
  if (definition.condition === null) return true;
  const node = definition.condition as unknown as FilterNode;
  if (changeConditionsOf(node).length === 0) return node;
  const folded = foldChangeConditions(node, () => false);
  return folded.kind === 'constant' ? folded.value : folded.filter;
}
