import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { str } from '../evaluate/helpers.js';
import { elements } from '../evaluate/values.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** ARRAYJOIN (SPEC §9.3, list). */
export const ARRAYJOIN = define({
  name: 'ARRAYJOIN',
  group: 'list',
  signatures: [sig('text', [p('list', 'list'), p('separator', 'text', true)])],
  result: fixed(T.text),
  description: {
    en: 'Joins the elements of a list into one text with a separator (", " when left out).',
    vi: 'Nối các phần tử của danh sách thành một chuỗi với dấu phân cách (mặc định ", ").',
  },
  examples: [ex('ARRAYJOIN(LIST("A", "B", "C"), "-")', 'A-B-C')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const separator = args.count > 1 ? (str(args, 1) ?? '') : ', ';
  return elements(args.value(0))
    .map((item) => args.rt.text(item))
    .filter((item) => item !== null)
    .join(separator);
};
