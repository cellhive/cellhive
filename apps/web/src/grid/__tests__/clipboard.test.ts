import { describe, expect, it } from 'vitest';

import {
  cellClipboardText,
  parseTsv,
  pastedDisplay,
  serializeTsv,
  toHtmlTable,
} from '../clipboard';
import { toGridField } from '../types';

import type { FieldDto } from '@cellhive/contracts';

const NOW = '2026-09-24T00:00:00.000Z';
const VI = { locale: 'vi-VN', timeZone: 'Asia/Ho_Chi_Minh' };
const EN = { locale: 'en-US', timeZone: 'UTC' };

function field(type: string, options: Record<string, unknown> = {}): FieldDto {
  return {
    id: `fld_${type.padEnd(16, '0').slice(0, 16)}`,
    table_id: 'tbl_Tickets000000001',
    name: type,
    type,
    options,
    is_primary: false,
    required: false,
    unique_values: false,
    description: null,
    position: 0,
    created_at: NOW,
    updated_at: NOW,
  } as FieldDto;
}

describe('parseTsv (FRONTEND §6.3)', () => {
  it.each([
    ['one cell', 'abc', [['abc']]],
    ['empty clipboard', '', [['']]],
    [
      'Excel: CRLF rows and a trailing CRLF',
      'a\tb\r\nc\td\r\n',
      [
        ['a', 'b'],
        ['c', 'd'],
      ],
    ],
    [
      'Google Sheets: LF rows, no trailing break',
      'a\tb\nc\td',
      [
        ['a', 'b'],
        ['c', 'd'],
      ],
    ],
    ['old Mac: CR rows', 'a\rb\r', [['a'], ['b']]],
    [
      'empty cells keep their place',
      '\tb\t\n\t\t',
      [
        ['', 'b', ''],
        ['', '', ''],
      ],
    ],
    ['a column of numbers', '1\n2\n3\n', [['1'], ['2'], ['3']]],
    [
      'Excel: quoted cell with a line break (CRLF inside becomes LF)',
      '"line 1\r\nline 2"\tx\r\n',
      [['line 1\nline 2', 'x']],
    ],
    [
      'Google Sheets: quoted cell with a line break and doubled quotes',
      '"He said ""hi""\nthen left"\tok',
      [['He said "hi"\nthen left', 'ok']],
    ],
    ['a tab inside quotes stays in the cell', '"a\tb"\tc', [['a\tb', 'c']]],
    [
      'a quoted cell at the end of a row',
      'x\t"multi\nline"\ny\tz',
      [
        ['x', 'multi\nline'],
        ['y', 'z'],
      ],
    ],
    ['quotes inside plain text are literal', '5" screen\t2"', [['5" screen', '2"']]],
    [
      'a quote that does not close before a tab is plain text',
      '"abc\tdef\n"x"y\tz',
      [
        ['"abc', 'def'],
        ['"x"y', 'z'],
      ],
    ],
    ['an empty quoted cell', '""\ta', [['', 'a']]],
    [
      'ragged rows are padded',
      'a\tb\tc\nd',
      [
        ['a', 'b', 'c'],
        ['d', '', ''],
      ],
    ],
    ['Vietnamese text', 'Máy POS lỗi in\t1.500.000 ₫', [['Máy POS lỗi in', '1.500.000 ₫']]],
  ])('%s', (_name, input, expected) => {
    expect(parseTsv(input)).toEqual(expected);
  });
});

describe('serializeTsv', () => {
  it('quotes only cells with tabs, line breaks or a leading quote', () => {
    expect(
      serializeTsv([
        ['plain', 'with\ttab', 'two\nlines'],
        ['"quoted"', '5" screen', ''],
      ]),
    ).toBe('plain\t"with\ttab"\t"two\nlines"\n"""quoted"""\t5" screen\t');
  });

  it.each([
    [
      [
        ['a', 'b'],
        ['c', 'd'],
      ],
    ],
    [[['multi\nline', 'tab\there', '"lead', 'end"', '']]],
    [
      [
        ['', ''],
        ['', 'x'],
      ],
    ],
    [[['Ghi chú: "quan trọng"\nvà dòng hai']]],
  ])('round-trips through parseTsv: %j', (rows) => {
    expect(parseTsv(serializeTsv(rows))).toEqual(rows);
  });
});

describe('toHtmlTable', () => {
  it('escapes cells and keeps line breaks', () => {
    expect(toHtmlTable([['<b>a</b> & "b"', "it's\nnew"]])).toBe(
      '<meta charset="utf-8"><table><tbody><tr><td>&lt;b&gt;a&lt;/b&gt; &amp; &quot;b&quot;</td>' +
        '<td>it&#39;s<br>new</td></tr></tbody></table>',
    );
  });
});

describe('cellClipboardText (cell_format=text)', () => {
  it.each([
    ['text', {}, 'Máy in', 'Máy in'],
    [
      'number currency',
      { style: { type: 'currency', currency_code: 'VND' } },
      1_500_000,
      '1.500.000 ₫',
    ],
    ['checkbox on', {}, true, '✓'],
    ['checkbox off', {}, false, ''],
    ['empty', {}, null, ''],
  ])('%s', (name, options, value, expected) => {
    const type = name.split(' ')[0] ?? 'text';
    expect(cellClipboardText(toGridField(field(type, options)), value, VI)).toBe(expected);
  });

  it('formats select and user values', () => {
    const select = toGridField(
      field('select', {
        multiple: true,
        options: [
          { id: 'opt_A000000000000001', name: 'A', color: 'blue' },
          { id: 'opt_B000000000000001', name: 'B', color: 'red' },
        ],
      }),
    );
    expect(cellClipboardText(select, ['A', 'B'], EN)).toBe('A, B');
    const user = toGridField(field('user', { multiple: true }));
    expect(
      cellClipboardText(
        user,
        [{ id: 'usr_0123456789ABCDEF', name: 'Nguyễn A', email: 'a@x.vn' }],
        EN,
      ),
    ).toBe('Nguyễn A');
  });

  it('falls back to titles for types without a formatter (link)', () => {
    const link = toGridField(field('link'));
    expect(
      cellClipboardText(
        link,
        [
          { id: 'rec_1', title: 'An Phát' },
          { id: 'rec_2', title: 'B' },
        ],
        EN,
      ),
    ).toBe('An Phát, B');
  });
});

describe('pastedDisplay', () => {
  it('reads text like typecast in the user locale, else leaves the cell', () => {
    expect(pastedDisplay(toGridField(field('number')), '1.500', VI)).toBe(1500);
    expect(pastedDisplay(toGridField(field('number')), 'abc', VI)).toBeUndefined();
    expect(pastedDisplay(toGridField(field('checkbox')), 'x', VI)).toBe(true);
    expect(pastedDisplay(toGridField(field('checkbox')), '', VI)).toBe(false);
    expect(pastedDisplay(toGridField(field('text')), '  ', VI)).toBeNull();
  });
});
