import { z } from 'zod';

import { idOf } from '../../ids.js';
import {
  createdShareLinkSchema,
  createShareLinkRequestSchema,
  orgShareLinkListQuerySchema,
  revokeShareLinksRequestSchema,
  revokeShareLinksResponseSchema,
  shareLinkListQuerySchema,
  shareLinkListSchema,
  shareLinkPreviewSchema,
  shareLinkSchema,
  updateShareLinkRequestSchema,
} from '../../share-links.js';
import { problemResponse, type RouteRegistrar } from '../types.js';

import { register, type RouteSpec } from './route-spec.js';

const viewParams = z.object({ viewId: idOf('viw') });
const dashboardParams = z.object({ dashboardId: idOf('dsh') });
const linkParams = z.object({ shareLinkId: idOf('shl') });
const baseParams = z.object({ baseId: idOf('bse') });
const orgParams = z.object({ orgId: idOf('org') });

const MANAGE =
  'Managing the links of a view needs to see the view (else `404`) and the right to share: ' +
  'base owner, role `admin` or `base_rule.share_link = true` (else `403 PERMISSION_DENIED`).';
const MANAGE_DASHBOARD =
  'Managing the link of a dashboard (T809) needs to read the dashboard (else `404`) and the ' +
  'right to share: base owner, role `admin` or `base_rule.share_link = true` (else `403 ' +
  'PERMISSION_DENIED`).';
const TOKEN_ONCE =
  'The response is the only place the token ever appears (it is stored as a SHA-256 hash and ' +
  'a six-character prefix, never logged or audited).';
const PUBLIC =
  '`PUBLIC_SHARING_DISABLED` when `audience = public` and the organization policy ' +
  '(`settings.public_sharing`) does not allow it for this target';
const SETTINGS_422 =
  '`VALIDATION_FAILED`: `EMBED_NOT_SUPPORTED` (`settings.embed.enabled` on a link that is not ' +
  '`public` or has a password), `INVALID_ORIGIN` (`settings.embed.allowed_origins[i]` not ' +
  '`https://host[:port]`, or no origin while embedding is on), `OUT_OF_RANGE` (`expires_at` ' +
  'not in the future, `settings.dashboard.refresh_seconds` outside 30–3600)';
const REVOKE_EVENT = 'Each revoked link emits `share_link.revoked` with its audit entry.';

/** Share links (SPEC §15A, CONTRACTS §16; BACKLOG T304). */
export const registerShareLinkRoutes: RouteRegistrar = (registry, components) => {
  const problem = (description: string) => problemResponse(components, description);
  const add = (spec: RouteSpec) => {
    register(registry, problem, spec);
  };

  add({
    method: 'get',
    path: '/api/v1/views/{viewId}/share-links',
    operationId: 'listViewShareLinks',
    tag: 'share-links',
    summary: 'The link of a view (at most one that is not revoked)',
    description: MANAGE,
    params: viewParams,
    status: 200,
    response: shareLinkListSchema,
  });
  add({
    method: 'get',
    path: '/api/v1/views/{viewId}/share-links/preview',
    operationId: 'previewShareLink',
    tag: 'share-links',
    summary: 'What people outside would see through a link of this view',
    description:
      `${MANAGE} Record count and fields reachable through a link created by the caller now ` +
      '(caller’s access ∩ view filter, fields hidden in the view left out; a form: the fields ' +
      'it may create). Shown as a warning before sharing (SPEC §15A.1).',
    params: viewParams,
    status: 200,
    response: shareLinkPreviewSchema,
    errors: { 422: '`VALIDATION_FAILED` / `PERSONAL_VIEW`' },
  });
  add({
    method: 'post',
    path: '/api/v1/views/{viewId}/share-links',
    operationId: 'createShareLink',
    tag: 'share-links',
    summary: 'Create the link of a view or form',
    description:
      `${MANAGE} \`target_type\` is \`form\` for a form view, \`view\` otherwise; personal views ` +
      'cannot be shared. A previous link of the view is revoked in the same transaction. ' +
      `${TOKEN_ONCE} Emits \`share_link.created\` with its audit entry.`,
    params: viewParams,
    body: createShareLinkRequestSchema,
    bodyOptional: true,
    status: 201,
    response: createdShareLinkSchema,
    forbidden: `\`PERMISSION_DENIED\`, ${PUBLIC}, or \`CSRF_INVALID\``,
    errors: { 422: `${SETTINGS_422}, \`PERSONAL_VIEW\`` },
  });
  add({
    method: 'get',
    path: '/api/v1/dashboards/{dashboardId}/share-links',
    operationId: 'listDashboardShareLinks',
    tag: 'share-links',
    summary: 'The link of a dashboard (at most one that is not revoked)',
    description: MANAGE_DASHBOARD,
    params: dashboardParams,
    status: 200,
    response: shareLinkListSchema,
  });
  add({
    method: 'post',
    path: '/api/v1/dashboards/{dashboardId}/share-links',
    operationId: 'createDashboardShareLink',
    tag: 'share-links',
    summary: 'Create the link of a dashboard',
    description:
      `${MANAGE_DASHBOARD} \`target_type\` is \`dashboard\`, \`table_id\` \`null\`. The link ` +
      "reads with its creator's **current** access ∩ the tables of the dashboard; it answers " +
      '`410` once the creator no longer reads the dashboard or may not share. A previous link ' +
      `of the dashboard is revoked in the same transaction. ${TOKEN_ONCE} Emits ` +
      '`share_link.created` with its audit entry.',
    params: dashboardParams,
    body: createShareLinkRequestSchema,
    bodyOptional: true,
    status: 201,
    response: createdShareLinkSchema,
    forbidden: `\`PERMISSION_DENIED\`, ${PUBLIC}, or \`CSRF_INVALID\``,
    errors: { 422: SETTINGS_422 },
  });
  add({
    method: 'get',
    path: '/api/v1/share-links/{shareLinkId}',
    operationId: 'getShareLink',
    tag: 'share-links',
    summary: 'A link (never its token)',
    description: `${MANAGE} Base admins also see links whose target was deleted. Revoked links are \`404\`.`,
    params: linkParams,
    status: 200,
    response: shareLinkSchema,
  });
  add({
    method: 'patch',
    path: '/api/v1/share-links/{shareLinkId}',
    operationId: 'updateShareLink',
    tag: 'share-links',
    summary: 'Change audience, password, expiry, settings or turn a link on/off',
    description:
      `${MANAGE} \`password: null\` removes the password. Emits \`share_link.updated\` with its ` +
      'audit entry (keys that changed; never the password or the token).',
    params: linkParams,
    body: updateShareLinkRequestSchema,
    status: 200,
    response: shareLinkSchema,
    forbidden: `\`PERMISSION_DENIED\`, ${PUBLIC}, or \`CSRF_INVALID\``,
    errors: { 422: SETTINGS_422 },
  });
  add({
    method: 'delete',
    path: '/api/v1/share-links/{shareLinkId}',
    operationId: 'revokeShareLink',
    tag: 'share-links',
    summary: 'Revoke a link for good (its token then answers `410`)',
    description: `${MANAGE} Base admins may also revoke links whose target was deleted. ${REVOKE_EVENT}`,
    params: linkParams,
    status: 204,
  });
  add({
    method: 'post',
    path: '/api/v1/share-links/{shareLinkId}/regenerate',
    operationId: 'regenerateShareLink',
    tag: 'share-links',
    summary: 'Replace the token of a link',
    description:
      `${MANAGE} Revokes the link (the old token answers \`410\`) and creates a copy with a new ` +
      `token and id, created by the caller. ${TOKEN_ONCE}`,
    params: linkParams,
    status: 201,
    response: createdShareLinkSchema,
    forbidden: `\`PERMISSION_DENIED\`, ${PUBLIC}, or \`CSRF_INVALID\``,
  });
  add({
    method: 'get',
    path: '/api/v1/bases/{baseId}/share-links',
    operationId: 'listBaseShareLinks',
    tag: 'share-links',
    summary: 'Links of a base that are not revoked (base admins)',
    description:
      'Newest first. Base owner, role `admin`, workspace admin, organization owner/admin; ' +
      'other members of the base get `403`.',
    params: baseParams,
    query: shareLinkListQuerySchema,
    status: 200,
    response: shareLinkListSchema,
  });
  add({
    method: 'post',
    path: '/api/v1/bases/{baseId}/share-links/revoke',
    operationId: 'revokeBaseShareLinks',
    tag: 'share-links',
    summary: 'Revoke several links of a base (base admins)',
    description: `Ids of other bases, unknown or already revoked are skipped. ${REVOKE_EVENT}`,
    params: baseParams,
    body: revokeShareLinksRequestSchema,
    status: 200,
    response: revokeShareLinksResponseSchema,
  });
  add({
    method: 'get',
    path: '/api/v1/orgs/{orgId}/share-links',
    operationId: 'listOrgShareLinks',
    tag: 'share-links',
    summary: 'Links of the organization that are not revoked (owners/admins)',
    description:
      'Newest first, with target, audience, creator and last access. Anyone else, members ' +
      'included, gets `404`.',
    params: orgParams,
    query: orgShareLinkListQuerySchema,
    status: 200,
    response: shareLinkListSchema,
  });
  add({
    method: 'post',
    path: '/api/v1/orgs/{orgId}/share-links/revoke',
    operationId: 'revokeOrgShareLinks',
    tag: 'share-links',
    summary: 'Revoke several links of the organization (owners/admins)',
    description: `Members get \`404\`. Unknown or already revoked ids are skipped. ${REVOKE_EVENT}`,
    params: orgParams,
    body: revokeShareLinksRequestSchema,
    status: 200,
    response: revokeShareLinksResponseSchema,
  });
};
