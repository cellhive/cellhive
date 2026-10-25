import { define, p, sig, exl, checkMembers } from '../catalogue/define.js';
import { combine, foldsCase } from '../evaluate/helpers.js';
import { elements } from '../evaluate/values.js';
import { elementOf } from '../types/formula-type.js';
import { T, type FormulaType } from '../types/formula-type.js';

import type { CallContext } from '../catalogue/types.js';
import type { FunctionImpl } from '../evaluate/runtime.js';

function members(ctx: CallContext): FormulaType {
  checkMembers(ctx, 1);
  return T.boolean;
}

/** CONTAIN (SPEC §9.3, logic). */
export const CONTAIN = define({
  name: 'CONTAIN',
  group: 'logic',
  signatures: [sig('boolean', [p('range', 'values'), p('value', 'values')], 1)],
  result: members,
  description: {
    en: 'True when the range (a value or a list) contains at least one of the values. Compares whole values, texts ignoring case ("vip" matches "VIP"); use CONTAINTEXT for text inside text.',
    vi: 'Đúng khi phạm vi (một giá trị hoặc danh sách) chứa ít nhất một trong các giá trị. So sánh nguyên giá trị, chuỗi không phân biệt hoa thường ("vip" khớp "VIP"); tìm chuỗi con dùng CONTAINTEXT.',
  },
  notes: {
    en: 'Case is ignored as in Lark (simple Unicode lowercase: "İ" matches "i", "ß" does not match "ss", accents still count); = stays case-sensitive. A linked record matches a text by its title (primary field), or by its ID for RECORD_ID(); a user matches a text by user ID. User IDs and RECORD_ID() compare exactly: when one takes part, the whole call is case-sensitive.',
    vi: 'Không phân biệt hoa thường như Lark (chữ thường Unicode đơn: "İ" khớp "i", "ß" không khớp "ss", dấu vẫn tính); = vẫn phân biệt. Record liên kết khớp chuỗi theo tiêu đề (primary field), hoặc theo ID với RECORD_ID(); user khớp chuỗi theo user ID. User ID và RECORD_ID() so chính xác: khi có một trong hai, cả lời gọi phân biệt hoa thường.',
  },
  examples: [
    exl(
      'IF(CONTAIN([Region], "Japan", "Korea"), "Asia-Pacific", "Other")',
      'IF(CONTAIN([Khu vực], "Nhật Bản", "Hàn Quốc"), "Châu Á - TBD", "Khác")',
      'Asia-Pacific',
      'Châu Á - TBD',
    ),
    exl(
      '[Orders].FILTER(CurrentValue.[Customer].CONTAIN([Name])).[Amount].SUM()',
      '[Đơn hàng].FILTER(CurrentValue.[Khách hàng].CONTAIN([Tên])).[Số tiền].SUM()',
      '3500000',
    ),
  ],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  // SQL: range && values (array overlap; empty elements never match).
  const range = elements(args.value(0));
  const rangeType = elementOf(args.type(0));
  const values = combine(args, 1);
  const type = elementOf(args.type(1));
  const fold = foldsCase(args);
  return values.some((item) => args.rt.member(item, range, type, rangeType, fold));
};
