import { isId, newId, type ButtonDisabledReason, type Id } from '@cellhive/contracts';

import { AuditWriter } from '../../../audit/audit-writer.js';
import { withTxScope, type OrgScope } from '../../../db/repository.js';
import { AppError } from '../../../errors/app-error.js';
import { emit } from '../../../events/event-writer.js';
import { resolveMemberBaseAccess, type AccessDefaults } from '../../../import/member-access.js';
import { enqueue } from '../../../jobs/enqueue.js';
import { RecordQueryService } from '../../../records/record-query.service.js';
import { readable } from '../../../records/table-model.js';
import { FieldsRepository } from '../../../schema/fields.repository.js';
import {
  BREAKER_MAX_UNITS_PER_MINUTE,
  BREAKER_WINDOW_SECONDS,
  tripCircuitBreaker,
} from '../../dispatch/circuit-breaker.js';
import { AUTOMATION_NOTIFICATIONS, type AutomationNotifier } from '../../dispatch/notifier.js';
import { AutomationRunsRepository } from '../../repository/automation-runs.repository.js';
import { AutomationsRepository } from '../../repository/automations.repository.js';

import { buttonAutomationOf, buttonGateOf, type ButtonAutomation } from './button-trigger.js';

import type { AuditContext } from '../../../audit/audit-entry.js';
import type { Db } from '../../../db/create-db.js';
import type { JsonObject } from '../../../db/schema.js';
import type { RecordAccessContext } from '../../../records/types.js';

export interface ButtonClickServiceOptions {
  /** Instance defaults used to resolve the access of `run_as`. */
  readonly defaults: AccessDefaults;
  /** Reads records as the clicker and as `run_as`; default: a service on `db`. */
  readonly records?: RecordQueryService;
  /** `automation.disabled` notification of a tripped circuit breaker; default: T511's. */
  readonly notifier?: AutomationNotifier;
}

export interface ButtonClickInput {
  readonly tableId: Id<'tbl'>;
  readonly recordId: string;
  readonly fieldId: string;
  /** The clicker's access to the table's base (a person: `userId` set). */
  readonly access: RecordAccessContext;
  /** Audit context of the request (actor = the clicker). */
  readonly context: AuditContext;
}

export interface ButtonClickResult {
  readonly runId: Id<'run'>;
  readonly eventId: Id<'evt'>;
  readonly automationId: Id<'aut'>;
}

/** The `trigger` part of `automation_runs.input` of a click (read by the engine, T505). */
interface ClickRunTrigger {
  readonly event_id: Id<'evt'>;
  readonly event_created_at: string;
  readonly type: 'button.clicked';
  readonly table_id: Id<'tbl'>;
  readonly record_id: Id<'rec'>;
  readonly bulk: false;
  readonly batch: null;
  /** `[@clicked_by]`, `[@clicked_at]`, `{ trigger: "clicked_by" }` (T504/T505). */
  readonly data: { readonly clicked_by: Id<'usr'>; readonly clicked_at: string };
}

const audit = new AuditWriter();

const notFound = () => new AppError('NOT_FOUND');

/** `422 VALIDATION_FAILED` / `BUTTON_DISABLED` (CONTRACTS §6, §21). */
export function buttonDisabled(reason: Exclude<ButtonDisabledReason, 'permission'>): AppError {
  return new AppError('VALIDATION_FAILED', {
    detail: 'This button cannot run now.',
    errors: [
      {
        path: 'field_id',
        code: 'BUTTON_DISABLED',
        message: 'The button cannot run now',
        params: { reason },
      },
    ],
  });
}

/**
 * A click on a button field (BACKLOG T517, ADR-32 §2, CONTRACTS §21): the
 * trigger `button.clicked` of the one automation attached to the button.
 *
 * Checks, in this order (the clicker never learns more than the cell shows):
 *
 * 1. the clicker reads the table, the field (a `button` of the table) and
 *    the record (live, in their read rule) — else `404`;
 * 2. the clicker has the trigger's `min_permission` on the record — `edit`
 *    (default; also without automation): table permission `edit`/`manage`
 *    and the record in their edit rule; `read`: reading it — else `403`;
 * 3. an automation (not deleted) is attached and on — else `422`
 *    `BUTTON_DISABLED` (`no_automation` / `automation_disabled`);
 * 4. `enabled_when` AND the automation's condition (`changed*` false) hold
 *    for the latest record read as `run_as` (read rule, readable fields) —
 *    else `422` `BUTTON_DISABLED` (`condition`).
 *
 * Then, in one transaction with the automation locked (still on): the
 * circuit breaker (ADR-26 §5; a click is its own trigger unit — tripping it
 * turns the automation off and answers `automation_disabled`), the event
 * `button.clicked` (`entity_type = record`, actor the clicker, depth 0) and
 * its audit entry, and a `queued` run (`trigger_event_id` / `trigger_unit` =
 * the event, `input.trigger.data = { clicked_by, clicked_at }`) with its
 * `automation.run` job. The run executes as `run_as` (T505), never as the
 * clicker. Rate limits and `Idempotency-Key` belong to the API. Share links
 * never reach this service.
 */
export class ButtonClickService {
  private readonly automations: AutomationsRepository;
  private readonly runs: AutomationRunsRepository;
  private readonly fields: FieldsRepository;
  private readonly records: RecordQueryService;
  private readonly notifier: AutomationNotifier;

  constructor(
    private readonly db: Db,
    private readonly options: ButtonClickServiceOptions,
  ) {
    this.automations = new AutomationsRepository(db);
    this.runs = new AutomationRunsRepository(db);
    this.fields = new FieldsRepository(db);
    this.records =
      options.records ??
      new RecordQueryService(db, {
        defaultTimeZone: options.defaults.timeZone,
        defaultLocale: options.defaults.locale,
      });
    this.notifier = options.notifier ?? AUTOMATION_NOTIFICATIONS;
  }

  async click(scope: OrgScope, input: ButtonClickInput): Promise<ButtonClickResult> {
    if (scope.tx !== undefined) throw new TypeError('ButtonClickService opens its own transaction');
    const { tableId, access } = input;
    const userId = access.userId;
    if (userId === null) throw notFound();
    const tableAccess = access.resolved.access.tables[tableId];
    if (tableAccess === undefined) throw notFound();
    if (!isId('fld', input.fieldId) || !isId('rec', input.recordId)) throw notFound();
    const fieldId = input.fieldId;
    const recordId = input.recordId;

    // 1. Table, field and record readable by the clicker.
    const field = await this.fields.getById(scope, fieldId);
    if (field?.table_id !== tableId || field.type !== 'button' || !readable(tableAccess, fieldId)) {
      throw notFound();
    }
    // `404` too for a table outside the clicker's base or not readable.
    const visible = await this.records.matchingIds(scope, tableId, access, [recordId], null);
    if (!visible.has(recordId)) throw notFound();

    // 2. `min_permission` (`edit` when nothing is attached yet).
    const [row] = await this.automations.listForButtons(scope, [fieldId]);
    const automation = row === undefined ? null : buttonAutomationOf(row, tableId, fieldId);
    const minPermission = automation?.trigger.min_permission ?? 'edit';
    if (minPermission === 'edit' && !(await this.mayEdit(scope, input, recordId))) {
      throw new AppError('PERMISSION_DENIED', {
        detail: 'You need to be able to edit this record to use this button.',
        params: { min_permission: minPermission },
      });
    }

    // 3–4. Attached, on, and its gate holds as `run_as`.
    if (row === undefined) throw buttonDisabled('no_automation');
    if (automation === null || !row.enabled) throw buttonDisabled('automation_disabled');
    if (!(await this.gateHolds(scope, automation, tableId, recordId))) {
      throw buttonDisabled('condition');
    }

    const outcome = await this.db.withTx(async (tx) => {
      const txScope = withTxScope(scope, tx);
      const locked = await this.automations.lockEnabled(txScope, row.id);
      if (locked === undefined) return { kind: 'off' } as const;
      const current =
        locked.version === row.version ? automation : buttonAutomationOf(locked, tableId, fieldId);
      // Changed meanwhile to another button or trigger.
      if (current === null) return { kind: 'detached' } as const;

      // Circuit breaker (ADR-26 §5): every click is a new trigger unit.
      const recent = await this.runs.recentUnits(txScope, locked.id, BREAKER_WINDOW_SECONDS, '');
      if (recent.distinct + 1 > BREAKER_MAX_UNITS_PER_MINUTE) {
        await tripCircuitBreaker(this.db, tx, scope, locked, this.notifier);
        return { kind: 'tripped' } as const;
      }

      const runId = newId('run');
      const data: JsonObject = { field_id: fieldId, automation_id: locked.id, run_id: runId };
      const event = await emit(tx, {
        type: 'button.clicked',
        organizationId: scope.organizationId,
        entityType: 'record',
        entityId: recordId,
        actor: input.context.actor,
        baseId: locked.base_id,
        tableId,
        data,
      });
      await audit.write(tx, {
        action: 'button.clicked',
        organizationId: scope.organizationId,
        baseId: locked.base_id,
        tableId,
        entityType: 'record',
        entityId: recordId,
        before: null,
        after: data,
        context: input.context,
      });
      const eventCreatedAt = event.createdAtExact ?? event.createdAt.toISOString();
      const trigger: ClickRunTrigger = {
        event_id: event.id,
        event_created_at: eventCreatedAt,
        type: 'button.clicked',
        table_id: tableId,
        record_id: recordId,
        bulk: false,
        batch: null,
        data: { clicked_by: userId, clicked_at: event.createdAt.toISOString() },
      };
      const inserted = await this.runs.insert(txScope, {
        id: runId,
        automationId: locked.id,
        automationVersion: locked.version,
        triggerEventId: event.id,
        triggerUnit: event.id,
        status: 'queued',
        depth: 0,
        input: {
          automation_version: locked.version,
          definition: locked.definition,
          trigger: trigger as unknown as JsonObject,
        },
      });
      if (inserted === undefined) throw new Error('The run of a new click event already exists');
      await enqueue(tx, 'automation.run', { organization_id: scope.organizationId, run_id: runId });
      return { kind: 'queued', runId, eventId: event.id, automationId: locked.id } as const;
    });
    switch (outcome.kind) {
      case 'off':
      case 'tripped':
        throw buttonDisabled('automation_disabled');
      case 'detached':
        throw buttonDisabled('no_automation');
      case 'queued':
        return {
          runId: outcome.runId,
          eventId: outcome.eventId,
          automationId: outcome.automationId,
        };
    }
  }

  /** The clicker may edit the record: table permission `edit`/`manage` and their edit rule. */
  private async mayEdit(
    scope: OrgScope,
    input: ButtonClickInput,
    recordId: Id<'rec'>,
  ): Promise<boolean> {
    const perm = input.access.resolved.access.tables[input.tableId]?.perm;
    if (perm !== 'edit' && perm !== 'manage') return false;
    const editable = await this.records.matchingIds(
      scope,
      input.tableId,
      input.access,
      [recordId],
      null,
      { editable: true },
    );
    return editable.has(recordId);
  }

  /** `enabled_when` AND the condition hold for the latest record, read as `run_as`. */
  private async gateHolds(
    scope: OrgScope,
    automation: ButtonAutomation,
    tableId: Id<'tbl'>,
    recordId: Id<'rec'>,
  ): Promise<boolean> {
    const gate = buttonGateOf(automation);
    if (gate === false) return false;
    const runAs = await resolveMemberBaseAccess(
      this.db,
      scope,
      { userId: automation.row.run_as_user_id, baseId: automation.row.base_id },
      this.options.defaults,
    );
    // Without access, the run would fail at once (T507 turns the automation off).
    if (runAs === undefined) return false;
    try {
      return await this.records.matchRecord(
        scope,
        tableId,
        recordId,
        runAs.record,
        gate === true ? null : gate,
      );
    } catch (error) {
      // Table or field `run_as` cannot read (any more).
      if (error instanceof AppError) return false;
      throw error;
    }
  }
}
