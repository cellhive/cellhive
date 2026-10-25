import { define, p, sig, exl } from '../catalogue/define.js';
import { containFoldsCase } from '../evaluate/case-fold.js';
import { elements } from '../evaluate/values.js';
import {
  T,
  formatType,
  elementOf,
  equalityComparable,
  type FormulaType,
} from '../types/formula-type.js';

import type { Expr } from '../ast.js';
import type { CallContext } from '../catalogue/types.js';
import type { FunctionImpl } from '../evaluate/runtime.js';

/** `[Table].[Field]` → its table and field IDs; `null` for any other expression. */
function tableField(node: Expr | undefined): { tableId: string; fieldId: string } | null {
  if (node?.type !== 'member' || node.object.type !== 'reference') return null;
  const { object, property } = node;
  if (object.kind !== 'table' || object.id === null || property.id === null) return null;
  return { tableId: object.id, fieldId: property.id };
}

/** Mode argument: 1 (default) finds the value inside a multi-value field, 0 compares whole lists. */
export function lookupMode(node: Expr | undefined): 0 | 1 | null {
  if (node === undefined) return 1;
  if (node.type !== 'number') return null;
  const value = Number(node.value);
  return value === 0 || value === 1 ? value : null;
}

/** The table and fields of a well-formed LOOKUP call (`null` when malformed). */
export function lookupParts(args: readonly Expr[]): {
  tableId: string;
  matchFieldId: string;
  resultFieldId: string;
  mode: 0 | 1;
} | null {
  const match = tableField(args[1]);
  const result = tableField(args[2]);
  const mode = lookupMode(args[3]);
  if (match === null || result === null || match.tableId !== result.tableId || mode === null) {
    return null;
  }
  return {
    tableId: match.tableId,
    matchFieldId: match.fieldId,
    resultFieldId: result.fieldId,
    mode,
  };
}

function lookupResult(ctx: CallContext): FormulaType {
  const [value, match, result, mode] = ctx.args;
  if (value === undefined || match === undefined || result === undefined) return T.any;
  const matchPart = tableField(match.node);
  if (matchPart === null) {
    return ctx.fail(1, 'INVALID_LOOKUP', 'The match field must be written [Table].[Field].');
  }
  const resultPart = tableField(result.node);
  if (resultPart?.tableId !== matchPart.tableId) {
    return ctx.fail(
      2,
      'INVALID_LOOKUP',
      "The result field must be [Table].[Field] of the match field's table.",
    );
  }
  const split = lookupMode(mode?.node);
  if (split === null) {
    return ctx.fail(3, 'INVALID_ARGUMENT', 'The mode must be 0 or 1.', { allowed: [0, 1] });
  }
  // `match.type` is the column of the match field: list<M>.
  const field = elementOf(match.type);
  const multi = field.kind === 'list';
  const target = multi && split === 1 ? field.element : field;
  const needle = multi && split === 1 ? elementOf(value.type) : value.type;
  if (!equalityComparable(target, needle)) {
    return ctx.fail(
      0,
      'TYPE_MISMATCH',
      `Cannot match ${formatType(needle)} against ${formatType(target)}.`,
      {
        expected: formatType(target),
        actual: formatType(needle),
      },
    );
  }
  return result.type;
}

/** LOOKUP (SPEC §9.3, list). */
export const LOOKUP = define({
  name: 'LOOKUP',
  group: 'list',
  signatures: [
    sig('list<T>', [
      p('lookup_value', 'values'),
      p('match_field', 'value'),
      p('result_field', 'value'),
      p('mode', 'number', true),
    ]),
  ],
  syntax: 'LOOKUP(lookup_value, [Table].[Match field], [Table].[Result field], [mode])',
  result: lookupResult,
  styleFrom: [2],
  description: {
    en: 'Values of the result field in the records of another table whose match field equals the lookup value. Short for [Table].FILTER(CurrentValue.[Match field] = value).[Result field].',
    vi: 'Giá trị của field kết quả trong các record của bảng khác có field đối chiếu bằng giá trị cần tìm. Viết tắt của [Bảng].FILTER(CurrentValue.[Field đối chiếu] = giá_trị).[Field kết quả].',
  },
  notes: {
    en: 'Mode 1 (default) matches a multi-value match field when it contains the lookup value (as CONTAIN: texts ignore case); mode 0 when it equals it as a whole list. Counts toward the limit of 5 queries on other tables.',
    vi: 'Mode 1 (mặc định): field đối chiếu nhiều giá trị khớp khi chứa giá trị cần tìm (như CONTAIN: chuỗi không phân biệt hoa thường); mode 0: khi bằng nguyên danh sách. Tính vào giới hạn 5 truy vấn bảng khác.',
  },
  examples: [
    exl(
      'LOOKUP([Name], [Sales summary].[Name], [Sales summary].[Sales volume])',
      'LOOKUP([Tên], [Tổng hợp doanh số].[Tên], [Tổng hợp doanh số].[Doanh số])',
      '120',
    ),
  ],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  // ≡ [T].FILTER(CurrentValue.[M] = value).[R]; mode 1 on a multi-value M: CONTAIN(CurrentValue.[M], value).
  const parts = lookupParts(args.call.args);
  if (parts === null) return null;
  const needle = args.value(0);
  const needleType = args.type(0);
  const matchType = args.rt.fieldType(parts.matchFieldId);
  const contains = parts.mode === 1 && matchType.kind === 'list';
  const fold = contains && containFoldsCase([matchType, needleType]);
  const rows = args.rt.table(parts.tableId).rows.filter((row) => {
    const value = args.rt.field(row, parts.matchFieldId);
    if (!contains) return args.rt.equal(value, needle, matchType, needleType);
    const range = elements(value);
    return elements(needle).some((item) =>
      args.rt.member(item, range, elementOf(needleType), elementOf(matchType), fold),
    );
  });
  return args.rt.column(rows, parts.resultFieldId);
};
