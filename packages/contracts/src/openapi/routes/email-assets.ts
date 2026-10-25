import { z } from 'zod';

import { ATTACHMENT_DOWNLOAD_URL_SECONDS, createUploadResponseSchema } from '../../attachments.js';
import {
  EMAIL_ASSET_UNUSED_TTL_HOURS,
  EMAIL_IMAGE_MAX_DIMENSION,
  EMAIL_IMAGE_MAX_UPLOAD_BYTES,
  EMAIL_INLINE_IMAGE_MAX_BYTES,
  emailAssetSchema,
  emailAssetUploadRequestSchema,
} from '../../email-assets.js';
import { idOf } from '../../ids.js';
import { problemResponse, type RouteRegistrar } from '../types.js';

import { SESSION_SECURITY_SCHEME } from './auth.js';
import { register, type RouteSpec } from './route-spec.js';

const orgParams = z.object({ orgId: idOf('org') });
const orgAssetParams = z.object({ orgId: idOf('org'), assetId: idOf('att') });
const automationParams = z.object({ automationId: idOf('aut') });
const automationAssetParams = z.object({ automationId: idOf('aut'), assetId: idOf('att') });

const MIB = 1024 * 1024;

const OWNERS = {
  org: {
    who:
      'Organization owner/admin only (a member: `403 PERMISSION_DENIED`; anyone else `404`). ' +
      'Signature images: the organization default signature and sender identity signatures ' +
      'may show them (`![alt](asset:att_…)`, at most 2 per signature).',
    tag: 'email',
    prefix: '/api/v1/orgs/{orgId}/email-assets',
    params: orgParams,
    assetParams: orgAssetParams,
    operation: 'OrgEmailAsset',
  },
  automation: {
    who:
      'People who manage the automation (base admin, or `manage` on the trigger table; one ' +
      'who sees it but does not manage it: `403`; anyone else `404`). Body images of this ' +
      'automation only (`![alt](asset:att_…)` in its `send_email` bodies).',
    tag: 'automations',
    prefix: '/api/v1/automations/{automationId}/email-assets',
    params: automationParams,
    assetParams: automationAssetParams,
    operation: 'AutomationEmailAsset',
  },
} as const;

const PROCESSING =
  `PNG, JPEG, GIF or WebP (never SVG) up to ${String(EMAIL_IMAGE_MAX_UPLOAD_BYTES / MIB)} MiB. ` +
  '`complete` checks the stored object (size, first bytes), then re-encodes it: turned ' +
  `upright, metadata (EXIF, GPS, ICC) removed, fitted inside ${String(EMAIL_IMAGE_MAX_DIMENSION)} ` +
  `× ${String(EMAIL_IMAGE_MAX_DIMENSION)} px (GIF → PNG, first frame); the result must stay ≤ ` +
  `${String(EMAIL_INLINE_IMAGE_MAX_BYTES / MIB)} MiB. Emails embed it as an inline \`cid:\` ` +
  'part, never a URL. An image nothing references is deleted ' +
  `${String(EMAIL_ASSET_UNUSED_TTL_HOURS)} hours after its upload.`;

/** Images of automation emails (CONTRACTS §23.5; BACKLOG T534). */
export const registerEmailAssetRoutes: RouteRegistrar = (registry, components) => {
  const problem = (description: string) => problemResponse(components, description);
  const add = (spec: RouteSpec) => {
    register(registry, problem, spec);
  };

  for (const owner of Object.values(OWNERS)) {
    add({
      method: 'post',
      path: `${owner.prefix}/uploads`,
      operationId: `create${owner.operation}Upload`,
      tag: owner.tag,
      summary: 'Start the upload of an email image (presigned PUT)',
      description: `${owner.who} ${PROCESSING} Returns a \`PUT\` URL like \`POST /files/uploads\`.`,
      params: owner.params,
      body: emailAssetUploadRequestSchema,
      status: 201,
      response: createUploadResponseSchema,
      errors: {
        422:
          '`VALIDATION_FAILED`: `FILE_TOO_LARGE` (`params.limit`), `MIME_NOT_ACCEPTED` ' +
          '(`params.accept`), invalid `mime`',
      },
    });
    add({
      method: 'post',
      path: `${owner.prefix}/uploads/{assetId}/complete`,
      operationId: `complete${owner.operation}Upload`,
      tag: owner.tag,
      summary: 'Finish the upload of an email image (checked and re-encoded)',
      description:
        `${owner.who} Only the uploader, for the owner the upload was started for (else ` +
        '`404`); idempotent once ready. A refused file is deleted with the upload.',
      params: owner.assetParams,
      status: 200,
      response: emailAssetSchema,
      errors: {
        422:
          '`VALIDATION_FAILED`: `UPLOAD_INCOMPLETE`, `SIZE_MISMATCH`, `CONTENT_MISMATCH`, ' +
          '`IMAGE_UNREADABLE` (`params.reason`: `unreadable`, `too_many_pixels`), ' +
          '`FILE_TOO_LARGE` (still above the limit once resized)',
      },
    });
    registry.registerPath({
      method: 'get',
      path: `${owner.prefix}/{assetId}`,
      operationId: `get${owner.operation}`,
      tags: [owner.tag],
      summary: 'An email image, for the editor preview',
      description:
        `${owner.who} Redirects to a storage URL (\`inline\`, \`Cache-Control: private, ` +
        'no-store`, `Referrer-Policy: no-referrer`). An image of another owner is `404`.',
      security: [{ [SESSION_SECURITY_SCHEME]: [] }],
      request: { params: owner.assetParams },
      responses: {
        302: {
          description: 'Redirect to the signed storage URL (`inline`)',
          headers: {
            Location: {
              description: `Signed URL, valid ${String(ATTACHMENT_DOWNLOAD_URL_SECONDS)} seconds`,
              schema: { type: 'string' as const },
            },
          },
        },
        401: problem('`UNAUTHENTICATED`'),
        403: problem('`PERMISSION_DENIED`'),
        404: problem('`NOT_FOUND`: no such image, or not visible to the caller'),
        422: problem('`VALIDATION_FAILED`: malformed id'),
      },
    });
    add({
      method: 'delete',
      path: `${owner.prefix}/{assetId}`,
      operationId: `delete${owner.operation}`,
      tag: owner.tag,
      summary: 'Delete an email image nothing shows',
      description:
        `${owner.who} Refused while a signature or the automation body still shows it ` +
        '(remove it from the Markdown first; unused images are also deleted by the cleanup).',
      params: owner.assetParams,
      status: 204,
      errors: { 422: '`VALIDATION_FAILED`: `EMAIL_IMAGE_IN_USE`' },
    });
  }
};
