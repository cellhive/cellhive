import {
  automationDefinitionSchema,
  type AutomationDefinition,
  type AutomationTrigger,
  type Id,
} from '@cellhive/contracts';

import { changeConditionsOf, foldChangeConditions } from '../../dispatch/condition.js';

import type { AutomationRow } from '../../../db/schema.js';
import type { FilterNode } from '@cellhive/filter-dsl';

/** The `button.clicked` trigger (ADR-32 §2, BACKLOG T517). */
export type ButtonClickedTrigger = Extract<AutomationTrigger, { type: 'button.clicked' }>;

/** A stored automation attached to a button, its definition parsed. */
export interface ButtonAutomation {
  readonly row: AutomationRow;
  readonly definition: AutomationDefinition;
  readonly trigger: ButtonClickedTrigger;
}

/**
 * The automation of `row` when it is a `button.clicked` automation on
 * `fieldId` of `tableId` whose stored definition still parses; `null`
 * otherwise (the button then reads as if its automation were off).
 */
export function buttonAutomationOf(
  row: AutomationRow,
  tableId: Id<'tbl'>,
  fieldId: Id<'fld'>,
): ButtonAutomation | null {
  const parsed = automationDefinitionSchema.safeParse(row.definition);
  if (!parsed.success) return null;
  const trigger = parsed.data.trigger;
  if (trigger.type !== 'button.clicked') return null;
  if (trigger.table_id !== tableId || trigger.field_id !== fieldId) return null;
  return { row, definition: parsed.data, trigger };
}

/**
 * What a record must match, as `run_as`, for the button to be clickable:
 * `enabled_when` AND the automation's `condition` (SPEC §11.3) — a click is
 * no change, so its `changed*` conditions are false. `true` (always), `false`
 * (never) or a Filter DSL tree with field ids and standard operators only.
 */
export function buttonGateOf(
  automation: Pick<ButtonAutomation, 'definition'>,
): boolean | FilterNode {
  const parts: FilterNode[] = [];
  const { trigger, condition } = automation.definition;
  if (trigger.type === 'button.clicked' && trigger.enabled_when !== null) {
    parts.push(trigger.enabled_when as unknown as FilterNode);
  }
  if (condition !== null) {
    const node = condition as unknown as FilterNode;
    if (changeConditionsOf(node).length === 0) {
      parts.push(node);
    } else {
      const folded = foldChangeConditions(node, () => false);
      if (folded.kind === 'constant') {
        if (!folded.value) return false;
      } else {
        parts.push(folded.filter);
      }
    }
  }
  if (parts.length === 0) return true;
  const [only] = parts;
  if (parts.length === 1 && only !== undefined) return only;
  return { op: 'and', items: parts };
}
