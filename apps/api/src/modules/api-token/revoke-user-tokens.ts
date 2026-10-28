import {
  AuditWriter,
  emit,
  orgScope,
  publishApiTokensRevoked,
  type ApiTokensRepository,
  type AuditContext,
  type Db,
  type OrganizationsRepository,
  type Tx,
} from '@cellhive/server-core';

import type { Id } from '@cellhive/contracts';

/** Why every token of a user is revoked at once (audit `after.reason`). */
export type BulkRevocationReason = 'password_reset' | 'password_change';

export interface RevokeUserApiTokensInput {
  readonly userId: Id<'usr'>;
  readonly reason: BulkRevocationReason;
  /** The audit context of the operation (the user redeeming a link, an admin, or `system`). */
  readonly context: AuditContext;
  /** `revoked_by`; the user themself unless an admin revokes (default: `userId`). */
  readonly revokedBy?: Id<'usr'>;
}

const audit = new AuditWriter();

/**
 * Revokes every API token of a user that is not revoked yet, in every
 * organization the user belongs to (BACKLOG T802, CONTRACTS §12.1, §26.4),
 * inside the caller's transaction. Each organization is handled in its own
 * scope: one bulk audit entry `api_token.revoked` (`after = { reason,
 * count, token_ids }`, never a value or hash), one event `api_token.revoked`
 * per token, and the realtime envelope that closes WebSocket connections
 * of these tokens after commit (T706). Returns how
 * many tokens were revoked.
 */
export async function revokeUserApiTokens(
  deps: {
    readonly db: Db;
    readonly organizations: OrganizationsRepository;
    readonly apiTokens: ApiTokensRepository;
  },
  tx: Tx,
  input: RevokeUserApiTokensInput,
): Promise<number> {
  const { userId, reason, context } = input;
  let total = 0;
  for (const { organizationId } of await deps.organizations.listMembershipsOfUser(userId, tx)) {
    const revoked = await deps.apiTokens.revokeAllOfUser(
      orgScope(organizationId, tx),
      userId,
      input.revokedBy ?? userId,
    );
    if (revoked.length === 0) continue;
    const tokenIds = revoked.map((token) => token.id);
    for (const token of revoked) {
      await emit(tx, {
        type: 'api_token.revoked',
        organizationId,
        entityType: 'api_token',
        entityId: token.id,
        actor: context.actor,
        ...(context.via === null ? {} : { via: context.via }),
        data: { user_id: token.user_id, reason },
      });
    }
    await audit.write(tx, {
      action: 'api_token.revoked',
      organizationId,
      entityType: 'user',
      entityId: userId,
      after: { reason, count: revoked.length, token_ids: tokenIds },
      context,
    });
    await publishApiTokensRevoked(deps.db, tx, organizationId, tokenIds);
    total += revoked.length;
  }
  return total;
}
