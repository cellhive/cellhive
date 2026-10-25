import { z } from 'zod';

import { ATTACHMENT_DOWNLOAD_URL_SECONDS, createUploadResponseSchema } from '../../attachments.js';
import {
  FORM_COVER_MAX_BYTES,
  FORM_COVER_UNUSED_TTL_HOURS,
  formCoverSchema,
  formCoverUploadRequestSchema,
} from '../../form-covers.js';
import { shareTokenParamSchema } from '../../forms.js';
import { idOf } from '../../ids.js';
import { SHARE_FILE_RATE_LIMIT, SHARE_FILE_RATE_WINDOW_SECONDS } from '../../shares.js';
import { problemResponse, type RouteRegistrar } from '../types.js';

import { SESSION_SECURITY_SCHEME } from './auth.js';
import { register, type RouteSpec } from './route-spec.js';

const viewParams = z.object({ viewId: idOf('viw') });
const viewCoverParams = z.object({ viewId: idOf('viw'), attachmentId: idOf('att') });
const shareCoverParams = z.object({ token: shareTokenParamSchema, attachmentId: idOf('att') });

const WHO =
  'The caller must be able to change the form view’s config: its owner for a personal view, ' +
  'else `view_rule.allow_edit` or schema rights on the table (a view the caller cannot see: ' +
  '`404`; visible but not editable: `403`); a locked view is `422 VIEW_LOCKED`, a view that is ' +
  'not a form `422 NOT_ALLOWED`.';

const REDIRECT = {
  302: {
    description: 'Redirect to the signed storage URL (`inline`)',
    headers: {
      Location: {
        description: `Signed URL, valid ${String(ATTACHMENT_DOWNLOAD_URL_SECONDS)} seconds`,
        schema: { type: 'string' as const },
      },
    },
  },
};

/** Cover images of forms (CONTRACTS §15, §17; BACKLOG T419). */
export const registerFormCoverRoutes: RouteRegistrar = (registry, components) => {
  const problem = (description: string) => problemResponse(components, description);
  const add = (spec: RouteSpec) => {
    register(registry, problem, spec);
  };

  add({
    method: 'post',
    path: '/api/v1/views/{viewId}/form-cover/uploads',
    operationId: 'createFormCoverUpload',
    tag: 'forms',
    summary: 'Start the upload of a form cover image (presigned PUT)',
    description:
      `${WHO} PNG, JPEG, GIF or WebP up to ${String(FORM_COVER_MAX_BYTES / 1024 / 1024)} MB. ` +
      'Returns a `PUT` URL like `POST /files/uploads`. The cover is not in the form until ' +
      '`config.form.cover_attachment_id` names it (`PATCH /views/{viewId}`); a cover no form ' +
      `view names is deleted ${String(FORM_COVER_UNUSED_TTL_HOURS)} hours after its upload. ` +
      '`Idempotency-Key` is ignored (a retry only leaves an unused upload).',
    params: viewParams,
    body: formCoverUploadRequestSchema,
    status: 201,
    response: createUploadResponseSchema,
    errors: {
      422:
        '`VALIDATION_FAILED`: `FILE_TOO_LARGE` (`params.limit`), `MIME_NOT_ACCEPTED` ' +
        '(`params.accept`), invalid `mime`, `VIEW_LOCKED`, `NOT_ALLOWED` (not a form view)',
    },
  });
  add({
    method: 'post',
    path: '/api/v1/views/{viewId}/form-cover/uploads/{attachmentId}/complete',
    operationId: 'completeFormCoverUpload',
    tag: 'forms',
    summary: 'Finish the upload of a form cover image',
    description:
      'Only the uploader, for the view the upload was started for (anyone else: `404`). Checks ' +
      'the stored object like `POST /files/uploads/{attachmentId}/complete` (size, first bytes ' +
      'of the image type); a wrong object is deleted with the upload.',
    params: viewCoverParams,
    status: 200,
    response: formCoverSchema,
    errors: {
      422: '`VALIDATION_FAILED`: `UPLOAD_INCOMPLETE`, `SIZE_MISMATCH`, `CONTENT_MISMATCH`',
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/v1/views/{viewId}/form-cover/{attachmentId}',
    operationId: 'formCover',
    tags: ['forms'],
    summary: 'Cover image of a form view',
    description:
      'The caller must see the form view (else `404`). Served when the cover is the one the ' +
      'view’s saved config names, or an upload of the caller for a form of this table not ' +
      'named yet (the builder shows it before saving); anything else is `404`. Redirects to a ' +
      'storage URL (`inline`, `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`).',
    security: [{ [SESSION_SECURITY_SCHEME]: [] }],
    request: { params: viewCoverParams },
    responses: {
      ...REDIRECT,
      401: problem('`UNAUTHENTICATED`'),
      404: problem('`NOT_FOUND`: no such view or cover, or not visible to the caller'),
      422: problem('`VALIDATION_FAILED`: malformed id'),
      429: problem('`RATE_LIMITED` with `Retry-After`'),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/v1/shares/{token}/form-cover/{attachmentId}',
    operationId: 'sharedFormCover',
    tags: ['forms'],
    summary: 'Cover image of a form through its share link',
    description:
      `Per-IP file limit of share links (${String(SHARE_FILE_RATE_LIMIT)} requests per ` +
      `${String(SHARE_FILE_RATE_WINDOW_SECONDS)} s, unknown tokens included), then the checks ` +
      'of `GET /shares/{token}/meta`: token (`404`/`410`), audience `org` (`401`; other users ' +
      '`404`), password (`403 SHARE_PASSWORD_REQUIRED`). The link must be a form link and the ' +
      'attachment the cover its form names now, else `404`. Redirects like the member route. ' +
      'Not audited.',
    security: [{ [SESSION_SECURITY_SCHEME]: [] }, {}],
    request: { params: shareCoverParams },
    responses: {
      ...REDIRECT,
      401: problem('`UNAUTHENTICATED`: `org` link without a session'),
      403: problem(
        '`SHARE_PASSWORD_REQUIRED` (`UNLOCK_REQUIRED`): link with a password not unlocked',
      ),
      404: problem('`NOT_FOUND`: unknown token, not a form link, or not the form’s cover'),
      410: problem('`SHARE_LINK_GONE`'),
      422: problem('`VALIDATION_FAILED`: malformed id'),
      429: problem('`RATE_LIMITED` with `Retry-After`'),
    },
  });
};
