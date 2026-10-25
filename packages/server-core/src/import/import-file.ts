import { createReadStream } from 'node:fs';
import { open as openFile, stat } from 'node:fs/promises';

import { unescapeCsvInjection } from '../export/csv.js';

import { CsvParser, detectDelimiter } from './csv-parser.js';
import { createTextDecoder, detectFileEncoding } from './encoding.js';
import { importFileError } from './file-errors.js';
import { XlsxReader, type XlsxLimits, type XlsxSheet } from './xlsx-reader.js';

import type {
  ImportCell,
  ImportDelimiter,
  ImportEncoding,
  ImportFormat,
} from '@cellhive/contracts';

/** A row of an import file: `line` is its 1-based record/sheet row number. */
export interface ImportFileRow {
  readonly line: number;
  readonly cells: ImportCell[];
}

/** Parse options chosen by the user (the rest is detected). */
export interface ImportParseOptions {
  readonly encoding?: ImportEncoding | undefined;
  readonly delimiter?: ImportDelimiter | undefined;
  readonly sheet?: string | undefined;
}

/** The options actually used to read a file. */
export interface ResolvedImportFile {
  readonly format: ImportFormat;
  readonly encoding: ImportEncoding | null;
  readonly delimiter: ImportDelimiter | null;
  /** XLSX sheet names; `[]` for CSV. */
  readonly sheets: readonly string[];
  readonly sheet: string | null;
}

/** An open import file: its resolved options and a stream of its non-empty rows. */
export interface ImportFile extends ResolvedImportFile {
  rows(): AsyncGenerator<ImportFileRow, void, undefined>;
  close(): void;
}

/** Bytes of a CSV file read to detect its delimiter. */
const DELIMITER_SAMPLE_BYTES = 64 * 1024;

/**
 * The format of an uploaded file: XLSX when it is a zip archive (`PK\3\4`),
 * else CSV when the name says so (`.csv`, `.tsv`, `.txt`) or has no known
 * extension; `undefined` for other spreadsheet formats (`.xls`, `.ods`…).
 */
export function detectImportFormat(filename: string, head: Uint8Array): ImportFormat | undefined {
  const zip = head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  const extension = /\.([A-Za-z0-9]{1,8})$/.exec(filename)?.[1]?.toLowerCase();
  if (zip)
    return extension === undefined || extension === 'xlsx' || extension === 'xlsm'
      ? 'xlsx'
      : undefined;
  // An OLE2 compound file is a legacy .xls (or another Office binary format).
  if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0)
    return undefined;
  if (extension === undefined || ['csv', 'tsv', 'txt'].includes(extension)) return 'csv';
  return undefined;
}

/** The first `bytes` bytes of a file. */
export async function readHead(path: string, bytes: number): Promise<Buffer> {
  const handle = await openFile(path, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function isEmptyRow(cells: readonly ImportCell[]): boolean {
  return cells.every((cell) => cell === null || (typeof cell === 'string' && cell.trim() === ''));
}

async function openCsv(path: string, options: ImportParseOptions): Promise<ImportFile> {
  const encoding = options.encoding ?? (await detectFileEncoding(path));
  let delimiter = options.delimiter;
  if (delimiter === undefined) {
    const sample = createTextDecoder(encoding).decode(await readHead(path, DELIMITER_SAMPLE_BYTES));
    delimiter = detectDelimiter(sample);
  }
  const resolved = delimiter;
  return {
    format: 'csv',
    encoding,
    delimiter: resolved,
    sheets: [],
    sheet: null,
    close: () => undefined,
    async *rows() {
      const decoder = createTextDecoder(encoding);
      const parser = new CsvParser({ delimiter: resolved });
      const ready: ImportFileRow[] = [];
      let line = 0;
      const collect = (cells: string[]) => {
        line += 1;
        const row = cells.map((cell): ImportCell => (cell === '' ? null : cell));
        if (!isEmptyRow(row)) ready.push({ line, cells: row });
      };
      const stream = createReadStream(path, { highWaterMark: 64 * 1024 });
      try {
        for await (const chunk of stream) {
          parser.push(decoder.decode(chunk as Buffer, { stream: true }), collect);
          while (ready.length > 0) yield ready.shift() as ImportFileRow;
        }
        parser.push(decoder.decode(), collect);
        parser.end(collect);
        while (ready.length > 0) yield ready.shift() as ImportFileRow;
      } finally {
        stream.destroy();
      }
    },
  };
}

async function openXlsx(
  path: string,
  options: ImportParseOptions,
  limits: XlsxLimits | undefined,
): Promise<ImportFile> {
  const { size } = await stat(path);
  const reader = await XlsxReader.open(path, size, limits);
  let sheet: XlsxSheet | undefined;
  if (options.sheet === undefined) {
    sheet = reader.sheets[0];
  } else {
    const wanted = options.sheet.normalize('NFC');
    sheet = reader.sheets.find((item) => item.name === wanted);
  }
  if (sheet === undefined) {
    reader.close();
    throw importFileError('UNKNOWN_SHEET', 'The workbook has no sheet with this name.');
  }
  const chosen = sheet;
  return {
    format: 'xlsx',
    encoding: null,
    delimiter: null,
    sheets: reader.sheets.map((item) => item.name),
    sheet: chosen.name,
    close: () => {
      reader.close();
    },
    rows: () => reader.rows(chosen),
  };
}

/**
 * Opens a local import file for streaming (SPEC §17): CSV with its encoding
 * and delimiter (given or detected), or a sheet of an XLSX workbook (given,
 * else the first). Rows come out one at a time; fully empty rows are
 * skipped but keep their line number. Call `close` when done.
 */
export async function openImportFile(
  path: string,
  format: ImportFormat,
  options: ImportParseOptions = {},
  limits?: XlsxLimits,
): Promise<ImportFile> {
  const file =
    format === 'csv' ? await openCsv(path, options) : await openXlsx(path, options, limits);
  return { ...file, rows: () => unescapedRows(file.rows()) };
}

/**
 * Text cells without the `'` export puts before formula-like text (CSV
 * injection, CONTRACTS §18/§19, T321): the preview, the type guess and the
 * import all see `-1` for `'-1` and `=A1` for `'=A1`.
 */
async function* unescapedRows(
  rows: AsyncGenerator<ImportFileRow, void, undefined>,
): AsyncGenerator<ImportFileRow, void, undefined> {
  for await (const row of rows) {
    yield {
      line: row.line,
      cells: row.cells.map((cell) =>
        typeof cell === 'string' ? unescapeCsvInjection(cell) : cell,
      ),
    };
  }
}
