import {
  AUTOMATION_TRIGGER_TYPES,
  DEFAULT_FIND_RECORDS,
  DEFAULT_UPDATE_RECORDS_LIMIT,
  MAX_AUTOMATION_ACTIONS,
  type AutomationAction,
  type AutomationBranchAction,
  type AutomationDefinition,
  type AutomationTrigger,
  type AutomationTriggerType,
  type Id,
} from '@cellhive/contracts';

import { newHttpRequestConfig, newRunN8nWorkflowConfig } from '../actions/http-request/model';

/**
 * The builder's draft (T521, SPEC §11.8): the definition being edited, as
 * the contract types hold it, with pure operations on its actions. An
 * action is found by its id (`act_…`, unique in the definition, branches
 * included); `if` branches hold every action type but `if` (one level).
 */

export type TableId = `tbl_${string}`;
export type FieldId = `fld_${string}`;
export type ViewId = `viw_${string}`;

/**
 * An id the user has still to choose (a new trigger's table, a date
 * field…): `''`, never saved — the save check names it (`check.ts`).
 */
export const NO_TABLE = '' as TableId;
export const NO_FIELD = '' as FieldId;
export const NO_VIEW = '' as ViewId;
/** No incoming webhook chosen yet (`webhook.received`, T604; picked in the builder, T612). */
export const NO_HOOK = '' as `hok_${string}`;

/**
 * Trigger types the builder and the create dialog offer: all of them since
 * T612 (`webhook.received` with its hook picker and sample listening).
 */
export const BUILDER_TRIGGER_TYPES: readonly AutomationTriggerType[] = AUTOMATION_TRIGGER_TYPES;
/** A `send_telegram` bot still to choose (T516). */
export const NO_SECRET = '' as Id<'sec'>;

export function isUnset(id: string | null | undefined): boolean {
  return id === undefined || id === null || id === '';
}

/** Ids from a `<select>` (the options are ids of that kind, or `''`). */
export const asTableId = (id: string): TableId => id as TableId;
export const asFieldId = (id: string): FieldId => id as FieldId;
export const asViewId = (id: string): ViewId => id as ViewId;

/** Where an action list lives: the top level, or one branch of an `if`. */
export type ListRef =
  | { readonly kind: 'root' }
  | { readonly kind: 'branch'; readonly ifId: string; readonly branch: 'then' | 'else' };

export const ROOT: ListRef = { kind: 'root' };

/** Action types the builder can add now (others are listed as coming soon). */
export type AddableActionType =
  | 'create_record'
  | 'update_record'
  | 'update_records'
  | 'find_records'
  | 'delete_record'
  | 'delay'
  | 'if'
  | 'send_email'
  | 'send_notification'
  | 'send_telegram'
  | 'http_request'
  | 'run_n8n_workflow';

/** Every action type shown in the "add step" menu, in its order (board "S5 · Automation builder"). */
export const ACTION_MENU = [
  'update_record',
  'create_record',
  'find_records',
  'delete_record',
  'if',
  'update_records',
  'delay',
  'send_email',
  'send_notification',
  'send_telegram',
  'http_request',
  'run_n8n_workflow',
] as const;
export type MenuActionType = (typeof ACTION_MENU)[number];

/**
 * Types whose step cannot be added yet, and the task that brings it (none
 * left: `send_email`/`send_notification` came with T522, `send_telegram`
 * with T516, `http_request`/`run_n8n_workflow` with T613). The server answers `unsupported_action` for a type without a
 * handler, so the builder does not offer them.
 */
export const COMING_SOON: Readonly<Partial<Record<MenuActionType, string>>> = {};

export function isAddable(type: MenuActionType): type is AddableActionType {
  return COMING_SOON[type] === undefined;
}

/** Whether the trigger gives the run a record (`schedule`, `webhook.received` do not: SPEC §11.4). */
export function hasTriggerRecord(trigger: Pick<AutomationTrigger, 'type'>): boolean {
  return trigger.type !== 'schedule' && trigger.type !== 'webhook.received';
}

/** Every action with its place, depth first (an `if`, then its `then`, then its `else`). */
export interface PlacedAction {
  readonly action: AutomationAction;
  readonly list: ListRef;
  readonly index: number;
  /** "1", "2", or "2.1" inside a branch (numbered across both branches, board). */
  readonly number: string;
}

export function placedActions(definition: Pick<AutomationDefinition, 'actions'>): PlacedAction[] {
  const out: PlacedAction[] = [];
  definition.actions.forEach((action, index) => {
    const number = String(index + 1);
    out.push({ action, list: ROOT, index, number });
    if (action.type !== 'if') return;
    let inner = 0;
    for (const branch of ['then', 'else'] as const) {
      action.config[branch].forEach((child, childIndex) => {
        inner += 1;
        out.push({
          action: child,
          list: { kind: 'branch', ifId: action.id, branch },
          index: childIndex,
          number: `${number}.${String(inner)}`,
        });
      });
    }
  });
  return out;
}

export function findPlaced(
  definition: Pick<AutomationDefinition, 'actions'>,
  id: string,
): PlacedAction | undefined {
  return placedActions(definition).find((placed) => placed.action.id === id);
}

/** Actions counted against the limit of 20 (branches included, SPEC §11.5). */
export function actionCount(definition: Pick<AutomationDefinition, 'actions'>): number {
  return placedActions(definition).length;
}

export function canAddAction(definition: Pick<AutomationDefinition, 'actions'>): boolean {
  return actionCount(definition) < MAX_AUTOMATION_ACTIONS;
}

/** A new action id: `act_<n>`, one above the highest number in use. */
export function newActionId(definition: Pick<AutomationDefinition, 'actions'>): string {
  let highest = 0;
  for (const { action } of placedActions(definition)) {
    const match = /^act_(\d+)$/u.exec(action.id);
    if (match !== null) highest = Math.max(highest, Number(match[1]));
  }
  return `act_${String(highest + 1)}`;
}

/**
 * Actions whose output an action may use (`{ step }` values, `[act_…]` in
 * templates): those before it, depth first, as the server checks (CONTRACTS
 * §21), without the other branch of its own `if` — those never run together.
 */
export function earlierActions(
  definition: Pick<AutomationDefinition, 'actions'>,
  id: string,
): PlacedAction[] {
  const all = placedActions(definition);
  const index = all.findIndex((placed) => placed.action.id === id);
  if (index === -1) return [];
  const self = all[index];
  return all.slice(0, index).filter((placed) => {
    if (self === undefined || self.list.kind !== 'branch' || placed.list.kind !== 'branch') {
      return true;
    }
    return placed.list.ifId !== self.list.ifId || placed.list.branch === self.list.branch;
  });
}

function mapList(
  actions: readonly AutomationAction[],
  list: ListRef,
  change: (items: AutomationBranchAction[] | AutomationAction[]) => AutomationAction[],
): AutomationAction[] {
  if (list.kind === 'root') return change([...actions]);
  return actions.map((action) => {
    if (action.type !== 'if' || action.id !== list.ifId) return action;
    const branch = change([...action.config[list.branch]]) as AutomationBranchAction[];
    return { ...action, config: { ...action.config, [list.branch]: branch } };
  });
}

/** Inserts `action` at `index` of `list` (an `if` never goes into a branch). */
export function insertAction(
  definition: AutomationDefinition,
  list: ListRef,
  index: number,
  action: AutomationAction,
): AutomationDefinition {
  if (list.kind === 'branch' && action.type === 'if') return definition;
  return {
    ...definition,
    actions: mapList(definition.actions, list, (items) => {
      const next = [...items] as AutomationAction[];
      next.splice(Math.max(0, Math.min(index, next.length)), 0, action);
      return next;
    }),
  };
}

/** Replaces the action with the same id (its place is kept). */
export function replaceAction(
  definition: AutomationDefinition,
  action: AutomationAction,
): AutomationDefinition {
  const placed = findPlaced(definition, action.id);
  if (placed === undefined) return definition;
  return {
    ...definition,
    actions: mapList(definition.actions, placed.list, (items) =>
      items.map((item) => (item.id === action.id ? action : item)),
    ),
  };
}

/** Removes an action (an `if` goes with its branches). */
export function removeAction(definition: AutomationDefinition, id: string): AutomationDefinition {
  const placed = findPlaced(definition, id);
  if (placed === undefined) return definition;
  return {
    ...definition,
    actions: mapList(definition.actions, placed.list, (items) =>
      items.filter((item) => item.id !== id),
    ),
  };
}

/** Moves an action `delta` places within its own list; `null` when it cannot move. */
export function moveAction(
  definition: AutomationDefinition,
  id: string,
  delta: number,
): AutomationDefinition | null {
  const placed = findPlaced(definition, id);
  if (placed === undefined) return null;
  const target = placed.index + delta;
  let length = definition.actions.length;
  if (placed.list.kind === 'branch') {
    const { ifId, branch } = placed.list;
    const owner = definition.actions.find((action) => action.id === ifId);
    length = owner?.type === 'if' ? owner.config[branch].length : 0;
  }
  if (target < 0 || target >= length) return null;
  return {
    ...definition,
    actions: mapList(definition.actions, placed.list, (items) => {
      const next = [...items] as AutomationAction[];
      const [moved] = next.splice(placed.index, 1);
      if (moved !== undefined) next.splice(target, 0, moved);
      return next;
    }),
  };
}

/** Moves the action `id` to the place of `overId` in the same list (drag and drop). */
export function moveActionTo(
  definition: AutomationDefinition,
  id: string,
  overId: string,
): AutomationDefinition | null {
  const from = findPlaced(definition, id);
  const to = findPlaced(definition, overId);
  if (from === undefined || to === undefined || id === overId) return null;
  if (JSON.stringify(from.list) !== JSON.stringify(to.list)) return null;
  return moveAction(definition, id, to.index - from.index);
}

export interface NewActionContext {
  /** Table of the trigger record (`null`: none, e.g. `schedule`). */
  readonly triggerTableId: TableId | null;
  /** A table to start `create_record`/`find_records` with when there is no trigger table. */
  readonly firstTableId: TableId | null;
  /**
   * Sender of a new `send_email` (T522): `null` = the system sender; an
   * identity id when the organization turned the system sender off.
   */
  readonly identityId?: `eid_${string}` | null | undefined;
}

/** A new action of `type` with its defaults (the user completes it in the panel). */
export function newAction(
  type: AddableActionType,
  id: string,
  context: NewActionContext,
): AutomationAction {
  const table = context.triggerTableId ?? context.firstTableId ?? NO_TABLE;
  switch (type) {
    case 'create_record':
      return { id, type, config: { table_id: table, fields: {} } };
    case 'update_record':
      return context.triggerTableId === null
        ? { id, type, config: { table_id: table, record_id: null, fields: {} } }
        : { id, type, config: { table_id: context.triggerTableId, record_id: null, fields: {} } };
    case 'find_records':
      return {
        id,
        type,
        config: {
          table_id: table,
          filter: null,
          sort: [],
          fields: [],
          limit: DEFAULT_FIND_RECORDS,
        },
      };
    case 'update_records':
      return {
        id,
        type,
        config: { table_id: table, filter: {}, fields: {}, limit: DEFAULT_UPDATE_RECORDS_LIMIT },
      };
    case 'delay':
      return { id, type, config: { minutes: 60, until: null, recheck_condition: null } };
    case 'delete_record':
      return { id, type, config: {} };
    case 'send_telegram':
      // Bot, chat and text still to fill: the save check names them (`check.ts`).
      return {
        id,
        type,
        config: {
          secret_id: NO_SECRET,
          chat_id: { literal: '' },
          text: { template: '', digest: null },
        },
      };
    case 'http_request':
      // URL still to fill (the save check names it); POST with an empty JSON body.
      return { id, type, config: newHttpRequestConfig() };
    case 'run_n8n_workflow':
      // URL and signing secret still to fill; every field `run_as` reads.
      return { id, type, config: newRunN8nWorkflowConfig() };
    case 'if':
      return {
        id,
        type,
        config: { match: 'and', conditions: [], on_false: 'else', then: [], else: [] },
      };
    case 'send_email':
      return {
        id,
        type,
        config: {
          identity_id: context.identityId ?? null,
          to: [],
          cc: [],
          bcc: [],
          reply_to: null,
          subject: { template: '' },
          body: { format: 'markdown', template: '', digest: null },
          include_signature: true,
          footer: 'minimal',
          attachments: [],
          on_missing_attachment: 'fail',
        },
      };
    case 'send_notification':
      return {
        id,
        type,
        config: {
          recipients: [],
          title: { template: '' },
          body: { template: '' },
          // A trigger without record (`schedule`) has nothing to link.
          link_record: context.triggerTableId === null ? null : 'trigger',
          skip_actor: false,
        },
      };
  }
}

/** Trigger types that start with a table to choose (all but `form.submitted`, `schedule`, `webhook.received`). */
export function triggerNeedsTable(type: AutomationTriggerType): boolean {
  return type !== 'form.submitted' && type !== 'schedule' && type !== 'webhook.received';
}

/** Default cron of a new `schedule` trigger: every day at 08:00 (organization time zone). */
export const DEFAULT_CRON = '0 8 * * *';

/**
 * A trigger of another type, keeping what carries over (the table). Fields
 * still to choose are empty (`''`, `[]`): the save check names them.
 */
export function switchTrigger(
  current: AutomationTrigger,
  type: AutomationTriggerType,
  fallbackTableId: TableId,
): AutomationTrigger {
  const table = 'table_id' in current ? current.table_id : fallbackTableId;
  const skipBulk = 'skip_bulk' in current ? current.skip_bulk : false;
  switch (type) {
    case 'record.created':
    case 'record.deleted':
      return { type, table_id: table, skip_bulk: skipBulk };
    case 'record.updated':
      return {
        type,
        table_id: table,
        watch_fields: current.type === 'record.updated' ? current.watch_fields : [],
        skip_bulk: skipBulk,
      };
    case 'record.matches':
      return {
        type,
        table_id: table,
        condition: current.type === 'record.matches' ? current.condition : {},
        skip_bulk: skipBulk,
      };
    case 'form.submitted':
      return { type, view_id: NO_VIEW };
    case 'schedule':
      return { type, cron: DEFAULT_CRON, timezone: null };
    case 'record.date_reached':
      return { type, table_id: table, field_id: NO_FIELD, offset_minutes: 0, time_of_day: null };
    case 'button.clicked':
      return {
        type,
        table_id: table,
        field_id: NO_FIELD,
        min_permission: 'edit',
        enabled_when: null,
      };
    case 'webhook.received':
      return {
        type,
        incoming_webhook_id:
          current.type === 'webhook.received' ? current.incoming_webhook_id : NO_HOOK,
      };
  }
}

/** A definition with every key in a stable order, for comparing drafts (`run_as` moves on change). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(
      Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
    );
  });
}

export function sameDefinition(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** Action types that send outside Cellhive: `skip_bulk` is suggested with them (ADR-26 §3). */
const OUTBOUND = new Set(['send_email', 'send_telegram', 'http_request', 'run_n8n_workflow']);

export function hasOutboundAction(definition: Pick<AutomationDefinition, 'actions'>): boolean {
  return placedActions(definition).some(({ action }) => OUTBOUND.has(action.type));
}
