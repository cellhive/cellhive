import { describe, expect, it } from 'vitest';

import {
  FILTER_ISSUE_CODES,
  MAX_FILTER_CONDITIONS,
  validate,
  validateFilter,
  type FilterMode,
  type FilterNode,
} from '../src/index.js';

import { fixedId, fld, opt, rec, table, usr, visible } from './fixture.js';

const check = (input: unknown, mode: FilterMode = 'standard', refFieldIds?: string[]) =>
  validateFilter(
    input,
    table,
    visible,
    refFieldIds === undefined ? { mode } : { mode, refFieldIds },
  );

const issues = (input: unknown, mode: FilterMode = 'standard', refFieldIds?: string[]) => {
  const result = check(input, mode, refFieldIds);
  return result.ok ? [] : result.errors.map(({ path, code }) => ({ path, code }));
};

/** Wraps `levels` nested groups around one condition. */
const nest = (levels: number): unknown => {
  let node: unknown = { field: fld.title, operator: 'is_empty' };
  for (let level = 0; level < levels; level += 1) {
    node = level % 2 === 0 ? { op: 'and', items: [node] } : { op: 'not', item: node };
  }
  return node;
};

const cond = (field: string, operator: string, value?: unknown) =>
  value === undefined ? { field, operator } : { field, operator, value };

describe('validateFilter: accepted filters and normalisation', () => {
  const cases: { name: string; input: unknown; expected: FilterNode; mode?: FilterMode }[] = [
    // text
    {
      name: 'text eq',
      input: cond(fld.title, 'eq', 'POS'),
      expected: cond(fld.title, 'eq', 'POS') as FilterNode,
    },
    {
      name: 'auto_number starts_with',
      input: cond(fld.code, 'starts_with', 'TK-'),
      expected: cond(fld.code, 'starts_with', 'TK-') as FilterNode,
    },
    {
      name: 'text is_empty drops a null value',
      input: cond(fld.title, 'is_empty', null),
      expected: cond(fld.title, 'is_empty') as FilterNode,
    },
    // number
    {
      name: 'number gte',
      input: cond(fld.amount, 'gte', 0.5),
      expected: cond(fld.amount, 'gte', 0.5) as FilterNode,
    },
    {
      name: 'number between',
      input: cond(fld.amount, 'between', [1, 10]),
      expected: cond(fld.amount, 'between', [1, 10]) as FilterNode,
    },
    {
      name: 'formula uses its result type',
      input: cond(fld.total, 'lt', 3),
      expected: cond(fld.total, 'lt', 3) as FilterNode,
    },
    // datetime
    {
      name: 'datetime is today ($var)',
      input: cond(fld.due, 'is', { $var: 'today' }),
      expected: cond(fld.due, 'is', { $var: 'today' }) as FilterNode,
    },
    {
      name: 'datetime before now',
      input: cond(fld.dueAt, 'before', { $var: 'now' }),
      expected: cond(fld.dueAt, 'before', { $var: 'now' }) as FilterNode,
    },
    {
      name: 'datetime date string → $date.exact',
      input: cond(fld.due, 'on_or_after', '2026-09-25'),
      expected: cond(fld.due, 'on_or_after', { $date: { exact: '2026-09-25' } }) as FilterNode,
    },
    {
      name: 'datetime relative with amount',
      input: cond(fld.created, 'after', { $date: { relative: 'days_ago', amount: 7 } }),
      expected: cond(fld.created, 'after', {
        $date: { relative: 'days_ago', amount: 7 },
      }) as FilterNode,
    },
    {
      name: 'datetime between exact datetime and relative',
      input: cond(fld.dueAt, 'between', [
        '2026-09-25T09:30',
        { $date: { relative: 'this_month' } },
      ]),
      expected: cond(fld.dueAt, 'between', [
        { $date: { exact: '2026-09-25T09:30' } },
        { $date: { relative: 'this_month' } },
      ]) as FilterNode,
    },
    // checkbox
    {
      name: 'checkbox is false',
      input: cond(fld.done, 'is', false),
      expected: cond(fld.done, 'is', false) as FilterNode,
    },
    // single select
    {
      name: 'select is by name → id',
      input: cond(fld.status, 'is', 'Done'),
      expected: cond(fld.status, 'is', opt.done) as FilterNode,
    },
    {
      name: 'select is by id',
      input: cond(fld.status, 'is', opt.new),
      expected: cond(fld.status, 'is', opt.new) as FilterNode,
    },
    {
      name: 'select is_not one-element list',
      input: cond(fld.status, 'is_not', ['Mới']),
      expected: cond(fld.status, 'is_not', opt.new) as FilterNode,
    },
    {
      name: 'select is_any_of names, deduplicated',
      input: cond(fld.status, 'is_any_of', ['Mới', opt.new, 'Đang xử lý']),
      expected: cond(fld.status, 'is_any_of', [opt.new, opt.progress]) as FilterNode,
    },
    {
      name: 'select is_none_of scalar → list',
      input: cond(fld.status, 'is_none_of', 'Done'),
      expected: cond(fld.status, 'is_none_of', [opt.done]) as FilterNode,
    },
    // multi-value
    {
      name: 'multi select has_all_of',
      input: cond(fld.tags, 'has_all_of', ['A', 'B']),
      expected: cond(fld.tags, 'has_all_of', [opt.a, opt.b]) as FilterNode,
    },
    {
      name: 'user has_any_of current_user (SPEC §6.1 example)',
      input: cond(fld.owner, 'has_any_of', [{ $var: 'current_user' }]),
      expected: cond(fld.owner, 'has_any_of', [{ $var: 'current_user' }]) as FilterNode,
    },
    {
      name: 'user scalar variable and { id }',
      input: cond(fld.creator, 'has_none_of', { $var: 'current_user_groups' }),
      expected: cond(fld.creator, 'has_none_of', [{ $var: 'current_user_groups' }]) as FilterNode,
    },
    {
      name: 'user { id } objects',
      input: cond(fld.owner, 'is_exactly', [{ id: usr.an }, usr.binh]),
      expected: cond(fld.owner, 'is_exactly', [usr.an, usr.binh]) as FilterNode,
    },
    {
      name: 'link has_any_of record ids',
      input: cond(fld.customer, 'has_any_of', [rec.r1, { id: rec.r2 }]),
      expected: cond(fld.customer, 'has_any_of', [rec.r1, rec.r2]) as FilterNode,
    },
    {
      name: 'parent is_not_empty',
      input: cond(fld.parent, 'is_not_empty'),
      expected: cond(fld.parent, 'is_not_empty') as FilterNode,
    },
    {
      name: 'attachment is_empty',
      input: cond(fld.files, 'is_empty'),
      expected: cond(fld.files, 'is_empty') as FilterNode,
    },
    {
      name: 'list lookup uses multi-value operators with source options',
      input: cond(fld.tagNames, 'has_any_of', ['B']),
      expected: cond(fld.tagNames, 'has_any_of', [opt.b]) as FilterNode,
    },
    // groups
    {
      name: 'nested and/or/not tree (SPEC §6.1)',
      input: {
        op: 'and',
        items: [
          cond(fld.status, 'is', 'Done'),
          {
            op: 'or',
            items: [
              cond(fld.amount, 'gt', 1_000_000),
              cond(fld.owner, 'has_any_of', [{ $var: 'current_user' }]),
            ],
          },
          { op: 'not', item: cond(fld.done, 'is', true) },
        ],
      },
      expected: {
        op: 'and',
        items: [
          cond(fld.status, 'is', opt.done),
          {
            op: 'or',
            items: [
              cond(fld.amount, 'gt', 1_000_000),
              cond(fld.owner, 'has_any_of', [{ $var: 'current_user' }]),
            ],
          },
          { op: 'not', item: cond(fld.done, 'is', true) },
        ],
      } as FilterNode,
    },
    {
      name: 'empty and group (matches everything)',
      input: { op: 'and', items: [] },
      expected: { op: 'and', items: [] },
    },
    { name: 'depth 5 is allowed', input: nest(5), expected: nest(5) as FilterNode },
    // lookup mode
    {
      name: 'lookup: intersects with field_ref __id (SPEC §5.8)',
      mode: 'lookup',
      input: cond(fld.customer, 'intersects', { field_ref: '__id' }),
      expected: cond(fld.customer, 'intersects', { field_ref: '__id' }) as FilterNode,
    },
    {
      name: 'lookup: eq with field_ref',
      mode: 'lookup',
      input: cond(fld.title, 'eq', { field_ref: fld.code }),
      expected: cond(fld.title, 'eq', { field_ref: fld.code }) as FilterNode,
    },
    {
      name: 'lookup: text intersects literal → one-element set',
      mode: 'lookup',
      input: cond(fld.title, 'intersects', 'a'),
      expected: cond(fld.title, 'intersects', ['a']) as FilterNode,
    },
    {
      name: 'lookup: select disjoint names → ids',
      mode: 'lookup',
      input: cond(fld.status, 'disjoint', ['Done']),
      expected: cond(fld.status, 'disjoint', [opt.done]) as FilterNode,
    },
    {
      name: 'lookup: date intersects',
      mode: 'lookup',
      input: cond(fld.due, 'intersects', [{ $var: 'today' }]),
      expected: cond(fld.due, 'intersects', [{ $var: 'today' }]) as FilterNode,
    },
    // automation mode
    {
      name: 'automation: changed',
      mode: 'automation',
      input: cond(fld.status, 'changed'),
      expected: cond(fld.status, 'changed') as FilterNode,
    },
    {
      name: 'automation: changed_to option name → id (SPEC §11.8)',
      mode: 'automation',
      input: cond(fld.status, 'changed_to', 'Done'),
      expected: cond(fld.status, 'changed_to', opt.done) as FilterNode,
    },
    {
      name: 'automation: changed_from number',
      mode: 'automation',
      input: cond(fld.amount, 'changed_from', 0),
      expected: cond(fld.amount, 'changed_from', 0) as FilterNode,
    },
    {
      name: 'automation: changed_to multi uses is_exactly values',
      mode: 'automation',
      input: cond(fld.owner, 'changed_to', { $var: 'current_user' }),
      expected: cond(fld.owner, 'changed_to', [{ $var: 'current_user' }]) as FilterNode,
    },
    {
      name: 'automation: changed on attachment',
      mode: 'automation',
      input: cond(fld.files, 'changed'),
      expected: cond(fld.files, 'changed') as FilterNode,
    },
    {
      name: 'automation: standard operators still work',
      mode: 'automation',
      input: cond(fld.done, 'is', true),
      expected: cond(fld.done, 'is', true) as FilterNode,
    },
  ];

  it.each(cases)('$name', ({ input, expected, mode }) => {
    expect(check(input, mode)).toEqual({ ok: true, ast: expected });
  });

  it('`validate` is the same function', () => {
    expect(validate).toBe(validateFilter);
  });

  it('does not mutate the input', () => {
    const input = cond(fld.status, 'is_any_of', ['Done']);
    const snapshot = structuredClone(input);
    check(input);
    expect(input).toEqual(snapshot);
  });

  it('accepts exactly 50 conditions', () => {
    const items = Array.from({ length: MAX_FILTER_CONDITIONS }, () => cond(fld.title, 'is_empty'));
    expect(check({ op: 'or', items }).ok).toBe(true);
  });
});

describe('validateFilter: rejected filters', () => {
  const cases: {
    name: string;
    input: unknown;
    mode?: FilterMode;
    expected: { path: string; code: (typeof FILTER_ISSUE_CODES)[number] }[];
  }[] = [
    // fields
    {
      name: 'hidden field',
      input: cond(fld.secret, 'is_empty'),
      expected: [{ path: 'field', code: 'UNKNOWN_FIELD' }],
    },
    {
      name: 'nonexistent field',
      input: cond(fixedId('fld', 'nope'), 'is_empty'),
      expected: [{ path: 'field', code: 'UNKNOWN_FIELD' }],
    },
    {
      name: 'field name instead of id',
      input: cond('Tiêu đề', 'is_empty'),
      expected: [{ path: 'field', code: 'UNKNOWN_FIELD' }],
    },
    {
      name: 'field not a string',
      input: { field: 1, operator: 'is_empty' },
      expected: [{ path: 'field', code: 'UNKNOWN_FIELD' }],
    },
    {
      name: 'unknown field and unknown operator both reported',
      input: cond(fixedId('fld', 'nope'), 'like'),
      expected: [
        { path: 'field', code: 'UNKNOWN_FIELD' },
        { path: 'operator', code: 'OPERATOR_NOT_ALLOWED' },
      ],
    },
    // operators
    {
      name: 'unknown operator',
      input: cond(fld.title, 'like', 'a'),
      expected: [{ path: 'operator', code: 'OPERATOR_NOT_ALLOWED' }],
    },
    {
      name: 'operator not a string',
      input: { field: fld.title, operator: 3 },
      expected: [{ path: 'operator', code: 'OPERATOR_NOT_ALLOWED' }],
    },
    {
      name: 'gt on text',
      input: cond(fld.title, 'gt', 'a'),
      expected: [{ path: 'operator', code: 'OPERATOR_NOT_ALLOWED' }],
    },
    {
      name: 'contains on number',
      input: cond(fld.amount, 'contains', '1'),
      expected: [{ path: 'operator', code: 'OPERATOR_NOT_ALLOWED' }],
    },
    {
      name: 'eq on datetime',
      input: cond(fld.due, 'eq', '2026-01-01'),
      expected: [{ path: 'operator', code: 'OPERATOR_NOT_ALLOWED' }],
    },
    {
      name: 'is_empty on checkbox',
      input: cond(fld.done, 'is_empty'),
      expected: [{ path: 'operator', code: 'OPERATOR_NOT_ALLOWED' }],
    },
    {
      name: 'has_any_of on single select',
      input: cond(fld.status, 'has_any_of', ['Done']),
      expected: [{ path: 'operator', code: 'OPERATOR_NOT_ALLOWED' }],
    },
    {
      name: 'is on multi select',
      input: cond(fld.tags, 'is', 'A'),
      expected: [{ path: 'operator', code: 'OPERATOR_NOT_ALLOWED' }],
    },
    {
      name: 'has_any_of on attachment',
      input: cond(fld.files, 'has_any_of', ['x']),
      expected: [{ path: 'operator', code: 'OPERATOR_NOT_ALLOWED' }],
    },
    {
      name: 'formula without result type',
      input: cond(fld.broken, 'is_empty'),
      expected: [{ path: 'operator', code: 'OPERATOR_NOT_ALLOWED' }],
    },
    {
      name: 'intersects in standard mode',
      input: cond(fld.tags, 'intersects', ['A']),
      expected: [{ path: 'operator', code: 'OPERATOR_NOT_ALLOWED' }],
    },
    {
      name: 'disjoint in automation mode',
      mode: 'automation',
      input: cond(fld.tags, 'disjoint', ['A']),
      expected: [{ path: 'operator', code: 'OPERATOR_NOT_ALLOWED' }],
    },
    {
      name: 'changed in standard mode',
      input: cond(fld.status, 'changed'),
      expected: [{ path: 'operator', code: 'OPERATOR_NOT_ALLOWED' }],
    },
    {
      name: 'changed_to in lookup mode',
      mode: 'lookup',
      input: cond(fld.status, 'changed_to', 'Done'),
      expected: [{ path: 'operator', code: 'OPERATOR_NOT_ALLOWED' }],
    },
    {
      name: 'changed_from in standard mode',
      input: cond(fld.status, 'changed_from', 'Done'),
      expected: [{ path: 'operator', code: 'OPERATOR_NOT_ALLOWED' }],
    },
    {
      name: 'lookup: intersects on checkbox',
      mode: 'lookup',
      input: cond(fld.done, 'intersects', [true]),
      expected: [{ path: 'operator', code: 'OPERATOR_NOT_ALLOWED' }],
    },
    {
      name: 'automation: changed_to on attachment',
      mode: 'automation',
      input: cond(fld.files, 'changed_to', []),
      expected: [{ path: 'operator', code: 'OPERATOR_NOT_ALLOWED' }],
    },
    {
      name: 'automation: changed on formula without result type',
      mode: 'automation',
      input: cond(fld.broken, 'changed'),
      expected: [{ path: 'operator', code: 'OPERATOR_NOT_ALLOWED' }],
    },
    // values
    {
      name: 'is_empty with a value',
      input: cond(fld.title, 'is_empty', 'x'),
      expected: [{ path: 'value', code: 'VALUE_NOT_ALLOWED' }],
    },
    {
      name: 'changed with a value',
      mode: 'automation',
      input: cond(fld.title, 'changed', 'x'),
      expected: [{ path: 'value', code: 'VALUE_NOT_ALLOWED' }],
    },
    {
      name: 'eq without a value',
      input: cond(fld.title, 'eq'),
      expected: [{ path: 'value', code: 'VALUE_REQUIRED' }],
    },
    {
      name: 'eq with null',
      input: cond(fld.amount, 'eq', null),
      expected: [{ path: 'value', code: 'VALUE_REQUIRED' }],
    },
    {
      name: 'text eq empty string',
      input: cond(fld.title, 'eq', ''),
      expected: [{ path: 'value', code: 'INVALID_VALUE' }],
    },
    {
      name: 'text eq number',
      input: cond(fld.title, 'eq', 5),
      expected: [{ path: 'value', code: 'INVALID_VALUE' }],
    },
    {
      name: 'text eq array',
      input: cond(fld.title, 'eq', ['a']),
      expected: [{ path: 'value', code: 'INVALID_VALUE' }],
    },
    {
      name: 'text eq current_user',
      input: cond(fld.title, 'eq', { $var: 'current_user' }),
      expected: [{ path: 'value', code: 'INVALID_VALUE' }],
    },
    {
      name: 'text eq too long',
      input: cond(fld.title, 'eq', 'x'.repeat(10_001)),
      expected: [{ path: 'value', code: 'INVALID_VALUE' }],
    },
    {
      name: 'number eq string',
      input: cond(fld.amount, 'eq', '5'),
      expected: [{ path: 'value', code: 'INVALID_VALUE' }],
    },
    {
      name: 'number eq Infinity',
      input: cond(fld.amount, 'eq', Number.POSITIVE_INFINITY),
      expected: [{ path: 'value', code: 'INVALID_VALUE' }],
    },
    {
      name: 'between with one value',
      input: cond(fld.amount, 'between', [1]),
      expected: [{ path: 'value', code: 'INVALID_VALUE' }],
    },
    {
      name: 'between with three values',
      input: cond(fld.amount, 'between', [1, 2, 3]),
      expected: [{ path: 'value', code: 'INVALID_VALUE' }],
    },
    {
      name: 'between with a scalar',
      input: cond(fld.amount, 'between', 1),
      expected: [{ path: 'value', code: 'INVALID_VALUE' }],
    },
    {
      name: 'between with a bad element',
      input: cond(fld.amount, 'between', [1, 'x']),
      expected: [{ path: 'value[1]', code: 'INVALID_VALUE' }],
    },
    {
      name: 'date: instant with offset',
      input: cond(fld.due, 'is', '2026-09-25T09:30:00Z'),
      expected: [{ path: 'value', code: 'INVALID_VALUE' }],
    },
    {
      name: 'date: invalid calendar day',
      input: cond(fld.due, 'is', '2026-02-30'),
      expected: [{ path: 'value', code: 'INVALID_VALUE' }],
    },
    {
      name: 'date: invalid time',
      input: cond(fld.due, 'is', '2026-02-03T24:00'),
      expected: [{ path: 'value', code: 'INVALID_VALUE' }],
    },
    {
      name: 'date: number',
      input: cond(fld.due, 'is', 20260925),
      expected: [{ path: 'value', code: 'INVALID_VALUE' }],
    },
    {
      name: 'date: current_user var',
      input: cond(fld.due, 'is', { $var: 'current_user' }),
      expected: [{ path: 'value', code: 'INVALID_VALUE' }],
    },
    {
      name: 'date: unknown var',
      input: cond(fld.due, 'is', { $var: 'yesterday' }),
      expected: [{ path: 'value', code: 'INVALID_VALUE' }],
    },
    {
      name: 'date: days_ago without amount',
      input: cond(fld.due, 'is', { $date: { relative: 'days_ago' } }),
      expected: [{ path: 'value.$date.amount', code: 'INVALID_VALUE' }],
    },
    {
      name: 'date: today with amount',
      input: cond(fld.due, 'is', { $date: { relative: 'today', amount: 1 } }),
      expected: [{ path: 'value.$date.amount', code: 'INVALID_VALUE' }],
    },
    {
      name: 'date: negative amount',
      input: cond(fld.due, 'is', { $date: { relative: 'days_from_now', amount: -1 } }),
      expected: [{ path: 'value.$date.amount', code: 'INVALID_VALUE' }],
    },
    {
      name: 'date: unknown relative',
      input: cond(fld.due, 'is', { $date: { relative: 'next_week' } }),
      expected: [{ path: 'value.$date', code: 'INVALID_VALUE' }],
    },
    {
      name: 'date: extra key',
      input: cond(fld.due, 'is', { $date: { exact: '2026-01-01' }, x: 1 }),
      expected: [{ path: 'value', code: 'INVALID_VALUE' }],
    },
    {
      name: 'date: between one bad',
      input: cond(fld.due, 'between', ['2026-01-01', 'soon']),
      expected: [{ path: 'value[1]', code: 'INVALID_VALUE' }],
    },
    {
      name: 'checkbox is string',
      input: cond(fld.done, 'is', 'true'),
      expected: [{ path: 'value', code: 'INVALID_VALUE' }],
    },
    {
      name: 'select unknown option',
      input: cond(fld.status, 'is', 'Nope'),
      expected: [{ path: 'value', code: 'INVALID_SELECT_OPTION' }],
    },
    {
      name: 'select option of another field',
      input: cond(fld.status, 'is', opt.a),
      expected: [{ path: 'value', code: 'INVALID_SELECT_OPTION' }],
    },
    {
      name: 'select is with two values',
      input: cond(fld.status, 'is', ['Mới', 'Done']),
      expected: [{ path: 'value', code: 'INVALID_VALUE' }],
    },
    {
      name: 'select is number',
      input: cond(fld.status, 'is', 1),
      expected: [{ path: 'value', code: 'INVALID_VALUE' }],
    },
    {
      name: 'select is_any_of empty list',
      input: cond(fld.status, 'is_any_of', []),
      expected: [{ path: 'value', code: 'INVALID_VALUE' }],
    },
    {
      name: 'select is_any_of too many values',
      input: cond(
        fld.status,
        'is_any_of',
        Array.from({ length: 1001 }, () => 'Done'),
      ),
      expected: [{ path: 'value', code: 'INVALID_VALUE' }],
    },
    {
      name: 'multi select unknown option in list',
      input: cond(fld.tags, 'has_any_of', ['A', 'Z']),
      expected: [{ path: 'value[1]', code: 'INVALID_SELECT_OPTION' }],
    },
    {
      name: 'user: not a user id',
      input: cond(fld.owner, 'has_any_of', ['An']),
      expected: [{ path: 'value[0]', code: 'INVALID_VALUE' }],
    },
    {
      name: 'user: today var',
      input: cond(fld.owner, 'has_any_of', [{ $var: 'today' }]),
      expected: [{ path: 'value[0]', code: 'INVALID_VALUE' }],
    },
    {
      name: 'user: scalar bad value',
      input: cond(fld.owner, 'has_any_of', 5),
      expected: [{ path: 'value', code: 'INVALID_VALUE' }],
    },
    {
      name: 'link: user id instead of record id',
      input: cond(fld.customer, 'has_any_of', [usr.an]),
      expected: [{ path: 'value[0]', code: 'INVALID_VALUE' }],
    },
    {
      name: 'link: { id } with extra key',
      input: cond(fld.customer, 'has_any_of', [{ id: rec.r1, x: 1 }]),
      expected: [{ path: 'value[0]', code: 'INVALID_VALUE' }],
    },
    {
      name: 'list lookup: unknown option',
      input: cond(fld.tagNames, 'has_any_of', ['Z']),
      expected: [{ path: 'value[0]', code: 'INVALID_SELECT_OPTION' }],
    },
    // field_ref
    {
      name: 'field_ref in standard mode',
      input: cond(fld.title, 'eq', { field_ref: fld.code }),
      expected: [{ path: 'value', code: 'INVALID_VALUE' }],
    },
    {
      name: 'field_ref with between',
      mode: 'lookup',
      input: cond(fld.amount, 'between', { field_ref: fld.amount }),
      expected: [{ path: 'value', code: 'INVALID_VALUE' }],
    },
    {
      name: 'field_ref malformed',
      mode: 'lookup',
      input: cond(fld.title, 'eq', { field_ref: 'Tiêu đề' }),
      expected: [{ path: 'value', code: 'INVALID_VALUE' }],
    },
    // structure
    { name: 'not an object', input: 'x', expected: [{ path: '', code: 'INVALID_STRUCTURE' }] },
    { name: 'array root', input: [], expected: [{ path: '', code: 'INVALID_STRUCTURE' }] },
    {
      name: 'object without op or field',
      input: { items: [] },
      expected: [{ path: '', code: 'INVALID_STRUCTURE' }],
    },
    {
      name: 'unknown group op',
      input: { op: 'xor', items: [] },
      expected: [{ path: 'op', code: 'INVALID_STRUCTURE' }],
    },
    {
      name: 'group items not an array',
      input: { op: 'and', items: {} },
      expected: [{ path: 'items', code: 'INVALID_STRUCTURE' }],
    },
    {
      name: 'not with items',
      input: { op: 'not', items: [] },
      expected: [{ path: 'items', code: 'INVALID_STRUCTURE' }],
    },
    {
      name: 'not without item',
      input: { op: 'not' },
      expected: [{ path: 'item', code: 'INVALID_STRUCTURE' }],
    },
    {
      name: 'extra key on condition',
      input: { ...cond(fld.title, 'is_empty'), x: 1 },
      expected: [{ path: 'x', code: 'INVALID_STRUCTURE' }],
    },
    {
      name: 'nested paths',
      input: {
        op: 'and',
        items: [
          cond(fld.title, 'is_empty'),
          {
            op: 'or',
            items: [cond(fld.amount, 'gt', 'x'), { op: 'not', item: cond(fld.secret, 'is_empty') }],
          },
        ],
      },
      expected: [
        { path: 'items[1].items[0].value', code: 'INVALID_VALUE' },
        { path: 'items[1].items[1].item.field', code: 'UNKNOWN_FIELD' },
      ],
    },
    // limits
    {
      name: 'depth 6',
      input: nest(6),
      expected: [{ path: 'item.items[0].item.items[0].item', code: 'MAX_DEPTH_EXCEEDED' }],
    },
    {
      name: 'depth 6 below the root',
      input: { op: 'or', items: [cond(fld.title, 'is_empty'), nest(5)] },
      expected: [{ path: 'items[1].items[0].item.items[0].item', code: 'MAX_DEPTH_EXCEEDED' }],
    },
    {
      name: '51 conditions',
      input: { op: 'and', items: Array.from({ length: 51 }, () => cond(fld.title, 'is_empty')) },
      expected: [{ path: '', code: 'MAX_CONDITIONS_EXCEEDED' }],
    },
    {
      name: 'lookup: empty where',
      mode: 'lookup',
      input: { op: 'and', items: [] },
      expected: [{ path: '', code: 'EMPTY_FILTER' }],
    },
  ];

  it.each(cases)('$name', ({ input, mode, expected }) => {
    expect(issues(input, mode)).toEqual(expected);
  });

  it('reports a hidden field exactly like a nonexistent one (same code, message, params shape)', () => {
    const hidden = check(cond(fld.secret, 'eq', 'x'));
    const missing = check(cond(fixedId('fld', 'nope'), 'eq', 'x'));
    expect(hidden.ok || missing.ok).toBe(false);
    if (!hidden.ok && !missing.ok) {
      expect(hidden.errors).toEqual([
        {
          path: 'field',
          code: 'UNKNOWN_FIELD',
          message: 'Field does not exist',
          params: { field: fld.secret },
        },
      ]);
      expect(missing.errors).toEqual([
        {
          path: 'field',
          code: 'UNKNOWN_FIELD',
          message: 'Field does not exist',
          params: { field: fixedId('fld', 'nope') },
        },
      ]);
    }
  });

  it('checks field_ref against refFieldIds in lookup mode', () => {
    expect(issues(cond(fld.title, 'eq', { field_ref: fld.code }), 'lookup', [fld.title])).toEqual([
      { path: 'value.field_ref', code: 'UNKNOWN_FIELD_REF' },
    ]);
    expect(issues(cond(fld.title, 'eq', { field_ref: fld.code }), 'lookup', [fld.code])).toEqual(
      [],
    );
    expect(issues(cond(fld.customer, 'intersects', { field_ref: '__id' }), 'lookup', [])).toEqual(
      [],
    );
  });

  it.each([
    // The source record is one of the records the current one links to (CONTRACTS §13).
    [cond('__id', 'is_any_of', { field_ref: fld.customer }), [fld.customer], []],
    [cond('__id', 'is_none_of', { field_ref: fld.customer }), [fld.customer], []],
    [
      cond('__id', 'eq', { field_ref: fld.customer }),
      [fld.customer],
      [{ path: 'operator', code: 'OPERATOR_NOT_ALLOWED' }],
    ],
    [
      cond('__id', 'is_any_of', ['rec_0123456789ABCDEF']),
      [fld.customer],
      [{ path: 'value', code: 'INVALID_VALUE' }],
    ],
    [
      cond('__id', 'is_any_of', { field_ref: '__id' }),
      [fld.customer],
      [{ path: 'value', code: 'INVALID_VALUE' }],
    ],
    [
      cond('__id', 'is_any_of', { field_ref: fld.customer }),
      [fld.title],
      [{ path: 'value.field_ref', code: 'UNKNOWN_FIELD_REF' }],
    ],
  ])('lookup mode: record ID condition %o', (node, refs, expected) => {
    expect(issues(node, 'lookup', refs)).toEqual(expected);
  });

  it('record ID conditions only in lookup mode', () => {
    expect(issues(cond('__id', 'is_any_of', { field_ref: fld.customer }))).toEqual([
      { path: 'field', code: 'UNKNOWN_FIELD' },
    ]);
  });

  it('reports operator-mode errors with the mode', () => {
    const result = check(cond(fld.tags, 'intersects', ['A']));
    expect(result.ok ? null : result.errors[0]?.params).toEqual({
      operator: 'intersects',
      mode: 'standard',
    });
  });

  it('throws on invalid select options in meta (trusted input)', () => {
    const broken = {
      fields: [{ id: fld.status, name: 'S', type: 'select' as const, options: { options: 'x' } }],
    };
    expect(() => validateFilter(cond(fld.status, 'is', 'x'), broken, [fld.status])).toThrow();
  });
});

describe('validateFilter: list lookups of scalars and unknown types', () => {
  const meta = {
    fields: [
      {
        id: fld.title,
        name: 'Names',
        type: 'lookup' as const,
        resultType: 'text' as const,
        resultIsList: true,
      },
      // A type from a later phase that this package does not know yet.
      { id: fld.code, name: 'Place', type: 'location' as unknown as 'text' },
    ],
  };
  const run = (input: unknown) => validateFilter(input, meta, [fld.title, fld.code]);

  it.each([{ name: 'strings', value: ['a', 'b', 'a'], expected: ['a', 'b'] }])(
    'accepts $name',
    ({ value, expected }) => {
      expect(run(cond(fld.title, 'has_any_of', value))).toEqual({
        ok: true,
        ast: cond(fld.title, 'has_any_of', expected),
      });
    },
  );

  it.each([
    // A list of texts compares texts only (T457: the SQL compares `text[]`).
    { name: 'number', value: [1], path: 'value[0]' },
    { name: 'boolean', value: ['a', true], path: 'value[1]' },
    { name: 'object', value: [{}], path: 'value[0]' },
    { name: 'Infinity', value: [Number.NEGATIVE_INFINITY], path: 'value[0]' },
    { name: 'too long string', value: ['x'.repeat(10_001)], path: 'value[0]' },
  ])('rejects $name', ({ value, path }) => {
    const result = run(cond(fld.title, 'has_any_of', value));
    expect(result.ok ? [] : result.errors.map((error) => error.path)).toEqual([path]);
  });

  it('rejects every operator on an unknown field type', () => {
    const result = run(cond(fld.code, 'is_empty'));
    expect(result.ok ? null : result.errors[0]?.code).toBe('OPERATOR_NOT_ALLOWED');
  });
});
