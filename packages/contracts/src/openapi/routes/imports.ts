import { z } from 'zod';

import { CSRF_COOKIE, CSRF_HEADER } from '../../auth.js';
import { idOf } from '../../ids.js';
import {
  IMPORT_MAX_FILE_BYTES,
  IMPORT_MAX_ROWS,
  importPreviewQuerySchema,
  importPreviewSchema,
  importUploadSchema,
  startImportRequestSchema,
} from '../../imports.js';
import { jobAcceptedSchema, jobSchema } from '../../jobs.js';
import { problemResponse, type RouteRegistrar } from '../types.js';

import { SESSION_SECURITY_SCHEME } from './auth.js';
import { register, type RouteSpec } from './route-spec.js';

const baseParams = z.object({ baseId: idOf('bse') });
const uploadParams = z.object({ baseId: idOf('bse'), uploadId: idOf('imp') });
const jobParams = z.object({ baseId: idOf('bse'), jobId: idOf('job') });

const WHO =
  'Needs a readable base (else `404`) and either base admin rights or a table the caller can ' +
  'add records to (else `403`). Uploads are private to their uploader: another user gets `404`.';
const FILE_ERRORS =
  `\`VALIDATION_FAILED\`: \`TOO_MANY_ROWS\` (more than ${String(IMPORT_MAX_ROWS)} data rows, ` +
  '`params.limit`), `EMPTY_FILE`, `INVALID_FILE` (unreadable CSV/XLSX, a cell over 1 000 000 ' +
  'characters, more than 1 000 columns), `ARCHIVE_LIMIT_EXCEEDED` (XLSX decompression limits), ' +
  '`UNKNOWN_SHEET`';

/** CSV/XLSX import (SPEC §17, CONTRACTS §19; BACKLOG T308). */
export const registerImportRoutes: RouteRegistrar = (registry, components) => {
  const problem = (description: string) => problemResponse(components, description);
  const add = (spec: RouteSpec) => {
    register(registry, problem, spec);
  };

  registry.registerPath({
    method: 'post',
    path: '/api/v1/bases/{baseId}/imports/uploads',
    operationId: 'uploadImportFile',
    tags: ['imports'],
    summary: 'Upload a CSV or XLSX file to import, with a first preview',
    description:
      `${WHO} \`multipart/form-data\` with one part \`file\` (CSV/TSV/TXT or XLSX, at most ` +
      `${String(IMPORT_MAX_FILE_BYTES / 1024 / 1024)} MB). The file is stored as a temporary ` +
      'upload for 24 hours; the preview detects the encoding (UTF-8, UTF-8 with BOM, ' +
      'Windows-1258) and delimiter of a CSV, lists the sheets of a workbook (first sheet ' +
      'previewed), returns the first 200 rows and guesses a type per column with the base’s ' +
      'locale. `Idempotency-Key` is ignored (a file body cannot be fingerprinted; a repeated ' +
      `upload only leaves an unused temporary file). Requires the \`${CSRF_HEADER}\` header ` +
      `(value of the \`${CSRF_COOKIE}\` cookie) when authenticated by the session cookie.`,
    security: [{ [SESSION_SECURITY_SCHEME]: [] }],
    request: {
      params: baseParams,
      body: {
        required: true,
        content: {
          'multipart/form-data': {
            schema: z.object({
              file: z.string().meta({ format: 'binary', description: 'The CSV or XLSX file' }),
            }),
          },
        },
      },
    },
    responses: {
      201: {
        description: 'Stored',
        content: { 'application/json': { schema: importUploadSchema } },
      },
      401: problem('`UNAUTHENTICATED`'),
      403: problem('`PERMISSION_DENIED` (visible but not allowed) or `CSRF_INVALID`'),
      404: problem('`NOT_FOUND`: the base does not exist or is not visible to the caller'),
      413: problem('`PAYLOAD_TOO_LARGE`: the file is larger than 50 MB'),
      415: problem(
        '`UNSUPPORTED_MEDIA_TYPE`: not `multipart/form-data`, or the file is neither CSV nor XLSX',
      ),
      422: problem(`${FILE_ERRORS}; \`FILE_REQUIRED\` (no \`file\` part)`),
      429: problem('`RATE_LIMITED` with `Retry-After`'),
    },
  });
  add({
    method: 'get',
    path: '/api/v1/bases/{baseId}/imports/uploads/{uploadId}/preview',
    operationId: 'previewImport',
    tag: 'imports',
    summary: 'Preview an uploaded file with other parse options',
    description:
      `${WHO} Options left out are detected again (encoding, delimiter) or defaulted (first ` +
      'sheet, header row on). The options of the latest preview are the ones the import uses. ' +
      'An expired or already used upload is `404`.',
    params: uploadParams,
    query: importPreviewQuerySchema,
    status: 200,
    response: importPreviewSchema,
    errors: { 422: FILE_ERRORS },
  });
  add({
    method: 'post',
    path: '/api/v1/bases/{baseId}/imports',
    operationId: 'startImport',
    tag: 'imports',
    summary: 'Import an uploaded file into a new or an existing table (background job)',
    description:
      '`create_table`: base admin only (else `403`); the table and its fields are created by the ' +
      'job with the confirmed types, the first column being the primary `text` field. The ' +
      'number of columns must fit the field budget of a new table (`TOO_MANY_COLUMNS`). ' +
      '`append`: the table must be visible (else `404`), with permission `edit` or more and the ' +
      '`add` operation (else `403`); every mapped field must be one the caller can see ' +
      '(`UNKNOWN_FIELD`) and write (`403 FIELD_READ_ONLY`), not an `attachment` field ' +
      '(`INVALID_FIELD_TYPE`), all checked before the job is queued. The upload is used up. ' +
      'Rows are written 1 000 per transaction with `typecast` in the base’s locale; link cells ' +
      'are record titles (the whole cell as one title, else a comma-separated list with ' +
      '`"…"` quoting, at most 500) and `parent` cells a title, matched exactly and uniquely ' +
      'among records the caller reads (row errors `LINK_TARGET_NOT_FOUND`, ' +
      '`LINK_TARGET_AMBIGUOUS`, `TOO_MANY_VALUES`); rows with invalid values are skipped and ' +
      'listed in the job result and its downloadable report (CONTRACTS §19).',
    params: baseParams,
    body: startImportRequestSchema,
    status: 202,
    response: jobAcceptedSchema,
    errors: {
      409: '`NAME_CONFLICT`: a table of the base already has this name (create mode)',
      422:
        '`VALIDATION_FAILED`: `UNKNOWN_COLUMN`, `DUPLICATE_COLUMN`, `DUPLICATE_FIELD`, ' +
        '`UNKNOWN_FIELD`, `INVALID_FIELD_TYPE` (first column not `text`; mapping to an ' +
        '`attachment` field), `TOO_MANY_COLUMNS`, ' +
        'invalid field options',
    },
  });
  add({
    method: 'post',
    path: '/api/v1/bases/{baseId}/imports/{jobId}/cancel',
    operationId: 'cancelImport',
    tag: 'imports',
    summary: 'Cancel an import job',
    description:
      'The job creator or an organization owner/admin (else `404`). A queued or running job ' +
      'becomes `cancelled`; the job stops after the batch in progress. Batches already ' +
      'written stay in an existing table; a table created by the import is moved to the trash. ' +
      'A finished job is returned unchanged.',
    params: jobParams,
    status: 200,
    response: jobSchema,
  });
};
