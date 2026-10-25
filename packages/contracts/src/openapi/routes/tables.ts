import { z } from 'zod';

import {
  computedPreviewRequestSchema,
  computedPreviewResponseSchema,
} from '../../computed-fields.js';
import { deletePreviewSchema } from '../../field-conversions.js';
import { idOf } from '../../ids.js';
import { offsetQuerySchema } from '../../pagination.js';
import {
  createFieldRequestSchema,
  createTableRequestSchema,
  fieldListQuerySchema,
  fieldListSchema,
  fieldSchema,
  purgedTableResponseSchema,
  purgeTableRequestSchema,
  tableListSchema,
  tableSchema,
  trashedTableListSchema,
  updateFieldRequestSchema,
  updateFieldResponseSchema,
  updateTableRequestSchema,
} from '../../tables.js';
import { problemResponse, type RouteRegistrar } from '../types.js';

import { register, type RouteSpec } from './route-spec.js';

const baseParams = z.object({ baseId: idOf('bse') });
const tableParams = z.object({ tableId: idOf('tbl') });
const fieldParams = z.object({ fieldId: idOf('fld') });

const SCHEMA_RIGHTS =
  'Needs schema rights: base `admin` (base owner, workspace admin and organization ' +
  'owner/admin included) or table permission `manage`; others who can read the table get ' +
  '`403 PERMISSION_DENIED`.';
const NAME_CONFLICT = '`NAME_CONFLICT`: another table/field of the same scope has this name';
const FORMULA_ERRORS =
  '`FORMULA_SYNTAX_ERROR` / `FORMULA_TYPE_ERROR` / `FORMULA_LIMIT_EXCEEDED` / `FORMULA_CYCLE` ' +
  '(formula/lookup, `errors[].params.position`; CONTRACTS §6; `FORMULA_LIMIT_EXCEEDED` / ' +
  '`MAX_COMPILED_SIZE` when the compiled SQL would pass its size budget), `INVALID_FILTER` ' +
  '(lookup `where`)';
const SCHEMA_LOCKED =
  '`SCHEMA_LOCKED`: the table is being compacted, its column budget is exhausted or its schema ' +
  'is busy; retry later';

/** Tables and fields (SPEC §5.5, §13.1, §14.1; BACKLOG T103). */
export const registerTableRoutes: RouteRegistrar = (registry, components) => {
  const problem = (description: string) => problemResponse(components, description);
  const add = (spec: RouteSpec) => {
    register(registry, problem, spec);
  };

  // --- Tables ---
  add({
    method: 'get',
    path: '/api/v1/bases/{baseId}/tables',
    operationId: 'listTables',
    tag: 'tables',
    summary: 'Tables of a base the caller can see',
    description: 'Tables the caller has no permission on (`no_perm`) are not listed.',
    params: baseParams,
    query: offsetQuerySchema,
    status: 200,
    response: tableListSchema,
  });
  add({
    method: 'get',
    path: '/api/v1/bases/{baseId}/tables/trash',
    operationId: 'listTrashedTables',
    tag: 'tables',
    summary: 'Tables of the base in the trash',
    description:
      'Base admins only (others who can read the base get `403`; T469, CONTRACTS §13). Latest ' +
      'deletion first, with who deleted each table, when it will be purged, the link fields ' +
      'of other tables a permanent delete takes with it and the formula/lookup fields of ' +
      'other tables in `REF` because of it.',
    params: baseParams,
    status: 200,
    response: trashedTableListSchema,
  });
  add({
    method: 'post',
    path: '/api/v1/bases/{baseId}/tables',
    operationId: 'createTable',
    tag: 'tables',
    summary: 'Create a table with its primary text field',
    description:
      'Base admins only. Text columns use the collation of the base. Increases the base ' +
      '`permission_version`.',
    params: baseParams,
    body: createTableRequestSchema,
    status: 201,
    response: tableSchema,
    errors: { 409: NAME_CONFLICT },
  });
  add({
    method: 'get',
    path: '/api/v1/tables/{tableId}',
    operationId: 'getTable',
    tag: 'tables',
    summary: 'A table the caller can see',
    params: tableParams,
    status: 200,
    response: tableSchema,
  });
  add({
    method: 'patch',
    path: '/api/v1/tables/{tableId}',
    operationId: 'updateTable',
    tag: 'tables',
    summary: 'Rename a table, change its description or move it in the display order',
    description: SCHEMA_RIGHTS,
    params: tableParams,
    body: updateTableRequestSchema,
    status: 200,
    response: tableSchema,
    errors: { 409: `${NAME_CONFLICT}; ${SCHEMA_LOCKED}` },
  });
  add({
    method: 'delete',
    path: '/api/v1/tables/{tableId}',
    operationId: 'deleteTable',
    tag: 'tables',
    summary: 'Move a table to the trash',
    description:
      `${SCHEMA_RIGHTS} Meta only: the data stays until the table is purged. Increases the ` +
      'base `permission_version`.',
    params: tableParams,
    status: 204,
    errors: { 409: SCHEMA_LOCKED },
  });
  add({
    method: 'get',
    path: '/api/v1/tables/{tableId}/delete-preview',
    operationId: 'previewTableDelete',
    tag: 'tables',
    summary: 'What would stop working if the table went to the trash',
    description:
      'Base admins only (like the delete: others who see the table get `403`). Changes ' +
      'nothing (T460, CONTRACTS §13): `dependents` lists the formula/lookup fields of other ' +
      'tables the caller can read that would get `compute_error.code = REF`. The delete is ' +
      'never refused because of it.',
    params: tableParams,
    status: 200,
    response: deletePreviewSchema,
  });
  add({
    method: 'post',
    path: '/api/v1/tables/{tableId}/restore',
    operationId: 'restoreTable',
    tag: 'tables',
    summary: 'Restore a table from the trash',
    description:
      'Base admins only. The table goes to the end of the display order; its name must still ' +
      'be free. Increases the base `permission_version`.',
    params: tableParams,
    status: 200,
    response: tableSchema,
    errors: { 409: `${NAME_CONFLICT}; ${SCHEMA_LOCKED}` },
  });
  add({
    method: 'post',
    path: '/api/v1/tables/{tableId}/purge',
    operationId: 'purgeTable',
    tag: 'tables',
    summary: 'Permanently delete a table from the trash',
    description:
      'Cannot be undone (T461, CONTRACTS §13). Base admins only: someone who sees the live ' +
      'table gets `403`, anyone else `404` (trashed tables are visible to base admins only). ' +
      'Only a table in the trash (`422 VALIDATION_FAILED` / `TABLE_NOT_IN_TRASH`), confirmed ' +
      'by its exact name (`CONFIRM_NAME_MISMATCH`). Drops the data table and the junction of ' +
      'every link touching it; link fields of other tables pointing at it go to the trash for ' +
      'good (restore → `422 LINK_TABLE_PURGED`, `schema.changed` `deleted`); its views are ' +
      'deleted and their share links revoked (`410`); its files are deleted once no other ' +
      'table uses them. Emits one `table.purged` (event and audit entry `after = { name, ' +
      'record_count, partner_field_ids }`). Tables stay in the trash 30 days, then the daily ' +
      '`tables.purge` job does the same.',
    params: tableParams,
    body: purgeTableRequestSchema,
    status: 200,
    response: purgedTableResponseSchema,
    errors: { 409: SCHEMA_LOCKED },
  });

  // --- Fields ---
  add({
    method: 'get',
    path: '/api/v1/tables/{tableId}/fields',
    operationId: 'listFields',
    tag: 'fields',
    summary: 'Fields of a table the caller can see',
    description:
      'Fields the caller has no permission on (`no_perm`) are not listed. With ' +
      '`include_deleted=true` (schema rights only, else `403 PERMISSION_DENIED`) the restorable ' +
      'fields in the trash follow the live ones, newest deletion first, each with `deleted_at`.',
    params: tableParams,
    query: fieldListQuerySchema,
    status: 200,
    response: fieldListSchema,
  });
  add({
    method: 'post',
    path: '/api/v1/tables/{tableId}/fields',
    operationId: 'createField',
    tag: 'fields',
    summary: 'Add a field',
    description:
      `${SCHEMA_RIGHTS} Options are validated for the type. Increases the base ` +
      '`permission_version`.',
    params: tableParams,
    body: createFieldRequestSchema,
    status: 201,
    response: fieldSchema,
    errors: {
      409: `${NAME_CONFLICT}; ${SCHEMA_LOCKED}`,
      422:
        '`VALIDATION_FAILED` or `FIELD_LIMIT_EXCEEDED` (`errors[].params.limit`); ' +
        FORMULA_ERRORS,
    },
  });
  add({
    method: 'post',
    path: '/api/v1/tables/{tableId}/computed-preview',
    operationId: 'previewComputedField',
    tag: 'fields',
    summary: 'Preview a formula or lookup definition',
    description:
      `${SCHEMA_RIGHTS} Checks the definition like \`POST /tables/{tableId}/fields\` (same ` +
      '`422` errors with positions; with `field_id`, cycles through that field) and computes it ' +
      'on the first 5 records the caller reads (or `record_ids` among them), with the ' +
      "caller's read scope on every source table (CONTRACTS §13, BACKLOG T456). Runs under a " +
      '2 s statement timeout (`504 QUERY_TIMEOUT`); rate limited like writes. Stores nothing.',
    params: tableParams,
    body: computedPreviewRequestSchema,
    status: 200,
    response: computedPreviewResponseSchema,
    errors: {
      422: `\`VALIDATION_FAILED\`; ${FORMULA_ERRORS}`,
      504: '`QUERY_TIMEOUT`: the preview took more than 2 s',
    },
  });
  add({
    method: 'get',
    path: '/api/v1/fields/{fieldId}',
    operationId: 'getField',
    tag: 'fields',
    summary: 'A field the caller can see',
    params: fieldParams,
    status: 200,
    response: fieldSchema,
  });
  add({
    method: 'patch',
    path: '/api/v1/fields/{fieldId}',
    operationId: 'updateField',
    tag: 'fields',
    summary: 'Rename a field or change its description, options, style or position',
    description:
      `${SCHEMA_RIGHTS} Never changes the column type or truncates values: a change that ` +
      'would (a datetime format between date-only and date-time, select/user `multiple` ' +
      'true → false) answers `422 CONVERSION_NOT_ALLOWED`; it is a conversion ' +
      '(`PUT /fields/{fieldId}`, CONTRACTS §4.4). A field whose values are being converted ' +
      'answers `409 SCHEMA_LOCKED` (`FIELD_CONVERTING`).',
    params: fieldParams,
    body: updateFieldRequestSchema,
    status: 200,
    response: updateFieldResponseSchema,
    errors: {
      409: `${NAME_CONFLICT}; ${SCHEMA_LOCKED}`,
      422:
        '`VALIDATION_FAILED` (`UNKNOWN_OPTION` for a select option id the field does not have), ' +
        '`CONVERSION_NOT_ALLOWED`, `UNIQUE_VIOLATION` or `TOO_MANY_OPTIONS`; ' +
        FORMULA_ERRORS,
    },
  });
  add({
    method: 'delete',
    path: '/api/v1/fields/{fieldId}',
    operationId: 'deleteField',
    tag: 'fields',
    summary: 'Move a field to the trash',
    description:
      `${SCHEMA_RIGHTS} Restorable for 30 days. The primary field cannot be deleted ` +
      '(`422 VALIDATION_FAILED`, `errors[].code = PRIMARY_FIELD_NOT_DELETABLE`). Increases ' +
      'the base `permission_version`.',
    params: fieldParams,
    status: 204,
    errors: { 409: SCHEMA_LOCKED },
  });
  add({
    method: 'get',
    path: '/api/v1/fields/{fieldId}/delete-preview',
    operationId: 'previewFieldDelete',
    tag: 'fields',
    summary: 'What would stop working if the field went to the trash',
    description:
      `${SCHEMA_RIGHTS} Changes nothing (T460, CONTRACTS §13): \`dependents\` lists the views ` +
      'the caller sees and, for base admins, the roles that use the field, and the ' +
      'formula/lookup fields the caller can read that would get `compute_error.code = REF` ' +
      '(directly or through another computed field). The delete is never refused because of it.',
    params: fieldParams,
    status: 200,
    response: deletePreviewSchema,
  });
  add({
    method: 'post',
    path: '/api/v1/fields/{fieldId}/restore',
    operationId: 'restoreField',
    tag: 'fields',
    summary: 'Restore a deleted field with its data',
    description:
      'Within 30 days of the deletion (ADR-23 §3): the column is renamed back, so every value ' +
      'returns. Needs schema rights on the table (base `admin` or table permission `manage`); ' +
      'anyone else, a deletion older than 30 days and a purged column get `404`. Restoring a ' +
      'field that is not deleted answers it unchanged. The name must still be free and the ' +
      'active field limit applies. A link field whose linked table was purged (T461, ' +
      '`link_table_purged`) answers `422 VALIDATION_FAILED` / `LINK_TABLE_PURGED`. ' +
      'Increases the base `permission_version`.',
    params: fieldParams,
    status: 200,
    response: fieldSchema,
    errors: {
      409: `${NAME_CONFLICT}; ${SCHEMA_LOCKED}`,
      422: '`FIELD_LIMIT_EXCEEDED`; `VALIDATION_FAILED` / `LINK_TABLE_PURGED`',
    },
  });
};
