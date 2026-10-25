import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  analyzeImportFile,
  columnIndexOf,
  numberFormatKind,
  openImportFile,
  resolvePartPath,
  serialToIso,
  type ImportFileRow,
} from '../../src/import/index.js';
import { buildXlsx, buildZip, deflatedRepeat, sheetXml } from '../support/xlsx.js';

describe('XLSX helpers', () => {
  it.each([
    ['A1', 0],
    ['Z9', 25],
    ['AA10', 26],
    ['AB12', 27],
    ['XFD1', 16_383],
    ['12', undefined],
  ] as const)('columnIndexOf(%s)', (ref, index) => {
    expect(columnIndexOf(ref)).toBe(index);
  });

  it.each([
    ['0.00', 'number'],
    ['#,##0 "đ"', 'number'],
    ['dd/mm/yyyy', 'date'],
    ['yyyy-mm-dd hh:mm', 'datetime'],
    ['[h]:mm:ss', 'datetime'],
    ['"day" 0', 'number'],
    ['[Red]0.00', 'number'],
  ] as const)('numberFormatKind(%s)', (code, kind) => {
    expect(numberFormatKind(code)).toBe(kind);
  });

  it.each([
    [46290, 'date', false, '2026-09-25'],
    [46290.5, 'date', false, '2026-09-25T12:00:00'],
    [46290.354166666664, 'datetime', false, '2026-09-25T08:30:00'],
    [44828, 'date', true, '2026-09-25'],
  ] as const)('serialToIso(%s)', (serial, kind, date1904, iso) => {
    expect(serialToIso(serial, kind, date1904)).toBe(iso);
  });

  it.each([
    ['worksheets/sheet1.xml', 'xl/worksheets/sheet1.xml'],
    ['/xl/worksheets/sheet2.xml', 'xl/worksheets/sheet2.xml'],
    ['../xl/worksheets/s.xml', 'xl/worksheets/s.xml'],
    ['../../etc/passwd', undefined],
  ] as const)('resolvePartPath(%s)', (target, path) => {
    expect(resolvePartPath(target)).toBe(path);
  });
});

describe('XLSX files', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cellhive-xlsx-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function write(bytes: Buffer): Promise<string> {
    const path = join(dir, `f${String(Math.random()).slice(2)}.xlsx`);
    await writeFile(path, bytes);
    return path;
  }

  async function rowsOf(path: string, sheet?: string): Promise<ImportFileRow[]> {
    const file = await openImportFile(path, 'xlsx', { sheet });
    const rows: ImportFileRow[] = [];
    try {
      for await (const row of file.rows()) rows.push(row);
    } finally {
      file.close();
    }
    return rows;
  }

  it('reads shared/inline strings, numbers, booleans, dates and formulas, skipping empty rows', async () => {
    const path = await write(
      buildXlsx([
        {
          name: 'Đơn hàng',
          rows: [
            ['Tên', 'Số tiền', 'Ngày', 'Xong', 'Ghi chú', 'Hạn'],
            [
              'Nguyễn A',
              1500000,
              { date: 46290 },
              true,
              { inline: 'Tiếng Việt' },
              { datetime: 46290.354166666664 },
            ],
            [null, null, null, null, null, null],
            ['Trần B', 2.5, null, false, { formula: 'A2&"!"', value: 'x!' }],
          ],
        },
        { name: 'Khác', rows: [['a'], ['b']] },
      ]),
    );
    expect(await rowsOf(path)).toEqual([
      { line: 1, cells: ['Tên', 'Số tiền', 'Ngày', 'Xong', 'Ghi chú', 'Hạn'] },
      {
        line: 2,
        cells: ['Nguyễn A', 1500000, '2026-09-25', true, 'Tiếng Việt', '2026-09-25T08:30:00'],
      },
      { line: 4, cells: ['Trần B', 2.5, null, false, 'x!'] },
    ]);
    expect(await rowsOf(path, 'Khác')).toEqual([
      { line: 1, cells: ['a'] },
      { line: 2, cells: ['b'] },
    ]);
    await expect(rowsOf(path, 'Nope')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      errors: [expect.objectContaining({ code: 'UNKNOWN_SHEET' })],
    });
  });

  it('previews a workbook: sheets, header, guessed types', async () => {
    const path = await write(
      buildXlsx([
        {
          name: 'S1',
          rows: [
            ['Tên', 'Số tiền', 'Ngày', 'Trạng thái'],
            ['A', 1, { date: 46290 }, 'Mới'],
            ['B', 2, { date: 46291 }, 'Mới'],
            ['C', 3, { date: 46292 }, 'Xong'],
            ['D', 4, { date: 46293 }, 'Xong'],
          ],
        },
        { name: 'S2', rows: [['x']] },
      ]),
    );
    const { preview, options } = await analyzeImportFile(path, 'xlsx', { locale: 'vi' });
    expect(preview).toMatchObject({
      format: 'xlsx',
      encoding: null,
      delimiter: null,
      sheets: ['S1', 'S2'],
      sheet: 'S1',
      header_row: true,
      total_rows: 4,
    });
    expect(preview.columns.map((column) => [column.name, column.type])).toEqual([
      ['Tên', 'text'],
      ['Số tiền', 'number'],
      ['Ngày', 'datetime'],
      ['Trạng thái', 'select'],
    ]);
    expect(options).toMatchObject({
      sheet: 'S1',
      columns: ['Tên', 'Số tiền', 'Ngày', 'Trạng thái'],
    });
  });

  it('refuses a zip bomb from its directory, before inflating anything', async () => {
    // 200 MB of spaces compress to about 200 KB: a ratio of ~1 000.
    const sheet = deflatedRepeat(
      Buffer.from('<worksheet><sheetData>'),
      Buffer.alloc(1024 * 1024, 0x20),
      200,
      Buffer.from('</sheetData></worksheet>'),
    );
    const bytes = buildXlsx([{ name: 'S', rows: [['a']] }], {
      extra: [{ name: 'xl/worksheets/bomb.xml', data: sheet }],
    });
    const path = await write(bytes);
    const before = process.memoryUsage().rss;
    await expect(openImportFile(path, 'xlsx')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      errors: [expect.objectContaining({ code: 'ARCHIVE_LIMIT_EXCEEDED' })],
    });
    expect(process.memoryUsage().rss - before).toBeLessThan(100 * 1024 * 1024);
  });

  it('stops an entry that inflates past its declared size', async () => {
    const strings: string[] = [];
    const rows = Array.from({ length: 2000 }, (_, i) => [`row ${String(i)}`, i]);
    const real = sheetXml(rows, strings);
    // A workbook whose sheet part lies about its size.
    const lying = buildZip([
      {
        name: 'xl/workbook.xml',
        data: '<workbook><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>',
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        data: '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      },
      {
        name: 'xl/sharedStrings.xml',
        data: `<sst>${strings.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`,
      },
      { name: 'xl/worksheets/sheet1.xml', data: real, declaredSize: 100 },
    ]);
    const path = await write(lying);
    await expect(rowsOf(path)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses something that is not a workbook', async () => {
    const path = await write(buildZip([{ name: 'hello.txt', data: 'hi' }]));
    await expect(openImportFile(path, 'xlsx')).rejects.toMatchObject({
      errors: [expect.objectContaining({ code: 'INVALID_FILE' })],
    });
    const garbage = await write(Buffer.from('PK\u0003\u0004 not really a zip'));
    await expect(openImportFile(garbage, 'xlsx')).rejects.toMatchObject({
      errors: [expect.objectContaining({ code: 'INVALID_FILE' })],
    });
  });
});

describe('analyzeImportFile (CSV)', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cellhive-preview-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function write(text: string): Promise<string> {
    const path = join(dir, `f${String(Math.random()).slice(2)}.csv`);
    await writeFile(path, text);
    return path;
  }

  it('returns 200 rows, the full count and guesses with the base locale', async () => {
    const lines = ['Tên;Số tiền;Ngày;Xong'];
    for (let i = 0; i < 250; i += 1) lines.push(`KH ${String(i)};1.500.000;25/09/2026;x`);
    const { preview } = await analyzeImportFile(await write(lines.join('\n')), 'csv', {
      locale: 'vi',
    });
    expect(preview.total_rows).toBe(250);
    expect(preview.rows).toHaveLength(200);
    expect(preview.delimiter).toBe(';');
    expect(preview.encoding).toBe('utf-8');
    expect(preview.columns.map((column) => column.type)).toEqual([
      'text',
      'number',
      'datetime',
      'checkbox',
    ]);
  });

  it('pads short rows, names columns without a header row', async () => {
    const { preview } = await analyzeImportFile(await write('a,b,c\nd\n'), 'csv', {
      locale: 'vi',
      headerRow: false,
    });
    expect(preview.columns.map((column) => column.name)).toEqual([
      'Column 1',
      'Column 2',
      'Column 3',
    ]);
    expect(preview.rows).toEqual([
      ['a', 'b', 'c'],
      ['d', null, null],
    ]);
  });

  it('refuses more rows than the cap (422 TOO_MANY_ROWS) and files without data', async () => {
    const path = await write(['h', '1', '2', '3', '4'].join('\n'));
    await expect(
      analyzeImportFile(path, 'csv', { locale: 'vi', maxRows: 3 }),
    ).rejects.toMatchObject({
      status: 422,
      errors: [expect.objectContaining({ code: 'TOO_MANY_ROWS', params: { limit: 3 } })],
    });
    await expect(
      analyzeImportFile(await write('only,header\n'), 'csv', { locale: 'vi' }),
    ).rejects.toMatchObject({
      errors: [expect.objectContaining({ code: 'EMPTY_FILE' })],
    });
  });
});
