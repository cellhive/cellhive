import { listOf, rowOf, T, type FormulaType } from '@cellhive/formula-engine';
import { describe, expect, it } from 'vitest';

import { publicResultType } from '../../src/computed/definition/definition.js';
import { formulaTypeOf } from '../../src/computed/definition/schema-rows.js';
import { dependentsInOrder, edgesOf, findCycle } from '../../src/computed/graph/index.js';
import { computedColumnType, expectedColumnOf } from '../../src/schema/physical.js';

const e = (fieldId: string, dependsOnFieldId: string) => ({ fieldId, dependsOnFieldId });

describe('findCycle (T456)', () => {
  const cases: [string, string, ReturnType<typeof e>[], string[], string[] | null][] = [
    ['no edge', 'a', [], ['a'], null],
    ['self reference', 'a', [e('a', 'a')], ['a'], ['a', 'a']],
    ['a → b → a', 'a', [e('a', 'b'), e('b', 'a')], ['a', 'b'], ['a', 'b', 'a']],
    [
      'a → b → c → a (through three tables)',
      'a',
      [e('a', 'b'), e('b', 'c'), e('c', 'a'), e('c', 'x')],
      ['a', 'b', 'c'],
      ['a', 'b', 'c', 'a'],
    ],
    [
      'shortest cycle wins',
      'a',
      [e('a', 'b'), e('b', 'c'), e('c', 'a'), e('b', 'a')],
      ['a', 'b', 'c'],
      ['a', 'b', 'a'],
    ],
    ['a chain without cycle', 'a', [e('a', 'b'), e('b', 'c')], ['a', 'b', 'c'], null],
    ['a cycle through a deleted field is ignored', 'a', [e('a', 'b'), e('b', 'a')], ['a'], null],
    [
      'a cycle not through start',
      'a',
      [e('a', 'b'), e('b', 'c'), e('c', 'b')],
      ['a', 'b', 'c'],
      null,
    ],
  ];
  it.each(cases)('%s', (_name, start, edges, active, expected) => {
    expect(findCycle(start, edges, new Set(active))).toEqual(expected);
  });
});

describe('dependentsInOrder (T456)', () => {
  it('lists start then its readers, each after what it reads', () => {
    // b and c read a; d reads b and c; x reads nothing of them.
    const edges = [e('b', 'a'), e('c', 'a'), e('d', 'b'), e('d', 'c'), e('x', 'y')];
    expect(dependentsInOrder('a', edges, new Set(['a', 'b', 'c', 'd', 'x']))).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });

  it('only follows active fields', () => {
    const edges = [e('b', 'a'), e('c', 'b')];
    expect(dependentsInOrder('a', edges, new Set(['a', 'c']))).toEqual(['a']);
  });

  it('terminates on a cycle left by a restore', () => {
    const edges = [e('b', 'a'), e('c', 'b'), e('b', 'c')];
    const order = dependentsInOrder('a', edges, new Set(['a', 'b', 'c']));
    expect(order[0]).toBe('a');
    expect([...order].sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('edgesOf (T456)', () => {
  it('groups dependencies by field with the closest kind and every path', () => {
    expect(
      edgesOf('fld_0000000000000001', [
        { field_id: 'fld_x', kind: 'via_link', link_path: ['fld_l'], condition_refs: [] },
        { field_id: 'fld_x', kind: 'same_row', link_path: [], condition_refs: [] },
        { field_id: 'fld_y', kind: 'cross_table', link_path: [], condition_refs: ['__id'] },
      ]),
    ).toEqual([
      {
        fieldId: 'fld_0000000000000001',
        dependsOnFieldId: 'fld_x',
        kind: 'same_row',
        paths: [
          { kind: 'via_link', link_path: ['fld_l'], condition_refs: [] },
          { kind: 'same_row', link_path: [], condition_refs: [] },
        ],
      },
      {
        fieldId: 'fld_0000000000000001',
        dependsOnFieldId: 'fld_y',
        kind: 'cross_table',
        paths: [{ kind: 'cross_table', link_path: [], condition_refs: ['__id'] }],
      },
    ]);
  });
});

describe('stored column types (BACKLOG S4b #5)', () => {
  const cases: [string, FormulaType, string, string][] = [
    ['text', T.text, 'text COLLATE "vi-VN-x-icu"', 'text'],
    ['number', T.number, 'numeric', 'numeric'],
    ['boolean', T.boolean, 'boolean', 'bool'],
    ['date', T.date, 'date', 'date'],
    ['datetime', T.datetime, 'timestamptz', 'timestamptz'],
    ['user', T.user, 'text', 'text'],
    ['a record', rowOf('tbl_0000000000000001'), 'text', 'text'],
    ['list of texts', listOf(T.text), 'text[]', '_text'],
    ['list of records', listOf(rowOf('tbl_0000000000000001')), 'text[]', '_text'],
    ['list of numbers', listOf(T.number), 'numeric[]', '_numeric'],
    ['list of dates', listOf(T.date), 'date[]', '_date'],
    ['list of datetimes', listOf(T.datetime), 'timestamptz[]', '_timestamptz'],
    ['list of booleans', listOf(T.boolean), 'boolean[]', '_bool'],
    ['list of attachments', listOf(T.attachment), 'jsonb', 'jsonb'],
  ];
  it.each(cases)('%s', (_name, type, pgType, udt) => {
    const column = computedColumnType(type, 'vi-VN-x-icu');
    expect(column).toBe(pgType);
    expect(expectedColumnOf(column).udtName).toBe(udt);
  });

  it('refuses a table or a list of lists', () => {
    expect(() => computedColumnType({ kind: 'table', tableId: 'tbl_x' }, 'und-x-icu')).toThrow();
    expect(() => computedColumnType(listOf(listOf(T.text)), 'und-x-icu')).toThrow();
  });
});

describe('result types (T456)', () => {
  it('round-trips through meta and maps to the public form', () => {
    for (const type of [T.number, listOf(rowOf('tbl_0000000000000001')), listOf(T.attachment)]) {
      expect(formulaTypeOf(JSON.parse(JSON.stringify(type)))).toEqual(type);
    }
    expect(formulaTypeOf({ kind: 'nope' })).toBeNull();
    expect(publicResultType(T.number)).toEqual({ kind: 'number', list: false });
    expect(publicResultType(listOf(rowOf('tbl_0000000000000001')))).toEqual({
      kind: 'record',
      list: true,
    });
    expect(publicResultType(listOf(T.null))).toEqual({ kind: 'null', list: true });
  });
});
