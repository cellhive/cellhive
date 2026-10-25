import { z } from 'zod';

import { tableExportQuerySchema, TABLE_EXPORT_MEDIA_TYPES } from '../../exports.js';
import { idOf } from '../../ids.js';
import { problemResponse, type RouteRegistrar } from '../types.js';

import { SESSION_SECURITY_SCHEME } from './auth.js';

const tableParams = z.object({ tableId: idOf('tbl') });
const binary = z.string().meta({ format: 'binary' });

/** Table export (SPEC §17, CONTRACTS §18; BACKLOG T307). */
export const registerExportRoutes: RouteRegistrar = (registry, components) => {
  const problem = (description: string) => problemResponse(components, description);
  registry.registerPath({
    method: 'get',
    path: '/api/v1/tables/{tableId}/export',
    operationId: 'exportTable',
    tags: ['export'],
    summary: 'Export the records of a table or view as CSV or XLSX',
    description:
      'Streams the file synchronously. Rows: the records the caller reads (record rule), ' +
      'through `view_id` when given (its filter, group and sort, then `__auto`); columns: ' +
      "fields the caller reads without the view's `hidden_fields`, in `field_order` then " +
      'display order. Values as `cell_format=text` in the locale and time zone of the caller ' +
      '(a datetime field with its own time zone keeps it); link cells: titles of the linked ' +
      'records the caller reads (others left out), `", "`-separated, a title with `,` or `"` ' +
      'quoted; `parent`: the parent title; attachments: file names. CSV: UTF-8 with BOM, CRLF, cells ' +
      "starting with `=`, `+`, `-`, `@`, tab or CR prefixed with `'`. XLSX: one sheet of string " +
      'cells. Needs `base_rule.download`. One running export per user. Audited as ' +
      '`export.created`. An error after the first byte aborts the connection (the file is ' +
      'incomplete); it cannot become a problem document.',
    security: [{ [SESSION_SECURITY_SCHEME]: [] }],
    request: { params: tableParams, query: tableExportQuerySchema },
    responses: {
      200: {
        description: 'The file, with `Content-Disposition: attachment`',
        headers: {
          'Content-Disposition': {
            description: '`attachment; filename="…"; filename*=UTF-8\'\'…`',
            schema: { type: 'string' },
          },
        },
        content: {
          [`${TABLE_EXPORT_MEDIA_TYPES.csv}; charset=utf-8`]: { schema: binary },
          [TABLE_EXPORT_MEDIA_TYPES.xlsx]: { schema: binary },
        },
      },
      401: problem('`UNAUTHENTICATED`'),
      403: problem(
        '`PERMISSION_DENIED`: the caller reads the table but has no `base_rule.download`',
      ),
      404: problem(
        '`NOT_FOUND`: the table, or the view (malformed id, another table, hidden by ' +
          '`visible_views`, personal view of someone else), is not visible to the caller',
      ),
      422: problem(
        '`VALIDATION_FAILED`: bad `format`, or `EXPORT_TOO_LARGE` (`params.limit`) when more ' +
          'records match than `EXPORT_MAX_ROWS`',
      ),
      429: problem(
        '`RATE_LIMITED` with `Retry-After`: another export of the caller is running, or the ' +
          'per-user / per-user-and-base request limits',
      ),
      504: problem('`QUERY_TIMEOUT`: counting the rows took longer than the statement timeout'),
    },
  });
};
