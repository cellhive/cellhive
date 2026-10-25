import { z } from 'zod';

import {
  convertFieldPreviewRequestSchema,
  convertFieldPreviewSchema,
  convertFieldRequestSchema,
  convertFieldResponseSchema,
  revertConversionPreviewSchema,
  revertConversionRequestSchema,
} from '../../field-conversions.js';
import { idOf } from '../../ids.js';
import { fieldSchema } from '../../tables.js';
import { problemResponse, type RouteRegistrar } from '../types.js';

import { register, type RouteSpec } from './route-spec.js';

const fieldParams = z.object({ fieldId: idOf('fld') });

const SCHEMA_RIGHTS =
  'Needs schema rights on the table: base `admin` or table permission `manage` (others who ' +
  'can see the field get `403 PERMISSION_DENIED`; a field or table they cannot see is `404`).';
const LOCKED =
  '`SCHEMA_LOCKED`: the values of the field are being converted (`FIELD_CONVERTING`), the table ' +
  'is being compacted, its column budget is exhausted (ADR-20) or its schema is busy; retry later';

/** Field type conversion (SPEC §5.5, CONTRACTS §4, ADR-23 §3; BACKLOG T403). */
export const registerFieldConversionRoutes: RouteRegistrar = (registry, components) => {
  const problem = (description: string) => problemResponse(components, description);
  const add = (spec: RouteSpec) => {
    register(registry, problem, spec);
  };

  add({
    method: 'post',
    path: '/api/v1/fields/{fieldId}/convert-preview',
    operationId: 'previewFieldConversion',
    tag: 'fields',
    summary: 'Dry run of a type or style change: counts, examples and dependents',
    description:
      `${SCHEMA_RIGHTS} Runs the conversion of CONTRACTS §4 over every record (the trash ` +
      'included) without writing anything: `affected`, `lost`, `truncated`, `new_options`, up ' +
      'to 20 `samples` from records the caller can read, `dependents`; `invalid` for `text` ' +
      'with style `email`/`phone` (values are never changed by a style). Counting runs in ' +
      'batches, each under the request `statement_timeout`.',
    params: fieldParams,
    body: convertFieldPreviewRequestSchema,
    status: 200,
    response: convertFieldPreviewSchema,
    errors: { 409: LOCKED },
  });
  add({
    method: 'put',
    path: '/api/v1/fields/{fieldId}',
    operationId: 'convertField',
    tag: 'fields',
    summary: 'Change the type of a field (conversion job)',
    description:
      `${SCHEMA_RIGHTS} Same body as the preview plus \`confirm\` / \`accept_data_loss\`. ` +
      'In one transaction: the column is renamed `f_x__old_<ms>` (kept 7 days for the revert), ' +
      'a new column is added, the field gets its new definition (`unique_values` is reset) and ' +
      'a `field.convert` job converts the values in batches of 5 000 (`202 { job_id }`, ' +
      'progress on `job.progress`). Until the job ends, record writes to the field and schema ' +
      'changes of it answer `409 SCHEMA_LOCKED`. The end sends `schema.changed` with action ' +
      '`converted` and emits `field.converted`. A change without data change (kind `none`: ' +
      'style, options, `multiple` false → true) is applied at once with `job_id: null`. ' +
      'Consumes one column slot (ADR-20).',
    params: fieldParams,
    body: convertFieldRequestSchema,
    status: 202,
    response: convertFieldResponseSchema,
    errors: {
      409: `${LOCKED}; \`NAME_CONFLICT\``,
      422:
        '`VALIDATION_FAILED`; `CONVERSION_NOT_ALLOWED` (target type not convertible, or values ' +
        'outside the whitelist without `accept_data_loss`); `CONVERSION_REQUIRES_CONFIRM` ' +
        '(values lost or truncated without `confirm`); `TOO_MANY_OPTIONS` (more than 1 000 ' +
        'select options)',
    },
  });
  add({
    method: 'post',
    path: '/api/v1/fields/{fieldId}/revert-conversion/preview',
    operationId: 'previewRevertFieldConversion',
    tag: 'fields',
    summary: 'What undoing the latest type conversion would lose',
    description:
      `${SCHEMA_RIGHTS} Within 7 days of the latest conversion of the field (ADR-23 §3), ` +
      'counts the cells written since the conversion (`changed`): the revert brings the old ' +
      'column back and loses them. No revertible conversion (none, older than 7 days, already ' +
      'reverted) → `404`.',
    params: fieldParams,
    status: 200,
    response: revertConversionPreviewSchema,
    errors: { 409: LOCKED },
  });
  add({
    method: 'post',
    path: '/api/v1/fields/{fieldId}/revert-conversion',
    operationId: 'revertFieldConversion',
    tag: 'fields',
    summary: 'Undo the latest type conversion of a field (7 days)',
    description:
      `${SCHEMA_RIGHTS} Restores the old column and definition (type, options, ` +
      '`unique_values`) at once; name, description and position stay. Values written since ' +
      'the conversion are lost: then `confirm: true` is required. Emits `field.converted` ' +
      '(`data.reverted_job_id`) and `schema.changed` `converted`; leaves one dropped column ' +
      'slot. No revertible conversion → `404`; a conversion still running → `409`.',
    params: fieldParams,
    body: revertConversionRequestSchema,
    bodyOptional: true,
    status: 200,
    response: fieldSchema,
    errors: {
      409: LOCKED,
      422: '`VALIDATION_FAILED` or `CONVERSION_REQUIRES_CONFIRM`',
    },
  });
};
