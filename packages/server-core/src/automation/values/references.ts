import {
  EMAIL_BODY_DIGEST_REFERENCE,
  TEMPLATE_PREVIOUS_REFERENCE,
  TEMPLATE_STEP_ACTION_TYPES,
  TEMPLATE_TEXT_STEP_ACTION_TYPES,
  type AutomationAction,
  type AutomationBranchAction,
  type AutomationDefinition,
  type AutomationTrigger,
  type Id,
  type TemplateTriggerReference,
} from '@cellhive/contracts';

import type { SnapshotField } from '@cellhive/formula-engine';

/**
 * Trigger data and step records in templates (BACKLOG T505, SPEC §11.4):
 * virtual fields of the automation snapshot, referenced by ID like fields
 * (`isTemplateReferenceId`), so they are typechecked when saved (the step
 * must come earlier; the fields of its record must be readable by the
 * saver) and resolved by the evaluator at run time as `run_as`.
 */

/** `[@id]` / `[@url]` of every record. */
export const RECORD_ID_REFERENCE = '@id';
export const RECORD_URL_REFERENCE = '@url';

/** The trigger references each trigger type provides (SPEC §11.4). */
export const TRIGGER_REFERENCES: Readonly<
  Record<AutomationTrigger['type'], readonly TemplateTriggerReference[]>
> = {
  'record.created': ['@fired_at', '@actor'],
  'record.updated': ['@fired_at', '@actor'],
  'record.deleted': ['@fired_at', '@actor'],
  'record.matches': ['@fired_at', '@actor'],
  'form.submitted': ['@fired_at', '@actor'],
  schedule: ['@fired_at'],
  'record.date_reached': ['@fired_at', '@due_at'],
  'button.clicked': ['@fired_at', '@clicked_by', '@clicked_at'],
  // T604: the whole parts; `[@body.<path>]`… are added per template (`webhook-data.ts`).
  'webhook.received': ['@fired_at', '@body', '@headers', '@query'],
};

/** Field type of each trigger reference (formula type through `fieldValueType`). */
const TRIGGER_REFERENCE_TYPES: Readonly<Record<TemplateTriggerReference, string>> = {
  '@fired_at': 'datetime',
  '@due_at': 'datetime',
  '@clicked_by': 'user',
  '@clicked_at': 'datetime',
  '@actor': 'user',
  // JSON text of the whole part (T604).
  '@body': 'text',
  '@headers': 'text',
  '@query': 'text',
};

/** Trigger data key behind each reference (`run.input.trigger` / the evaluator's `trigger.data`). */
export const TRIGGER_REFERENCE_DATA: Readonly<Record<TemplateTriggerReference, string>> = {
  '@fired_at': 'fired_at',
  '@due_at': 'due_at',
  '@clicked_by': 'clicked_by',
  '@clicked_at': 'clicked_at',
  '@actor': 'actor',
  '@body': 'body',
  '@headers': 'headers',
  '@query': 'query',
};

/**
 * Id of the "record before the change" a `[@previous]` cell links to: not a
 * record of the table, the evaluator builds it from the event (T521 follow-up).
 */
export const PREVIOUS_RECORD_ID = TEMPLATE_PREVIOUS_REFERENCE;

/** What a template may reference besides record fields. */
export interface TemplateSources {
  readonly trigger: readonly TemplateTriggerReference[];
  /** Earlier steps with a record, by action id → table of that record. */
  readonly steps: ReadonlyMap<string, Id<'tbl'>>;
  /** Earlier steps whose output is a text (`ai_generate_text`, T911): `[act_…]` is that text. */
  readonly texts?: ReadonlySet<string>;
  /**
   * The body of a `send_email` step with a `digest` (T514): `[@digest]`, a
   * text holding the digest lines.
   */
  readonly digest?: boolean;
  /**
   * `[@previous]` (`record.updated`): a single-record link to the trigger
   * table whose record is the trigger record before the change.
   */
  readonly previous?: Id<'tbl'>;
}

/** The table `[@previous]` links to: the trigger table of a `record.updated` trigger. */
export function previousSourceOf(
  triggerType: AutomationTrigger['type'] | null,
  triggerTableId: Id<'tbl'> | null,
): { previous?: Id<'tbl'> } {
  return triggerType === 'record.updated' && triggerTableId !== null
    ? { previous: triggerTableId }
    : {};
}

export const NO_TEMPLATE_SOURCES: TemplateSources = { trigger: [], steps: new Map() };

/** `@id` / `@url` fields added to every table of an automation snapshot. */
export function recordReferenceFields(): SnapshotField[] {
  return [
    { id: RECORD_ID_REFERENCE, name: RECORD_ID_REFERENCE, type: 'text' },
    { id: RECORD_URL_REFERENCE, name: RECORD_URL_REFERENCE, type: 'text' },
  ];
}

/** Trigger and step fields of the row a template runs on. */
export function sourceFields(sources: TemplateSources): SnapshotField[] {
  const fields: SnapshotField[] = sources.trigger.map((id) => ({
    id,
    name: id,
    type: TRIGGER_REFERENCE_TYPES[id],
  }));
  for (const [actionId, tableId] of sources.steps) {
    fields.push({ id: actionId, name: actionId, type: 'link', linkTableId: tableId, single: true });
  }
  for (const actionId of sources.texts ?? []) {
    fields.push({ id: actionId, name: actionId, type: 'text' });
  }
  if (sources.previous !== undefined) {
    fields.push({
      id: TEMPLATE_PREVIOUS_REFERENCE,
      name: TEMPLATE_PREVIOUS_REFERENCE,
      type: 'link',
      linkTableId: sources.previous,
      single: true,
    });
  }
  if (sources.digest === true) {
    fields.push({
      id: EMAIL_BODY_DIGEST_REFERENCE,
      name: EMAIL_BODY_DIGEST_REFERENCE,
      type: 'text',
    });
  }
  return fields;
}

/** Table of the record a step produces, or `null` for an action without one. */
export function stepRecordTable(
  action: AutomationAction | AutomationBranchAction,
  triggerTableId: Id<'tbl'> | null,
): Id<'tbl'> | null {
  if (!(TEMPLATE_STEP_ACTION_TYPES as readonly string[]).includes(action.type)) return null;
  switch (action.type) {
    case 'create_record':
    case 'find_records':
      return action.config.table_id;
    case 'update_record':
      return action.config.record_id === null ? triggerTableId : action.config.table_id;
    default:
      return null;
  }
}

/** Whether a step's output is a text later templates place as `[act_…]` (T911). */
export function isTextStep(action: AutomationAction | AutomationBranchAction): boolean {
  return (TEMPLATE_TEXT_STEP_ACTION_TYPES as readonly string[]).includes(action.type);
}

/** Every record and text step of a definition (what the run-time snapshot offers). */
export function definitionSources(
  definition: AutomationDefinition,
  actions: readonly (AutomationAction | AutomationBranchAction)[],
  triggerTableId: Id<'tbl'> | null,
): TemplateSources {
  const steps = new Map<string, Id<'tbl'>>();
  const texts = new Set<string>();
  for (const action of actions) {
    const tableId = stepRecordTable(action, triggerTableId);
    if (tableId !== null) steps.set(action.id, tableId);
    if (isTextStep(action)) texts.add(action.id);
  }
  return {
    trigger: TRIGGER_REFERENCES[definition.trigger.type],
    steps,
    texts,
    ...previousSourceOf(definition.trigger.type, triggerTableId),
  };
}

/** The text a text step's output stands for in templates (`text` of `ai_generate_text`). */
export function stepText(output: unknown): string | null {
  if (typeof output !== 'object' || output === null || Array.isArray(output)) return null;
  const text = (output as Readonly<Record<string, unknown>>)['text'];
  return typeof text === 'string' ? text : null;
}

/**
 * The record id a step output stands for in templates: `{ id }` of
 * `create_record`/`update_record`, the first of `find_records` `records`.
 */
export function stepRecordId(output: unknown): string | null {
  if (typeof output !== 'object' || output === null || Array.isArray(output)) return null;
  const record = output as Readonly<Record<string, unknown>>;
  if (typeof record['id'] === 'string') return record['id'];
  const records = record['records'];
  if (Array.isArray(records)) {
    const first = records[0] as unknown;
    if (typeof first === 'object' && first !== null && 'id' in first) {
      const id = first.id;
      return typeof id === 'string' ? id : null;
    }
  }
  return null;
}
