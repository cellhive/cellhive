import { describe, expect, it } from 'vitest';

import {
  analyzeAst,
  desugarLookup,
  FormulaError,
  formatType,
  LOOKUP_AGGREGATES,
  lookupToAst,
  parse,
  resolveNames,
  serialize,
  type Call,
  type LookupOptions,
  type LookupWhere,
} from '../src/index.js';

import { customers, fld, orders, STATUS_OPTIONS, tbl, TAG_OPTIONS } from './typed-fixture.js';

const viaLink: LookupWhere = {
  field: fld.customer,
  operator: 'intersects',
  value: { field_ref: '__id' },
};
const byCondition: LookupWhere = {
  field: fld.orderTitle,
  operator: 'eq',
  value: { field_ref: fld.customerName },
};

const display = (options: LookupOptions) => serialize(lookupToAst(options, customers), 'display');

describe('lookupToAst: every aggregate, with and without a link', () => {
  const expectedType: Record<string, string> = {
    raw_value: 'list<number>',
    unique: 'list<number>',
    sum: 'number',
    average: 'number',
    max: 'number',
    min: 'number',
    counta: 'number',
    unique_counta: 'number',
  };
  const suffix: Record<string, string> = {
    raw_value: '',
    unique: '.UNIQUE()',
    sum: '.SUM()',
    average: '.AVERAGE()',
    max: '.MAX()',
    min: '.MIN()',
    counta: '.COUNTA()',
    unique_counta: '.UNIQUE().COUNTA()',
  };
  const wheres: [string, LookupWhere, string, string[]][] = [
    ['through a link', viaLink, 'CONTAIN(CurrentValue.[Khách hàng], RECORD_ID())', ['__id']],
    [
      'by condition',
      byCondition,
      'LOWER(UNACCENT(CurrentValue.[Tiêu đề])) = LOWER(UNACCENT([Tên]))',
      [],
    ],
  ];
  const cases = LOOKUP_AGGREGATES.flatMap((aggregate) =>
    wheres.map(
      ([label, where, condition, refs]) => [aggregate, label, where, condition, refs] as const,
    ),
  );
  it.each(cases)('%s %s', (aggregate, _label, where, condition, refs) => {
    const options: LookupOptions = { from: tbl.orders, select: fld.amount, where, aggregate };
    expect(display(options)).toBe(
      `[Đơn hàng].FILTER(${condition}).[Số tiền]${suffix[aggregate] ?? ''}`,
    );
    const analysis = analyzeAst(lookupToAst(options, customers), customers);
    expect(analysis.errors).toEqual([]);
    expect(analysis.result_type === null ? null : formatType(analysis.result_type)).toBe(
      expectedType[aggregate],
    );
    expect(analysis.compute_mode).toBe('stored');
    expect(analysis.style).toEqual(
      aggregate === 'counta' || aggregate === 'unique_counta'
        ? null
        : { type: 'currency', precision: 0, currency_code: 'VND' },
    );
    const amount = analysis.dependencies.find((item) => item.field_id === fld.amount);
    expect(amount).toEqual({
      field_id: fld.amount,
      kind: 'cross_table',
      link_path: [],
      condition_refs: refs,
    });
  });

  it('defaults to raw_value', () => {
    expect(display({ from: tbl.orders, select: fld.amount, where: viaLink })).toBe(
      '[Đơn hàng].FILTER(CONTAIN(CurrentValue.[Khách hàng], RECORD_ID())).[Số tiền]',
    );
  });

  it('flattens a multi-value field', () => {
    const options: LookupOptions = {
      from: tbl.orders,
      select: fld.tags,
      where: viaLink,
      aggregate: 'unique',
    };
    expect(display(options)).toBe(
      '[Đơn hàng].FILTER(CONTAIN(CurrentValue.[Khách hàng], RECORD_ID())).[Tags].LISTCOMBINE().UNIQUE()',
    );
    const analysis = analyzeAst(lookupToAst(options, customers), customers);
    expect(analysis.result_type).toEqual({ kind: 'list', element: { kind: 'text' } });
  });

  it('takes linked records as they are', () => {
    const options: LookupOptions = {
      from: tbl.orders,
      select: fld.product,
      where: viaLink,
    };
    const analysis = analyzeAst(lookupToAst(options, customers), customers);
    expect(analysis.result_type).toEqual({
      kind: 'list',
      element: { kind: 'row', tableId: tbl.products },
    });
  });
});

describe('lookupToAst: conditions (Filter DSL semantics)', () => {
  const [opNew, opDone] = STATUS_OPTIONS;
  const [tagVip, tagInternal] = TAG_OPTIONS;
  const cv = (name: string) => `CurrentValue.[${name}]`;
  const not = (inner: string) => `NOT(IFERROR(${inner}, FALSE))`;
  const cases: [string, LookupWhere, string][] = [
    [
      'text eq',
      { field: fld.orderTitle, operator: 'eq', value: 'An' },
      `LOWER(UNACCENT(${cv('Tiêu đề')})) = LOWER(UNACCENT("An"))`,
    ],
    [
      'text neq',
      { field: fld.orderTitle, operator: 'neq', value: 'An' },
      not(`LOWER(UNACCENT(${cv('Tiêu đề')})) = LOWER(UNACCENT("An"))`),
    ],
    [
      'text contains',
      { field: fld.orderTitle, operator: 'contains', value: 'a' },
      `CONTAINTEXT(LOWER(UNACCENT(${cv('Tiêu đề')})), LOWER(UNACCENT("a")))`,
    ],
    [
      'text not_contains',
      { field: fld.orderTitle, operator: 'not_contains', value: 'a' },
      not(`CONTAINTEXT(LOWER(UNACCENT(${cv('Tiêu đề')})), LOWER(UNACCENT("a")))`),
    ],
    [
      'text starts_with',
      { field: fld.orderTitle, operator: 'starts_with', value: 'a' },
      `LEFT(LOWER(UNACCENT(${cv('Tiêu đề')})), LEN(LOWER(UNACCENT("a")))) = LOWER(UNACCENT("a"))`,
    ],
    [
      'text ends_with',
      { field: fld.orderTitle, operator: 'ends_with', value: 'a' },
      `RIGHT(LOWER(UNACCENT(${cv('Tiêu đề')})), LEN(LOWER(UNACCENT("a")))) = LOWER(UNACCENT("a"))`,
    ],
    [
      'text intersects',
      { field: fld.orderTitle, operator: 'intersects', value: ['a', 'b'] },
      `CONTAIN(${cv('Tiêu đề')}, "a", "b")`,
    ],
    ['is_empty', { field: fld.orderTitle, operator: 'is_empty' }, `ISBLANK(${cv('Tiêu đề')})`],
    [
      'is_not_empty',
      { field: fld.amount, operator: 'is_not_empty' },
      `NOT(ISBLANK(${cv('Số tiền')}))`,
    ],
    ['number gt', { field: fld.amount, operator: 'gt', value: 1000 }, `${cv('Số tiền')} > 1000`],
    [
      'number lte negative',
      { field: fld.amount, operator: 'lte', value: -2.5 },
      `${cv('Số tiền')} <= -2.5`,
    ],
    [
      'number eq tiny',
      { field: fld.amount, operator: 'eq', value: 1e-7 },
      `${cv('Số tiền')} = 0.0000001`,
    ],
    ['number neq', { field: fld.amount, operator: 'neq', value: 0 }, not(`${cv('Số tiền')} = 0`)],
    [
      'number between',
      { field: fld.amount, operator: 'between', value: [1, 2] },
      `${cv('Số tiền')} >= 1 && ${cv('Số tiền')} <= 2`,
    ],
    [
      'date field_ref',
      { field: fld.received, operator: 'on_or_after', value: { field_ref: fld.customerSince } },
      `${cv('Ngày nhận')} >= [Khách từ]`,
    ],
    [
      'date field_ref is',
      { field: fld.received, operator: 'is', value: { field_ref: fld.customerSince } },
      `${cv('Ngày nhận')} >= [Khách từ] && ${cv('Ngày nhận')} < [Khách từ] + 1`,
    ],
    ['checkbox', { field: fld.paid, operator: 'is', value: true }, `${cv('Đã trả')} = TRUE`],
    [
      'select is (option name)',
      { field: fld.status, operator: 'is', value: opDone?.id ?? '' },
      `${cv('Trạng thái')} = "Xong"`,
    ],
    [
      'select is_not',
      { field: fld.status, operator: 'is_not', value: opNew?.id ?? '' },
      not(`${cv('Trạng thái')} = "Mới"`),
    ],
    [
      'select is_any_of',
      { field: fld.status, operator: 'is_any_of', value: [opNew?.id ?? '', opDone?.id ?? ''] },
      `CONTAIN(${cv('Trạng thái')}, "Mới", "Xong")`,
    ],
    [
      'select is_none_of',
      { field: fld.status, operator: 'is_none_of', value: [opNew?.id ?? ''] },
      not(`CONTAIN(${cv('Trạng thái')}, "Mới")`),
    ],
    [
      'multi has_any_of',
      { field: fld.tags, operator: 'has_any_of', value: [tagVip?.id ?? ''] },
      `CONTAIN(${cv('Tags')}, "VIP")`,
    ],
    [
      'multi has_all_of',
      { field: fld.tags, operator: 'has_all_of', value: [tagVip?.id ?? '', tagInternal?.id ?? ''] },
      `CONTAINSALL(${cv('Tags')}, "VIP", "Nội bộ")`,
    ],
    [
      'multi is_exactly',
      { field: fld.tags, operator: 'is_exactly', value: [tagVip?.id ?? ''] },
      `CONTAINSALL(${cv('Tags')}, "VIP") && CONTAINSONLY(${cv('Tags')}, "VIP")`,
    ],
    [
      'multi has_none_of',
      { field: fld.tags, operator: 'has_none_of', value: [tagVip?.id ?? ''] },
      not(`CONTAIN(${cv('Tags')}, "VIP")`),
    ],
    ['multi has_any_of []', { field: fld.tags, operator: 'has_any_of', value: [] }, 'FALSE'],
    ['multi has_none_of []', { field: fld.tags, operator: 'has_none_of', value: [] }, 'TRUE'],
    ['multi has_all_of []', { field: fld.tags, operator: 'has_all_of', value: [] }, 'FALSE'],
    [
      'user ids',
      { field: fld.createdBy, operator: 'has_any_of', value: ['usr_1'] },
      `CONTAIN(${cv('Người tạo')}, "usr_1")`,
    ],
    [
      'link disjoint',
      { field: fld.customer, operator: 'disjoint', value: { field_ref: '__id' } },
      not(`CONTAIN(${cv('Khách hàng')}, RECORD_ID())`),
    ],
    [
      'date is exact',
      { field: fld.received, operator: 'is', value: { $date: { exact: '2026-09-28' } } },
      `${cv('Ngày nhận')} >= DATE(2026, 9, 28) && ${cv('Ngày nhận')} < DATE(2026, 9, 28) + 1`,
    ],
    [
      'datetime exact minute',
      { field: fld.deadline, operator: 'before', value: { $date: { exact: '2026-09-28T08:30' } } },
      `${cv('Hạn chót')} < TODATE("2026-09-28 08:30")`,
    ],
    [
      'datetime exact minute after',
      { field: fld.deadline, operator: 'after', value: { $date: { exact: '2026-09-28T08:30' } } },
      `${cv('Hạn chót')} >= TODATE("2026-09-28 08:30") + DURATION(0, 0, 1)`,
    ],
    [
      'date today',
      { field: fld.received, operator: 'on_or_after', value: { $date: { relative: 'today' } } },
      `${cv('Ngày nhận')} >= TODAY()`,
    ],
    [
      'date $var today',
      { field: fld.received, operator: 'on_or_before', value: { $var: 'today' } },
      `${cv('Ngày nhận')} < TODAY() + 1`,
    ],
    [
      'date $var now',
      { field: fld.deadline, operator: 'before', value: { $var: 'now' } },
      `${cv('Hạn chót')} < NOW()`,
    ],
    [
      'date tomorrow',
      { field: fld.received, operator: 'is', value: { $date: { relative: 'tomorrow' } } },
      `${cv('Ngày nhận')} >= TODAY() + 1 && ${cv('Ngày nhận')} < TODAY() + 1 + 1`,
    ],
    [
      'date yesterday',
      { field: fld.received, operator: 'before', value: { $date: { relative: 'yesterday' } } },
      `${cv('Ngày nhận')} < TODAY() - 1`,
    ],
    [
      'date days_ago',
      {
        field: fld.received,
        operator: 'after',
        value: { $date: { relative: 'days_ago', amount: 3 } },
      },
      `${cv('Ngày nhận')} >= TODAY() - 3 + 1`,
    ],
    [
      'date days_from_now',
      {
        field: fld.received,
        operator: 'before',
        value: { $date: { relative: 'days_from_now', amount: 3 } },
      },
      `${cv('Ngày nhận')} < TODAY() + 3`,
    ],
    [
      'date this_week',
      { field: fld.received, operator: 'is', value: { $date: { relative: 'this_week' } } },
      `${cv('Ngày nhận')} >= TODAY() - (WEEKDAY(TODAY(), 2) - 1) && ${cv('Ngày nhận')} < TODAY() - (WEEKDAY(TODAY(), 2) - 1) + 7`,
    ],
    [
      'date this_month',
      { field: fld.received, operator: 'is', value: { $date: { relative: 'this_month' } } },
      `${cv('Ngày nhận')} >= EOMONTH(TODAY(), -1) + 1 && ${cv('Ngày nhận')} < EOMONTH(TODAY(), 0) + 1`,
    ],
    [
      'date last_month',
      { field: fld.received, operator: 'is', value: { $date: { relative: 'last_month' } } },
      `${cv('Ngày nhận')} >= EOMONTH(TODAY(), -2) + 1 && ${cv('Ngày nhận')} < EOMONTH(TODAY(), -1) + 1`,
    ],
    [
      'date this_year',
      { field: fld.received, operator: 'is', value: { $date: { relative: 'this_year' } } },
      `${cv('Ngày nhận')} >= DATE(YEAR(TODAY()), 1, 1) && ${cv('Ngày nhận')} < DATE(YEAR(TODAY()) + 1, 1, 1)`,
    ],
    [
      'date between',
      {
        field: fld.received,
        operator: 'between',
        value: [{ $date: { exact: '2026-01-01' } }, { $date: { exact: '2026-01-31' } }],
      },
      `${cv('Ngày nhận')} >= DATE(2026, 1, 1) && ${cv('Ngày nhận')} < DATE(2026, 1, 31) + 1`,
    ],
    [
      'date intersects',
      { field: fld.received, operator: 'intersects', value: [{ $date: { relative: 'today' } }] },
      `${cv('Ngày nhận')} >= TODAY() && ${cv('Ngày nhận')} < TODAY() + 1`,
    ],
    ['date disjoint []', { field: fld.received, operator: 'disjoint', value: [] }, not('FALSE')],
    [
      'and / or / not',
      {
        op: 'and',
        items: [
          viaLink,
          {
            op: 'or',
            items: [
              { field: fld.paid, operator: 'is', value: true },
              { field: fld.amount, operator: 'gt', value: 5 },
            ],
          },
          { op: 'not', item: { field: fld.orderTitle, operator: 'is_empty' } },
        ],
      },
      `CONTAIN(${cv('Khách hàng')}, RECORD_ID()) && (${cv('Đã trả')} = TRUE || ${cv('Số tiền')} > 5) && ${not(`ISBLANK(${cv('Tiêu đề')})`)}`,
    ],
  ];
  it.each(cases)('%s', (_name, where, condition) => {
    const options: LookupOptions = {
      from: tbl.orders,
      select: fld.amount,
      where,
      aggregate: 'sum',
    };
    expect(display(options)).toBe(`[Đơn hàng].FILTER(${condition}).[Số tiền].SUM()`);
    const analysis = analyzeAst(lookupToAst(options, customers), customers);
    expect(analysis.errors).toEqual([]);
    expect(analysis.result_type).toEqual({ kind: 'number' });
  });

  it('is virtual with a relative date', () => {
    const options: LookupOptions = {
      from: tbl.orders,
      select: fld.amount,
      where: { field: fld.received, operator: 'is', value: { $date: { relative: 'today' } } },
    };
    expect(analyzeAst(lookupToAst(options, customers), customers).compute_mode).toBe('virtual');
  });
});

describe('lookupToAst: invalid definitions', () => {
  const fails = (options: LookupOptions) => {
    try {
      lookupToAst(options, customers);
    } catch (error) {
      if (error instanceof FormulaError) return [error.detail, error.params['path']];
      throw error;
    }
    return null;
  };
  const cases: [string, LookupOptions, [string, string] | null][] = [
    [
      'unknown table',
      { from: 'tbl_nope000000000000', select: fld.amount, where: viaLink },
      ['UNKNOWN_TABLE', 'from'],
    ],
    [
      'unknown select',
      { from: tbl.orders, select: fld.tier, where: viaLink },
      ['UNKNOWN_FIELD', 'select'],
    ],
    [
      'unknown where field',
      { from: tbl.orders, select: fld.amount, where: { field: fld.tier, operator: 'is_empty' } },
      ['UNKNOWN_FIELD', 'where.field'],
    ],
    [
      'unknown field_ref',
      {
        from: tbl.orders,
        select: fld.amount,
        where: { field: fld.amount, operator: 'eq', value: { field_ref: fld.amount } },
      },
      ['UNKNOWN_FIELD', 'where.value'],
    ],
    [
      'empty group',
      { from: tbl.orders, select: fld.amount, where: { op: 'and', items: [] } },
      ['INVALID_LOOKUP', 'where'],
    ],
    [
      'operator for another type',
      {
        from: tbl.orders,
        select: fld.amount,
        where: { field: fld.amount, operator: 'contains', value: 'a' },
      },
      ['INVALID_LOOKUP', 'where.operator'],
    ],
    [
      'missing value',
      { from: tbl.orders, select: fld.amount, where: { field: fld.amount, operator: 'eq' } },
      ['INVALID_LOOKUP', 'where.value'],
    ],
    [
      'wrong value type',
      {
        from: tbl.orders,
        select: fld.amount,
        where: { field: fld.amount, operator: 'eq', value: 'x' },
      },
      ['INVALID_LOOKUP', 'where.value'],
    ],
    [
      'between with one value',
      {
        from: tbl.orders,
        select: fld.amount,
        where: { field: fld.amount, operator: 'between', value: [1] },
      },
      ['INVALID_LOOKUP', 'where.value'],
    ],
    [
      'unknown option',
      {
        from: tbl.orders,
        select: fld.amount,
        where: { field: fld.status, operator: 'is', value: 'opt_nope' },
      },
      ['INVALID_LOOKUP', 'where.value'],
    ],
    [
      'record ID constant on a link',
      {
        from: tbl.orders,
        select: fld.amount,
        where: { field: fld.customer, operator: 'has_any_of', value: ['rec_1'] },
      },
      ['INVALID_LOOKUP', 'where.value'],
    ],
    [
      'current_user',
      {
        from: tbl.orders,
        select: fld.amount,
        where: { field: fld.createdBy, operator: 'has_any_of', value: [{ $var: 'current_user' }] },
      },
      ['INVALID_LOOKUP', 'where.value'],
    ],
    [
      'date variable',
      {
        from: tbl.orders,
        select: fld.amount,
        where: { field: fld.received, operator: 'is', value: { $var: 'current_user' } },
      },
      ['INVALID_LOOKUP', 'where.value'],
    ],
    [
      'date not a date',
      {
        from: tbl.orders,
        select: fld.amount,
        where: { field: fld.received, operator: 'is', value: 3 },
      },
      ['INVALID_LOOKUP', 'where.value'],
    ],
    [
      'bad exact date',
      {
        from: tbl.orders,
        select: fld.amount,
        where: { field: fld.received, operator: 'is', value: { $date: { exact: '28/09/2026' } } },
      },
      ['INVALID_LOOKUP', 'where.value'],
    ],
    [
      'bad relative date',
      {
        from: tbl.orders,
        select: fld.amount,
        where: {
          field: fld.received,
          operator: 'is',
          value: { $date: { relative: 'next_decade' } },
        },
      },
      ['INVALID_LOOKUP', 'where.value'],
    ],
    [
      'date operator',
      {
        from: tbl.orders,
        select: fld.amount,
        where: { field: fld.received, operator: 'gt', value: { $var: 'today' } },
      },
      ['INVALID_LOOKUP', 'where.value'],
    ],
    [
      'between one date',
      {
        from: tbl.orders,
        select: fld.amount,
        where: { field: fld.received, operator: 'between', value: [{ $var: 'today' }] },
      },
      ['INVALID_LOOKUP', 'where.value'],
    ],
    [
      'date field_ref to a text',
      {
        from: tbl.orders,
        select: fld.amount,
        where: { field: fld.received, operator: 'is', value: { field_ref: fld.customerName } },
      },
      ['INVALID_LOOKUP', 'where.value'],
    ],
    [
      'date field_ref unknown',
      {
        from: tbl.orders,
        select: fld.amount,
        where: { field: fld.received, operator: 'is', value: { field_ref: fld.amount } },
      },
      ['UNKNOWN_FIELD', 'where.value'],
    ],
    [
      'number type error through field_ref',
      {
        from: tbl.orders,
        select: fld.amount,
        where: { field: fld.amount, operator: 'eq', value: { field_ref: fld.customerName } },
      },
      null,
    ],
    [
      'untyped field',
      { from: tbl.orders, select: fld.amount, where: { field: fld.untyped, operator: 'is_empty' } },
      ['INVALID_LOOKUP', 'where.field'],
    ],
    [
      'nested path',
      {
        from: tbl.orders,
        select: fld.amount,
        where: {
          op: 'or',
          items: [viaLink, { op: 'not', item: { field: fld.amount, operator: 'eq' } }],
        },
      },
      ['INVALID_LOOKUP', 'where.items.1.item.value'],
    ],
  ];
  it.each(cases)('%s', (_name, options, expected) => {
    expect(fails(options)).toEqual(expected);
  });

  it('needs the current table in the snapshot', () => {
    expect(() =>
      lookupToAst(
        { from: tbl.orders, select: fld.amount, where: viaLink },
        { ...customers, tableId: 'tbl_gone000000000000' },
      ),
    ).toThrow(FormulaError);
  });
});

describe('lookupToAst: records this record links to (__id, CONTRACTS §13)', () => {
  const linked: LookupWhere = {
    field: '__id',
    operator: 'is_any_of',
    value: { field_ref: fld.customerOrders },
  };
  const done: LookupWhere = { field: fld.status, operator: 'is', value: STATUS_OPTIONS[1]?.id };
  const analysed = (options: LookupOptions) =>
    analyzeAst(lookupToAst(options, customers), customers);

  it('alone: the linked records, a via_link dependency', () => {
    const options: LookupOptions = {
      from: tbl.orders,
      select: fld.amount,
      where: linked,
      aggregate: 'sum',
    };
    expect(display(options)).toBe('[Các đơn].[Số tiền].SUM()');
    const analysis = analysed(options);
    expect(analysis.errors).toEqual([]);
    expect(analysis.dependencies).toContainEqual({
      field_id: fld.amount,
      kind: 'via_link',
      link_path: [fld.customerOrders],
      condition_refs: [],
    });
    expect(analysis.style).toEqual({ type: 'currency', precision: 0, currency_code: 'VND' });
  });

  it('with other conditions of an and: they filter the linked records', () => {
    const options: LookupOptions = {
      from: tbl.orders,
      select: fld.amount,
      where: { op: 'and', items: [done, linked] },
      aggregate: 'sum',
    };
    expect(display(options)).toBe(
      '[Các đơn].FILTER(CurrentValue.[Trạng thái] = "Xong").[Số tiền].SUM()',
    );
    const analysis = analysed(options);
    expect(analysis.errors).toEqual([]);
    expect(analysis.dependencies.every((item) => item.kind !== 'cross_table')).toBe(true);
  });

  it.each([
    [
      'is_none_of',
      { field: '__id', operator: 'is_none_of', value: { field_ref: fld.customerOrders } },
      '[Đơn hàng].FILTER(NOT(IFERROR(CONTAIN([Các đơn], CurrentValue), FALSE))).[Tiêu đề]',
    ],
    [
      'inside an or',
      { op: 'or', items: [linked, done] },
      '[Đơn hàng].FILTER(CONTAIN([Các đơn], CurrentValue) || CurrentValue.[Trạng thái] = "Xong").[Tiêu đề]',
    ],
  ] as [string, LookupWhere, string][])(
    '%s: membership of each source record',
    (_name, where, text) => {
      const options: LookupOptions = { from: tbl.orders, select: fld.orderTitle, where };
      expect(display(options)).toBe(text);
      expect(analysed(options).errors).toEqual([]);
    },
  );

  it.each([
    [{ field: '__id', operator: 'eq', value: { field_ref: fld.customerOrders } }, 'where.operator'],
    [{ field: '__id', operator: 'is_any_of', value: { field_ref: '__id' } }, 'where.value'],
    [
      { field: '__id', operator: 'is_any_of', value: { field_ref: fld.tier } },
      'where.value.field_ref',
    ],
  ] as [LookupWhere, string][])('refuses %o at %s', (where, path) => {
    expect(() => lookupToAst({ from: tbl.orders, select: fld.amount, where }, customers)).toThrow(
      expect.objectContaining({ params: { path } }) as Error,
    );
  });
});

describe('desugarLookup (LOOKUP ≡ FILTER, BACKLOG S4b #6)', () => {
  const desugar = (source: string) => {
    const ast = resolveNames(parse(source), orders);
    const call = ast.type === 'call' ? ast : null;
    if (call === null) throw new Error('expected a call');
    const out = desugarLookup(call, orders);
    return out === null ? null : serialize(out, 'display');
  };
  const cases: [string, string | null][] = [
    [
      'LOOKUP([Tiêu đề], [Nhà cung cấp].[Tên], [Nhà cung cấp].[Quốc gia])',
      '[Nhà cung cấp].FILTER(CurrentValue.[Tên] = [Tiêu đề]).[Quốc gia]',
    ],
    [
      'LOOKUP("VIP", [Đơn hàng].[Tags], [Đơn hàng].[Số tiền])',
      '[Đơn hàng].FILTER(CONTAIN(CurrentValue.[Tags], "VIP")).[Số tiền]',
    ],
    [
      'LOOKUP([Tags], [Đơn hàng].[Tags], [Đơn hàng].[Số tiền], 0)',
      '[Đơn hàng].FILTER(CurrentValue.[Tags] = [Tags]).[Số tiền]',
    ],
    ['LOOKUP([Tiêu đề], [Nhà cung cấp].[Tên], [Tickets].[Hạn])', null],
    ['LOOKUP([Tiêu đề], [Nhà cung cấp].[Tên], [Nhà cung cấp].[Tên], 3)', null],
  ];
  it.each(cases)('%s', (source, expected) => {
    expect(desugar(source)).toBe(expected);
  });

  it('gives the same type as the LOOKUP', () => {
    const source = 'LOOKUP("VIP", [Đơn hàng].[Tags], [Đơn hàng].[Số tiền])';
    const sugar = resolveNames(parse(source), orders) as Call;
    const plain = desugarLookup(sugar, orders);
    expect(plain).not.toBeNull();
    if (plain === null) return;
    expect(analyzeAst(plain, orders).result_type).toEqual(analyzeAst(sugar, orders).result_type);
  });
});
