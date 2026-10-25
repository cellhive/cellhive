import { buffer } from 'node:stream/consumers';

import { streamXlsxRows } from 'hucre/xlsx';
import { describe, expect, it } from 'vitest';

import {
  csvCell,
  sheetNameOf,
  unescapeCsvInjection,
  tableExportBody,
  tableExportDisposition,
} from '../../src/export/index.js';

import type { RecordOutput, RecordStreamField, RecordStreamTarget } from '../../src/index.js';

const fields: RecordStreamField[] = [
  { id: 'fld_title0000000001', name: 'Tiêu đề', type: 'text' },
  { id: 'fld_amount000000001', name: '=Amount', type: 'number' },
  { id: 'fld_note00000000001', name: 'Note', type: 'text' },
] as RecordStreamField[];

function record(values: Record<string, string>): RecordOutput {
  return {
    id: 'rec_A1b2C3d4E5f6G7h8',
    created_at: '2026-09-24T00:00:00.000Z',
    updated_at: '2026-09-24T00:00:00.000Z',
    version: 1,
    fields: values,
  };
}

const chunks: RecordOutput[][] = [
  [
    record({ fld_title0000000001: 'Máy POS', fld_amount000000001: '-1.500 ₫' }),
    record({ fld_title0000000001: '=HYPERLINK("x")', fld_note00000000001: 'a, "b"\nc' }),
  ],
  [record({ fld_title0000000001: '@SUM(A1)', fld_amount000000001: '+5', fld_note00000000001: '' })],
  [record({ fld_title0000000001: 'Hoàn tiền', fld_amount000000001: '-2.000' })],
];

async function* source(): AsyncGenerator<RecordOutput[]> {
  for (const chunk of chunks) {
    await Promise.resolve();
    yield chunk;
  }
}

const target: RecordStreamTarget = {
  table: { id: 'tbl_A1b2C3d4E5f6G7h8', name: 'Đơn hàng' },
  view: { id: 'viw_A1b2C3d4E5f6G7h8', name: 'Của tôi: [mới]' },
};

describe('csvCell (CSV injection, RFC 4180)', () => {
  it.each([
    [null, ''],
    ['plain', 'plain'],
    ['=1+1', "'=1+1"],
    ['+1', "'+1"],
    ['@x', "'@x"],
    ['\tx', "'\tx"],
    ['\rx', `"'\rx"`],
    ['a,b', '"a,b"'],
    ['say "hi"', '"say ""hi"""'],
    ['=a,b', `"'=a,b"`],
    ['line\nbreak', '"line\nbreak"'],
    // Plain numbers are not formulas (T321): no prefix.
    ['-1', '-1'],
    ['-0', '-0'],
    ['-1.5', '-1.5'],
    ['-1.500.000', '-1.500.000'],
    ['-1,5', '"-1,5"'],
    ['-1,500,000.25', '"-1,500,000.25"'],
    ['1.500.000', '1.500.000'],
    // Anything else starting with a formula character keeps the prefix.
    ["-2+3+cmd|' /C calc'!A0", `'-2+3+cmd|' /C calc'!A0`],
    ['-1.500.000 ₫', "'-1.500.000 ₫"],
    ['-1 ', "'-1 "],
    ['- 1', "'- 1"],
    ['-1e5', "'-1e5"],
    ['-1-1', "'-1-1"],
    ['-1.', "'-1."],
    ['-.5', "'-.5"],
    ['--1', "'--1"],
    ['-', "'-"],
    ['-1\t', "'-1\t"],
    ['+1.5', "'+1.5"],
    ['@SUM(1)', "'@SUM(1)"],
    ['=1+1', "'=1+1"],
    ['-1+1', "'-1+1"],
    ['-A1', "'-A1"],
    ['-١٢', "'-١٢"],
    // Already quoted formula-like text gets one more `'` (import drops one).
    ["'=x", "''=x"],
    ["'-1", "''-1"],
    ["'abc", "'abc"],
  ])('%j → %j', (input, expected) => {
    expect(csvCell(input)).toBe(expected);
  });
});

describe('unescapeCsvInjection (import, T321)', () => {
  it.each([
    ["'-1", '-1'],
    ["'=SUM(A1)", '=SUM(A1)'],
    ["'+1", '+1'],
    ["'@SUM(1)", '@SUM(1)'],
    ["'\tx", '\tx'],
    ["'\rx", '\rx'],
    ["'-2+3+cmd|' /C calc'!A0", "-2+3+cmd|' /C calc'!A0"],
    ["'-1.500.000 ₫", '-1.500.000 ₫'],
    // Only one `'`, only before `'`s and a formula character.
    ["''=x", "'=x"],
    ["'''-1", "''-1"],
    ["''abc", "''abc"],
    ["'abc", "'abc"],
    ["'", "'"],
    ["It's", "It's"],
    ['-1', '-1'],
    ['plain', 'plain'],
  ])('%j → %j', (input, expected) => {
    expect(unescapeCsvInjection(input)).toBe(expected);
  });

  it.each([
    '-1',
    '-1.500.000',
    '-1,5',
    '=HYPERLINK("x")',
    '@SUM(1)',
    '+5',
    '\tx',
    "-2+3+cmd|' /C calc'!A0",
    '-1.500.000 ₫',
    'plain',
    "'=x",
    "''=x",
    "'-1",
    "'-1.500",
    "'@a",
    "'abc",
    "'",
    "It's",
  ])('round-trips %j through csvCell', (value) => {
    const cell = csvCell(value);
    const unquoted = cell.startsWith('"') ? cell.slice(1, -1).replaceAll('""', '"') : cell;
    expect(unescapeCsvInjection(unquoted)).toBe(value);
  });
});

describe('tableExportBody', () => {
  it('writes CSV with BOM, a protected header, CRLF lines and empty missing cells', async () => {
    const text = (await buffer(tableExportBody('csv', target, fields, source()))).toString('utf8');
    expect(text.startsWith('\uFEFF')).toBe(true);
    expect(text.slice(1).split('\r\n')).toEqual([
      "Tiêu đề,'=Amount,Note",
      "Máy POS,'-1.500 ₫,",
      `"'=HYPERLINK(""x"")",,"a, ""b""\nc"`,
      "'@SUM(A1),'+5,",
      'Hoàn tiền,-2.000,',
      '',
    ]);
  });

  it('writes XLSX string cells that keep formula-like text inert and unchanged', async () => {
    const file = await buffer(tableExportBody('xlsx', target, fields, source()));
    const rows: unknown[][] = [];
    for await (const row of streamXlsxRows(new Uint8Array(file))) rows.push([...row.values]);
    const cells = rows.map((row) => fields.map((_, index) => row[index] ?? null));
    expect(cells).toEqual([
      ['Tiêu đề', '=Amount', 'Note'],
      ['Máy POS', '-1.500 ₫', null],
      ['=HYPERLINK("x")', null, 'a, "b"\nc'],
      ['@SUM(A1)', '+5', null],
      ['Hoàn tiền', '-2.000', null],
    ]);
  });

  it('stops pulling records when the body is destroyed', async () => {
    let pulled = 0;
    let closed = false;
    async function* endless(): AsyncGenerator<RecordOutput[]> {
      try {
        for (;;) {
          await Promise.resolve();
          pulled += 1;
          yield Array.from({ length: 500 }, () => record({ fld_title0000000001: 'x'.repeat(200) }));
        }
      } finally {
        closed = true;
      }
    }
    const body = tableExportBody('csv', target, fields, endless());
    // Consume a little so the records are being read, then go away.
    for (let read = 0; read < 3;) {
      await new Promise<void>((resolve) => body.once('readable', resolve));
      while (body.read() !== null) read += 1;
    }
    body.destroy();
    await new Promise((resolve) => setImmediate(resolve));
    const seen = pulled;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pulled).toBe(seen);
    expect(pulled).toBeLessThan(50);
    expect(closed).toBe(true);
  });
});

describe('names', () => {
  it('builds sheet names Excel accepts', () => {
    expect(sheetNameOf('Của tôi: [mới]')).toBe('Của tôi   mới');
    expect(sheetNameOf("'quoted'")).toBe('quoted');
    expect(sheetNameOf('   ')).toBe('Export');
    expect(sheetNameOf('x'.repeat(40))).toHaveLength(31);
  });

  it('offers an ASCII filename and the UTF-8 one', () => {
    expect(tableExportDisposition(target, 'csv')).toBe(
      `attachment; filename="Don hang - Cua toi_ _moi_.csv"; filename*=UTF-8''` +
        encodeURIComponent('Đơn hàng - Của tôi: [mới].csv'),
    );
    expect(
      tableExportDisposition(
        { table: { id: 'tbl_A1b2C3d4E5f6G7h8', name: 'a"b/c' }, view: null },
        'xlsx',
      ),
    ).toBe(`attachment; filename="a b c.xlsx"; filename*=UTF-8''a%20b%20c.xlsx`);
  });
});
