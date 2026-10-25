import { z } from 'zod';

import { CSRF_COOKIE, CSRF_HEADER } from '../../auth.js';
import { idOf } from '../../ids.js';
import { linkCandidatesRequestSchema, linkCandidatesResponseSchema } from '../../links.js';
import { problemResponse, type RouteRegistrar } from '../types.js';

import { SESSION_SECURITY_SCHEME } from './auth.js';

/** Link fields (SPEC §5.6, CONTRACTS §2; BACKLOG T402): the picker's candidate list. */
export const registerLinkRoutes: RouteRegistrar = (registry, components) => {
  const problem = (description: string) => problemResponse(components, description);
  registry.registerPath({
    method: 'post',
    path: '/api/v1/fields/{fieldId}/link-candidates',
    operationId: 'listLinkCandidates',
    tags: ['fields'],
    summary: 'Records a link picker may offer',
    description:
      'A read (no `Idempotency-Key`). Live records of the linked table the caller reads (table ' +
      'access and read rule) that match the field’s `record_filter` (resolved for the caller), ' +
      'in creation order, optionally narrowed by `search` (unaccented, case-insensitive ' +
      'substring of the primary field). With `ids`: exactly those records in that order, ' +
      '`record_filter` reported as `selectable` instead of applied. Items carry the title, up ' +
      'to 3 display fields the caller reads, `linked` (in the cell of `record_id`) and `full` ' +
      '(two-way link whose reverse cell is at its limit). Paging by `offset`/`limit` ' +
      '(`has_more`, no total). Rate limited per user (60 requests/s) and per user and base ' +
      `(20 requests/s). Requires the \`${CSRF_HEADER}\` header (value of the \`${CSRF_COOKIE}\` ` +
      'cookie) when authenticated by the session cookie.',
    security: [{ [SESSION_SECURITY_SCHEME]: [] }],
    request: {
      params: z.object({ fieldId: idOf('fld') }),
      body: { content: { 'application/json': { schema: linkCandidatesRequestSchema } } },
    },
    responses: {
      200: {
        description: 'Success',
        content: { 'application/json': { schema: linkCandidatesResponseSchema } },
      },
      401: problem('`UNAUTHENTICATED`'),
      403: problem(
        '`PERMISSION_DENIED`: the caller reads the field and the linked table but cannot ' +
          'write the field; or `CSRF_INVALID`',
      ),
      404: problem(
        '`NOT_FOUND`: the field is not a link field the caller reads, the caller cannot read ' +
          'the linked table (or it is in the trash), or `record_id` is not a record the caller ' +
          'reads (never `403` for something the caller cannot read)',
      ),
      422: problem(
        '`VALIDATION_FAILED` (`UNKNOWN_FIELD` at `search` when the caller cannot read the ' +
          'primary field of the linked table)',
      ),
      429: problem('`RATE_LIMITED`'),
      504: problem('`QUERY_TIMEOUT`'),
    },
  });
};
