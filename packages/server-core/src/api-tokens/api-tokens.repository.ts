import { sql, type Insertable, type RawBuilder, type SqlBool } from 'kysely';

import { afterCursor, cursorTimestamp, pageWithCursor, type KeysetCursor } from '../db/cursor.js';
import {
  TenantRepository,
  type OrgScope,
  type TenantRepositoryContract,
} from '../db/repository.js';

import type { Db } from '../db/create-db.js';
import type { ApiTokenRow, ApiTokensTable, JsonValue, User } from '../db/schema.js';
import type { ApiTokenScope, ApiTokenStatus, Id } from '@cellhive/contracts';

export type NewApiToken = Omit<
  Insertable<ApiTokensTable>,
  'organization_id' | 'last_used_at' | 'revoked_at' | 'revoked_by' | 'created_at' | 'updated_at'
>;

/** A token with its owner's display name (listings) and its keyset position. */
export type ApiTokenListRow = ApiTokenRow & {
  readonly user_display_name: string;
  readonly cursor_at: string;
};

/** A token as the request authentication sees it (`findForAuthentication`). */
export interface ApiTokenAuthentication {
  readonly id: Id<'tok'>;
  readonly scopes: readonly ApiTokenScope[];
  readonly baseIds: readonly Id<'bse'>[] | null;
  readonly revoked: boolean;
  /** `expires_at` passed, at the database's `now()`. */
  readonly expired: boolean;
  readonly lastUsedAt: Date | null;
  /** `organizations.settings` (the token policy lives in `api_tokens`). */
  readonly orgSettings: JsonValue;
  /** The owner is still a member (tokens cascade with the membership anyway). */
  readonly isMember: boolean;
  readonly user: User;
}

/** `last_used_at` is written at most this often per token (CONTRACTS §26.6). */
export const API_TOKEN_LAST_USED_INTERVAL_MS = 5 * 60 * 1000;

export interface ApiTokenListFilter {
  readonly userId?: Id<'usr'>;
  readonly status?: ApiTokenStatus;
}

/** SQL condition of a status, evaluated at the transaction's `now()`. */
function statusCondition(status: ApiTokenStatus): RawBuilder<SqlBool> {
  switch (status) {
    case 'active':
      return sql<SqlBool>`t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now())`;
    case 'revoked':
      return sql<SqlBool>`t.revoked_at IS NOT NULL`;
    case 'expired':
      return sql<SqlBool>`t.revoked_at IS NULL AND t.expires_at <= now()`;
  }
}

/**
 * `meta.api_tokens` (BACKLOG T703, ADR-36 §1). Every query is scoped by
 * `organization_id`: a token of another organization behaves exactly like
 * a missing one. The only lookup by hash, from a request that does not know
 * its organization yet, is `findApiTokenByHash` (cross-tenant, S§14.1).
 */
export class ApiTokensRepository
  extends TenantRepository<'api_tokens'>
  implements TenantRepositoryContract<ApiTokensRepository>
{
  constructor(db: Db) {
    super(db, 'api_tokens');
  }

  async create(scope: OrgScope, input: NewApiToken): Promise<ApiTokenRow> {
    return this.executor(scope)
      .insertInto('meta.api_tokens')
      .values({ ...input, organization_id: scope.organizationId })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async findById(
    scope: OrgScope,
    id: Id<'tok'>,
    options: { forUpdate?: boolean } = {},
  ): Promise<ApiTokenRow | undefined> {
    let query = this.executor(scope)
      .selectFrom('meta.api_tokens')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id);
    if (options.forUpdate === true) query = query.forUpdate();
    return query.executeTakeFirst();
  }

  /**
   * Locks the membership of `userId` (`FOR NO KEY UPDATE`) so that one
   * token creation at a time counts and inserts for that member; `false`
   * when the user is no longer a member.
   */
  async lockOwner(scope: OrgScope, userId: Id<'usr'>): Promise<boolean> {
    const row = await this.executor(scope)
      .selectFrom('meta.org_members')
      .select('user_id')
      .where('organization_id', '=', scope.organizationId)
      .where('user_id', '=', userId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    return row !== undefined;
  }

  /** Tokens of the member that are not revoked (expired ones included). */
  async countNotRevoked(scope: OrgScope, userId: Id<'usr'>): Promise<number> {
    const row = await this.executor(scope)
      .selectFrom('meta.api_tokens')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('organization_id', '=', scope.organizationId)
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  /** Every token id of the member (before the membership, and so the tokens, go). */
  async idsOfUser(scope: OrgScope, userId: Id<'usr'>): Promise<Id<'tok'>[]> {
    const rows = await this.executor(scope)
      .selectFrom('meta.api_tokens')
      .select('id')
      .where('organization_id', '=', scope.organizationId)
      .where('user_id', '=', userId)
      .execute();
    return rows.map((row) => row.id);
  }

  async rename(scope: OrgScope, id: Id<'tok'>, name: string): Promise<ApiTokenRow | undefined> {
    return this.executor(scope)
      .updateTable('meta.api_tokens')
      .set({ name })
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
  }

  /** Soft revocation; `undefined` when the token is unknown or already revoked. */
  async revoke(
    scope: OrgScope,
    id: Id<'tok'>,
    revokedBy: Id<'usr'>,
  ): Promise<ApiTokenRow | undefined> {
    return this.executor(scope)
      .updateTable('meta.api_tokens')
      .set({ revoked_at: sql`now()`, revoked_by: revokedBy })
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .where('revoked_at', 'is', null)
      .returningAll()
      .executeTakeFirst();
  }

  /**
   * Soft-revokes every token of the member in this organization that is not
   * revoked yet (expired ones included; already revoked ones keep their
   * `revoked_at`), e.g. on a password reset (BACKLOG T802). Returns the
   * revoked rows, oldest first.
   */
  async revokeAllOfUser(
    scope: OrgScope,
    userId: Id<'usr'>,
    revokedBy: Id<'usr'>,
  ): Promise<ApiTokenRow[]> {
    const rows = await this.executor(scope)
      .updateTable('meta.api_tokens')
      .set({ revoked_at: sql`now()`, revoked_by: revokedBy })
      .where('organization_id', '=', scope.organizationId)
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .returningAll()
      .execute();
    return rows.sort(
      (a, b) => a.created_at.getTime() - b.created_at.getTime() || a.id.localeCompare(b.id),
    );
  }

  /**
   * What authenticating a request with this token needs, in one query
   * (BACKLOG T704): the token, its owner, the organization's settings (the
   * token policy), whether the owner is still a member, and whether the
   * token expired at the database's `now()`. `undefined` when unknown here.
   */
  async findForAuthentication(
    scope: OrgScope,
    id: Id<'tok'>,
  ): Promise<ApiTokenAuthentication | undefined> {
    const row = await this.executor(scope)
      .selectFrom('meta.api_tokens as t')
      .innerJoin('meta.organizations as o', 'o.id', 't.organization_id')
      .innerJoin('meta.users as u', 'u.id', 't.user_id')
      .leftJoin('meta.org_members as m', (join) =>
        join
          .onRef('m.organization_id', '=', 't.organization_id')
          .onRef('m.user_id', '=', 't.user_id'),
      )
      .select([
        't.id',
        't.user_id',
        't.scopes',
        't.base_ids',
        't.revoked_at',
        't.last_used_at',
        'o.settings as org_settings',
        'm.user_id as member_user_id',
        'u.email as u_email',
        'u.display_name as u_display_name',
        'u.avatar_url as u_avatar_url',
        'u.password_hash as u_password_hash',
        'u.status as u_status',
        'u.locale as u_locale',
        'u.timezone as u_timezone',
        'u.created_at as u_created_at',
        'u.updated_at as u_updated_at',
        sql<boolean>`t.expires_at IS NOT NULL AND t.expires_at <= now()`.as('expired'),
      ])
      .where('t.organization_id', '=', scope.organizationId)
      .where('t.id', '=', id)
      .executeTakeFirst();
    if (row === undefined) return undefined;
    return {
      id: row.id,
      scopes: row.scopes,
      baseIds: row.base_ids,
      revoked: row.revoked_at !== null,
      expired: row.expired,
      lastUsedAt: row.last_used_at,
      orgSettings: row.org_settings,
      isMember: row.member_user_id !== null,
      user: {
        id: row.user_id,
        email: row.u_email,
        display_name: row.u_display_name,
        avatar_url: row.u_avatar_url,
        password_hash: row.u_password_hash,
        status: row.u_status,
        locale: row.u_locale,
        timezone: row.u_timezone,
        created_at: row.u_created_at,
        updated_at: row.u_updated_at,
      },
    };
  }

  /**
   * Records that the token was used, at most once per
   * `API_TOKEN_LAST_USED_INTERVAL` (CONTRACTS §26.6): the condition sits in
   * the `UPDATE`, so concurrent requests write once. `true` when written.
   */
  async touchLastUsed(scope: OrgScope, id: Id<'tok'>): Promise<boolean> {
    const result = await this.executor(scope)
      .updateTable('meta.api_tokens')
      .set({ last_used_at: sql`now()` })
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .where(sql<SqlBool>`(last_used_at IS NULL OR last_used_at < now() - interval '5 minutes')`)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /** Newest first (`created_at DESC, id DESC`), cursor-paginated, with the owner's name. */
  async listPage(
    scope: OrgScope,
    filter: ApiTokenListFilter,
    page: { readonly cursor: KeysetCursor | null; readonly limit: number },
  ): Promise<{ items: ApiTokenListRow[]; nextCursor: string | null }> {
    const conditions: RawBuilder<SqlBool>[] = [
      sql<SqlBool>`t.organization_id = ${scope.organizationId}`,
    ];
    if (filter.userId !== undefined) conditions.push(sql<SqlBool>`t.user_id = ${filter.userId}`);
    if (filter.status !== undefined) conditions.push(statusCondition(filter.status));
    if (page.cursor !== null) {
      conditions.push(afterCursor(sql`t.created_at`, sql`t.id`, page.cursor));
    }
    const { rows } = await sql<ApiTokenListRow>`
      SELECT t.*, u.display_name AS user_display_name,
             ${cursorTimestamp(sql`t.created_at`)} AS cursor_at
        FROM meta.api_tokens AS t
        JOIN meta.users AS u ON u.id = t.user_id
       WHERE ${sql.join(conditions, sql` AND `)}
       ORDER BY t.created_at DESC, t.id DESC
       LIMIT ${page.limit + 1}
    `.execute(this.executor(scope));
    return pageWithCursor(rows, page.limit, (row) => ({ at: row.cursor_at, id: row.id }));
  }
}
