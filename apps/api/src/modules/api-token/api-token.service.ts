import {
  API_TOKEN_MAX_LIFETIME_DAYS,
  API_TOKEN_SCOPES,
  API_TOKENS_MAX_PER_USER,
  newId,
  TOKEN_LIFETIME_EXCEEDED,
  TOO_MANY_TOKENS,
  type ApiTokenDto,
  type ApiTokenList,
  type ApiTokenListQuery,
  type ApiTokenPolicy,
  type CreateApiTokenRequest,
  type CreatedApiToken,
  type Id,
  type OrgApiTokenList,
  type OrgApiTokenListQuery,
  type UpdateApiTokenRequest,
} from '@cellhive/contracts';
import {
  apiTokenPolicyOf,
  ApiTokensRepository,
  AuditWriter,
  decodeCursor,
  generateApiToken,
  orgScope,
  publishApiTokensRevoked,
  type ApiTokenRow,
  type AuditContext,
  type Db,
  type JsonObject,
  type Tx,
} from '@cellhive/server-core';
import { AppError } from '@cellhive/server-core/errors';
import { Inject, Injectable } from '@nestjs/common';

import {
  AccessService,
  notFound,
  permissionDenied,
  type OrgAccess,
} from '../../common/access/access.service.js';
import { mutationContextOf, recordChange } from '../../common/access/change-log.js';
import { type RequestMeta } from '../../common/auth/request-meta.js';
import { iso, isoOrNull, validationFailed } from '../../common/dto.js';
import { DB } from '../../common/tokens.js';

import type { Principal } from '../../common/auth/principal.js';

const DAY_MS = 86_400_000;

/** Audit/event snapshot of a token (CONTRACTS §8): never its value or hash. */
function snapshotOf(token: ApiTokenRow): JsonObject {
  return {
    user_id: token.user_id,
    name: token.name,
    token_prefix: token.token_prefix,
    scopes: token.scopes,
    base_ids: token.base_ids,
    expires_at: isoOrNull(token.expires_at),
  };
}

function dtoOf(row: ApiTokenRow): ApiTokenDto {
  return {
    id: row.id,
    name: row.name,
    token_prefix: row.token_prefix,
    scopes: row.scopes,
    base_ids: row.base_ids,
    expires_at: isoOrNull(row.expires_at),
    last_used_at: isoOrNull(row.last_used_at),
    revoked_at: isoOrNull(row.revoked_at),
    created_at: iso(row.created_at),
  };
}

/**
 * `expires_at` of a new token: in the future, at most 3,650 days away, and
 * within `max_lifetime_days` of the policy (which also rules out `null`).
 */
function checkExpiry(expiresAt: string | null, policy: ApiTokenPolicy, now: number): void {
  const at = expiresAt === null ? null : Date.parse(expiresAt);
  if (at !== null && (at <= now || at > now + API_TOKEN_MAX_LIFETIME_DAYS * DAY_MS)) {
    throw validationFailed(
      `The expiry must be in the future and at most ${String(API_TOKEN_MAX_LIFETIME_DAYS)} days away.`,
      { path: 'expires_at', code: 'OUT_OF_RANGE' },
    );
  }
  const limit = policy.max_lifetime_days;
  if (limit !== null && (at === null || at > now + limit * DAY_MS)) {
    throw validationFailed(
      `This organization requires API tokens to expire within ${String(limit)} days.`,
      { path: 'expires_at', code: TOKEN_LIFETIME_EXCEEDED, params: { max_lifetime_days: limit } },
    );
  }
}

const audit = new AuditWriter();

/**
 * Personal API tokens — management (BACKLOG T703, CONTRACTS §26.4, ADR-36
 * §1). Session only (T704 refuses tokens on these routes).
 *
 * - A member creates, lists and renames their own tokens of an
 *   organization; the token value is in the create response only.
 * - The owner or an organization owner/admin revokes a token (soft:
 *   `revoked_at`); anyone else — and anyone in another organization — gets
 *   `404`. Revocation publishes `api_token.revoked` after commit.
 * - Organization owners/admins list every token of the organization
 *   (metadata only).
 *
 * Events + audit `api_token.created|revoked`, audit `api_token.updated`.
 */
@Injectable()
export class ApiTokenService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(ApiTokensRepository) private readonly tokens: ApiTokensRepository,
  ) {}

  async listMine(
    principal: Principal,
    organizationId: Id<'org'>,
    query: ApiTokenListQuery,
  ): Promise<ApiTokenList> {
    const org = await this.access.requireOrg(principal, organizationId);
    const page = await this.tokens.listPage(
      org.scope,
      { userId: principal.userId, ...(query.status === undefined ? {} : { status: query.status }) },
      { cursor: decodeCursor(query.cursor), limit: query.limit },
    );
    return { items: page.items.map(dtoOf), next_cursor: page.nextCursor };
  }

  async listOrg(
    principal: Principal,
    organizationId: Id<'org'>,
    query: OrgApiTokenListQuery,
  ): Promise<OrgApiTokenList> {
    const org = await this.access.requireOrgAdmin(principal, organizationId);
    const page = await this.tokens.listPage(
      org.scope,
      {
        ...(query.user_id === undefined ? {} : { userId: query.user_id }),
        ...(query.status === undefined ? {} : { status: query.status }),
      },
      { cursor: decodeCursor(query.cursor), limit: query.limit },
    );
    return {
      items: page.items.map((row) => ({
        ...dtoOf(row),
        user: { id: row.user_id, display_name: row.user_display_name },
      })),
      next_cursor: page.nextCursor,
    };
  }

  async create(
    principal: Principal,
    organizationId: Id<'org'>,
    body: CreateApiTokenRequest,
    meta: RequestMeta,
  ): Promise<CreatedApiToken> {
    const org = await this.access.requireOrg(principal, organizationId);
    const policy = apiTokenPolicyOf(org.membership.settings);
    if (!policy.enabled) {
      throw new AppError('API_TOKENS_DISABLED', {
        detail: 'API tokens are turned off for this organization.',
      });
    }
    checkExpiry(body.expires_at, policy, Date.now());
    await this.checkBases(principal, org, body.base_ids);
    const generated = generateApiToken();
    const context = mutationContextOf(meta, principal.userId);
    const created = await this.db.withTx(async (tx) => {
      const scope = orgScope(organizationId, tx);
      // One creation at a time per member: the count and the insert agree.
      if (!(await this.tokens.lockOwner(scope, principal.userId))) throw notFound();
      if ((await this.tokens.countNotRevoked(scope, principal.userId)) >= API_TOKENS_MAX_PER_USER) {
        throw validationFailed(
          `A member has at most ${String(API_TOKENS_MAX_PER_USER)} API tokens that are not revoked.`,
          { path: '', code: TOO_MANY_TOKENS, params: { maximum: API_TOKENS_MAX_PER_USER } },
        );
      }
      const row = await this.tokens.create(scope, {
        id: newId('tok'),
        user_id: principal.userId,
        name: body.name,
        token_prefix: generated.prefix,
        token_hash: generated.hash,
        // Canonical order, duplicates dropped.
        scopes: API_TOKEN_SCOPES.filter((item) => body.scopes.includes(item)),
        base_ids: body.base_ids === null ? null : [...new Set(body.base_ids)],
        expires_at: body.expires_at,
      });
      await this.change(tx, row, 'api_token.created', context, { after: snapshotOf(row) });
      return row;
    });
    return { ...dtoOf(created), token: generated.token };
  }

  async rename(
    principal: Principal,
    tokenId: Id<'tok'>,
    body: UpdateApiTokenRequest,
    meta: RequestMeta,
  ): Promise<ApiTokenDto> {
    const { token } = await this.requireToken(principal, tokenId);
    if (token.user_id !== principal.userId) {
      throw permissionDenied('Only the owner of an API token can rename it.');
    }
    const context = mutationContextOf(meta, principal.userId);
    const row = await this.db.withTx(async (tx) => {
      const scope = orgScope(token.organization_id, tx);
      const locked = await this.tokens.findById(scope, tokenId, { forUpdate: true });
      if (locked === undefined) throw notFound();
      if (locked.name === body.name) return locked;
      const renamed = await this.tokens.rename(scope, tokenId, body.name);
      if (renamed === undefined) throw notFound();
      await audit.write(tx, {
        action: 'api_token.updated',
        organizationId: renamed.organization_id,
        baseId: null,
        entityType: 'api_token',
        entityId: renamed.id,
        before: { name: locked.name },
        after: { name: renamed.name },
        context,
      });
      return renamed;
    });
    return dtoOf(row);
  }

  /** Soft revocation; revoking a revoked token again changes nothing (`204`). */
  async revoke(principal: Principal, tokenId: Id<'tok'>, meta: RequestMeta): Promise<void> {
    const { token } = await this.requireToken(principal, tokenId);
    const context = mutationContextOf(meta, principal.userId);
    await this.db.withTx(async (tx) => {
      const revoked = await this.tokens.revoke(
        orgScope(token.organization_id, tx),
        tokenId,
        principal.userId,
      );
      if (revoked === undefined) return;
      await this.change(tx, revoked, 'api_token.revoked', context, {
        before: snapshotOf(revoked),
      });
      await publishApiTokensRevoked(this.db, tx, revoked.organization_id, [revoked.id]);
    });
  }

  /**
   * Each base must exist in this organization and be readable by the caller
   * now; else `404` naming every offending `base_ids[i]` (no difference
   * between "missing" and "not readable").
   */
  private async checkBases(
    principal: Principal,
    org: OrgAccess,
    baseIds: readonly Id<'bse'>[] | null,
  ): Promise<void> {
    const errors = [];
    for (const [index, baseId] of (baseIds ?? []).entries()) {
      const base = await this.access.findBase(principal, baseId);
      if (base?.org.organizationId !== org.organizationId) {
        errors.push({
          path: `base_ids[${String(index)}]`,
          code: 'NOT_FOUND',
          message: 'Not found',
        });
      }
    }
    if (errors.length > 0) {
      throw new AppError('NOT_FOUND', { detail: 'A base of the token was not found.', errors });
    }
  }

  /**
   * A token of one of the caller's organizations that the caller owns or,
   * as an organization owner/admin, manages; `404` for anything else.
   */
  private async requireToken(
    principal: Principal,
    tokenId: Id<'tok'>,
  ): Promise<{ org: OrgAccess; token: ApiTokenRow }> {
    for (const membership of await this.access.memberships(principal)) {
      const org = await this.access.requireOrg(principal, membership.organizationId);
      const token = await this.tokens.findById(org.scope, tokenId);
      if (token === undefined) continue;
      if (token.user_id !== principal.userId && !org.isAdmin) throw notFound();
      return { org, token };
    }
    throw notFound();
  }

  private async change(
    tx: Tx,
    token: ApiTokenRow,
    type: 'api_token.created' | 'api_token.revoked',
    context: AuditContext,
    values: { readonly before?: JsonObject; readonly after?: JsonObject },
  ): Promise<void> {
    await recordChange(tx, {
      type,
      organizationId: token.organization_id,
      entityType: 'api_token',
      entityId: token.id,
      context,
      before: values.before ?? null,
      after: values.after ?? null,
      data: { user_id: token.user_id },
    });
  }
}
