import { sql, type Expression, type ExpressionBuilder, type SqlBool } from 'kysely';

import {
  TenantRepository,
  type OrgScope,
  type TenantRepositoryContract,
} from '../db/repository.js';

import type { Db } from '../db/create-db.js';
import type {
  Database,
  JsonObject,
  ShareLinkAudienceKind,
  ShareLinkRow,
  ShareLinkTargetKind,
} from '../db/schema.js';
import type { Id } from '@cellhive/contracts';

export interface InsertShareLinkInput {
  readonly id: Id<'shl'>;
  readonly baseId: Id<'bse'>;
  /** Table of the target view/form; `null` for dashboards. */
  readonly tableId: Id<'tbl'> | null;
  readonly targetType: ShareLinkTargetKind;
  readonly targetId: string;
  readonly audience: ShareLinkAudienceKind;
  readonly tokenPrefix: string;
  /** SHA-256 of the token, hex. */
  readonly tokenHash: string;
  readonly passwordHash: string | null;
  readonly expiresAt: Date | null;
  readonly settings: JsonObject;
  readonly enabled: boolean;
  readonly createdBy: Id<'usr'>;
}

export interface UpdateShareLinkInput {
  readonly audience?: ShareLinkAudienceKind;
  readonly passwordHash?: string | null;
  readonly expiresAt?: Date | null;
  readonly settings?: JsonObject;
  readonly enabled?: boolean;
}

/** Filters of the admin lists (links that are not revoked). */
export interface ShareLinkListFilter {
  readonly baseId?: Id<'bse'>;
  readonly audience?: ShareLinkAudienceKind;
  readonly enabled?: boolean;
  readonly targetType?: ShareLinkTargetKind;
  readonly createdBy?: Id<'usr'>;
  /** Only links of these bases (`[]` = none). */
  readonly baseIds?: readonly Id<'bse'>[];
}

type ShareLinkAliases = Database & { sl: Database['meta.share_links'] };

/** A link with the names the lists show. */
export interface ShareLinkListRow extends ShareLinkRow {
  /** Current name of the target view, form or dashboard; `null` when it no longer exists. */
  readonly target_name: string | null;
  /** Display name of the creator; `null` for a deleted user. */
  readonly creator_name: string | null;
}

/**
 * `meta.share_links` and `meta.share_link_daily_stats` (SPEC §5.10, §15A).
 * Every query is scoped by `organization_id`; finding the organization of a
 * token is `findShareLinkOrganization` (cross-tenant lookups). Permission
 * checks belong to the callers. The token itself never reaches this class:
 * only its hash and prefix.
 */
export class ShareLinksRepository
  extends TenantRepository<'share_links'>
  implements TenantRepositoryContract<ShareLinksRepository>
{
  constructor(db: Db) {
    super(db, 'share_links');
  }

  async insert(scope: OrgScope, input: InsertShareLinkInput): Promise<ShareLinkRow> {
    return this.executor(scope)
      .insertInto('meta.share_links')
      .values({
        id: input.id,
        organization_id: scope.organizationId,
        base_id: input.baseId,
        table_id: input.tableId,
        target_type: input.targetType,
        target_id: input.targetId,
        audience: input.audience,
        token_prefix: input.tokenPrefix,
        token_hash: input.tokenHash,
        password_hash: input.passwordHash,
        expires_at: input.expiresAt,
        settings: input.settings,
        enabled: input.enabled,
        created_by: input.createdBy,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * Serialises link changes of one target (at most one link per target is
   * not revoked) until the transaction of `scope` ends.
   */
  async lockTarget(
    scope: OrgScope,
    targetType: ShareLinkTargetKind,
    targetId: string,
  ): Promise<void> {
    if (scope.tx === undefined) throw new TypeError('lockTarget needs a transaction scope');
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`share-links:${scope.organizationId}:${targetType}:${targetId}`}, 0))`.execute(
      this.executor(scope),
    );
  }

  /** A link, revoked or not. */
  async getById(scope: OrgScope, id: Id<'shl'>): Promise<ShareLinkRow | undefined> {
    return this.executor(scope)
      .selectFrom('meta.share_links')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
  }

  /** A link that is not revoked, with the names the API shows. */
  async getLive(scope: OrgScope, id: Id<'shl'>): Promise<ShareLinkListRow | undefined> {
    return this.selectListRows(scope)
      .where('sl.id', '=', id)
      .where('sl.revoked_at', 'is', null)
      .executeTakeFirst();
  }

  /** A link that is not revoked, locked `FOR UPDATE` until the transaction of `scope` ends. */
  async lockLive(scope: OrgScope, id: Id<'shl'>): Promise<ShareLinkRow | undefined> {
    return this.executor(scope)
      .selectFrom('meta.share_links')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .where('revoked_at', 'is', null)
      .forUpdate()
      .executeTakeFirst();
  }

  /** The link whose token has this SHA-256, revoked or not. */
  async findByTokenHash(scope: OrgScope, tokenHash: string): Promise<ShareLinkRow | undefined> {
    return this.executor(scope)
      .selectFrom('meta.share_links')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('token_hash', '=', tokenHash)
      .executeTakeFirst();
  }

  /** Links of a target that are not revoked (at most one), with names. */
  async listLiveForTarget(
    scope: OrgScope,
    targetType: ShareLinkTargetKind,
    targetId: string,
  ): Promise<ShareLinkListRow[]> {
    return this.selectListRows(scope)
      .where('sl.target_type', '=', targetType)
      .where('sl.target_id', '=', targetId)
      .where('sl.revoked_at', 'is', null)
      .orderBy('sl.created_at')
      .orderBy('sl.id')
      .execute();
  }

  /** Ids of the links of a target that are not revoked. */
  async liveIdsForTarget(
    scope: OrgScope,
    targetType: ShareLinkTargetKind,
    targetId: string,
  ): Promise<Id<'shl'>[]> {
    const rows = await this.executor(scope)
      .selectFrom('meta.share_links')
      .select('id')
      .where('organization_id', '=', scope.organizationId)
      .where('target_type', '=', targetType)
      .where('target_id', '=', targetId)
      .where('revoked_at', 'is', null)
      .execute();
    return rows.map((row) => row.id);
  }

  /** Links that are not revoked, newest first, with names. */
  async listPage(
    scope: OrgScope,
    filter: ShareLinkListFilter,
    page: { readonly offset: number; readonly limit: number },
  ): Promise<{ items: ShareLinkListRow[]; total: number }> {
    if (filter.baseIds !== undefined && filter.baseIds.length === 0) return { items: [], total: 0 };
    const where = (eb: ExpressionBuilder<ShareLinkAliases, 'sl'>) => {
      const conditions: Expression<SqlBool>[] = [eb('sl.revoked_at', 'is', null)];
      if (filter.baseId !== undefined) conditions.push(eb('sl.base_id', '=', filter.baseId));
      if (filter.baseIds !== undefined) {
        conditions.push(eb('sl.base_id', 'in', [...filter.baseIds]));
      }
      if (filter.audience !== undefined) conditions.push(eb('sl.audience', '=', filter.audience));
      if (filter.enabled !== undefined) conditions.push(eb('sl.enabled', '=', filter.enabled));
      if (filter.targetType !== undefined) {
        conditions.push(eb('sl.target_type', '=', filter.targetType));
      }
      if (filter.createdBy !== undefined) {
        conditions.push(eb('sl.created_by', '=', filter.createdBy));
      }
      return eb.and(conditions);
    };
    const items = await this.selectListRows(scope)
      .where(where)
      .orderBy('sl.created_at', 'desc')
      .orderBy('sl.id', 'desc')
      .limit(page.limit)
      .offset(page.offset)
      .execute();
    const { n } = await this.executor(scope)
      .selectFrom('meta.share_links as sl')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('sl.organization_id', '=', scope.organizationId)
      .where(where)
      .executeTakeFirstOrThrow();
    return { items, total: n };
  }

  async update(
    scope: OrgScope,
    id: Id<'shl'>,
    patch: UpdateShareLinkInput,
  ): Promise<ShareLinkRow | undefined> {
    const values = {
      ...(patch.audience === undefined ? {} : { audience: patch.audience }),
      ...(patch.passwordHash === undefined ? {} : { password_hash: patch.passwordHash }),
      ...(patch.expiresAt === undefined ? {} : { expires_at: patch.expiresAt }),
      ...(patch.settings === undefined ? {} : { settings: patch.settings }),
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
    };
    if (Object.keys(values).length === 0) return this.getById(scope, id);
    return this.executor(scope)
      .updateTable('meta.share_links')
      .set(values)
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .where('revoked_at', 'is', null)
      .returningAll()
      .executeTakeFirst();
  }

  /**
   * Revokes the links among `ids` that are not revoked yet (optionally only
   * those of `baseId`); returns the rows as they were before, locked.
   */
  async revoke(
    scope: OrgScope,
    ids: readonly Id<'shl'>[],
    revokedBy: Id<'usr'>,
    options: { readonly baseId?: Id<'bse'> } = {},
  ): Promise<ShareLinkRow[]> {
    if (ids.length === 0) return [];
    let query = this.executor(scope)
      .selectFrom('meta.share_links')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('id', 'in', [...ids])
      .where('revoked_at', 'is', null);
    if (options.baseId !== undefined) query = query.where('base_id', '=', options.baseId);
    const rows = await query.orderBy('id').forUpdate().execute();
    if (rows.length === 0) return [];
    await this.executor(scope)
      .updateTable('meta.share_links')
      .set({ revoked_at: sql<Date>`now()`, revoked_by: revokedBy })
      .where('organization_id', '=', scope.organizationId)
      .where(
        'id',
        'in',
        rows.map((row) => row.id),
      )
      .execute();
    return rows;
  }

  /**
   * Revokes every link of a table's views and forms that is not revoked yet
   * (purge of the table, T461; `revokedBy` is `null` for the system);
   * returns the rows as they were before, locked.
   */
  async revokeByTable(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    revokedBy: Id<'usr'> | null,
  ): Promise<ShareLinkRow[]> {
    const rows = await this.executor(scope)
      .selectFrom('meta.share_links')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('table_id', '=', tableId)
      .where('revoked_at', 'is', null)
      .orderBy('id')
      .forUpdate()
      .execute();
    if (rows.length === 0) return [];
    await this.executor(scope)
      .updateTable('meta.share_links')
      .set({ revoked_at: sql<Date>`now()`, revoked_by: revokedBy })
      .where('organization_id', '=', scope.organizationId)
      .where(
        'id',
        'in',
        rows.map((row) => row.id),
      )
      .execute();
    return rows;
  }

  /**
   * Adds `count` accesses at `at` (T305 batches them): `access_count`,
   * `last_accessed_at` and the count of the UTC day. `count = 0` only moves
   * `last_accessed_at` (requests that are not page opens).
   */
  async recordAccess(
    scope: OrgScope,
    id: Id<'shl'>,
    access: { readonly count: number; readonly at: Date },
  ): Promise<void> {
    if (!Number.isSafeInteger(access.count) || access.count < 0) return;
    const updated = await this.executor(scope)
      .updateTable('meta.share_links')
      .set({
        access_count: sql<bigint>`access_count + ${access.count}`,
        last_accessed_at: sql<Date>`greatest(last_accessed_at, ${access.at})`,
      })
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .returning('id')
      .executeTakeFirst();
    if (updated === undefined || access.count === 0) return;
    await this.executor(scope)
      .insertInto('meta.share_link_daily_stats')
      .values({
        organization_id: scope.organizationId,
        share_link_id: id,
        day: access.at.toISOString().slice(0, 10),
        access_count: access.count,
      })
      .onConflict((conflict) =>
        conflict.columns(['share_link_id', 'day']).doUpdateSet({
          access_count: sql<bigint>`meta.share_link_daily_stats.access_count + excluded.access_count`,
        }),
      )
      .execute();
  }

  /** Daily access counts of a link since `since` (`YYYY-MM-DD`, UTC), oldest first. */
  async dailyStats(
    scope: OrgScope,
    id: Id<'shl'>,
    since: string,
  ): Promise<{ day: string; access_count: bigint }[]> {
    return this.executor(scope)
      .selectFrom('meta.share_link_daily_stats')
      .select(['day', 'access_count'])
      .where('organization_id', '=', scope.organizationId)
      .where('share_link_id', '=', id)
      .where('day', '>=', since)
      .orderBy('day')
      .execute();
  }

  private selectListRows(scope: OrgScope) {
    return (
      this.executor(scope)
        .selectFrom('meta.share_links as sl')
        .leftJoin('meta.views as v', (join) =>
          join
            .onRef('v.organization_id', '=', 'sl.organization_id')
            .onRef('v.id', '=', 'sl.target_id')
            .on(sql<SqlBool>`sl.target_type IN ('view', 'form')`),
        )
        // Dashboards in the trash have no name to show (their links do not work, T809).
        .leftJoin('meta.dashboards as d', (join) =>
          join
            .onRef('d.organization_id', '=', 'sl.organization_id')
            .onRef('d.id', '=', 'sl.target_id')
            .on(sql<SqlBool>`sl.target_type = 'dashboard'`)
            .on('d.deleted_at', 'is', null),
        )
        .leftJoin('meta.users as u', 'u.id', 'sl.created_by')
        .selectAll('sl')
        .select([
          sql<string | null>`coalesce(v.name, d.name)`.as('target_name'),
          sql<string | null>`CASE WHEN u.status = 'deleted' THEN NULL ELSE u.display_name END`.as(
            'creator_name',
          ),
        ])
        .where('sl.organization_id', '=', scope.organizationId)
    );
  }
}
