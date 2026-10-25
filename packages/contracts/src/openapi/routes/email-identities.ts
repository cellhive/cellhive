import { z } from 'zod';

import {
  baseEmailIdentityListSchema,
  createEmailIdentityRequestSchema,
  DISPLAY_NAME_NOT_ALLOWED,
  emailIdentityIdSchema,
  emailIdentityListSchema,
  emailIdentityMutationSchema,
  emailIdentitySchema,
  emailIdentityUsagesSchema,
  emailVerificationConfirmedSchema,
  emailVerificationOutcomeSchema,
  emailVerificationPreviewSchema,
  emailVerificationTokenRequestSchema,
  updateEmailIdentityRequestSchema,
  verifyEmailIdentityCodeRequestSchema,
} from '../../email-identities.js';
import { problemTitle, problemTypeUri, type ProblemDetails } from '../../errors.js';
import { idOf } from '../../ids.js';
import { problemResponse, type RouteRegistrar } from '../types.js';

import { register, type RouteSpec } from './route-spec.js';

const orgParams = z.object({ orgId: idOf('org') });
const identityParams = z.object({ identityId: emailIdentityIdSchema });
const baseParams = z.object({ baseId: idOf('bse') });

const ADMIN_ONLY =
  '`PERMISSION_DENIED`: the caller is a member but not an owner/admin of the organization ' +
  '(workspace and base admins included), or `CSRF_INVALID`';

const SAVE_ERRORS =
  '`VALIDATION_FAILED`: malformed body or `errors[].code` `INVALID_EMAIL`, `EMAIL_TAKEN`, ' +
  '`HOST_NOT_ALLOWED` (the host resolves to a private, loopback, link-local or metadata ' +
  'address and `SMTP_ALLOW_PRIVATE_HOSTS` is off), `HOST_UNRESOLVABLE`, ' +
  '`INSECURE_NOT_CONFIRMED` (`security = none` without `allow_insecure: true`), ' +
  '`SMTP_REQUIRED`, `SMTP_NOT_ALLOWED`, `PASSWORD_REQUIRED`, `UNKNOWN_BASE`, ' +
  '`IDENTITY_LIMIT_REACHED`; signature (T531, T534): `PLACEHOLDER_NOT_ALLOWED`, ' +
  '`IMAGE_SOURCE_NOT_ALLOWED`, `TOO_MANY_IMAGES`, `EMAIL_IMAGE_NOT_FOUND` (`params.asset_id`); ' +
  'display name (T540): `DISPLAY_NAME_NOT_ALLOWED` (path `display_name`, `params.reason`: ' +
  '`control_char`, `angle_bracket`, `at_sign`, `url`) — `@`, `<`, `>`, control characters ' +
  '(C0/C1, U+2028/U+2029, bidirectional overrides and isolates) and URL/domain look-alikes ' +
  '(`xxx://`, `www.`, `label.tld`) are refused; names saved before the rule are kept and ' +
  'flagged by `display_name_issue`';

/** Example `422` of a save (T540). */
export const SAVE_ERROR_EXAMPLE: ProblemDetails = {
  type: problemTypeUri('VALIDATION_FAILED'),
  title: problemTitle('VALIDATION_FAILED'),
  status: 422,
  code: 'VALIDATION_FAILED',
  detail: 'The request does not match the expected schema.',
  errors: [
    {
      path: 'display_name',
      code: DISPLAY_NAME_NOT_ALLOWED,
      message: 'The display name may not contain @, < or >, control characters or a URL.',
      params: { reason: 'angle_bracket' },
    },
  ],
  request_id: 'req_A1b2C3d4E5f6G7h8',
};

const VERIFICATION_LIMITS =
  'At most 3 verification emails per hour per identity and 20 per day per organization.';

/** Sender identities (CONTRACTS §23.3; BACKLOG T530; ADR-33). */
export const registerEmailIdentityRoutes: RouteRegistrar = (registry, components) => {
  const problem = (description: string) => problemResponse(components, description);
  const add = (spec: RouteSpec) => {
    register(registry, problem, spec);
  };

  add({
    method: 'get',
    path: '/api/v1/orgs/{orgId}/email-identities',
    operationId: 'listEmailIdentities',
    tag: 'email',
    summary: 'List the sender identities of an organization',
    description:
      'Organization owner/admin only. SMTP settings come without the password (`password_set`).',
    params: orgParams,
    status: 200,
    response: emailIdentityListSchema,
    forbidden: ADMIN_ONLY,
  });
  add({
    method: 'post',
    path: '/api/v1/orgs/{orgId}/email-identities',
    operationId: 'createEmailIdentity',
    tag: 'email',
    summary: 'Create a sender identity and send its verification email',
    description:
      'Organization owner/admin only. The identity starts `pending`; the verification email ' +
      '(link + 6-digit code) is sent at once through the transport the identity will use ' +
      '(instance SMTP, or the identity SMTP after logging in). An SMTP failure is reported in ' +
      '`verification` (`status: failed`), not as an error. The SMTP host is resolved and ' +
      'refused when it is internal. ' +
      VERIFICATION_LIMITS,
    params: orgParams,
    body: createEmailIdentityRequestSchema,
    status: 201,
    response: emailIdentityMutationSchema,
    forbidden: ADMIN_ONLY,
    errors: { 422: SAVE_ERRORS },
    errorExamples: { 422: SAVE_ERROR_EXAMPLE },
  });
  add({
    method: 'get',
    path: '/api/v1/email-identities/{identityId}',
    operationId: 'getEmailIdentity',
    tag: 'email',
    summary: 'Read a sender identity',
    description: 'Organization owner/admin only.',
    params: identityParams,
    status: 200,
    response: emailIdentitySchema,
    forbidden: ADMIN_ONLY,
  });
  add({
    method: 'patch',
    path: '/api/v1/email-identities/{identityId}',
    operationId: 'updateEmailIdentity',
    tag: 'email',
    summary: 'Change a sender identity',
    description:
      'Organization owner/admin only. Changing `email`, `transport` or, for `smtp`, `host`, ' +
      '`username` or `password` puts the identity back to `pending` and sends a new ' +
      'verification email; the display name, Reply-To, signature and base scope do not. Omit ' +
      '`smtp.password` to keep the stored one.',
    params: identityParams,
    body: updateEmailIdentityRequestSchema,
    status: 200,
    response: emailIdentityMutationSchema,
    forbidden: ADMIN_ONLY,
    errors: { 422: SAVE_ERRORS },
    errorExamples: { 422: SAVE_ERROR_EXAMPLE },
  });
  add({
    method: 'delete',
    path: '/api/v1/email-identities/{identityId}',
    operationId: 'deleteEmailIdentity',
    tag: 'email',
    summary: 'Delete a sender identity',
    description:
      'Organization owner/admin only. Automations using it keep running; their email steps ' +
      'fail with `email_identity_unavailable`.',
    params: identityParams,
    status: 204,
    forbidden: ADMIN_ONLY,
  });
  add({
    method: 'post',
    path: '/api/v1/email-identities/{identityId}/send-verification',
    operationId: 'sendEmailIdentityVerification',
    tag: 'email',
    summary: 'Send the verification email again',
    description:
      'Organization owner/admin only; identities in `pending` or `error`. A new link and code ' +
      'replace the previous ones. ' +
      VERIFICATION_LIMITS,
    params: identityParams,
    status: 200,
    response: emailVerificationOutcomeSchema,
    forbidden: ADMIN_ONLY,
    errors: {
      422:
        '`VALIDATION_FAILED` (`NOT_VERIFIABLE`: verified or disabled); `SMTP_NOT_CONFIGURED`: ' +
        'transport `system` without `SMTP_URL`',
      429: '`RATE_LIMITED` with `Retry-After`',
    },
  });
  add({
    method: 'post',
    path: '/api/v1/email-identities/{identityId}/test-and-verify',
    operationId: 'testAndVerifyEmailIdentity',
    tag: 'email',
    summary: 'Test the identity SMTP and send the verification email through it',
    description:
      'Organization owner/admin only; transport `smtp`, status `pending` or `error`. Connects ' +
      '(the host is resolved and checked again), negotiates TLS, logs in, then sends the ' +
      'verification email from the identity address to itself. A failure is a `200` with ' +
      '`status: failed`, the `step` and the classified SMTP code (`auth_failed` for `535`). ' +
      VERIFICATION_LIMITS,
    params: identityParams,
    status: 200,
    response: emailVerificationOutcomeSchema,
    forbidden: ADMIN_ONLY,
    errors: {
      422: '`VALIDATION_FAILED` (`TRANSPORT_NOT_SMTP`, `NOT_VERIFIABLE`)',
      429: '`RATE_LIMITED` with `Retry-After`',
    },
  });
  add({
    method: 'post',
    path: '/api/v1/email-identities/{identityId}/verify-code',
    operationId: 'verifyEmailIdentityCode',
    tag: 'email',
    summary: 'Verify an identity with the 6-digit code from its email',
    description:
      'Organization owner/admin only. Five wrong codes lock the verification: send a new one.',
    params: identityParams,
    body: verifyEmailIdentityCodeRequestSchema,
    status: 200,
    response: emailIdentitySchema,
    forbidden: ADMIN_ONLY,
    errors: {
      422:
        '`EMAIL_VERIFICATION_INVALID` (`CODE_INVALID` with `params.attempts_left`, ' +
        '`CODE_LOCKED`, `NO_PENDING_VERIFICATION`)',
    },
  });
  for (const action of ['disable', 'enable'] as const) {
    add({
      method: 'post',
      path: `/api/v1/email-identities/{identityId}/${action}`,
      operationId: `${action}EmailIdentity`,
      tag: 'email',
      summary: action === 'disable' ? 'Disable a sender identity' : 'Enable a sender identity',
      description:
        action === 'disable'
          ? 'Organization owner/admin only. Automations using it are not disabled; their email ' +
            'steps fail with `email_identity_unavailable` until it is enabled again.'
          : 'Organization owner/admin only. Back to `verified` if it was verified, else `pending`.',
      params: identityParams,
      status: 200,
      response: emailIdentitySchema,
      forbidden: ADMIN_ONLY,
    });
  }
  add({
    method: 'get',
    path: '/api/v1/email-identities/{identityId}/usages',
    operationId: 'listEmailIdentityUsages',
    tag: 'email',
    summary: 'Automations sending with the identity',
    description:
      'Organization owner/admin only. The automation name is `null` when the caller cannot ' +
      'see its base.',
    params: identityParams,
    status: 200,
    response: emailIdentityUsagesSchema,
    forbidden: ADMIN_ONLY,
  });
  add({
    method: 'get',
    path: '/api/v1/bases/{baseId}/email-identities',
    operationId: 'listBaseEmailIdentities',
    tag: 'email',
    summary: 'Identities an automation of the base may send as',
    description:
      'Automation managers of the base (base admin or `manage` on a table). Only `verified` ' +
      'identities whose scope includes the base; only `id`, `email`, `display_name`, `mode` ' +
      '(never SMTP settings).',
    params: baseParams,
    status: 200,
    response: baseEmailIdentityListSchema,
    forbidden: '`PERMISSION_DENIED`: the caller reads the base but cannot manage automations',
  });
  add({
    method: 'post',
    path: '/api/v1/email-identities/verify/preview',
    operationId: 'previewEmailVerification',
    tag: 'email',
    summary: 'What a verification link confirms (public, no state change)',
    description:
      'Used by the public page `/verify-sender?token=…`: organization, requester and address. ' +
      'Opening the link never verifies anything. Rate limited per IP.',
    body: emailVerificationTokenRequestSchema,
    status: 200,
    response: emailVerificationPreviewSchema,
    public: true,
    forbidden: '`CSRF_INVALID` (requests carrying a session cookie)',
    errors: {
      422: '`EMAIL_VERIFICATION_INVALID` (`TOKEN_INVALID`: wrong, used, expired or replaced)',
      429: '`RATE_LIMITED` with `Retry-After`',
    },
  });
  add({
    method: 'post',
    path: '/api/v1/email-identities/verify',
    operationId: 'confirmEmailVerification',
    tag: 'email',
    summary: 'Confirm a sender identity from its verification link (public)',
    description:
      'The button of `/verify-sender`: verifies the identity (`verified_via = link`). Tokens ' +
      'are single use and expire after 24 hours. Rate limited per IP.',
    body: emailVerificationTokenRequestSchema,
    status: 200,
    response: emailVerificationConfirmedSchema,
    public: true,
    forbidden: '`CSRF_INVALID` (requests carrying a session cookie)',
    errors: {
      422: '`EMAIL_VERIFICATION_INVALID` (`TOKEN_INVALID`: wrong, used, expired or replaced)',
      429: '`RATE_LIMITED` with `Retry-After`',
    },
  });
};
