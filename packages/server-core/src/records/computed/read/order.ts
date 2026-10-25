import { sql, type RawBuilder } from 'kysely';

import type { ComputedField } from './computed-fields.js';
import type { Id } from '@cellhive/contracts';

/**
 * Sort and group keys of formula/lookup fields (BACKLOG T457, CONTRACTS
 * §1.4): the value of a scalar result (texts under the collation of the
 * value), the first element of a list, members by name like user cells.
 * Records and attachments never order (`sortKind = null`, like links).
 * `value` is the field's value in the statement (its expression, or the
 * column an inner query exposes it as).
 */
export function computedSortKey(
  field: ComputedField,
  value: RawBuilder<unknown>,
  organizationId: Id<'org'>,
): RawBuilder<unknown> {
  const memberName = (userId: RawBuilder<unknown>) =>
    sql`(SELECT u.display_name FROM meta.users AS u JOIN meta.org_members AS m ON m.user_id = u.id WHERE m.organization_id = ${organizationId} AND u.id = ${userId})`;
  switch (field.sortKind) {
    case 'first':
      return sql`(${value})[1]`;
    case 'user':
      return memberName(value);
    case 'first_user':
      return memberName(sql`(${value})[1]`);
    default:
      return value;
  }
}

/** Whether rows with different values may share a sort key (the group adds the value as a key). */
export function computedSortKeyMayTie(field: ComputedField): boolean {
  return field.sortKind !== 'value';
}

/** Name an inner query exposes a computed value under (`records/group-counts`). Code only. */
export function computedColumnAlias(field: ComputedField): string {
  return `cf_${field.id}`;
}
