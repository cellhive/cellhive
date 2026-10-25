import { define, p, sig, ex, exl, listOfArgs } from '../catalogue/define.js';
import { elements } from '../evaluate/values.js';

import type { FunctionImpl } from '../evaluate/runtime.js';
import type { Value } from '../evaluate/values.js';

/** LISTCOMBINE (SPEC §9.3, list). */
export const LISTCOMBINE = define({
  name: 'LISTCOMBINE',
  group: 'list',
  signatures: [sig('list<T>', [p('value', 'lists')], 1)],
  result: listOfArgs(2),
  styleFrom: 'all',
  description: {
    en: 'Combines values, lists and lists of lists (such as a multi-value field read through a link) into one flat list.',
    vi: 'Gộp các giá trị, danh sách và danh sách lồng (vd field đa giá trị đọc qua link) thành một danh sách phẳng.',
  },
  examples: [
    ex('LIST(1, 2, 3).LISTCOMBINE(4, 5)', '1, 2, 3, 4, 5'),
    exl(
      '[Orders].[Tags].LISTCOMBINE().UNIQUE()',
      '[Đơn hàng].[Tags].LISTCOMBINE().UNIQUE()',
      'VIP, Wholesale',
      'VIP, Sỉ',
    ),
  ],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const out: Value[] = [];
  for (let index = 0; index < args.count; index += 1) {
    const value = args.value(index);
    if (!Array.isArray(value) && args.type(index).kind !== 'list') {
      out.push(value);
      continue;
    }
    for (const item of elements(value)) {
      if (Array.isArray(item)) out.push(...(item as readonly Value[]));
      else out.push(item);
    }
  }
  return out;
};
