import { z } from 'zod';

import { createUploadResponseSchema } from '../../attachments.js';
import { SHARE_FORM_MAX_FILES_PER_QUESTION } from '../../client-constants.js';
import {
  shareFormUploadCompleteRequestSchema,
  shareFormUploadRequestSchema,
  shareFormUploadSchema,
  shareLinkCandidatesQuerySchema,
  shareLinkCandidatesSchema,
} from '../../form-inputs.js';
import {
  formSubmissionStatusSchema,
  formSubmitRequestSchema,
  formSubmitResponseSchema,
  formSubmitTokenSchema,
  SHARE_FORM_UPLOAD_RATE_LIMIT,
  SHARE_FORM_UPLOAD_RATE_WINDOW_SECONDS,
  shareFormMemberListSchema,
  shareTokenParamSchema,
} from '../../forms.js';
import { idOf } from '../../ids.js';
import { problemResponse, type RouteRegistrar } from '../types.js';

import { register, type RouteSpec } from './route-spec.js';

const viewParams = z.object({ viewId: idOf('viw') });
const tokenParams = z.object({ token: shareTokenParamSchema });
const candidateParams = z.object({ token: shareTokenParamSchema, fieldId: idOf('fld') });
const uploadParams = z.object({ token: shareTokenParamSchema, attachmentId: idOf('att') });

const SHARE_CHECKS =
  'Checked like `GET /shares/{token}/meta`: token (`404`/`410`), audience `org` (`401`, ' +
  'other users `404`), password (`403 SHARE_PASSWORD_REQUIRED`).';
const SHARE_ERRORS = {
  401: '`UNAUTHENTICATED`: `org` link (or `require_login` form for uploads) without a session',
  410: '`SHARE_LINK_GONE`',
  429: '`RATE_LIMITED`, with `Retry-After`',
};
const UPLOAD_LIMITS =
  `At most ${String(SHARE_FORM_UPLOAD_RATE_LIMIT)} uploads per ` +
  `${String(SHARE_FORM_UPLOAD_RATE_WINDOW_SECONDS / 60)} minutes per client IP (unknown ` +
  'tokens included, before any other check); per submit token at most ' +
  `\`min(max_files, ${String(SHARE_FORM_MAX_FILES_PER_QUESTION)})\` files per question ` +
  '(`TOO_MANY_VALUES`, `params.limit`) and 100 MB in all (`UPLOAD_LIMIT_EXCEEDED`).';

const VALUES =
  'One record per submission, created like `POST /tables/{id}/records?typecast=true&' +
  'field_key_type=id` (base locale; select options are never created). Only fields of the form ' +
  '(`422 VALIDATION_FAILED` / `UNKNOWN_FIELD` at `fields.<id>`); fields the form requires (on ' +
  'top of the table) need a non-empty value (`422 REQUIRED_FIELD_MISSING`). Value errors ' +
  '(`INVALID_CELL_VALUE`, `INVALID_SELECT_OPTION`, …) have paths `fields.<id>`. Emits ' +
  '`record.created` and `form.submitted` with their audit entries in one transaction.';
const LIMIT =
  '`SUBMISSION_LIMIT_REACHED`: the signed-in submitter already submitted in the current period ' +
  'of `submission_limit` (`errors[0].params.limit`, `next_allowed_at`)';
const VALUE_ERRORS =
  '`VALIDATION_FAILED`, `REQUIRED_FIELD_MISSING`, `INVALID_CELL_VALUE`, ' +
  '`INVALID_SELECT_OPTION`, `UNIQUE_VIOLATION`, …';

/** Form submissions (SPEC §8, §15A; CONTRACTS §17; BACKLOG T306). */
export const registerFormRoutes: RouteRegistrar = (registry, components) => {
  const problem = (description: string) => problemResponse(components, description);
  const add = (spec: RouteSpec) => {
    register(registry, problem, spec);
  };

  add({
    method: 'post',
    path: '/api/v1/views/{viewId}/submit',
    operationId: 'submitForm',
    tag: 'forms',
    summary: 'Fill in a form as a member of the base',
    description:
      'The caller must see the form view (else `404`); `add` on the table and `create`/`edit` on ' +
      'the fields sent are checked by the record service (`403 PERMISSION_DENIED`, ' +
      '`FIELD_READ_ONLY`), and the new record must match the edit rule (`403 ' +
      `RECORD_RULE_VIOLATION\`). ${VALUES} Counted against 10 submissions/minute per user.`,
    params: viewParams,
    body: formSubmitRequestSchema,
    status: 200,
    response: formSubmitResponseSchema,
    errors: {
      403: '`PERMISSION_DENIED`, `FIELD_READ_ONLY`, `RECORD_RULE_VIOLATION` or `CSRF_INVALID`',
      409: LIMIT,
      413: '`PAYLOAD_TOO_LARGE`: body over 256 KiB',
      422: VALUE_ERRORS,
    },
  });
  add({
    method: 'get',
    path: '/api/v1/views/{viewId}/submission-status',
    operationId: 'getFormSubmissionStatus',
    tag: 'forms',
    summary: 'Whether the caller already reached the submission limit of a form',
    description:
      'For members filling in a form view (same visibility as `POST /views/{viewId}/submit`, ' +
      'else `404`; a view that is not a form is `404`). Counts the caller’s submissions in the ' +
      'current period of `submission_limit` (base time zone), like the submit route does. ' +
      'Read-only: submitting still checks the limit.',
    params: viewParams,
    status: 200,
    response: formSubmissionStatusSchema,
  });
  add({
    method: 'get',
    path: '/api/v1/shares/{token}/submit-token',
    operationId: 'getFormSubmitToken',
    tag: 'forms',
    summary: 'A submit token for a form link',
    description:
      'Signed, single use, bound to the link; valid from `not_before` (the minimum fill time) ' +
      'until `expires_at` (24 h). Fetch it when the form is shown. Counts against the per-IP ' +
      'share read limit (20/s, unknown tokens included); audience `org` needs a signed-in ' +
      'member of the organization; no password needed yet.',
    public: true,
    params: tokenParams,
    status: 200,
    response: formSubmitTokenSchema,
    errors: {
      401: '`UNAUTHENTICATED`: `org` link without a session',
      404:
        '`NOT_FOUND`: unknown token, a link that is not a form link, or an `org` link and a ' +
        'caller outside the organization',
      410: '`SHARE_LINK_GONE`',
      429: '`RATE_LIMITED`, with `Retry-After`',
    },
  });
  add({
    method: 'get',
    path: '/api/v1/shares/{token}/submission-status',
    operationId: 'getSharedFormSubmissionStatus',
    tag: 'forms',
    summary: 'Whether the caller already reached the submission limit of a form link',
    description:
      'Like `GET /views/{viewId}/submission-status` for the person filling in a form link ' +
      '(T321). Checked like `GET /shares/{token}/submit-token`: per-IP share read limit (20/s, ' +
      'unknown tokens included), `404`/`410`, audience `org` (`401`, other users `404`); no ' +
      'password needed. A form that requires sign-in (`require_login`) answers `401` without a ' +
      'session. A form link whose submitters are anonymous (audience `public` without ' +
      '`require_login`) has no per-person limit: `{ "limit": "none", "reached": false, ' +
      '"next_allowed_at": null }`. Read-only: submitting still checks the limit.',
    public: true,
    params: tokenParams,
    status: 200,
    response: formSubmissionStatusSchema,
    errors: {
      401: '`UNAUTHENTICATED`: sign-in needed (`org` link or `require_login`)',
      404:
        '`NOT_FOUND`: unknown token, not a form link, or an `org` link and a caller outside ' +
        'the organization',
      410: '`SHARE_LINK_GONE`',
      429: '`RATE_LIMITED`, with `Retry-After`',
    },
  });
  add({
    method: 'get',
    path: '/api/v1/shares/{token}/members',
    operationId: 'listSharedFormMembers',
    tag: 'forms',
    summary: 'People the user questions of an organization form link offer',
    description:
      'Only for a form link with audience `org` (T321) whose form has a `user` question the ' +
      'link can write: the active members of the organization who can open the base, as ' +
      '`{ id, display_name }` — never an email. Public form links hide `user` questions ' +
      '(`meta` leaves them out, `submit` refuses them) and answer `404` here, like view links ' +
      'and forms without a `user` question. Checked like `GET /shares/{token}/meta` (per-IP ' +
      'read limit, `404`/`410`, `401`/`404` for the audience, the password).',
    public: true,
    forbidden:
      '`SHARE_PASSWORD_REQUIRED` (`UNLOCK_REQUIRED`: link with a password not unlocked, ' +
      'CONTRACTS §16A)',
    params: tokenParams,
    status: 200,
    response: shareFormMemberListSchema,
    errors: {
      401: '`UNAUTHENTICATED`: `org` link without a session',
      404:
        '`NOT_FOUND`: unknown token, not an `org` form link with a `user` question, or a ' +
        'caller outside the organization',
      410: '`SHARE_LINK_GONE`',
      429: '`RATE_LIMITED`, with `Retry-After`',
    },
  });
  add({
    method: 'get',
    path: '/api/v1/shares/{token}/link-candidates/{fieldId}',
    operationId: 'listSharedFormLinkCandidates',
    tag: 'forms',
    summary: 'Records a link question of an organization form link offers',
    description:
      'Only for a form link with audience `org` (T410) and a `link` question of its form the ' +
      'link writes: live records of the linked table the link’s creator reads now (their ' +
      'access and record rule) that match the field’s `record_filter`, oldest first, as ' +
      '`{ id, title }` only — no other field. `search` matches the title without accents; a ' +
      'title the creator cannot read is `null` (and search is refused, `422`). Public form ' +
      'links hide link questions (`meta` leaves them out, `submit` refuses them as fields ' +
      `outside the form) and answer \`404\`, like view links and other fields. ${SHARE_CHECKS} ` +
      'Per-IP share read limit (20/s).',
    public: true,
    forbidden:
      '`SHARE_PASSWORD_REQUIRED` (`UNLOCK_REQUIRED`: link with a password not unlocked, ' +
      'CONTRACTS §16A)',
    params: candidateParams,
    query: shareLinkCandidatesQuerySchema,
    status: 200,
    response: shareLinkCandidatesSchema,
    errors: {
      ...SHARE_ERRORS,
      404:
        '`NOT_FOUND`: unknown token, not an `org` form link, not a link question of the form, ' +
        'a linked table the creator cannot read, or a caller outside the organization',
      422: '`VALIDATION_FAILED`: invalid query, or `search` when the title is not readable',
    },
  });
  add({
    method: 'post',
    path: '/api/v1/shares/{token}/uploads',
    operationId: 'createSharedFormUpload',
    tag: 'forms',
    summary: 'Start an upload for an attachment question of a form link',
    description:
      'Like `POST /files/uploads` for the person filling in a form link (T410): anonymous on ' +
      'public links; `org` links and `require_login` forms need a session. The field must be ' +
      'an attachment question of the form the link writes (else `404`) and `submit_token` a ' +
      'token of this link not used yet (`422 SUBMIT_TOKEN_INVALID`; the minimum fill time ' +
      'does not apply). The same checks as members (`FILE_TOO_LARGE`, `MIME_NOT_ACCEPTED`, ' +
      `\`BLOCKED_FILE_TYPE\`). ${UPLOAD_LIMITS} Files are bound to the token: only the ` +
      'submission sent with it can use them; files never submitted are deleted after 24 ' +
      `hours. ${SHARE_CHECKS} No \`Idempotency-Key\`.`,
    public: true,
    forbidden:
      '`CSRF_INVALID`, `SHARE_PASSWORD_REQUIRED` (`UNLOCK_REQUIRED`: link with a password not ' +
      'unlocked, CONTRACTS §16A)',
    params: tokenParams,
    body: shareFormUploadRequestSchema,
    status: 201,
    response: createUploadResponseSchema,
    errors: {
      ...SHARE_ERRORS,
      404:
        '`NOT_FOUND`: unknown token, not a form link, not an attachment question of the form, ' +
        'or a caller outside the organization',
      422:
        '`VALIDATION_FAILED`: `SUBMIT_TOKEN_INVALID`, `FILE_TOO_LARGE`, `MIME_NOT_ACCEPTED`, ' +
        '`BLOCKED_FILE_TYPE`, `TOO_MANY_VALUES`, `UPLOAD_LIMIT_EXCEEDED`, invalid `mime`',
    },
  });
  add({
    method: 'post',
    path: '/api/v1/shares/{token}/uploads/{attachmentId}/complete',
    operationId: 'completeSharedFormUpload',
    tag: 'forms',
    summary: 'Finish an upload of a form link',
    description:
      'Like `POST /files/uploads/{attachmentId}/complete` (size and content checks, ' +
      '`UPLOAD_INCOMPLETE`, `SIZE_MISMATCH`, `CONTENT_MISMATCH`, `BLOCKED_FILE_TYPE`), with the ' +
      'submit token the upload was started with: an upload of another link, token or member ' +
      `is \`404\`. Returns \`{ id, name, size, mime }\` (no URL). ${SHARE_CHECKS} Per-IP ` +
      'share read limit (20/s).',
    public: true,
    forbidden:
      '`CSRF_INVALID`, `SHARE_PASSWORD_REQUIRED` (`UNLOCK_REQUIRED`: link with a password not ' +
      'unlocked, CONTRACTS §16A)',
    params: uploadParams,
    body: shareFormUploadCompleteRequestSchema,
    status: 200,
    response: shareFormUploadSchema,
    errors: {
      ...SHARE_ERRORS,
      404: '`NOT_FOUND`: unknown token or upload, or an upload of another link or token',
      422:
        '`VALIDATION_FAILED`: `SUBMIT_TOKEN_INVALID`, `UPLOAD_INCOMPLETE`, `SIZE_MISMATCH`, ' +
        '`CONTENT_MISMATCH`, `BLOCKED_FILE_TYPE`',
    },
  });
  add({
    method: 'post',
    path: '/api/v1/shares/{token}/submit',
    operationId: 'submitSharedForm',
    tag: 'forms',
    summary: 'Fill in a form through its share link',
    description:
      'Acts with the link’s access (its creator’s current access ∩ the form fields, create ' +
      'only). Audience `org` needs a signed-in member of the organization (`401`; other ' +
      'users `404`); `require_login` needs any signed-in user (`401`). Signed-in submitters of ' +
      'such links are the actor and `created_by`; other submissions are anonymous (actor ' +
      '`share_link`, `created_by` `null`); all carry `via.share_link_id`. Needs `submit_token` ' +
      '(`422 SUBMIT_TOKEN_INVALID` / `SUBMITTED_TOO_FAST`); a non-empty `honeypot` gets the ' +
      'normal response and writes nothing. `user` questions are answered only through `org` ' +
      'links, with members who can open the base (`422 INVALID_CELL_VALUE` / `USER_NOT_FOUND` ' +
      'otherwise), `link` questions only through `org` links with records the creator reads ' +
      'that match `record_filter` (`422 LINK_TARGET_NOT_FOUND` otherwise); a `public` link ' +
      'treats both as fields outside the form (`422 VALIDATION_FAILED` / `UNKNOWN_FIELD`). ' +
      'Attachment answers are files uploaded with the same `submit_token` through ' +
      '`POST /shares/{token}/uploads` (else `422 INVALID_CELL_VALUE` / ' +
      '`ATTACHMENT_NOT_FOUND`). 10 submissions/minute per client IP ' +
      `(\`429\`). No \`Idempotency-Key\`. ${VALUES}`,
    public: true,
    forbidden:
      '`CSRF_INVALID` (signed-in callers, or an unlock cookie without its `X-Share-CSRF-Token`), ' +
      '`SHARE_PASSWORD_REQUIRED` (`UNLOCK_REQUIRED`: link with a password not unlocked, ' +
      'CONTRACTS §16A), `RECORD_RULE_VIOLATION`',
    params: tokenParams,
    body: formSubmitRequestSchema,
    status: 200,
    response: formSubmitResponseSchema,
    errors: {
      401: '`UNAUTHENTICATED`: sign-in needed (`org` link or `require_login`)',
      404:
        '`NOT_FOUND`: unknown token, not a form link, or an `org` link and a caller ' +
        'outside the organization',
      409: LIMIT,
      410: '`SHARE_LINK_GONE`',
      413: '`PAYLOAD_TOO_LARGE`: body over 256 KiB',
      422: VALUE_ERRORS,
      429: '`RATE_LIMITED`, with `Retry-After`',
    },
  });
};
