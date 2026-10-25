import { IMPORT_MAX_FILE_BYTES } from '@cellhive/contracts';
import { describe, expect, it } from 'vitest';

import { checkImportFile, tableNameFromFile } from '../file';

describe('checkImportFile', () => {
  it.each([
    ['khach-hang.csv', 10, null],
    ['KHACH.CSV', 10, null],
    ['data.tsv', 10, null],
    ['export.txt', 10, null],
    ['sales.xlsx', 10, null],
    ['sales.xlsx', IMPORT_MAX_FILE_BYTES, null],
    ['sales.xlsx', IMPORT_MAX_FILE_BYTES + 1, 'tooLarge'],
    ['empty.csv', 0, 'empty'],
    ['old.xls', 10, 'legacyExcel'],
    ['calc.ods', 10, 'legacyExcel'],
    ['macro.xlsm', 10, 'legacyExcel'],
    ['photo.png', 10, 'unsupported'],
    ['no-extension', 10, 'unsupported'],
  ] as const)('%s (%d bytes) → %s', (name, size, problem) => {
    expect(checkImportFile({ name, size })).toBe(problem);
  });
});

describe('tableNameFromFile', () => {
  it.each([
    ['Khách hàng.csv', 'Khách hàng'],
    ['  orders 2026.xlsx', 'orders 2026'],
    ['report.final.csv', 'report.final'],
    ['README', 'README'],
    [`${'a'.repeat(300)}.csv`, 'a'.repeat(255)],
  ])('%s → %s', (file, name) => {
    expect(tableNameFromFile(file)).toBe(name);
  });
});
