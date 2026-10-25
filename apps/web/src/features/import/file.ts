import { IMPORT_MAX_FILE_BYTES } from '@cellhive/contracts';

/**
 * Client-side checks of a chosen file (T318), before any byte is sent: the
 * server checks again (CONTRACTS §19: `413`, `415`) and decides on content,
 * not on the name.
 */

/** Extensions the importer reads: text files as CSV/TSV, workbooks as XLSX. */
export const IMPORT_EXTENSIONS = ['.csv', '.tsv', '.txt', '.xlsx'] as const;

/** `accept` of the file input. */
export const IMPORT_ACCEPT = [
  ...IMPORT_EXTENSIONS,
  'text/csv',
  'text/tab-separated-values',
  'text/plain',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
].join(',');

export type FileProblem = 'empty' | 'tooLarge' | 'unsupported' | 'legacyExcel';

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

/** Why `file` cannot be imported, or `null`. */
export function checkImportFile(file: {
  readonly name: string;
  readonly size: number;
}): FileProblem | null {
  const extension = extensionOf(file.name);
  if (extension === '.xls' || extension === '.ods' || extension === '.xlsm') return 'legacyExcel';
  if (!(IMPORT_EXTENSIONS as readonly string[]).includes(extension)) return 'unsupported';
  if (file.size === 0) return 'empty';
  if (file.size > IMPORT_MAX_FILE_BYTES) return 'tooLarge';
  return null;
}

const MAX_TABLE_NAME = 255;

/** Default name of a table made from `filename`: the name without its extension. */
export function tableNameFromFile(filename: string): string {
  const extension = extensionOf(filename);
  const base = extension === '' ? filename : filename.slice(0, -extension.length);
  return base.trim().slice(0, MAX_TABLE_NAME).trim();
}
