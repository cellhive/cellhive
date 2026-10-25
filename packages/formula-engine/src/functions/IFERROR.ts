import { define, p, sig, ex, exl, unifyArgs } from '../catalogue/define.js';
import { isNull } from '../evaluate/values.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** IFERROR (SPEC §9.3, logic). */
export const IFERROR = define({
  name: 'IFERROR',
  group: 'logic',
  signatures: [sig('T', [p('value', 'value'), p('value_if_error', 'value')])],
  result: unifyArgs(() => [0, 1]),
  styleFrom: [0, 1],
  description: {
    en: 'Returns the value, or the fallback when the value is an error or empty.',
    vi: 'Trả về giá trị, hoặc giá trị thay thế khi giá trị bị lỗi hoặc rỗng.',
  },
  notes: {
    en: 'Errors and empty values are the same here (IFERROR works like COALESCE): unlike Lark, an empty value also gets the fallback.',
    vi: 'Lỗi và rỗng được coi như nhau (IFERROR hoạt động như COALESCE): khác Lark, giá trị rỗng cũng nhận giá trị thay thế.',
  },
  examples: [
    ex('IFERROR(2 / 0, 0)', '0'),
    exl('IFERROR(VALUE([Code]), -1)', 'IFERROR(VALUE([Mã]), -1)', '-1'),
  ],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const value = args.value(0);
  return isNull(value) ? args.value(1) : value;
};
