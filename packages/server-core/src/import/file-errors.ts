import { AppError } from '../errors/app-error.js';

/** Detail codes of an unreadable or oversized import file (CONTRACTS §6, §19). */
export type ImportFileProblem =
  'INVALID_FILE' | 'ARCHIVE_LIMIT_EXCEEDED' | 'TOO_MANY_ROWS' | 'EMPTY_FILE' | 'UNKNOWN_SHEET';

/**
 * `422 VALIDATION_FAILED` with one `errors[]` item on `file`. Messages
 * describe the file's structure only, never a cell value.
 */
export function importFileError(
  code: ImportFileProblem,
  message: string,
  params?: Readonly<Record<string, unknown>>,
): AppError {
  return new AppError('VALIDATION_FAILED', {
    detail: message,
    errors: [
      {
        path: code === 'UNKNOWN_SHEET' ? 'sheet' : 'file',
        code,
        message,
        ...(params === undefined ? {} : { params }),
      },
    ],
  });
}
