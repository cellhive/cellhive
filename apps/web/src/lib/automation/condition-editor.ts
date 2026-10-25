/**
 * The condition editor the automation builder (T521, `features/automation`)
 * gets from the route (FRONTEND §1.2): the view filter builder of T311
 * (`features/view/toolbar`) in automation mode — `changed`, `changed_to`,
 * `changed_from` for a `record.updated` trigger (SPEC §11.3).
 */

import { automationValueSchema } from '@cellhive/contracts';

import type { FieldDto } from '@cellhive/contracts';
import type { ComponentType } from 'react';

/**
 * Whether a condition value is a value of SPEC §11.4 (`{ "field" }`,
 * `{ "step" }`, `{ "template" }`…) — the filter of `update_records` takes
 * them (T506), resolved when the step runs. No DSL operand looks like one.
 */
export function isAutomationValue(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    automationValueSchema.safeParse(value).success
  );
}

/** Props of the "value from the automation" control of a condition (T521b). */
export interface ConditionValueSourceProps {
  readonly field: FieldDto;
  /** The condition's value: a value of SPEC §11.4, or a constant (then only "+" shows). */
  readonly value: unknown;
  readonly onChange: (value: unknown) => void;
  readonly label: string;
}

/** State of the conditions being edited, given with every change. */
export interface ConditionEditorState {
  /** The DSL of the complete conditions; `null` = no condition. */
  readonly filter: Readonly<Record<string, unknown>> | null;
  /** Whether the complete conditions pass the client check (the server checks again). */
  readonly valid: boolean;
  /** Conditions still missing a value (left out of `filter`). */
  readonly incomplete: number;
}

/** An `errors[]` item of `422 AUTOMATION_INVALID` under this filter (`path` relative to it). */
export interface ConditionIssue {
  readonly path: string;
  readonly code: string;
}

export interface AutomationConditionEditorProps {
  /** Table whose records the conditions test. */
  readonly tableId: string;
  /** Organization of the base (user pickers). */
  readonly orgId: string;
  /** Conditions to start from (read once: give the editor a new `key` to start over). */
  readonly value: Readonly<Record<string, unknown>> | null;
  readonly onChange: (state: ConditionEditorState) => void;
  /** Offer `changed` / `changed_to` / `changed_from` (a `record.updated` trigger). */
  readonly changeOperators?: boolean | undefined;
  /** Fields not offered at all (virtual computed fields of trigger conditions). */
  readonly excludeFields?: ReadonlySet<string> | undefined;
  /** Server issues of the last save, `path` relative to this filter (`items[0].field`). */
  readonly issues?: readonly ConditionIssue[] | undefined;
  /** Name of the root group ("Run only if"). */
  readonly label: string;
  /** Text when there is no condition. */
  readonly emptyText: string;
  /** Nested groups (default: one level, board "S5 · Automation builder"). */
  readonly nested?: boolean | undefined;
  /**
   * Values from the automation in conditions (`update_records`, T506): a "+"
   * next to each value, and a chip instead of the editor for such a value.
   */
  readonly ValueSource?: ComponentType<ConditionValueSourceProps> | undefined;
}
