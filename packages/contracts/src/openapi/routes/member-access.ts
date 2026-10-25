import { z } from 'zod';

import { idOf } from '../../ids.js';
import {
  basePrincipalListSchema,
  MEMBER_ACCESS_MAX_COUNTED_TABLES,
  memberAccessQuerySchema,
  memberAccessSchema,
  principalListQuerySchema,
} from '../../member-access.js';
import { problemResponse, type RouteRegistrar } from '../types.js';

import { register, type RouteSpec } from './route-spec.js';

const baseParams = z.object({ baseId: idOf('bse') });
const memberParams = z.object({ baseId: idOf('bse'), userId: idOf('usr') });

const BASE_ADMIN =
  'Base admins only (role `admin`, base owner, workspace admin, organization owner/admin); ' +
  'other users who can open the base get `403 PERMISSION_DENIED`. Session only. Not audited.';

/** Read-only API of the permissions UI (BACKLOG T711; CONTRACTS §5A, §14). */
export const registerMemberAccessRoutes: RouteRegistrar = (registry, components) => {
  const problem = (description: string) => problemResponse(components, description);
  const add = (spec: RouteSpec) => {
    register(registry, problem, spec);
  };

  add({
    method: 'get',
    path: '/api/v1/bases/{baseId}/members/{userId}/access',
    operationId: 'getMemberAccess',
    tag: 'roles',
    summary: "A member's effective access to the base and where it comes from",
    description:
      `${BASE_ADMIN} \`access\` is exactly what the member gets from \`GET /bases/:id\` ` +
      '(`null` when they cannot open the base); `source` follows the resolution order of ' +
      'SPEC §14.1. With `counts=true`, the records the member can read and edit are counted ' +
      `in the first ${String(MEMBER_ACCESS_MAX_COUNTED_TABLES)} visible tables with the ` +
      "member's permissions; a table whose count takes longer than 10 s is `null`. A user who " +
      'is not an active member of the organization is `404`.',
    params: memberParams,
    query: memberAccessQuerySchema,
    status: 200,
    response: memberAccessSchema,
  });
  add({
    method: 'get',
    path: '/api/v1/bases/{baseId}/principals',
    operationId: 'listBasePrincipals',
    tag: 'roles',
    summary: 'Active members and groups of the organization with their role in the base',
    description:
      `${BASE_ADMIN} For the role picker: users who left the organization or are not active ` +
      'are not listed. Ordered by name (case-insensitive), then type and ID; cursor ' +
      'pagination (CONTRACTS §1.1).',
    params: baseParams,
    query: principalListQuerySchema,
    status: 200,
    response: basePrincipalListSchema,
  });
};
