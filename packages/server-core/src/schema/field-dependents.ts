import { filterFieldIds } from '../views/view-config.js';

import type { JsonValue } from '../db/schema.js';
import type { Id } from '@cellhive/contracts';

/**
 * What uses a field and may break when its type changes (CONTRACTS §4.4
 * `dependents`, T403): views whose filter, sort, group, kanban settings or
 * form name the field, and roles whose field rule or record filters of the
 * table name it. Formula/lookup fields and automations join once they
 * exist. Display-only references (hidden fields, column order and widths)
 * do not count.
 */

export interface FieldDependent {
  readonly type: 'field' | 'view' | 'role' | 'automation';
  readonly id: string;
}

function objectOf(value: JsonValue | undefined): Record<string, JsonValue> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
}

function namesField(items: JsonValue | undefined, fieldId: string, key = 'field'): boolean {
  return (
    Array.isArray(items) &&
    items.some((item) => {
      const object = objectOf(item);
      return object !== null && object[key] === fieldId;
    })
  );
}

/** Whether a stored view config uses the field (filter, sort, group, kanban, form). */
export function viewUsesField(config: JsonValue, fieldId: string): boolean {
  const view = objectOf(config);
  if (view === null) return false;
  if (filterFieldIds(view.filter ?? null).has(fieldId)) return true;
  if (namesField(view.sort, fieldId) || namesField(view.group, fieldId)) return true;
  const kanban = objectOf(view.kanban);
  if (kanban !== null) {
    if (kanban.group_field === fieldId || kanban.cover_field === fieldId) return true;
    if (Array.isArray(kanban.card_fields) && kanban.card_fields.includes(fieldId)) return true;
  }
  const form = objectOf(view.form);
  return form !== null && namesField(form.fields, fieldId);
}

/** Whether a role config uses the field of `tableId` (field rule entries, record filters). */
export function roleUsesField(config: JsonValue, tableId: string, fieldId: string): boolean {
  const table = objectOf(objectOf(objectOf(config)?.tables)?.[tableId]);
  if (table === null) return false;
  const fieldRule = objectOf(table.field_rule);
  if (fieldRule !== null) {
    if (objectOf(fieldRule.fields)?.[fieldId] !== undefined) return true;
    for (const key of ['option_edit_fields', 'file_download_fields']) {
      const list = fieldRule[key];
      if (Array.isArray(list) && list.includes(fieldId)) return true;
    }
  }
  const recordRule = objectOf(table.record_rule);
  if (recordRule === null) return false;
  return (
    filterFieldIds(recordRule.edit_filter ?? null).has(fieldId) ||
    filterFieldIds(recordRule.read_filter ?? null).has(fieldId)
  );
}

/** Dependents of `fieldId` among `views` (of its table) and `roles` (of its base). */
export function fieldDependents(
  fieldId: Id<'fld'>,
  tableId: Id<'tbl'>,
  views: readonly { readonly id: string; readonly config: JsonValue }[],
  roles: readonly { readonly id: string; readonly config: JsonValue }[],
): FieldDependent[] {
  return [
    ...views
      .filter((view) => viewUsesField(view.config, fieldId))
      .map((view) => ({ type: 'view' as const, id: view.id })),
    ...roles
      .filter((role) => roleUsesField(role.config, tableId, fieldId))
      .map((role) => ({ type: 'role' as const, id: role.id })),
  ];
}
