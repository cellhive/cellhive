import { describe, expect, it } from 'vitest';

import {
  analyze,
  formatType,
  MVP_FUNCTION_NAMES,
  S4B_FUNCTION_NAMES,
  type SchemaSnapshot,
} from '../src/index.js';

import { customers, orders, tbl } from './typed-fixture.js';

function typeOf(source: string, snapshot: SchemaSnapshot = orders): string {
  const result = analyze(source, snapshot, { form: 'display' });
  const [error] = result.errors;
  if (error !== undefined) {
    return `${error.detail} @ ${source.slice(error.start, error.start + error.length)}`;
  }
  return result.result_type === null ? 'null' : formatType(result.result_type);
}

/**
 * Every function with argument types it accepts and one it rejects (the
 * error code and the text it points at). Fields of `Đơn hàng`:
 * [Số tiền] number, [Tiêu đề] text, [Trạng thái] select, [Tags] multi select,
 * [Ngày nhận] date, [Hạn chót] datetime, [Đã trả] checkbox, [Tệp] attachments,
 * [Khách hàng] link → Khách hàng, [Người tạo] user.
 */
const CASES: Record<string, { ok: [string, string][]; bad: [string, string][] }> = {
  IF: {
    ok: [
      ['IF([Đã trả], [Số tiền], 0)', 'number'],
      ['IF([Đã trả], "a")', 'text'],
      ['IF([Đã trả], [Tags], LIST())', 'list<text>'],
      ['IF([Đã trả], [Ngày nhận], [Hạn chót])', 'datetime'],
    ],
    bad: [
      ['IF([Số tiền], 1, 2)', 'TYPE_MISMATCH @ [Số tiền]'],
      ['IF([Đã trả], 1, "a")', 'TYPE_MISMATCH @ "a"'],
      ['IF([Tags], 1, 2)', 'LIST_AS_SCALAR @ [Tags]'],
      ['IF([Đã trả])', 'WRONG_ARGUMENT_COUNT @ IF([Đã trả])'],
    ],
  },
  IFS: {
    ok: [['IFS([Số tiền] > 10, "big", TRUE, "small")', 'text']],
    bad: [
      [
        'IFS([Số tiền] > 10, "big", TRUE)',
        'WRONG_ARGUMENT_COUNT @ IFS([Số tiền] > 10, "big", TRUE)',
      ],
      ['IFS([Số tiền] > 10, "big", TRUE, 1)', 'TYPE_MISMATCH @ 1'],
    ],
  },
  SWITCH: {
    ok: [
      ['SWITCH([Trạng thái], "Mới", 1, "Xong", 2)', 'number'],
      ['SWITCH([Trạng thái], "Mới", 1, 0)', 'number'],
    ],
    bad: [
      ['SWITCH([Trạng thái], 1, "a")', 'TYPE_MISMATCH @ 1'],
      ['SWITCH([Trạng thái], "Mới", 1, "x")', 'TYPE_MISMATCH @ "x"'],
      ['SWITCH([Trạng thái], "Mới")', 'WRONG_ARGUMENT_COUNT @ SWITCH([Trạng thái], "Mới")'],
    ],
  },
  IFERROR: {
    ok: [['IFERROR([Số tiền] / 0, 0)', 'number']],
    bad: [['IFERROR([Số tiền] / 0, "x")', 'TYPE_MISMATCH @ "x"']],
  },
  IFBLANK: {
    ok: [['IFBLANK([Tiêu đề], "-")', 'text']],
    bad: [['IFBLANK([Tiêu đề], 0)', 'TYPE_MISMATCH @ 0']],
  },
  AND: {
    ok: [['AND([Đã trả], [Số tiền] > 1, TRUE)', 'boolean']],
    bad: [
      ['AND([Đã trả], [Số tiền])', 'TYPE_MISMATCH @ [Số tiền]'],
      ['AND()', 'WRONG_ARGUMENT_COUNT @ AND()'],
    ],
  },
  OR: { ok: [['OR([Đã trả], FALSE)', 'boolean']], bad: [['OR("a")', 'TYPE_MISMATCH @ "a"']] },
  NOT: { ok: [['NOT([Đã trả])', 'boolean']], bad: [['NOT(1)', 'TYPE_MISMATCH @ 1']] },
  ISBLANK: {
    ok: [
      ['ISBLANK([Tags])', 'boolean'],
      ['ISBLANK([Tiêu đề])', 'boolean'],
    ],
    bad: [['ISBLANK([Tickets])', 'TABLE_NEEDS_FIELD @ [Tickets]']],
  },
  ISNULL: {
    ok: [['ISNULL([Khách hàng])', 'boolean']],
    bad: [['ISNULL()', 'WRONG_ARGUMENT_COUNT @ ISNULL()']],
  },
  ISERROR: {
    ok: [['ISERROR(1 / [Số tiền])', 'boolean']],
    bad: [['ISERROR(1, 2)', 'WRONG_ARGUMENT_COUNT @ ISERROR(1, 2)']],
  },
  ISNUMBER: {
    ok: [['ISNUMBER([Tiêu đề])', 'boolean']],
    bad: [['ISNUMBER([Tickets])', 'TABLE_NEEDS_FIELD @ [Tickets]']],
  },
  CONTAIN: {
    ok: [
      ['CONTAIN([Tags], "VIP", "Nội bộ")', 'boolean'],
      ['[Tags].CONTAIN(LIST("VIP"))', 'boolean'],
      ['CONTAIN([Trạng thái], "Mới")', 'boolean'],
      ['CONTAIN([Khách hàng], "An")', 'boolean'],
      ['CONTAIN([Khách hàng], RECORD_ID())', 'boolean'],
      ['CONTAIN([Người tạo], "usr_1")', 'boolean'],
    ],
    bad: [
      ['CONTAIN([Tags], 1)', 'TYPE_MISMATCH @ 1'],
      ['CONTAIN([Tags])', 'WRONG_ARGUMENT_COUNT @ CONTAIN([Tags])'],
      ['CONTAIN([Đơn hàng].[Tags], "VIP")', 'NESTED_LIST @ [Đơn hàng].[Tags]'],
    ],
  },
  CONTAINSALL: {
    ok: [['CONTAINSALL([Tags], "VIP", "Nội bộ")', 'boolean']],
    bad: [['CONTAINSALL([Tags], [Ngày nhận])', 'TYPE_MISMATCH @ [Ngày nhận]']],
  },
  CONTAINSONLY: {
    ok: [['CONTAINSONLY([Tags], "VIP")', 'boolean']],
    bad: [['CONTAINSONLY([Tickets], "VIP")', 'TABLE_NEEDS_FIELD @ [Tickets]']],
  },
  TRUE: { ok: [['TRUE()', 'boolean']], bad: [['TRUE(1)', 'WRONG_ARGUMENT_COUNT @ TRUE(1)']] },
  FALSE: { ok: [['FALSE()', 'boolean']], bad: [['FALSE(1)', 'WRONG_ARGUMENT_COUNT @ FALSE(1)']] },
  RECORD_ID: {
    ok: [['RECORD_ID() & "-x"', 'text']],
    bad: [['RECORD_ID(1)', 'WRONG_ARGUMENT_COUNT @ RECORD_ID(1)']],
  },
  SUM: {
    ok: [
      ['SUM(1, [Số tiền], LIST(2, 3))', 'number'],
      ['[Khách hàng].[Các đơn].[Số tiền].SUM()', 'number'],
    ],
    bad: [
      ['SUM([Tags])', 'TYPE_MISMATCH @ [Tags]'],
      ['SUM("1")', 'TYPE_MISMATCH @ "1"'],
      ['SUM([Tickets])', 'TABLE_NEEDS_FIELD @ [Tickets]'],
      ['SUM([Đơn hàng].[Tags])', 'NESTED_LIST @ [Đơn hàng].[Tags]'],
    ],
  },
  AVERAGE: {
    ok: [['AVERAGE([Số tiền], 2)', 'number']],
    bad: [['AVERAGE([Tiêu đề])', 'TYPE_MISMATCH @ [Tiêu đề]']],
  },
  MAX: {
    ok: [
      ['MAX(1, [Số tiền])', 'number'],
      ['MAX([Ngày nhận], [Hạn chót])', 'datetime'],
      ['[Tickets].[Hạn].MAX()', 'date'],
    ],
    bad: [
      ['MAX(1, [Ngày nhận])', 'TYPE_MISMATCH @ [Ngày nhận]'],
      ['MAX([Tiêu đề])', 'TYPE_MISMATCH @ [Tiêu đề]'],
    ],
  },
  MIN: { ok: [['MIN(LIST(3, 1))', 'number']], bad: [['MIN([Tags])', 'TYPE_MISMATCH @ [Tags]']] },
  MEDIAN: {
    ok: [['MEDIAN(1, 2, 3)', 'number']],
    bad: [['MEDIAN([Đã trả])', 'TYPE_MISMATCH @ [Đã trả]']],
  },
  COUNTA: {
    ok: [
      ['COUNTA([Tệp])', 'number'],
      ['COUNTA([Tags], [Tiêu đề])', 'number'],
      ['COUNTA([Đơn hàng].[Tags])', 'number'],
    ],
    bad: [['COUNTA([Tickets])', 'TABLE_NEEDS_FIELD @ [Tickets]']],
  },
  COUNTIF: {
    ok: [
      ['[Tickets].COUNTIF(CurrentValue.[Hạn] < TODAY())', 'number'],
      ['[Tags].COUNTIF(CurrentValue = "VIP")', 'number'],
    ],
    bad: [
      ['[Tickets].COUNTIF(CurrentValue.[Hạn])', 'TYPE_MISMATCH @ CurrentValue.[Hạn]'],
      ['COUNTIF([Số tiền], TRUE)', 'EXPECTED_LIST @ [Số tiền]'],
    ],
  },
  SUMIF: {
    ok: [
      ['LIST(1, 5).SUMIF(CurrentValue > 3)', 'number'],
      ['[Đơn hàng].SUMIF(CurrentValue.[Đã trả], CurrentValue.[Số tiền])', 'number'],
    ],
    bad: [
      ['[Tags].SUMIF(TRUE)', 'TYPE_MISMATCH @ [Tags]'],
      ['[Đơn hàng].SUMIF(TRUE, CurrentValue.[Tiêu đề])', 'TYPE_MISMATCH @ CurrentValue.[Tiêu đề]'],
    ],
  },
  ROUND: {
    ok: [
      ['ROUND([Số tiền], 2)', 'number'],
      ['ROUND([Số tiền])', 'number'],
    ],
    bad: [['ROUND([Số tiền], "2")', 'TYPE_MISMATCH @ "2"']],
  },
  ROUNDUP: {
    ok: [['ROUNDUP(1.25, 1)', 'number']],
    bad: [['ROUNDUP([Tags], 1)', 'LIST_AS_SCALAR @ [Tags]']],
  },
  ROUNDDOWN: {
    ok: [['ROUNDDOWN(1.25, 1)', 'number']],
    bad: [['ROUNDDOWN(1, 2, 3)', 'WRONG_ARGUMENT_COUNT @ ROUNDDOWN(1, 2, 3)']],
  },
  FLOOR: {
    ok: [['FLOOR(3.14, 0.1)', 'number']],
    bad: [['FLOOR([Tiêu đề])', 'TYPE_MISMATCH @ [Tiêu đề]']],
  },
  CEILING: { ok: [['CEILING(3.14)', 'number']], bad: [['CEILING(TRUE)', 'TYPE_MISMATCH @ TRUE']] },
  ABS: {
    ok: [['ABS(-[Số tiền])', 'number']],
    bad: [['ABS([Ngày nhận])', 'TYPE_MISMATCH @ [Ngày nhận]']],
  },
  INT: { ok: [['INT(8.9)', 'number']], bad: [['INT("8")', 'TYPE_MISMATCH @ "8"']] },
  MOD: { ok: [['MOD(3, 2)', 'number']], bad: [['MOD(3)', 'WRONG_ARGUMENT_COUNT @ MOD(3)']] },
  POWER: { ok: [['POWER(5, 2)', 'number']], bad: [['POWER(5, "2")', 'TYPE_MISMATCH @ "2"']] },
  QUOTIENT: {
    ok: [['QUOTIENT(5, 2)', 'number']],
    bad: [['QUOTIENT([Tags], 2)', 'LIST_AS_SCALAR @ [Tags]']],
  },
  VALUE: {
    ok: [
      ['VALUE("50")', 'number'],
      ['VALUE([Tiêu đề])', 'number'],
    ],
    bad: [['VALUE([Tags])', 'LIST_AS_SCALAR @ [Tags]']],
  },
  RANK: {
    ok: [['RANK(3, LIST(4, 3, 2), TRUE)', 'number']],
    bad: [
      ['RANK(3, 4)', 'EXPECTED_LIST @ 4'],
      ['RANK(3, [Tags])', 'TYPE_MISMATCH @ [Tags]'],
    ],
  },
  CONCATENATE: {
    ok: [['CONCATENATE([Tiêu đề], " ", [Số tiền], [Ngày nhận])', 'text']],
    bad: [['CONCATENATE([Tags])', 'LIST_AS_SCALAR @ [Tags]']],
  },
  LEN: {
    ok: [['LEN([Tiêu đề])', 'number']],
    bad: [['LEN([Tickets])', 'TABLE_NEEDS_FIELD @ [Tickets]']],
  },
  LEFT: {
    ok: [['LEFT([Tiêu đề], 2)', 'text']],
    bad: [['LEFT([Tiêu đề], "2")', 'TYPE_MISMATCH @ "2"']],
  },
  RIGHT: {
    ok: [['RIGHT([Tiêu đề])', 'text']],
    bad: [['RIGHT()', 'WRONG_ARGUMENT_COUNT @ RIGHT()']],
  },
  MID: {
    ok: [['MID([Tiêu đề], 1, 2)', 'text']],
    bad: [['MID([Tiêu đề], 1)', 'WRONG_ARGUMENT_COUNT @ MID([Tiêu đề], 1)']],
  },
  FIND: {
    ok: [['FIND("a", [Tiêu đề], 2)', 'number']],
    bad: [['FIND("a", [Tags])', 'LIST_AS_SCALAR @ [Tags]']],
  },
  REPLACE: {
    ok: [['REPLACE([Tiêu đề], 1, 2, "x")', 'text']],
    bad: [['REPLACE([Tiêu đề], "1", 2, "x")', 'TYPE_MISMATCH @ "1"']],
  },
  SUBSTITUTE: {
    ok: [['SUBSTITUTE([Tiêu đề], "a", "b", 1)', 'text']],
    bad: [['SUBSTITUTE([Tiêu đề], "a")', 'WRONG_ARGUMENT_COUNT @ SUBSTITUTE([Tiêu đề], "a")']],
  },
  UPPER: {
    ok: [['UPPER([Trạng thái])', 'text']],
    bad: [['UPPER([Tags])', 'LIST_AS_SCALAR @ [Tags]']],
  },
  LOWER: {
    ok: [['LOWER("A")', 'text']],
    bad: [['LOWER([Tickets])', 'TABLE_NEEDS_FIELD @ [Tickets]']],
  },
  TRIM: {
    ok: [['TRIM(" a ")', 'text']],
    bad: [['TRIM("a", "b")', 'WRONG_ARGUMENT_COUNT @ TRIM("a", "b")']],
  },
  TEXT: {
    ok: [
      ['TEXT([Ngày nhận], "YYYY/MM/DD")', 'text'],
      ['TEXT([Số tiền], "0.00")', 'text'],
    ],
    bad: [['TEXT([Tags], "x")', 'LIST_AS_SCALAR @ [Tags]']],
  },
  CONTAINTEXT: {
    ok: [['CONTAINTEXT([Tiêu đề], "a")', 'boolean']],
    bad: [['CONTAINTEXT([Tags], "a")', 'LIST_AS_SCALAR @ [Tags]']],
  },
  SPLIT: {
    ok: [['SPLIT([Tiêu đề], ",")', 'list<text>']],
    bad: [['SPLIT([Tiêu đề])', 'WRONG_ARGUMENT_COUNT @ SPLIT([Tiêu đề])']],
  },
  TODATE: {
    ok: [['TODATE("2023-06-05")', 'datetime']],
    bad: [['TODATE([Tags])', 'LIST_AS_SCALAR @ [Tags]']],
  },
  FORMAT: {
    ok: [
      ['FORMAT("{1} - {2}", [Tiêu đề], [Số tiền])', 'text'],
      ['FORMAT("x")', 'text'],
    ],
    bad: [['FORMAT("{1}", [Tags])', 'LIST_AS_SCALAR @ [Tags]']],
  },
  HYPERLINK: {
    ok: [['HYPERLINK("https://a.b", [Tiêu đề])', 'text']],
    bad: [['HYPERLINK()', 'WRONG_ARGUMENT_COUNT @ HYPERLINK()']],
  },
  ENCODEURL: {
    ok: [['ENCODEURL([Tiêu đề])', 'text']],
    bad: [['ENCODEURL([Tags])', 'LIST_AS_SCALAR @ [Tags]']],
  },
  REGEXMATCH: {
    ok: [['REGEXMATCH([Tiêu đề], "[0-9]+")', 'boolean']],
    bad: [['REGEXMATCH([Tiêu đề])', 'WRONG_ARGUMENT_COUNT @ REGEXMATCH([Tiêu đề])']],
  },
  REGEXEXTRACT: {
    ok: [['REGEXEXTRACT([Tiêu đề], "[0-9]+")', 'text']],
    bad: [['REGEXEXTRACT([Tags], "a")', 'LIST_AS_SCALAR @ [Tags]']],
  },
  REGEXREPLACE: {
    ok: [['REGEXREPLACE([Tiêu đề], "[0-9]", "#")', 'text']],
    bad: [['REGEXREPLACE([Tiêu đề], "a")', 'WRONG_ARGUMENT_COUNT @ REGEXREPLACE([Tiêu đề], "a")']],
  },
  UNACCENT: {
    ok: [['UNACCENT([Tiêu đề])', 'text']],
    bad: [['UNACCENT([Tags])', 'LIST_AS_SCALAR @ [Tags]']],
  },
  NOW: { ok: [['NOW()', 'datetime']], bad: [['NOW(1)', 'WRONG_ARGUMENT_COUNT @ NOW(1)']] },
  TODAY: { ok: [['TODAY()', 'date']], bad: [['TODAY() * 2', 'TYPE_MISMATCH @ TODAY()']] },
  DATE: {
    ok: [['DATE(2024, 1, 31)', 'date']],
    bad: [['DATE(2024, "1", 31)', 'TYPE_MISMATCH @ "1"']],
  },
  YEAR: {
    ok: [['YEAR([Ngày nhận])', 'number']],
    bad: [['YEAR([Số tiền])', 'TYPE_MISMATCH @ [Số tiền]']],
  },
  MONTH: {
    ok: [
      ['MONTH([Hạn chót])', 'number'],
      ['MONTH("2024-01-01")', 'number'],
    ],
    bad: [['MONTH([Số tiền])', 'TYPE_MISMATCH @ [Số tiền]']],
  },
  DAY: {
    ok: [['DAY(TODAY())', 'number']],
    bad: [['DAY([Tickets].[Hạn])', 'LIST_AS_SCALAR @ [Tickets].[Hạn]']],
  },
  HOUR: { ok: [['HOUR(NOW())', 'number']], bad: [['HOUR(1)', 'TYPE_MISMATCH @ 1']] },
  MINUTE: {
    ok: [['MINUTE([Hạn chót])', 'number']],
    bad: [['MINUTE()', 'WRONG_ARGUMENT_COUNT @ MINUTE()']],
  },
  SECOND: {
    ok: [
      ['SECOND([Hạn chót])', 'number'],
      ['SECOND([Tiêu đề])', 'number'],
    ],
    bad: [['SECOND([Số tiền])', 'TYPE_MISMATCH @ [Số tiền]']],
  },
  WEEKDAY: {
    ok: [['WEEKDAY([Ngày nhận], 2)', 'number']],
    bad: [['WEEKDAY([Ngày nhận], "2")', 'TYPE_MISMATCH @ "2"']],
  },
  WEEKNUM: {
    ok: [['WEEKNUM([Ngày nhận])', 'number']],
    bad: [['WEEKNUM(TRUE)', 'TYPE_MISMATCH @ TRUE']],
  },
  DAYS: {
    ok: [['DAYS([Hạn chót], [Ngày nhận])', 'number']],
    bad: [['DAYS([Hạn chót], 1)', 'TYPE_MISMATCH @ 1']],
  },
  DATEDIF: {
    ok: [['DATEDIF([Ngày nhận], TODAY(), "M")', 'number']],
    bad: [
      ['DATEDIF([Ngày nhận], TODAY(), "W")', 'INVALID_ARGUMENT @ "W"'],
      ['DATEDIF([Ngày nhận], 1, "D")', 'TYPE_MISMATCH @ 1'],
    ],
  },
  DURATION: {
    ok: [
      ['DURATION(1, 12)', 'number'],
      ['[Hạn chót] + DURATION(0, 12)', 'datetime'],
    ],
    bad: [['DURATION("1")', 'TYPE_MISMATCH @ "1"']],
  },
  EDATE: {
    ok: [
      ['EDATE([Ngày nhận], 1)', 'date'],
      ['EDATE([Hạn chót], -1)', 'datetime'],
    ],
    bad: [['EDATE([Ngày nhận], [Ngày nhận])', 'TYPE_MISMATCH @ [Ngày nhận]']],
  },
  EOMONTH: {
    ok: [['EOMONTH([Hạn chót], 0)', 'date']],
    bad: [['EOMONTH(1, 0)', 'TYPE_MISMATCH @ 1']],
  },
  WORKDAY: {
    ok: [
      ['WORKDAY([Ngày nhận], 3, LIST(DATE(2026, 9, 2)))', 'date'],
      ['WORKDAY([Ngày nhận], 3, [Tickets].[Hạn])', 'date'],
    ],
    bad: [['WORKDAY([Ngày nhận], 3, LIST(1))', 'TYPE_MISMATCH @ LIST(1)']],
  },
  NETWORKDAYS: {
    ok: [['NETWORKDAYS([Ngày nhận], [Hạn chót])', 'number']],
    bad: [['NETWORKDAYS([Ngày nhận])', 'WRONG_ARGUMENT_COUNT @ NETWORKDAYS([Ngày nhận])']],
  },
  LIST: {
    ok: [
      ['LIST(1, 2, [Số tiền])', 'list<number>'],
      ['LIST()', 'list<null>'],
      ['LIST([Ngày nhận], [Hạn chót])', 'list<datetime>'],
    ],
    bad: [
      ['LIST(1, "a")', 'MIXED_LIST @ "a"'],
      ['LIST([Tags])', 'LIST_AS_SCALAR @ [Tags]'],
    ],
  },
  FIRST: {
    ok: [
      ['FIRST([Tags])', 'text'],
      ['[Khách hàng].FIRST()', `row<${tbl.customers}>`],
    ],
    bad: [['FIRST([Số tiền])', 'EXPECTED_LIST @ [Số tiền]']],
  },
  LAST: {
    ok: [['LAST(LIST(1, 2))', 'number']],
    bad: [['LAST([Đơn hàng].[Tags])', 'NESTED_LIST @ [Đơn hàng].[Tags]']],
  },
  NTH: { ok: [['NTH([Tags], 2)', 'text']], bad: [['NTH([Tags], "2")', 'TYPE_MISMATCH @ "2"']] },
  FILTER: {
    ok: [
      ['[Tags].FILTER(CurrentValue != "Nội bộ")', 'list<text>'],
      ['[Tickets].FILTER(CurrentValue.[Hạn] < TODAY()).[Hạn]', 'list<date>'],
      ['[Khách hàng].FILTER(CurrentValue.[Tên] = "A").[Tên]', 'list<text>'],
    ],
    bad: [
      ['[Tags].FILTER(1)', 'TYPE_MISMATCH @ 1'],
      ['FILTER([Tiêu đề], TRUE)', 'EXPECTED_LIST @ [Tiêu đề]'],
    ],
  },
  MAP: {
    ok: [['[Tags].MAP(LEN(CurrentValue))', 'list<number>']],
    bad: [['[Tickets].MAP([Tickets])', 'TABLE_NEEDS_FIELD @ [Tickets]']],
  },
  SORT: {
    ok: [
      ['SORT(LIST(3, 1), FALSE)', 'list<number>'],
      ['[Tags].SORT()', 'list<text>'],
    ],
    bad: [
      ['SORT([Khách hàng])', 'TYPE_MISMATCH @ [Khách hàng]'],
      ['SORT([Tags], 1)', 'TYPE_MISMATCH @ 1'],
    ],
  },
  SORTBY: {
    ok: [
      ['[Tickets].SORTBY(CurrentValue.[Hạn], FALSE).[Hạn]', 'list<date>'],
      ['[Tickets].SORTBY([Tickets].[Hạn]).[Hạn]', 'list<date>'],
      ['[Khách hàng].SORTBY(CurrentValue.[Tên]).[Tên]', 'list<text>'],
    ],
    bad: [
      ['[Tags].SORTBY(CurrentValue)', 'TYPE_MISMATCH @ [Tags]'],
      ['[Tickets].SORTBY([Đơn hàng].[Số tiền]).[Hạn]', 'LIST_AS_SCALAR @ [Đơn hàng].[Số tiền]'],
      [
        '[Tickets].SORTBY(CurrentValue.[Người phụ trách]).[Hạn]',
        'LIST_AS_SCALAR @ CurrentValue.[Người phụ trách]',
      ],
    ],
  },
  UNIQUE: {
    ok: [
      ['UNIQUE(1, 2, 2)', 'list<number>'],
      ['UNIQUE([Khách hàng])', `list<row<${tbl.customers}>>`],
    ],
    bad: [['UNIQUE([Tags], 1)', 'MIXED_LIST @ 1']],
  },
  ARRAYJOIN: {
    ok: [
      ['ARRAYJOIN([Tags], "; ")', 'text'],
      ['[Khách hàng].ARRAYJOIN()', 'text'],
    ],
    bad: [['ARRAYJOIN([Tiêu đề])', 'EXPECTED_LIST @ [Tiêu đề]']],
  },
  LISTCOMBINE: {
    ok: [
      ['LISTCOMBINE([Tags], "x", LIST("y"))', 'list<text>'],
      ['[Đơn hàng].[Tags].LISTCOMBINE()', 'list<text>'],
    ],
    bad: [['LISTCOMBINE([Tags], 1)', 'MIXED_LIST @ 1']],
  },
  LET: {
    ok: [['LET(a, 1, b, a + 1, b * 2)', 'number']],
    bad: [['LET(a, "x", a * 2)', 'TYPE_MISMATCH @ a']],
  },
  LOOKUP: {
    ok: [
      [
        'LOOKUP([Tiêu đề], [Nhà cung cấp].[Tên], [Nhà cung cấp].[Quốc gia])',
        `list<row<${tbl.countries}>>`,
      ],
      ['LOOKUP([Ngày nhận], [Tickets].[Hạn], [Tickets].[Khách]).COUNTA()', 'number'],
      ['LOOKUP("VIP", [Đơn hàng].[Tags], [Đơn hàng].[Số tiền])', 'list<number>'],
      ['LOOKUP([Tags], [Đơn hàng].[Tags], [Đơn hàng].[Số tiền], 0)', 'list<number>'],
    ],
    bad: [
      [
        'LOOKUP([Tiêu đề], [Nhà cung cấp].[Tên], [Tickets].[Hạn])',
        'INVALID_LOOKUP @ [Tickets].[Hạn]',
      ],
      ['LOOKUP([Tiêu đề], [Khách hàng], [Khách hàng].[Tên])', 'INVALID_LOOKUP @ [Khách hàng]'],
      [
        'LOOKUP([Số tiền], [Nhà cung cấp].[Tên], [Nhà cung cấp].[Tên])',
        'TYPE_MISMATCH @ [Số tiền]',
      ],
      ['LOOKUP("a", [Nhà cung cấp].[Tên], [Nhà cung cấp].[Tên], 2)', 'INVALID_ARGUMENT @ 2'],
      ['LOOKUP("a", [Khách hàng].[Tên])', 'WRONG_ARGUMENT_COUNT @ LOOKUP("a", [Khách hàng].[Tên])'],
    ],
  },
  PRODUCT: {
    ok: [['PRODUCT(2, 3, [Số tiền])', 'number']],
    bad: [['PRODUCT("2")', 'TYPE_MISMATCH @ "2"']],
  },
  SQRT: { ok: [['SQRT(16)', 'number']], bad: [['SQRT([Tags])', 'LIST_AS_SCALAR @ [Tags]']] },
  EXP: { ok: [['EXP(1)', 'number']], bad: [['EXP()', 'WRONG_ARGUMENT_COUNT @ EXP()']] },
  LN: { ok: [['LN(EXP(1))', 'number']], bad: [['LN("e")', 'TYPE_MISMATCH @ "e"']] },
  LOG: {
    ok: [
      ['LOG(100)', 'number'],
      ['LOG(8, 2)', 'number'],
    ],
    bad: [['LOG(8, 2, 1)', 'WRONG_ARGUMENT_COUNT @ LOG(8, 2, 1)']],
  },
  PI: { ok: [['PI() * 2', 'number']], bad: [['PI(1)', 'WRONG_ARGUMENT_COUNT @ PI(1)']] },
  LARGE: {
    ok: [['LARGE(LIST(1, 2, 3), 2)', 'number']],
    bad: [['LARGE(1, 2)', 'EXPECTED_LIST @ 1']],
  },
  SMALL: {
    ok: [['SMALL([Tickets].FILTER(TRUE).[Hạn].MAP(DAY(CurrentValue)), 1)', 'number']],
    bad: [['SMALL([Tags], 1)', 'TYPE_MISMATCH @ [Tags]']],
  },
  STDEV: {
    ok: [['STDEV(1, 2, 3)', 'number']],
    bad: [['STDEV([Tiêu đề])', 'TYPE_MISMATCH @ [Tiêu đề]']],
  },
};

describe('every function has type cases', () => {
  it('covers the whole catalogue', () => {
    expect(Object.keys(CASES).sort()).toEqual(
      [...MVP_FUNCTION_NAMES, ...S4B_FUNCTION_NAMES].sort(),
    );
  });
});

describe.each(Object.entries(CASES))('%s', (_name, { ok, bad }) => {
  it.each(ok)('accepts %s → %s', (source, expected) => {
    expect(typeOf(source)).toBe(expected);
  });
  it.each(bad)('rejects %s → %s', (source, expected) => {
    expect(typeOf(source)).toBe(expected);
  });
});

describe('customers snapshot', () => {
  it('reads orders through the reverse link', () => {
    expect(typeOf('[Các đơn].FILTER(CurrentValue.[Đã trả]).[Số tiền].SUM()', customers)).toBe(
      'number',
    );
  });
});

describe('branch type mismatch (M5)', () => {
  it.each([
    'IF([Đã trả], 1, "a")',
    'IFERROR([Số tiền] / 0, "x")',
    'IFS([Số tiền] > 10, "big", TRUE, 1)',
  ])('%s suggests TEXT()', (source) => {
    const result = analyze(source, orders, { form: 'display' });
    expect(result.errors[0]?.detail).toBe('TYPE_MISMATCH');
    expect(result.errors[0]?.params).toMatchObject({ suggestions: ['TEXT'] });
  });
});
