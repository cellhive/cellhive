import { z } from 'zod';

import { booleanQueryParam, isoDateTimeSchema } from './common.js';
import { idOf } from './ids.js';

/**
 * CSV/XLSX import (SPEC §17, CONTRACTS §19; BACKLOG T308, S3 decision 6).
 *
 * Flow: upload a file (`POST /bases/:id/imports/uploads`, multipart) → the
 * response carries a preview with the detected encoding/delimiter/sheets,
 * the first 200 rows and a guessed type per column; change parse options
 * with `GET …/uploads/:uploadId/preview` → start the import
 * (`POST /bases/:id/imports`, `202 { job_id }`) in one of two modes; follow
 * `GET /jobs/:id` or `job.progress` on `user:{id}`; cancel with
 * `POST /bases/:id/imports/:jobId/cancel`.
 */

/** Data rows one import may hold (SPEC §17). More → `422 TOO_MANY_ROWS` at the preview. */
export const IMPORT_MAX_ROWS = 50_000;
/** Largest uploaded file (S3 decision 6). More → `413 PAYLOAD_TOO_LARGE`. */
export const IMPORT_MAX_FILE_BYTES = 50 * 1024 * 1024;
/** Rows returned by a preview, and rows the type guess looks at (SPEC §17). */
export const IMPORT_PREVIEW_ROWS = 200;
/** Records written per transaction by the import job (SPEC §7.3 bulk limit). */
export const IMPORT_BATCH_SIZE = 1000;
/** Most columns a file may have (hard cap of `MAX_FIELDS_PER_TABLE`). */
export const IMPORT_MAX_COLUMNS = 1000;
/** Longest cell, in characters; longer → the file is refused (`INVALID_FILE`). */
export const IMPORT_MAX_CELL_CHARS = 1_000_000;
/** An upload not used by an import is deleted after this many hours. */
export const IMPORT_UPLOAD_TTL_HOURS = 24;
/** The error report of a finished import can be downloaded for this many hours. */
export const IMPORT_REPORT_TTL_HOURS = 24;
/** Row errors listed in the job result; the downloadable report has the rest. */
export const IMPORT_RESULT_ERRORS = 100;
/** Row errors kept in the downloadable report (`errors_truncated` beyond). */
export const IMPORT_REPORT_MAX_ERRORS = 100_000;
/** `meta.jobs.type` of an import (CONTRACTS §12.2). */
export const IMPORT_JOB_TYPE = 'table.import';

/** Detail code (`VALIDATION_FAILED`): the file or sheet has more than `params.limit` data rows. */
export const TOO_MANY_ROWS = 'TOO_MANY_ROWS';
/**
 * Detail code (`VALIDATION_FAILED`): more columns than the table can take
 * (`params.limit`: the field budget left, SPEC §5.4).
 */
export const TOO_MANY_COLUMNS = 'TOO_MANY_COLUMNS';
/** Detail code (`VALIDATION_FAILED`): the file cannot be read as CSV/XLSX (corrupt, cell too long…). */
export const INVALID_FILE = 'INVALID_FILE';
/**
 * Detail code (`VALIDATION_FAILED`): the XLSX archive exceeds a decompression
 * limit (zip bomb protection, ADR-24): too many entries, an entry or the
 * total larger than allowed, or a compression ratio above the limit.
 */
export const ARCHIVE_LIMIT_EXCEEDED = 'ARCHIVE_LIMIT_EXCEEDED';
/** Detail code (`VALIDATION_FAILED`): `sheet` is not a sheet of the workbook. */
export const UNKNOWN_SHEET = 'UNKNOWN_SHEET';
/** Detail code (`VALIDATION_FAILED`): a column index outside the previewed columns. */
export const UNKNOWN_COLUMN = 'UNKNOWN_COLUMN';
/** Detail code (`VALIDATION_FAILED`): a column is used twice in `table.columns`. */
export const DUPLICATE_COLUMN = 'DUPLICATE_COLUMN';
/** Detail code (`VALIDATION_FAILED`): the multipart body has no `file` part. */
export const FILE_REQUIRED = 'FILE_REQUIRED';
/** Detail code (`VALIDATION_FAILED`): the file has no data row (after the header row). */
export const EMPTY_FILE = 'EMPTY_FILE';
/**
 * Row error code of an import (`ImportRowError.code`, T411): a title of a
 * link (or `parent`) cell matches more than one record the importer reads.
 * A title matching none is `LINK_TARGET_NOT_FOUND` (CONTRACTS §19).
 */
export const LINK_TARGET_AMBIGUOUS = 'LINK_TARGET_AMBIGUOUS';

export const IMPORT_FORMATS = ['csv', 'xlsx'] as const;
export const importFormatSchema = z.enum(IMPORT_FORMATS).meta({ id: 'ImportFormat' });
export type ImportFormat = z.infer<typeof importFormatSchema>;

/** Text encodings of a CSV file; detected, or forced by the preview. */
export const IMPORT_ENCODINGS = ['utf-8', 'utf-8-bom', 'windows-1258'] as const;
export const importEncodingSchema = z.enum(IMPORT_ENCODINGS).meta({ id: 'ImportEncoding' });
export type ImportEncoding = z.infer<typeof importEncodingSchema>;

/** Field delimiters of a CSV file; detected, or forced by the preview. */
export const IMPORT_DELIMITERS = [',', ';', '\t', '|'] as const;
export const importDelimiterSchema = z.enum(IMPORT_DELIMITERS).meta({ id: 'ImportDelimiter' });
export type ImportDelimiter = z.infer<typeof importDelimiterSchema>;

export const IMPORT_MODES = ['create_table', 'append'] as const;
export const importModeSchema = z.enum(IMPORT_MODES).meta({ id: 'ImportMode' });
export type ImportMode = z.infer<typeof importModeSchema>;

/** Field types a new table's column may get (the S1 types a user can enter). */
export const IMPORT_FIELD_TYPES = ['text', 'number', 'select', 'datetime', 'checkbox'] as const;
export const importFieldTypeSchema = z.enum(IMPORT_FIELD_TYPES);
export type ImportFieldType = z.infer<typeof importFieldTypeSchema>;

/**
 * A cell as read from the file: CSV cells are strings (`null` when empty);
 * XLSX keeps numbers and booleans, and date-formatted numbers become ISO 8601
 * (`YYYY-MM-DD` or `YYYY-MM-DDTHH:mm:ss`, no zone).
 */
export const importCellSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type ImportCell = z.infer<typeof importCellSchema>;

/**
 * Parse options of `GET …/uploads/:uploadId/preview`. Omitted options are
 * detected (encoding, delimiter) or defaulted (first sheet, header row on).
 * The options of the latest preview are the ones the import uses.
 */
export const importPreviewQuerySchema = z.strictObject({
  sheet: z.string().min(1).max(255).optional().meta({ description: 'XLSX sheet name' }),
  delimiter: importDelimiterSchema.optional(),
  encoding: importEncodingSchema.optional(),
  header_row: booleanQueryParam.optional().meta({
    description: 'First row holds column names (default `true`); `false` names them `Column 1…`',
  }),
});
export type ImportPreviewQuery = z.infer<typeof importPreviewQuerySchema>;

export const importColumnSchema = z
  .strictObject({
    /** 0-based position in the file; mappings refer to it. */
    index: z.int().min(0),
    /** Header cell (trimmed, made unique); `Column N` when empty or without a header row. */
    name: z.string(),
    /** Type guessed from the first 200 rows with the base's locale. */
    type: importFieldTypeSchema,
    /** Options for `type` (e.g. `select` options, `datetime` format); `{}` for defaults. */
    options: z.record(z.string(), z.unknown()),
  })
  .meta({ id: 'ImportColumn' });
export type ImportColumn = z.infer<typeof importColumnSchema>;

export const importPreviewSchema = z
  .strictObject({
    format: importFormatSchema,
    /** CSV only. */
    encoding: importEncodingSchema.nullable(),
    /** CSV only. */
    delimiter: importDelimiterSchema.nullable(),
    /** XLSX sheet names in workbook order; `[]` for CSV. */
    sheets: z.array(z.string()),
    /** The previewed sheet (XLSX), else `null`. */
    sheet: z.string().nullable(),
    header_row: z.boolean(),
    /** Data rows (header excluded, fully empty rows skipped), at most `IMPORT_MAX_ROWS`. */
    total_rows: z.int().min(0),
    columns: z.array(importColumnSchema),
    /** The first 200 data rows; each has one cell per column. */
    rows: z.array(z.array(importCellSchema)),
  })
  .meta({ id: 'ImportPreview' });
export type ImportPreview = z.infer<typeof importPreviewSchema>;

export const importUploadSchema = z
  .strictObject({
    id: idOf('imp'),
    /** Original file name (display only). */
    filename: z.string(),
    format: importFormatSchema,
    size: z.int().min(0),
    /** The upload is deleted after this time unless an import used it. */
    expires_at: isoDateTimeSchema,
    /** Preview with detected options. */
    preview: importPreviewSchema,
  })
  .meta({ id: 'ImportUpload' });
export type ImportUploadDto = z.infer<typeof importUploadSchema>;

const MAX_NAME = 255;
const columnIndexSchema = z
  .int()
  .min(0)
  .max(IMPORT_MAX_COLUMNS - 1);

export const importNewColumnSchema = z.strictObject({
  column: columnIndexSchema,
  /** Field name (unique in the new table, ignoring case). */
  name: z.string().trim().min(1).max(MAX_NAME),
  type: importFieldTypeSchema,
  /** Field options for `type` (as for `POST /tables/:id/fields`); default `{}`. */
  options: z.record(z.string(), z.unknown()).optional(),
});
export type ImportNewColumn = z.infer<typeof importNewColumnSchema>;

export const importCreateTableRequestSchema = z.strictObject({
  upload_id: idOf('imp'),
  mode: z.literal('create_table'),
  table: z.strictObject({
    name: z.string().trim().min(1).max(MAX_NAME),
    /**
     * Columns to import, in field order. The first one becomes the primary
     * field and must be `text`. Columns left out are not imported.
     */
    columns: z.array(importNewColumnSchema).min(1).max(IMPORT_MAX_COLUMNS),
  }),
});

export const importMappingItemSchema = z.strictObject({
  column: columnIndexSchema,
  field_id: idOf('fld'),
});

export const importAppendRequestSchema = z.strictObject({
  upload_id: idOf('imp'),
  mode: z.literal('append'),
  table_id: idOf('tbl'),
  /** Column → field. A field appears once; columns left out are not imported. */
  mapping: z.array(importMappingItemSchema).min(1).max(IMPORT_MAX_COLUMNS),
});

export const startImportRequestSchema = z
  .discriminatedUnion('mode', [importCreateTableRequestSchema, importAppendRequestSchema])
  .meta({ id: 'StartImportRequest' });
export type StartImportRequest = z.infer<typeof startImportRequestSchema>;

/** One skipped row problem of an import (job result and report). */
export const importRowErrorSchema = z
  .strictObject({
    /** 1-based row of the file/sheet as a spreadsheet shows it (header row included). */
    row: z.int().min(1),
    /**
     * 1-based number of the data row (blank rows and the header row not
     * counted), as the preview numbers its rows (T320). Absent on results
     * written before it existed.
     */
    data_row: z.int().min(1).optional(),
    /** 0-based column index; `null` when the problem is the whole row. */
    column: z.int().min(0).nullable(),
    column_name: z.string().nullable(),
    field_id: idOf('fld').nullable(),
    /**
     * A CONTRACTS §6 code, e.g. `EXPECTED_NUMBER`, `REQUIRED_FIELD_MISSING`, `UNIQUE_VIOLATION`,
     * `LINK_TARGET_NOT_FOUND`, `LINK_TARGET_AMBIGUOUS`, `TOO_MANY_VALUES`.
     */
    code: z.string(),
  })
  .meta({ id: 'ImportRowError' });
export type ImportRowError = z.infer<typeof importRowErrorSchema>;

/** `result` of a succeeded `table.import` job (CONTRACTS §19). */
export const importJobResultSchema = z
  .strictObject({
    mode: importModeSchema,
    table_id: idOf('tbl'),
    /** Data rows read. */
    rows: z.int().min(0),
    imported: z.int().min(0),
    /** Rows skipped because of a row error. */
    failed: z.int().min(0),
    /** The first 100 row errors, in file order. */
    errors: z.array(importRowErrorSchema),
    /** Every row error was kept in the report (`false` past 100 000). */
    errors_truncated: z.boolean(),
    /**
     * CSV report of every row error (`row,column,column_name,field_id,code,data_row,value`;
     * `value` = the rejected cell as read from the file); only when `failed > 0`. Downloadable
     * by the person who ran the import only (it holds file values).
     */
    download_url: z.string().optional(),
    expires_at: isoDateTimeSchema.optional(),
  })
  .meta({ id: 'ImportJobResult' });
export type ImportJobResult = z.infer<typeof importJobResultSchema>;
