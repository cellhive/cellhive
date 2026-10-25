import { z } from 'zod';

import {
  emailSettingsSchema,
  emailTestResultSchema,
  updateEmailSettingsRequestSchema,
} from '../../email.js';
import { idOf } from '../../ids.js';
import { problemResponse, type RouteRegistrar } from '../types.js';

import { register, type RouteSpec } from './route-spec.js';

const orgParams = z.object({ orgId: idOf('org') });

const ADMIN_ONLY =
  '`PERMISSION_DENIED`: the caller is a member but not an owner/admin of the organization';

/**
 * Instance SMTP status and connection test (CONTRACTS §23; BACKLOG T513),
 * automation email settings of the organization (T531).
 */
export const registerEmailRoutes: RouteRegistrar = (registry, components) => {
  const problem = (description: string) => problemResponse(components, description);
  const add = (spec: RouteSpec) => {
    register(registry, problem, spec);
  };

  add({
    method: 'get',
    path: '/api/v1/orgs/{orgId}/email-settings',
    operationId: 'getEmailSettings',
    tag: 'email',
    summary: 'Instance SMTP status and email limits',
    description:
      'Organization owner/admin only. Read-only: SMTP is configured by the instance environment ' +
      '(`SMTP_URL`, `SMTP_FROM`, `SMTP_ALLOWED_FROM_DOMAINS`). The host is masked; the password, ' +
      'user and full URL are never returned. `usage` counts the automation and notification ' +
      'emails of the organization in the current clock hour. `automation` holds the footer ' +
      'policy, default signature and system sender of automation emails (T531) and the ' +
      'attachment limits in force (T532: `max_attachments`, `max_attachment_bytes`, at most ' +
      '`limits.max_attachments` / `limits.max_attachment_bytes`, the instance caps).',
    params: orgParams,
    status: 200,
    response: emailSettingsSchema,
    forbidden: ADMIN_ONLY,
    errors: { 503: '`DEPENDENCY_UNAVAILABLE`: Valkey is unreachable' },
  });
  add({
    method: 'patch',
    path: '/api/v1/orgs/{orgId}/email-settings',
    operationId: 'updateEmailSettings',
    tag: 'email',
    summary: 'Change the automation email settings of the organization',
    description:
      'Organization owner/admin only. `footer_policy` (`required` | `author_choice`) only takes ' +
      'effect when the instance sets `EMAIL_AUTOMATION_FOOTER=org`; `none` is still only allowed ' +
      'for emails sent as a verified `send_as` identity. `default_signature_md` is the signature ' +
      'of automation emails sent by the system sender (narrow Markdown, at most 2,000 ' +
      'characters, no placeholders; `null` or blank removes it). `system_sender_enabled: false` ' +
      'makes `send_email` steps without an identity fail with `email_identity_unavailable` ' +
      '(`automation.system_sender_usage` counts them). `max_attachments` (files) and ' +
      '`max_attachment_bytes` (original bytes in all, ≥ 1 MiB) of one automation email may be ' +
      'lowered or raised up to the instance caps `EMAIL_MAX_ATTACHMENTS` / ' +
      '`EMAIL_MAX_ATTACHMENT_BYTES`; `null` = the caps (T532). Audited as `org.updated` with the ' +
      'before/after email settings. Returns the settings as `GET` does.',
    params: orgParams,
    body: updateEmailSettingsRequestSchema,
    status: 200,
    response: emailSettingsSchema,
    forbidden: `${ADMIN_ONLY}, or \`CSRF_INVALID\``,
    errors: {
      422:
        '`VALIDATION_FAILED`: unknown or no property, `TOO_BIG` (signature longer than 2,000 ' +
        'characters, or an attachment limit above the instance cap — `params.maximum`), ' +
        '`PLACEHOLDER_NOT_ALLOWED` (signature containing `{{`), signature images (T534): ' +
        '`IMAGE_SOURCE_NOT_ALLOWED` (URL, `data:`), `TOO_MANY_IMAGES` (more than 2), ' +
        '`EMAIL_IMAGE_NOT_FOUND` (not a signature image of the organization, `params.asset_id`)',
    },
  });
  add({
    method: 'post',
    path: '/api/v1/orgs/{orgId}/email-settings/test',
    operationId: 'testEmailSettings',
    tag: 'email',
    summary: 'Test the SMTP connection by emailing the caller',
    description:
      'Organization owner/admin only. Connects and authenticates to the instance SMTP, then ' +
      "sends one fixed test email to the caller's own address (never another one) with the " +
      'mandatory headers. An SMTP failure is a `200` with `status: failed` and the classified ' +
      '`code`/`reason`. At most `EMAIL_TEST_SEND_PER_MIN` per user per minute. Audited as ' +
      '`email.test_sent` (status and SMTP code only).',
    params: orgParams,
    status: 200,
    response: emailTestResultSchema,
    forbidden: `${ADMIN_ONLY}, or \`CSRF_INVALID\``,
    errors: {
      422: '`SMTP_NOT_CONFIGURED`: `SMTP_URL` is not set; `VALIDATION_FAILED`: malformed id',
      429: '`RATE_LIMITED` with `Retry-After`: more than `EMAIL_TEST_SEND_PER_MIN` tests',
    },
  });
};
