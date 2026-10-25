import { define, p, sig, exl, unifyArgs, every } from '../catalogue/define.js';
import { T, formatType, singlesComparable, type FormulaType } from '../types/formula-type.js';

import type { CallContext } from '../catalogue/types.js';
import type { FunctionImpl } from '../evaluate/runtime.js';

function switchResult(ctx: CallContext): FormulaType {
  const count = ctx.args.length;
  const hasDefault = count % 2 === 0;
  const expression = ctx.args[0]?.type ?? T.any;
  for (let index = 1; index < count - (hasDefault ? 1 : 0); index += 2) {
    const pattern = ctx.args[index]?.type ?? T.any;
    if (!singlesComparable(expression, pattern)) {
      ctx.fail(
        index,
        'TYPE_MISMATCH',
        `Cannot compare ${formatType(expression)} with ${formatType(pattern)}.`,
        {
          expected: formatType(expression),
          actual: formatType(pattern),
        },
      );
    }
  }
  const results = every(2, 2, hasDefault ? 1 : 0)(ctx);
  return unifyArgs(() => (hasDefault ? [...results, count - 1] : results))(ctx);
}

/** SWITCH (SPEC §9.3, logic). */
export const SWITCH = define({
  name: 'SWITCH',
  group: 'logic',
  signatures: [
    sig(
      'T',
      [p('expression', 'single'), p('pattern', 'single'), p('result', 'value')],
      2,
      p('default', 'value', true),
    ),
  ],
  syntax: 'SWITCH(expression, pattern1, result1, [pattern2, result2, …], [default])',
  result: switchResult,
  description: {
    en: 'Compares an expression with each pattern in turn and returns the result of the first match, or the default (empty when there is none).',
    vi: 'So sánh biểu thức lần lượt với từng mẫu, trả về kết quả của mẫu khớp đầu tiên, không khớp thì trả về giá trị mặc định (rỗng nếu không có).',
  },
  examples: [
    exl(
      'SWITCH([Weekday], 1, "Sunday", 2, "Monday", "Other")',
      'SWITCH([Thứ], 1, "Chủ nhật", 2, "Thứ hai", "Khác")',
      'Monday',
      'Thứ hai',
    ),
  ],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const hasDefault = args.count % 2 === 0;
  const expression = args.value(0);
  for (let index = 1; index + 1 < args.count; index += 2) {
    if (args.rt.equal(expression, args.value(index), args.type(0), args.type(index))) {
      return args.value(index + 1);
    }
  }
  return hasDefault ? args.value(args.count - 1) : null;
};
