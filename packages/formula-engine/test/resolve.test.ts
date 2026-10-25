import { describe, expect, it } from 'vitest';

import {
  FormulaError,
  MAX_CROSS_TABLE_FILTERS,
  MAX_LINK_CHAIN,
  parse,
  renderNames,
  resolveNames,
  serialize,
  toStoredFormula,
  type SchemaSnapshot,
} from '../src/index.js';

import {
  fld,
  inCustomers,
  inOrders,
  nodes,
  snapshotFor,
  tbl,
  withoutField,
  withoutTable,
} from './fixture.js';

const stored = (source: string, snapshot: SchemaSnapshot = inOrders) =>
  toStoredFormula(source, snapshot).stored;

const failure = (source: string, snapshot: SchemaSnapshot = inOrders) => {
  try {
    toStoredFormula(source, snapshot);
  } catch (error) {
    if (error instanceof FormulaError) {
      return {
        code: error.code,
        detail: error.detail,
        text: source.slice(error.start, error.start + error.length),
        params: error.params,
      };
    }
    throw error;
  }
  throw new Error(`expected "${source}" to fail`);
};

describe('resolveNames: SPEC §9.2 examples', () => {
  const cases: { name: string; source: string; snapshot: SchemaSnapshot; expected: string }[] = [
    {
      name: 'same-row fields',
      source: 'IF([Trạng thái] = "Hoàn thành", [Số tiền] * 0.1, 0)',
      snapshot: inOrders,
      expected: `IF([${fld.status}] = "Hoàn thành", [${fld.amount}] * 0.1, 0)`,
    },
    {
      name: 'field through a link',
      source: '[Khách hàng].[Hạng]',
      snapshot: inOrders,
      expected: `[${fld.customer}].[${fld.tier}]`,
    },
    {
      name: 'cross-table FILTER with CurrentValue',
      source:
        '[Đơn hàng].FILTER(CurrentValue.[Khách hàng].CONTAIN([Tên]) && CurrentValue.[Trạng thái] = "Đã giao").[Số tiền].SUM()',
      snapshot: inCustomers,
      expected: `[${tbl.orders}].FILTER([${fld.customer}] ≡`,
    },
    {
      name: 'COUNTIF over a table',
      source:
        'COUNTIF([Tickets], CurrentValue.[Người phụ trách] = [Nhân viên] && CurrentValue.[Hạn] < TODAY())',
      snapshot: inCustomers,
      expected: `COUNTIF([${tbl.tickets}], CurrentValue.[${fld.assignee}] = [${fld.employee}] && CurrentValue.[${fld.due}] < TODAY())`,
    },
    {
      name: 'FILTER over a plain list',
      source: '[Tags].FILTER(CurrentValue != "Nội bộ").ARRAYJOIN(", ")',
      snapshot: inOrders,
      expected: `[${fld.tags}].FILTER(CurrentValue != "Nội bộ").ARRAYJOIN(", ")`,
    },
    {
      name: 'date function',
      source: 'WORKDAY([Ngày nhận], 3)',
      snapshot: inOrders,
      expected: `WORKDAY([${fld.received}], 3)`,
    },
  ];

  it.each(cases)('$name', ({ source, snapshot, expected }) => {
    const text = stored(source, snapshot);
    if (expected.endsWith('≡')) {
      expect(text).toBe(
        `[${tbl.orders}].FILTER(CurrentValue.[${fld.customer}].CONTAIN([${fld.customerName}]) && CurrentValue.[${fld.status}] = "Đã giao").[${fld.amount}].SUM()`,
      );
    } else {
      expect(text).toBe(expected);
    }
    // Stored text renders back to the canonical display text.
    expect(renderNames(text, snapshot)).toBe(serialize(parse(source)));
  });
});

describe('resolveNames: contexts', () => {
  const cases: { name: string; source: string; snapshot?: SchemaSnapshot; expected: string }[] = [
    { name: 'table column', source: '[Tickets].[Hạn]', expected: `[${tbl.tickets}].[${fld.due}]` },
    { name: 'whole table', source: 'COUNTA([Tickets])', expected: `COUNTA([${tbl.tickets}])` },
    {
      name: 'a field wins over a table of the same name',
      source: '[Khách hàng].[Tên]',
      expected: `[${fld.customer}].[${fld.customerName}]`,
    },
    {
      name: 'the table is used where no field has the name',
      source: '[Khách hàng].[Tên]',
      snapshot: snapshotFor(tbl.tickets),
      expected: `[${tbl.customers}].[${fld.customerName}]`,
    },
    {
      name: 'three link hops',
      source: '[Sản phẩm].[Nhà cung cấp].[Quốc gia].[Tên]',
      expected: `[${fld.product}].[${fld.supplier}].[${fld.country}].[${fld.countryName}]`,
    },
    {
      name: 'three link hops ending on a link',
      source: '[Sản phẩm].[Nhà cung cấp].[Quốc gia].[Châu lục]',
      expected: `[${fld.product}].[${fld.supplier}].[${fld.country}].[${fld.continent}]`,
    },
    {
      name: 'same name resolves per table',
      source: '[Sản phẩm].[Tên] & [Khách hàng].[Tên]',
      expected: `[${fld.product}].[${fld.productName}] & [${fld.customer}].[${fld.customerName}]`,
    },
    {
      name: 'table then link',
      source: '[Đơn hàng].[Khách hàng].[Tên]',
      snapshot: inCustomers,
      expected: `[${tbl.orders}].[${fld.customer}].[${fld.customerName}]`,
    },
    {
      name: 'FILTER over a link, CurrentValue is a linked record',
      source: '[Các đơn].FILTER(CurrentValue.[Số tiền] > 100).[Tiêu đề]',
      snapshot: inCustomers,
      expected: `[${fld.customerOrders}].FILTER(CurrentValue.[${fld.amount}] > 100).[${fld.orderTitle}]`,
    },
    {
      name: 'FILTER function form',
      source: 'FILTER([Tickets], CurrentValue.[Hạn] > TODAY()).[Người phụ trách]',
      expected: `FILTER([${tbl.tickets}], CurrentValue.[${fld.due}] > TODAY()).[${fld.assignee}]`,
    },
    {
      name: 'bare names inside FILTER stay in the formula table',
      source: '[Tickets].FILTER(CurrentValue.[Người phụ trách] = [Tiêu đề]).COUNTA()',
      expected: `[${tbl.tickets}].FILTER(CurrentValue.[${fld.assignee}] = [${fld.orderTitle}]).COUNTA()`,
    },
    {
      name: 'CurrentValue row through links',
      source:
        '[Tickets].FILTER(CurrentValue.[Hạn] > 1).COUNTA() + [Các đơn].FILTER(CurrentValue.[Khách hàng].[Hạng] = "A").COUNTA()',
      snapshot: inCustomers,
      expected: `[${tbl.tickets}].FILTER(CurrentValue.[${fld.due}] > 1).COUNTA() + [${fld.customerOrders}].FILTER(CurrentValue.[${fld.customer}].[${fld.tier}] = "A").COUNTA()`,
    },
    {
      name: 'MAP, SUMIF and SORTBY iterate too',
      source:
        'MAP([Tickets], CurrentValue.[Hạn]) & SUMIF([Đơn hàng], CurrentValue.[Số tiền] > 1) & SORTBY([Tickets], CurrentValue.[Hạn])',
      snapshot: inCustomers,
      expected: `MAP([${tbl.tickets}], CurrentValue.[${fld.due}]) & SUMIF([${tbl.orders}], CurrentValue.[${fld.amount}] > 1) & SORTBY([${tbl.tickets}], CurrentValue.[${fld.due}])`,
    },
    {
      name: 'rows survive SORT, FIRST and NTH',
      source: '[Tickets].SORT().FIRST().[Hạn] & [Tickets].NTH(2).[Hạn]',
      expected: `[${tbl.tickets}].SORT().FIRST().[${fld.due}] & [${tbl.tickets}].NTH(2).[${fld.due}]`,
    },
    {
      name: 'LET variable holding rows',
      source:
        'LET(rows, [Tickets].FILTER(CurrentValue.[Hạn] > 1), rows.[Người phụ trách].COUNTA())',
      expected: `LET(rows, [${tbl.tickets}].FILTER(CurrentValue.[${fld.due}] > 1), rows.[${fld.assignee}].COUNTA())`,
    },
    {
      name: 'LET variable holding a link',
      source: 'LET(k, [Khách hàng], k.[Hạng])',
      expected: `LET(k, [${fld.customer}], k.[${fld.tier}])`,
    },
    {
      name: 'nested LET shadows rows with a value',
      source: 'LET(k, [Khách hàng], LET(k, 1, k + 1))',
      expected: `LET(k, [${fld.customer}], LET(k, 1, k + 1))`,
    },
    {
      name: 'self link',
      source: '[Người bán].[Quản lý].[Quản lý].[Tên]',
      expected: `[${fld.staffLink}].[${fld.manager}].[${fld.manager}].[${fld.staffName}]`,
    },
    {
      name: 'name with escapes',
      source: '[a\\]b\\\\c "q"] & 1',
      expected: `[${fld.odd}] & 1`,
    },
    {
      name: 'restored #REF heals',
      source: `#REF[${fld.amount}] + [Khách hàng].#REF[${fld.tier}]`,
      expected: `[${fld.amount}] + [${fld.customer}].[${fld.tier}]`,
    },
    {
      name: 'bare CurrentValue outside iteration is left to the typecheck',
      source: 'CurrentValue',
      expected: 'CurrentValue',
    },
    { name: 'no references', source: '1 + 2', expected: '1 + 2' },
  ];

  it.each(cases)('$name', ({ source, snapshot = inOrders, expected }) => {
    expect(stored(source, snapshot)).toBe(expected);
  });

  it('fills id, kind and name on every reference', () => {
    const ast = resolveNames(parse('[Khách hàng].[Hạng] & [Tickets].COUNTA()'), inOrders);
    const refs = nodes(ast).filter((node) => node.type === 'reference');
    expect(refs.map(({ name, id, kind }) => ({ name, id, kind }))).toEqual([
      { name: 'Khách hàng', id: fld.customer, kind: 'field' },
      { name: 'Hạng', id: fld.tier, kind: 'field' },
      { name: 'Tickets', id: tbl.tickets, kind: 'table' },
    ]);
  });

  it('resolves stored text the same way (IDs are checked in context)', () => {
    const text = stored('[Khách hàng].[Hạng] + [Tickets].[Hạn].COUNTA()');
    const again = serialize(resolveNames(parse(text, { form: 'stored' }), inOrders), 'stored');
    expect(again).toBe(text);
  });

  it('keeps spans', () => {
    const ast = resolveNames(parse('1 + [Số tiền]'), inOrders);
    expect(ast.type === 'binary' && ast.right).toMatchObject({
      start: 4,
      length: 9,
      id: fld.amount,
    });
  });
});

describe('resolveNames: errors', () => {
  const noAmount = withoutField(inOrders, fld.amount);
  const cases: {
    name: string;
    source: string;
    snapshot?: SchemaSnapshot;
    detail: string;
    text: string;
    params?: Record<string, unknown>;
  }[] = [
    {
      name: 'unknown field',
      source: '1 + [Nope]',
      detail: 'UNKNOWN_FIELD',
      text: '[Nope]',
      params: { name: 'Nope' },
    },
    {
      name: 'names are case sensitive',
      source: '[số tiền]',
      detail: 'UNKNOWN_FIELD',
      text: '[số tiền]',
    },
    {
      name: 'hidden field',
      source: '[Số tiền] * 2',
      snapshot: noAmount,
      detail: 'UNKNOWN_FIELD',
      text: '[Số tiền]',
    },
    {
      name: 'unknown field through a link',
      source: '[Khách hàng].[Nope]',
      detail: 'UNKNOWN_FIELD',
      text: '[Nope]',
    },
    {
      name: 'field of another table through a link',
      source: '[Khách hàng].[Số tiền]',
      detail: 'UNKNOWN_FIELD',
      text: '[Số tiền]',
    },
    {
      name: 'unknown field of a table',
      source: '[Tickets].[Tên]',
      detail: 'UNKNOWN_FIELD',
      text: '[Tên]',
    },
    {
      name: 'unknown field of the CurrentValue row',
      source: '[Tickets].FILTER(CurrentValue.[Số tiền] > 1)',
      detail: 'UNKNOWN_FIELD',
      text: '[Số tiền]',
    },
    {
      name: 'broken reference still missing',
      source: `#REF[${fld.amount}] + 1`,
      snapshot: noAmount,
      detail: 'UNKNOWN_FIELD',
      text: `#REF[${fld.amount}]`,
      params: { id: fld.amount },
    },
    {
      name: 'broken reference to a field of another table',
      source: `#REF[${fld.due}]`,
      detail: 'UNKNOWN_FIELD',
      text: `#REF[${fld.due}]`,
    },
    {
      name: 'broken table reference',
      source: `#REF[${tbl.tickets}].COUNTA()`,
      snapshot: withoutTable(inOrders, tbl.tickets),
      detail: 'UNKNOWN_TABLE',
      text: `#REF[${tbl.tickets}]`,
      params: { id: tbl.tickets },
    },
    {
      name: 'member of a plain field',
      source: '[Số tiền].[Hạng]',
      detail: 'NOT_A_LINK',
      text: '[Số tiền]',
    },
    {
      name: 'member of a plain field through a link',
      source: '[Khách hàng].[Hạng].[Tên]',
      detail: 'NOT_A_LINK',
      text: '[Khách hàng].[Hạng]',
    },
    { name: 'member of a number', source: '1.[Hạng]', detail: 'INVALID_MEMBER', text: '1' },
    {
      name: 'member of a sum',
      source: '([Khách hàng] + 1).[Hạng]',
      detail: 'INVALID_MEMBER',
      text: '([Khách hàng] + 1)',
    },
    {
      name: 'member of a SUM',
      source: '[Tags].SUM().[Hạng]',
      detail: 'INVALID_MEMBER',
      text: '[Tags].SUM()',
    },
    {
      name: 'member of a value variable',
      source: 'LET(x, 1, x.[Hạng])',
      detail: 'INVALID_MEMBER',
      text: 'x',
    },
    {
      name: 'CurrentValue row outside iteration',
      source: 'CurrentValue.[Số tiền]',
      detail: 'INVALID_CURRENT_VALUE',
      text: 'CurrentValue',
    },
    {
      name: 'CurrentValue of a plain list is a value',
      source: '[Tags].FILTER(CurrentValue.[Hạng] = 1)',
      detail: 'INVALID_CURRENT_VALUE',
      text: 'CurrentValue',
    },
    {
      name: 'CurrentValue in the scope argument is the outer one',
      source: 'FILTER(CurrentValue.[Hạn], TRUE)',
      detail: 'INVALID_CURRENT_VALUE',
      text: 'CurrentValue',
    },
  ];

  it.each(cases)('$name → $detail', ({ source, snapshot = inOrders, detail, text, params }) => {
    const result = failure(source, snapshot);
    expect(result).toMatchObject({ code: 'FORMULA_SYNTAX_ERROR', detail, text });
    if (params !== undefined) expect(result.params).toEqual(params);
  });
});

describe('resolveNames: SPEC §9.5 limits', () => {
  it(`rejects more than ${String(MAX_LINK_CHAIN)} link hops`, () => {
    expect(failure('[Sản phẩm].[Nhà cung cấp].[Quốc gia].[Châu lục].[Tên]')).toMatchObject({
      code: 'FORMULA_LIMIT_EXCEEDED',
      detail: 'MAX_LINK_CHAIN',
      text: '[Sản phẩm].[Nhà cung cấp].[Quốc gia].[Châu lục].[Tên]',
      params: { limit: MAX_LINK_CHAIN },
    });
  });

  it('counts hops of a self link', () => {
    expect(failure('[Người bán].[Quản lý].[Quản lý].[Quản lý].[Tên]').detail).toBe(
      'MAX_LINK_CHAIN',
    );
  });

  it('counts hops of a CurrentValue row', () => {
    const source =
      '[Đơn hàng].FILTER(CurrentValue.[Sản phẩm].[Nhà cung cấp].[Quốc gia].[Châu lục].[Tên] = "A").COUNTA()';
    expect(failure(source, inCustomers).detail).toBe('MAX_LINK_CHAIN');
  });

  it('rejects iterating over records four links away', () => {
    const source = '[Sản phẩm].[Nhà cung cấp].[Quốc gia].[Châu lục].FILTER(TRUE).COUNTA()';
    expect(failure(source)).toMatchObject({
      detail: 'MAX_LINK_CHAIN',
      text: source.replace('.COUNTA()', ''),
    });
  });

  const filters = (count: number) =>
    Array.from({ length: count }, () => '[Tickets].FILTER(CurrentValue.[Hạn] > 1).COUNTA()').join(
      ' + ',
    );

  it(`accepts ${String(MAX_CROSS_TABLE_FILTERS)} cross-table filters`, () => {
    expect(() => stored(filters(MAX_CROSS_TABLE_FILTERS))).not.toThrow();
  });

  it(`rejects ${String(MAX_CROSS_TABLE_FILTERS + 1)} cross-table filters at the extra one`, () => {
    const source = filters(MAX_CROSS_TABLE_FILTERS + 1);
    expect(failure(source)).toMatchObject({
      code: 'FORMULA_LIMIT_EXCEEDED',
      detail: 'MAX_CROSS_TABLE_FILTERS',
      text: '[Tickets].FILTER(CurrentValue.[Hạn] > 1)',
      params: { limit: MAX_CROSS_TABLE_FILTERS },
    });
  });

  it('counts COUNTIF, SUMIF, MAP and SORTBY over tables too', () => {
    const source =
      'COUNTIF([Tickets], TRUE) + SUMIF([Tickets], TRUE) + MAP([Tickets], 1).COUNTA() + SORTBY([Tickets], 1).COUNTA() + [Tickets].FILTER(TRUE).COUNTA() + COUNTIF([Tickets], FALSE)';
    expect(failure(source).detail).toBe('MAX_CROSS_TABLE_FILTERS');
  });

  it('does not count filters over links or plain lists', () => {
    const source = Array.from(
      { length: 8 },
      () => '[Khách hàng].FILTER(TRUE).COUNTA() + [Tags].FILTER(TRUE).COUNTA()',
    ).join(' + ');
    expect(() => stored(source)).not.toThrow();
  });
});

describe('renderNames', () => {
  const text = stored('[Số tiền] + [Khách hàng].[Hạng].COUNTA() + [Tickets].[Hạn].COUNTA()');

  it('renders current names', () => {
    expect(renderNames(text, inOrders)).toBe(
      '[Số tiền] + [Khách hàng].[Hạng].COUNTA() + [Tickets].[Hạn].COUNTA()',
    );
  });

  it('follows renames', () => {
    const renamed: SchemaSnapshot = {
      ...inOrders,
      tables: inOrders.tables.map((table) => ({
        ...table,
        name: table.id === tbl.tickets ? 'Phiếu [hỗ trợ]' : table.name,
        fields: table.fields.map((item) =>
          item.id === fld.amount ? { ...item, name: 'Doanh thu' } : item,
        ),
      })),
    };
    expect(renderNames(text, renamed)).toBe(
      '[Doanh thu] + [Khách hàng].[Hạng].COUNTA() + [Phiếu [hỗ trợ\\]].[Hạn].COUNTA()',
    );
  });

  it.each([
    [
      'a deleted field',
      withoutField(inOrders, fld.amount),
      `#REF[${fld.amount}] + [Khách hàng].[Hạng].COUNTA() + [Tickets].[Hạn].COUNTA()`,
    ],
    [
      'a deleted field behind a link',
      withoutField(inOrders, fld.tier),
      `[Số tiền] + [Khách hàng].#REF[${fld.tier}].COUNTA() + [Tickets].[Hạn].COUNTA()`,
    ],
    [
      'a deleted link (the field after it keeps its name)',
      withoutField(inOrders, fld.customer),
      `[Số tiền] + #REF[${fld.customer}].[Hạng].COUNTA() + [Tickets].[Hạn].COUNTA()`,
    ],
    [
      'a deleted table',
      withoutTable(inOrders, tbl.tickets),
      `[Số tiền] + [Khách hàng].[Hạng].COUNTA() + #REF[${tbl.tickets}].#REF[${fld.due}].COUNTA()`,
    ],
  ])('renders #REF for %s', (_name, snapshot, expected) => {
    const display = renderNames(text, snapshot);
    expect(display).toBe(expected);
    // #REF text parses; it resolves again once the ID is back.
    expect(() => parse(display)).not.toThrow();
    expect(stored(display, inOrders)).toBe(text);
  });

  it('renders a field of a deleted table and a field out of context as #REF', () => {
    const snapshot = withoutTable(inOrders, tbl.tickets);
    const display = renderNames(`[${tbl.tickets}].[${fld.due}] & [${fld.due}]`, snapshot);
    expect(display).toBe(`#REF[${tbl.tickets}].#REF[${fld.due}] & #REF[${fld.due}]`);
  });

  it('does not fail on limits (stored text was checked when saved)', () => {
    const chain = `[${fld.product}].[${fld.supplier}].[${fld.country}].[${fld.continent}].[${fld.continentName}]`;
    expect(renderNames(chain, inOrders)).toBe(
      '[Sản phẩm].[Nhà cung cấp].[Quốc gia].[Châu lục].[Tên]',
    );
    const filters = Array.from({ length: 7 }, () => `[${tbl.tickets}].FILTER(TRUE).COUNTA()`).join(
      ' + ',
    );
    expect(() => renderNames(filters, inOrders)).not.toThrow();
  });

  it('rejects display text passed as stored text', () => {
    expect(() => renderNames('[Số tiền]', inOrders)).toThrow(FormulaError);
  });
});

describe('round trip: display → stored → display', () => {
  const sources = [
    'IF([Trạng thái] = "Hoàn thành", [Số tiền] * 0.1, 0)',
    '[Khách hàng].[Hạng]',
    '[Tags].FILTER(CurrentValue != "Nội bộ").ARRAYJOIN(", ")',
    'WORKDAY([Ngày nhận], 3)',
    'LET(rows, [Tickets].FILTER(CurrentValue.[Hạn] > 1), rows.[Người phụ trách].COUNTA())',
    '[Sản phẩm].[Nhà cung cấp].[Quốc gia].[Tên]',
    '[a\\]b\\\\c "q"] & "x\\"y"',
    '-(1 + [Số tiền]) * [Chi phí] % 3',
  ];

  it.each(sources)('%s', (source) => {
    const { ast, stored: text } = toStoredFormula(source, inOrders);
    expect(renderNames(text, inOrders)).toBe(serialize(ast));
    expect(renderNames(text, inOrders)).toBe(serialize(parse(source)));
    expect(stored(renderNames(text, inOrders))).toBe(text);
  });
});
