import { define, p, sig, ex, exl } from '../catalogue/define.js';
import { Dec } from '../evaluate/decimal.js';
import { elements, toDec } from '../evaluate/values.js';
import { T, formatType, isOpen, type FormulaType } from '../types/formula-type.js';

import type { CallContext } from '../catalogue/types.js';
import type { FunctionImpl } from '../evaluate/runtime.js';

function sumifResult(ctx: CallContext): FormulaType {
  const value = ctx.args[2];
  if (value !== undefined && !isOpen(value.type) && value.type.kind !== 'number') {
    return ctx.fail(2, 'TYPE_MISMATCH', `Expected number, got ${formatType(value.type)}.`, {
      expected: 'number',
      actual: formatType(value.type),
    });
  }
  return T.number;
}

/** SUMIF (SPEC §9.3, number). */
export const SUMIF = define({
  name: 'SUMIF',
  group: 'number',
  iterates: true,
  signatures: [
    sig('number', [p('range', 'number_list'), p('condition', 'condition')]),
    sig('number', [p('range', 'rows'), p('condition', 'condition'), p('sum_value', 'mapping')]),
  ],
  result: sumifResult,
  styleFrom: [2, 0],
  description: {
    en: 'Adds the numbers of a list for which the condition is true; over a table, adds the value computed for each matching record.',
    vi: 'Cộng các số của danh sách thỏa điều kiện; với bảng, cộng giá trị tính cho từng record thỏa điều kiện.',
  },
  examples: [
    ex('LIST(1, 5, 12).SUMIF(CurrentValue > 3)', '17'),
    exl(
      '[Orders].SUMIF(CurrentValue.[Status] = "Paid", CurrentValue.[Amount])',
      '[Đơn hàng].SUMIF(CurrentValue.[Trạng thái] = "Đã trả", CurrentValue.[Số tiền])',
      '2000000',
    ),
  ],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  let total = Dec.ZERO;
  for (const item of elements(args.value(0))) {
    if (args.with(1, item) !== true) continue;
    const value = toDec(args.count > 2 ? args.with(2, item) : item);
    if (value !== null) total = total.add(value);
  }
  return total;
};
