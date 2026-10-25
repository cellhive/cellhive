import { z } from 'zod';

import {
  apiTokenIdSchema,
  apiTokenListQuerySchema,
  apiTokenListSchema,
  apiTokenSchema,
  createApiTokenRequestSchema,
  createdApiTokenSchema,
  orgApiTokenListQuerySchema,
  orgApiTokenListSchema,
  updateApiTokenRequestSchema,
} from '../../api-tokens.js';
import { idOf } from '../../ids.js';
import { problemResponse, type RouteRegistrar } from '../types.js';

import { register, type RouteSpec } from './route-spec.js';

const orgParams = z.object({ orgId: idOf('org') });
const tokenParams = z.object({ apiTokenId: apiTokenIdSchema });

const SESSION_ONLY = 'Session only: an API token can never manage tokens.';

/** Personal API tokens — management (CONTRACTS §26.4; BACKLOG T703, ADR-36 §1). */
export const registerApiTokenRoutes: RouteRegistrar = (registry, components) => {
  const problem = (description: string) => problemResponse(components, description);
  const add = (spec: RouteSpec) => {
    register(registry, problem, spec);
  };

  add({
    method: 'get',
    path: '/api/v1/orgs/{orgId}/me/api-tokens',
    operationId: 'listMyApiTokens',
    tag: 'api-tokens',
    summary: 'List my API tokens in an organization, newest first',
    description:
      `${SESSION_ONLY} Metadata only (never the token or its hash); revoked and expired tokens ` +
      'stay listed 90 days. Cursor pagination.',
    params: orgParams,
    query: apiTokenListQuerySchema,
    status: 200,
    response: apiTokenListSchema,
  });
  add({
    method: 'post',
    path: '/api/v1/orgs/{orgId}/me/api-tokens',
    operationId: 'createApiToken',
    tag: 'api-tokens',
    summary: 'Create a personal API token (shown once)',
    description:
      `${SESSION_ONLY} The response is the only place the token appears. Its rights are the ` +
      "caller's current rights ∩ `scopes` ∩ `base_ids` in this organization. At most 50 tokens " +
      'not revoked per member. Audited as `api_token.created` (name, prefix, scopes, bases, ' +
      'expiry).',
    params: orgParams,
    body: createApiTokenRequestSchema,
    status: 201,
    response: createdApiTokenSchema,
    forbidden: '`API_TOKENS_DISABLED`: the organization turned API tokens off, or `CSRF_INVALID`',
    errors: {
      404:
        '`NOT_FOUND`: not a member of the organization, or a base of `base_ids` does not exist ' +
        'or is not readable (`errors[].path` = `base_ids[i]`)',
      422:
        '`VALIDATION_FAILED`: malformed body (unknown scope included) or `errors[].code` ' +
        '`OUT_OF_RANGE` (path `expires_at`: not in the future or more than 3650 days away), ' +
        '`TOKEN_LIFETIME_EXCEEDED` (path `expires_at`, `params.max_lifetime_days`), ' +
        '`TOO_MANY_TOKENS` (`params.maximum`)',
    },
  });
  add({
    method: 'get',
    path: '/api/v1/orgs/{orgId}/api-tokens',
    operationId: 'listOrgApiTokens',
    tag: 'api-tokens',
    summary: 'List every API token of an organization (owners/admins)',
    description:
      `${SESSION_ONLY} Organization owner/admin only. Metadata only, with the owner of each ` +
      'token. Cursor pagination; filter by `user_id` and `status`.',
    params: orgParams,
    query: orgApiTokenListQuerySchema,
    status: 200,
    response: orgApiTokenListSchema,
    forbidden: '`PERMISSION_DENIED`: the caller is a member but not an owner/admin',
  });
  add({
    method: 'patch',
    path: '/api/v1/api-tokens/{apiTokenId}',
    operationId: 'updateApiToken',
    tag: 'api-tokens',
    summary: 'Rename my API token',
    description:
      `${SESSION_ONLY} The owner only; an organization owner/admin gets \`403\`, anyone else ` +
      '`404`. Audited as `api_token.updated`.',
    params: tokenParams,
    body: updateApiTokenRequestSchema,
    status: 200,
    response: apiTokenSchema,
  });
  add({
    method: 'delete',
    path: '/api/v1/api-tokens/{apiTokenId}',
    operationId: 'revokeApiToken',
    tag: 'api-tokens',
    summary: 'Revoke an API token',
    description:
      `${SESSION_ONLY} The owner, or an owner/admin of its organization; anyone else gets ` +
      '`404`. The token stops authenticating at once (`401 TOKEN_REVOKED`) and its WebSocket ' +
      'connections close; it stays listed 90 days. Revoking again changes nothing. Audited as ' +
      '`api_token.revoked`.',
    params: tokenParams,
    status: 204,
  });
};
