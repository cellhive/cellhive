import { z } from 'zod';

import {
  recordHistoryQuerySchema,
  recordHistoryResponseSchema,
  recordKeyParamsSchema,
  recordTrashQuerySchema,
  recordTrashResponseSchema,
  revertRecordRequestSchema,
  revertedRecordSchema,
} from '../../audit.js';
import { CSRF_COOKIE, CSRF_HEADER } from '../../auth.js';
import { idOf } from '../../ids.js';
import {
  deleteRecordQuerySchema,
  deleteRecordsRequestSchema,
  recordAncestorsResponseSchema,
  recordChildrenQuerySchema,
  recordTreeRequestSchema,
  recordTreeResponseSchema,
  restoreRecordsRequestSchema,
} from '../../record-tree.js';
import {
  createRecordsRequestSchema,
  deletedRecordsResponseSchema,
  MAX_GROUP_COUNT_GROUPS,
  MAX_RECORDS_PER_REQUEST,
  purgedRecordsResponseSchema,
  purgeRecordsRequestSchema,
  recordGetQuerySchema,
  recordGroupCountsRequestSchema,
  recordGroupCountsResponseSchema,
  recordListQuerySchema,
  recordListResponseSchema,
  recordQueryRequestSchema,
  recordReadParamsSchema,
  recordSchema,
  recordsResponseSchema,
  recordSummariesRequestSchema,
  recordSummariesResponseSchema,
  recordWriteParamsSchema,
  updateRecordRequestSchema,
  updateRecordsRequestSchema,
  upsertRecordsResponseSchema,
} from '../../records.js';
import { problemResponse, type RouteRegistrar } from '../types.js';

import { SESSION_SECURITY_SCHEME } from './auth.js';
import { IDEMPOTENCY_NOTE, idempotencyHeaders, withIdempotencyConflict } from './idempotency.js';

import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });

const CSRF_NOTE =
  `Requires the \`${CSRF_HEADER}\` header (value of the \`${CSRF_COOKIE}\` cookie) when ` +
  'authenticated by the session cookie.';

const NOT_VISIBLE =
  '`NOT_FOUND`: the table (or record) does not exist or is not readable by the caller ' +
  '(never `403` for something the caller cannot read)';

const RATE_LIMIT_NOTE =
  'Rate limited per user (60 requests/s) and per user and base (20 requests/s): ' +
  '`429 RATE_LIMITED` with `Retry-After`.';

const QUERY_RATE_LIMIT_NOTE =
  'Rate limited per user (60 requests/s) only, not per base, so that the grid can read ' +
  'blocks while scrolling fast: `429 RATE_LIMITED` with `Retry-After`.';

const WRITE_ERRORS = {
  409:
    '`VERSION_CONFLICT` (`errors[].params`: `current_version`, `version`, `updated_at` and ' +
    '`updated_by` `{ id, name }` of the current version; `updated_by` is `null` for system ' +
    'writes, `name` is `null` for non-members) or `SCHEMA_LOCKED`',
  413: `\`PAYLOAD_TOO_LARGE\`: more than ${String(MAX_RECORDS_PER_REQUEST)} records`,
  429: '`RATE_LIMITED`',
} as const;

const READ_ERRORS = {
  429: '`RATE_LIMITED`',
  504: '`QUERY_TIMEOUT`',
} as const;

type Method = 'get' | 'post' | 'patch' | 'delete';

interface RouteSpec {
  readonly method: Method;
  readonly path: string;
  readonly operationId: string;
  readonly summary: string;
  readonly description: string;
  readonly params: z.ZodObject;
  readonly query?: z.ZodObject;
  readonly body?: z.ZodType;
  /** Omitted for `204`. */
  readonly response?: z.ZodType;
  readonly status: 200 | 201 | 204;
  readonly errors: Readonly<Record<number, string>>;
  readonly idempotent?: boolean;
  /** Counted per user only, not per base (grid reads). */
  readonly perUserLimitOnly?: boolean;
  /** `204` when the written record is not readable by the caller afterwards. */
  readonly maybeNoContent?: boolean;
  /** Description of `422`. */
  readonly invalid: string;
  /** Description of `403`. */
  readonly forbidden: string;
}

function register(
  registry: OpenAPIRegistry,
  problem: (description: string) => ReturnType<typeof problemResponse>,
  spec: RouteSpec,
): void {
  const mutating = spec.method !== 'get';
  const responses: Record<number, object> = {
    [spec.status]:
      spec.response === undefined
        ? { description: 'Done' }
        : { description: 'Success', content: json(spec.response) },
    401: problem('`UNAUTHENTICATED`'),
    403: problem(spec.forbidden),
    404: problem(NOT_VISIBLE),
    422: problem(spec.invalid),
  };
  if (spec.maybeNoContent === true) {
    responses[204] = { description: 'Written, but the caller can no longer read the record' };
  }
  for (const [status, description] of Object.entries(spec.errors)) {
    responses[Number(status)] = problem(description);
  }
  if (spec.idempotent === true) {
    responses[409] = problem(withIdempotencyConflict(spec.errors[409]));
  }
  const description = [
    spec.description,
    spec.perUserLimitOnly === true ? QUERY_RATE_LIMIT_NOTE : RATE_LIMIT_NOTE,
    spec.idempotent === true ? IDEMPOTENCY_NOTE : undefined,
    mutating ? CSRF_NOTE : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(' ');
  registry.registerPath({
    method: spec.method,
    path: spec.path,
    operationId: spec.operationId,
    tags: ['records'],
    summary: spec.summary,
    description,
    security: [{ [SESSION_SECURITY_SCHEME]: [] }],
    request: {
      params: spec.params,
      ...(spec.query === undefined ? {} : { query: spec.query }),
      ...(spec.idempotent === true ? { headers: idempotencyHeaders } : {}),
      ...(spec.body === undefined ? {} : { body: { content: json(spec.body), required: true } }),
    },
    responses,
  });
}

const tableParams = z.object({ tableId: idOf('tbl') });
const recordParams = z.object({ tableId: idOf('tbl'), recordId: idOf('rec') });

const READ_FORBIDDEN = '`PERMISSION_DENIED`';
const WRITE_FORBIDDEN =
  '`PERMISSION_DENIED` (operation not allowed), `FIELD_READ_ONLY` (also a formula or lookup ' +
  'field the caller reads, with `params.type`), `RECORD_RULE_VIOLATION` or `CSRF_INVALID`';
const READ_INVALID =
  '`VALIDATION_FAILED` (`UNKNOWN_FIELD`, `TOO_BIG`…), `INVALID_FILTER` or `INVALID_SORT`';
const WRITE_INVALID =
  '`VALIDATION_FAILED`, `INVALID_CELL_VALUE`, `INVALID_SELECT_OPTION`, ' +
  '`REQUIRED_FIELD_MISSING`, `UNIQUE_VIOLATION`, `UPSERT_AMBIGUOUS`, `LINK_TARGET_NOT_FOUND` ' +
  '(also a new parent that is missing, trashed or unreadable; with `typecast` a title ' +
  'matching several readable records has the detail code `LINK_TARGET_AMBIGUOUS`), ' +
  '`SUBRECORD_CYCLE` or ' +
  '`SUBRECORD_TOO_DEEP` (`params.limit` = 10 levels)';
const TREE_INVALID =
  '`VALIDATION_FAILED` (`SUBRECORDS_NOT_ENABLED`: the table has no `parent` field the caller ' +
  'reads; `UNKNOWN_FIELD`…), `INVALID_FILTER` or `INVALID_SORT` (`FIELD_NOT_SORTABLE`)';

/** Record endpoints (SPEC §13.1, CONTRACTS §1.3–1.4). */
export const registerRecordRoutes: RouteRegistrar = (registry, components) => {
  const problem = (description: string) => problemResponse(components, description);
  const add = (spec: RouteSpec) => {
    register(registry, problem, spec);
  };

  add({
    method: 'post',
    path: '/api/v1/tables/{tableId}/records/query',
    operationId: 'queryRecords',
    perUserLimitOnly: true,
    summary: 'Query records (filter, sort, search, pagination)',
    description:
      'Body of SPEC §7.1. `filter` accepts the DSL or the tuple form of CONTRACTS §3. At most ' +
      '10 sort keys; empty cells sort last. Above 100 000 matching rows the response carries ' +
      '`total_estimate` instead of `total`. Fields the caller cannot read are absent, and ' +
      'cannot be filtered, sorted, grouped or searched on (same error as a missing field). ' +
      "With `view_id` (CONTRACTS §1.4): the view's filter is ANDed with the request's; ORDER BY " +
      "is group (the request's `group`, else the view's) → view sort → request sort → " +
      "creation order. The view's saved conditions apply even on fields the caller cannot " +
      "read; conditions on deleted fields are ignored; the view's `hidden_fields` do not " +
      'narrow `fields`.',
    params: tableParams,
    query: recordReadParamsSchema,
    body: recordQueryRequestSchema,
    status: 200,
    response: recordListResponseSchema,
    errors: READ_ERRORS,
    invalid: READ_INVALID,
    forbidden: '`CSRF_INVALID`',
  });
  add({
    method: 'post',
    path: '/api/v1/tables/{tableId}/records/tree',
    operationId: 'queryRecordTree',
    perUserLimitOnly: true,
    summary: 'One level of the sub-record tree (roots, or the children of a record)',
    description:
      'Sub-records (SPEC §5.7, CONTRACTS §1.4): without `parent_id` the roots of the visible ' +
      'tree, with it the children of that record, paged and ordered by view sort → request ' +
      'sort → creation order among siblings (never grouped: the view group is ignored). The ' +
      'visible tree holds the live records the caller reads; a record whose parent is ' +
      'unreadable or in the trash is a root. With a filter or search it holds the matches and, ' +
      "with `show_ancestors` (default: the view's `tree.show_ancestors`), their readable " +
      'ancestors flagged `ancestor_only`. Each record has `tree` = `{ parent_id, depth, ' +
      'children_count, ancestor_only }`; `children_count` never counts records the caller ' +
      'cannot read. A `parent_id` outside the visible tree is `404`.',
    params: tableParams,
    query: recordReadParamsSchema,
    body: recordTreeRequestSchema,
    status: 200,
    response: recordTreeResponseSchema,
    errors: READ_ERRORS,
    invalid: TREE_INVALID,
    forbidden: '`CSRF_INVALID`',
  });
  add({
    method: 'post',
    path: '/api/v1/tables/{tableId}/records/group-counts',
    operationId: 'countRecordGroups',
    summary: 'Count records per group',
    description:
      'Same WHERE as `records/query` (view filter, `filter`, `search`, read rule) grouped by ' +
      "`group` (else the view's group, at most 3 levels): one entry per combination of group " +
      'values with its row count, in the row order of `records/query`, at most ' +
      `${String(MAX_GROUP_COUNT_GROUPS)} (\`truncated: true\` beyond). Values use ` +
      '`cell_format`; `group[].field` uses `field_key_type`. A `group` field the caller cannot ' +
      "read is `422 INVALID_SORT` (`UNKNOWN_FIELD`); levels of the view's group on such fields " +
      'are left out. Without group levels: one entry with `values: []`.',
    params: tableParams,
    query: recordReadParamsSchema,
    body: recordGroupCountsRequestSchema,
    status: 200,
    response: recordGroupCountsResponseSchema,
    errors: READ_ERRORS,
    invalid: READ_INVALID,
    forbidden: '`CSRF_INVALID`',
  });
  add({
    method: 'post',
    path: '/api/v1/tables/{tableId}/records/summaries',
    operationId: 'summarizeRecords',
    summary: 'Summarize records (summary bar)',
    description:
      'The summary bar of a grid (T472, CONTRACTS §1.4, §15): one aggregate query over the ' +
      'records of `records/query` with the same view, `filter`, `filter_mode`, `search` and ' +
      "read rule — never loading records. `summaries` (field → function) replaces the view's " +
      'saved `config.summaries` (temporary change); saved entries on deleted fields, on fields ' +
      'the caller cannot read or that are locked for them, or with a function the field type ' +
      'no longer accepts are skipped (absent from the result). With group levels (`group`, ' +
      "else the view's, as in `records/group-counts`) every group of every level carries its " +
      `own summaries, at most ${String(MAX_GROUP_COUNT_GROUPS)} (\`truncated\`). A request ` +
      '`summaries` on a field the caller cannot read or that is locked for them (like ' +
      'filter/sort/group, T501) is `422 VALIDATION_FAILED` / `UNKNOWN_FIELD` (`path` ' +
      '`summaries.<field>`); a function the type does not accept `INVALID_FIELD_TYPE`. A ' +
      'cancelled statement is `504 QUERY_TIMEOUT`. Ignores `Idempotency-Key`.',
    params: tableParams,
    query: recordReadParamsSchema,
    body: recordSummariesRequestSchema,
    status: 200,
    response: recordSummariesResponseSchema,
    errors: READ_ERRORS,
    invalid: READ_INVALID,
    forbidden: '`CSRF_INVALID`',
  });
  add({
    method: 'get',
    path: '/api/v1/tables/{tableId}/records',
    operationId: 'listRecords',
    summary: 'List records',
    description:
      'The query of `POST …/records/query` as query-string parameters: repeat `fields` for ' +
      'several fields; `filter` and `sort` are JSON documents.',
    params: tableParams,
    query: recordListQuerySchema,
    status: 200,
    response: recordListResponseSchema,
    errors: READ_ERRORS,
    invalid: READ_INVALID,
    forbidden: READ_FORBIDDEN,
  });
  add({
    method: 'post',
    path: '/api/v1/tables/{tableId}/records',
    operationId: 'createRecords',
    summary: 'Create records',
    description:
      'Either `{ "records": [{ "fields": … }] }` (1–1 000, answered with `{ "records" }`) or a ' +
      'single `{ "fields": … }` (answered with the record). New select options are created ' +
      'only with `typecast=true` for fields whose options the caller may edit. A record the ' +
      'caller cannot read after the write is left out (single form: `204`).',
    params: tableParams,
    query: recordWriteParamsSchema,
    body: createRecordsRequestSchema,
    status: 201,
    response: z.union([recordsResponseSchema, recordSchema]),
    errors: WRITE_ERRORS,
    idempotent: true,
    maybeNoContent: true,
    invalid: WRITE_INVALID,
    forbidden: WRITE_FORBIDDEN,
  });
  add({
    method: 'patch',
    path: '/api/v1/tables/{tableId}/records',
    operationId: 'updateRecords',
    summary: 'Update records, or upsert',
    description:
      'Bulk update: `records[].id` with only the fields that change and an optional ' +
      '`version`. Upsert: `upsert.merge_on` (1–3 fields) and records without `id`; the ' +
      'response adds `created_ids` and `updated_ids`; more than one match is ' +
      '`422 UPSERT_AMBIGUOUS`.',
    params: tableParams,
    query: recordWriteParamsSchema,
    body: updateRecordsRequestSchema,
    status: 200,
    response: z.union([recordsResponseSchema, upsertRecordsResponseSchema]),
    errors: WRITE_ERRORS,
    invalid: WRITE_INVALID,
    forbidden: WRITE_FORBIDDEN,
  });
  add({
    method: 'delete',
    path: '/api/v1/tables/{tableId}/records',
    operationId: 'deleteRecords',
    summary: 'Move records to the trash',
    description:
      'Soft delete; needs the `delete` operation. Answers the ids moved to the trash (with ' +
      '`children: delete`, the requested ids then their descendants). Sub-records (T405): ' +
      'live children left behind become roots (`record.updated` on the parent field, same ' +
      '`batch_id`); `children: delete` trashes the descendants the caller may delete too.',
    params: tableParams,
    body: deleteRecordsRequestSchema,
    status: 200,
    response: deletedRecordsResponseSchema,
    errors: WRITE_ERRORS,
    invalid: '`VALIDATION_FAILED`',
    forbidden: WRITE_FORBIDDEN,
  });
  add({
    method: 'post',
    path: '/api/v1/tables/{tableId}/records/restore',
    operationId: 'restoreRecords',
    summary: 'Restore records from the trash',
    description:
      'Same rights as the trash: table permission `edit`/`manage`, the `delete` operation, and ' +
      'each record must match the caller’s edit rule (a record that does not is `404`, exactly ' +
      'like a missing one). Unique fields are checked again. `branch: true` also restores the ' +
      'descendants deleted together with each record (sub-records, T405).',
    params: tableParams,
    body: restoreRecordsRequestSchema,
    status: 200,
    response: recordsResponseSchema,
    errors: WRITE_ERRORS,
    idempotent: true,
    invalid: '`VALIDATION_FAILED` or `UNIQUE_VIOLATION`',
    forbidden: WRITE_FORBIDDEN,
  });
  add({
    method: 'post',
    path: '/api/v1/tables/{tableId}/records/trash/purge',
    operationId: 'purgeRecords',
    summary: 'Permanently delete records from the trash',
    description:
      'Cannot be undone (T408, CONTRACTS §11.3). Needs the table schema right — base admin or ' +
      'permission `manage` — and the `delete` operation (else `403 PERMISSION_DENIED`); each ' +
      'record must be in the caller’s trash (read and edit rules), else `404` exactly like a ' +
      'missing one. `branch: true` also purges the descendants deleted together with each ' +
      'record. Links to and from the records are removed, their children become roots, their ' +
      'files are deleted once no other record uses them. Emits one `record.purged` (event and ' +
      'audit entry `after = { count, record_ids }`); the record history then answers `404`, the ' +
      'audit log keeps every entry.',
    params: tableParams,
    body: purgeRecordsRequestSchema,
    status: 200,
    response: purgedRecordsResponseSchema,
    errors: WRITE_ERRORS,
    idempotent: true,
    invalid: '`VALIDATION_FAILED`',
    forbidden: '`PERMISSION_DENIED` (no schema right or no `delete` operation on the table)',
  });
  add({
    method: 'get',
    path: '/api/v1/tables/{tableId}/records/trash',
    operationId: 'listRecordTrash',
    summary: 'Records in the trash',
    description:
      'Needs table permission `edit`/`manage` and the `delete` operation (else ' +
      '`403 PERMISSION_DENIED`); only records matching the caller’s read and edit rules are ' +
      'listed, newest deletion first, with `deleted_at` and `deleted_by`. Cursor pagination ' +
      '(CONTRACTS §11.3): pass `next_cursor` back as `cursor`.',
    params: tableParams,
    query: recordTrashQuerySchema,
    status: 200,
    response: recordTrashResponseSchema,
    errors: READ_ERRORS,
    invalid: '`VALIDATION_FAILED` (`cursor`, `limit`)',
    forbidden: '`PERMISSION_DENIED` (no `edit` permission or `delete` operation on the table)',
  });
  add({
    method: 'get',
    path: '/api/v1/tables/{tableId}/records/{recordId}/children',
    operationId: 'listRecordChildren',
    summary: 'Sub-records of a record',
    description:
      'Live children the caller reads, in creation order (SPEC §5.7). The record must be live ' +
      'and readable (else `404`).',
    params: recordParams,
    query: recordChildrenQuerySchema,
    status: 200,
    response: recordListResponseSchema,
    errors: READ_ERRORS,
    invalid: TREE_INVALID,
    forbidden: READ_FORBIDDEN,
  });
  add({
    method: 'get',
    path: '/api/v1/tables/{tableId}/records/{recordId}/ancestors',
    operationId: 'listRecordAncestors',
    summary: 'Parent path of a record',
    description:
      'Ancestors root first (T405): readable ones as `{ id, title }`, the others as locked ' +
      'placeholders without id or title; the path stops at a parent in the trash. The record ' +
      'must be live and readable (else `404`).',
    params: recordParams,
    status: 200,
    response: recordAncestorsResponseSchema,
    errors: READ_ERRORS,
    invalid: TREE_INVALID,
    forbidden: READ_FORBIDDEN,
  });
  add({
    method: 'get',
    path: '/api/v1/tables/{tableId}/records/{recordId}/history',
    operationId: 'getRecordHistory',
    summary: 'History of a record',
    description:
      'Needs read access to the record now (else `404`). Entries are filtered to the fields ' +
      'the caller can read now; an entry that only changed hidden or deleted fields is left ' +
      'out. Values are rendered like `cell_format=json` against the current meta ' +
      '(CONTRACTS §11.1). `field` keeps only entries that changed that field. Newest first, ' +
      'cursor pagination. A change made through an API token has the token user as `actor` ' +
      'and `via.api_token_id` + `via.api_token_name` (current name, `null` once deleted) for ' +
      'organization owners/admins and the token owner; other readers get ' +
      '`api_token_id: null, api_token_name: null` (T705).',
    params: recordParams,
    query: recordHistoryQuerySchema,
    status: 200,
    response: recordHistoryResponseSchema,
    errors: READ_ERRORS,
    invalid: '`VALIDATION_FAILED` (`cursor`, `limit`, `field`: `UNKNOWN_FIELD`)',
    forbidden: READ_FORBIDDEN,
  });
  add({
    method: 'post',
    path: '/api/v1/tables/{tableId}/records/{recordId}/revert',
    operationId: 'revertRecord',
    summary: 'Set fields back to their value before a history entry',
    description:
      'A new update through the normal write path (permissions, record rules, `version`), ' +
      'audited with `via.reverted_from` (CONTRACTS §11.2). The entry must belong to this ' +
      'record of this table (else `404`). Only fields of the entry the caller can read now ' +
      'are set; none left is `404`. A readable field the caller cannot edit is ' +
      '`403 FIELD_READ_ONLY`. Link and `parent` fields (T465) are written back as record ids ' +
      'like any write (kept links stay even when unreadable; a record linked again must be ' +
      'linkable by the caller, else `422 LINK_TARGET_NOT_FOUND`); records deleted since are ' +
      'left out and counted in `skipped`. Answers the record like `PATCH` (`204` when the ' +
      'caller can no longer read it).',
    params: recordParams,
    query: recordKeyParamsSchema,
    body: revertRecordRequestSchema,
    status: 200,
    response: revertedRecordSchema,
    errors: WRITE_ERRORS,
    idempotent: true,
    maybeNoContent: true,
    invalid: WRITE_INVALID,
    forbidden: WRITE_FORBIDDEN,
  });
  add({
    method: 'get',
    path: '/api/v1/tables/{tableId}/records/{recordId}',
    operationId: 'getRecord',
    summary: 'One record',
    description: 'A record in the trash or outside the caller’s read rule is `404`.',
    params: recordParams,
    query: recordGetQuerySchema,
    status: 200,
    response: recordSchema,
    errors: READ_ERRORS,
    invalid: '`VALIDATION_FAILED` (`UNKNOWN_FIELD`)',
    forbidden: READ_FORBIDDEN,
  });
  add({
    method: 'patch',
    path: '/api/v1/tables/{tableId}/records/{recordId}',
    operationId: 'updateRecord',
    summary: 'Update one record',
    description:
      'Only the fields that change; optional `version`. Answers the record (`204` when the ' +
      'caller can no longer read it).',
    params: recordParams,
    query: recordWriteParamsSchema,
    body: updateRecordRequestSchema,
    status: 200,
    response: recordSchema,
    errors: WRITE_ERRORS,
    maybeNoContent: true,
    invalid: WRITE_INVALID,
    forbidden: WRITE_FORBIDDEN,
  });
  add({
    method: 'delete',
    path: '/api/v1/tables/{tableId}/records/{recordId}',
    operationId: 'deleteRecord',
    summary: 'Move one record to the trash',
    description:
      'Soft delete; needs the `delete` operation. `children` as for the bulk delete (default ' +
      '`promote`).',
    params: recordParams,
    query: deleteRecordQuerySchema,
    status: 204,
    errors: WRITE_ERRORS,
    invalid: '`VALIDATION_FAILED`',
    forbidden: WRITE_FORBIDDEN,
  });
};
