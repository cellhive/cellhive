import { createHash } from 'node:crypto';

import type { MemberBaseAccess } from '../../../import/member-access.js';

/**
 * The permission profile of a recipient of `send_notification` (BACKLOG
 * T515, ADR-32 §1): recipients with the same key see the same records,
 * fields and computed values, so the text is rendered once per key, with
 * the access of one of them. The key is
 *
 * - the base's `permission_version` (every role or assignment change bumps it);
 * - the effective access (tables, fields, operations — the result of the
 *   roles the person holds, directly or through groups and workspaces);
 * - the record rules that decide what they read (`readFilters`, which also
 *   scope lookups and link titles — P20, P35);
 * - and, only when a read rule names `current_user`/`current_user_groups`,
 *   the user and the members of their groups (the rule then reads
 *   differently for each person).
 */
export function permissionProfileKey(
  access: MemberBaseAccess,
  permissionVersion: string | number | bigint,
): string {
  const { resolved, relatedAccess, userId, groupMemberUserIds } = access.record;
  const read = canonicalJson(resolved.internal.readFilters);
  const related =
    relatedAccess === undefined
      ? null
      : canonicalJson({
          access: relatedAccess.access,
          read: relatedAccess.internal.readFilters,
        });
  const personal =
    read.includes('"current_user') || (related?.includes('"current_user') ?? false)
      ? { user: userId, groups: [...groupMemberUserIds].sort() }
      : null;
  return createHash('sha256')
    .update(
      canonicalJson({
        version: String(permissionVersion),
        access: resolved.access,
        read,
        related,
        personal,
      }),
    )
    .digest('base64url');
}

/** JSON with object keys sorted at every level (same value → same text). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return item;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(item).sort()) {
      sorted[key] = (item as Record<string, unknown>)[key];
    }
    return sorted;
  });
}
