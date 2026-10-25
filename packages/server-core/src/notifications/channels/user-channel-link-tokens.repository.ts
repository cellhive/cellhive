import {
  TenantRepository,
  type OrgScope,
  type TenantRepositoryContract,
} from '../../db/repository.js';

import type { Db } from '../../db/create-db.js';
import type { UserChannelLinkTokenRow } from '../../db/schema.js';
import type { Id } from '@cellhive/contracts';

export interface NewLinkToken {
  /** SHA-256 (hex) of the token: the token itself is never stored. */
  readonly tokenHash: string;
  readonly userId: Id<'usr'>;
  readonly secretId: Id<'sec'>;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

/**
 * `meta.user_channel_link_tokens` (BACKLOG T549): one-time `/start` tokens of
 * personal Telegram channels, by hash. A token is **pending** while it is
 * not used and not expired; using or cancelling it sets `used_at`. Rows
 * stay a while after use so that the hourly creation limit counts them.
 * Every query is scoped by `organization_id`: a token of another
 * organization is never found.
 */
export class UserChannelLinkTokensRepository
  extends TenantRepository<'user_channel_link_tokens'>
  implements TenantRepositoryContract<UserChannelLinkTokensRepository>
{
  constructor(db: Db) {
    super(db, 'user_channel_link_tokens');
  }

  async insert(scope: OrgScope, token: NewLinkToken): Promise<void> {
    await this.executor(scope)
      .insertInto('meta.user_channel_link_tokens')
      .values({
        organization_id: scope.organizationId,
        token_hash: token.tokenHash,
        user_id: token.userId,
        kind: 'telegram',
        secret_id: token.secretId,
        created_at: token.createdAt,
        expires_at: token.expiresAt,
      })
      .execute();
  }

  /** Links the member created since `since` (used, cancelled and expired ones included). */
  async countCreatedSince(scope: OrgScope, userId: Id<'usr'>, since: Date): Promise<number> {
    const row = await this.executor(scope)
      .selectFrom('meta.user_channel_link_tokens')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('organization_id', '=', scope.organizationId)
      .where('user_id', '=', userId)
      .where('created_at', '>', since)
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  /** The oldest creation time among the member's links since `since` (for `Retry-After`). */
  async oldestCreatedSince(
    scope: OrgScope,
    userId: Id<'usr'>,
    since: Date,
  ): Promise<Date | undefined> {
    const row = await this.executor(scope)
      .selectFrom('meta.user_channel_link_tokens')
      .select((eb) => eb.fn.min<Date | null>('created_at').as('oldest'))
      .where('organization_id', '=', scope.organizationId)
      .where('user_id', '=', userId)
      .where('created_at', '>', since)
      .executeTakeFirst();
    const oldest = row?.oldest;
    return oldest === null || oldest === undefined ? undefined : new Date(oldest);
  }

  /** The member's pending links, newest first. */
  async listPendingForUser(
    scope: OrgScope,
    userId: Id<'usr'>,
    now: Date,
  ): Promise<Pick<UserChannelLinkTokenRow, 'token_hash' | 'secret_id' | 'expires_at'>[]> {
    return this.executor(scope)
      .selectFrom('meta.user_channel_link_tokens')
      .select(['token_hash', 'secret_id', 'expires_at'])
      .where('organization_id', '=', scope.organizationId)
      .where('user_id', '=', userId)
      .where('used_at', 'is', null)
      .where('expires_at', '>', now)
      .orderBy('created_at', 'desc')
      .orderBy('token_hash')
      .execute();
  }

  /**
   * Cancels pending links (`used_at = now`) — the member's (`userId`), or
   * every member's when `userId` is `null`; returns how many.
   */
  async cancelPending(scope: OrgScope, userId: Id<'usr'> | null, now: Date): Promise<number> {
    let query = this.executor(scope)
      .updateTable('meta.user_channel_link_tokens')
      .set({ used_at: now })
      .where('organization_id', '=', scope.organizationId)
      .where('used_at', 'is', null)
      .where('expires_at', '>', now);
    if (userId !== null) query = query.where('user_id', '=', userId);
    const result = await query.executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  /** Cancels the member's oldest pending links beyond the newest `keep`. */
  async cancelPendingBeyond(
    scope: OrgScope,
    userId: Id<'usr'>,
    keep: number,
    now: Date,
  ): Promise<number> {
    const pending = await this.listPendingForUser(scope, userId, now);
    const extra = pending.slice(keep).map((row) => row.token_hash);
    if (extra.length === 0) return 0;
    const result = await this.executor(scope)
      .updateTable('meta.user_channel_link_tokens')
      .set({ used_at: now })
      .where('organization_id', '=', scope.organizationId)
      .where('token_hash', 'in', extra)
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  /** Deletes the member's rows created before `before` that are no longer pending. */
  async deleteSettledBefore(
    scope: OrgScope,
    userId: Id<'usr'>,
    before: Date,
    now: Date,
  ): Promise<number> {
    const result = await this.executor(scope)
      .deleteFrom('meta.user_channel_link_tokens')
      .where('organization_id', '=', scope.organizationId)
      .where('user_id', '=', userId)
      .where('created_at', '<', before)
      .where((eb) => eb.or([eb('used_at', 'is not', null), eb('expires_at', '<=', now)]))
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  /** The token by hash, locked until the transaction ends (any state). */
  async lockByHash(
    scope: OrgScope,
    tokenHash: string,
  ): Promise<UserChannelLinkTokenRow | undefined> {
    return this.executor(scope)
      .selectFrom('meta.user_channel_link_tokens')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('token_hash', '=', tokenHash)
      .forUpdate()
      .executeTakeFirst();
  }

  /** Marks a token used. */
  async markUsed(scope: OrgScope, tokenHash: string, now: Date): Promise<boolean> {
    const result = await this.executor(scope)
      .updateTable('meta.user_channel_link_tokens')
      .set({ used_at: now })
      .where('organization_id', '=', scope.organizationId)
      .where('token_hash', '=', tokenHash)
      .where('used_at', 'is', null)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /** Whether links of the bot `secretId` are pending (the poller keeps going while so). */
  async hasPendingForBot(scope: OrgScope, secretId: Id<'sec'>, now: Date): Promise<boolean> {
    const row = await this.executor(scope)
      .selectFrom('meta.user_channel_link_tokens')
      .select('token_hash')
      .where('organization_id', '=', scope.organizationId)
      .where('secret_id', '=', secretId)
      .where('used_at', 'is', null)
      .where('expires_at', '>', now)
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }
}
