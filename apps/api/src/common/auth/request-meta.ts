import { isIP } from 'node:net';

import { isId, type Id } from '@cellhive/contracts';

import type { Actor, AuditContext } from '@cellhive/server-core';
import type { FastifyRequest } from 'fastify';

/** Client facts recorded with sessions and audit entries. */
export interface RequestMeta {
  /** `req_…` of the request. */
  readonly requestId: string;
  /** Client IP (from `X-Forwarded-For` only behind a trusted proxy); `null` if unknown. */
  readonly ip: string | null;
  readonly userAgent: string | null;
  /**
   * The API token the request was authenticated with (ADR-36 §1), absent
   * for a session or an anonymous caller: changes its user makes carry
   * `via.api_token_id` (BACKLOG T705).
   */
  readonly apiToken?: { readonly id: Id<'tok'>; readonly userId: Id<'usr'> };
  /** Through the MCP server (`POST /api/v1/mcp`): `via.mcp` next to `via.api_token_id` (T923). */
  readonly mcp?: true;
}

export function requestMetaOf(request: FastifyRequest): RequestMeta {
  const userAgent = request.headers['user-agent'];
  const principal = request.principal;
  return {
    requestId: request.id,
    ip: isIP(request.ip) === 0 ? null : request.ip,
    userAgent: typeof userAgent === 'string' && userAgent !== '' ? userAgent : null,
    ...(principal?.kind === 'api_token'
      ? { apiToken: { id: principal.tokenId, userId: principal.userId } }
      : {}),
  };
}

/**
 * Audit context of an HTTP request (SPEC §14.4). Through an API token the
 * actor stays the token's user and `via = { api_token_id }` (ADR-36 §1, S6
 * decision #5): `updated_by`, audit filters by actor and notifications see
 * the user.
 */
export function auditContextOf(meta: RequestMeta, actor: Actor): AuditContext {
  const token = meta.apiToken;
  return {
    actor,
    via:
      token !== undefined && actor.type === 'user' && actor.id === token.userId
        ? { api_token_id: token.id, ...(meta.mcp === true ? { mcp: true as const } : {}) }
        : null,
    batch_id: null,
    request_id: isId('req', meta.requestId) ? meta.requestId : null,
    ip: meta.ip,
    user_agent: meta.userAgent,
  };
}
