import {
  TEMPLATE_STEP_ACTION_TYPES,
  type AutomationDefinition,
  type AutomationTriggerType,
  type FieldDto,
  type IncomingWebhookSample,
} from '@cellhive/contracts';

import { HTTP_STEP_TYPES, httpStepPaths } from '../actions/http-request/model';
import { pickedResponsePaths } from '../actions/http-request/response-paths';
import { displayPath } from '../triggers/webhook/model';

import { earlierActions, isUnset, type TableId } from './draft';
import { stepPathsOf, templateReference, triggerDataOf, triggerValuePartsOf } from './values';

/**
 * What a value of one action may read (SPEC §11.4, CONTRACTS §21): the
 * trigger record (its table's fields), the trigger data of the trigger type,
 * and the records of the earlier steps. The "+" menu lists it; chips are
 * named from it (names change with the schema: renaming a field renames
 * the chip, a deleted field is `#REF`).
 */
export interface ScopeStep {
  readonly id: string;
  /** "Step 2.1" number. */
  readonly number: string;
  readonly type: string;
  /** Table of the step's record (`create_record`/`update_record`/`find_records`), else `null`. */
  readonly tableId: TableId | null;
  /**
   * (T613) Outputs a whole value may read (`{ step, path }`) when they are not
   * the type's fixed ones: an HTTP step's `status`, `body` and response paths.
   */
  readonly paths?: readonly string[];
}

export interface ValueScope {
  readonly triggerType: AutomationTriggerType;
  /** Table of the trigger record; `null` without one (`schedule`) or not chosen yet. */
  readonly triggerTableId: TableId | null;
  readonly steps: readonly ScopeStep[];
}

/** Table of the trigger record (`form.submitted`: the form's table, given by `formTable`). */
export function triggerTableOf(
  trigger: AutomationDefinition['trigger'],
  formTable: (viewId: string) => TableId | undefined,
): TableId | null {
  if (trigger.type === 'schedule' || trigger.type === 'webhook.received') return null;
  if (trigger.type === 'form.submitted') return formTable(trigger.view_id) ?? null;
  return isUnset(trigger.table_id) ? null : trigger.table_id;
}

const STEP_TYPES: ReadonlySet<string> = new Set(TEMPLATE_STEP_ACTION_TYPES);

/** Table of a step's record, for `[act_…]` references. */
function stepTable(
  action: AutomationDefinition['actions'][number],
  triggerTableId: TableId | null,
): TableId | null {
  if (!STEP_TYPES.has(action.type)) return null;
  if (action.type === 'update_record') {
    return action.config.record_id === null
      ? triggerTableId
      : isUnset(action.config.table_id)
        ? null
        : action.config.table_id;
  }
  if (action.type === 'create_record' || action.type === 'find_records') {
    return isUnset(action.config.table_id) ? null : action.config.table_id;
  }
  return null;
}

/** The scope of the values of action `actionId` (`null`: the trigger and condition, no step). */
export function scopeOf(
  definition: AutomationDefinition,
  actionId: string | null,
  triggerTableId: TableId | null,
  picked: (stepId: string) => readonly string[] = pickedResponsePaths,
): ValueScope {
  const steps =
    actionId === null
      ? []
      : earlierActions(definition, actionId).map(({ action, number }) => ({
          id: action.id,
          number,
          type: action.type,
          tableId: stepTable(action, triggerTableId),
          ...(HTTP_STEP_TYPES.has(action.type)
            ? { paths: httpStepPaths(definition, action.id, picked(action.id)) }
            : {}),
        }));
  return { triggerType: definition.trigger.type, triggerTableId, steps };
}

/** Steps whose record a template may name, for `validate-template` (`steps: [{ id, table_id }]`). */
export function templateSteps(scope: ValueScope): { id: string; table_id: TableId }[] {
  return scope.steps.flatMap((step) =>
    step.tableId === null ? [] : [{ id: step.id, table_id: step.tableId }],
  );
}

/** Color family of a chip (board: field = jade, trigger data = indigo, step output = amber). */
export type ChipTone = 'field' | 'trigger' | 'step' | 'expression' | 'error';

/** How the builder names a chip (the caller translates `label` keys). */
export type ChipName =
  | { readonly tone: 'field'; readonly field: string }
  | { readonly tone: 'trigger'; readonly data: string }
  | { readonly tone: 'trigger'; readonly record: string }
  | { readonly tone: 'trigger'; readonly previous: string }
  /** (T612) Webhook data: `body.customer.email`. */
  | { readonly tone: 'trigger'; readonly webhook: string }
  | {
      readonly tone: 'step';
      readonly number: string;
      readonly field?: string | undefined;
      readonly part?: string | undefined;
    }
  | { readonly tone: 'expression'; readonly expression: string }
  | { readonly tone: 'error'; readonly ref: string };

export interface ScopeNames {
  /** Fields of a table, `undefined` while loading. */
  readonly fieldsOf: (tableId: string) => readonly FieldDto[] | undefined;
  /**
   * (T612) The captured sample of the `webhook.received` trigger's hook: its
   * paths are offered under "Webhook data" (`null`/absent: the whole parts only).
   */
  readonly webhookSample?: IncomingWebhookSample | null | undefined;
}

function fieldName(
  names: ScopeNames,
  tableId: string | null,
  fieldId: string,
): string | null | undefined {
  if (tableId === null) return null;
  const fields = names.fieldsOf(tableId);
  if (fields === undefined) return undefined;
  return fields.find((field) => field.id === fieldId)?.name ?? null;
}

/**
 * The name of a placeholder chip. `display` is the server's names form of an
 * expression (`validate-template`), when the builder cannot name it itself.
 */
export function chipNameOf(
  expression: string,
  scope: ValueScope,
  names: ScopeNames,
  display?: string,
): ChipName {
  const reference = templateReference(expression);
  if (reference === null) return { tone: 'expression', expression: display ?? expression };
  switch (reference.kind) {
    case 'field': {
      const name = fieldName(names, scope.triggerTableId, reference.fieldId);
      if (name === null) return { tone: 'error', ref: reference.fieldId };
      return { tone: 'field', field: name ?? '…' };
    }
    case 'record':
      return { tone: 'trigger', record: reference.ref };
    case 'trigger': {
      const data = reference.ref.slice(1);
      return triggerDataOf(scope.triggerType).includes(data)
        ? { tone: 'trigger', data }
        : { tone: 'error', ref: reference.ref };
    }
    case 'webhook':
      return scope.triggerType === 'webhook.received'
        ? { tone: 'trigger', webhook: displayPath(reference.part, reference.pathText) }
        : { tone: 'error', ref: `@${reference.part}` };
    case 'previous': {
      // `[@previous]`: the trigger record before the change (record.updated, T521b).
      if (scope.triggerType !== 'record.updated') return { tone: 'error', ref: '@previous' };
      const name = fieldName(names, scope.triggerTableId, reference.fieldId);
      if (name === null) return { tone: 'error', ref: reference.fieldId };
      return { tone: 'trigger', previous: name ?? '…' };
    }
    case 'step': {
      const step = scope.steps.find((item) => item.id === reference.step);
      if (step === undefined || step.tableId === null)
        return { tone: 'error', ref: reference.step };
      if (reference.fieldId === null) {
        return { tone: 'step', number: step.number, part: reference.ref ?? 'record' };
      }
      const name = fieldName(names, step.tableId, reference.fieldId);
      if (name === null) return { tone: 'error', ref: reference.fieldId };
      return { tone: 'step', number: step.number, field: name ?? '…' };
    }
  }
}

/** The name of a single-source value (`{ field }`, `{ trigger }`, `{ step, path }`). */
export function sourceNameOf(
  value:
    | { field: string }
    | { trigger: string; path?: string | undefined }
    | { step: string; path?: string | undefined },
  scope: ValueScope,
  names: ScopeNames,
): ChipName {
  if ('field' in value) {
    const name = fieldName(names, scope.triggerTableId, value.field);
    return name === null
      ? { tone: 'error', ref: value.field }
      : { tone: 'field', field: name ?? '…' };
  }
  if ('trigger' in value) {
    if (
      scope.triggerType === 'webhook.received' &&
      (value.trigger === 'body' || value.trigger === 'headers' || value.trigger === 'query')
    ) {
      return { tone: 'trigger', webhook: displayPath(value.trigger, value.path ?? '') };
    }
    return triggerValuePartsOf(scope.triggerType).includes(value.trigger)
      ? { tone: 'trigger', data: value.trigger }
      : { tone: 'error', ref: value.trigger };
  }
  const step = scope.steps.find((item) => item.id === value.step);
  if (step === undefined) return { tone: 'error', ref: value.step };
  const path = value.path ?? '';
  return {
    tone: 'step',
    number: step.number,
    part: stepPathsOf(step.type).includes(path) ? path : path === '' ? 'output' : path,
  };
}
