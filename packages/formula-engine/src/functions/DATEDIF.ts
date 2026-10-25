import { define, p, sig, ex, literalOneOf } from '../catalogue/define.js';
import { datedif } from '../evaluate/dates.js';
import { Dec } from '../evaluate/decimal.js';
import { day, str } from '../evaluate/helpers.js';
import { T, type FormulaType } from '../types/formula-type.js';

import type { CallContext } from '../catalogue/types.js';
import type { FunctionImpl } from '../evaluate/runtime.js';

function datedifResult(ctx: CallContext): FormulaType {
  literalOneOf(ctx, 2, DATEDIF_UNITS);
  return T.number;
}

/** Units of DATEDIF (case-insensitive). */
export const DATEDIF_UNITS = ['Y', 'M', 'D', 'MD', 'YM', 'YD'] as const;

/** DATEDIF (SPEC §9.3, date). */
export const DATEDIF = define({
  name: 'DATEDIF',
  group: 'date',
  signatures: [sig('number', [p('start_date', 'date'), p('end_date', 'date'), p('unit', 'text')])],
  result: datedifResult,
  description: {
    en: 'Whole years ("Y"), months ("M") or days ("D") between two dates; "MD", "YM", "YD" ignore the larger units.',
    vi: 'Số năm ("Y"), tháng ("M") hoặc ngày ("D") tròn giữa hai ngày; "MD", "YM", "YD" bỏ qua đơn vị lớn hơn.',
  },
  examples: [ex('DATEDIF(DATE(2000, 1, 1), DATE(2000, 1, 8), "D")', '7')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const start = day(args, 0);
  const end = day(args, 1);
  const unit = str(args, 2);
  if (start === null || end === null || unit === null) return null;
  const result = datedif(start, end, unit);
  return result === null ? null : Dec.int(result);
};
