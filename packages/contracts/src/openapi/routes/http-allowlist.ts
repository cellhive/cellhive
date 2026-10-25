import { z } from 'zod';

import {
  createHttpAllowlistEntryRequestSchema,
  httpAllowlistEntryIdSchema,
  httpAllowlistEntrySchema,
  httpAllowlistSchema,
} from '../../http-allowlist.js';
import { idOf } from '../../ids.js';
import { problemResponse, type RouteRegistrar } from '../types.js';

import { register, type RouteSpec } from './route-spec.js';

const orgParams = z.object({ orgId: idOf('org') });
const entryParams = z.object({ allowlistEntryId: httpAllowlistEntryIdSchema });

const ADMIN_ONLY =
  '`PERMISSION_DENIED`: the caller is a member but not an owner/admin of the organization ' +
  '(workspace and base admins included), or `CSRF_INVALID`';

/** Outbound HTTP allowlist of an organization (CONTRACTS §25.4; BACKLOG T600, ADR-35 §3). */
export const registerHttpAllowlistRoutes: RouteRegistrar = (registry, components) => {
  const problem = (description: string) => problemResponse(components, description);
  const add = (spec: RouteSpec) => {
    register(registry, problem, spec);
  };

  add({
    method: 'get',
    path: '/api/v1/orgs/{orgId}/http-allowlist',
    operationId: 'listHttpAllowlist',
    tag: 'http-allowlist',
    summary: 'List the hosts automations may call on a private network',
    description:
      'Organization owner/admin only. `private_addresses` is `HTTP_PRIVATE_ALLOWLIST` of the ' +
      'instance: with `off`, entries only allow another port on a public host.',
    params: orgParams,
    status: 200,
    response: httpAllowlistSchema,
    forbidden: ADMIN_ONLY,
  });
  add({
    method: 'post',
    path: '/api/v1/orgs/{orgId}/http-allowlist',
    operationId: 'createHttpAllowlistEntry',
    tag: 'http-allowlist',
    summary: 'Allow a host (an internal n8n) for outbound HTTP',
    description:
      'Organization owner/admin only. An exact host or `*.suffix` (at least two labels) with ' +
      'an optional `:port`, stored lower case in punycode. A matching entry lets calls to the ' +
      'host reach private addresses (loopback only through an exact host with its port) and ' +
      'use its port; cloud metadata addresses stay unreachable. At most 100 entries. Audited ' +
      'as `http_allowlist.created` (pattern, note).',
    params: orgParams,
    body: createHttpAllowlistEntryRequestSchema,
    status: 201,
    response: httpAllowlistEntrySchema,
    forbidden: ADMIN_ONLY,
    errors: {
      422:
        '`VALIDATION_FAILED`: malformed body or `errors[].code` (path `pattern`) ' +
        '`INVALID_ALLOWLIST_PATTERN` (IP address, CIDR, `*.com`, scheme, path…), ' +
        '`ALLOWLIST_ENTRY_EXISTS`, `TOO_MANY_ALLOWLIST_ENTRIES`',
    },
  });
  add({
    method: 'delete',
    path: '/api/v1/http-allowlist/{allowlistEntryId}',
    operationId: 'deleteHttpAllowlistEntry',
    tag: 'http-allowlist',
    summary: 'Remove an allowlisted host',
    description:
      'Organization owner/admin only; an entry of another organization is `404`. Calls in ' +
      'progress are not interrupted; the next call is checked without it. Audited as ' +
      '`http_allowlist.deleted`.',
    params: entryParams,
    status: 204,
    forbidden: ADMIN_ONLY,
  });
};
