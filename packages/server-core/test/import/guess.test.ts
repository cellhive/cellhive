import { describe, expect, it } from 'vitest';

import { columnNames, guessColumnType } from '../../src/import/index.js';

import type { ImportCell } from '@cellhive/contracts';

describe('guessColumnType (SPEC §17, base locale)', () => {
  it.each([
    ['vi grouped number', ['1.500.000', '2.000.000', '350.000'], 'vi', 'number'],
    ['vi decimal comma', ['1,5', '2,25'], 'vi', 'number'],
    ['en-US grouped number', ['1,500,000', '2,000'], 'en-US', 'number'],
    ['XLSX numbers', [1500000, 2.5], 'vi', 'number'],
    ['percent', ['20%', '35%'], 'vi', 'number'],
    ['leading zeros stay text (phone numbers)', ['0901234567', '0912345678'], 'vi', 'text'],
    ['dd/MM/yyyy date in vi', ['25/09/2026', '01/10/2026'], 'vi', 'datetime'],
    ['MM/dd/yyyy date in en-US', ['09/25/2026', '10/01/2026'], 'en-US', 'datetime'],
    ['ISO dates (XLSX date cells)', ['2026-09-25', '2026-10-01'], 'vi', 'datetime'],
    ['date with time', ['25/09/2026 08:30', '26/09/2026 17:00'], 'vi', 'datetime'],
    ['checkbox x/empty', ['x', null, 'x', ''], 'vi', 'checkbox'],
    ['checkbox có/không', ['có', 'không', 'Có'], 'vi', 'checkbox'],
    ['checkbox TRUE/FALSE', ['TRUE', 'FALSE'], 'en-US', 'checkbox'],
    ['XLSX booleans', [true, false], 'vi', 'checkbox'],
    ['only 0/1 is a number', ['0', '1', '1'], 'vi', 'number'],
    [
      'select: few repeated values',
      ['Mới', 'Đang xử lý', 'Mới', 'Xong', 'Xong', 'Mới'],
      'vi',
      'select',
    ],
    ['all distinct: text', ['Nguyễn Văn A', 'Trần B', 'Lê C'], 'vi', 'text'],
    ['mixed number and text', ['1.500', 'abc'], 'vi', 'text'],
    ['empty column', [null, '', '  '], 'vi', 'text'],
  ] as const)('%s', (_name, cells, locale, type) => {
    expect(guessColumnType(cells as readonly ImportCell[], locale).type).toBe(type);
  });

  it('gives field options that fit the values', () => {
    expect(guessColumnType(['1.500.000', '2.000.000'], 'vi').options).toEqual({
      style: { type: 'plain', precision: 0, percentage: false, thousands_separator: true },
    });
    expect(guessColumnType(['1,25', '2,5'], 'vi').options).toMatchObject({
      style: { precision: 2 },
    });
    expect(guessColumnType(['25/09/2026'], 'vi').options).toEqual({
      style: { format: 'dd/MM/yyyy' },
    });
    expect(guessColumnType(['2026-09-25 08:30'], 'vi').options).toEqual({
      style: { format: 'yyyy-MM-dd HH:mm' },
    });
    expect(guessColumnType(['09/25/2026'], 'en-US').options).toEqual({
      style: { format: 'MM/dd/yyyy' },
    });
    const select = guessColumnType(['Mới', 'Xong', 'Mới', 'Xong'], 'vi');
    expect(select.options).toEqual({
      options: [
        { id: expect.stringMatching(/^opt_/) as unknown, name: 'Mới' },
        { id: expect.stringMatching(/^opt_/) as unknown, name: 'Xong' },
      ],
    });
    expect(guessColumnType(['a@x.vn', 'b@y.com'], 'vi')).toEqual({
      type: 'text',
      options: { style: { type: 'email' } },
    });
  });
});

describe('columnNames', () => {
  it('trims, fills and de-duplicates header cells ignoring case', () => {
    expect(columnNames([' Tên ', null, 'tên', 'TÊN', 42], 6)).toEqual([
      'Tên',
      'Column 2',
      'tên (2)',
      'TÊN (3)',
      '42',
      'Column 6',
    ]);
  });
});
