import { getFieldType } from '@cellhive/field-types';

import type { AutomationFieldMeta } from '../definition/validate.js';

/**
 * Trigger data taken from the event that started a run (SPEC §11.4; T521
 * follow-up): `actor` — the user whose change caused it (`[@actor]`,
 * `{ "trigger": "actor" }`) — and `previous` — the values before the
 * change of the fields in the event's `changes` (`[@previous].[fld_…]`,
 * `record.updated` only). Pure: the run engine reads the event, this shapes
 * what it holds.
 */

/** `actor` of an event (CONTRACTS §8): a user id, else `null` (system, automation, API token…). */
export function eventActorId(actor: {
  readonly type: string;
  readonly id: string | null;
}): string | null {
  return actor.type === 'user' && actor.id !== null && actor.id.startsWith('usr_')
    ? actor.id
    : null;
}

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * One value of `changes[].from` (storage form: option ids, user ids,
 * record ids — CONTRACTS §8) in the form templates read (`cell_format=json`
 * of CONTRACTS §2): options by name through the field type; users and
 * records stay ids (the evaluator names users, follows record ids like
 * link cells). A value the type cannot read is left as stored.
 */
export function previousCell(field: AutomationFieldMeta, stored: unknown): unknown {
  if (stored === null || stored === undefined) return null;
  switch (field.type) {
    case 'user':
    case 'created_by':
    case 'updated_by':
    case 'link':
      return Array.isArray(stored) ? stored : [stored];
    case 'parent':
      return stored;
    default: {
      const definition = getFieldType(field.type as never);
      if (definition === undefined) return stored;
      try {
        const options = definition.optionsSchema.parse(field.options ?? {});
        // Select options are stored as a list of ids (`text[]`); accept one id too.
        const value = field.type === 'select' && !Array.isArray(stored) ? [stored] : stored;
        return definition.fromStorage(value, options) ?? null;
      } catch {
        return stored;
      }
    }
  }
}

/**
 * Values before the change of the fields of `table` in `changes`, by field
 * id; `null` when there is nothing to tell (no `changes`).
 */
export function previousValues(
  changes: unknown,
  fields: readonly AutomationFieldMeta[],
  tableId: string,
): Record<string, unknown> | null {
  if (!isObject(changes)) return null;
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.table_id !== tableId || !Object.hasOwn(changes, field.id)) continue;
    const change = changes[field.id];
    out[field.id] = previousCell(field, isObject(change) ? change['from'] : null);
  }
  return out;
}
