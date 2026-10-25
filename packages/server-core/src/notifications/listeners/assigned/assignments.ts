import { isId, type Id } from '@cellhive/contracts';

import type { JsonValue } from '../../../db/schema.js';

/** One storage-form change of an event (`changes[field]`, CONTRACTS §8). */
export interface StoredChange {
  readonly from: JsonValue;
  readonly to: JsonValue;
}

/**
 * Users of the stored value of a `user` field (`text[]` of user ids, SPEC
 * §5.5): valid user ids only, in value order, without duplicates. Anything
 * else (`null`, a malformed value) holds nobody.
 */
export function storedUsers(value: JsonValue): Id<'usr'>[] {
  if (!Array.isArray(value)) return [];
  const out: Id<'usr'>[] = [];
  for (const item of value) {
    if (typeof item === 'string' && isId('usr', item) && !out.includes(item)) out.push(item);
  }
  return out;
}

/**
 * Users the change **added** to the field (ADR-29 §1, BACKLOG T544): in the
 * value after and not in the value before, in the order of the value after.
 * A new record (`from = null`) adds every user of its value; removing or
 * re-ordering users adds nobody.
 */
export function addedUsers(change: StoredChange): Id<'usr'>[] {
  const before = new Set<string>(storedUsers(change.from));
  return storedUsers(change.to).filter((userId) => !before.has(userId));
}

/**
 * Who a `record.created|updated` event assigns (BACKLOG T544): for each
 * field of `notifyFieldIds` (the `user` fields with `notify_on_assign`, in
 * display order) present in `changes`, the users it added — gathered per
 * user with the fields they were added to, in that order. The user behind
 * the change (`actorUserId`) is left out: nobody is told about their own
 * assignment (including a `current_user` default of the record they create).
 * Users are returned in id order (code units) so the outcome is stable.
 */
export function assignmentsOf(
  changes: Readonly<Record<string, StoredChange>> | undefined,
  notifyFieldIds: readonly Id<'fld'>[],
  actorUserId: Id<'usr'> | null,
): Map<Id<'usr'>, Id<'fld'>[]> {
  const byUser = new Map<Id<'usr'>, Id<'fld'>[]>();
  if (changes === undefined) return byUser;
  for (const fieldId of new Set(notifyFieldIds)) {
    const change = Object.hasOwn(changes, fieldId) ? changes[fieldId] : undefined;
    if (change === undefined) continue;
    for (const userId of addedUsers(change)) {
      if (userId === actorUserId) continue;
      const fields = byUser.get(userId) ?? [];
      fields.push(fieldId);
      byUser.set(userId, fields);
    }
  }
  return new Map([...byUser].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
