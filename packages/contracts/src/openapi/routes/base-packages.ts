import { z } from 'zod';

import { CSRF_COOKIE, CSRF_HEADER } from '../../auth.js';
import {
  BASE_PACKAGE_EXTENSION,
  BASE_PACKAGE_UPLOAD_FIELD,
  baseExportRequestSchema,
} from '../../base-packages.js';
import { idOf } from '../../ids.js';
import { jobAcceptedSchema } from '../../jobs.js';
import { problemResponse, type RouteRegistrar } from '../types.js';

import { SESSION_SECURITY_SCHEME } from './auth.js';
import { register, type RouteSpec } from './route-spec.js';

const baseParams = z.object({ baseId: idOf('bse') });
const workspaceParams = z.object({ workspaceId: idOf('wsp') });

/** Whole-base packages (`.chbase`, ADR-24, CONTRACTS §12.2). */
export const registerBasePackageRoutes: RouteRegistrar = (registry, components) => {
  const problem = (description: string) => problemResponse(components, description);
  const add = (spec: RouteSpec) => {
    register(registry, problem, spec);
  };

  add({
    method: 'post',
    path: '/api/v1/bases/{baseId}/export',
    operationId: 'exportBase',
    tag: 'bases',
    summary: 'Export the whole base as a `.chbase` package (background job)',
    description:
      'Base owners/admins and organization owners/admins only: the package holds every ' +
      'field of every table. A base the caller cannot open (also outside the `base_ids` of an ' +
      'API token) is `404` before any other check; a member who is not an admin of the base ' +
      'gets `403 PERMISSION_DENIED`. An API token needs `schema:read` and `automations:read` ' +
      'besides `records:read` (`403 INSUFFICIENT_SCOPE` listing those it lacks). Starts a ' +
      '`base.export` job (one export per organization runs at a time, others wait) and writes ' +
      '`base.exported` (counts, no value). Follow it with `GET /jobs/{jobId}`: its result is a ' +
      '`BaseExportResult` whose `download_url` (one hour) only the job creator while still an ' +
      'admin of the base and organization owners/admins can use. The package holds the schema, ' +
      'shared views, dashboards, automations (secrets, identities, groups and webhooks only by ' +
      'name), custom roles, the records outside the trash in storage form with users as ' +
      'emails, the links and the files; never personal views, the trash, share links, tokens, ' +
      'secret values, members or role assignments. A package over `BASE_PACKAGE_MAX_BYTES` ' +
      'fails the job with `VALIDATION_FAILED` `PACKAGE_TOO_LARGE`; one over another cap of the ' +
      'format with `INVALID_PACKAGE` `ARCHIVE_LIMIT_EXCEEDED`.',
    params: baseParams,
    body: baseExportRequestSchema,
    bodyOptional: true,
    status: 202,
    response: jobAcceptedSchema,
    forbidden:
      '`INSUFFICIENT_SCOPE` (API token without `schema:read`/`automations:read`), ' +
      '`PERMISSION_DENIED` (not an admin of the base) or `CSRF_INVALID`',
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/workspaces/{workspaceId}/bases/import',
    operationId: 'importBase',
    tags: ['bases'],
    summary: 'Import a `.chbase` package as a new base of the workspace (background job)',
    description:
      'Workspace admins and organization owners/admins only (the right to create a base). A ' +
      'workspace the caller cannot see (also another organization) is `404` before any other ' +
      'check; a member who may not create bases gets `403 PERMISSION_DENIED`. An API token ' +
      'needs `records:write` and `automations:write` besides `schema:write` (`403 ' +
      'INSUFFICIENT_SCOPE` listing those it lacks); a token limited to some bases cannot ' +
      `import (\`403 PERMISSION_DENIED\`). \`multipart/form-data\` with one part \`${BASE_PACKAGE_UPLOAD_FIELD}\` ` +
      `(a \`${BASE_PACKAGE_EXTENSION}\` file of at most \`BASE_PACKAGE_MAX_BYTES\`, 2 GiB by default), ` +
      'streamed to a temporary file and to object storage, never held in memory; its content ' +
      'is checked by the job only. Starts a `base.import` job (one import per organization ' +
      'runs at a time, others wait). The job checks the whole package before writing anything, ' +
      'builds the base hidden (`404` to everyone, the importer included, and never in the ' +
      'trash), then makes it visible with the importer as its owner; follow it with `GET ' +
      '/jobs/{jobId}`, whose result is a `BaseImportResult`. A package that is not a valid ' +
      'package fails the job with `INVALID_PACKAGE` (detail codes and package paths in ' +
      '`errors`); a failed, cancelled or interrupted import leaves nothing behind. The ' +
      '`Idempotency-Key` header is ignored (a streamed file cannot be fingerprinted). Requires ' +
      `the \`${CSRF_HEADER}\` header (value of the \`${CSRF_COOKIE}\` cookie) when authenticated by ` +
      'the session cookie.',
    security: [{ [SESSION_SECURITY_SCHEME]: [] }],
    request: {
      params: workspaceParams,
      body: {
        required: true,
        content: {
          'multipart/form-data': {
            schema: z.object({
              [BASE_PACKAGE_UPLOAD_FIELD]: z.string().meta({
                format: 'binary',
                description: `The \`${BASE_PACKAGE_EXTENSION}\` package`,
              }),
            }),
          },
        },
      },
    },
    responses: {
      202: {
        description: 'Accepted: the package is stored and the job queued',
        content: { 'application/json': { schema: jobAcceptedSchema } },
      },
      401: problem('`UNAUTHENTICATED`'),
      403: problem(
        '`INSUFFICIENT_SCOPE` (API token without `schema:write`, `records:write` or ' +
          '`automations:write`), `PERMISSION_DENIED` (may not create a base in the workspace, or ' +
          'an API token limited to some bases) or `CSRF_INVALID`',
      ),
      404: problem('`NOT_FOUND`: the workspace does not exist or is not visible to the caller'),
      413: problem(
        '`PAYLOAD_TOO_LARGE` with `errors[0] = { path: "file", code: "PACKAGE_TOO_LARGE", ' +
          'params: { limit } }`: the file is larger than `BASE_PACKAGE_MAX_BYTES`',
      ),
      415: problem(
        `\`UNSUPPORTED_MEDIA_TYPE\`: not \`multipart/form-data\`, or the file name does not end in \`${BASE_PACKAGE_EXTENSION}\``,
      ),
      422: problem('`VALIDATION_FAILED`: `FILE_REQUIRED` (no `file` part) or a malformed body'),
      429: problem('`RATE_LIMITED` with `Retry-After`'),
    },
  });
};
