import { describe, expect, it } from 'vitest';

import {
  createEvaluator,
  evaluate,
  FilterEvaluationError,
  negatedOperator,
  resolveVariables,
  type DslOperator,
  type EvaluateContext,
  type FilterNode,
  type ResolvedFilterNode,
  type ResolvedValue,
} from '../src/index.js';

import { fld, opt, rec, table, usr } from './fixture.js';

const ctx: EvaluateContext = { table };

const cond = (field: string, operator: DslOperator, value?: ResolvedValue): ResolvedFilterNode =>
  (value === undefined ? { field, operator } : { field, operator, value }) as ResolvedFilterNode;

const range = (start: string, end: string, startDate: string, endDate: string) => ({
  $range: { start, end, start_date: startDate, end_date: endDate },
});

/** 2026-09-23 in Asia/Ho_Chi_Minh. */
const SEP23 = range(
  '2026-09-22T17:00:00.000Z',
  '2026-09-23T17:00:00.000Z',
  '2026-09-23',
  '2026-09-24',
);
const SEP24 = range(
  '2026-09-23T17:00:00.000Z',
  '2026-09-24T17:00:00.000Z',
  '2026-09-24',
  '2026-09-25',
);

interface Row {
  readonly field: string;
  readonly operator: DslOperator;
  readonly value?: ResolvedValue;
  readonly cell: unknown;
  readonly expected: boolean;
}

const show = (value: unknown): string => {
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  if (typeof value === 'bigint') return `${value.toString()}n`;
  return value === undefined ? 'undefined' : JSON.stringify(value);
};

const table_ = (rows: Row[]) =>
  rows.map((row) => ({ ...row, name: `${row.operator} ${show(row.value)} on ${show(row.cell)}` }));

describe('evaluate: text (unaccented, case-insensitive)', () => {
  it.each(
    table_([
      {
        field: fld.title,
        operator: 'eq',
        value: 'nguyen van an',
        cell: 'Nguyễn Văn An',
        expected: true,
      },
      { field: fld.title, operator: 'eq', value: 'NGUYỄN', cell: 'Nguyễn Văn An', expected: false },
      { field: fld.title, operator: 'eq', value: 'dao', cell: 'Đào', expected: true },
      { field: fld.title, operator: 'eq', value: 'x', cell: null, expected: false },
      { field: fld.title, operator: 'eq', value: 'x', cell: '', expected: false },
      { field: fld.title, operator: 'neq', value: 'x', cell: null, expected: true },
      { field: fld.title, operator: 'neq', value: 'x', cell: '', expected: true },
      { field: fld.title, operator: 'neq', value: 'X', cell: 'x', expected: false },
      {
        field: fld.title,
        operator: 'contains',
        value: 'VAN',
        cell: 'Nguyễn Văn An',
        expected: true,
      },
      { field: fld.title, operator: 'contains', value: '%', cell: '100%', expected: true },
      { field: fld.title, operator: 'contains', value: '%', cell: '100', expected: false },
      { field: fld.title, operator: 'contains', value: '_', cell: 'a_b', expected: true },
      { field: fld.title, operator: 'contains', value: '_', cell: 'ab', expected: false },
      { field: fld.title, operator: 'contains', value: '%', cell: '％', expected: true },
      { field: fld.title, operator: 'contains', value: 'cafe', cell: 'Cafe\u0301', expected: true },
      { field: fld.title, operator: 'contains', value: 'x', cell: null, expected: false },
      { field: fld.title, operator: 'not_contains', value: 'x', cell: null, expected: true },
      { field: fld.title, operator: 'not_contains', value: 'an', cell: 'Ân', expected: false },
      {
        field: fld.title,
        operator: 'starts_with',
        value: 'đặng',
        cell: 'Dang Thi',
        expected: true,
      },
      {
        field: fld.title,
        operator: 'starts_with',
        value: 'thi',
        cell: 'Dang Thi',
        expected: false,
      },
      { field: fld.title, operator: 'ends_with', value: 'THI', cell: 'Dang Thị', expected: true },
      { field: fld.title, operator: 'ends_with', value: 'x', cell: '', expected: false },
      { field: fld.title, operator: 'is_empty', cell: null, expected: true },
      { field: fld.title, operator: 'is_empty', cell: '', expected: true },
      { field: fld.title, operator: 'is_empty', cell: ' ', expected: false },
      { field: fld.title, operator: 'is_not_empty', cell: 'a', expected: true },
      { field: fld.code, operator: 'eq', value: 'no.001', cell: 'NO.001', expected: true },
      { field: fld.code, operator: 'eq', value: '12', cell: 12, expected: true },
      { field: fld.code, operator: 'eq', value: '12', cell: { not: 'text' }, expected: false },
    ]),
  )('$name', ({ field, operator, value, cell, expected }) => {
    expect(evaluate(cond(field, operator, value), { [field]: cell }, ctx)).toBe(expected);
  });
});

describe('evaluate: number (exact decimals)', () => {
  it.each(
    table_([
      { field: fld.amount, operator: 'eq', value: 0.3, cell: '0.30', expected: true },
      { field: fld.amount, operator: 'eq', value: 0.1 + 0.2, cell: '0.3', expected: false },
      { field: fld.amount, operator: 'eq', value: 0.3, cell: 0.1 + 0.2, expected: false },
      {
        field: fld.amount,
        operator: 'gt',
        value: 1,
        cell: '1.00000000000000000001',
        expected: true,
      },
      { field: fld.amount, operator: 'gte', value: 1, cell: '1', expected: true },
      {
        field: fld.amount,
        operator: 'lt',
        value: 0,
        cell: '-0.00000000000000000001',
        expected: true,
      },
      { field: fld.amount, operator: 'lte', value: -1, cell: '-1.5', expected: true },
      {
        field: fld.amount,
        operator: 'lt',
        value: 1e21,
        cell: '999999999999999999999',
        expected: true,
      },
      { field: fld.amount, operator: 'gt', value: 1e-7, cell: '0.0000001', expected: false },
      { field: fld.amount, operator: 'gt', value: 5, cell: 'Infinity', expected: true },
      { field: fld.amount, operator: 'gt', value: 5, cell: '-Infinity', expected: false },
      { field: fld.amount, operator: 'gt', value: 5, cell: 'NaN', expected: true },
      { field: fld.amount, operator: 'eq', value: 5, cell: 'not a number', expected: false },
      { field: fld.amount, operator: 'eq', value: 0, cell: '-0.000', expected: true },
      { field: fld.amount, operator: 'neq', value: 0, cell: null, expected: true },
      { field: fld.amount, operator: 'neq', value: 0, cell: 0, expected: false },
      { field: fld.amount, operator: 'eq', value: 12, cell: BigInt(12), expected: true },
      { field: fld.amount, operator: 'between', value: [1, 2], cell: '1.5', expected: true },
      { field: fld.amount, operator: 'between', value: [1, 2], cell: '2', expected: true },
      { field: fld.amount, operator: 'between', value: [2, 1], cell: '1.5', expected: false },
      { field: fld.amount, operator: 'between', value: [1, 2], cell: null, expected: false },
      { field: fld.amount, operator: 'between', value: [1], cell: '1', expected: false },
      { field: fld.amount, operator: 'eq', value: null, cell: '1', expected: false },
      { field: fld.amount, operator: 'is_empty', cell: null, expected: true },
      { field: fld.amount, operator: 'is_empty', cell: '0', expected: false },
      { field: fld.amount, operator: 'is_not_empty', cell: 0, expected: true },
      { field: fld.total, operator: 'gt', value: 1, cell: 2, expected: true },
    ]),
  )('$name', ({ field, operator, value, cell, expected }) => {
    expect(evaluate(cond(field, operator, value), { [field]: cell }, ctx)).toBe(expected);
  });
});

describe('evaluate: datetime ranges', () => {
  it.each(
    table_([
      // Date-only field: compares start_date/end_date.
      { field: fld.due, operator: 'is', value: SEP23, cell: '2026-09-23', expected: true },
      { field: fld.due, operator: 'is', value: SEP23, cell: '2026-09-24', expected: false },
      { field: fld.due, operator: 'before', value: SEP23, cell: '2026-09-22', expected: true },
      { field: fld.due, operator: 'before', value: SEP23, cell: '2026-09-23', expected: false },
      { field: fld.due, operator: 'after', value: SEP23, cell: '2026-09-24', expected: true },
      {
        field: fld.due,
        operator: 'on_or_before',
        value: SEP23,
        cell: '2026-09-23',
        expected: true,
      },
      { field: fld.due, operator: 'on_or_after', value: SEP23, cell: '2026-09-23', expected: true },
      {
        field: fld.due,
        operator: 'on_or_after',
        value: SEP23,
        cell: '2026-09-22',
        expected: false,
      },
      {
        field: fld.due,
        operator: 'between',
        value: [SEP23, SEP24],
        cell: '2026-09-24',
        expected: true,
      },
      {
        field: fld.due,
        operator: 'between',
        value: [SEP24, SEP23],
        cell: '2026-09-23',
        expected: false,
      },
      {
        field: fld.due,
        operator: 'between',
        value: [SEP23, 'x'],
        cell: '2026-09-23',
        expected: false,
      },
      { field: fld.due, operator: 'between', value: SEP23, cell: '2026-09-23', expected: false },
      {
        field: fld.due,
        operator: 'is',
        value: SEP23,
        cell: new Date('2026-09-23T00:00:00Z'),
        expected: true,
      },
      { field: fld.due, operator: 'is', value: SEP23, cell: 'garbage', expected: false },
      { field: fld.due, operator: 'is', value: '2026-09-23', cell: '2026-09-23', expected: false },
      { field: fld.due, operator: 'is_empty', cell: null, expected: true },
      { field: fld.due, operator: 'is_not_empty', cell: '2026-09-23', expected: true },
      // Timestamp field: compares start/end instants.
      {
        field: fld.dueAt,
        operator: 'is',
        value: SEP23,
        cell: new Date('2026-09-22T17:00:00.000Z'),
        expected: true,
      },
      {
        field: fld.dueAt,
        operator: 'is',
        value: SEP23,
        cell: new Date('2026-09-22T16:59:59.999Z'),
        expected: false,
      },
      {
        field: fld.dueAt,
        operator: 'is',
        value: SEP23,
        cell: '2026-09-23T16:59:59.999999Z',
        expected: true,
      },
      {
        field: fld.dueAt,
        operator: 'is',
        value: SEP23,
        cell: '2026-09-23 23:59:59.999+07',
        expected: true,
      },
      {
        field: fld.dueAt,
        operator: 'is',
        value: SEP23,
        cell: '2026-09-23T00:00+07:00',
        expected: true,
      },
      {
        field: fld.dueAt,
        operator: 'is',
        value: SEP23,
        cell: '2026-09-22T12:59:59-04:00',
        expected: false,
      },
      {
        field: fld.dueAt,
        operator: 'is',
        value: SEP23,
        cell: '2026-09-22T13:00:00-0400',
        expected: true,
      },
      {
        field: fld.dueAt,
        operator: 'is',
        value: SEP23,
        cell: Date.parse('2026-09-23T00:00:00Z') + 0.5,
        expected: true,
      },
      { field: fld.dueAt, operator: 'is', value: SEP23, cell: Number.NaN, expected: false },
      {
        field: fld.dueAt,
        operator: 'is',
        value: SEP23,
        cell: new Date(Number.NaN),
        expected: false,
      },
      { field: fld.dueAt, operator: 'is', value: SEP23, cell: 'not a date', expected: false },
      {
        field: fld.dueAt,
        operator: 'after',
        value: SEP23,
        cell: '2026-09-23T17:00:00Z',
        expected: true,
      },
      {
        field: fld.dueAt,
        operator: 'on_or_before',
        value: SEP23,
        cell: '2026-09-23T16:00:00Z',
        expected: true,
      },
      {
        field: fld.created,
        operator: 'before',
        value: SEP23,
        cell: new Date('2026-01-01T00:00:00Z'),
        expected: true,
      },
      { field: fld.created, operator: 'is_empty', cell: true, expected: true },
    ]),
  )('$name', ({ field, operator, value, cell, expected }) => {
    expect(evaluate(cond(field, operator, value), { [field]: cell }, ctx)).toBe(expected);
  });
});

describe('evaluate: checkbox, select, user', () => {
  it.each(
    table_([
      { field: fld.done, operator: 'is', value: true, cell: true, expected: true },
      { field: fld.done, operator: 'is', value: false, cell: null, expected: true },
      { field: fld.done, operator: 'is', value: false, cell: true, expected: false },
      { field: fld.done, operator: 'is', value: 'true', cell: true, expected: false },
      { field: fld.status, operator: 'is', value: opt.done, cell: [opt.done], expected: true },
      { field: fld.status, operator: 'is', value: opt.done, cell: null, expected: false },
      { field: fld.status, operator: 'is', value: [opt.done], cell: [opt.done], expected: false },
      { field: fld.status, operator: 'is_not', value: opt.done, cell: null, expected: true },
      { field: fld.status, operator: 'is_not', value: opt.done, cell: [opt.new], expected: true },
      {
        field: fld.status,
        operator: 'is_any_of',
        value: [opt.new, opt.done],
        cell: [opt.new],
        expected: true,
      },
      { field: fld.status, operator: 'is_any_of', value: [], cell: [opt.new], expected: false },
      { field: fld.status, operator: 'is_none_of', value: [opt.new], cell: [], expected: true },
      { field: fld.status, operator: 'is_empty', cell: [], expected: true },
      { field: fld.status, operator: 'is_not_empty', cell: [opt.new], expected: true },
      {
        field: fld.tags,
        operator: 'has_any_of',
        value: [opt.a],
        cell: [opt.a, opt.b],
        expected: true,
      },
      { field: fld.tags, operator: 'has_any_of', value: [], cell: [opt.a], expected: false },
      { field: fld.tags, operator: 'has_any_of', value: null, cell: [opt.a], expected: false },
      {
        field: fld.tags,
        operator: 'has_all_of',
        value: [opt.a, opt.b],
        cell: [opt.b, opt.a],
        expected: true,
      },
      {
        field: fld.tags,
        operator: 'has_all_of',
        value: [opt.a, opt.b],
        cell: [opt.a],
        expected: false,
      },
      { field: fld.tags, operator: 'has_all_of', value: [], cell: [opt.a], expected: false },
      { field: fld.tags, operator: 'has_none_of', value: [], cell: null, expected: true },
      { field: fld.tags, operator: 'has_none_of', value: [opt.a], cell: [opt.a], expected: false },
      {
        field: fld.tags,
        operator: 'is_exactly',
        value: [opt.a, opt.b],
        cell: [opt.b, opt.a, opt.a],
        expected: true,
      },
      {
        field: fld.tags,
        operator: 'is_exactly',
        value: [opt.a],
        cell: [opt.a, opt.b],
        expected: false,
      },
      {
        field: fld.tags,
        operator: 'is_exactly',
        value: [opt.a],
        cell: [opt.a, null],
        expected: false,
      },
      { field: fld.tags, operator: 'is_exactly', value: [], cell: [], expected: false },
      {
        field: fld.owner,
        operator: 'has_any_of',
        value: [usr.an],
        cell: [usr.binh, usr.an],
        expected: true,
      },
      { field: fld.owner, operator: 'is_empty', cell: null, expected: true },
      { field: fld.creator, operator: 'has_any_of', value: [usr.an], cell: usr.an, expected: true },
      {
        field: fld.creator,
        operator: 'has_all_of',
        value: [usr.an, usr.binh],
        cell: usr.an,
        expected: false,
      },
      {
        field: fld.creator,
        operator: 'is_exactly',
        value: [usr.an, usr.an],
        cell: usr.an,
        expected: true,
      },
      { field: fld.creator, operator: 'is_empty', cell: '', expected: true },
      { field: fld.creator, operator: 'has_none_of', value: [usr.an], cell: null, expected: true },
      { field: fld.files, operator: 'is_empty', cell: [], expected: true },
      { field: fld.files, operator: 'is_not_empty', cell: [{ id: 'att' }], expected: true },
      {
        field: fld.tagNames,
        operator: 'has_any_of',
        value: [opt.a],
        cell: [opt.a],
        expected: true,
      },
    ]),
  )('$name', ({ field, operator, value, cell, expected }) => {
    expect(evaluate(cond(field, operator, value), { [field]: cell }, ctx)).toBe(expected);
  });
});

describe('evaluate: groups and variables', () => {
  const record = { [fld.title]: 'Đào', [fld.amount]: '10', [fld.owner]: [usr.binh] };

  it.each([
    { name: 'empty and', node: { op: 'and', items: [] }, expected: true },
    { name: 'empty or', node: { op: 'or', items: [] }, expected: false },
    {
      name: 'and',
      node: { op: 'and', items: [cond(fld.title, 'eq', 'dao'), cond(fld.amount, 'gt', 5)] },
      expected: true,
    },
    {
      name: 'or',
      node: { op: 'or', items: [cond(fld.title, 'eq', 'x'), cond(fld.amount, 'gt', 50)] },
      expected: false,
    },
    { name: 'not', node: { op: 'not', item: cond(fld.title, 'eq', 'x') }, expected: true },
    {
      name: 'not of an empty-cell comparison',
      node: { op: 'not', item: cond(fld.code, 'eq', 'x') },
      expected: true,
    },
  ] as { name: string; node: ResolvedFilterNode; expected: boolean }[])(
    '$name',
    ({ node, expected }) => {
      expect(evaluate(node, record, ctx)).toBe(expected);
    },
  );

  it('evaluates resolved variables (current user, groups, today)', () => {
    const filter: FilterNode = {
      op: 'and',
      items: [
        { field: fld.owner, operator: 'has_any_of', value: [{ $var: 'current_user_groups' }] },
        { field: fld.due, operator: 'is', value: { $var: 'today' } },
      ],
    };
    const resolve = (userId: string | null, members: string[]) =>
      resolveVariables(filter, {
        userId,
        groupMemberUserIds: members,
        timeZone: 'Asia/Ho_Chi_Minh',
        now: new Date('2026-09-23T10:00:00Z'),
      });
    const row = { ...record, [fld.due]: '2026-09-23' };
    expect(evaluate(resolve(usr.an, [usr.an, usr.binh]), row, ctx)).toBe(true);
    expect(evaluate(resolve(usr.an, [usr.an]), row, ctx)).toBe(false);
    expect(evaluate(resolve(null, []), row, ctx)).toBe(false);
  });

  it('createEvaluator reuses one prepared filter', () => {
    const matches = createEvaluator(cond(fld.amount, 'gte', 10), ctx);
    expect([{ [fld.amount]: '9.99' }, { [fld.amount]: '10' }, {}].map(matches)).toEqual([
      false,
      true,
      false,
    ]);
  });

  it('negatedOperator pairs every negative operator with its positive', () => {
    expect(negatedOperator('neq')).toBe('eq');
    expect(negatedOperator('disjoint')).toBe('intersects');
    expect(negatedOperator('eq')).toBeNull();
  });
});

describe('evaluate: automation operators', () => {
  const after = {
    [fld.title]: 'Done',
    [fld.amount]: '1.50',
    [fld.due]: '2026-09-23',
    [fld.dueAt]: new Date('2026-09-23T01:00:00Z'),
    [fld.done]: true,
    [fld.status]: [opt.done],
    [fld.tags]: [opt.b, opt.a],
    [fld.files]: [{ id: 'a' }],
  };
  const before = {
    [fld.title]: 'Doing',
    [fld.amount]: 1.5,
    [fld.due]: '2026-09-23',
    [fld.dueAt]: '2026-09-23T01:00:00.000Z',
    [fld.done]: null,
    [fld.status]: [opt.new],
    [fld.tags]: [opt.a, opt.b],
    [fld.files]: [{ id: 'a' }],
  };

  it.each([
    { field: fld.title, changed: true },
    { field: fld.amount, changed: false },
    { field: fld.due, changed: false },
    { field: fld.dueAt, changed: false },
    { field: fld.done, changed: true },
    { field: fld.status, changed: true },
    { field: fld.tags, changed: false },
    { field: fld.files, changed: false },
    { field: fld.code, changed: false },
  ])('changed on $field → $changed', ({ field, changed }) => {
    expect(evaluate(cond(field, 'changed'), after, { table, before })).toBe(changed);
  });

  it('treats text emptiness alike and compares text exactly', () => {
    const node = cond(fld.title, 'changed');
    expect(evaluate(node, { [fld.title]: '' }, { table, before: { [fld.title]: null } })).toBe(
      false,
    );
    expect(evaluate(node, { [fld.title]: 'a' }, { table, before: { [fld.title]: 'A' } })).toBe(
      true,
    );
    expect(
      evaluate(cond(fld.amount, 'changed'), { [fld.amount]: '1' }, { table, before: {} }),
    ).toBe(true);
  });

  it('changed_to / changed_from use the field equality operator', () => {
    const context = { table, before };
    expect(evaluate(cond(fld.status, 'changed_to', opt.done), after, context)).toBe(true);
    expect(evaluate(cond(fld.status, 'changed_from', opt.new), after, context)).toBe(true);
    expect(evaluate(cond(fld.status, 'changed_from', opt.done), after, context)).toBe(false);
    expect(evaluate(cond(fld.title, 'changed_to', 'DONE'), after, context)).toBe(true);
    expect(evaluate(cond(fld.amount, 'changed_to', 1.5), after, context)).toBe(false);
    expect(evaluate(cond(fld.tags, 'changed_to', [opt.a, opt.b]), after, context)).toBe(false);
  });

  it('a created record (before = null) changed every non-empty field', () => {
    const context = { table, before: null };
    expect(evaluate(cond(fld.status, 'changed_to', opt.done), after, context)).toBe(true);
    expect(evaluate(cond(fld.status, 'changed_from', opt.done), after, context)).toBe(false);
    expect(evaluate(cond(fld.code, 'changed'), after, context)).toBe(false);
  });

  it('changedFieldIds (event diff) wins over comparing values', () => {
    const context = { table, before, changedFieldIds: [fld.amount] };
    expect(evaluate(cond(fld.amount, 'changed'), after, context)).toBe(true);
    expect(evaluate(cond(fld.title, 'changed'), after, context)).toBe(false);
  });

  it('throws without before or an event diff', () => {
    expect(() => evaluate(cond(fld.title, 'changed'), after, ctx)).toThrow(FilterEvaluationError);
  });

  it('throws when the field has no equality operator', () => {
    expect(() =>
      evaluate(cond(fld.files, 'changed_to', 'x'), after, { table, before: null }),
    ).toThrow(FilterEvaluationError);
  });
});

describe("evaluate: record ID in the current record's link (lookup)", () => {
  const refRecord = {
    __id: rec.r1,
    [fld.customer]: [{ id: 'rec_linked0000000001' }, 'rec_linked0000000002'],
  };
  it.each([
    ['is_any_of', 'rec_linked0000000001', true],
    ['is_any_of', 'rec_linked0000000002', true],
    ['is_any_of', 'rec_other00000000001', false],
    ['is_none_of', 'rec_other00000000001', true],
    ['is_none_of', 'rec_linked0000000002', false],
  ] as const)('%s %s → %s', (operator, id, expected) => {
    const node = {
      field: '__id',
      operator,
      value: { field_ref: fld.customer },
    } as unknown as ResolvedFilterNode;
    expect(evaluate(node, { __id: id }, { table, refRecord })).toBe(expected);
  });
});

describe('evaluate: lookup operators and field_ref', () => {
  const ref = (field: string) => ({ field_ref: field }) as ResolvedValue;
  const refRecord = {
    __id: rec.r1,
    [fld.title]: 'Đào',
    [fld.amount]: '10',
    [fld.due]: '2026-09-23',
    [fld.dueAt]: '2026-09-23T01:00:00Z',
    [fld.tags]: [opt.a, opt.b],
    [fld.status]: [opt.done],
    [fld.done]: true,
  };
  const context = { table, refRecord, timeZone: 'Asia/Ho_Chi_Minh' };

  it.each([
    {
      name: 'text eq ref',
      node: cond(fld.title, 'eq', ref(fld.title)),
      cell: 'dao',
      expected: true,
    },
    {
      name: 'text neq ref',
      node: cond(fld.title, 'neq', ref(fld.title)),
      cell: 'dao',
      expected: false,
    },
    {
      name: 'text eq empty ref',
      node: cond(fld.title, 'eq', ref(fld.code)),
      cell: 'x',
      expected: false,
    },
    {
      name: 'text neq empty ref',
      node: cond(fld.title, 'neq', ref(fld.code)),
      cell: 'x',
      expected: true,
    },
    {
      name: 'number gt ref',
      node: cond(fld.amount, 'gt', ref(fld.amount)),
      cell: '10.5',
      expected: true,
    },
    {
      name: 'date is date ref',
      node: cond(fld.due, 'is', ref(fld.due)),
      cell: '2026-09-23',
      expected: true,
    },
    {
      name: 'timestamp is date ref (zoned day)',
      node: cond(fld.dueAt, 'is', ref(fld.due)),
      cell: '2026-09-22T17:30:00Z',
      expected: true,
    },
    {
      name: 'timestamp is instant ref',
      node: cond(fld.dueAt, 'is', ref(fld.dueAt)),
      cell: '2026-09-23T01:00:00Z',
      expected: true,
    },
    {
      name: 'date on_or_before instant ref',
      node: cond(fld.due, 'on_or_before', ref(fld.dueAt)),
      cell: '2026-09-23',
      expected: true,
    },
    {
      name: 'timestamp after garbage ref',
      node: cond(fld.dueAt, 'after', ref(fld.title)),
      cell: '2026-09-23T01:00:00Z',
      expected: false,
    },
    {
      name: 'multi has_any_of ref',
      node: cond(fld.tags, 'has_any_of', ref(fld.tags)),
      cell: [opt.b],
      expected: true,
    },
    {
      name: 'multi is_exactly ref',
      node: cond(fld.tags, 'is_exactly', ref(fld.tags)),
      cell: [opt.b],
      expected: false,
    },
    {
      name: 'select is ref',
      node: cond(fld.status, 'is', ref(fld.status)),
      cell: [opt.done],
      expected: true,
    },
    {
      name: 'checkbox is ref',
      node: cond(fld.done, 'is', ref(fld.done)),
      cell: true,
      expected: true,
    },
    {
      name: 'link intersects __id',
      node: cond(fld.tagNames, 'intersects', ref('__id')),
      cell: [rec.r1, rec.r2],
      expected: true,
    },
    {
      name: 'text intersects list',
      node: cond(fld.title, 'intersects', ['x', 'ĐÀO']),
      cell: 'dao',
      expected: true,
    },
    {
      name: 'text disjoint list',
      node: cond(fld.title, 'disjoint', ['x']),
      cell: 'dao',
      expected: true,
    },
    {
      name: 'number intersects list',
      node: cond(fld.amount, 'intersects', [1, 2]),
      cell: '2.0',
      expected: true,
    },
    {
      name: 'date intersects ranges',
      node: cond(fld.due, 'intersects', [SEP24, SEP23]),
      cell: '2026-09-23',
      expected: true,
    },
    {
      name: 'multi disjoint',
      node: cond(fld.tags, 'disjoint', [opt.progress]),
      cell: [opt.a],
      expected: true,
    },
  ])('$name', ({ node, cell, expected }) => {
    const field = (node as { field: string }).field;
    expect(evaluate(node, { [field]: cell }, context)).toBe(expected);
  });

  it('a date-only ref in UTC by default', () => {
    const node = cond(fld.dueAt, 'is', ref(fld.due));
    expect(evaluate(node, { [fld.dueAt]: '2026-09-23T23:30:00Z' }, { table, refRecord })).toBe(
      true,
    );
  });

  it('throws without refRecord', () => {
    expect(() => evaluate(cond(fld.title, 'eq', ref(fld.title)), {}, ctx)).toThrow(
      FilterEvaluationError,
    );
  });
});

describe('evaluate: programming errors', () => {
  it.each([
    { name: 'unknown field', node: cond('fld_nope000000000000', 'eq', 'x') },
    { name: 'text operator gt', node: cond(fld.title, 'gt', 'x') },
    { name: 'number operator contains', node: cond(fld.amount, 'contains', 1) },
    { name: 'datetime operator eq', node: cond(fld.due, 'eq', SEP23) },
    { name: 'checkbox operator eq', node: cond(fld.done, 'eq', true) },
    { name: 'select operator contains', node: cond(fld.tags, 'contains', 'x') },
    { name: 'unsupported formula', node: cond(fld.broken, 'eq', 'x') },
  ])('$name throws FilterEvaluationError', ({ node }) => {
    const record = {
      [fld.title]: 'x',
      [fld.amount]: '1',
      [fld.due]: '2026-09-23',
      [fld.done]: true,
      [fld.tags]: ['x'],
      [fld.broken]: 'x',
    };
    expect(() => evaluate(node, record, ctx)).toThrow(FilterEvaluationError);
  });
});
