import { z } from 'zod';

import { idOf } from '../../ids.js';
import { offsetQuerySchema } from '../../pagination.js';
import {
  createViewRequestSchema,
  duplicateViewRequestSchema,
  updateViewRequestSchema,
  viewListSchema,
  viewSchema,
} from '../../views.js';
import { problemResponse, type RouteRegistrar } from '../types.js';

import { register, type RouteSpec } from './route-spec.js';

const tableParams = z.object({ tableId: idOf('tbl') });
const viewParams = z.object({ viewId: idOf('viw') });

const VISIBLE =
  'A view is visible when its table is readable and it is a shared view listed by ' +
  '`view_rule.visible_views` (`null` = every view), or the caller’s own personal view; any ' +
  'other view is `404` and never listed.';
const EDIT_SHARED =
  'Shared views need `view_rule.allow_edit` or schema rights on the table (base `admin` or ' +
  'table permission `manage`); others who can see the view get `403 PERMISSION_DENIED`. ' +
  'Personal views: their owner only.';
const EVENTS =
  'Emits `view.*` with its audit entry and `schema.changed` (entity `view`) on `table:{id}` to ' +
  'the subscribers who can see the view.';
const CONFIG_ERRORS =
  '`VALIDATION_FAILED` (`UNKNOWN_FIELD`, `DUPLICATE_FIELD`, `INVALID_FIELD_TYPE`, ' +
  '`FIELD_READ_ONLY`, `REQUIRED_FIELD_MISSING` under `config`); `INVALID_FILTER` / ' +
  '`INVALID_SORT` for a filter or sort/group item on a field that is missing or that the ' +
  'saver cannot read';
const LIMITS =
  '`VALIDATION_FAILED` / `VIEW_LIMIT_EXCEEDED` (`params.scope` `table`: 200 views per table; ' +
  '`personal`: 50 personal views per user and table)';
const NAME_CONFLICT =
  '`NAME_CONFLICT`: another shared view of the table (or another personal view of the owner) ' +
  'has this name, ignoring case';

/** Saved views (SPEC §8, CONTRACTS §15; BACKLOG T301). */
export const registerViewRoutes: RouteRegistrar = (registry, components) => {
  const problem = (description: string) => problemResponse(components, description);
  const add = (spec: RouteSpec) => {
    register(registry, problem, spec);
  };

  add({
    method: 'get',
    path: '/api/v1/tables/{tableId}/views',
    operationId: 'listViews',
    tag: 'views',
    summary: 'Views of a table the caller can see',
    description: `Shared views first, then the caller’s personal views, each by position. ${VISIBLE}`,
    params: tableParams,
    query: offsetQuerySchema,
    status: 200,
    response: viewListSchema,
  });
  add({
    method: 'post',
    path: '/api/v1/tables/{tableId}/views',
    operationId: 'createView',
    tag: 'views',
    summary: 'Create a shared or personal view',
    description:
      `${EDIT_SHARED} Anyone who can read the table may create personal views. Missing config ` +
      `keys take their defaults (a form lists every writable field the creator can read). ${EVENTS}`,
    params: tableParams,
    body: createViewRequestSchema,
    status: 201,
    response: viewSchema,
    errors: { 409: NAME_CONFLICT, 422: `${CONFIG_ERRORS}; ${LIMITS}` },
  });
  add({
    method: 'get',
    path: '/api/v1/views/{viewId}',
    operationId: 'getView',
    tag: 'views',
    summary: 'A view the caller can see',
    description: VISIBLE,
    params: viewParams,
    status: 200,
    response: viewSchema,
  });
  add({
    method: 'patch',
    path: '/api/v1/views/{viewId}',
    operationId: 'updateView',
    tag: 'views',
    summary: 'Rename, reorder, reconfigure, lock or share/unshare a view',
    description:
      `${EDIT_SHARED} \`locked\` needs schema rights on the table and applies to shared views ` +
      'only (`NOT_ALLOWED`). While a view is locked its `config` cannot change and it cannot ' +
      'become personal (`VIEW_LOCKED`). Making a shared view personal gives it to the caller, ' +
      'removes it from every role’s `visible_views` (bumping `permission_version`), and needs ' +
      `another shared view to remain (\`LAST_VIEW\`). ${EVENTS}`,
    params: viewParams,
    body: updateViewRequestSchema,
    status: 200,
    response: viewSchema,
    errors: {
      409: NAME_CONFLICT,
      422: `${CONFIG_ERRORS}; \`VALIDATION_FAILED\` / \`VIEW_LOCKED\`, \`LAST_VIEW\`, ${LIMITS}`,
    },
  });
  add({
    method: 'delete',
    path: '/api/v1/views/{viewId}',
    operationId: 'deleteView',
    tag: 'views',
    summary: 'Delete a view',
    description:
      `${EDIT_SHARED} A table keeps at least one shared view (\`LAST_VIEW\`); a locked view ` +
      'must be unlocked first (`VIEW_LOCKED`). Deleting a shared view removes it from every ' +
      `role’s \`visible_views\` and bumps \`permission_version\`. ${EVENTS}`,
    params: viewParams,
    status: 204,
    errors: { 422: '`VALIDATION_FAILED` / `LAST_VIEW` or `VIEW_LOCKED`' },
  });
  add({
    method: 'post',
    path: '/api/v1/views/{viewId}/duplicate',
    operationId: 'duplicateView',
    tag: 'views',
    summary: 'Copy a view (shared or personal)',
    description:
      `Copying into a shared view needs the rights to create shared views; anyone who sees the ` +
      'view may copy it into a personal view. The copy drops everything that names a field the ' +
      `caller cannot read, and is never locked. ${EVENTS}`,
    params: viewParams,
    body: duplicateViewRequestSchema,
    bodyOptional: true,
    status: 201,
    response: viewSchema,
    errors: { 409: NAME_CONFLICT, 422: `${CONFIG_ERRORS}; ${LIMITS}` },
  });
};
