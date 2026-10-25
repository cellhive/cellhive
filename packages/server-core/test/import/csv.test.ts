import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppError } from '../../src/errors/app-error.js';
import {
  CsvParser,
  detectDelimiter,
  detectEncoding,
  detectFileEncoding,
  detectImportFormat,
  openImportFile,
  parseCsv,
  type ImportFileRow,
} from '../../src/import/index.js';

/** Windows-1258 bytes: `ê` = EA, combining acute = EC, combining dot below = F2, `Đ` = D0, grave = CC, `ă` = E3, tilde = DE. */
const CP1258_TIENG_VIET = Buffer.from([
  0x54, 0x69, 0xea, 0xec, 0x6e, 0x67, 0x20, 0x56, 0x69, 0xea, 0xf2, 0x74,
]);
const CP1258_DA_NANG = Buffer.from([0xd0, 0x61, 0xcc, 0x20, 0x4e, 0xe3, 0xde, 0x6e, 0x67]);

describe('CsvParser (RFC 4180, lenient)', () => {
  it.each([
    [
      'plain',
      'a,b,c\n1,2,3\n',
      ',',
      [
        ['a', 'b', 'c'],
        ['1', '2', '3'],
      ],
    ],
    [
      'CRLF',
      'a,b\r\n1,2\r\n',
      ',',
      [
        ['a', 'b'],
        ['1', '2'],
      ],
    ],
    [
      'CR only',
      'a,b\r1,2',
      ',',
      [
        ['a', 'b'],
        ['1', '2'],
      ],
    ],
    [
      'no final newline',
      'a,b\n1,2',
      ',',
      [
        ['a', 'b'],
        ['1', '2'],
      ],
    ],
    ['quoted delimiter', '"a,b",c\n', ',', [['a,b', 'c']]],
    ['escaped quote', '"say ""hi""",x\n', ',', [['say "hi"', 'x']]],
    ['quoted line break', '"line 1\nline 2",x\n', ',', [['line 1\nline 2', 'x']]],
    ['empty cells', ',,\n', ',', [['', '', '']]],
    ['empty line kept as a record', 'a\n\nb\n', ',', [['a'], [], ['b']]],
    [
      'semicolon',
      'a;b\n1,5;2\n',
      ';',
      [
        ['a', 'b'],
        ['1,5', '2'],
      ],
    ],
    ['tab', 'a\tb\n', '\t', [['a', 'b']]],
    ['pipe', 'a|b\n', '|', [['a', 'b']]],
    ['quote inside unquoted cell', 'a"b,c\n', ',', [['a"b', 'c']]],
    ['text after closing quote', '"a"b,c\n', ',', [['ab', 'c']]],
    ['NFD normalised to NFC', 'Việt\n', ',', [['Việt']]],
  ] as const)('%s', (_name, text, delimiter, expected) => {
    expect(parseCsv(text, delimiter)).toEqual(expected);
  });

  it('gives the same records whatever the chunk boundaries', () => {
    const text = 'id,"note, with comma","q ""x"""\r\n1,"multi\r\nline",Đà Nẵng\r\n2,,end';
    const expected = parseCsv(text, ',');
    for (let size = 1; size <= text.length; size += 1) {
      const parser = new CsvParser({ delimiter: ',' });
      const records: string[][] = [];
      const collect = (cells: string[]) => records.push(cells);
      for (let start = 0; start < text.length; start += size) {
        parser.push(text.slice(start, start + size), collect);
      }
      parser.end(collect);
      expect(records, `chunk size ${String(size)}`).toEqual(expected);
    }
  });

  it('refuses a cell longer than the limit and too many columns (bounded memory)', () => {
    const long = new CsvParser({ delimiter: ',', maxCellChars: 10 });
    expect(() => {
      long.push('x'.repeat(11), () => undefined);
    }).toThrow(AppError);
    const wide = new CsvParser({ delimiter: ',', maxColumns: 3 });
    expect(() => {
      wide.push('a,b,c,d\n', () => undefined);
    }).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });
});

describe('detectDelimiter', () => {
  it.each([
    ['comma', 'name,amount,date\nA,1,2\nB,3,4\n', ','],
    [
      'semicolon (Excel, vi/de locales)',
      'Tên;Số tiền;Ngày\nA;1,5;25/09/2026\nB;2,5;26/09/2026\n',
      ';',
    ],
    ['tab', 'a\tb\tc\n1\t2\t3\n', '\t'],
    ['pipe', 'a|b\n1|2\n', '|'],
    ['commas inside quotes do not count', '"a,b";c\n"d,e";f\n', ';'],
    ['single column falls back to comma', 'only\nvalues\n', ','],
    ['cut last line ignored', 'a;b\n1;2\n3;4\n5,6,7,8,9', ';'],
  ] as const)('%s', (_name, sample, expected) => {
    expect(detectDelimiter(sample)).toBe(expected);
  });
});

describe('detectEncoding', () => {
  it.each([
    [
      'UTF-8 with BOM',
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Tiếng Việt')]),
      'utf-8-bom',
    ],
    ['UTF-8 with Vietnamese', Buffer.from('Tên,Đà Nẵng\n'), 'utf-8'],
    ['ASCII', Buffer.from('a,b\n'), 'utf-8'],
    ['Windows-1258', CP1258_TIENG_VIET, 'windows-1258'],
  ] as const)('%s', (_name, bytes, expected) => {
    expect(detectEncoding(bytes)).toBe(expected);
  });
});

describe('detectImportFormat', () => {
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0]);
  const text = Buffer.from('a,b');
  it.each([
    ['data.csv', text, 'csv'],
    ['data.TSV', text, 'csv'],
    ['data.txt', text, 'csv'],
    ['no-extension', text, 'csv'],
    ['book.xlsx', zip, 'xlsx'],
    ['book', zip, 'xlsx'],
    ['old.xls', ole, undefined],
    ['renamed.csv', ole, undefined],
    ['archive.zip', zip, undefined],
    ['sheet.ods', zip, undefined],
    ['image.png', text, undefined],
  ] as const)('%s', (name, head, expected) => {
    expect(detectImportFormat(name, head)).toBe(expected);
  });
});

describe('openImportFile (CSV files)', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cellhive-csv-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function rowsOf(
    bytes: Buffer,
    options = {},
  ): Promise<{ rows: ImportFileRow[]; file: Awaited<ReturnType<typeof openImportFile>> }> {
    const path = join(dir, `f${String(Math.random()).slice(2)}.csv`);
    await writeFile(path, bytes);
    const file = await openImportFile(path, 'csv', options);
    const rows: ImportFileRow[] = [];
    for await (const row of file.rows()) rows.push(row);
    return { rows, file };
  }

  it('reads a Windows-1258 file with Vietnamese tones as NFC text', async () => {
    const body = Buffer.concat([
      Buffer.from('Name;City\r\n'),
      CP1258_TIENG_VIET,
      Buffer.from(';'),
      CP1258_DA_NANG,
      Buffer.from('\r\n'),
    ]);
    const path = join(dir, 'cp1258.csv');
    await writeFile(path, body);
    expect(await detectFileEncoding(path)).toBe('windows-1258');
    const { rows, file } = await rowsOf(body);
    expect(file.encoding).toBe('windows-1258');
    expect(file.delimiter).toBe(';');
    expect(rows).toEqual([
      { line: 1, cells: ['Name', 'City'] },
      { line: 2, cells: ['Tiếng Việt', 'Đà Nẵng'] },
    ]);
  });

  it('drops the BOM of a UTF-8 BOM file and keeps line numbers across empty lines', async () => {
    const bytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('Tên,Số tiền\n\nNguyễn Văn A,1.500.000\n,\n"Trần B","2.000"\n'),
    ]);
    const { rows, file } = await rowsOf(bytes);
    expect(file.encoding).toBe('utf-8-bom');
    expect(rows).toEqual([
      { line: 1, cells: ['Tên', 'Số tiền'] },
      { line: 3, cells: ['Nguyễn Văn A', '1.500.000'] },
      { line: 5, cells: ['Trần B', '2.000'] },
    ]);
  });

  it('drops the CSV injection prefix of an exported file (T321)', async () => {
    const { rows } = await rowsOf(
      Buffer.from(
        'Tên,\'=Amount,Note\r\n\'-1.500.000 ₫,-1.500.000,"\'=HYPERLINK(""x"")"\r\n' +
          "It's,'-1,''=x\r\n",
      ),
    );
    expect(rows).toEqual([
      { line: 1, cells: ['Tên', '=Amount', 'Note'] },
      { line: 2, cells: ['-1.500.000 ₫', '-1.500.000', '=HYPERLINK("x")'] },
      // `''=x` is how export writes the text `'=x`.
      { line: 3, cells: ["It's", '-1', "'=x"] },
    ]);
  });

  it('honours forced options', async () => {
    const { rows, file } = await rowsOf(Buffer.from('a;b\n1;2\n'), { delimiter: ',' });
    expect(file.delimiter).toBe(',');
    expect(rows[0]?.cells).toEqual(['a;b']);
  });
});
