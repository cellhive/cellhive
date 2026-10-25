import { Buffer } from 'node:buffer';

import { isId, type Id } from '@cellhive/contracts';
import {
  TenantRepository,
  type Db,
  type OrgScope,
  type TenantRepositoryContract,
} from '@cellhive/server-core';
import { AppError } from '@cellhive/server-core/errors';
import { sql } from 'kysely';

/** A user or group a base admin can give a role to. */
export interface PrincipalRow {
  readonly principal_type: 'user' | 'group';
  readonly principal_id: Id<'usr'> | Id<'grp'>;
  readonly name: string;
  readonly email: string | null;
  readonly role_id: Id<'rol'> | null;
  /**
   * (T713) Why the principal has full access to the base whatever its role
   * there (SPEC §14.1 step 1): organization owner/admin, base owner,
   * workspace admin (directly or through a group); `null` otherwise.
   */
  readonly full_access: FullAccessKind | null;
}

export type FullAccessKind = 'org_admin' | 'base_owner' | 'workspace_admin';

/** Position in the list: `(lower(name), principal_type, principal_id)`. */
export interface PrincipalCursor {
  readonly key: string;
  readonly type: 'user' | 'group';
  readonly id: string;
}

const MAX_CURSOR_LENGTH = 1000;

function invalidCursor(): AppError {
  return new AppError('VALIDATION_FAILED', {
    detail: 'The cursor is invalid.',
    errors: [{ path: 'cursor', code: 'INVALID_FORMAT', message: 'Invalid cursor' }],
  });
}

export function encodePrincipalCursor(cursor: PrincipalCursor): string {
  return Buffer.from(JSON.stringify([cursor.key, cursor.type, cursor.id]), 'utf8').toString(
    'base64url',
  );
}

/** The cursor of a request (`undefined` = first page); malformed → `422 VALIDATION_FAILED`. */
export function decodePrincipalCursor(value: string | undefined): PrincipalCursor | null {
  if (value === undefined) return null;
  if (value.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalidCursor();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) throw invalidCursor();
  const [key, type, id] = parsed as unknown[];
  if (
    typeof key !== 'string' ||
    (type !== 'user' && type !== 'group') ||
    !(type === 'user' ? isId('usr', id) : isId('grp', id))
  ) {
    throw invalidCursor();
  }
  return { key, type, id: id as string };
}

/**
 * Principals of one organization for the role picker of a base (BACKLOG
 * T711): its active members and its groups, each with its role in the base.
 * Every query is scoped by `organization_id` (users join through
 * `meta.org_members`, so a user who left the organization is not listed).
 */
export class MemberAccessRepository
  extends TenantRepository<'org_members'>
  implements TenantRepositoryContract<MemberAccessRepository>
{
  constructor(db: Db) {
    super(db, 'org_members');
  }

  /**
   * One page by `(lower(name), principal_type, principal_id)`, after
   * `cursor`, at most `limit + 1` rows (the caller cuts the page). `search`
   * is a case-insensitive substring of a user's display name or email or of
   * a group's name. `full_access` (T713) names why a principal has full
   * access whatever its role (a group: workspace admin, which every member
   * inherits).
   */
  async listPrincipals(
    scope: OrgScope,
    baseId: Id<'bse'>,
    options: { search: string | null; cursor: PrincipalCursor | null; limit: number },
  ): Promise<(PrincipalRow & { readonly sort_key: string })[]> {
    const organizationId = scope.organizationId;
    const needle = options.search === null ? null : options.search.toLowerCase();
    const cursor = options.cursor;
    const { rows } = await sql<PrincipalRow & { sort_key: string }>`
      WITH base AS (
        SELECT b.owner_id, b.workspace_id
          FROM meta.bases b
         WHERE b.organization_id = ${organizationId} AND b.id = ${baseId}
      ),
      workspace_admins AS (
        SELECT w.principal_type, w.principal_id
          FROM meta.workspace_members w
          JOIN base ON base.workspace_id = w.workspace_id
         WHERE w.organization_id = ${organizationId} AND w.role = 'admin'
      )
      SELECT p.principal_type, p.principal_id, p.name, p.email, p.sort_key, a.role_id,
             p.full_access
        FROM (
          SELECT 'user'::text AS principal_type, u.id AS principal_id, u.display_name AS name,
                 u.email AS email, lower(u.display_name) AS sort_key,
                 CASE
                   WHEN m.role IN ('owner', 'admin') THEN 'org_admin'
                   WHEN u.id = (SELECT owner_id FROM base) THEN 'base_owner'
                   WHEN EXISTS (
                     SELECT 1 FROM workspace_admins w
                      WHERE (w.principal_type = 'user' AND w.principal_id = u.id)
                         OR (w.principal_type = 'group' AND w.principal_id IN (
                               SELECT gm.group_id FROM meta.group_members gm
                                WHERE gm.organization_id = ${organizationId}
                                  AND gm.user_id = u.id))
                   ) THEN 'workspace_admin'
                 END AS full_access
            FROM meta.org_members m
            JOIN meta.users u ON u.id = m.user_id
           WHERE m.organization_id = ${organizationId}
             AND u.status = 'active'
             AND (${needle}::text IS NULL
                  OR strpos(lower(u.display_name), ${needle}::text) > 0
                  OR strpos(lower(u.email), ${needle}::text) > 0)
          UNION ALL
          SELECT 'group'::text, g.id, g.name, NULL::text, lower(g.name),
                 CASE
                   WHEN EXISTS (
                     SELECT 1 FROM workspace_admins w
                      WHERE w.principal_type = 'group' AND w.principal_id = g.id
                   ) THEN 'workspace_admin'
                 END
            FROM meta.groups g
           WHERE g.organization_id = ${organizationId}
             AND (${needle}::text IS NULL OR strpos(lower(g.name), ${needle}::text) > 0)
        ) AS p
        LEFT JOIN meta.base_role_members a
               ON a.organization_id = ${organizationId}
              AND a.base_id = ${baseId}
              AND a.principal_type::text = p.principal_type
              AND a.principal_id = p.principal_id
       WHERE ${
         cursor === null
           ? sql`TRUE`
           : sql`(p.sort_key, p.principal_type, p.principal_id)
                   > (${cursor.key}::text, ${cursor.type}::text, ${cursor.id}::text)`
       }
       ORDER BY p.sort_key, p.principal_type, p.principal_id
       LIMIT ${options.limit + 1}
    `.execute(this.executor(scope));
    return rows;
  }
}
