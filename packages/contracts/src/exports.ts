import { z } from 'zod';

/**
 * Table export (SPEC §13.1, §17; CONTRACTS §18; BACKLOG T307):
 * `GET /tables/{tableId}/export?view_id=&format=` streams a CSV or XLSX
 * file synchronously (BACKLOG S3 decision 2).
 */

export const TABLE_EXPORT_FORMATS = ['csv', 'xlsx'] as const;
export const tableExportFormatSchema = z.enum(TABLE_EXPORT_FORMATS).meta({
  id: 'TableExportFormat',
  description: '`csv` (UTF-8 with BOM, CRLF) or `xlsx` (one sheet)',
});
export type TableExportFormat = z.infer<typeof tableExportFormatSchema>;

/** Default of `EXPORT_MAX_ROWS`: most rows one export may contain. */
export const DEFAULT_EXPORT_MAX_ROWS = 1_000_000;

/**
 * Detail code (`VALIDATION_FAILED`): more rows match than `EXPORT_MAX_ROWS`
 * (`params.limit`); nothing was streamed.
 */
export const EXPORT_TOO_LARGE = 'EXPORT_TOO_LARGE';

export const tableExportQuerySchema = z.object({
  view_id: z
    .string()
    .min(1)
    .optional()
    .meta({
      description:
        'Saved view to export through (its filter, sort, group, `hidden_fields` and ' +
        '`field_order`). A view the caller cannot see (or a malformed id) is `404`. ' +
        'Omitted: the whole table.',
    }),
  format: tableExportFormatSchema.default('csv'),
});
export type TableExportQuery = z.infer<typeof tableExportQuerySchema>;

/** Media type of each export format. */
export const TABLE_EXPORT_MEDIA_TYPES: Readonly<Record<TableExportFormat, string>> = {
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
