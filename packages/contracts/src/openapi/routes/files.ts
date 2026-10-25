import { z } from 'zod';

import {
  ATTACHMENT_DOWNLOAD_URL_SECONDS,
  ATTACHMENT_THUMBNAIL_CACHE_SECONDS,
  ATTACHMENT_THUMBNAIL_MAX_PIXELS,
  ATTACHMENT_UPLOAD_URL_SECONDS,
  attachmentSchema,
  createUploadRequestSchema,
  createUploadResponseSchema,
  thumbnailQuerySchema,
} from '../../attachments.js';
import { idOf } from '../../ids.js';
import { problemResponse, type RouteRegistrar } from '../types.js';

import { SESSION_SECURITY_SCHEME } from './auth.js';
import { register, type RouteSpec } from './route-spec.js';

const attachmentParams = z.object({ attachmentId: idOf('att') });

/** Attachment uploads and downloads (SPEC §16, CONTRACTS §20; BACKLOG T406). */
export const registerFileRoutes: RouteRegistrar = (registry, components) => {
  const problem = (description: string) => problemResponse(components, description);
  const add = (spec: RouteSpec) => {
    register(registry, problem, spec);
  };

  add({
    method: 'post',
    path: '/api/v1/files/uploads',
    operationId: 'createUpload',
    tag: 'files',
    summary: 'Start an attachment upload (presigned PUT)',
    description:
      'The caller must be able to write the attachment field: a table or field they cannot ' +
      'see is `404`; a visible one they cannot write (table `read_only`, field `read`) is ' +
      '`403`. `mime` must match the field’s `accept` and neither the file name nor the MIME ' +
      'type may be of the field’s `blocked_extensions` (default: executables, editable by ' +
      'admins), `size` must not exceed ' +
      '`ATTACHMENT_MAX_FILE_BYTES` (default 100 MB). Returns a `PUT` URL valid ' +
      `${String(ATTACHMENT_UPLOAD_URL_SECONDS / 60)} minutes, on \`S3_PUBLIC_ENDPOINT\` (or ` +
      'the API itself with `STORAGE_DRIVER=local`), signed for the exact `Content-Type` and ' +
      '`Content-Length`. An upload not written to a cell within 24 hours is deleted. ' +
      '`Idempotency-Key` is ignored (a retry only leaves an unused upload).',
    body: createUploadRequestSchema,
    status: 201,
    response: createUploadResponseSchema,
    errors: {
      422:
        '`VALIDATION_FAILED`: `FILE_TOO_LARGE` (`params.limit`), `MIME_NOT_ACCEPTED` ' +
        '(`params.accept`), `BLOCKED_FILE_TYPE` (`params.extension`), `INVALID_FIELD_TYPE` ' +
        '(not an attachment field), invalid `mime`',
    },
  });
  add({
    method: 'post',
    path: '/api/v1/files/uploads/{attachmentId}/complete',
    operationId: 'completeUpload',
    tag: 'files',
    summary: 'Finish an attachment upload',
    description:
      'Only the uploader (anyone else: `404`). Checks the stored object: its size must be the ' +
      'announced one and its first bytes must not contradict its MIME type (e.g. a ' +
      'JPEG named `.png`), nor be a native executable while the field blocks `exe`; computes ' +
      'SHA-256. A wrong object is deleted with the upload (`SIZE_MISMATCH`, `CONTENT_MISMATCH`, ' +
      '`BLOCKED_FILE_TYPE`: start again); a missing one is ' +
      '`UPLOAD_INCOMPLETE` (retry after the `PUT`). Completing a ready upload again returns ' +
      'it unchanged. The attachment can then be written to a cell as `[{ "id": "att_…" }]`.',
    params: attachmentParams,
    status: 200,
    response: attachmentSchema,
    errors: {
      422:
        '`VALIDATION_FAILED`: `UPLOAD_INCOMPLETE`, `SIZE_MISMATCH`, `CONTENT_MISMATCH`, ' +
        '`BLOCKED_FILE_TYPE`',
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/v1/files/{attachmentId}',
    operationId: 'downloadAttachment',
    tags: ['files'],
    summary: 'Download an attachment',
    description:
      'Checked on every call: the caller must read the record (record rule, not in the ' +
      'trash) and the field, else `404`; the field must be one of the role’s ' +
      '`file_download_fields`, else `403`. Redirects to a storage URL valid ' +
      `${String(ATTACHMENT_DOWNLOAD_URL_SECONDS)} seconds with \`Content-Disposition\` ` +
      '(RFC 5987 UTF-8 name): `inline` only for PNG, JPEG, GIF, WebP and audio/video (native ' +
      'players), `attachment` otherwise (never SVG/HTML inline). Files served by the API ' +
      'itself (`STORAGE_DRIVER=local`) also carry `X-Content-Type-Options: nosniff` and ' +
      '`Content-Security-Policy: sandbox`, and honour single `Range` requests.',
    security: [{ [SESSION_SECURITY_SCHEME]: [] }],
    request: { params: attachmentParams },
    responses: {
      302: {
        description: 'Redirect to the signed storage URL',
        headers: {
          Location: { description: 'Signed URL, valid 60 seconds', schema: { type: 'string' } },
        },
      },
      401: problem('`UNAUTHENTICATED`'),
      403: problem('`PERMISSION_DENIED`: the field is not among the role’s `file_download_fields`'),
      404: problem(
        '`NOT_FOUND`: no such attachment, or the caller cannot read its record or field ' +
          '(never `403` for something the caller cannot read)',
      ),
      422: problem('`VALIDATION_FAILED`: malformed id'),
      429: problem('`RATE_LIMITED` with `Retry-After`'),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/v1/files/{attachmentId}/thumbnail',
    operationId: 'attachmentThumbnail',
    tags: ['files'],
    summary: 'Thumbnail of an image attachment',
    description:
      'The WebP thumbnail the worker rendered after `complete` (job `file.thumbnail`, BACKLOG ' +
      'T407) for PNG, JPEG, GIF and WebP files up to 50 MB and ' +
      `${String(ATTACHMENT_THUMBNAIL_MAX_PIXELS / 1_000_000)} megapixels, fitted inside ` +
      '`size` × `size` pixels (never enlarged). Checked on every call: the caller must read ' +
      'the record (record rule, not in the trash) and the field, else `404` — ' +
      '`file_download_fields` is **not** required (viewing is allowed without the right to ' +
      'download, SPEC §14.1). The uploader also reads the thumbnail of their own finished ' +
      'upload before it is written to a cell (T421b; same field rules; anyone else `404`). ' +
      'While the thumbnail is not rendered yet or when it was skipped ' +
      '(too many pixels, unreadable): a `302` to the original image (like `GET ' +
      '/files/{attachmentId}`, `inline`) for callers who may download it, else `404`. ' +
      'Served by the API itself (same origin) with `Content-Type: image/webp`, ' +
      `\`Cache-Control: private, max-age=${String(ATTACHMENT_THUMBNAIL_CACHE_SECONDS)}\`, ` +
      '`X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`.',
    security: [{ [SESSION_SECURITY_SCHEME]: [] }],
    request: { params: attachmentParams, query: thumbnailQuerySchema },
    responses: {
      200: {
        description: 'The thumbnail',
        content: { 'image/webp': { schema: { type: 'string', format: 'binary' } } },
      },
      302: {
        description:
          'No thumbnail (yet): redirect to the original image, only for callers with ' +
          '`file_download_fields`',
        headers: {
          Location: { description: 'Signed URL, valid 60 seconds', schema: { type: 'string' } },
        },
      },
      401: problem('`UNAUTHENTICATED`'),
      404: problem(
        '`NOT_FOUND`: no such attachment, the caller cannot read its record or field, not an ' +
          'image, or no thumbnail (yet) and no right to download the original',
      ),
      422: problem('`VALIDATION_FAILED`: malformed id or `size`'),
      429: problem('`RATE_LIMITED` with `Retry-After`'),
    },
  });
};
