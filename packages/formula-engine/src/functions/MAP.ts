import { define, p, sig, ex } from '../catalogue/define.js';
import { elements } from '../evaluate/values.js';
import { T, listOf } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** MAP (SPEC §9.3, list). */
export const MAP = define({
  name: 'MAP',
  group: 'list',
  iterates: true,
  signatures: [sig('list<T>', [p('range', 'range'), p('mapping', 'mapping')])],
  result: (ctx) => listOf(ctx.args[1]?.type ?? T.any),
  styleFrom: [1],
  description: {
    en: 'Turns each record of a table (or element of a list) into a new value; CurrentValue is the record (or element).',
    vi: 'Biến mỗi record của bảng (hoặc phần tử của danh sách) thành giá trị mới; CurrentValue là record (hoặc phần tử) đang xét.',
  },
  examples: [ex('LIST(1, 2, 3).MAP(CurrentValue * 10)', '10, 20, 30')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) =>
  elements(args.value(0)).map((item) => args.with(1, item));
