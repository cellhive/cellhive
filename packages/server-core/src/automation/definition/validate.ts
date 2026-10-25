import {
  ATTACHMENT_FIELD_INVALID,
  ATTACHMENT_FIELD_NOT_DOWNLOADABLE,
  AUTOMATION_PERMISSION_DENIED,
  CRON_TOO_FREQUENT,
  INVALID_CRON,
  INVALID_TIME_ZONE,
  SCHEDULE_MIN_INTERVAL_MINUTES,
  DUPLICATE_ACTION_ID,
  EMAIL_BODY_DIGEST_REFERENCE,
  EMAIL_REPLY_TO_INVALID,
  HEADER_NOT_ALLOWED,
  IMAGE_SOURCE_NOT_ALLOWED,
  INVALID_URL,
  isAllowedHttpRequestHeader,
  INVALID_CONDITION,
  MAX_AUTOMATION_ACTIONS,
  NO_TRIGGER_RECORD,
  NOT_TRIGGER_TABLE,
  TOO_MANY_ACTIONS,
  UNKNOWN_STEP,
  UNKNOWN_WEBHOOK,
  UNSUPPORTED_VALUE_SOURCE,
  WEBHOOK_TRIGGER_PARTS,
  type AutomationAction,
  type AutomationBranchAction,
  type AutomationDefinition,
  type AutomationFilter,
  type AutomationTrigger,
  type AutomationValue,
  type EffectiveAccess,
  type EmailRecipientValue,
  type EmailReplyTo,
  type HttpRequestBody,
  type HttpRequestConfig,
  type HttpRequestValue,
  type RunN8nWorkflowConfig,
  type Id,
  type NotificationRecipientValue,
  type ProblemErrorItem,
  type SendEmailConfig,
  type SendNotificationConfig,
  type SendTelegramConfig,
  type TableAccess,
  type TelegramChatValue,
} from '@cellhive/contracts';
import { isValidTimeZone } from '@cellhive/field-types';
import {
  isAutomationOnlyOperator,
  isFilterCondition,
  measureFilter,
  parseFilterInput,
  type FilterFieldMeta,
  type FilterMode,
  type FilterNode,
} from '@cellhive/filter-dsl';
import { collectImages, IMAGE_SOURCES, imageSyntaxIssues, parseTemplate } from '@cellhive/markdown';
import { isViewVisible } from '@cellhive/permissions';

import { normalizeAddress } from '../../mail/address.js';
import { isOutboundHttpError } from '../../net/errors.js';
import { parseOutboundUrl } from '../../net/url-policy.js';
import { computedFilterResultOf } from '../../records/computed/read/computed-fields.js';
import { dueValueKindOf } from '../../records/due/due-scan.js';
import { filterValueSlots, withFilterValues } from '../actions/update-records/filter-values.js';
import { minIntervalMinutes, parseCron } from '../time/cron.js';
import { checkAutomationTemplate } from '../values/check.js';
import {
  previousSourceOf,
  stepRecordTable,
  TRIGGER_REFERENCES,
  type TemplateSources,
} from '../values/references.js';
import { automationSnapshot, stepFieldsOf } from '../values/snapshot.js';

import type { FieldType } from '@cellhive/field-types';

/** What a definition is checked against: the base and one person's access (ADR-25 §3). */
export interface AutomationValidationContext {
  /**
   * Active tables of the base (trash excluded). `name` and
   * `primary_field_id` serve templates (names for the display form, record
   * titles, the primary field a `find_records` step returns by default).
   */
  readonly tables: readonly AutomationTableMeta[];
  /** Active fields of those tables. */
  readonly fields: readonly AutomationFieldMeta[];
  /** Effective access of the person the automation would run as. */
  readonly access: EffectiveAccess;
  /**
   * Formula/lookup fields locked for that person (T457): readable, but
   * conditions and watches on them answer like on a hidden field.
   */
  readonly lockedFieldIds?: ReadonlySet<string>;
  /** Views a `form.submitted` trigger may name, by id (any table of the base). */
  readonly views?: ReadonlyMap<string, AutomationViewMeta>;
  /**
   * Live (not deleted) incoming webhooks of **this** base a
   * `webhook.received` trigger may name (T604); absent = none.
   */
  readonly incomingWebhookIds?: ReadonlySet<string>;
}

export interface AutomationTableMeta {
  readonly id: Id<'tbl'>;
  readonly name?: string;
  readonly primary_field_id?: string | null;
}

export interface AutomationFieldMeta {
  readonly id: Id<'fld'>;
  readonly table_id: Id<'tbl'>;
  readonly name: string;
  readonly type: string;
  readonly options: unknown;
  readonly compute_mode?: string | null;
  readonly result_type?: unknown;
}

export interface AutomationViewMeta {
  readonly id: Id<'viw'>;
  readonly table_id: Id<'tbl'>;
  readonly type: string;
  readonly is_personal: boolean;
}

export type AutomationValidation =
  | {
      readonly ok: true;
      /** The definition to store: filters normalised to DSL with ids. */
      readonly definition: AutomationDefinition;
      /** Table of the trigger (`null` for `schedule`): who manages it, what dispatch matches. */
      readonly triggerTableId: Id<'tbl'> | null;
    }
  | { readonly ok: false; readonly errors: ProblemErrorItem[] };

/** Parts of `{ "trigger": … }` each trigger type provides (SPEC §11.4, ADR-32 §2). */
const TRIGGER_DATA_PARTS: Readonly<Record<AutomationTrigger['type'], readonly string[]>> = {
  'record.created': ['actor'],
  'record.updated': ['actor'],
  'record.deleted': ['actor'],
  'record.matches': ['actor'],
  'form.submitted': ['actor'],
  schedule: ['fired_at'],
  'record.date_reached': ['due_at'],
  'button.clicked': ['clicked_by', 'clicked_at'],
  'webhook.received': WEBHOOK_TRIGGER_PARTS,
};

/** The field type a `button.clicked` trigger names (T517, ADR-32 §2). */
const BUTTON_FIELD_TYPE = 'button';

const ROOT = 'definition';

function join(base: string, key: string | number): string {
  if (typeof key === 'number') return `${base}[${String(key)}]`;
  return /^[^.[\]"]+$/u.test(key) ? `${base}.${key}` : `${base}[${JSON.stringify(key)}]`;
}

/** A filter issue path (relative to the filter) under `base`. */
function joinRelative(base: string, path: string): string {
  if (path === '') return base;
  return path.startsWith('[') ? `${base}${path}` : `${base}.${path}`;
}

function isWritableTable(table: TableAccess): boolean {
  return table.perm === 'edit' || table.perm === 'manage';
}

/** Every action of a definition with its path, depth first (`if` before its branches). */
export function flattenActions(
  actions: readonly AutomationAction[],
  base = join(ROOT, 'actions'),
): { action: AutomationAction | AutomationBranchAction; path: string }[] {
  const out: { action: AutomationAction | AutomationBranchAction; path: string }[] = [];
  actions.forEach((action, index) => {
    const path = join(base, index);
    out.push({ action, path });
    if (action.type === 'if') {
      action.config.then.forEach((branch, i) => {
        out.push({ action: branch, path: join(join(join(path, 'config'), 'then'), i) });
      });
      action.config.else.forEach((branch, i) => {
        out.push({ action: branch, path: join(join(join(path, 'config'), 'else'), i) });
      });
    }
  });
  return out;
}

/**
 * Checks an automation definition against the base and the access of the
 * person it would run as (ADR-25 §3; BACKLOG T502), for every save that
 * makes that person `run_as`: create, a definition change, enable, take
 * over — and, from T507, again when `run_as` loses access.
 *
 * - Tables, fields and views the person cannot read are reported exactly
 *   like missing ones (`UNKNOWN_TABLE` / `UNKNOWN_FIELD` / `UNKNOWN_VIEW`),
 *   never revealing that they exist.
 * - Readable but not writable as an action needs (`perm ≥ edit`, `add` /
 *   `delete`, field `create`/`edit`) → `PERMISSION_DENIED`; computed fields
 *   → `FIELD_READ_ONLY`.
 * - At most `MAX_AUTOMATION_ACTIONS` actions including `if` branches,
 *   unique action ids, `step` values naming an earlier action, values and
 *   actions the trigger can provide (`NO_TRIGGER_RECORD`,
 *   `UNSUPPORTED_VALUE_SOURCE`).
 * - Filters validate like record filters (`automation` mode for the
 *   condition: `changed*` allowed), tuple form accepted, stored as DSL.
 *
 * Every problem is collected (paths under `definition.`); the caller turns
 * them into `422 AUTOMATION_INVALID`. Pure: no I/O.
 */
export function validateAutomationDefinition(
  definition: AutomationDefinition,
  context: AutomationValidationContext,
): AutomationValidation {
  return new DefinitionChecker(context).run(definition);
}

class DefinitionChecker {
  readonly errors: ProblemErrorItem[] = [];
  private readonly tableIds: ReadonlySet<string>;
  private readonly fieldsByTable = new Map<string, AutomationFieldMeta[]>();
  private readonly fieldById = new Map<string, AutomationFieldMeta>();
  private triggerTableId: Id<'tbl'> | null = null;
  private triggerHasRecord = false;
  private triggerType: AutomationTrigger['type'] = 'schedule';
  /** Record steps checked so far (readable table): what `[act_…]` in a template may name. */
  private readonly recordSteps = new Map<string, Id<'tbl'>>();
  /** `find_records` steps checked so far (readable table): what a `digest` may list. */
  private readonly findSteps = new Map<
    string,
    { readonly tableId: Id<'tbl'>; readonly fields: readonly string[] }
  >();

  constructor(private readonly context: AutomationValidationContext) {
    this.tableIds = new Set(context.tables.map((table) => table.id));
    for (const field of context.fields) {
      this.fieldById.set(field.id, field);
      const list = this.fieldsByTable.get(field.table_id) ?? [];
      list.push(field);
      this.fieldsByTable.set(field.table_id, list);
    }
  }

  run(definition: AutomationDefinition): AutomationValidation {
    const trigger = this.checkTrigger(definition.trigger, join(ROOT, 'trigger'));
    const issues = this.errors.length;
    const condition =
      definition.condition === null
        ? null
        : this.triggerType === 'webhook.received'
          ? this.refuseCondition(definition.condition)
          : this.checkTriggerFilter(definition.condition, join(ROOT, 'condition'), 'automation');
    // On a condition that parsed (an AST with ids).
    if (condition !== null && this.errors.length === issues && this.triggerTableId !== null) {
      this.checkChangedFields(
        condition as unknown as FilterNode,
        this.triggerTableId,
        join(ROOT, 'condition'),
      );
    }
    const actions = this.checkActions(definition.actions);
    if (this.errors.length > 0) return { ok: false, errors: this.errors };
    return {
      ok: true,
      definition: { trigger, condition, actions },
      triggerTableId: this.triggerTableId,
    };
  }

  /**
   * `webhook.received` has no record to test (ADR-35 §2): any condition is
   * `INVALID_CONDITION` — an `if` step on `{ "trigger": "body" … }` values
   * filters requests instead.
   */
  private refuseCondition(condition: AutomationFilter): AutomationFilter {
    this.add(
      join(ROOT, 'condition'),
      INVALID_CONDITION,
      'This trigger has no record: use an if step on the webhook data instead',
    );
    return condition;
  }

  // --- Issues -------------------------------------------------------------------

  private add(path: string, code: string, message: string, params?: Record<string, unknown>): void {
    this.errors.push({ path, code, message, ...(params === undefined ? {} : { params }) });
  }

  // --- Lookups ------------------------------------------------------------------

  /** The person's access to a readable table of the base, else `undefined`. */
  private readableTable(tableId: string): TableAccess | undefined {
    if (!this.tableIds.has(tableId)) return undefined;
    return this.context.access.tables[tableId as Id<'tbl'>];
  }

  /** `UNKNOWN_TABLE` unless the table is readable; returns its access. */
  private requireTable(tableId: string, path: string): TableAccess | undefined {
    const table = this.readableTable(tableId);
    if (table === undefined) this.add(path, 'UNKNOWN_TABLE', 'Unknown table');
    return table;
  }

  /** A readable field of `tableId` (not locked unless `allowLocked`), else `undefined`. */
  private readableField(
    tableId: string,
    fieldId: string,
    allowLocked = false,
  ): AutomationFieldMeta | undefined {
    const table = this.readableTable(tableId);
    const field = this.fieldById.get(fieldId);
    if (table === undefined || field === undefined || field.table_id !== tableId) return undefined;
    if (table.fields[field.id] === undefined) return undefined;
    if (!allowLocked && this.context.lockedFieldIds?.has(field.id) === true) return undefined;
    return field;
  }

  private requireField(
    tableId: string,
    fieldId: string,
    path: string,
    allowLocked = false,
  ): AutomationFieldMeta | undefined {
    const field = this.readableField(tableId, fieldId, allowLocked);
    if (field === undefined) this.add(path, 'UNKNOWN_FIELD', 'Unknown field');
    return field;
  }

  /** Readable, unlocked fields of a table: what a filter may name. */
  private filterFields(tableId: string): { meta: FilterFieldMeta[]; visible: string[] } {
    const fields = this.fieldsByTable.get(tableId) ?? [];
    const visible = fields
      .filter((field) => this.readableField(tableId, field.id) !== undefined)
      .map((field) => field.id);
    return {
      meta: fields.map((field) => ({
        id: field.id,
        name: field.name,
        type: field.type as FieldType,
        options: field.options,
        ...(field.type === 'formula' || field.type === 'lookup'
          ? computedFilterResultOf(field.result_type)
          : {}),
      })),
      visible,
    };
  }

  private checkFilter(
    filter: AutomationFilter,
    tableId: string,
    path: string,
    mode: FilterMode = 'standard',
  ): AutomationFilter {
    const { meta, visible } = this.filterFields(tableId);
    const result = parseFilterInput(filter, { fields: meta }, visible, {
      fieldKeyType: 'id',
      mode,
    });
    if (result.ok) return result.ast as unknown as AutomationFilter;
    for (const issue of result.errors) {
      this.add(joinRelative(path, issue.path), issue.code, issue.message, issue.params);
    }
    return filter;
  }

  /**
   * The filter of `update_records` (T506): like {@link checkFilter}, and a
   * condition `value` may be a value of SPEC §11.4 (checked as such, its
   * condition checked for field and operator; a no-value operator with one
   * is `VALUE_NOT_ALLOWED`). With such values the filter is stored as given
   * (ids); it is resolved and validated again when the step runs.
   */
  private checkValueFilter(
    filter: AutomationFilter,
    tableId: string,
    path: string,
    earlier: ReadonlySet<string>,
  ): AutomationFilter {
    const slots = filterValueSlots(filter);
    if (slots.length === 0) return this.checkFilter(filter, tableId, path);
    const stored = slots.map((slot) =>
      this.checkValue(slot.value, joinRelative(path, slot.path), earlier),
    );
    const probe = withFilterValues(
      filter,
      slots,
      slots.map(() => undefined),
    );
    const { meta, visible } = this.filterFields(tableId);
    const result = parseFilterInput(probe, { fields: meta }, visible, { fieldKeyType: 'id' });
    const issues = result.ok ? [] : result.errors;
    const valuePaths = new Set(slots.map((slot) => slot.path));
    for (const issue of issues) {
      // The probe left the values out: "needs a value" is what they provide.
      if (issue.code === 'VALUE_REQUIRED' && valuePaths.has(issue.path)) continue;
      this.add(joinRelative(path, issue.path), issue.code, issue.message, issue.params);
    }
    for (const slot of slots) {
      const condition = slot.path.slice(0, -'value'.length).replace(/\.$/u, '');
      const required = issues.some(
        (issue) => issue.code === 'VALUE_REQUIRED' && issue.path === slot.path,
      );
      const other = issues.some(
        (issue) =>
          issue.path !== slot.path &&
          (condition === '' || issue.path === condition || issue.path.startsWith(`${condition}.`)),
      );
      if (!required && !other) {
        this.add(
          joinRelative(path, slot.path),
          'VALUE_NOT_ALLOWED',
          'This operator takes no value',
        );
      }
    }
    return withFilterValues(filter, slots, stored) as AutomationFilter;
  }

  /** A filter on the trigger record (condition, `if`, `delay` recheck). */
  private checkTriggerFilter(
    filter: AutomationFilter,
    path: string,
    mode: FilterMode = 'standard',
  ): AutomationFilter {
    if (this.triggerTableId === null || !this.triggerHasRecord) {
      this.add(path, NO_TRIGGER_RECORD, 'This trigger has no record to test');
      return filter;
    }
    return this.checkFilter(filter, this.triggerTableId, path, mode);
  }

  // --- Trigger ------------------------------------------------------------------

  private checkTrigger(trigger: AutomationTrigger, path: string): AutomationTrigger {
    this.triggerType = trigger.type;
    if (trigger.type === 'schedule') {
      this.checkSchedule(trigger, path);
      return trigger;
    }
    if (trigger.type === 'webhook.received') {
      // A live hook of this base (T604): another base's or a deleted one reads as unknown.
      if (this.context.incomingWebhookIds?.has(trigger.incoming_webhook_id) !== true) {
        this.add(join(path, 'incoming_webhook_id'), UNKNOWN_WEBHOOK, 'Unknown incoming webhook');
      }
      return trigger;
    }
    if (trigger.type === 'form.submitted') {
      const view = this.context.views?.get(trigger.view_id);
      const table = view === undefined ? undefined : this.readableTable(view.table_id);
      if (
        view === undefined ||
        table === undefined ||
        view.type !== 'form' ||
        view.is_personal ||
        !isViewVisible(table, view.id)
      ) {
        this.add(join(path, 'view_id'), 'UNKNOWN_VIEW', 'Unknown form view');
        return trigger;
      }
      this.useTriggerTable(view.table_id);
      return trigger;
    }
    if (this.requireTable(trigger.table_id, join(path, 'table_id')) === undefined) return trigger;
    this.useTriggerTable(trigger.table_id);
    switch (trigger.type) {
      case 'record.created':
      case 'record.deleted':
        return trigger;
      case 'record.updated':
        trigger.watch_fields.forEach((fieldId, index) => {
          const fieldPath = join(join(path, 'watch_fields'), index);
          const field = this.requireField(trigger.table_id, fieldId, fieldPath);
          if (field !== undefined) this.requireNotVirtual(field, fieldPath);
        });
        if (new Set(trigger.watch_fields).size !== trigger.watch_fields.length) {
          this.add(join(path, 'watch_fields'), 'DUPLICATE_FIELD', 'A field is listed twice');
        }
        return trigger;
      case 'record.matches': {
        const conditionPath = join(path, 'condition');
        const before = this.errors.length;
        const condition = this.checkFilter(trigger.condition, trigger.table_id, conditionPath);
        if (this.errors.length === before) {
          const ast = condition as unknown as FilterNode;
          if (measureFilter(ast).conditions === 0) {
            this.add(conditionPath, 'EMPTY_FILTER', 'The condition needs at least one condition');
          }
          this.checkVirtualFields(ast, trigger.table_id, conditionPath);
        }
        return { ...trigger, condition };
      }
      case 'record.date_reached': {
        const fieldPath = join(path, 'field_id');
        const field = this.requireField(trigger.table_id, trigger.field_id, fieldPath, true);
        if (field !== undefined && dueValueKindOf(field) === null) {
          if (isVirtualDateField(field)) {
            // Computed on read: no stored value to index or to see change (T508).
            this.add(
              fieldPath,
              'INVALID_FIELD_TYPE',
              'A virtual formula/lookup cannot be scanned: make it stored',
              {
                expected: 'stored',
                type: field.type,
                compute_mode: 'virtual',
              },
            );
          } else {
            this.add(fieldPath, 'INVALID_FIELD_TYPE', 'Not a date field', {
              expected: 'datetime',
              type: field.type,
            });
          }
        }
        return trigger;
      }
      case 'button.clicked': {
        const fieldPath = join(path, 'field_id');
        const field = this.requireField(trigger.table_id, trigger.field_id, fieldPath, true);
        if (field !== undefined && field.type !== BUTTON_FIELD_TYPE) {
          this.add(fieldPath, 'INVALID_FIELD_TYPE', 'Not a button field', {
            expected: BUTTON_FIELD_TYPE,
            type: field.type,
          });
        }
        return {
          ...trigger,
          enabled_when:
            trigger.enabled_when === null
              ? null
              : this.checkFilter(
                  trigger.enabled_when,
                  trigger.table_id,
                  join(path, 'enabled_when'),
                ),
        };
      }
    }
  }

  /**
   * `schedule` (SPEC §11.2, T508): a five-field cron firing at most every 5
   * minutes, and an IANA time zone the runtime knows (`null` = the
   * organization's).
   */
  private checkSchedule(
    trigger: Extract<AutomationTrigger, { type: 'schedule' }>,
    path: string,
  ): void {
    const parsed = parseCron(trigger.cron);
    if (!parsed.ok) {
      this.add(join(path, 'cron'), INVALID_CRON, `Invalid cron expression: ${parsed.message}`, {
        field: parsed.field,
      });
    } else {
      const interval = minIntervalMinutes(parsed.schedule);
      if (interval < SCHEDULE_MIN_INTERVAL_MINUTES) {
        this.add(
          join(path, 'cron'),
          CRON_TOO_FREQUENT,
          `A schedule runs at most every ${String(SCHEDULE_MIN_INTERVAL_MINUTES)} minutes`,
          { min_interval_minutes: SCHEDULE_MIN_INTERVAL_MINUTES, interval_minutes: interval },
        );
      }
    }
    if (trigger.timezone !== null && !isValidTimeZone(trigger.timezone)) {
      this.add(join(path, 'timezone'), INVALID_TIME_ZONE, 'Unknown time zone');
    }
  }

  /**
   * A virtual formula/lookup (computed on read, e.g. with `NOW()`) has no
   * stored value whose change could be seen (T509, S4b-decisions-followup
   * §3.4): it cannot be watched nor tested with `changed*`.
   */
  private requireNotVirtual(field: AutomationFieldMeta, path: string): void {
    if (field.type !== 'formula' && field.type !== 'lookup') return;
    if (field.compute_mode !== 'virtual') return;
    this.add(
      path,
      'INVALID_FIELD_TYPE',
      'A virtual formula/lookup never changes as an event: make it stored, or use a date or schedule trigger',
      { expected: 'stored', type: field.type, compute_mode: 'virtual' },
    );
  }

  /**
   * Every condition of a (validated) `record.matches` condition on a
   * virtual field (T510): such a value changes without any event (only time
   * passing), so the record would never be seen entering the condition.
   */
  private checkVirtualFields(node: FilterNode, tableId: string, path: string): void {
    if (isFilterCondition(node)) {
      const field = this.readableField(tableId, node.field);
      if (field !== undefined) this.requireNotVirtual(field, join(path, 'field'));
      return;
    }
    if (node.op === 'not') {
      this.checkVirtualFields(node.item, tableId, join(path, 'item'));
      return;
    }
    node.items.forEach((item, index) => {
      this.checkVirtualFields(item, tableId, join(join(path, 'items'), index));
    });
  }

  /** `changed`/`changed_to`/`changed_from` of a (validated) condition on virtual fields. */
  private checkChangedFields(node: FilterNode, tableId: string, path: string): void {
    if (isFilterCondition(node)) {
      if (!isAutomationOnlyOperator(node.operator)) return;
      const field = this.readableField(tableId, node.field);
      if (field !== undefined) this.requireNotVirtual(field, join(path, 'field'));
      return;
    }
    if (node.op === 'not') {
      this.checkChangedFields(node.item, tableId, join(path, 'item'));
      return;
    }
    node.items.forEach((item, index) => {
      this.checkChangedFields(item, tableId, join(join(path, 'items'), index));
    });
  }

  private useTriggerTable(tableId: Id<'tbl'>): void {
    this.triggerTableId = tableId;
    this.triggerHasRecord = true;
  }

  // --- Actions ------------------------------------------------------------------

  private checkActions(actions: readonly AutomationAction[]): AutomationAction[] {
    const flat = flattenActions(actions);
    if (flat.length > MAX_AUTOMATION_ACTIONS) {
      this.add(
        join(ROOT, 'actions'),
        TOO_MANY_ACTIONS,
        `At most ${String(MAX_AUTOMATION_ACTIONS)} actions, if branches included`,
        { limit: MAX_AUTOMATION_ACTIONS, count: flat.length },
      );
    }
    const seen = new Set<string>();
    for (const { action, path } of flat) {
      if (seen.has(action.id)) {
        this.add(join(path, 'id'), DUPLICATE_ACTION_ID, 'Another action has this id', {
          id: action.id,
        });
      }
      seen.add(action.id);
    }
    const earlier = new Set<string>();
    return actions.map((action, index) =>
      this.checkAction(action, join(join(ROOT, 'actions'), index), earlier),
    );
  }

  private checkAction<A extends AutomationAction | AutomationBranchAction>(
    action: A,
    path: string,
    earlier: Set<string>,
  ): A {
    const config = join(path, 'config');
    let checked: AutomationAction | AutomationBranchAction = action;
    switch (action.type) {
      case 'create_record': {
        const table = this.requireWritable(action.config.table_id, join(config, 'table_id'), 'add');
        const fields = this.checkFieldValues(
          action.config.table_id,
          action.config.fields,
          config,
          earlier,
          table,
          'create',
        );
        checked = { ...action, config: { ...action.config, fields } };
        break;
      }
      case 'update_record': {
        const tablePath = join(config, 'table_id');
        const table = this.requireWritable(action.config.table_id, tablePath, null);
        let recordId = action.config.record_id;
        if (recordId === null) {
          if (!this.triggerHasRecord) {
            this.add(join(config, 'record_id'), NO_TRIGGER_RECORD, 'This trigger has no record');
          } else if (table !== undefined && action.config.table_id !== this.triggerTableId) {
            this.add(tablePath, NOT_TRIGGER_TABLE, 'The trigger record is in another table', {
              table_id: this.triggerTableId,
            });
          }
        } else {
          recordId = this.checkValue(recordId, join(config, 'record_id'), earlier);
        }
        const fields = this.checkFieldValues(
          action.config.table_id,
          action.config.fields,
          config,
          earlier,
          table,
          'edit',
        );
        checked = { ...action, config: { ...action.config, record_id: recordId, fields } };
        break;
      }
      case 'update_records': {
        const table = this.requireWritable(action.config.table_id, join(config, 'table_id'), null);
        const filter =
          table === undefined
            ? action.config.filter
            : this.checkValueFilter(
                action.config.filter,
                action.config.table_id,
                join(config, 'filter'),
                earlier,
              );
        const fields = this.checkFieldValues(
          action.config.table_id,
          action.config.fields,
          config,
          earlier,
          table,
          'edit',
        );
        checked = { ...action, config: { ...action.config, filter, fields } };
        break;
      }
      case 'delete_record': {
        if (!this.triggerHasRecord || this.triggerTableId === null) {
          this.add(path, NO_TRIGGER_RECORD, 'This trigger has no record to delete');
        } else {
          this.requireWritable(this.triggerTableId, path, 'delete');
        }
        break;
      }
      case 'find_records': {
        const tableId = action.config.table_id;
        const table = this.requireTable(tableId, join(config, 'table_id'));
        if (table === undefined) break;
        const filter =
          action.config.filter === null
            ? null
            : this.checkFilter(action.config.filter, tableId, join(config, 'filter'));
        action.config.sort.forEach((item, index) => {
          this.requireField(tableId, item.field, join(join(join(config, 'sort'), index), 'field'));
        });
        action.config.fields.forEach((fieldId, index) => {
          this.requireField(tableId, fieldId, join(join(config, 'fields'), index), true);
        });
        this.findSteps.set(action.id, { tableId, fields: action.config.fields });
        checked = { ...action, config: { ...action.config, filter } };
        break;
      }
      case 'send_email':
        checked = { ...action, config: this.checkSendEmail(action.config, config, earlier) };
        break;
      case 'send_notification':
        checked = {
          ...action,
          config: this.checkSendNotification(action.config, config, earlier),
        };
        break;
      case 'send_telegram':
        checked = { ...action, config: this.checkSendTelegram(action.config, config, earlier) };
        break;
      case 'http_request':
        checked = { ...action, config: this.checkHttpRequest(action.config, config, earlier) };
        break;
      case 'run_n8n_workflow':
        checked = { ...action, config: this.checkRunN8nWorkflow(action.config, config, earlier) };
        break;
      case 'delay': {
        const recheck =
          action.config.recheck_condition === null
            ? null
            : this.checkTriggerFilter(
                action.config.recheck_condition,
                join(config, 'recheck_condition'),
              );
        const until =
          action.config.until === null
            ? null
            : this.checkValue(action.config.until, join(config, 'until'), earlier);
        checked = {
          ...action,
          config: { ...action.config, until, recheck_condition: recheck },
        };
        break;
      }
      case 'if': {
        const conditions = action.config.conditions.map((condition, index) => {
          const conditionPath = join(join(config, 'conditions'), index);
          if ('filter' in condition) {
            return {
              filter: this.checkTriggerFilter(condition.filter, join(conditionPath, 'filter')),
            };
          }
          return {
            ...condition,
            value: this.checkValue(condition.value, join(conditionPath, 'value'), earlier),
            compare:
              condition.compare === null
                ? null
                : this.checkValue(condition.compare, join(conditionPath, 'compare'), earlier),
          };
        });
        earlier.add(action.id);
        const branch = (key: 'then' | 'else') =>
          action.config[key].map((item, index) =>
            this.checkAction(item, join(join(config, key), index), earlier),
          );
        const then = branch('then');
        const otherwise = branch('else');
        checked = { ...action, config: { ...action.config, conditions, then, else: otherwise } };
        return checked as A;
      }
    }
    earlier.add(action.id);
    this.rememberRecordStep(checked);
    return checked as A;
  }

  /** A step whose record later templates may reference (`[act_…]`, T505), when readable. */
  private rememberRecordStep(action: AutomationAction | AutomationBranchAction): void {
    const tableId = stepRecordTable(action, this.triggerHasRecord ? this.triggerTableId : null);
    if (tableId !== null && this.readableTable(tableId) !== undefined) {
      this.recordSteps.set(action.id, tableId);
    }
  }

  /**
   * A readable table the action writes: `perm ≥ edit` plus the record
   * operation it needs (`add` to create, `delete` to delete).
   */
  private requireWritable(
    tableId: string,
    path: string,
    operation: 'add' | 'delete' | null,
  ): TableAccess | undefined {
    const table = this.requireTable(tableId, path);
    if (table === undefined) return undefined;
    if (!isWritableTable(table) || (operation !== null && !table.operations.includes(operation))) {
      this.add(path, AUTOMATION_PERMISSION_DENIED, 'You cannot write records of this table', {
        ...(operation === null ? {} : { operation }),
      });
    }
    return table;
  }

  /** Field → value maps: readable fields of the table the person may write. */
  private checkFieldValues(
    tableId: string,
    values: Readonly<Record<string, AutomationValue>>,
    config: string,
    earlier: ReadonlySet<string>,
    table: TableAccess | undefined,
    mode: 'create' | 'edit',
  ): Record<string, AutomationValue> {
    const out: Record<string, AutomationValue> = {};
    for (const [fieldId, value] of Object.entries(values)) {
      const path = join(join(config, 'fields'), fieldId);
      out[fieldId] = this.checkValue(value, path, earlier);
      if (table === undefined) continue;
      const field = this.requireField(tableId, fieldId, path, true);
      if (field === undefined) continue;
      const perm = table.fields[field.id];
      const writable = perm === 'edit' || (mode === 'create' && perm === 'create');
      if (writable) continue;
      if (isComputedType(field.type)) {
        this.add(path, 'FIELD_READ_ONLY', 'This field is computed', { type: field.type });
      } else {
        this.add(path, AUTOMATION_PERMISSION_DENIED, 'You cannot write this field');
      }
    }
    return out;
  }

  // --- send_email (T514) ---------------------------------------------------------

  /**
   * Recipients, Reply-To, subject and body of `send_email` (ADR-32 §3,
   * ADR-33): fields must be readable user/email fields of the trigger
   * record, literal addresses valid, templates checked like other templates
   * (`REGEX*` refused). The sender identity and the footer need the database
   * (`checkSendEmailSenders`).
   */
  private checkSendEmail(
    config: SendEmailConfig,
    path: string,
    earlier: ReadonlySet<string>,
  ): SendEmailConfig {
    const recipients = (key: 'to' | 'cc' | 'bcc') =>
      config[key].map((value, index) =>
        this.checkRecipient(value, join(join(path, key), index), earlier),
      );
    const to = recipients('to');
    const cc = recipients('cc');
    const bcc = recipients('bcc');
    if (config.reply_to !== null) this.checkReplyTo(config.reply_to, join(path, 'reply_to'));
    this.checkAttachments(config, path);
    const sources = (digest: boolean): TemplateSources => ({
      trigger: TRIGGER_REFERENCES[this.triggerType],
      steps: new Map(this.recordSteps),
      ...this.previousSource(),
      ...(digest ? { digest: true } : {}),
    });
    const row = this.triggerHasRecord ? this.triggerTableId : null;
    const subject = this.checkTemplate(
      config.subject.template,
      join(join(path, 'subject'), 'template'),
      row,
      null,
      sources(false),
    );
    const bodyPath = join(path, 'body');
    let digest = config.body.digest;
    if (digest !== null) {
      const value = this.checkValue({ digest }, bodyPath, earlier);
      if ('digest' in value) digest = value.digest;
    }
    const body = this.checkTemplate(
      config.body.template,
      join(bodyPath, 'template'),
      row,
      null,
      sources(digest !== null),
    );
    this.checkBodyImages(config.body.template, join(bodyPath, 'template'));
    return {
      ...config,
      to,
      cc,
      bcc,
      subject: { template: subject },
      body: { ...config.body, template: body, digest },
    };
  }

  /** A recipient value: valid literal addresses, a user/email field, `clicked_by`, a step. */
  private checkRecipient(
    value: EmailRecipientValue,
    path: string,
    earlier: ReadonlySet<string>,
  ): EmailRecipientValue {
    if ('literal' in value) {
      const items = typeof value.literal === 'string' ? [value.literal] : value.literal;
      items.forEach((item, index) => {
        if (normalizeAddress(item) !== null) return;
        const at = join(path, 'literal');
        const itemPath = typeof value.literal === 'string' ? at : join(at, index);
        this.add(itemPath, 'INVALID_EMAIL', 'Not an email address');
      });
      return value;
    }
    if ('trigger' in value && value.trigger !== 'clicked_by') {
      this.add(join(path, 'trigger'), UNSUPPORTED_VALUE_SOURCE, 'Not a person of the trigger', {
        source: 'trigger',
        part: value.trigger,
      });
      return value;
    }
    const checked = this.checkValue(value, path, earlier) as EmailRecipientValue;
    if ('field' in value && this.triggerHasRecord && this.triggerTableId !== null) {
      const field = this.readableField(this.triggerTableId, value.field, true);
      if (field !== undefined && !isRecipientField(field)) {
        this.add(join(path, 'field'), 'INVALID_FIELD_TYPE', 'Not a user or email field', {
          expected: 'user',
          type: field.type,
        });
      }
    }
    return checked;
  }

  /**
   * Attachments (T532): attachment fields of the trigger record, each once,
   * that the person saving (the future `run_as`) reads and may download
   * (`file_download_fields`, SPEC §14.1). A field they cannot read is
   * `UNKNOWN_FIELD` (no existence leak).
   */
  private checkAttachments(config: SendEmailConfig, path: string): void {
    const seen = new Set<string>();
    config.attachments.forEach((item, index) => {
      const at = join(join(join(path, 'attachments'), index), 'field');
      if (!this.triggerHasRecord || this.triggerTableId === null) {
        this.add(at, ATTACHMENT_FIELD_INVALID, 'This trigger has no record with files', {
          reason: 'no_trigger_record',
        });
        return;
      }
      if (seen.has(item.field)) {
        this.add(at, ATTACHMENT_FIELD_INVALID, 'This field is already attached', {
          reason: 'duplicate',
        });
        return;
      }
      seen.add(item.field);
      const field = this.requireField(this.triggerTableId, item.field, at, true);
      if (field === undefined) return;
      if (field.type !== 'attachment') {
        this.add(at, ATTACHMENT_FIELD_INVALID, 'Not an attachment field', { type: field.type });
        return;
      }
      const table = this.readableTable(this.triggerTableId);
      if (table?.file_download_fields.includes(field.id) !== true) {
        this.add(
          at,
          ATTACHMENT_FIELD_NOT_DOWNLOADABLE,
          'You cannot download the files of this field',
        );
      }
    });
  }

  /**
   * Images of the body (T534): only `asset:` (checked with the database,
   * `checkSendEmailImages`) and `field:` — an attachment field of the
   * trigger record that the person saving reads and may download, like
   * attachments; any other image syntax (URL, `data:`, `cid:`) is
   * `IMAGE_SOURCE_NOT_ALLOWED`. Problems point at the template with
   * `params.position` / `params.field_id`.
   */
  private checkBodyImages(template: string, path: string): void {
    for (const issue of imageSyntaxIssues(template, IMAGE_SOURCES)) {
      this.add(path, IMAGE_SOURCE_NOT_ALLOWED, 'Images come from uploads or attachment fields', {
        position: issue.start,
      });
    }
    const fields = new Set(
      collectImages(parseTemplate(template, { images: IMAGE_SOURCES }).blocks)
        .filter((image) => image.source === 'field')
        .map((image) => image.id),
    );
    for (const fieldId of fields) {
      const params = { field_id: fieldId };
      if (!this.triggerHasRecord || this.triggerTableId === null) {
        this.add(path, ATTACHMENT_FIELD_INVALID, 'This trigger has no record with files', {
          ...params,
          reason: 'no_trigger_record',
        });
        continue;
      }
      const field = this.readableField(this.triggerTableId, fieldId, true);
      if (field === undefined) {
        this.add(path, 'UNKNOWN_FIELD', 'Unknown field', params);
        continue;
      }
      if (field.type !== 'attachment') {
        this.add(path, ATTACHMENT_FIELD_INVALID, 'Not an attachment field', {
          ...params,
          type: field.type,
        });
        continue;
      }
      const table = this.readableTable(this.triggerTableId);
      if (table?.file_download_fields.includes(field.id) !== true) {
        this.add(
          path,
          ATTACHMENT_FIELD_NOT_DOWNLOADABLE,
          'You cannot download the files of this field',
          params,
        );
      }
    }
  }

  /** Reply-To: a verified identity (checked with the database) or a Cellhive user. */
  private checkReplyTo(value: EmailReplyTo, path: string): void {
    if ('field' in value) {
      if (!this.triggerHasRecord || this.triggerTableId === null) {
        this.add(path, UNSUPPORTED_VALUE_SOURCE, 'This trigger has no record', { source: 'field' });
        return;
      }
      const field = this.requireField(this.triggerTableId, value.field, join(path, 'field'), true);
      if (field !== undefined && !USER_FIELD_TYPES.has(field.type)) {
        this.add(
          join(path, 'field'),
          EMAIL_REPLY_TO_INVALID,
          'Reply-To must be a verified identity or a Cellhive user',
          { type: field.type },
        );
      }
      return;
    }
    if ('trigger' in value && !TRIGGER_DATA_PARTS[this.triggerType].includes(value.trigger)) {
      this.add(join(path, 'trigger'), UNSUPPORTED_VALUE_SOURCE, 'The trigger has no such data', {
        source: 'trigger',
        part: value.trigger,
      });
    }
  }

  // --- send_telegram (T516) ------------------------------------------------------

  /**
   * Chat and text of `send_telegram`: the chat a literal (checked by the
   * contract), a readable field of the trigger record or an earlier step;
   * the text a template like the body of `send_email` (`{{ [@digest] }}`
   * with a `digest`). The secret and its base scope need the database
   * (`checkSendTelegramSecrets`).
   */
  private checkSendTelegram(
    config: SendTelegramConfig,
    path: string,
    earlier: ReadonlySet<string>,
  ): SendTelegramConfig {
    const chatPath = join(path, 'chat_id');
    const chat =
      'literal' in config.chat_id
        ? config.chat_id
        : (this.checkValue(config.chat_id, chatPath, earlier) as TelegramChatValue);
    const textPath = join(path, 'text');
    let digest = config.text.digest;
    if (digest !== null) {
      const value = this.checkValue({ digest }, textPath, earlier);
      if ('digest' in value) digest = value.digest;
    }
    const template = this.checkTemplate(
      config.text.template,
      join(textPath, 'template'),
      this.triggerHasRecord ? this.triggerTableId : null,
      null,
      {
        trigger: TRIGGER_REFERENCES[this.triggerType],
        steps: new Map(this.recordSteps),
        ...this.previousSource(),
        ...(digest !== null ? { digest: true } : {}),
      },
    );
    return { ...config, chat_id: chat, text: { template, digest } };
  }

  // --- http_request (T606) ------------------------------------------------------

  /**
   * Values, headers and literal URL of `http_request` (ADR-35 §5, §8): every
   * value is checked like any other (fields the saver reads, earlier steps,
   * templates); a literal URL must be one the outbox could ever call
   * (`INVALID_URL`, `params.reason` like `ssrf_blocked` — the address is
   * checked when the request is sent, DNS may change); a header the outbox
   * sets or of the connection, or a name given twice (the auth header
   * included), is `HEADER_NOT_ALLOWED`. Secrets need the database
   * (`checkHttpRequestSecrets`).
   */
  private checkHttpRequest(
    config: HttpRequestConfig,
    path: string,
    earlier: ReadonlySet<string>,
  ): HttpRequestConfig {
    const value = (item: HttpRequestValue, at: string): HttpRequestValue =>
      this.checkValue(item, at, earlier) as HttpRequestValue;
    const urlPath = join(path, 'url');
    if ('literal' in config.url) {
      const literal = config.url.literal;
      let reason: string | null = typeof literal === 'string' ? null : 'invalid_url';
      if (typeof literal === 'string') {
        try {
          parseOutboundUrl(literal);
        } catch (error) {
          if (!isOutboundHttpError(error)) throw error;
          reason =
            typeof error.params['reason'] === 'string' ? error.params['reason'] : 'invalid_url';
        }
      }
      if (reason !== null) {
        this.add(urlPath, INVALID_URL, 'This URL can never be called', { reason });
      }
    }
    const url = value(config.url, urlPath);
    const query = config.query.map((item, index) => ({
      ...item,
      value: value(item.value, join(join(join(path, 'query'), index), 'value')),
    }));
    const seen = new Set<string>();
    const header = (name: string, at: string): void => {
      const lower = name.toLowerCase();
      if (!isAllowedHttpRequestHeader(lower)) {
        this.add(at, HEADER_NOT_ALLOWED, 'Cellhive sets this header itself', {
          name,
          reason: 'reserved',
        });
      } else if (seen.has(lower)) {
        this.add(at, HEADER_NOT_ALLOWED, 'This header is given twice', {
          name,
          reason: 'duplicate',
        });
      }
      seen.add(lower);
    };
    if (config.auth !== null)
      header(config.auth.header_name, join(join(path, 'auth'), 'header_name'));
    const headers = config.headers.map((item, index) => {
      const at = join(join(path, 'headers'), index);
      header(item.name, join(at, 'name'));
      return { ...item, value: value(item.value, join(at, 'value')) };
    });
    const bodyPath = join(path, 'body');
    let body: HttpRequestBody | null = config.body;
    if (body !== null) {
      if (body.type === 'form') {
        body = {
          ...body,
          fields: body.fields.map((item, index) => ({
            ...item,
            value: value(item.value, join(join(join(bodyPath, 'fields'), index), 'value')),
          })),
        };
      } else if (body.type === 'json') {
        body = { ...body, value: value(body.value, join(bodyPath, 'value')) };
      } else {
        body = { ...body, value: this.checkValue(body.value, join(bodyPath, 'value'), earlier) };
      }
    }
    return { ...config, url, query, headers, body };
  }

  // --- run_n8n_workflow (T607) --------------------------------------------------

  /**
   * `run_n8n_workflow`, the preset of `http_request` (SPEC §11.5, §13.3):
   * its URL is checked like the URL of `http_request` (the value, a literal
   * the outbox could ever call — `INVALID_URL`); listed `fields` must be
   * fields of the trigger table the saver reads (`UNKNOWN_FIELD`; locked
   * formulas are readable), and need a trigger with a record
   * (`NO_TRIGGER_RECORD`). The signing secret needs the database
   * (`checkHttpRequestSecrets`).
   */
  private checkRunN8nWorkflow(
    config: RunN8nWorkflowConfig,
    path: string,
    earlier: ReadonlySet<string>,
  ): RunN8nWorkflowConfig {
    const { url } = this.checkHttpRequest(
      {
        method: 'POST',
        url: config.url,
        query: [],
        headers: [],
        auth: null,
        body: null,
        signing_secret_id: config.signing_secret_id,
        fail_on_http_error: true,
      },
      path,
      earlier,
    );
    if (config.fields !== null) {
      const fieldsPath = join(path, 'fields');
      if (!this.triggerHasRecord || this.triggerTableId === null) {
        this.add(fieldsPath, NO_TRIGGER_RECORD, 'This trigger has no record to send fields of');
      } else {
        const tableId = this.triggerTableId;
        config.fields.forEach((fieldId, index) => {
          this.requireField(tableId, fieldId, join(fieldsPath, index), true);
        });
      }
    }
    return { ...config, url };
  }

  // --- send_notification (T515) --------------------------------------------------

  /**
   * Recipients, title, body and linked record of `send_notification`
   * (ADR-32 §1): user fields of the trigger record, earlier steps,
   * `clicked_by`; templates on the trigger record, the trigger data and the
   * records of earlier `create_record`/`update_record` steps only — records
   * read by `find_records` and `digest` are `run_as` data, refused
   * (`UNSUPPORTED_VALUE_SOURCE`, Câu hỏi mở S5 #3). Fixed users and groups
   * need the database (`checkSendNotificationRecipients`).
   */
  private checkSendNotification(
    config: SendNotificationConfig,
    path: string,
    earlier: ReadonlySet<string>,
  ): SendNotificationConfig {
    const recipients = config.recipients.map((value, index) => {
      const at = join(join(path, 'recipients'), index);
      if ('user_ids' in value || 'group_id' in value) return value;
      if ('trigger' in value) {
        if (!TRIGGER_DATA_PARTS[this.triggerType].includes(value.trigger)) {
          this.add(join(at, 'trigger'), UNSUPPORTED_VALUE_SOURCE, 'The trigger has no such data', {
            source: 'trigger',
            part: value.trigger,
          });
        }
        return value;
      }
      const checked = this.checkValue(value, at, earlier) as NotificationRecipientValue;
      if ('field' in value && this.triggerHasRecord && this.triggerTableId !== null) {
        const field = this.readableField(this.triggerTableId, value.field, true);
        if (field !== undefined && !USER_FIELD_TYPES.has(field.type)) {
          this.add(join(at, 'field'), 'INVALID_FIELD_TYPE', 'Not a user field', {
            expected: 'user',
            type: field.type,
          });
        }
      }
      return checked;
    });
    const steps = new Map(
      [...this.recordSteps].filter(([actionId]) => !this.findSteps.has(actionId)),
    );
    const template = (source: string, at: string): string => {
      const { check, errors } = checkAutomationTemplate(
        source,
        automationSnapshot(this.context, this.triggerHasRecord ? this.triggerTableId : null, null, {
          trigger: TRIGGER_REFERENCES[this.triggerType],
          steps,
        }),
        at,
      );
      for (const error of errors) {
        const reference = error.params?.['id'] ?? error.params?.['name'];
        const position = error.params?.['position'];
        if (error.code === 'UNKNOWN_FIELD' && typeof reference === 'string') {
          if (this.findSteps.has(reference)) {
            this.add(at, UNSUPPORTED_VALUE_SOURCE, 'Records found by find_records cannot be used', {
              source: 'step',
              step: reference,
              position,
            });
            continue;
          }
          if (reference === EMAIL_BODY_DIGEST_REFERENCE) {
            this.add(at, UNSUPPORTED_VALUE_SOURCE, 'A notification has no digest', {
              source: 'digest',
              position,
            });
            continue;
          }
        }
        this.errors.push(error);
      }
      return check.stored ?? source;
    };
    const title = template(config.title.template, join(join(path, 'title'), 'template'));
    const body = template(config.body.template, join(join(path, 'body'), 'template'));
    const link = config.link_record;
    if (link !== null && link !== 'trigger') {
      const at = join(join(path, 'link_record'), 'step');
      if (!earlier.has(link.step)) {
        this.add(at, UNKNOWN_STEP, 'No earlier action has this id', { step: link.step });
      } else if (!steps.has(link.step)) {
        this.add(
          at,
          UNSUPPORTED_VALUE_SOURCE,
          'Link the record of create_record or update_record',
          {
            source: 'step',
            step: link.step,
          },
        );
      }
    }
    return { ...config, recipients, title: { template: title }, body: { template: body } };
  }

  // --- Values -------------------------------------------------------------------

  /** The value as stored (templates in canonical stored form); problems recorded. */
  private checkValue(
    value: AutomationValue,
    path: string,
    earlier: ReadonlySet<string>,
  ): AutomationValue {
    if ('field' in value) {
      if (!this.triggerHasRecord || this.triggerTableId === null) {
        this.add(path, UNSUPPORTED_VALUE_SOURCE, 'This trigger has no record', { source: 'field' });
      } else {
        this.requireField(this.triggerTableId, value.field, join(path, 'field'), true);
      }
    } else if ('step' in value) {
      if (!earlier.has(value.step)) {
        this.add(join(path, 'step'), UNKNOWN_STEP, 'No earlier action has this id', {
          step: value.step,
        });
      }
    } else if ('trigger' in value) {
      if (!TRIGGER_DATA_PARTS[this.triggerType].includes(value.trigger)) {
        this.add(join(path, 'trigger'), UNSUPPORTED_VALUE_SOURCE, 'The trigger has no such data', {
          source: 'trigger',
          part: value.trigger,
        });
      }
    } else if ('template' in value) {
      // Formula of the trigger record (none for `schedule`), read as the saver (ADR-25 §3).
      const template = this.checkTemplate(
        value.template,
        join(path, 'template'),
        this.triggerHasRecord ? this.triggerTableId : null,
        null,
        {
          trigger: TRIGGER_REFERENCES[this.triggerType],
          steps: new Map(this.recordSteps),
          ...this.previousSource(),
        },
      );
      return { template };
    } else if ('digest' in value) {
      const stepPath = join(join(path, 'digest'), 'step');
      const step = this.findSteps.get(value.digest.step);
      if (!earlier.has(value.digest.step)) {
        this.add(stepPath, UNKNOWN_STEP, 'No earlier action has this id', {
          step: value.digest.step,
        });
      } else if (step === undefined) {
        this.add(stepPath, UNSUPPORTED_VALUE_SOURCE, 'A digest lists the records of find_records', {
          source: 'digest',
          step: value.digest.step,
        });
      } else {
        // Formula of each found record, limited to the fields the step returns.
        const rowTemplate = this.checkTemplate(
          value.digest.row_template,
          join(join(path, 'digest'), 'row_template'),
          step.tableId,
          stepFieldsOf(this.context, step.tableId, step.fields),
        );
        return { digest: { ...value.digest, row_template: rowTemplate } };
      }
    }
    // `literal`: any JSON.
    return value;
  }

  /** `[@previous]` of a `record.updated` trigger (the record before the change). */
  private previousSource(): { previous?: Id<'tbl'> } {
    return previousSourceOf(this.triggerType, this.triggerHasRecord ? this.triggerTableId : null);
  }

  /** A template checked as the saver; the canonical stored text when valid. */
  private checkTemplate(
    source: string,
    path: string,
    tableId: string | null,
    onlyFields: ReadonlySet<string> | null,
    sources: TemplateSources | null = null,
  ): string {
    const { check, errors } = checkAutomationTemplate(
      source,
      automationSnapshot(this.context, tableId, onlyFields, sources),
      path,
    );
    this.errors.push(...errors);
    return check.stored ?? source;
  }
}

const COMPUTED_TYPES: ReadonlySet<string> = new Set([
  'formula',
  'lookup',
  'auto_number',
  'created_at',
  'updated_at',
  'created_by',
  'updated_by',
]);

/** Fields whose value is Cellhive users (recipients, Reply-To). */
const USER_FIELD_TYPES: ReadonlySet<string> = new Set(['user', 'created_by', 'updated_by']);

/** A recipient field: users, or text with the `email` style. */
function isRecipientField(field: AutomationFieldMeta): boolean {
  if (USER_FIELD_TYPES.has(field.type)) return true;
  if (field.type !== 'text') return false;
  const options = field.options as { style?: { type?: unknown } } | null | undefined;
  return options?.style?.type === 'email';
}

function isComputedType(type: string): boolean {
  return COMPUTED_TYPES.has(type);
}

/** A virtual formula/lookup whose result is a single date (T508: `INVALID_FIELD_TYPE` with `expected: stored`). */
function isVirtualDateField(field: AutomationFieldMeta): boolean {
  if (field.type !== 'formula' && field.type !== 'lookup') return false;
  if (field.compute_mode !== 'virtual') return false;
  const result = computedFilterResultOf(field.result_type);
  return result.resultType === 'datetime' && result.resultIsList !== true;
}
