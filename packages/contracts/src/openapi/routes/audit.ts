import { z } from 'zod';

import {
  auditLogListSchema,
  baseAuditLogQuerySchema,
  exportAuditLogsRequestSchema,
  exportBaseAuditLogsRequestSchema,
  orgAuditLogQuerySchema,
  redactAuditLogsRequestSchema,
  redactAuditLogsResponseSchema,
} from '../../audit.js';
import { idOf } from '../../ids.js';
import { jobAcceptedSchema, jobSchema } from '../../jobs.js';
import { problemResponse, type RouteRegistrar } from '../types.js';

import { SESSION_SECURITY_SCHEME } from './auth.js';
import { register, type RouteSpec } from './route-spec.js';

const orgParams = z.object({ orgId: idOf('org') });
const baseParams = z.object({ baseId: idOf('bse') });
const jobParams = z.object({ jobId: idOf('job') });

const FILTERS =
  'Filters combine with AND; the values of a repeated filter (`action`, `action_prefix`, ' +
  '`actor_id`, `via`, at most 20 each) with OR; `from` is inclusive and `to` exclusive. Newest ' +
  'first, cursor pagination (pass `next_cursor` back as `cursor`). `before`/`after` hold ' +
  'storage-form values (option, user and record ids); `include=refs` adds the names of the ' +
  'users, fields, tables and API tokens of the page. `retention_days` says how long entries ' +
  'are kept. Viewing is itself audited (`audit.viewed`, at most once per viewer, scope and ' +
  'filters every 10 minutes: further pages add nothing).';

/** Audit log admin API (ADR-23, CONTRACTS §11.4) and background jobs (CONTRACTS §12.2). */
export const registerAuditRoutes: RouteRegistrar = (registry, components) => {
  const problem = (description: string) => problemResponse(components, description);
  const add = (spec: RouteSpec) => {
    register(registry, problem, spec);
  };

  add({
    method: 'get',
    path: '/api/v1/orgs/{orgId}/audit-logs',
    operationId: 'listOrgAuditLogs',
    tag: 'audit',
    summary: 'Audit log of an organization',
    description: `Organization owners and admins only; anyone else gets \`404\`. ${FILTERS}`,
    params: orgParams,
    query: orgAuditLogQuerySchema,
    status: 200,
    response: auditLogListSchema,
  });
  add({
    method: 'get',
    path: '/api/v1/bases/{baseId}/audit-logs',
    operationId: 'listBaseAuditLogs',
    tag: 'audit',
    summary: 'Audit log of a base',
    description:
      'Base admins only (role `admin`, base owner, workspace admin, organization owner/admin); ' +
      `anyone else gets \`404\`. Only entries of the base; \`refs\` only names fields and ` +
      `tables of the base. A base admin who is not an organization owner/admin sees API ` +
      `tokens of other users as \`via.api_token_id: null\` (also in \`refs\` and the export ` +
      `\`via\` column, T705). ${FILTERS}`,
    params: baseParams,
    query: baseAuditLogQuerySchema,
    status: 200,
    response: auditLogListSchema,
  });
  add({
    method: 'post',
    path: '/api/v1/bases/{baseId}/audit-logs/export',
    operationId: 'exportBaseAuditLogs',
    tag: 'audit',
    summary: 'Export the audit log of a base as CSV (background job)',
    description:
      'Base admins only (else `404`, also for members who can read the base). Same filters ' +
      'and CSV as the organization export, restricted to the base; one audit export runs per ' +
      'organization at a time (others wait). Starts an `audit.base_export` job and writes ' +
      '`audit.exported`; follow it with `GET /jobs/{jobId}`, whose result carries a ' +
      '`download_url` valid for one hour, usable by organization owners/admins and by the job ' +
      'creator while still an admin of the base.',
    params: baseParams,
    body: exportBaseAuditLogsRequestSchema,
    status: 202,
    response: jobAcceptedSchema,
    errors: { 409: '`IDEMPOTENCY_KEY_REUSED`' },
  });
  add({
    method: 'post',
    path: '/api/v1/orgs/{orgId}/audit-logs/export',
    operationId: 'exportOrgAuditLogs',
    tag: 'audit',
    summary: 'Export the audit log as CSV (background job)',
    description:
      'Organization owners and admins only (else `404`). Starts an `audit.export` job and ' +
      'writes `audit.exported`; follow it with `GET /jobs/{jobId}`, whose result carries a ' +
      '`download_url` valid for one hour and usable only by the job creator or an ' +
      'organization owner/admin.',
    params: orgParams,
    body: exportAuditLogsRequestSchema,
    status: 202,
    response: jobAcceptedSchema,
    errors: { 409: '`IDEMPOTENCY_KEY_REUSED`' },
  });
  add({
    method: 'post',
    path: '/api/v1/orgs/{orgId}/audit-logs/redact',
    operationId: 'redactOrgAuditLogs',
    tag: 'audit',
    summary: 'Redact personal data from the audit log',
    description:
      'Organization **owner** only (admins get `403`, anyone else `404`). By entity: ' +
      '`before`/`after` of those entities become `{"redacted": true}`. By user: `ip` and ' +
      '`user_agent` of the user’s actions are cleared and entries about the user are redacted. ' +
      'Entries whose actor is the caller and `audit.*` entries are never changed. Writes ' +
      '`audit.redacted` without values.',
    params: orgParams,
    body: redactAuditLogsRequestSchema,
    status: 200,
    response: redactAuditLogsResponseSchema,
    forbidden: '`PERMISSION_DENIED` (not the organization owner) or `CSRF_INVALID`',
  });
  add({
    method: 'get',
    path: '/api/v1/jobs/{jobId}',
    operationId: 'getJob',
    tag: 'jobs',
    summary: 'Status of a background job',
    description:
      'Visible to the user who started the job and to owners/admins of its organization; ' +
      'an `audit.export` job only to organization owners/admins, an `audit.base_export` job ' +
      'also to its creator while still an admin of the base; anyone else gets `404`.',
    params: jobParams,
    status: 200,
    response: jobSchema,
  });
  registry.registerPath({
    method: 'get',
    path: '/api/v1/files/exports/{jobId}',
    operationId: 'downloadExport',
    tags: ['jobs'],
    summary: 'Download the file of an export job or the error report of an import',
    description:
      'The `download_url` of a succeeded export job, or of an import job with skipped rows ' +
      '(CSV error report, CONTRACTS §19). Only the job creator and organization ' +
      'owners/admins (audit exports: whoever `GET /jobs/{jobId}` shows them to), until ' +
      '`result.expires_at`; everything else is `404`. Redirects to a ' +
      'short-lived signed URL of the object storage.',
    security: [{ [SESSION_SECURITY_SCHEME]: [] }],
    request: { params: jobParams },
    responses: {
      302: { description: 'Redirect to a signed URL valid for 60 seconds' },
      401: problem('`UNAUTHENTICATED`'),
      404: problem('`NOT_FOUND`: no such file for the caller, or the link expired'),
      422: problem('`VALIDATION_FAILED`'),
    },
  });
};
