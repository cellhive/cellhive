import { isComputedRow } from '../../computed/definition/definition.js';
import { loadBaseSchemaRows, type BaseSchemaRows } from '../../computed/definition/schema-rows.js';
import {
  lockedComputedFieldIds,
  strictComputedPermissionsOf,
} from '../../records/computed/read/references.js';

import type { Db } from '../../db/create-db.js';
import type { OrgScope } from '../../db/repository.js';
import type { AutomationValidationContext } from '../definition/validate.js';
import type { EffectiveAccess, Id } from '@cellhive/contracts';

/**
 * The base as one person sees it (BACKLOG T505): tables, fields, their
 * effective access and the computed fields locked for them (T457) — what
 * the definition was checked against when saved (ADR-25 §3), resolved again
 * for `run_as` at run time.
 */
export async function loadAutomationSchema(
  db: Db,
  scope: OrgScope,
  baseId: Id<'bse'>,
  access: EffectiveAccess,
  baseSettings: unknown,
): Promise<AutomationValidationContext> {
  return automationSchemaOf(await loadBaseSchemaRows(db, scope, baseId), access, baseSettings);
}

/**
 * {@link loadAutomationSchema} on rows already read: one read of the base
 * for many people (the `run_as` check of T507).
 */
export function automationSchemaOf(
  rows: BaseSchemaRows,
  access: EffectiveAccess,
  baseSettings: unknown,
): AutomationValidationContext {
  const locked = new Set<string>();
  if (rows.fields.some(isComputedRow)) {
    const readable = {
      table: (tableId: Id<'tbl'>) => access.tables[tableId] !== undefined,
      field: (tableId: Id<'tbl'>, fieldId: Id<'fld'>) =>
        access.tables[tableId]?.fields[fieldId] !== undefined,
    };
    const strict = strictComputedPermissionsOf(baseSettings);
    for (const table of rows.tables) {
      for (const id of lockedComputedFieldIds(rows, table.id, readable, strict)) locked.add(id);
    }
  }
  return { tables: rows.tables, fields: rows.fields, access, lockedFieldIds: locked };
}
