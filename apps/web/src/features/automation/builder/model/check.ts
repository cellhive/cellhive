import { automationDefinitionSchema, type AutomationDefinition } from '@cellhive/contracts';

import {
  checkHttpRequest,
  checkRunN8nWorkflow,
  HTTP_CLIENT_ISSUE_CODES,
} from '../actions/http-request/model';

import { isUnset, placedActions } from './draft';
import { locateIssue, type BuilderIssue, type StepKey } from './issues';
import { parseCron, nextRuns, tooFrequent } from './schedule';
import { isEmptyValue } from './values';

/**
 * The check before saving (T521): what the server would refuse for sure
 * and the builder can say better — a table or field still to choose, a
 * condition without its value, a cron that never fires or fires too often —
 * then the contract schema itself. Issues use the paths of the server's
 * `422` (`definition.…`), so both show the same way. The server checks
 * permissions, fields and templates again (CONTRACTS §21).
 */

/** Client-only issue codes (translated by the builder; server codes by `errors:detail`). */
export const CLIENT_ISSUE_CODES = [
  'REQUIRED',
  'NAME_REQUIRED',
  'CONDITION_REQUIRED',
  'CONDITION_INCOMPLETE',
  'CONDITION_INVALID',
  'NO_CONDITIONS',
  'CRON_INVALID',
  'CRON_TOO_FREQUENT',
  'COMING_SOON',
  'INVALID_DEFINITION',
  ...HTTP_CLIENT_ISSUE_CODES,
] as const;
export type ClientIssueCode = (typeof CLIENT_ISSUE_CODES)[number];

/** State of a condition editor (`lib/automation/condition-editor`) the builder keeps by slot. */
export interface ConditionSlotState {
  readonly valid: boolean;
  readonly incomplete: number;
}

export interface CheckContext {
  readonly name: string;
  /** Editors still holding conditions the definition does not have yet (`slot` → state). */
  readonly conditions: ReadonlyMap<string, ConditionSlotState>;
  /** Time zone a `schedule` without its own zone uses (the organization's). */
  readonly orgTimeZone: string;
  readonly now: Date;
}

/** Slots of the condition editors (`conditionSlot(step, path)`), e.g. `act_2:config.filter`. */
export function conditionSlot(step: StepKey, path: string): string {
  return `${step}:${path}`;
}

function issue(
  step: StepKey,
  path: string,
  code: ClientIssueCode,
  params?: Record<string, unknown>,
): BuilderIssue {
  return { step, path, code, ...(params === undefined ? {} : { params }) };
}

function conditionIssue(context: CheckContext, step: StepKey, path: string): BuilderIssue | null {
  const state = context.conditions.get(conditionSlot(step, path));
  if (state === undefined) return null;
  if (state.incomplete > 0)
    return issue(step, path, 'CONDITION_INCOMPLETE', { count: state.incomplete });
  if (!state.valid) return issue(step, path, 'CONDITION_INVALID');
  return null;
}

function isEmptyFilter(filter: unknown): boolean {
  if (filter === null || filter === undefined) return true;
  if (typeof filter !== 'object') return false;
  const record = filter as Record<string, unknown>;
  if (Object.keys(record).length === 0) return true;
  return Array.isArray(record['items']) && record['items'].length === 0;
}

export function checkDraft(
  definition: AutomationDefinition,
  context: CheckContext,
): BuilderIssue[] {
  const issues: BuilderIssue[] = [];
  const push = (item: BuilderIssue | null) => {
    if (item !== null) issues.push(item);
  };
  if (context.name.trim() === '') push(issue('general', 'name', 'NAME_REQUIRED'));

  const trigger = definition.trigger;
  if ('table_id' in trigger && isUnset(trigger.table_id))
    push(issue('trigger', 'table_id', 'REQUIRED'));
  switch (trigger.type) {
    case 'record.updated':
      if (trigger.watch_fields.length === 0) push(issue('trigger', 'watch_fields', 'REQUIRED'));
      break;
    case 'record.matches':
      push(
        conditionIssue(context, 'trigger', 'condition') ??
          (isEmptyFilter(trigger.condition)
            ? issue('trigger', 'condition', 'CONDITION_REQUIRED')
            : null),
      );
      break;
    case 'form.submitted':
      if (isUnset(trigger.view_id)) push(issue('trigger', 'view_id', 'REQUIRED'));
      break;
    case 'schedule': {
      if (parseCron(trigger.cron) === null) {
        push(issue('trigger', 'cron', 'CRON_INVALID'));
        break;
      }
      const runs = nextRuns(trigger.cron, trigger.timezone ?? context.orgTimeZone, context.now, 5);
      if (runs !== null && tooFrequent(runs)) push(issue('trigger', 'cron', 'CRON_TOO_FREQUENT'));
      break;
    }
    case 'record.date_reached':
      if (isUnset(trigger.field_id)) push(issue('trigger', 'field_id', 'REQUIRED'));
      break;
    case 'button.clicked':
      // (T525) The button, and `enabled_when` complete (it may be empty: always enabled).
      if (isUnset(trigger.field_id)) push(issue('trigger', 'field_id', 'REQUIRED'));
      push(conditionIssue(context, 'trigger', 'enabled_when'));
      break;
    case 'webhook.received':
      // (T612) The hook; the server checks it is a live hook of the base (`UNKNOWN_WEBHOOK`).
      if (isUnset(trigger.incoming_webhook_id)) {
        push(issue('trigger', 'incoming_webhook_id', 'REQUIRED'));
      }
      break;
    default:
      break;
  }
  push(conditionIssue(context, 'condition', ''));

  for (const { action } of placedActions(definition)) {
    const step = action.id as StepKey;
    switch (action.type) {
      case 'create_record':
      case 'update_record':
        if (isUnset(action.config.table_id)) push(issue(step, 'config.table_id', 'REQUIRED'));
        for (const [fieldId, value] of Object.entries(action.config.fields)) {
          if ((value as unknown) === undefined)
            push(issue(step, `config.fields.${fieldId}`, 'REQUIRED'));
        }
        break;
      case 'find_records':
        if (isUnset(action.config.table_id)) push(issue(step, 'config.table_id', 'REQUIRED'));
        push(conditionIssue(context, step, 'config.filter'));
        break;
      case 'if':
        if (action.config.conditions.length === 0) {
          push(issue(step, 'config.conditions', 'NO_CONDITIONS'));
        }
        action.config.conditions.forEach((condition, index) => {
          if (!('filter' in condition)) return;
          const path = `config.conditions[${String(index)}].filter`;
          push(
            conditionIssue(context, step, path) ??
              (isEmptyFilter(condition.filter) ? issue(step, path, 'CONDITION_REQUIRED') : null),
          );
        });
        break;
      case 'update_records':
        if (isUnset(action.config.table_id)) push(issue(step, 'config.table_id', 'REQUIRED'));
        push(
          conditionIssue(context, step, 'config.filter') ??
            (isEmptyFilter(action.config.filter)
              ? issue(step, 'config.filter', 'CONDITION_REQUIRED')
              : null),
        );
        for (const [fieldId, value] of Object.entries(action.config.fields)) {
          if ((value as unknown) === undefined) {
            push(issue(step, `config.fields.${fieldId}`, 'REQUIRED'));
          }
        }
        break;
      case 'delay':
        if (action.config.minutes === null) {
          if (action.config.until === null) push(issue(step, 'config.minutes', 'REQUIRED'));
          else if (isEmptyValue(action.config.until)) {
            push(issue(step, 'config.until', 'REQUIRED'));
          }
        }
        if (action.config.recheck_condition !== null) {
          push(
            conditionIssue(context, step, 'config.recheck_condition') ??
              (isEmptyFilter(action.config.recheck_condition)
                ? issue(step, 'config.recheck_condition', 'CONDITION_REQUIRED')
                : null),
          );
        }
        break;
      case 'send_email':
        // (T522) The contract wants one recipient and a subject; the server checks the rest.
        if (action.config.to.length === 0) push(issue(step, 'config.to', 'REQUIRED'));
        if (action.config.subject.template.trim() === '') {
          push(issue(step, 'config.subject.template', 'REQUIRED'));
        }
        break;
      case 'send_notification':
        if (action.config.recipients.length === 0) {
          push(issue(step, 'config.recipients', 'REQUIRED'));
        }
        if (action.config.title.template.trim() === '') {
          push(issue(step, 'config.title.template', 'REQUIRED'));
        }
        break;
      case 'send_telegram': {
        if (isUnset(action.config.secret_id)) push(issue(step, 'config.secret_id', 'REQUIRED'));
        const chat = action.config.chat_id;
        if ('literal' in chat && String(chat.literal).trim() === '') {
          push(issue(step, 'config.chat_id', 'REQUIRED'));
        }
        if (action.config.text.template.trim() === '') {
          push(issue(step, 'config.text.template', 'REQUIRED'));
        }
        break;
      }
      case 'http_request':
        // (T613) URL, header names, auth, JSON body (CONTRACTS §21).
        issues.push(...checkHttpRequest(step, action.config));
        break;
      case 'run_n8n_workflow':
        issues.push(...checkRunN8nWorkflow(step, action.config));
        break;
      default:
        break;
    }
  }
  if (issues.length > 0) return issues;

  // The contract itself (ids, bounds): anything left is a builder bug, said plainly.
  const parsed = automationDefinitionSchema.safeParse(definition);
  if (parsed.success) return [];
  return parsed.error.issues.map((item) => {
    const located = locateIssue(
      definition,
      item.path
        .map((part) => (typeof part === 'number' ? `[${String(part)}]` : String(part)))
        .join('.')
        .replace(/\.\[/gu, '['),
    );
    return { ...located, code: 'INVALID_DEFINITION', message: item.message };
  });
}
