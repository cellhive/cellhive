import { define, p, sig, exl, fixed } from '../catalogue/define.js';
import { Dec } from '../evaluate/decimal.js';
import { elements, isBlank } from '../evaluate/values.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** COUNTA (SPEC §9.3, number). */
export const COUNTA = define({
  name: 'COUNTA',
  group: 'number',
  signatures: [sig('number', [p('value', 'value')], 1)],
  result: fixed(T.number),
  description: {
    en: 'Counts non-empty values; a list counts each of its non-empty elements.',
    vi: 'Đếm số giá trị không rỗng; danh sách được đếm theo từng phần tử không rỗng.',
  },
  examples: [exl('COUNTA([Attachments])', 'COUNTA([Tệp đính kèm])', '3')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  let count = 0;
  for (let index = 0; index < args.count; index += 1) {
    for (const item of elements(args.value(index))) if (!isBlank(item)) count += 1;
  }
  return Dec.int(count);
};
