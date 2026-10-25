import { define, p, sig, exl, checkMembers } from '../catalogue/define.js';
import { combine, foldsCase } from '../evaluate/helpers.js';
import { elements } from '../evaluate/values.js';
import { elementOf, T, type FormulaType } from '../types/formula-type.js';

import type { CallContext } from '../catalogue/types.js';
import type { FunctionImpl } from '../evaluate/runtime.js';

function members(ctx: CallContext): FormulaType {
  checkMembers(ctx, 1);
  return T.boolean;
}

/** CONTAINSALL (SPEC §9.3, logic). */
export const CONTAINSALL = define({
  name: 'CONTAINSALL',
  group: 'logic',
  signatures: [sig('boolean', [p('range', 'values'), p('value', 'values')], 1)],
  result: members,
  description: {
    en: 'True when the range contains every one of the values (texts ignoring case, as CONTAIN). An empty value is never contained: CONTAINSALL with an empty search value is FALSE.',
    vi: 'Đúng khi phạm vi chứa tất cả các giá trị (chuỗi không phân biệt hoa thường, như CONTAIN). Giá trị rỗng không bao giờ được chứa: CONTAINSALL với giá trị tìm rỗng là FALSE.',
  },
  examples: [
    exl(
      'CONTAINSALL([Courses], "Literature", "Linguistics")',
      'CONTAINSALL([Môn học], "Văn học", "Ngôn ngữ học")',
      'TRUE',
    ),
  ],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  // SQL: range @> values (an empty value is never contained).
  const range = elements(args.value(0));
  const rangeType = elementOf(args.type(0));
  const type = elementOf(args.type(1));
  const fold = foldsCase(args);
  return combine(args, 1).every((item) => args.rt.member(item, range, type, rangeType, fold));
};
