/**
 * Cross-table compiler without a database (BACKLOG T455): SQL shape
 * (placeholders only, qualified columns, the viewer-scope hook), refusals
 * and lookup errors. Values are checked on PostgreSQL by the int harness.
 */
import {
  analyze,
  FormulaError,
  type LookupOptions,
  type SchemaSnapshot,
} from '@cellhive/formula-engine';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';

import {
  compileCrossAnalysis,
  compileLookup,
  type CrossTableContext,
} from '../../../src/formula/cross/index.js';
import { snapshotTableOf, type CompiledFormula } from '../../../src/formula/index.js';
import { buildTableModel, type TableModel } from '../../../src/records/table-model.js';
import { kysely } from '../model.js';
import { PAYLOADS, literal } from '../payloads.js';

import type { FieldRow, TableRow } from '../../../src/db/schema.js';

const ORG = 'org_unit000000000000';
const CUSTOMERS = 'tbl_customers0000000';
const ORDERS = 'tbl_orders0000000000';

let position = 0;
function field(
  tableId: string,
  id: string,
  name: string,
  type: string,
  extra: Partial<Record<string, unknown>> = {},
): FieldRow {
  position += 1;
  return {
    id,
    organization_id: ORG,
    table_id: tableId,
    name,
    type,
    options: {},
    is_primary: false,
    db_column_name: type === 'link' ? null : `f_${id.slice(4, 16).toLowerCase()}`,
    position,
    link_junction: null,
    link_side: null,
    ...extra,
  } as unknown as FieldRow;
}

function table(id: string, name: string, dbName: string, rows: FieldRow[]): TableModel {
  const row = {
    id,
    organization_id: ORG,
    name,
    db_table_name: dbName,
    collation: 'und-x-icu',
  } as unknown as TableRow;
  return buildTableModel(row, rows, null);
}

const customerLink = {
  type: 'link',
  link_junction: 'l_custlink0000',
  options: {
    link_table: CUSTOMERS,
    bidirectional: true,
    symmetric_field_id: 'fld_myorders00000000',
  },
};
const orders = table(ORDERS, 'Orders', 't_orders000000', [
  field(ORDERS, 'fld_ref0000000000000', 'Ref', 'text', { is_primary: true }),
  field(ORDERS, 'fld_amount0000000000', 'Amount', 'number'),
  field(ORDERS, 'fld_tags000000000000', 'Tags', 'select', {
    options: { multiple: true, options: [{ id: 'opt_vip0000000000000', name: 'VIP' }] },
  }),
  field(ORDERS, 'fld_customer00000000', 'Customer', 'link', { ...customerLink, link_side: 'a' }),
]);
const customers = table(CUSTOMERS, 'Customers', 't_customers000', [
  field(CUSTOMERS, 'fld_name000000000000', 'Name', 'text', { is_primary: true }),
  field(CUSTOMERS, 'fld_myorders00000000', 'My orders', 'link', {
    ...customerLink,
    options: {
      link_table: ORDERS,
      bidirectional: true,
      symmetric_field_id: 'fld_customer00000000',
    },
    link_side: 'b',
  }),
]);
const MODELS = new Map([
  [ORDERS, orders],
  [CUSTOMERS, customers],
]);
const SNAPSHOT: SchemaSnapshot = {
  tableId: CUSTOMERS,
  tables: [snapshotTableOf(customers), snapshotTableOf(orders)],
};

function compile(formula: string, cross: Partial<CrossTableContext> = {}): CompiledFormula {
  const analysis = analyze(formula, SNAPSHOT, { form: 'display' });
  expect(analysis.errors).toEqual([]);
  return compileCrossAnalysis(
    analysis,
    { timeZone: 'Asia/Ho_Chi_Minh', tableAlias: 'r' },
    { self: customers, table: (id) => MODELS.get(id) ?? null, ...cross },
  );
}

const text = (compiled: CompiledFormula) => compiled.sql.compile(kysely);

describe('cross-table compiler', () => {
  it.each(PAYLOADS)('keeps the literal %s out of the SQL text', (payload) => {
    const query = text(
      compile(
        `[Orders].FILTER(CurrentValue.[Ref] = ${literal(payload)} || CurrentValue.[Customer].CONTAIN(${literal(payload)})).[Amount].SUM()`,
      ),
    );
    if (payload.length > 3) expect(query.sql).not.toContain(payload);
    expect(query.parameters).toContain(payload);
  });

  it('qualifies the formula row, so subqueries never capture its id or columns', () => {
    const query = text(
      compile('[Orders].FILTER(CurrentValue.[Customer].CONTAIN(RECORD_ID())).[Ref]'),
    );
    expect(query.sql).toContain('"r"."__id"');
    expect(query.sql).toContain('"data"."t_orders000000"');
    expect(query.sql).toContain('"data"."l_custlink0000"');
    expect(query.sql).not.toMatch(/[^.]"__id"/);
  });

  it('defaults the formula alias to the table name', () => {
    const analysis = analyze('[My orders].[Ref]', SNAPSHOT, { form: 'display' });
    const compiled = compileCrossAnalysis(
      analysis,
      { timeZone: 'UTC' },
      { self: customers, table: (id) => MODELS.get(id) ?? null },
    );
    expect(text(compiled).sql).toContain('"t_customers000"."__id"');
  });

  it('asks the viewer scope of every source table, never of the formula row', () => {
    const asked: string[] = [];
    const query = text(
      compile('[My orders].[Customer].[Name].COUNTA() + [Orders].[Ref].COUNTA()', {
        sourceScope: (tableId, alias) => {
          asked.push(tableId);
          return sql`${sql.id(alias, '__scope')} = ${'viewer'}`;
        },
      }),
    );
    expect(asked.sort()).toEqual([CUSTOMERS, ORDERS, ORDERS].sort());
    expect(query.sql.match(/"__scope"/g)).toHaveLength(3);
  });

  it('reads a table missing from the models (trash) as empty', () => {
    const query = text(
      compile('[Orders].[Amount].SUM()', {
        table: (id) => (id === ORDERS ? null : (MODELS.get(id) ?? null)),
      }),
    );
    expect(query.sql).not.toContain('t_orders');
  });

  it('refuses a list of lists outside LISTCOMBINE/COUNTA/ISBLANK', () => {
    expect(() => compile('COUNTA(IF(TRUE, [My orders].[Tags], LIST()))')).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_TYPE' }),
    );
    expect(() => compile('[My orders].[Tags].LISTCOMBINE().COUNTA()')).not.toThrow();
  });

  it('turns an empty lookup where into INVALID_LOOKUP (422 at the API)', () => {
    const options: LookupOptions = {
      from: ORDERS,
      select: 'fld_amount0000000000',
      where: { op: 'and', items: [] },
      aggregate: 'sum',
    };
    let error: unknown;
    try {
      compileLookup(
        options,
        SNAPSHOT,
        { timeZone: 'UTC' },
        { self: customers, table: (id) => MODELS.get(id) ?? null },
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(FormulaError);
    expect((error as FormulaError).detail).toBe('INVALID_LOOKUP');
  });
});
