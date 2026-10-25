import { sql, type RawBuilder } from 'kysely';

import type { PrincipalType } from './schema.js';
import type { Id } from '@cellhive/contracts';

/** Who is asking, for visibility filters: the user and their groups in the organization. */
export interface PrincipalRef {
  readonly userId: Id<'usr'>;
  readonly groupIds: readonly Id<'grp'>[];
}

/**
 * SQL condition "the row's principal is the user or one of their groups" for
 * tables with `principal_type`/`principal_id` (`workspace_members`,
 * `base_role_members`). `table` is a code constant (table name or alias),
 * never input; the IDs are parameters.
 */
export function principalMatches(table: string, principal: PrincipalRef): RawBuilder<boolean> {
  const pairs: [PrincipalType, string][] = [
    ['user', principal.userId],
    ...principal.groupIds.map((groupId): [PrincipalType, string] => ['group', groupId]),
  ];
  const values = pairs.map(([type, id]) => sql`(${type}, ${id})`);
  return sql<boolean>`(${sql.ref(`${table}.principal_type`)}, ${sql.ref(`${table}.principal_id`)}) in (${sql.join(values)})`;
}
