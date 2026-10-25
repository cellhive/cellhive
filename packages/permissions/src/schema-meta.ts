import type { Id } from '@cellhive/contracts';

/**
 * Field types whose values are computed by the system (SPEC §14.1): roles
 * can never grant more than `read` on them.
 */
export const COMPUTED_FIELD_TYPES: ReadonlySet<string> = new Set([
  'formula',
  'lookup',
  // A button holds no value (T517): clicking it is governed by its automation.
  'button',
  'auto_number',
  'created_at',
  'updated_at',
  'created_by',
  'updated_by',
]);

/** Minimal field metadata the permission model needs. */
export interface FieldMeta {
  id: Id<'fld'>;
  /** Field type from SPEC §5.5, e.g. `text`, `select`, `formula`. */
  type: string;
  /** Forces the field to be treated as computed regardless of its type. */
  computed?: boolean;
}

export interface TableMeta {
  id: Id<'tbl'>;
  fields: readonly FieldMeta[];
}

/** The base's schema as seen by the permission model. */
export interface SchemaMeta {
  tables: readonly TableMeta[];
  dashboards?: readonly Id<'dsh'>[];
}

export function isComputedField(field: FieldMeta): boolean {
  return field.computed === true || COMPUTED_FIELD_TYPES.has(field.type);
}
