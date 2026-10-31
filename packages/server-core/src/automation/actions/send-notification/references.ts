import {
  isTemplateReferenceId,
  type AutomationAction,
  type AutomationBranchAction,
  type EffectiveAccess,
  type Id,
} from '@cellhive/contracts';

import { aiSourceFieldIds } from '../../../ai/generation/options.js';
import { checkAutomationTemplate } from '../../values/check.js';
import { automationSnapshot } from '../../values/snapshot.js';

import type { AutomationValidationContext } from '../../definition/validate.js';
import type { TemplateSources } from '../../values/references.js';

/**
 * What the title and body of a `send_notification` step read (BACKLOG
 * T515, ADR-32 §1), whoever reads them: every field a placeholder depends
 * on (same row, or along a link path — the link fields included) and the
 * root records it starts from (the trigger record, the record of an
 * earlier step `[act_…]`). Found by checking the templates against the
 * whole base (every table and field, as if readable), so that a field the
 * `run_as` user cannot read any more still counts: a recipient is only
 * notified when they can read all of them.
 */
export interface NotificationReferences {
  /** Fields by id, with their table. */
  readonly fields: ReadonlyMap<Id<'fld'>, Id<'tbl'>>;
  /** The trigger record is read (a placeholder uses one of its fields). */
  readonly triggerRecord: boolean;
  /** Step records read (`[act_…]`), by action id. */
  readonly steps: ReadonlySet<string>;
}

/** The base with every table and field readable (references only — never used to read data). */
function wholeBase(context: AutomationValidationContext): AutomationValidationContext {
  const tables: Record<string, { fields: Record<string, 'read'> }> = {};
  for (const table of context.tables) tables[table.id] = { fields: {} };
  for (const field of context.fields) {
    const table = tables[field.table_id];
    if (table !== undefined) table.fields[field.id] = 'read';
  }
  return {
    tables: context.tables,
    fields: context.fields,
    access: { ...context.access, tables } as unknown as EffectiveAccess,
  };
}

export function notificationReferences(
  templates: readonly string[],
  context: AutomationValidationContext,
  triggerTableId: Id<'tbl'> | null,
  sources: TemplateSources,
): NotificationReferences {
  const snapshot = automationSnapshot(wholeBase(context), triggerTableId, null, sources);
  const tableOf = new Map(context.fields.map((field) => [field.id as string, field.table_id]));
  const fields = new Map<Id<'fld'>, Id<'tbl'>>();
  const steps = new Set<string>();
  let triggerRecord = false;
  const addField = (id: string): boolean => {
    const tableId = tableOf.get(id);
    if (tableId === undefined) return false;
    fields.set(id as Id<'fld'>, tableId);
    return true;
  };
  for (const template of templates) {
    const { check } = checkAutomationTemplate(template, snapshot, 'template');
    for (const placeholder of check.placeholders) {
      for (const dependency of placeholder.dependencies) {
        const path =
          dependency.kind === 'via_link'
            ? [...dependency.link_path, dependency.field_id]
            : [dependency.field_id];
        const root = path[0];
        if (root === undefined) continue;
        if (isTemplateReferenceId(root)) {
          if (root.startsWith('act_')) steps.add(root);
        } else if (tableOf.get(root) === triggerTableId) {
          triggerRecord = true;
        }
        for (const id of path) {
          if (!isTemplateReferenceId(id)) addField(id);
        }
      }
    }
  }
  return { fields, triggerRecord, steps };
}

/**
 * The text of an `ai_generate_text` step (`[act_…]`, T911) was generated
 * from fields of the trigger record: a recipient of a text that places it
 * must read the trigger record and every field its prompt reads, like
 * fields the text placed itself.
 */
export function withTextStepSources(
  references: NotificationReferences,
  actions: readonly (AutomationAction | AutomationBranchAction)[],
  triggerTableId: Id<'tbl'> | null,
): NotificationReferences {
  const fields = new Map(references.fields);
  let triggerRecord = references.triggerRecord;
  for (const action of actions) {
    if (action.type !== 'ai_generate_text' || !references.steps.has(action.id)) continue;
    if (triggerTableId === null) continue;
    triggerRecord = true;
    for (const id of aiSourceFieldIds(action.config.prompt)) fields.set(id, triggerTableId);
  }
  return { ...references, fields, triggerRecord };
}
