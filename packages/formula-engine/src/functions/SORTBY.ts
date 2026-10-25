import { define, p, sig, exl } from '../catalogue/define.js';
import { optBool, sortBy } from '../evaluate/helpers.js';
import { elements, isRow, isTable } from '../evaluate/values.js';
import {
  T,
  formatType,
  elementOf,
  isOrderable,
  isOpen,
  rowsTable,
  isSingle,
  type FormulaType,
} from '../types/formula-type.js';

import type { CallContext } from '../catalogue/types.js';
import type { FunctionImpl } from '../evaluate/runtime.js';
import type { Value } from '../evaluate/values.js';

function sortbyResult(ctx: CallContext): FormulaType {
  const rows = ctx.args[0]?.type ?? T.any;
  const by = ctx.args[1];
  if (by !== undefined) {
    // `[Table].[Field]` of the same table is Lark's way to name the sort field.
    const sameTable =
      by.node.type === 'member' &&
      by.node.object.type === 'reference' &&
      by.node.object.kind === 'table' &&
      by.node.object.id === rowsTable(rows);
    const key = sameTable ? elementOf(by.type) : by.type;
    if (!isSingle(key) && !isOpen(key)) {
      return ctx.fail(
        1,
        'LIST_AS_SCALAR',
        'Sort by one value per record, e.g. CurrentValue.[Field].',
        {
          suggestions: ['CurrentValue.[Field]'],
        },
      );
    }
    if (!isOrderable(key)) {
      return ctx.fail(1, 'TYPE_MISMATCH', `Cannot sort by ${formatType(key)} values.`, {
        expected: 'number | text | date',
        actual: formatType(key),
      });
    }
  }
  return rows;
}

/** SORTBY (SPEC §9.3, list). */
export const SORTBY = define({
  name: 'SORTBY',
  group: 'list',
  iterates: true,
  signatures: [
    sig('T', [p('rows', 'rows'), p('sort_by', 'mapping'), p('ascending', 'boolean', true)]),
  ],
  result: sortbyResult,
  styleFrom: [0],
  description: {
    en: 'Sorts the records of a table (or a list of records) by a value of each record: CurrentValue.[Field] or [Table].[Field]. End with .[Field].',
    vi: 'Sắp xếp record của bảng (hoặc danh sách record) theo một giá trị của từng record: CurrentValue.[Field] hoặc [Table].[Field]. Kết thúc bằng .[Field].',
  },
  examples: [
    exl(
      '[Sales].SORTBY(CurrentValue.[Date], FALSE).[Amount]',
      '[Doanh số].SORTBY(CurrentValue.[Ngày], FALSE).[Số tiền]',
      '300, 120, 90',
    ),
  ],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const range = args.value(0);
  const by = args.node(1);
  // `[Table].[Field]` of the rows' table names the field of each record (as in Lark).
  const field =
    by.type === 'member' && by.object.type === 'reference' && by.object.kind === 'table'
      ? { tableId: by.object.id, fieldId: by.property.id }
      : null;
  const key = (item: Value): Value =>
    field !== null && field.fieldId !== null && isRow(item) && item.tableId === field.tableId
      ? args.rt.field(item, field.fieldId)
      : args.with(1, item);
  const rows = sortBy(elements(range), key, optBool(args, 2, true), args.rt);
  if (!isTable(range)) return rows;
  return { kind: 'table', tableId: range.tableId, rows: rows.filter(isRow) };
};
