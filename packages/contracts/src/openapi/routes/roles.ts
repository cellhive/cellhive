import { z } from 'zod';

import { idOf } from '../../ids.js';
import { offsetQuerySchema } from '../../pagination.js';
import {
  assignRoleRequestSchema,
  createRoleRequestSchema,
  removeRoleAssignmentRequestSchema,
  roleAssignmentSchema,
  roleListSchema,
  roleSchema,
  roleWithAdjustmentsSchema,
  updateRoleRequestSchema,
} from '../../roles.js';
import { problemResponse, type RouteRegistrar } from '../types.js';

import { register, type RouteSpec } from './route-spec.js';

const baseParams = z.object({ baseId: idOf('bse') });
const roleParams = z.object({ baseId: idOf('bse'), roleId: idOf('rol') });

const BASE_ADMIN =
  'Base admins only (role `admin`, base owner, workspace admin, organization owner/admin); ' +
  'other users who can open the base get `403 PERMISSION_DENIED`.';
const BUMPS =
  'Increases the base `permission_version` and emits `permission.changed` (CONTRACTS §8).';
const CONFIG_ERRORS =
  '`VALIDATION_FAILED` (`errors[].code` `UNKNOWN_TABLE` / `UNKNOWN_FIELD` for IDs that are ' +
  'not active tables/fields of the base, `UNKNOWN_VIEW` for a `visible_views` entry that is ' +
  'a personal view or a view of another table — entries naming deleted or never existing ' +
  'views are dropped silently —, `UNKNOWN_DASHBOARD` for a `dashboards` entry that is not a ' +
  'dashboard of the base, active or in its trash — entries the stored config already lists ' +
  'whose dashboard was purged are dropped silently —, or a schema detail code with a path ' +
  'under `config`); ' +
  '`INVALID_FILTER` for a record filter that does not validate against its table';
const NORMALIZED =
  'The config is validated and normalised (SPEC §14.1): computed fields are capped at `read`, ' +
  'fields used by record filters are raised to `read` (`create` when the role can add), ' +
  '`operations` need `edit`/`manage`, and system `editor`/`reader` keep their ceilings. The ' +
  'response lists every automatic change in `adjustments`.';

/** Base roles and role assignments (SPEC §13.1, §14.1; BACKLOG T109). */
export const registerRoleRoutes: RouteRegistrar = (registry, components) => {
  const problem = (description: string) => problemResponse(components, description);
  const add = (spec: RouteSpec) => {
    register(registry, problem, spec);
  };

  add({
    method: 'get',
    path: '/api/v1/bases/{baseId}/roles',
    operationId: 'listRoles',
    tag: 'roles',
    summary: 'Roles of a base with their configs and assignments',
    description: `${BASE_ADMIN} System roles first, then custom roles by position.`,
    params: baseParams,
    query: offsetQuerySchema,
    status: 200,
    response: roleListSchema,
  });
  add({
    method: 'post',
    path: '/api/v1/bases/{baseId}/roles',
    operationId: 'createRole',
    tag: 'roles',
    summary: 'Create a custom role',
    description: `${BASE_ADMIN} ${NORMALIZED} ${BUMPS}`,
    params: baseParams,
    body: createRoleRequestSchema,
    status: 201,
    response: roleWithAdjustmentsSchema,
    errors: {
      409: '`NAME_CONFLICT`: another role of the base has this name (case-insensitive)',
      422: CONFIG_ERRORS,
    },
  });
  add({
    method: 'get',
    path: '/api/v1/bases/{baseId}/roles/{roleId}',
    operationId: 'getRole',
    tag: 'roles',
    summary: 'A role of the base',
    description: BASE_ADMIN,
    params: roleParams,
    status: 200,
    response: roleSchema,
  });
  add({
    method: 'patch',
    path: '/api/v1/bases/{baseId}/roles/{roleId}',
    operationId: 'updateRole',
    tag: 'roles',
    summary: 'Rename a role or replace its config',
    description:
      `${BASE_ADMIN} ${NORMALIZED} System roles can be renamed; the config of \`editor\` and ` +
      '`reader` can change within their ceilings; the config of `admin` cannot change ' +
      `(\`422 VALIDATION_FAILED\`, \`SYSTEM_ROLE\`). ${BUMPS}`,
    params: roleParams,
    body: updateRoleRequestSchema,
    status: 200,
    response: roleWithAdjustmentsSchema,
    errors: {
      409: '`NAME_CONFLICT`: another role of the base has this name (case-insensitive)',
      422: `${CONFIG_ERRORS}; \`VALIDATION_FAILED\` / \`SYSTEM_ROLE\``,
    },
  });
  add({
    method: 'delete',
    path: '/api/v1/bases/{baseId}/roles/{roleId}',
    operationId: 'deleteRole',
    tag: 'roles',
    summary: 'Delete a custom role',
    description:
      `${BASE_ADMIN} System roles cannot be deleted (\`SYSTEM_ROLE\`); a role that is still ` +
      `assigned cannot be deleted (\`ROLE_IN_USE\`, \`errors[].params.assignments\`). ${BUMPS}`,
    params: roleParams,
    status: 204,
    errors: { 422: '`VALIDATION_FAILED` / `SYSTEM_ROLE` or `ROLE_IN_USE`' },
  });
  add({
    method: 'put',
    path: '/api/v1/bases/{baseId}/role-assignments',
    operationId: 'assignRole',
    tag: 'roles',
    summary: 'Give a user or group a role in the base (replaces its previous role)',
    description:
      `${BASE_ADMIN} A user must be a member of the organization, a group one of its groups ` +
      '(`UNKNOWN_PRINCIPAL`); `role_id` must be a role of the base (`UNKNOWN_ROLE`). Each ' +
      `principal has exactly one role per base. Emits \`role_assignment.changed\`. ${BUMPS}`,
    params: baseParams,
    body: assignRoleRequestSchema,
    status: 200,
    response: roleAssignmentSchema,
    errors: { 422: '`VALIDATION_FAILED` / `UNKNOWN_PRINCIPAL` or `UNKNOWN_ROLE`' },
  });
  add({
    method: 'delete',
    path: '/api/v1/bases/{baseId}/role-assignments',
    operationId: 'removeRoleAssignment',
    tag: 'roles',
    summary: 'Remove the role of a user or group in the base',
    description:
      `${BASE_ADMIN} \`404\` when the principal has no role in the base. Emits ` +
      `\`role_assignment.changed\`. ${BUMPS}`,
    params: baseParams,
    body: removeRoleAssignmentRequestSchema,
    status: 204,
  });
};
