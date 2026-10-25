import { define, p, sig, ex, exl, fixed } from '../catalogue/define.js';
import { Dec } from '../evaluate/decimal.js';
import { elements } from '../evaluate/values.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** COUNTIF (SPEC §9.3, number). */
export const COUNTIF = define({
  name: 'COUNTIF',
  group: 'number',
  iterates: true,
  signatures: [sig('number', [p('range', 'range'), p('condition', 'condition')])],
  result: fixed(T.number),
  description: {
    en: 'Counts the records of a table (or the elements of a list) for which the condition is true; CurrentValue is the record (or element) being tested.',
    vi: 'Đếm số record của bảng (hoặc phần tử của danh sách) thỏa điều kiện; CurrentValue là record (hoặc phần tử) đang xét.',
  },
  examples: [
    exl(
      'COUNTIF([Tickets], CurrentValue.[Assignee] = [Employee] && CurrentValue.[Due] < TODAY())',
      'COUNTIF([Tickets], CurrentValue.[Người phụ trách] = [Nhân viên] && CurrentValue.[Hạn] < TODAY())',
      '4',
    ),
    ex('LIST(1, 5, 12).COUNTIF(CurrentValue > 3)', '2'),
  ],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) =>
  Dec.int(elements(args.value(0)).filter((item) => args.with(1, item) === true).length);
