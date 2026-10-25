import {
  MAX_RECORD_FOLLOWS_PER_USER,
  recordFollowParamsSchema,
  recordFollowSchema,
  TOO_MANY_FOLLOWS,
} from '../../record-follows.js';
import { problemResponse, type RouteRegistrar } from '../types.js';

import { register, type RouteSpec } from './route-spec.js';

const ACCESS =
  'The caller must be able to read the record now (table permission, read rule, not in the ' +
  'trash): anything else — a record, table or base the caller cannot read, another ' +
  'organization — is `404`. Share links have no follow route. Not audited, no event.';

/** Following records (CONTRACTS §22.5; ADR-29 §1, ADR-34 §2; BACKLOG T543). */
export const registerRecordFollowRoutes: RouteRegistrar = (registry, components) => {
  const problem = (description: string) => problemResponse(components, description);
  const add = (spec: RouteSpec) => {
    register(registry, problem, spec);
  };

  add({
    method: 'get',
    path: '/api/v1/tables/{tableId}/records/{recordId}/follow',
    operationId: 'getRecordFollow',
    tag: 'records',
    summary: 'Whether I follow a record, and why',
    description: `${ACCESS} \`source\` is \`null\` when the caller does not follow the record.`,
    params: recordFollowParamsSchema,
    status: 200,
    response: recordFollowSchema,
  });
  add({
    method: 'put',
    path: '/api/v1/tables/{tableId}/records/{recordId}/follow',
    operationId: 'followRecord',
    tag: 'records',
    summary: 'Follow a record',
    description:
      `${ACCESS} Idempotent: a record already followed keeps its \`source\`; otherwise the ` +
      `follow is \`manual\`. At most ${String(MAX_RECORD_FOLLOWS_PER_USER)} followed records ` +
      'per person and organization (records the person unfollowed do not count).',
    params: recordFollowParamsSchema,
    status: 204,
    forbidden: '`CSRF_INVALID`',
    errors: {
      422:
        `\`VALIDATION_FAILED\` with \`errors[].code = ${TOO_MANY_FOLLOWS}\` ` +
        `(\`params.maximum\` = ${String(MAX_RECORD_FOLLOWS_PER_USER)}): the caller already ` +
        'follows the most records allowed',
    },
  });
  add({
    method: 'delete',
    path: '/api/v1/tables/{tableId}/records/{recordId}/follow',
    operationId: 'unfollowRecord',
    tag: 'records',
    summary: 'Unfollow a record',
    description:
      `${ACCESS} Idempotent. Unfollowing by hand wins over every automatic source on this ` +
      'record: creating or being assigned never makes the caller follow it again — only ' +
      '`PUT …/follow` does.',
    params: recordFollowParamsSchema,
    status: 204,
    forbidden: '`CSRF_INVALID`',
  });
};
