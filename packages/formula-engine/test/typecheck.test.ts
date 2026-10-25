import { describe, expect, it } from 'vitest';

import { analyze, formatType, type SchemaSnapshot } from '../src/index.js';

import { customers, fld, orders, tbl, tickets } from './typed-fixture.js';

/** `number`, `list<text>`… or `CODE @ "source text"` for the first error. */
function typeOf(source: string, snapshot: SchemaSnapshot = orders): string {
  const result = analyze(source, snapshot, { form: 'display' });
  const [error] = result.errors;
  if (error !== undefined) {
    return `${error.detail} @ ${source.slice(error.start, error.start + error.length)}`;
  }
  return result.result_type === null ? 'null' : formatType(result.result_type);
}

const rowOrders = `list<row<${tbl.orders}>>`;
const rowCustomers = `list<row<${tbl.customers}>>`;

type Case = [source: string, expected: string, snapshot?: SchemaSnapshot];

describe('SPEC §9.2 examples', () => {
  const cases: Case[] = [
    ['IF([Trạng thái] = "Hoàn thành", [Số tiền] * 0.1, 0)', 'number'],
    ['[Khách hàng].[Hạng]', 'list<text>'],
    [
      '[Đơn hàng].FILTER(CurrentValue.[Khách hàng].CONTAIN([Tên]) && CurrentValue.[Trạng thái] = "Đã giao").[Số tiền].SUM()',
      'number',
      customers,
    ],
    [
      'COUNTIF([Tickets], CurrentValue.[Người phụ trách] = [Nhân viên] && CurrentValue.[Hạn] < TODAY())',
      'number',
      customers,
    ],
    ['[Tags].FILTER(CurrentValue != "Nội bộ").ARRAYJOIN(", ")', 'text'],
    ['WORKDAY([Ngày nhận], 3)', 'date'],
  ];
  it.each(cases)('%s → %s', (source, expected, snapshot) => {
    expect(typeOf(source, snapshot)).toBe(expected);
  });
});

describe('field types (packages/field-types → formula types)', () => {
  const cases: Case[] = [
    ['[Tiêu đề]', 'text'],
    ['[Số tiền]', 'number'],
    ['[Trạng thái]', 'text'],
    ['[Tags]', 'list<text>'],
    ['[Ngày nhận]', 'date'],
    ['[Hạn chót]', 'datetime'],
    ['[Đã trả]', 'boolean'],
    ['[Tệp]', 'list<attachment>'],
    ['[Khách hàng]', rowCustomers],
    ['[Ngày tạo]', 'datetime'],
    ['[Người tạo]', 'list<user>'],
    ['[Mã]', 'text'],
    ['[VAT]', 'number'],
    ['[Không rõ]', 'any'],
    ['[Nhân viên]', 'list<user>', customers],
    ['[Các đơn]', rowOrders, customers],
  ];
  it.each(cases)('%s → %s', (source, expected, snapshot) => {
    expect(typeOf(source, snapshot)).toBe(expected);
  });
});

describe('references, links and tables', () => {
  const cases: Case[] = [
    ['[Khách hàng].[Tên]', 'list<text>'],
    ['[Khách hàng].[Các đơn]', rowOrders],
    ['[Khách hàng].[Các đơn].[Số tiền]', 'list<number>'],
    ['[Sản phẩm].[Nhà cung cấp].[Quốc gia].[Tên]', 'list<text>'],
    ['[Khách hàng].[Nhân viên]', 'NESTED_LIST @ [Khách hàng].[Nhân viên]'],
    ['[Khách hàng].[Nhân viên].LISTCOMBINE()', 'list<user>'],
    ['[Tickets].[Hạn]', 'list<date>'],
    ['[Tickets].[Khách].[Tên]', 'list<text>'],
    ['[Tickets]', 'TABLE_NEEDS_FIELD @ [Tickets]'],
    [
      '[Tickets].FILTER(CurrentValue.[Hạn] < TODAY())',
      'TABLE_NEEDS_FIELD @ [Tickets].FILTER(CurrentValue.[Hạn] < TODAY())',
    ],
    ['[Tickets].FILTER(CurrentValue.[Hạn] < TODAY()).[Hạn]', 'list<date>'],
    ['[Khách hàng].FIRST()', `row<${tbl.customers}>`],
    ['[Khách hàng].FIRST().[Tên]', 'text'],
    ['[Tickets].FIRST().[Hạn]', 'date'],
    ['[Khách hàng].FILTER(CurrentValue.[Tên] = "A").[Tên]', 'list<text>'],
    ['[Tags].FILTER(CurrentValue = "VIP")', 'list<text>'],
    ['LET(x, [Số tiền], y, x * 2, y + 1)', 'number'],
    ['LET(t, [Tickets].FILTER(CurrentValue.[Hạn] < TODAY()), t.[Hạn].FIRST())', 'date'],
    ['LET(x, [Tags], x.FIRST())', 'text'],
  ];
  it.each(cases)('%s → %s', (source, expected, snapshot) => {
    expect(typeOf(source, snapshot)).toBe(expected);
  });
});

describe('operators', () => {
  const cases: Case[] = [
    ['1 + 2 * 3', 'number'],
    ['-[Số tiền]', 'number'],
    ['-"a"', 'TYPE_MISMATCH @ "a"'],
    ['-[Tags]', 'LIST_AS_SCALAR @ [Tags]'],
    ['[Số tiền] % 3', 'number'],
    ['"a" + 1', 'TYPE_MISMATCH @ "a"'],
    ['[Ngày nhận] + 3', 'date'],
    ['3 + [Ngày nhận]', 'date'],
    ['[Hạn chót] - 1', 'datetime'],
    ['[Hạn chót] - [Ngày nhận]', 'number'],
    ['[Ngày nhận] * 2', 'TYPE_MISMATCH @ [Ngày nhận]'],
    ['"Tổng: " & [Số tiền]', 'text'],
    ['[Tiêu đề] & [Ngày nhận] & TRUE', 'text'],
    ['"a" & [Tags]', 'LIST_AS_SCALAR @ [Tags]'],
    ['[Số tiền] > 10 && [Đã trả]', 'boolean'],
    ['[Số tiền] || TRUE', 'TYPE_MISMATCH @ [Số tiền]'],
    ['[Số tiền] = "10"', 'TYPE_MISMATCH @ "10"'],
    ['[Trạng thái] = "Xong"', 'boolean'],
    ['[Trạng thái] != "Xong"', 'boolean'],
    ['[Tags] = [Tags]', 'boolean'],
    ['[Tags] = "VIP"', 'TYPE_MISMATCH @ "VIP"'],
    ['[Ngày nhận] < [Hạn chót]', 'boolean'],
    ['[Tiêu đề] < "m"', 'boolean'],
    ['[Đã trả] < TRUE', 'TYPE_MISMATCH @ TRUE'],
    ['[Tags] > 1', 'LIST_AS_SCALAR @ [Tags]'],
    ['[Khách hàng] = [Khách hàng]', 'boolean'],
    ['[Tickets] = 1', 'TABLE_NEEDS_FIELD @ [Tickets]'],
    ['[Tệp] = [Tệp]', 'TYPE_MISMATCH @ [Tệp]'],
    ['[Không rõ] + 1', 'number'],
    ['[Không rõ] = "x" && [Không rõ] > 2', 'boolean'],
  ];
  it.each(cases)('%s → %s', (source, expected, snapshot) => {
    expect(typeOf(source, snapshot)).toBe(expected);
  });
});

describe('SPEC §9.2 rules', () => {
  const cases: Case[] = [
    // A list is not one value: the error suggests SUM / ARRAYJOIN / FIRST.
    ['[Khách hàng].[Tên] & "x"', 'LIST_AS_SCALAR @ [Khách hàng].[Tên]'],
    ['ROUND([Tickets].[Hạn].DAYS(TODAY()))', 'LIST_AS_SCALAR @ [Tickets].[Hạn]'],
    ['UPPER([Tags])', 'LIST_AS_SCALAR @ [Tags]'],
    // Multi-value field over many records needs LISTCOMBINE.
    ['[Đơn hàng].[Tags].ARRAYJOIN()', 'NESTED_LIST @ [Đơn hàng].[Tags]', customers],
    ['[Đơn hàng].[Tags].LISTCOMBINE().ARRAYJOIN()', 'text', customers],
    ['[Đơn hàng].[Tags].FILTER(TRUE)', 'NESTED_LIST @ [Đơn hàng].[Tags]', customers],
    // No FILTER/MAP/COUNTIF/SUMIF in the condition of another.
    [
      '[Tickets].FILTER(CurrentValue.[Khách].FILTER(CurrentValue.[Tên] = "A").COUNTA() > 0).[Hạn]',
      'NESTED_ITERATION @ CurrentValue.[Khách].FILTER(CurrentValue.[Tên] = "A")',
    ],
    [
      '[Tickets].COUNTIF(COUNTIF([Tags], CurrentValue = "VIP") > 0)',
      'NESTED_ITERATION @ COUNTIF([Tags], CurrentValue = "VIP")',
    ],
    [
      'LIST(1, 2).MAP(LIST(3).SUMIF(CurrentValue > 1))',
      'NESTED_ITERATION @ LIST(3).SUMIF(CurrentValue > 1)',
    ],
    // Chaining is fine.
    [
      '[Tickets].FILTER(CurrentValue.[Hạn] < TODAY()).FILTER(CurrentValue.[Hạn] > DATE(2020, 1, 1)).[Hạn].COUNTA()',
      'number',
    ],
    // CurrentValue only inside an iteration.
    ['CurrentValue', 'CURRENT_VALUE_OUTSIDE_ITERATION @ CurrentValue'],
    [
      '[Tags].FILTER(TRUE).ARRAYJOIN(CurrentValue)',
      'CURRENT_VALUE_OUTSIDE_ITERATION @ CurrentValue',
    ],
    // CurrentValue is a value over a list, a record over a table.
    ['[Tags].MAP(UPPER(CurrentValue))', 'list<text>'],
    ['LIST(1, 2).MAP(CurrentValue * 2)', 'list<number>'],
    ['[Tickets].MAP(CurrentValue.[Hạn])', 'list<date>'],
    ['[Tickets].MAP(CurrentValue)', `list<row<${tbl.tickets}>>`],
    ['[Khách hàng].MAP(CurrentValue.[Tên])', 'list<text>'],
    ['[Tickets].FILTER(CurrentValue)', 'TABLE_NEEDS_FIELD @ CurrentValue'],
  ];
  it.each(cases)('%s → %s', (source, expected, snapshot) => {
    expect(typeOf(source, snapshot)).toBe(expected);
  });
});

describe('error positions and params', () => {
  it('points at the argument and names the suggestions', () => {
    const source = 'ROUND([Tags], 2)';
    const [error] = analyze(source, orders, { form: 'display' }).errors;
    expect(error?.code).toBe('FORMULA_TYPE_ERROR');
    expect(error?.toProblemError()).toEqual({
      path: 'formula',
      code: 'LIST_AS_SCALAR',
      message: expect.any(String) as string,
      params: {
        expected: 'number',
        actual: 'list<text>',
        suggestions: ['SUM', 'ARRAYJOIN', 'FIRST'],
        position: { start: 6, length: 6 },
      },
    });
  });

  it('reports every independent error', () => {
    const result = analyze('UPPER(1 + "a") & ROUND("x")', orders, { form: 'display' });
    expect(result.errors.map((error) => error.detail)).toEqual(['TYPE_MISMATCH', 'TYPE_MISMATCH']);
    expect(result.result_type).toBeNull();
  });

  it('keeps syntax and reference errors from the parser and resolver', () => {
    expect(typeOf('SUM(')).toBe('UNEXPECTED_END @ ');
    expect(typeOf('[Nope] + 1')).toBe('UNKNOWN_FIELD @ [Nope]');
    expect(analyze('SUM(', orders, { form: 'display' }).errors[0]?.code).toBe(
      'FORMULA_SYNTAX_ERROR',
    );
  });

  it('counts wrong argument counts on the call', () => {
    const [error] = analyze('ROUND()', orders, { form: 'display' }).errors;
    expect(error?.detail).toBe('WRONG_ARGUMENT_COUNT');
    expect(error?.params).toMatchObject({ function: 'ROUND', min: 1, max: 2, actual: 0 });
  });

  it('types the stored form the same as the display form', () => {
    const display = analyze('[Khách hàng].[Tên].ARRAYJOIN()', orders, { form: 'display' });
    expect(display.errors).toEqual([]);
    const stored = analyze(`[${fld.customer}]`, orders);
    expect(stored.errors).toEqual([]);
    expect(stored.result_type).toEqual({
      kind: 'list',
      element: { kind: 'row', tableId: tbl.customers },
    });
  });

  it('types every node', () => {
    const result = analyze('[Số tiền] + 1', orders, { form: 'display' });
    const kinds = [...result.types.values()].map(formatType);
    expect(kinds).toEqual(['number', 'number', 'number']);
  });
});

describe('tickets snapshot', () => {
  it('link from another table', () => {
    expect(typeOf('[Khách].[Nhân viên].LISTCOMBINE().COUNTA()', tickets)).toBe('number');
  });
});
