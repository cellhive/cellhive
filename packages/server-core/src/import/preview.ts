import {
  IMPORT_MAX_COLUMNS,
  IMPORT_MAX_ROWS,
  IMPORT_PREVIEW_ROWS,
  type ImportCell,
  type ImportFormat,
  type ImportPreview,
} from '@cellhive/contracts';

import { importFileError } from './file-errors.js';
import { guessColumnType } from './guess.js';
import { openImportFile, type ImportParseOptions } from './import-file.js';

import type { XlsxLimits } from './xlsx-reader.js';
import type { JsonObject } from '../db/schema.js';

/** Longest column name (a field name, SPEC §5.3). */
const MAX_COLUMN_NAME = 255;

/**
 * The options an import reads its file with, stored on the upload after
 * each preview (`meta.imports.options`) and used by the job as they are.
 */
export interface StoredImportOptions extends JsonObject {
  readonly encoding: ImportPreview['encoding'];
  readonly delimiter: ImportPreview['delimiter'];
  readonly sheet: string | null;
  readonly header_row: boolean;
  /** Column names of the preview, by index (error reports). */
  readonly columns: string[];
  readonly total_rows: number;
}

export interface AnalyzeImportOptions extends ImportParseOptions {
  /** First non-empty row holds column names (default `true`). */
  readonly headerRow?: boolean | undefined;
  /** Base locale for the type guesses (CONTRACTS §2). */
  readonly locale: string;
  /** Row cap (default `IMPORT_MAX_ROWS`); tests lower it. */
  readonly maxRows?: number;
  readonly xlsxLimits?: XlsxLimits;
}

export interface ImportAnalysis {
  readonly preview: ImportPreview;
  readonly options: StoredImportOptions;
}

/**
 * Column names from the header row: trimmed, `Column N` (1-based) when
 * empty, cut to 255 characters, and made unique ignoring case with a
 * ` (2)`, ` (3)`… suffix, since they become field names.
 */
export function columnNames(header: readonly ImportCell[], width: number): string[] {
  const taken = new Set<string>();
  const names: string[] = [];
  for (let index = 0; index < width; index += 1) {
    const cell = header[index];
    const raw = cell === null || cell === undefined ? '' : String(cell).normalize('NFC').trim();
    const base = (raw === '' ? `Column ${String(index + 1)}` : raw).slice(0, MAX_COLUMN_NAME);
    let name = base;
    for (let suffix = 2; taken.has(name.toLowerCase()); suffix += 1) {
      const tail = ` (${String(suffix)})`;
      name = `${base.slice(0, MAX_COLUMN_NAME - tail.length)}${tail}`;
    }
    taken.add(name.toLowerCase());
    names.push(name);
  }
  return names;
}

/**
 * Reads a whole import file once, as a stream (SPEC §17): the resolved
 * parse options, the header, the first 200 data rows, the number of data
 * rows and the widest row, and a type guess per column from the preview
 * rows. More than `IMPORT_MAX_ROWS` data rows → `422 TOO_MANY_ROWS`
 * (reading stops there); no data row → `422 EMPTY_FILE`.
 */
export async function analyzeImportFile(
  path: string,
  format: ImportFormat,
  options: AnalyzeImportOptions,
): Promise<ImportAnalysis> {
  const maxRows = options.maxRows ?? IMPORT_MAX_ROWS;
  const headerRow = options.headerRow ?? true;
  const file = await openImportFile(
    path,
    format,
    { encoding: options.encoding, delimiter: options.delimiter, sheet: options.sheet },
    options.xlsxLimits,
  );
  let header: ImportCell[] | undefined;
  const sample: ImportCell[][] = [];
  let total = 0;
  let width = 0;
  try {
    for await (const row of file.rows()) {
      width = Math.max(width, row.cells.length);
      if (headerRow && header === undefined) {
        header = row.cells;
        continue;
      }
      total += 1;
      if (total > maxRows) {
        throw importFileError('TOO_MANY_ROWS', `The file has more than ${String(maxRows)} rows.`, {
          limit: maxRows,
        });
      }
      if (sample.length < IMPORT_PREVIEW_ROWS) sample.push(row.cells);
    }
  } finally {
    file.close();
  }
  if (total === 0) throw importFileError('EMPTY_FILE', 'The file has no data row.');
  width = Math.min(width, IMPORT_MAX_COLUMNS);
  const names = columnNames(headerRow ? (header ?? []) : [], width);
  const rows = sample.map((cells) =>
    Array.from({ length: width }, (_, index) => cells[index] ?? null),
  );
  const columns = names.map((name, index) => {
    const guess = guessColumnType(
      rows.map((cells) => cells[index] ?? null),
      options.locale,
    );
    return { index, name, type: guess.type, options: guess.options };
  });
  const preview: ImportPreview = {
    format,
    encoding: file.encoding,
    delimiter: file.delimiter,
    sheets: [...file.sheets],
    sheet: file.sheet,
    header_row: headerRow,
    total_rows: total,
    columns,
    rows,
  };
  return {
    preview,
    options: {
      encoding: file.encoding,
      delimiter: file.delimiter,
      sheet: file.sheet,
      header_row: headerRow,
      columns: names,
      total_rows: total,
    },
  };
}
