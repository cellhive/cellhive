import { analyze, analyzeAst, lookupToAst, type SchemaSnapshot } from '@cellhive/formula-engine';
import { describe, expect, it } from 'vitest';

import {
  anyOf,
  conditionsOver,
  countOver,
  linkKeysOf,
  recomputeOrder,
  tableReferences,
} from '../../src/computed/recompute/index.js';

import type { GraphEdge } from '../../src/computed/graph/index.js';

/**
 * T458, pure parts of the incremental recompute: the update order of
 * stored computed fields, and how a formula selects records of a table it
 * reads as `[Table]` (conditions, link keys).
 */

const edge = (fieldId: string, dependsOnFieldId: string): GraphEdge => ({
  fieldId,
  dependsOnFieldId,
});

describe('recomputeOrder', () => {
  it.each([
    {
      name: 'independent fields: by table name, then id',
      nodes: [
        { id: 'b', tie: 't_2' },
        { id: 'a', tie: 't_2' },
        { id: 'c', tie: 't_1' },
      ],
      edges: [],
      order: ['c', 'a', 'b'],
    },
    {
      name: 'same table: by field position before id (deterministic, T460)',
      nodes: [
        { id: 'a', tie: 't_1', position: 3 },
        { id: 'z', tie: 't_1', position: 1 },
        { id: 'm', tie: 't_1', position: 2 },
      ],
      edges: [],
      order: ['z', 'm', 'a'],
    },
    {
      name: 'a reader after what it reads, whatever the table',
      nodes: [
        { id: 'lookup', tie: 't_1' },
        { id: 'formula', tie: 't_2' },
        { id: 'chain', tie: 't_0' },
      ],
      edges: [edge('lookup', 'formula'), edge('chain', 'lookup')],
      order: ['formula', 'lookup', 'chain'],
    },
    {
      name: 'edges to fields outside the list are ignored (plain fields, virtual ones)',
      nodes: [
        { id: 'x', tie: 't_1' },
        { id: 'y', tie: 't_1' },
      ],
      edges: [edge('x', 'amount'), edge('y', 'x'), edge('y', 'virtual')],
      order: ['x', 'y'],
    },
    {
      name: 'diamond: both branches before the join',
      nodes: [
        { id: 'd', tie: 't' },
        { id: 'b', tie: 't' },
        { id: 'c', tie: 't' },
        { id: 'a', tie: 't' },
      ],
      edges: [edge('b', 'a'), edge('c', 'a'), edge('d', 'b'), edge('d', 'c')],
      order: ['a', 'b', 'c', 'd'],
    },
    {
      name: 'a cycle left by a restore is broken, never loops',
      nodes: [
        { id: 'p', tie: 't' },
        { id: 'q', tie: 't' },
      ],
      edges: [edge('p', 'q'), edge('q', 'p')],
      order: ['p', 'q'],
    },
  ])('$name', ({ nodes, edges, order }) => {
    expect(recomputeOrder(nodes, edges)).toEqual(order);
  });
});

const snapshot: SchemaSnapshot = {
  tableId: 'tbl_c',
  tables: [
    {
      id: 'tbl_c',
      name: 'Customers',
      primaryFieldId: 'fld_name',
      fields: [
        { id: 'fld_name', name: 'Name', type: 'text', options: null },
        { id: 'fld_code', name: 'Code', type: 'text', options: null },
        { id: 'fld_n', name: 'N', type: 'number', options: null },
      ],
    },
    {
      id: 'tbl_o',
      name: 'Orders',
      primaryFieldId: 'fld_title',
      fields: [
        { id: 'fld_title', name: 'Title', type: 'text', options: null },
        { id: 'fld_amount', name: 'Amount', type: 'number', options: null },
        { id: 'fld_ocode', name: 'OCode', type: 'text', options: null },
        {
          id: 'fld_customer',
          name: 'Customer',
          type: 'link',
          options: { link_table: 'tbl_c' },
          linkTableId: 'tbl_c',
        },
        {
          id: 'fld_tags',
          name: 'Tags',
          type: 'select',
          options: { multiple: true, options: [{ id: 'opt_a', name: 'A' }] },
        },
      ],
    },
  ],
};

function astOf(expression: string) {
  const analysis = analyze(expression, snapshot, { form: 'display' });
  expect(analysis.errors).toEqual([]);
  if (analysis.ast === null) throw new Error('no AST');
  return analysis.ast;
}

const multiValue = (fieldId: string) => fieldId === 'fld_tags' || fieldId === 'fld_customer';

describe('conditionsOver', () => {
  it.each([
    {
      name: 'FILTER keyed on a link: a link key',
      formula: '[Orders].FILTER(CONTAIN(CurrentValue.[Customer], RECORD_ID())).[Amount].SUM()',
      conditions: 1,
      linkKeys: [['fld_customer']],
    },
    {
      name: 'FILTER keyed on a value: no link key',
      formula: '[Orders].FILTER(CurrentValue.[OCode] = [Code]).[Amount].SUM()',
      conditions: 1,
      linkKeys: [[]],
    },
    {
      name: 'a link key among other conjuncts',
      formula:
        '[Orders].FILTER(CurrentValue.[Amount] > 5 && CurrentValue.[Customer].CONTAIN(RECORD_ID())).[Amount].SUM()',
      conditions: 1,
      linkKeys: [['fld_customer']],
    },
    {
      name: 'a link key under OR is not a key',
      formula:
        '[Orders].FILTER(CurrentValue.[Amount] > 5 || CONTAIN(CurrentValue.[Customer], RECORD_ID())).[Amount].SUM()',
      conditions: 1,
      linkKeys: [[]],
    },
    {
      name: 'COUNTIF and SUMIF have conditions too',
      formula:
        'COUNTIF([Orders], CurrentValue.[OCode] = [Code]) + SUMIF([Orders], CurrentValue.[OCode] = [Code], CurrentValue.[Amount])',
      conditions: 2,
      linkKeys: [[], []],
    },
    {
      name: 'LOOKUP reads as a FILTER on its match field',
      formula: 'LOOKUP([Code], [Orders].[OCode], [Orders].[Amount]).SUM()',
      conditions: 1,
      linkKeys: [[]],
    },
  ])('$name', ({ formula, conditions, linkKeys }) => {
    const found = conditionsOver(astOf(formula), 'tbl_o', multiValue);
    expect(found).not.toBeNull();
    expect(found?.length).toBe(conditions);
    expect(found?.map((item) => item.linkKeys)).toEqual(linkKeys);
  });

  it.each([
    ['the whole table', '[Orders].[Amount].SUM()'],
    ['MAP over the table', '[Orders].MAP(CurrentValue.[Amount]).SUM()'],
    ['a LET variable', 'LET(t, [Orders], t.FILTER(CurrentValue.[OCode] = [Code]).[Amount].SUM())'],
  ])('reads the table otherwise (%s) → null (every row)', (_name, formula) => {
    expect(conditionsOver(astOf(formula), 'tbl_o', multiValue)).toBeNull();
  });

  it('another table than the one asked: no condition, not null', () => {
    expect(conditionsOver(astOf('[Orders].[Amount].SUM()'), 'tbl_c', multiValue)).toEqual([]);
  });

  it('lookup fields go through the same FILTER (lookupToAst)', () => {
    const ast = lookupToAst(
      {
        from: 'tbl_o',
        select: 'fld_amount',
        where: { field: 'fld_customer', operator: 'intersects', value: { field_ref: '__id' } },
        aggregate: 'sum',
      },
      snapshot,
    );
    expect(conditionsOver(ast, 'tbl_o', multiValue)?.map((item) => item.linkKeys)).toEqual([
      ['fld_customer'],
    ]);
  });

  it('a COUNTIF over the conditions typechecks on the formula table', () => {
    const found = conditionsOver(
      astOf(
        '[Orders].FILTER(CurrentValue.[OCode] = [Code]).[Amount].SUM() + COUNTIF([Orders], CurrentValue.[Amount] > [N])',
      ),
      'tbl_o',
      multiValue,
    );
    const condition = anyOf(found?.map((item) => item.condition) ?? []);
    if (condition === null) throw new Error('no condition');
    const checked = analyzeAst(countOver('tbl_o', condition), snapshot);
    expect(checked.errors).toEqual([]);
    expect(checked.result_type).toEqual({ kind: 'number' });
    expect(anyOf([])).toBeNull();
  });
});

describe('linkKeysOf and tableReferences', () => {
  it('equality with RECORD_ID() on either side names the field (links are checked later)', () => {
    const ast = astOf('[Orders].FILTER(RECORD_ID() = CurrentValue.[Title]).[Amount].SUM()');
    expect(tableReferences(ast)).toEqual(new Set(['tbl_o']));
    const [condition] = conditionsOver(ast, 'tbl_o', multiValue) ?? [];
    expect(condition?.linkKeys).toEqual(['fld_title']);
    expect(condition === undefined ? null : linkKeysOf(condition.condition)).toEqual(['fld_title']);
  });

  it('no table read: no reference', () => {
    expect(tableReferences(astOf('[N] * 2'))).toEqual(new Set());
  });
});
