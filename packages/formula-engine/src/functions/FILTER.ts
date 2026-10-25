import { define, p, sig, exl, argType } from '../catalogue/define.js';
import { elements, isTable } from '../evaluate/values.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** FILTER (SPEC §9.3, list). */
export const FILTER = define({
  name: 'FILTER',
  group: 'list',
  iterates: true,
  signatures: [sig('T', [p('range', 'range'), p('condition', 'condition')])],
  result: argType(0),
  styleFrom: [0],
  description: {
    en: 'Keeps the records of a table (or elements of a list) for which the condition is true; CurrentValue is the record (or element) being tested. Over a table, end with .[Field].',
    vi: 'Giữ các record của bảng (hoặc phần tử của danh sách) thỏa điều kiện; CurrentValue là record (hoặc phần tử) đang xét. Trên bảng phải kết thúc bằng .[Field].',
  },
  notes: {
    en: 'FILTER, MAP, COUNTIF, SUMIF, SORTBY and LOOKUP cannot be used inside the condition of one another (chaining is fine).',
    vi: 'Không lồng FILTER, MAP, COUNTIF, SUMIF, SORTBY, LOOKUP trong điều kiện của nhau (chaining thì được).',
  },
  examples: [
    exl(
      '[Orders].FILTER(CurrentValue.[Customer].CONTAIN([Name]) && CurrentValue.[Status] = "Delivered").[Amount].SUM()',
      '[Đơn hàng].FILTER(CurrentValue.[Khách hàng].CONTAIN([Tên]) && CurrentValue.[Trạng thái] = "Đã giao").[Số tiền].SUM()',
      '3500000',
    ),
    exl(
      '[Tags].FILTER(CurrentValue != "Internal").ARRAYJOIN(", ")',
      '[Tags].FILTER(CurrentValue != "Nội bộ").ARRAYJOIN(", ")',
      'VIP, Wholesale',
      'VIP, Sỉ',
    ),
  ],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const range = args.value(0);
  if (isTable(range)) {
    return {
      kind: 'table',
      tableId: range.tableId,
      rows: range.rows.filter((row) => args.with(1, row) === true),
    };
  }
  return elements(range).filter((item) => args.with(1, item) === true);
};
