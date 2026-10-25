import {
  OIDC_LINK_RETURN_PATH,
  OIDC_START_RATE_LIMIT,
  type AuthProvidersResponse,
  type Id,
  type OidcCallbackQuery,
  type OidcLinkError,
  type OidcLoginError,
} from '@cellhive/contracts';
import {
  asciiDomain,
  AuditWriter,
  auditForUser,
  OrganizationsRepository,
  OrgMembersRepository,
  orgScope,
  sqlStateOf,
  SQLSTATE,
  UserIdentitiesRepository,
  UsersRepository,
  type Db,
  type OidcProviderConfig,
  type Organization,
  type Session,
  type Tx,
  type User,
  type UserIdentity,
} from '@cellhive/server-core';
import { AppError } from '@cellhive/server-core/errors';
import { Inject, Injectable } from '@nestjs/common';
import { Counter } from 'prom-client';

import { mutationContextOf, recordChange } from '../../common/access/change-log.js';
import { oidcNextPath } from '../../common/auth/oidc/next-path.js';
import { OidcClient, OidcFailure, type OidcIdentity } from '../../common/auth/oidc/oidc-client.js';
import {
  OidcStateCookie,
  type OidcLinkBinding,
  type OidcState,
} from '../../common/auth/oidc/state-cookie.js';
import { auditContextOf, type RequestMeta } from '../../common/auth/request-meta.js';
import { safeEqual } from '../../common/auth/secrets.js';
import { SessionService } from '../../common/auth/session.service.js';
import { AppLogger } from '../../common/logging/app-logger.js';
import { RateLimiter } from '../../common/rate-limit/rate-limiter.js';
import { DB } from '../../common/tokens.js';
import { MetricsService } from '../metrics/metrics.service.js';

import {
  auditIdentityChange,
  identityEmailOf,
  linkErrorLocation,
  MeIdentitiesService,
} from './me-identities.service.js';

import type { SessionPrincipal } from '../../common/auth/principal.js';

/** Longest display name (as the account API, CONTRACTS §5A). */
const DISPLAY_NAME_MAX_LENGTH = 100;

/** Where `GET …/start` sends the browser, and the state cookie to set (absent on errors). */
export interface OidcStartResult {
  readonly location: string;
  readonly cookie: string | null;
}

/**
 * Outcome of the callback: a new session; an identity linked to the
 * signed-in user (`link` mode, T708); or a failure and where to report it
 * (`/login?error=` or `/account/connections?error=`).
 */
export type OidcCallbackResult =
  | {
      readonly kind: 'signed_in';
      readonly session: Session;
      /** Goes into the cookie only. */
      readonly token: string;
      readonly next: string;
    }
  | { readonly kind: 'linked'; readonly location: string }
  | {
      readonly kind: 'failed';
      readonly error: OidcLoginError | OidcLinkError;
      readonly location: string;
    };

type Resolution =
  | { readonly kind: 'signed_in'; readonly session: Session; readonly token: string }
  | { readonly kind: 'failed'; readonly error: OidcLoginError };

export function loginErrorLocation(error: OidcLoginError): string {
  return `/login?error=${error}`;
}

function loginFailure(error: OidcLoginError): OidcCallbackResult {
  return { kind: 'failed', error, location: loginErrorLocation(error) };
}

function linkFailure(error: OidcLinkError): OidcCallbackResult {
  return { kind: 'failed', error, location: linkErrorLocation(error) };
}

function notFound(): AppError {
  return new AppError('NOT_FOUND', { detail: 'No such sign-in provider.' });
}

/** The email of the token when it is a valid address (citext: case is ignored on lookup). */
const emailOf = identityEmailOf;

/** `name` → `preferred_username` → the part of the email before `@` (CONTRACTS §27.2). */
function displayNameOf(identity: OidcIdentity, email: string): string {
  const candidate = identity.name ?? identity.preferredUsername ?? email.split('@')[0] ?? email;
  const trimmed = candidate.trim().slice(0, DISPLAY_NAME_MAX_LENGTH).trim();
  return trimmed === '' ? email.slice(0, DISPLAY_NAME_MAX_LENGTH) : trimmed;
}

function domainAllowed(provider: OidcProviderConfig, email: string): boolean {
  if (provider.allowedDomains === null) return true;
  const domain = asciiDomain(email.slice(email.lastIndexOf('@') + 1));
  return domain !== null && provider.allowedDomains.includes(domain);
}

/**
 * Sign-in with OIDC (ADR-36 §3, CONTRACTS §27.2; BACKLOG T707): `start`
 * prepares the attempt, `callback` turns a validated ID token into a session.
 * The identity is `(provider, sub)`; an account with the same email is
 * linked only when the provider sets `LINK_BY_EMAIL=true` and the email is
 * verified (T708); accounts are created only when the provider allows
 * sign-up, the email is verified and its domain allowed. An attempt started
 * from `GET /me/identities/:provider/start` (`link` mode) attaches the
 * identity to the signed-in user instead (`MeIdentitiesService`).
 */
@Injectable()
export class OidcLoginService {
  private readonly audit = new AuditWriter();
  private readonly callbacks: Counter<'provider' | 'result'>;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(UserIdentitiesRepository) private readonly identities: UserIdentitiesRepository,
    @Inject(OrganizationsRepository) private readonly organizations: OrganizationsRepository,
    @Inject(OrgMembersRepository) private readonly orgMembers: OrgMembersRepository,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(RateLimiter) private readonly rateLimiter: RateLimiter,
    @Inject(OidcClient) private readonly client: OidcClient,
    @Inject(OidcStateCookie) private readonly stateCookie: OidcStateCookie,
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Inject(MeIdentitiesService) private readonly links: MeIdentitiesService,
    @Inject(MetricsService) metrics: MetricsService,
  ) {
    // Labels: the operator's provider slugs (≤ 10) and a closed list of results.
    this.callbacks = new Counter({
      name: 'oidc_callbacks_total',
      help: 'OIDC sign-in callbacks, by provider and result',
      labelNames: ['provider', 'result'],
      registers: [metrics.registry],
    });
  }

  providers(): AuthProvidersResponse {
    return { providers: this.client.list(), password_login: true };
  }

  /**
   * `GET …/start`: unknown provider → `404`; beyond 20 per minute per IP or
   * when the provider is unreachable → back to the sign-in page with the code.
   * With `link` (`POST /me/identities/:provider/start`, T708) the attempt is
   * bound to that user and session, asks the provider to authenticate again
   * (`max_age=0`) and comes back to `/account/connections`; its errors are
   * problem documents (`429 RATE_LIMITED`, `503 DEPENDENCY_UNAVAILABLE`).
   */
  async start(
    slug: string,
    next: string | undefined,
    meta: RequestMeta,
    link?: OidcLinkBinding,
  ): Promise<OidcStartResult> {
    const provider = this.client.provider(slug);
    if (provider === undefined) throw notFound();
    try {
      await this.rateLimiter.hit(`oidc:start:ip:${meta.ip ?? 'unknown'}`, OIDC_START_RATE_LIMIT);
    } catch (error) {
      if (link === undefined && error instanceof AppError && error.code === 'RATE_LIMITED') {
        return { location: loginErrorLocation('RATE_LIMITED'), cookie: null };
      }
      throw error;
    }
    const { state, value } =
      link === undefined
        ? this.stateCookie.create(provider.slug, oidcNextPath(next))
        : this.stateCookie.create(provider.slug, oidcNextPath(OIDC_LINK_RETURN_PATH), link);
    try {
      const url = await this.client.authorizationUrl(provider, state);
      return { location: url.href, cookie: value };
    } catch (error) {
      if (!(error instanceof OidcFailure)) throw error;
      this.logFailure(provider, 'OIDC_PROVIDER_ERROR', error);
      if (link !== undefined) {
        throw new AppError('DEPENDENCY_UNAVAILABLE', {
          detail: 'The sign-in provider did not answer.',
        });
      }
      return { location: loginErrorLocation('OIDC_PROVIDER_ERROR'), cookie: null };
    }
  }

  /**
   * `GET …/callback`. The caller has already cleared the state cookie. The
   * `state` parameter must match the cookie's (constant-time); an `error`
   * from the provider is never reflected.
   */
  async callback(
    slug: string,
    query: OidcCallbackQuery,
    cookieValue: string | undefined,
    previous: SessionPrincipal | undefined,
    meta: RequestMeta,
  ): Promise<OidcCallbackResult> {
    const provider = this.client.provider(slug);
    if (provider === undefined) throw notFound();

    const state = this.stateCookie.open(cookieValue);
    if (
      state === undefined ||
      state.provider !== provider.slug ||
      query.state === undefined ||
      !safeEqual(query.state, state.state)
    ) {
      // Not an attempt started here (or a replay): metric and log, no audit.
      this.count(provider, 'OIDC_STATE_INVALID');
      this.logger.warn(
        { provider: provider.slug, result: 'OIDC_STATE_INVALID' },
        'oidc sign-in failed',
      );
      return loginFailure('OIDC_STATE_INVALID');
    }

    if (state.link !== undefined) return this.linkCallback(provider, query, state, previous, meta);

    if (query.error !== undefined || query.code === undefined) {
      const oauthError =
        query.error !== undefined && /^[a-z0-9_]{1,64}$/.test(query.error) ? query.error : null;
      return this.fail(provider, 'OIDC_PROVIDER_ERROR', null, meta, {
        reason: 'authorization_error',
        oauthError,
      });
    }

    let identity: OidcIdentity;
    try {
      identity = await this.client.signIn(provider, query, state);
    } catch (error) {
      if (!(error instanceof OidcFailure)) throw error;
      return this.fail(provider, 'OIDC_PROVIDER_ERROR', null, meta, {
        reason: error.reason,
        libraryCode: error.libraryCode,
        oauthError: error.oauthError,
      });
    }

    let resolution: Resolution;
    try {
      resolution = await this.resolve(provider, identity, previous, meta);
    } catch (error) {
      // Another callback created the same identity or email meanwhile: decide again.
      if (sqlStateOf(error) !== SQLSTATE.uniqueViolation) throw error;
      try {
        resolution = await this.resolve(provider, identity, previous, meta);
      } catch (retryError) {
        // Still racing after one retry: back to the sign-in page, not a 500.
        if (sqlStateOf(retryError) !== SQLSTATE.uniqueViolation) throw retryError;
        return this.fail(provider, 'OIDC_PROVIDER_ERROR', null, meta, {
          reason: 'concurrent_sign_in',
        });
      }
    }
    if (resolution.kind === 'failed') return loginFailure(resolution.error);
    this.count(provider, 'success');
    this.logger.info(
      { provider: provider.slug, session_id: resolution.session.id },
      'oidc sign-in',
    );
    return { ...resolution, next: state.next };
  }

  /** Finds or creates the user of `identity` and opens a session, in one transaction. */
  private async resolve(
    provider: OidcProviderConfig,
    identity: OidcIdentity,
    previous: SessionPrincipal | undefined,
    meta: RequestMeta,
  ): Promise<Resolution> {
    const email = emailOf(identity);
    const outcome = await this.db.withTx(async (tx): Promise<Resolution> => {
      const signInExisting = async (existing: UserIdentity): Promise<Resolution> => {
        const user = await this.users.findById(existing.user_id, tx);
        if (user?.status !== 'active') {
          return this.failIn(tx, provider, 'UNAUTHENTICATED', existing.user_id, meta);
        }
        await this.identities.recordLogin(existing.id, email, tx);
        return this.openSession(tx, provider, user, previous, meta);
      };
      const existing = await this.identities.findByProviderSubject(
        provider.slug,
        identity.subject,
        tx,
      );
      if (existing !== undefined) return signInExisting(existing);

      if (email !== null) {
        const sameEmail = await this.users.findByEmail(email, tx);
        if (sameEmail !== undefined) {
          // READ COMMITTED: a parallel callback for the same `sub` may have
          // committed its new user and identity between the two lookups
          // above. A snapshot that sees the user also sees an identity
          // committed with it, so look the identity up again.
          const committed = await this.identities.findByProviderSubject(
            provider.slug,
            identity.subject,
            tx,
          );
          if (committed !== undefined) return signInExisting(committed);
          return this.linkByEmail(tx, provider, identity, sameEmail, previous, meta);
        }
      }

      if (!provider.allowSignup) {
        return this.failIn(tx, provider, 'OIDC_SIGNUP_DISABLED', null, meta);
      }
      if (email === null || !identity.emailVerified) {
        return this.failIn(tx, provider, 'OIDC_EMAIL_UNVERIFIED', null, meta);
      }
      if (!domainAllowed(provider, email)) {
        return this.failIn(tx, provider, 'OIDC_DOMAIN_NOT_ALLOWED', null, meta);
      }

      const user = await this.createUser(tx, provider, identity, email, meta);
      return this.openSession(tx, provider, user, previous, meta);
    });
    if (outcome.kind === 'failed') this.count(provider, outcome.error);
    return outcome;
  }

  /**
   * An account with the email of the token exists (CONTRACTS §27.2 (b)):
   * linked and signed in only when the provider sets `LINK_BY_EMAIL=true`
   * and `email_verified` is the JSON boolean `true` (the provider vouches
   * for the address); else `OIDC_ACCOUNT_EXISTS` — the person signs in with
   * the password and links the identity in their profile. Also refused when
   * the account already has another identity of this provider (an address
   * re-registered at the provider must not add a second way in).
   */
  private async linkByEmail(
    tx: Tx,
    provider: OidcProviderConfig,
    identity: OidcIdentity,
    sameEmail: User,
    previous: SessionPrincipal | undefined,
    meta: RequestMeta,
  ): Promise<Resolution> {
    if (!provider.linkByEmail || !identity.emailVerified) {
      return this.failIn(tx, provider, 'OIDC_ACCOUNT_EXISTS', sameEmail.id, meta);
    }
    // Serialises with manual links/unlinks of this user.
    const user = await this.users.lockById(sameEmail.id, tx);
    if (user?.status !== 'active') {
      return this.failIn(tx, provider, 'UNAUTHENTICATED', sameEmail.id, meta);
    }
    const own = await this.identities.listByUser(user.id, tx);
    if (own.some((row) => row.provider === provider.slug)) {
      return this.failIn(tx, provider, 'OIDC_ACCOUNT_EXISTS', user.id, meta);
    }
    const created = await this.identities.create(
      {
        userId: user.id,
        provider: provider.slug,
        subject: identity.subject,
        email: emailOf(identity),
        signedIn: true,
      },
      tx,
    );
    await auditIdentityChange(tx, this.organizations, meta, {
      action: 'auth.identity_linked',
      userId: user.id,
      identity: created,
      method: 'email',
    });
    this.logger.info(
      { provider: provider.slug, user_id: user.id, identity_id: created.id },
      'oidc identity linked by email',
    );
    return this.openSession(tx, provider, user, previous, meta);
  }

  /**
   * Callback of a `link` attempt (CONTRACTS §27.3): the session that started
   * it must still be the one of this request (same user, same session),
   * else `OIDC_STATE_INVALID`. No session is created; failures are logged
   * and counted, not audited as sign-in failures.
   */
  private async linkCallback(
    provider: OidcProviderConfig,
    query: OidcCallbackQuery,
    state: OidcState,
    previous: SessionPrincipal | undefined,
    meta: RequestMeta,
  ): Promise<OidcCallbackResult> {
    const binding = state.link;
    if (
      binding === undefined ||
      previous === undefined ||
      previous.userId !== binding.userId ||
      !safeEqual(previous.session.id, binding.sessionId)
    ) {
      return this.linkFail(provider, 'OIDC_STATE_INVALID', { reason: 'session_changed' });
    }
    if (query.error !== undefined || query.code === undefined) {
      const oauthError =
        query.error !== undefined && /^[a-z0-9_]{1,64}$/.test(query.error) ? query.error : null;
      return this.linkFail(provider, 'OIDC_PROVIDER_ERROR', {
        reason: 'authorization_error',
        oauthError,
      });
    }
    let identity: OidcIdentity;
    try {
      identity = await this.client.signIn(provider, query, state);
    } catch (error) {
      if (!(error instanceof OidcFailure)) throw error;
      return this.linkFail(provider, 'OIDC_PROVIDER_ERROR', {
        reason: error.reason,
        libraryCode: error.libraryCode,
        oauthError: error.oauthError,
      });
    }
    const outcome = await this.links.link(provider, identity, previous, meta);
    if (outcome.kind === 'failed') {
      return this.linkFail(provider, outcome.error, {
        reason: 'link_refused',
        userId: previous.userId,
      });
    }
    this.count(provider, 'linked');
    this.logger.info(
      {
        provider: provider.slug,
        user_id: previous.userId,
        identity_id: outcome.identityId,
        replaced: outcome.replaced,
      },
      'oidc identity linked',
    );
    return { kind: 'linked', location: OIDC_LINK_RETURN_PATH };
  }

  private linkFail(
    provider: OidcProviderConfig,
    error: OidcLinkError,
    details: {
      readonly reason: string;
      readonly userId?: Id<'usr'>;
      readonly libraryCode?: string | null;
      readonly oauthError?: string | null;
    },
  ): OidcCallbackResult {
    this.count(provider, error);
    this.logger.warn(
      {
        provider: provider.slug,
        result: error,
        reason: details.reason,
        ...(details.userId === undefined ? {} : { user_id: details.userId }),
        ...(details.libraryCode == null ? {} : { library_code: details.libraryCode }),
        ...(details.oauthError == null ? {} : { oauth_error: details.oauthError }),
      },
      'oidc link failed',
    );
    return linkFailure(error);
  }

  /**
   * A new account without password, its identity and — with
   * `OIDC_<SLUG>_AUTO_JOIN_ORG` — a `member` membership, in the sign-in
   * transaction. Audit `user.created` (in the joined organization, else
   * without organization) and `org_member.added` (event + audit).
   */
  private async createUser(
    tx: Tx,
    provider: OidcProviderConfig,
    identity: OidcIdentity,
    email: string,
    meta: RequestMeta,
  ): Promise<User> {
    const user = await this.users.create(
      {
        email,
        displayName: displayNameOf(identity, email),
        passwordHash: null,
        locale: null,
        timezone: null,
      },
      tx,
    );
    await this.identities.create(
      {
        userId: user.id,
        provider: provider.slug,
        subject: identity.subject,
        email,
        signedIn: true,
      },
      tx,
    );

    let organization: Organization | undefined;
    if (provider.autoJoinOrg !== null) {
      organization = await this.organizations.findBySlug(provider.autoJoinOrg, tx);
      if (organization === undefined) {
        this.logger.warn(
          { provider: provider.slug, auto_join_org: provider.autoJoinOrg },
          'oidc auto-join organization not found; account created without membership',
        );
      }
    }

    await this.audit.write(tx, {
      action: 'user.created',
      organizationId: organization?.id ?? null,
      entityType: 'user',
      entityId: user.id,
      after: {
        email: user.email,
        display_name: user.display_name,
        method: 'oidc',
        provider: provider.slug,
      },
      context: auditContextOf(meta, { type: 'user', id: user.id }),
    });

    if (organization !== undefined) {
      await this.orgMembers.add(orgScope(organization.id, tx), user.id, 'member');
      await recordChange(tx, {
        type: 'org_member.added',
        organizationId: organization.id,
        entityType: 'org_member',
        entityId: user.id,
        context: mutationContextOf(meta, user.id),
        after: { user_id: user.id, role: 'member', method: 'oidc', provider: provider.slug },
        data: { user_id: user.id, role: 'member' },
      });
    }
    return user;
  }

  /** Session as `POST /auth/login` (the session sent with the request is revoked) + `auth.login`. */
  private async openSession(
    tx: Tx,
    provider: OidcProviderConfig,
    user: User,
    previous: SessionPrincipal | undefined,
    meta: RequestMeta,
  ): Promise<Resolution> {
    if (previous !== undefined) await this.sessions.revoke(previous.session, tx);
    const created = await this.sessions.create(user.id, meta, tx);
    await auditForUser(tx, this.organizations, user.id, {
      action: 'auth.login',
      entityType: 'session',
      entityId: created.session.id,
      after: { user_id: user.id, method: 'oidc', provider: provider.slug },
      context: auditContextOf(meta, { type: 'user', id: user.id }),
    });
    return { kind: 'signed_in', session: created.session, token: created.token };
  }

  /** `auth.login_failed` about the user concerned, if known (`reason` = the code, never a claim). */
  private async failIn(
    tx: Tx,
    provider: OidcProviderConfig,
    error: OidcLoginError,
    userId: Id<'usr'> | null,
    meta: RequestMeta,
  ): Promise<Resolution> {
    await auditForUser(tx, this.organizations, userId, {
      action: 'auth.login_failed',
      entityType: 'user',
      entityId: userId,
      after: { reason: error, method: 'oidc', provider: provider.slug },
      context: auditContextOf(meta, { type: 'system', id: null }),
    });
    this.logger.warn(
      { provider: provider.slug, result: error, ...(userId === null ? {} : { user_id: userId }) },
      'oidc sign-in failed',
    );
    return { kind: 'failed', error };
  }

  /** A failure before any user is known: audit without organization, log, metric. */
  private async fail(
    provider: OidcProviderConfig,
    error: OidcLoginError,
    userId: Id<'usr'> | null,
    meta: RequestMeta,
    details: {
      readonly reason: string;
      readonly libraryCode?: string | null;
      readonly oauthError?: string | null;
    },
  ): Promise<OidcCallbackResult> {
    await this.db.withTx(async (tx) => {
      await auditForUser(tx, this.organizations, userId, {
        action: 'auth.login_failed',
        entityType: 'user',
        entityId: userId,
        after: { reason: error, method: 'oidc', provider: provider.slug },
        context: auditContextOf(meta, { type: 'system', id: null }),
      });
    });
    this.count(provider, error);
    this.logger.warn(
      {
        provider: provider.slug,
        result: error,
        reason: details.reason,
        ...(details.libraryCode == null ? {} : { library_code: details.libraryCode }),
        ...(details.oauthError == null ? {} : { oauth_error: details.oauthError }),
      },
      'oidc sign-in failed',
    );
    return loginFailure(error);
  }

  private logFailure(provider: OidcProviderConfig, error: OidcLoginError, failure: OidcFailure) {
    this.logger.warn(
      {
        provider: provider.slug,
        result: error,
        reason: failure.reason,
        ...(failure.libraryCode === null ? {} : { library_code: failure.libraryCode }),
      },
      'oidc sign-in could not start',
    );
  }

  private count(
    provider: OidcProviderConfig,
    result: OidcLoginError | OidcLinkError | 'success' | 'linked',
  ): void {
    this.callbacks.inc({ provider: provider.slug, result: result.toLowerCase() });
  }
}
