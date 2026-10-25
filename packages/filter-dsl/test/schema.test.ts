import { describe, expect, it } from 'vitest';

import {
  AUTOMATION_ONLY_OPERATORS,
  collectFieldIds,
  collectFieldRefs,
  DSL_OPERATORS,
  fieldProfile,
  filterNodeSchema,
  forEachCondition,
  isAutomationOnlyOperator,
  isDslOperator,
  isLookupOnlyOperator,
  LOOKUP_ONLY_OPERATORS,
  measureFilter,
  parseExactDate,
  type FilterFieldMeta,
  type FilterNode,
} from '../src/index.js';

import { fld, opt, usr } from './fixture.js';

const leaf = (): FilterNode => ({ field: fld.title, operator: 'is_empty' });

const chain = (levels: number): FilterNode => {
  let node = leaf();
  for (let level = 0; level < levels; level += 1) node = { op: 'and', items: [node] };
  return node;
};

describe('filterNodeSchema', () => {
  const valid: { name: string; node: unknown }[] = [
    { name: 'condition without value', node: { field: fld.title, operator: 'is_empty' } },
    {
      name: 'SPEC §6.1 example',
      node: {
        op: 'and',
        items: [
          { field: fld.status, operator: 'is', value: opt.done },
          {
            op: 'or',
            items: [
              { field: fld.amount, operator: 'gt', value: 1_000_000 },
              { field: fld.owner, operator: 'has_any_of', value: [{ $var: 'current_user' }] },
            ],
          },
        ],
      },
    },
    { name: 'not', node: { op: 'not', item: { field: fld.title, operator: 'eq', value: 'x' } } },
    {
      name: 'exact date',
      node: { field: fld.due, operator: 'is', value: { $date: { exact: '2026-09-25T09:30' } } },
    },
    {
      name: 'relative date with amount',
      node: {
        field: fld.due,
        operator: 'is',
        value: { $date: { relative: 'days_ago', amount: 7 } },
      },
    },
    {
      name: 'field_ref',
      node: { field: fld.customer, operator: 'intersects', value: { field_ref: '__id' } },
    },
    {
      name: 'automation operator',
      node: { field: fld.status, operator: 'changed_to', value: opt.done },
    },
    {
      name: 'user list',
      node: {
        field: fld.owner,
        operator: 'is_exactly',
        value: [usr.an, { $var: 'current_user_groups' }],
      },
    },
    { name: 'depth 5', node: chain(5) },
    { name: '50 conditions', node: { op: 'or', items: Array.from({ length: 50 }, () => leaf()) } },
  ];

  it.each(valid)('accepts $name', ({ node }) => {
    expect(filterNodeSchema.safeParse(node).success).toBe(true);
  });

  const invalid: { name: string; node: unknown }[] = [
    { name: 'field name', node: { field: 'Status', operator: 'is' } },
    { name: 'unknown operator', node: { field: fld.title, operator: 'like' } },
    { name: 'unknown group op', node: { op: 'xor', items: [] } },
    { name: 'not with items', node: { op: 'not', items: [] } },
    { name: 'extra key', node: { field: fld.title, operator: 'is_empty', x: 1 } },
    {
      name: 'unknown variable',
      node: { field: fld.owner, operator: 'has_any_of', value: [{ $var: 'me' }] },
    },
    {
      name: 'bad exact date',
      node: { field: fld.due, operator: 'is', value: { $date: { exact: '2026-02-30' } } },
    },
    {
      name: 'relative needing amount',
      node: { field: fld.due, operator: 'is', value: { $date: { relative: 'days_from_now' } } },
    },
    {
      name: 'relative refusing amount',
      node: {
        field: fld.due,
        operator: 'is',
        value: { $date: { relative: 'this_week', amount: 1 } },
      },
    },
    {
      name: 'field_ref by name',
      node: { field: fld.title, operator: 'eq', value: { field_ref: 'Title' } },
    },
    { name: 'nested list', node: { field: fld.amount, operator: 'between', value: [[1], [2]] } },
    { name: 'depth 6', node: chain(6) },
    { name: '51 conditions', node: { op: 'or', items: Array.from({ length: 51 }, () => leaf()) } },
  ];

  it.each(invalid)('rejects $name', ({ node }) => {
    expect(filterNodeSchema.safeParse(node).success).toBe(false);
  });
});

describe('tree helpers', () => {
  const tree: FilterNode = {
    op: 'and',
    items: [
      { field: fld.title, operator: 'eq', value: { field_ref: fld.code } },
      {
        op: 'not',
        item: {
          op: 'or',
          items: [
            { field: fld.amount, operator: 'is_empty' },
            { field: fld.title, operator: 'eq', value: 'x' },
            { field: fld.customer, operator: 'intersects', value: { field_ref: '__id' } },
          ],
        },
      },
    ],
  };

  it('collectFieldIds returns distinct fields in first-seen order', () => {
    expect(collectFieldIds(tree)).toEqual([fld.title, fld.amount, fld.customer]);
    expect(collectFieldIds(null)).toEqual([]);
    expect(collectFieldIds(undefined)).toEqual([]);
  });

  it('collectFieldRefs returns field_ref targets', () => {
    expect(collectFieldRefs(tree)).toEqual([fld.code, '__id']);
  });

  it('forEachCondition visits depth first', () => {
    const seen: string[] = [];
    forEachCondition(tree, (condition) => seen.push(condition.operator));
    expect(seen).toEqual(['eq', 'is_empty', 'eq', 'intersects']);
  });

  it('measureFilter counts group depth and conditions', () => {
    expect(measureFilter(tree)).toEqual({ depth: 3, conditions: 4 });
    expect(measureFilter(leaf())).toEqual({ depth: 0, conditions: 1 });
    expect(measureFilter({ op: 'and', items: [] })).toEqual({ depth: 1, conditions: 0 });
  });
});

describe('operators', () => {
  it('classifies mode-specific operators', () => {
    for (const operator of LOOKUP_ONLY_OPERATORS) expect(isLookupOnlyOperator(operator)).toBe(true);
    for (const operator of AUTOMATION_ONLY_OPERATORS)
      expect(isAutomationOnlyOperator(operator)).toBe(true);
    expect(isLookupOnlyOperator('eq')).toBe(false);
    expect(isAutomationOnlyOperator('intersects')).toBe(false);
    expect(DSL_OPERATORS).toContain('has_all_of');
    expect(isDslOperator('between')).toBe(true);
    expect(isDslOperator('like')).toBe(false);
    expect(isDslOperator(1)).toBe(false);
  });
});

describe('parseExactDate', () => {
  it.each([
    ['2026-09-25', { year: 2026, month: 9, day: 25, time: null }],
    ['2026-09-25T09:30', { year: 2026, month: 9, day: 25, time: { hour: 9, minute: 30 } }],
    ['2028-02-29', { year: 2028, month: 2, day: 29, time: null }],
    ['2026-02-29', null],
    ['2026-00-10', null],
    ['2026-09-25T23:60', null],
    ['2026-09-25 09:30', null],
    ['25/09/2026', null],
  ])('%s', (text, expected) => {
    expect(parseExactDate(text)).toEqual(expected);
  });
});

describe('fieldProfile', () => {
  const profile = (field: Omit<FilterFieldMeta, 'id' | 'name'>) =>
    fieldProfile({ id: fld.title, name: 'x', ...field });

  it.each([
    { name: 'text', field: { type: 'text' }, group: 'text', element: 'scalar' },
    { name: 'auto_number', field: { type: 'auto_number' }, group: 'text', element: 'scalar' },
    { name: 'number', field: { type: 'number' }, group: 'number', element: 'scalar' },
    { name: 'datetime', field: { type: 'datetime' }, group: 'datetime', element: 'scalar' },
    { name: 'updated_at', field: { type: 'updated_at' }, group: 'datetime', element: 'scalar' },
    { name: 'checkbox', field: { type: 'checkbox' }, group: 'checkbox', element: 'scalar' },
    {
      name: 'single select (default options)',
      field: { type: 'select' },
      group: 'single_select',
      element: 'option',
    },
    {
      name: 'multi select',
      field: { type: 'select', options: { multiple: true } },
      group: 'multi',
      element: 'option',
    },
    { name: 'user', field: { type: 'user' }, group: 'multi', element: 'user' },
    { name: 'updated_by', field: { type: 'updated_by' }, group: 'multi', element: 'user' },
    { name: 'link', field: { type: 'link' }, group: 'multi', element: 'record' },
    { name: 'parent', field: { type: 'parent' }, group: 'multi', element: 'record' },
    { name: 'attachment', field: { type: 'attachment' }, group: 'attachment', element: 'scalar' },
    {
      name: 'formula → datetime',
      field: { type: 'formula', resultType: 'datetime' },
      group: 'datetime',
      element: 'scalar',
    },
    {
      name: 'formula → checkbox',
      field: { type: 'formula', resultType: 'checkbox' },
      group: 'checkbox',
      element: 'scalar',
    },
    {
      name: 'lookup → text list',
      field: { type: 'lookup', resultType: 'text', resultIsList: true },
      group: 'multi',
      element: 'text',
    },
    {
      name: 'lookup → user list',
      field: { type: 'lookup', resultType: 'user', resultIsList: true },
      group: 'multi',
      element: 'user',
    },
    {
      name: 'lookup → link list',
      field: { type: 'lookup', resultType: 'link', resultIsList: true },
      group: 'multi',
      element: 'record',
    },
    {
      name: 'lookup → attachment list',
      field: { type: 'lookup', resultType: 'attachment', resultIsList: true },
      group: 'attachment',
      element: 'scalar',
    },
    {
      name: 'lookup → single number',
      field: { type: 'lookup', resultType: 'number' },
      group: 'number',
      element: 'scalar',
    },
    {
      name: 'formula without result',
      field: { type: 'formula' },
      group: 'unsupported',
      element: 'scalar',
    },
    {
      name: 'formula → formula',
      field: { type: 'formula', resultType: 'formula' },
      group: 'unsupported',
      element: 'scalar',
    },
    {
      name: 'lookup → lookup list',
      field: { type: 'lookup', resultType: 'lookup', resultIsList: true },
      group: 'unsupported',
      element: 'scalar',
    },
  ] as const)('$name', ({ field, group, element }) => {
    const result = profile(field);
    expect({ group: result.group, element: result.element }).toEqual({ group, element });
  });

  it('computed lists of numbers, dates and booleans only filter on emptiness (T457)', () => {
    for (const resultType of ['number', 'datetime', 'checkbox'] as const) {
      expect(profile({ type: 'formula', resultType, resultIsList: true }).operators).toEqual([
        'is_empty',
        'is_not_empty',
      ]);
    }
    expect(
      profile({ type: 'formula', resultType: 'text', resultIsList: true }).operators,
    ).toContain('has_any_of');
  });

  it('uses the field-types operator lists', () => {
    expect(profile({ type: 'checkbox' }).operators).toEqual(['is']);
    expect(profile({ type: 'attachment' }).operators).toEqual(['is_empty', 'is_not_empty']);
    expect(profile({ type: 'link' }).operators).toContain('has_all_of');
    expect(profile({ type: 'formula' }).operators).toEqual([]);
  });
});
