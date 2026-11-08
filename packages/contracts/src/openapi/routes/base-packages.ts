import { z } from 'zod';

import { baseExportRequestSchema } from '../../base-packages.js';
import { idOf } from '../../ids.js';
import { jobAcceptedSchema } from '../../jobs.js';
import { problemResponse, type RouteRegistrar } from '../types.js';

import { register, type RouteSpec } from './route-spec.js';

const baseParams = z.object({ baseId: idOf('bse') });

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
};
