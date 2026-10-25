import { describe, expect, it } from 'vitest';

import { analyze, type FormulaDependency, type SchemaSnapshot } from '../src/index.js';

import { fld, tbl, typedTables } from './typed-fixture.js';

/**
 * T456 additions to `analyze`: records read as text depend on the primary
 * field of their table (a rename of a customer changes a formula comparing
 * `[Khách hàng]` with a text), and the `perf_warning` of virtual formulas
 * scanning another table (BACKLOG S4b open question #11).
 */

/** The typed fixture with the primary field of every table (the first field). */
const withPrimaries: SchemaSnapshot['tables'] = typedTables.map((table) => ({
  ...table,
  primaryFieldId: table.fields[0]?.id ?? null,
}));

const snapshot = (tableId: string): SchemaSnapshot => ({ tableId, tables: withPrimaries });
const run = (source: string, tableId: string = tbl.orders) =>
  analyze(source, snapshot(tableId), { form: 'display' });

const has = (deps: readonly FormulaDependency[], expected: Partial<FormulaDependency>) =>
  deps.some((dep) =>
    Object.entries(expected).every(([key, value]) => {
      const actual = (dep as unknown as Record<string, unknown>)[key];
      return JSON.stringify(actual) === JSON.stringify(value);
    }),
  );

const primaryOf = (tableId: string): string => {
  const table = withPrimaries.find((item) => item.id === tableId);
  if (table?.primaryFieldId == null) throw new Error(`no primary of ${tableId}`);
  return table.primaryFieldId;
};

describe('title dependencies (records read as text)', () => {
  const cases: [string, string, string, Partial<FormulaDependency>][] = [
    [
      'a link cell compared with a text',
      'IF([Khách hàng].FIRST() = "An", 1, 0)',
      tbl.orders,
      { field_id: primaryOf(tbl.customers), kind: 'via_link', link_path: [fld.customer] },
    ],
    [
      'a link cell joined with &',
      '"Khách: " & [Khách hàng].FIRST()',
      tbl.orders,
      { field_id: primaryOf(tbl.customers), kind: 'via_link', link_path: [fld.customer] },
    ],
    [
      'ARRAYJOIN of records',
      '[Khách hàng].ARRAYJOIN(", ")',
      tbl.orders,
      { field_id: primaryOf(tbl.customers), kind: 'via_link', link_path: [fld.customer] },
    ],
    [
      'CONTAIN of a text in a link cell of another table (SPEC §9.2 example)',
      '[Đơn hàng].FILTER(CurrentValue.[Khách hàng].CONTAIN([Tên])).[Số tiền].SUM()',
      tbl.customers,
      { field_id: primaryOf(tbl.customers), kind: 'cross_table', link_path: [fld.customer] },
    ],
  ];

  it.each(cases)('%s', (_name, source, tableId, expected) => {
    const result = run(source, tableId);
    expect(result.errors).toEqual([]);
    expect(has(result.dependencies, expected)).toBe(true);
  });

  it('records compared by id add no title dependency', () => {
    const result = run('[Khách hàng].FIRST() = [Khách hàng].LAST()');
    expect(result.errors).toEqual([]);
    expect(result.dependencies.map((dep) => dep.field_id)).not.toContain(primaryOf(tbl.customers));
  });

  it('counting or reading fields of records adds no title dependency', () => {
    const result = run('[Khách hàng].COUNTA() + [Khách hàng].[Hạng].COUNTA()');
    expect(result.errors).toEqual([]);
    expect(result.dependencies.map((dep) => dep.field_id)).not.toContain(primaryOf(tbl.customers));
  });

  it('without primaryFieldId in the snapshot nothing is added', () => {
    const plain = analyze(
      'IF([Khách hàng].FIRST() = "An", 1, 0)',
      { tableId: tbl.orders, tables: typedTables },
      {
        form: 'display',
      },
    );
    expect(plain.errors).toEqual([]);
    expect(plain.dependencies.map((dep) => dep.field_id)).toEqual([fld.customer]);
  });
});

describe('perf_warning (BACKLOG S4b #11)', () => {
  it('stored cross-table formulas without a link: stored, no warning', () => {
    const result = run(
      '[Tickets].FILTER(CurrentValue.[Hạn] = [Ngày nhận]).[Hạn].COUNTA()',
      tbl.orders,
    );
    expect(result.errors).toEqual([]);
    expect(result.compute_mode).toBe('stored');
    expect(result.perf_warning).toBeNull();
  });

  it('virtual (TODAY) cross-table filter on plain fields: cross_table_scan', () => {
    const result = run(
      '[Tickets].FILTER(CurrentValue.[Hạn] < TODAY() && CurrentValue.[Người phụ trách] = [Người tạo]).[Hạn].COUNTA()',
      tbl.orders,
    );
    expect(result.errors).toEqual([]);
    expect(result.compute_mode).toBe('virtual');
    expect(result.perf_warning).toBe('cross_table_scan');
  });

  it('virtual cross-table filter through a link field: no warning', () => {
    const result = run(
      '[Đơn hàng].FILTER(CurrentValue.[Khách hàng].CONTAIN([Tên]) && CurrentValue.[Ngày nhận] < TODAY()).[Số tiền].SUM()',
      tbl.customers,
    );
    expect(result.errors).toEqual([]);
    expect(result.compute_mode).toBe('virtual');
    expect(result.perf_warning).toBeNull();
  });

  it('virtual same-row formula: no warning', () => {
    const result = run('TODAY() - [Ngày nhận]');
    expect(result.compute_mode).toBe('virtual');
    expect(result.perf_warning).toBeNull();
  });
});
