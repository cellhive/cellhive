import {
  emailSchema,
  OIDC_LINK_RETURN_PATH,
  type Id,
  type MeIdentityList,
  type OidcLinkError,
} from '@cellhive/contracts';
import {
  auditForUser,
  OrganizationsRepository,
  sqlStateOf,
  SQLSTATE,
  UserIdentitiesRepository,
  UsersRepository,
  type Db,
  type OidcProviderConfig,
  type Tx,
  type UserIdentity,
} from '@cellhive/server-core';
import { AppError } from '@cellhive/server-core/errors';
import { Inject, Injectable } from '@nestjs/common';

import { OidcClient, type OidcIdentity } from '../../common/auth/oidc/oidc-client.js';
import { auditContextOf, type RequestMeta } from '../../common/auth/request-meta.js';
import { AppLogger } from '../../common/logging/app-logger.js';
import { DB } from '../../common/tokens.js';

import type { SessionPrincipal } from '../../common/auth/principal.js';

/** Where the link callback sends the browser back on failure. */
export function linkErrorLocation(error: OidcLinkError): string {
  return `${OIDC_LINK_RETURN_PATH}?error=${error}`;
}

/** How an identity got attached to its user (`after.method` of `auth.identity_linked`). */
export type IdentityLinkMethod = 'manual' | 'email';

/** The email of the token when it is a valid address. */
export function identityEmailOf(identity: OidcIdentity): string | null {
  if (identity.email === null) return null;
  const parsed = emailSchema.safeParse(identity.email);
  return parsed.success ? parsed.data : null;
}

/**
 * `auth.identity_linked` / `auth.identity_unlinked` (CONTRACTS §12.0, §27.3):
 * one entry per organization of the user (no organization → one entry
 * without), actor = the user, provider + method only — never `sub` nor a claim.
 */
export async function auditIdentityChange(
  tx: Tx,
  organizations: OrganizationsRepository,
  meta: RequestMeta,
  change: {
    readonly action: 'auth.identity_linked' | 'auth.identity_unlinked';
    readonly userId: Id<'usr'>;
    readonly identity: Pick<UserIdentity, 'id' | 'provider'>;
    readonly method?: IdentityLinkMethod;
  },
): Promise<void> {
  const snapshot = { identity_id: change.identity.id, provider: change.identity.provider };
  await auditForUser(tx, organizations, change.userId, {
    action: change.action,
    entityType: 'user',
    entityId: change.userId,
    ...(change.action === 'auth.identity_linked'
      ? { after: { ...snapshot, method: change.method ?? 'manual' } }
      : { before: snapshot }),
    context: auditContextOf(meta, { type: 'user', id: change.userId }),
  });
}

export type LinkOutcome =
  | { readonly kind: 'linked'; readonly identityId: Id<'idn'>; readonly replaced: boolean }
  | { readonly kind: 'failed'; readonly error: OidcLinkError };

/**
 * Connected accounts of the signed-in user (CONTRACTS §27.3; BACKLOG T708,
 * ADR-36 §3): list, link (from the OIDC callback in `link` mode) and unlink.
 * Changes to the sign-in methods of one user are serialised by a row lock on
 * the user, so two links of one provider, or two unlinks of the last
 * identities, cannot both pass their checks.
 */
@Injectable()
export class MeIdentitiesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(UserIdentitiesRepository) private readonly identities: UserIdentitiesRepository,
    @Inject(OrganizationsRepository) private readonly organizations: OrganizationsRepository,
    @Inject(OidcClient) private readonly client: OidcClient,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  async list(principal: SessionPrincipal): Promise<MeIdentityList> {
    const rows = await this.identities.listByUser(principal.userId);
    return {
      items: rows.map((row) => ({
        id: row.id,
        provider: row.provider,
        provider_name: this.client.provider(row.provider)?.name ?? row.provider,
        email: row.email,
        created_at: row.created_at.toISOString(),
        last_login_at: row.last_login_at?.toISOString() ?? null,
      })),
    };
  }

  /**
   * Attaches `(provider, sub)` to the signed-in user: the identity of another
   * user, or another account of the same provider already attached →
   * `IDENTITY_IN_USE`; the same account again → its email is refreshed.
   */
  async link(
    provider: OidcProviderConfig,
    identity: OidcIdentity,
    principal: SessionPrincipal,
    meta: RequestMeta,
  ): Promise<LinkOutcome> {
    try {
      return await this.linkOnce(provider, identity, principal, meta);
    } catch (error) {
      // Another user linked the same identity meanwhile: decide again (→ in use).
      if (sqlStateOf(error) !== SQLSTATE.uniqueViolation) throw error;
      return this.linkOnce(provider, identity, principal, meta);
    }
  }

  private async linkOnce(
    provider: OidcProviderConfig,
    identity: OidcIdentity,
    principal: SessionPrincipal,
    meta: RequestMeta,
  ): Promise<LinkOutcome> {
    const email = identityEmailOf(identity);
    const userId = principal.userId;
    return this.db.withTx(async (tx): Promise<LinkOutcome> => {
      const existing = await this.identities.findByProviderSubject(
        provider.slug,
        identity.subject,
        tx,
      );
      if (existing !== undefined && existing.user_id !== userId) {
        return { kind: 'failed', error: 'IDENTITY_IN_USE' };
      }
      // Serialises with other links/unlinks of this user (no unique (user, provider)).
      await this.users.lockById(userId, tx);
      const own = await this.identities.listByUser(userId, tx);
      const same = own.find(
        (row) => row.provider === provider.slug && row.subject === identity.subject,
      );
      if (same !== undefined) {
        await this.identities.refreshEmail(same.id, email, tx);
        await auditIdentityChange(tx, this.organizations, meta, {
          action: 'auth.identity_linked',
          userId,
          identity: same,
          method: 'manual',
        });
        return { kind: 'linked', identityId: same.id, replaced: true };
      }
      if (own.some((row) => row.provider === provider.slug)) {
        return { kind: 'failed', error: 'IDENTITY_IN_USE' };
      }
      const created = await this.identities.create(
        { userId, provider: provider.slug, subject: identity.subject, email },
        tx,
      );
      await auditIdentityChange(tx, this.organizations, meta, {
        action: 'auth.identity_linked',
        userId,
        identity: created,
        method: 'manual',
      });
      return { kind: 'linked', identityId: created.id, replaced: false };
    });
  }

  /**
   * `DELETE /me/identities/:id`: another user's or an unknown id → `404`;
   * the last way to sign in (no password, one identity) → `422
   * LAST_LOGIN_METHOD`.
   */
  async unlink(principal: SessionPrincipal, id: Id<'idn'>, meta: RequestMeta): Promise<void> {
    const userId = principal.userId;
    await this.db.withTx(async (tx) => {
      const user = await this.users.lockById(userId, tx);
      const target = await this.identities.findOfUser(userId, id, tx);
      if (user === undefined || target === undefined) {
        throw new AppError('NOT_FOUND', { detail: 'No such connected account.' });
      }
      const own = await this.identities.listByUser(userId, tx);
      if (user.password_hash === null && own.length <= 1) {
        throw new AppError('VALIDATION_FAILED', {
          detail:
            'This is the only way to sign in to this account: set a password or connect ' +
            'another provider first.',
          errors: [
            {
              path: 'userIdentityId',
              code: 'LAST_LOGIN_METHOD',
              message: 'The account would have no way to sign in',
            },
          ],
        });
      }
      await this.identities.deleteOfUser(userId, id, tx);
      await auditIdentityChange(tx, this.organizations, meta, {
        action: 'auth.identity_unlinked',
        userId,
        identity: target,
      });
    });
    this.logger.info({ user_id: userId, identity_id: id }, 'oidc identity unlinked');
  }
}
