import { describe, expect, it } from 'vitest';

import {
  analyze,
  conditionKeys,
  parse,
  resolveNames,
  toStoredFormula,
  type FormulaDependency,
  type SchemaSnapshot,
} from '../src/index.js';

import { customers, fld, orders, products, staff, tbl, tickets } from './typed-fixture.js';

const run = (source: string, snapshot: SchemaSnapshot = orders) =>
  analyze(source, snapshot, { form: 'display' });

const dep = (
  field_id: string,
  kind: FormulaDependency['kind'],
  link_path: string[] = [],
  condition_refs: string[] = [],
): FormulaDependency => ({ field_id, kind, link_path, condition_refs });

const sorted = (items: FormulaDependency[]) =>
  [...items].sort((a, b) =>
    `${a.field_id}${a.kind}${a.link_path.join()}`.localeCompare(
      `${b.field_id}${b.kind}${b.link_path.join()}`,
    ),
  );

describe('dependencies', () => {
  const cases: [string, string, SchemaSnapshot, FormulaDependency[], string[]][] = [
    [
      'same row',
      'IF([Trạng thái] = "Xong", [Số tiền] * 0.1, 0)',
      orders,
      [dep(fld.status, 'same_row'), dep(fld.amount, 'same_row')],
      [],
    ],
    [
      'through a link',
      '[Khách hàng].[Hạng]',
      orders,
      [dep(fld.customer, 'same_row'), dep(fld.tier, 'via_link', [fld.customer])],
      [tbl.customers],
    ],
    [
      'chain of 3 links',
      '[Sản phẩm].[Nhà cung cấp].[Quốc gia].[Tên]',
      orders,
      [
        dep(fld.product, 'same_row'),
        dep(fld.supplier, 'via_link', [fld.product]),
        dep(fld.country, 'via_link', [fld.product, fld.supplier]),
        dep(fld.countryName, 'via_link', [fld.product, fld.supplier, fld.country]),
      ],
      [tbl.products, tbl.suppliers, tbl.countries],
    ],
    [
      'chain of 3 links from products',
      '[Nhà cung cấp].[Quốc gia].[Châu lục].[Tên].ARRAYJOIN()',
      products,
      [
        dep(fld.supplier, 'same_row'),
        dep(fld.country, 'via_link', [fld.supplier]),
        dep(fld.continent, 'via_link', [fld.supplier, fld.country]),
        dep(fld.continentName, 'via_link', [fld.supplier, fld.country, fld.continent]),
      ],
      [tbl.suppliers, tbl.countries, tbl.continents],
    ],
    [
      'self-link',
      '[Quản lý].[Tên]',
      staff,
      [dep(fld.manager, 'same_row'), dep(fld.staffName, 'via_link', [fld.manager])],
      [tbl.staff],
    ],
    [
      'FILTER over a link',
      '[Các đơn].FILTER(CurrentValue.[Đã trả] && CurrentValue.[Số tiền] > [Khách từ].YEAR()).[Số tiền].SUM()',
      customers,
      [
        dep(fld.customerOrders, 'same_row'),
        dep(fld.paid, 'via_link', [fld.customerOrders]),
        dep(fld.amount, 'via_link', [fld.customerOrders]),
        dep(fld.customerSince, 'same_row'),
      ],
      [tbl.orders],
    ],
    [
      'cross table with a key (SPEC §9.2 example)',
      '[Đơn hàng].FILTER(CurrentValue.[Khách hàng].CONTAIN([Tên]) && CurrentValue.[Trạng thái] = "Đã giao").[Số tiền].SUM()',
      customers,
      [
        dep(fld.customer, 'cross_table', [], [fld.customerName]),
        dep(fld.customerName, 'same_row'),
        dep(fld.status, 'cross_table', [], [fld.customerName]),
        dep(fld.amount, 'cross_table', [], [fld.customerName]),
      ],
      // The link compares its records by title: Khách hàng is read too.
      [tbl.orders, tbl.customers],
    ],
    [
      'cross table with an equality key on either side',
      'COUNTIF([Tickets], [Nhân viên] = CurrentValue.[Người phụ trách] && CurrentValue.[Hạn] < TODAY())',
      customers,
      [
        dep(fld.employee, 'same_row'),
        dep(fld.assignee, 'cross_table', [], [fld.employee]),
        dep(fld.due, 'cross_table', [], [fld.employee]),
      ],
      [tbl.tickets],
    ],
    [
      'cross table without a key: whole table',
      '[Tickets].FILTER(CurrentValue.[Hạn] < TODAY() || CurrentValue.[Người phụ trách] = [Người tạo]).[Hạn].COUNTA()',
      orders,
      [
        dep(fld.due, 'cross_table'),
        dep(fld.assignee, 'cross_table'),
        dep(fld.createdBy, 'same_row'),
      ],
      [tbl.tickets],
    ],
    [
      'a column of another table: whole table',
      '[Tickets].[Hạn].MAX()',
      orders,
      [dep(fld.due, 'cross_table')],
      [tbl.tickets],
    ],
    [
      'a link of another table',
      '[Tickets].FILTER(CurrentValue.[Khách] = [Khách hàng]).[Khách].[Tên]',
      orders,
      [
        dep(fld.ticketCustomer, 'cross_table', [], [fld.customer]),
        dep(fld.customer, 'same_row'),
        dep(fld.customerName, 'cross_table', [fld.ticketCustomer], [fld.customer]),
      ],
      [tbl.tickets, tbl.customers],
    ],
    [
      'RECORD_ID as key',
      '[Tickets].FILTER(CONTAIN(CurrentValue.[Khách], RECORD_ID())).[Hạn].COUNTA()',
      customers,
      [
        dep(fld.ticketCustomer, 'cross_table', [], ['__id']),
        dep(fld.due, 'cross_table', [], ['__id']),
      ],
      [tbl.tickets, tbl.customers],
    ],
    [
      'LOOKUP keys on its value',
      'LOOKUP([Tiêu đề], [Nhà cung cấp].[Tên], [Nhà cung cấp].[Quốc gia]).COUNTA()',
      orders,
      [
        dep(fld.orderTitle, 'same_row'),
        dep(fld.supplierName, 'cross_table', [], [fld.orderTitle]),
        dep(fld.country, 'cross_table', [], [fld.orderTitle]),
      ],
      [tbl.suppliers, tbl.countries],
    ],
    [
      'LOOKUP of an expression: whole table',
      'LOOKUP(UPPER([Tiêu đề]), [Nhà cung cấp].[Tên], [Nhà cung cấp].[Tên])',
      orders,
      [dep(fld.orderTitle, 'same_row'), dep(fld.supplierName, 'cross_table')],
      [tbl.suppliers],
    ],
    [
      'the same column read with and without a condition: whole table',
      '[Tickets].[Hạn].COUNTA() + [Tickets].FILTER(CurrentValue.[Người phụ trách] = [Người tạo]).[Hạn].COUNTA()',
      orders,
      [
        dep(fld.due, 'cross_table'),
        dep(fld.assignee, 'cross_table', [], [fld.createdBy]),
        dep(fld.createdBy, 'same_row'),
      ],
      [tbl.tickets],
    ],
    [
      'a LET table read with and without a condition',
      'LET(t, [Tickets], t.FILTER(CurrentValue.[Người phụ trách] = [Người tạo]).[Hạn].COUNTA() + t.[Hạn].COUNTA())',
      orders,
      [
        dep(fld.assignee, 'cross_table', [], [fld.createdBy]),
        dep(fld.createdBy, 'same_row'),
        dep(fld.due, 'cross_table'),
      ],
      [tbl.tickets],
    ],
    [
      'chained conditions add their keys',
      '[Tickets].FILTER(CurrentValue.[Hạn] < TODAY()).FILTER(CurrentValue.[Người phụ trách] = [Người tạo]).[Hạn].COUNTA()',
      orders,
      [
        dep(fld.due, 'cross_table', [], [fld.createdBy]),
        dep(fld.assignee, 'cross_table', [], [fld.createdBy]),
        dep(fld.createdBy, 'same_row'),
      ],
      [tbl.tickets],
    ],
    [
      'LET keeps the records a variable stands for',
      'LET(t, [Tickets].FILTER(CurrentValue.[Người phụ trách] = [Người tạo]), t.[Hạn].COUNTA())',
      orders,
      [
        dep(fld.assignee, 'cross_table', [], [fld.createdBy]),
        dep(fld.createdBy, 'same_row'),
        dep(fld.due, 'cross_table', [], [fld.createdBy]),
      ],
      [tbl.tickets],
    ],
  ];

  it.each(cases)('%s', (_name, source, snapshot, expected, tables) => {
    const result = run(source, snapshot);
    expect(result.errors).toEqual([]);
    expect(sorted(result.dependencies)).toEqual(sorted(expected));
    expect(result.referenced_tables.sort()).toEqual([...tables].sort());
  });

  it('works on the stored form', () => {
    const { stored } = toStoredFormula('[Khách hàng].[Hạng]', orders);
    expect(analyze(stored, orders).dependencies).toEqual([
      dep(fld.customer, 'same_row'),
      dep(fld.tier, 'via_link', [fld.customer]),
    ]);
  });
});

describe('condition keys', () => {
  const keys = (condition: string, snapshot: SchemaSnapshot = customers) => {
    const ast = resolveNames(parse(`[Đơn hàng].FILTER(${condition}).[Số tiền]`), snapshot);
    if (ast.type !== 'member' || ast.object.type !== 'call') throw new Error('unexpected shape');
    const cond = ast.object.args[1];
    if (cond === undefined) throw new Error('no condition');
    return [...conditionKeys(cond)].sort();
  };
  const cases: [string, string[]][] = [
    ['CurrentValue.[Tiêu đề] = [Tên]', [fld.customerName]],
    ['[Tên] = CurrentValue.[Tiêu đề]', [fld.customerName]],
    ['AND(CurrentValue.[Đã trả], CurrentValue.[Tiêu đề] = [Tên])', [fld.customerName]],
    ['CONTAIN(CurrentValue.[Khách hàng], RECORD_ID())', ['__id']],
    ['CONTAINSALL(CurrentValue.[Tags], [Hạng], [Tên])', [fld.customerName, fld.tier]],
    ['CONTAIN(CurrentValue.[Tags], [Hạng], "VIP")', []],
    ['CurrentValue.[Tiêu đề] = UPPER([Tên])', []],
    ['CurrentValue.[Tiêu đề] = [Tên] || TRUE', []],
    ['CurrentValue.[Tiêu đề] != [Tên]', []],
    ['CurrentValue.[Đã trả]', []],
  ];
  it.each(cases)('%s → %j', (condition, expected) => {
    expect(keys(condition)).toEqual(expected);
  });
});

describe('compute mode', () => {
  const cases: [string, string, 'stored' | 'virtual', unknown][] = [
    ['deterministic', '[Số tiền] * 2', 'stored', null],
    ['NOW', 'NOW() - [Hạn chót]', 'virtual', { kind: 'volatile_function', function: 'NOW' }],
    [
      'TODAY inside FILTER',
      '[Tickets].FILTER(CurrentValue.[Hạn] < TODAY()).[Hạn].COUNTA()',
      'virtual',
      { kind: 'volatile_function', function: 'TODAY' },
    ],
    ['a stored formula field', '[VAT] + 1', 'stored', null],
    [
      'a virtual formula field',
      '[Tuổi đơn] + 1',
      'virtual',
      { kind: 'virtual_dependency', field_id: fld.ageVirtual },
    ],
    [
      'a virtual field through a link',
      '[Khách hàng].[Các đơn].[Tuổi đơn].SUM()',
      'virtual',
      { kind: 'virtual_dependency', field_id: fld.ageVirtual },
    ],
  ];
  it.each(cases)('%s', (_name, source, mode, reason) => {
    const result = run(source);
    expect(result.errors).toEqual([]);
    expect(result.compute_mode).toBe(mode);
    expect(result.virtual_reason).toEqual(reason);
  });

  it('a virtual field of another table', () => {
    const result = run('[Đơn hàng].[Tuổi đơn].MAX()', tickets);
    expect(result.compute_mode).toBe('virtual');
  });
});

describe('style hint', () => {
  const currency = { type: 'currency', precision: 0, currency_code: 'VND' };
  const cases: [string, unknown][] = [
    ['[Số tiền]', currency],
    ['[Số tiền] * 0.1', currency],
    ['0.1 * [Số tiền]', currency],
    ['-[Số tiền]', currency],
    ['IF([Đã trả], [Số tiền], 0)', currency],
    ['ROUND([Số tiền] / 3, 0)', currency],
    ['[Khách hàng].[Các đơn].[Số tiền].SUM()', currency],
    ['[Khách hàng].[Các đơn].[Số tiền].SUM() + [VAT]', currency],
    ['[Khách hàng].[Các đơn].[Số tiền]', currency],
    ['[Ngày nhận]', { format: 'dd/MM/yyyy' }],
    ['EDATE([Ngày nhận], 1)', { format: 'dd/MM/yyyy' }],
    ['COUNTA([Tags])', null],
    ['LEN([Tiêu đề])', null],
    ['[Số tiền] & ""', null],
    ['[Số tiền] > 0', null],
    ['SWITCH([Số tiền], 1, "a", "b")', null],
  ];
  it.each(cases)('%s', (source, style) => {
    expect(run(source).style).toEqual(style);
  });
});

describe('errors', () => {
  it('returns syntax errors without dependencies', () => {
    const result = run('[Số tiền] +');
    expect(result.ast).toBeNull();
    expect(result.result_type).toBeNull();
    expect(result.errors.map((error) => error.detail)).toEqual(['UNEXPECTED_END']);
    expect(result.dependencies).toEqual([]);
  });

  it('returns type errors with dependencies', () => {
    const result = run('[Số tiền] & [Tags]');
    expect(result.result_type).toBeNull();
    expect(result.errors.map((error) => error.detail)).toEqual(['LIST_AS_SCALAR']);
    expect(result.dependencies).toHaveLength(2);
  });

  it('counts LOOKUP toward the cross-table limit', () => {
    const lookups = Array.from(
      { length: 6 },
      () => 'LOOKUP([Tiêu đề], [Nhà cung cấp].[Tên], [Nhà cung cấp].[Tên]).COUNTA()',
    );
    const result = run(lookups.join(' + '));
    expect(result.errors.map((error) => [error.code, error.detail, error.params['limit']])).toEqual(
      [['FORMULA_LIMIT_EXCEEDED', 'MAX_CROSS_TABLE_FILTERS', 5]],
    );
  });

  it('rethrows what is not a formula error', () => {
    const broken = { tableId: tbl.orders, tables: null } as unknown as SchemaSnapshot;
    expect(() => analyze('1', broken)).toThrow(TypeError);
  });
});
