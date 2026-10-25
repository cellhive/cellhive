import {
  API_TOKEN_LAST_USED_INTERVAL_MS,
  ApiTokensRepository,
  apiTokenPolicyOf,
  findApiTokenByHash,
  hashApiToken,
  orgScope,
  parseApiToken,
  type Db,
} from '@cellhive/server-core';
import { AppError } from '@cellhive/server-core/errors';
import { Inject, Injectable } from '@nestjs/common';

import { AppLogger } from '../logging/app-logger.js';
import { DB } from '../tokens.js';

import type { ApiTokenPrincipal } from './principal.js';

/** `WWW-Authenticate` of every `401` answered on the Bearer path (RFC 6750 §3, ADR-36 §1). */
export const BEARER_CHALLENGE = 'Bearer error="invalid_token"';

/**
 * `Authorization: Bearer <token>` (scheme case-insensitive, RFC 7235 §2.1);
 * `undefined` for another scheme or a malformed header.
 */
export function bearerTokenOf(authorization: string): string | undefined {
  const match = /^Bearer +([^\s]+) *$/iu.exec(authorization);
  return match?.[1];
}

function unauthenticated(): AppError {
  return new AppError('UNAUTHENTICATED', { detail: 'Invalid API token.' });
}

/**
 * Resolves an API token into its principal (CONTRACTS §26.1, ADR-36 §1,
 * BACKLOG T704), for `AuthGuard` and the WebSocket handshake (T706):
 *
 * 1. `parseApiToken`: malformed or wrong checksum → `401 UNAUTHENTICATED`
 *    without touching the database;
 * 2. SHA-256 → `findApiTokenByHash` (the one cross-tenant lookup, S§14.1),
 *    then everything else read inside the token's organization, in one
 *    query;
 * 3. revoked → `401 TOKEN_REVOKED`, expired → `401 TOKEN_EXPIRED`; tokens
 *    turned off by the organization, a user who is not `active` or no longer
 *    a member → `401 UNAUTHENTICATED`.
 *
 * The token value is never logged; its id is.
 */
@Injectable()
export class ApiTokenAuthService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ApiTokensRepository) private readonly tokens: ApiTokensRepository,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  async authenticate(token: string): Promise<ApiTokenPrincipal> {
    if (parseApiToken(token) !== 'ok') throw unauthenticated();
    const match = await findApiTokenByHash(this.db.kysely, hashApiToken(token));
    if (match === undefined) throw unauthenticated();
    const scope = orgScope(match.organization_id);
    const found = await this.tokens.findForAuthentication(scope, match.id);
    if (found === undefined) throw unauthenticated();
    if (found.revoked) {
      throw new AppError('TOKEN_REVOKED', { detail: 'This API token was revoked.' });
    }
    if (found.expired) {
      throw new AppError('TOKEN_EXPIRED', { detail: 'This API token expired.' });
    }
    if (
      !apiTokenPolicyOf(found.orgSettings).enabled ||
      found.user.status !== 'active' ||
      !found.isMember
    ) {
      throw unauthenticated();
    }
    if (
      found.lastUsedAt === null ||
      Date.now() - found.lastUsedAt.getTime() >= API_TOKEN_LAST_USED_INTERVAL_MS
    ) {
      try {
        await this.tokens.touchLastUsed(scope, found.id);
      } catch (error) {
        // Bookkeeping only: the request goes on.
        this.logger.warn({ err: error, token_id: found.id }, 'api token last_used_at not written');
      }
    }
    return {
      kind: 'api_token',
      userId: found.user.id,
      user: found.user,
      organizationId: match.organization_id,
      tokenId: found.id,
      scopes: found.scopes,
      baseIds: found.baseIds,
    };
  }
}
