/**
 * (T713) The record rule editor the role editor (`features/base-settings`)
 * gets from the route (FRONTEND §1.2): the view filter builder of T311
 * (`features/view/toolbar`) over every field of a table, with the
 * `current_user` / `current_user_groups` variables on user fields and link
 * fields by the id of linked records (T710). One filter DSL (ADR-09).
 */

import type { ComponentType } from 'react';

/** State of the conditions being edited, given with every change. */
export interface RuleFilterState {
  /** The DSL of the complete conditions; `null` = no condition. */
  readonly filter: Readonly<Record<string, unknown>> | null;
  /** Whether the complete conditions pass the client check (the server checks again). */
  readonly valid: boolean;
  /** Conditions still missing a value (left out of `filter`). */
  readonly incomplete: number;
}

export interface RuleFilterEditorProps {
  /** Table whose records the rule tests (an admin reads every field of it). */
  readonly tableId: string;
  /** Organization of the base (user pickers). */
  readonly orgId: string;
  /** Conditions to start from (read once: give the editor a new `key` to start over). */
  readonly value: Readonly<Record<string, unknown>> | null;
  readonly onChange: (state: RuleFilterState) => void;
  /** Name of the root group ("Records where"). */
  readonly label: string;
  /** Text when there is no condition. */
  readonly emptyText: string;
}

export type RuleFilterEditorComponent = ComponentType<RuleFilterEditorProps>;
