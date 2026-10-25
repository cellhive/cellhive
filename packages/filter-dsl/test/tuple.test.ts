import { describe, expect, it } from 'vitest';

import {
  isTupleFilter,
  normalizeTuple,
  parseFilterInput,
  tupleFilterSchema,
  tuplePathOf,
  type FilterNode,
} from '../src/index.js';

import { fld, opt, rec, table, usr, visible } from './fixture.js';

const byId = (conditions: unknown[][], logic = 'and') =>
  normalizeTuple({ logic, conditions }, table, { fieldKeyType: 'id' });

/** One DSL item produced from one tuple condition. */
const single = (condition: unknown[]): FilterNode | undefined => {
  const result = byId([condition]);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return 'items' in result.ast ? result.ast.items[0] : undefined;
};

describe('normalizeTuple: CONTRACTS §3 mapping table', () => {
  // Rows `==`, `!=`, comparisons, `intersects`, `disjoint`, `empty`/`non_empty`
  // × columns text | number | datetime | checkbox | single select | multi select/user/link.
  const cases: { name: string; condition: unknown[]; expected: FilterNode }[] = [
    // `==`
    {
      name: '== text',
      condition: [fld.title, '==', 'POS'],
      expected: { field: fld.title, operator: 'eq', value: 'POS' },
    },
    {
      name: '== number',
      condition: [fld.amount, '==', 5],
      expected: { field: fld.amount, operator: 'eq', value: 5 },
    },
    {
      name: '== datetime',
      condition: [fld.due, '==', 'Today'],
      expected: { field: fld.due, operator: 'is', value: { $date: { relative: 'today' } } },
    },
    {
      name: '== checkbox',
      condition: [fld.done, '==', true],
      expected: { field: fld.done, operator: 'is', value: true },
    },
    {
      name: '== single select',
      condition: [fld.status, '==', 'Mới'],
      expected: { field: fld.status, operator: 'is', value: 'Mới' },
    },
    {
      name: '== multi select',
      condition: [fld.tags, '==', ['A', 'B']],
      expected: { field: fld.tags, operator: 'is_exactly', value: ['A', 'B'] },
    },
    {
      name: '== user',
      condition: [fld.owner, '==', [{ id: usr.an }]],
      expected: { field: fld.owner, operator: 'is_exactly', value: [usr.an] },
    },
    {
      name: '== link',
      condition: [fld.customer, '==', [{ id: rec.r1 }]],
      expected: { field: fld.customer, operator: 'is_exactly', value: [rec.r1] },
    },
    // `!=`
    {
      name: '!= text',
      condition: [fld.title, '!=', 'POS'],
      expected: { field: fld.title, operator: 'neq', value: 'POS' },
    },
    {
      name: '!= number',
      condition: [fld.amount, '!=', 5],
      expected: { field: fld.amount, operator: 'neq', value: 5 },
    },
    {
      name: '!= datetime is not + is',
      condition: [fld.due, '!=', 'ExactDate(2026-09-25)'],
      expected: {
        op: 'not',
        item: { field: fld.due, operator: 'is', value: { $date: { exact: '2026-09-25' } } },
      },
    },
    {
      name: '!= checkbox inverts is',
      condition: [fld.done, '!=', true],
      expected: { field: fld.done, operator: 'is', value: false },
    },
    {
      name: '!= checkbox false',
      condition: [fld.done, '!=', false],
      expected: { field: fld.done, operator: 'is', value: true },
    },
    {
      name: '!= single select',
      condition: [fld.status, '!=', 'Done'],
      expected: { field: fld.status, operator: 'is_not', value: 'Done' },
    },
    {
      name: '!= multi select is not + is_exactly',
      condition: [fld.tags, '!=', ['A']],
      expected: { op: 'not', item: { field: fld.tags, operator: 'is_exactly', value: ['A'] } },
    },
    {
      name: '!= user',
      condition: [fld.owner, '!=', 'CurrentUser'],
      expected: {
        op: 'not',
        item: { field: fld.owner, operator: 'is_exactly', value: [{ $var: 'current_user' }] },
      },
    },
    // comparisons
    {
      name: '> number',
      condition: [fld.amount, '>', 1],
      expected: { field: fld.amount, operator: 'gt', value: 1 },
    },
    {
      name: '>= number',
      condition: [fld.amount, '>=', 1],
      expected: { field: fld.amount, operator: 'gte', value: 1 },
    },
    {
      name: '< number',
      condition: [fld.amount, '<', 1],
      expected: { field: fld.amount, operator: 'lt', value: 1 },
    },
    {
      name: '<= number',
      condition: [fld.amount, '<=', 1],
      expected: { field: fld.amount, operator: 'lte', value: 1 },
    },
    {
      name: '> datetime',
      condition: [fld.due, '>', 'Yesterday'],
      expected: { field: fld.due, operator: 'after', value: { $date: { relative: 'yesterday' } } },
    },
    {
      name: '>= datetime',
      condition: [fld.due, '>=', 'Tomorrow'],
      expected: {
        field: fld.due,
        operator: 'on_or_after',
        value: { $date: { relative: 'tomorrow' } },
      },
    },
    {
      name: '< datetime',
      condition: [fld.dueAt, '<', 'ExactDate(2026-09-25 09:30)'],
      expected: {
        field: fld.dueAt,
        operator: 'before',
        value: { $date: { exact: '2026-09-25T09:30' } },
      },
    },
    {
      name: '<= datetime (one-element list)',
      condition: [fld.created, '<=', ['ExactDate(2026-09-25)']],
      expected: {
        field: fld.created,
        operator: 'on_or_before',
        value: { $date: { exact: '2026-09-25' } },
      },
    },
    // intersects
    {
      name: 'intersects text',
      condition: [fld.title, 'intersects', 'pos'],
      expected: { field: fld.title, operator: 'contains', value: 'pos' },
    },
    {
      name: 'intersects text one-element list',
      condition: [fld.title, 'intersects', ['pos']],
      expected: { field: fld.title, operator: 'contains', value: 'pos' },
    },
    {
      name: 'intersects text several strings → or of contains',
      condition: [fld.title, 'intersects', ['pos', 'in']],
      expected: {
        op: 'or',
        items: [
          { field: fld.title, operator: 'contains', value: 'pos' },
          { field: fld.title, operator: 'contains', value: 'in' },
        ],
      },
    },
    {
      name: 'intersects single select',
      condition: [fld.status, 'intersects', ['Mới', 'Đang xử lý']],
      expected: { field: fld.status, operator: 'is_any_of', value: ['Mới', 'Đang xử lý'] },
    },
    {
      name: 'intersects multi select',
      condition: [fld.tags, 'intersects', ['A']],
      expected: { field: fld.tags, operator: 'has_any_of', value: ['A'] },
    },
    {
      name: 'intersects user (CurrentUser)',
      condition: [fld.owner, 'intersects', ['CurrentUser', { id: usr.binh }]],
      expected: {
        field: fld.owner,
        operator: 'has_any_of',
        value: [{ $var: 'current_user' }, usr.binh],
      },
    },
    {
      name: 'intersects link',
      condition: [fld.customer, 'intersects', [{ id: rec.r1 }, rec.r2]],
      expected: { field: fld.customer, operator: 'has_any_of', value: [rec.r1, rec.r2] },
    },
    // disjoint
    {
      name: 'disjoint text',
      condition: [fld.title, 'disjoint', 'pos'],
      expected: { field: fld.title, operator: 'not_contains', value: 'pos' },
    },
    {
      name: 'disjoint text several strings → and of not_contains',
      condition: [fld.title, 'disjoint', ['a', 'b']],
      expected: {
        op: 'and',
        items: [
          { field: fld.title, operator: 'not_contains', value: 'a' },
          { field: fld.title, operator: 'not_contains', value: 'b' },
        ],
      },
    },
    {
      name: 'disjoint single select',
      condition: [fld.status, 'disjoint', ['Done']],
      expected: { field: fld.status, operator: 'is_none_of', value: ['Done'] },
    },
    {
      name: 'disjoint multi select',
      condition: [fld.tags, 'disjoint', ['B']],
      expected: { field: fld.tags, operator: 'has_none_of', value: ['B'] },
    },
    {
      name: 'disjoint user',
      condition: [fld.creator, 'disjoint', 'CurrentUser'],
      expected: { field: fld.creator, operator: 'has_none_of', value: [{ $var: 'current_user' }] },
    },
    // empty / non_empty (every type except checkbox)
    ...(
      [
        ['text', fld.title],
        ['auto_number', fld.code],
        ['number', fld.amount],
        ['datetime', fld.due],
        ['single select', fld.status],
        ['multi select', fld.tags],
        ['user', fld.owner],
        ['link', fld.customer],
        ['attachment', fld.files],
        ['formula (number)', fld.total],
      ] as const
    ).flatMap(([label, field]) => [
      {
        name: `empty ${label}`,
        condition: [field, 'empty'],
        expected: { field, operator: 'is_empty' as const },
      },
      {
        name: `non_empty ${label}`,
        condition: [field, 'non_empty', null],
        expected: { field, operator: 'is_not_empty' as const },
      },
    ]),
    // formula/lookup by result type
    {
      name: '> formula number',
      condition: [fld.total, '>', 0],
      expected: { field: fld.total, operator: 'gt', value: 0 },
    },
    {
      name: '== list lookup',
      condition: [fld.tagNames, '==', ['A']],
      expected: { field: fld.tagNames, operator: 'is_exactly', value: ['A'] },
    },
  ];

  it.each(cases)('$name', ({ condition, expected }) => {
    expect(single(condition)).toEqual(expected);
  });

  // The "lỗi" cells.
  const errors: { name: string; condition: unknown[] }[] = [
    ...(['>', '>=', '<', '<='] as const).flatMap((op) => [
      { name: `${op} text`, condition: [fld.title, op, 'a'] },
      { name: `${op} checkbox`, condition: [fld.done, op, true] },
      { name: `${op} single select`, condition: [fld.status, op, 'Mới'] },
      { name: `${op} multi select`, condition: [fld.tags, op, ['A']] },
      { name: `${op} user`, condition: [fld.owner, op, 'CurrentUser'] },
      { name: `${op} link`, condition: [fld.customer, op, [rec.r1]] },
    ]),
    ...(['intersects', 'disjoint'] as const).flatMap((op) => [
      { name: `${op} number`, condition: [fld.amount, op, [1]] },
      { name: `${op} datetime`, condition: [fld.due, op, 'Today'] },
      { name: `${op} checkbox`, condition: [fld.done, op, [true]] },
    ]),
    { name: 'empty checkbox (never empty)', condition: [fld.done, 'empty'] },
    { name: 'non_empty checkbox', condition: [fld.done, 'non_empty'] },
    { name: '== attachment', condition: [fld.files, '==', []] },
    { name: '== formula without result type', condition: [fld.broken, '==', 1] },
    { name: 'unknown tuple operator', condition: [fld.amount, '~', 1] },
  ];

  it.each(errors)('$name → OPERATOR_NOT_ALLOWED at conditions[1][1]', ({ condition }) => {
    const result = byId([[fld.title, 'empty'], condition]);
    expect(result).toEqual({
      ok: false,
      errors: [expect.objectContaining({ path: 'conditions[1][1]', code: 'OPERATOR_NOT_ALLOWED' })],
    });
  });
});

describe('normalizeTuple: fields, values and structure', () => {
  it('resolves field names with field_key_type=name and keeps the logic', () => {
    const result = normalizeTuple(
      {
        logic: 'or',
        conditions: [
          ['Trạng thái', 'intersects', ['Mới', 'Đang xử lý']],
          ['Hạn', '<', 'Today'],
        ],
      },
      table,
      { fieldKeyType: 'name' },
    );
    expect(result).toEqual({
      ok: true,
      ast: {
        op: 'or',
        items: [
          { field: fld.status, operator: 'is_any_of', value: ['Mới', 'Đang xử lý'] },
          { field: fld.due, operator: 'before', value: { $date: { relative: 'today' } } },
        ],
      },
    });
  });

  it('turns an empty condition list into an empty and group', () => {
    expect(byId([])).toEqual({ ok: true, ast: { op: 'and', items: [] } });
  });

  it('reports hidden and missing fields identically when visibleFieldIds is given', () => {
    const run = (name: string) =>
      normalizeTuple({ logic: 'and', conditions: [[name, 'empty']] }, table, {
        fieldKeyType: 'name',
        visibleFieldIds: visible,
      });
    const hidden = run('Giá vốn');
    const missing = run('Không có');
    const strip = (result: ReturnType<typeof run>) =>
      result.ok ? [] : result.errors.map(({ path, code, message }) => ({ path, code, message }));
    expect(strip(hidden)).toEqual([
      { path: 'conditions[0][0]', code: 'UNKNOWN_FIELD', message: 'Field does not exist' },
    ]);
    expect(strip(hidden)).toEqual(strip(missing));
  });

  it('does not resolve names when field_key_type=id', () => {
    const result = normalizeTuple({ logic: 'and', conditions: [['Tiêu đề', 'empty']] }, table, {
      fieldKeyType: 'id',
    });
    expect(result.ok).toBe(false);
  });

  it.each([
    { name: 'not an object', input: [], path: '', code: 'INVALID_STRUCTURE' },
    {
      name: 'unknown key',
      input: { logic: 'and', conditions: [], x: 1 },
      path: 'x',
      code: 'INVALID_STRUCTURE',
    },
    {
      name: 'bad logic',
      input: { logic: 'xor', conditions: [] },
      path: 'logic',
      code: 'INVALID_STRUCTURE',
    },
    {
      name: 'conditions not an array',
      input: { logic: 'and', conditions: {} },
      path: 'conditions',
      code: 'INVALID_STRUCTURE',
    },
    {
      name: 'condition too short',
      input: { logic: 'and', conditions: [[fld.title]] },
      path: 'conditions[0]',
      code: 'INVALID_STRUCTURE',
    },
    {
      name: 'condition too long',
      input: { logic: 'and', conditions: [[fld.title, '==', 'a', 'b']] },
      path: 'conditions[0]',
      code: 'INVALID_STRUCTURE',
    },
    {
      name: 'field not a string',
      input: { logic: 'and', conditions: [[1, '==', 'a']] },
      path: 'conditions[0]',
      code: 'INVALID_STRUCTURE',
    },
    {
      name: 'malformed ExactDate',
      input: { logic: 'and', conditions: [[fld.due, '==', 'ExactDate(25/09/2026)']] },
      path: 'conditions[0][2]',
      code: 'INVALID_VALUE',
    },
    {
      name: 'checkbox != with a non-boolean',
      input: { logic: 'and', conditions: [[fld.done, '!=', 'yes']] },
      path: 'conditions[0][2]',
      code: 'INVALID_VALUE',
    },
    {
      name: 'empty with a value',
      input: { logic: 'and', conditions: [[fld.title, 'empty', 'x']] },
      path: 'conditions[0][2]',
      code: 'VALUE_NOT_ALLOWED',
    },
  ])('rejects $name', ({ input, path, code }) => {
    const result = normalizeTuple(input, table, { fieldKeyType: 'id' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContainEqual(expect.objectContaining({ path, code }));
  });

  it('converts date tokens inside lists (between after normalisation)', () => {
    expect(single([fld.due, '==', ['Today', 'ExactDate(2026-01-01)']])).toEqual({
      field: fld.due,
      operator: 'is',
      value: [{ $date: { relative: 'today' } }, { $date: { exact: '2026-01-01' } }],
    });
    expect(byId([[fld.due, '==', ['ExactDate(bad)', 'Today']]]).ok).toBe(false);
  });

  it('passes through strings that are not date tokens', () => {
    expect(single([fld.due, '==', '2026-09-25'])).toEqual({
      field: fld.due,
      operator: 'is',
      value: '2026-09-25',
    });
    expect(single([fld.due, '==', 5])).toEqual({ field: fld.due, operator: 'is', value: 5 });
  });

  it('exposes a structural zod schema', () => {
    expect(
      tupleFilterSchema.safeParse({
        logic: 'and',
        conditions: [
          ['a', '==', 1],
          ['b', 'empty'],
        ],
      }).success,
    ).toBe(true);
    expect(tupleFilterSchema.safeParse({ logic: 'and', conditions: [['a', '~', 1]] }).success).toBe(
      false,
    );
  });
});

describe('parseFilterInput', () => {
  const opts = { fieldKeyType: 'name' } as const;

  it('detects the tuple form', () => {
    expect(isTupleFilter({ logic: 'and', conditions: [] })).toBe(true);
    expect(isTupleFilter({ op: 'and', items: [] })).toBe(false);
    expect(isTupleFilter(null)).toBe(false);
    expect(isTupleFilter([])).toBe(false);
  });

  it('normalises and validates the CONTRACTS §1.4 query example', () => {
    const result = parseFilterInput(
      {
        logic: 'and',
        conditions: [
          ['Trạng thái', 'intersects', ['Mới', 'Đang xử lý']],
          ['Hạn', '<', 'Today'],
        ],
      },
      table,
      visible,
      opts,
    );
    expect(result).toEqual({
      ok: true,
      ast: {
        op: 'and',
        items: [
          { field: fld.status, operator: 'is_any_of', value: [opt.new, opt.progress] },
          { field: fld.due, operator: 'before', value: { $date: { relative: 'today' } } },
        ],
      },
    });
  });

  it('validates DSL input directly', () => {
    const result = parseFilterInput(
      { field: fld.status, operator: 'is', value: 'Done' },
      table,
      visible,
      opts,
    );
    expect(result).toEqual({
      ok: true,
      ast: { field: fld.status, operator: 'is', value: opt.done },
    });
  });

  it('returns normalisation errors as is', () => {
    const result = parseFilterInput(
      { logic: 'and', conditions: [['Giá vốn', 'empty']] },
      table,
      visible,
      opts,
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors[0]).toMatchObject({ path: 'conditions[0][0]', code: 'UNKNOWN_FIELD' });
  });

  it('maps validation paths back to the tuple', () => {
    const result = parseFilterInput(
      {
        logic: 'and',
        conditions: [
          ['Tiêu đề', 'empty'],
          ['Trạng thái', '==', 'Không có'],
          ['Hạn', '!=', 'hôm qua'],
          ['Tiêu đề', 'intersects', ['ok', 5]],
          ['Nhãn', 'intersects', ['A', 'Z']],
        ],
      },
      table,
      visible,
      opts,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map(({ path, code }) => ({ path, code }))).toEqual([
        { path: 'conditions[1][2]', code: 'INVALID_SELECT_OPTION' },
        { path: 'conditions[2][2]', code: 'INVALID_VALUE' },
        { path: 'conditions[3][2][1]', code: 'INVALID_VALUE' },
        { path: 'conditions[4][2][1]', code: 'INVALID_SELECT_OPTION' },
      ]);
    }
  });

  it.each([
    ['items[3].field', 'conditions[3][0]'],
    ['items[3].operator', 'conditions[3][1]'],
    ['items[3].item.value', 'conditions[3][2]'],
    ['items[3].value.$date.amount', 'conditions[3][2].$date.amount'],
    ['items[3].items[1].value', 'conditions[3][2][1]'],
    ['items[3].items[1].field', 'conditions[3][0]'],
    ['items[3]', 'conditions[3]'],
    ['', ''],
  ])('tuplePathOf(%s) = %s', (dslPath, tuplePath) => {
    expect(tuplePathOf(dslPath)).toBe(tuplePath);
  });
});
