import { describe, expect, it } from 'vitest';

import {
  checkArgument,
  equalityComparable,
  fieldStyle,
  fieldValueType,
  formatType,
  isFlatList,
  listOf,
  orderComparable,
  rowOf,
  rowsTable,
  singlesComparable,
  T,
  tableOf,
  unify,
  type FormulaType,
  type ParamKind,
  type SnapshotField,
} from '../src/index.js';

const f = (
  type: string | undefined,
  options?: Record<string, unknown>,
  extra: Partial<SnapshotField> = {},
): SnapshotField => ({
  id: 'fld_x000000000000000',
  name: 'x',
  ...(type === undefined ? {} : { type }),
  ...(options === undefined ? {} : { options }),
  ...extra,
});

describe('fieldValueType', () => {
  const cases: [string, SnapshotField, string][] = [
    ['text', f('text'), 'text'],
    ['auto_number', f('auto_number'), 'text'],
    ['number', f('number'), 'number'],
    ['checkbox', f('checkbox'), 'boolean'],
    ['select single', f('select', { multiple: false }), 'text'],
    ['select default', f('select'), 'text'],
    ['select multiple', f('select', { multiple: true }), 'list<text>'],
    ['datetime date-only', f('datetime', { style: { format: 'yyyy-MM-dd' } }), 'date'],
    ['datetime with time', f('datetime', { style: { format: 'yyyy-MM-dd HH:mm' } }), 'datetime'],
    ['datetime bad format', f('datetime', { style: { format: 'nope' } }), 'datetime'],
    ['datetime no style', f('datetime'), 'datetime'],
    ['created_at', f('created_at'), 'datetime'],
    ['updated_at', f('updated_at'), 'datetime'],
    ['user', f('user'), 'list<user>'],
    ['created_by', f('created_by'), 'list<user>'],
    ['updated_by', f('updated_by'), 'list<user>'],
    ['attachment', f('attachment'), 'list<attachment>'],
    ['link', f('link', {}, { linkTableId: 'tbl_a' }), 'list<row<tbl_a>>'],
    ['parent', f('parent', {}, { linkTableId: 'tbl_a' }), 'list<row<tbl_a>>'],
    ['formula', f('formula', {}, { resultType: { kind: 'number' } }), 'number'],
    ['lookup list', f('lookup', {}, { resultType: listOf(T.text) }), 'list<text>'],
    ['formula without result type', f('formula'), 'any'],
    ['unknown type', f('location'), 'any'],
    ['no type', f(undefined), 'any'],
  ];
  it.each(cases)('%s → %s', (_name, field, expected) => {
    expect(formatType(fieldValueType(field))).toBe(expected);
  });

  it('lends number and date styles only', () => {
    expect(fieldStyle(f('number', { style: { type: 'currency' } }))).toEqual({ type: 'currency' });
    expect(fieldStyle(f('datetime', { style: { format: 'yyyy-MM-dd' } }))).toEqual({
      format: 'yyyy-MM-dd',
    });
    expect(fieldStyle(f('text', { style: { type: 'url' } }))).toBeNull();
    expect(fieldStyle(f('number', { style: 'bad' }))).toBeNull();
    expect(fieldStyle(f('number'))).toBeNull();
  });
});

describe('unify', () => {
  const cases: [FormulaType, FormulaType, string | null][] = [
    [T.number, T.number, 'number'],
    [T.null, T.number, 'number'],
    [T.number, T.null, 'number'],
    [T.any, T.null, 'any'],
    [T.null, T.null, 'null'],
    [T.any, T.text, 'text'],
    [T.date, T.datetime, 'datetime'],
    [T.date, T.date, 'date'],
    [{ kind: 'text', recordIdOf: 'tbl_a' }, T.text, 'text'],
    [listOf(T.null), listOf(T.text), 'list<text>'],
    [listOf(T.text), listOf(T.number), null],
    [T.text, T.number, null],
    [rowOf('tbl_a'), rowOf('tbl_b'), null],
    [rowOf('tbl_a'), rowOf('tbl_a'), 'row<tbl_a>'],
    [tableOf('tbl_a'), tableOf('tbl_a'), 'table<tbl_a>'],
  ];
  it.each(cases)('%j ∪ %j', (a, b, expected) => {
    const result = unify(a, b);
    expect(result === null ? null : formatType(result)).toBe(expected);
  });

  it('keeps the record ID mark of the same table', () => {
    const id: FormulaType = { kind: 'text', recordIdOf: 'tbl_a' };
    expect(unify(id, id)).toEqual(id);
  });
});

describe('comparisons', () => {
  const cases: [string, FormulaType, FormulaType, boolean, boolean][] = [
    ['numbers', T.number, T.number, true, true],
    ['number/text', T.number, T.text, false, false],
    ['texts', T.text, T.text, true, true],
    ['booleans', T.boolean, T.boolean, true, false],
    ['date/datetime', T.date, T.datetime, true, true],
    ['user/text', T.user, T.text, true, false],
    ['text/user', T.text, T.user, true, false],
    ['row/text', rowOf('tbl_a'), T.text, true, false],
    ['rows of one table', rowOf('tbl_a'), rowOf('tbl_a'), true, false],
    ['rows of two tables', rowOf('tbl_a'), rowOf('tbl_b'), false, false],
    ['attachments', T.attachment, T.attachment, false, false],
    ['any', T.any, T.boolean, true, false],
    ['null/any', T.null, T.any, true, true],
    ['any/number', T.any, T.number, true, true],
    ['lists', listOf(T.text), listOf(T.text), true, false],
    ['list/text', listOf(T.text), T.text, false, false],
    ['tables', tableOf('tbl_a'), tableOf('tbl_a'), false, false],
  ];
  it.each(cases)('%s', (_name, a, b, equality, order) => {
    expect(equalityComparable(a, b)).toBe(equality);
    expect(orderComparable(a, b)).toBe(order);
  });

  it('never compares a list inside CONTAIN', () => {
    expect(singlesComparable(listOf(T.text), listOf(T.text))).toBe(false);
  });
});

describe('helpers', () => {
  it('rowsTable', () => {
    expect(rowsTable(tableOf('tbl_a'))).toBe('tbl_a');
    expect(rowsTable(rowOf('tbl_a'))).toBe('tbl_a');
    expect(rowsTable(listOf(rowOf('tbl_a')))).toBe('tbl_a');
    expect(rowsTable(listOf(T.text))).toBeNull();
  });

  it('isFlatList', () => {
    expect(isFlatList(listOf(T.text))).toBe(true);
    expect(isFlatList(listOf(listOf(T.text)))).toBe(false);
    expect(isFlatList(T.text)).toBe(false);
  });
});

describe('checkArgument', () => {
  const cases: [ParamKind, FormulaType, string | null][] = [
    ['number', T.null, null],
    ['number', T.any, null],
    ['number', rowOf('tbl_a'), 'TABLE_NEEDS_FIELD'],
    ['text', rowOf('tbl_a'), null],
    ['single', T.attachment, null],
    ['values', rowOf('tbl_a'), null],
    ['value', tableOf('tbl_a'), 'TABLE_NEEDS_FIELD'],
    ['value', listOf(listOf(T.text)), null],
    ['numbers', listOf(T.number), null],
    ['numbers', listOf(listOf(T.number)), 'NESTED_LIST'],
    ['dates', listOf(T.date), null],
    ['dates', T.datetime, null],
    ['dates', listOf(T.text), 'TYPE_MISMATCH'],
    ['list', tableOf('tbl_a'), 'TABLE_NEEDS_FIELD'],
    ['items', tableOf('tbl_a'), null],
    ['items', T.null, null],
    ['range', T.number, 'EXPECTED_LIST'],
    ['range', listOf(listOf(T.number)), 'NESTED_LIST'],
    ['rows', listOf(rowOf('tbl_a')), null],
    ['rows', listOf(T.text), 'TYPE_MISMATCH'],
    ['lists', listOf(listOf(T.text)), null],
    ['lists', tableOf('tbl_a'), 'TABLE_NEEDS_FIELD'],
    ['mapping', tableOf('tbl_a'), 'TABLE_NEEDS_FIELD'],
    ['number_list', T.number, 'EXPECTED_LIST'],
    ['condition', T.number, 'TYPE_MISMATCH'],
  ];
  it.each(cases)('%s ← %j', (kind, type, expected) => {
    expect(checkArgument(kind, type)?.code ?? null).toBe(expected);
  });
});
