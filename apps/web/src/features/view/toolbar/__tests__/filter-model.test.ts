import {
  fieldProfile,
  MAX_FILTER_CONDITIONS,
  MAX_FILTER_DEPTH,
  validateFilter,
  type DslOperator,
} from '@cellhive/filter-dsl';
import { describe, expect, it } from 'vitest';

import {
  appendTo,
  canAddCondition,
  canNestGroup,
  checkFilter,
  conditionCount,
  filterMetaOf,
  focusAfterRemoval,
  fromFilter,
  isInvertedRange,
  issuesByItem,
  newCondition,
  operatorsFor,
  toFilter,
  valueShapeOf,
  withOperator,
  type ConditionItem,
  type GroupItem,
  type OperandKind,
} from '../filter-model';
import { dateOperand, userOperand } from '../values';

import type { FieldDto } from '@cellhive/contracts';

const NOW = '2026-09-24T00:00:00.000Z';
const OPT_NEW = 'opt_NewAAAAAAAAAAAAA';
const OPT_DONE = 'opt_DoneAAAAAAAAAAAA';
const USER = 'usr_0123456789ABCDEF';

function field(id: string, type: string, options: unknown = {}, isPrimary = false): FieldDto {
  return {
    id,
    table_id: 'tbl_Tickets000000001',
    name: id.slice(4, 12),
    type,
    options,
    is_primary: isPrimary,
    required: false,
    unique_values: false,
    description: null,
    position: 0,
    created_at: NOW,
    updated_at: NOW,
  } as FieldDto;
}

const selectOptions = (multiple: boolean) => ({
  multiple,
  options: [
    { id: OPT_NEW, name: 'Mới', color: 1 },
    { id: OPT_DONE, name: 'Xong', color: 2 },
  ],
});

/** One field of every S1 type (and the system fields) the builder offers. */
const FIELDS: FieldDto[] = [
  field('fld_TextAAAAAAAAAAAA', 'text', {}, true),
  field('fld_NumberAAAAAAAAAA', 'number'),
  field('fld_PercentAAAAAAAAA', 'number', {
    style: { type: 'plain', precision: 0, percentage: true, thousands_separator: false },
  }),
  field('fld_DateAAAAAAAAAAAA', 'datetime', { style: { format: 'dd/MM/yyyy' } }),
  field('fld_DateTimeAAAAAAAA', 'datetime', { style: { format: 'dd/MM/yyyy HH:mm' } }),
  field('fld_CheckboxAAAAAAAA', 'checkbox'),
  field('fld_SelectAAAAAAAAAA', 'select', selectOptions(false)),
  field('fld_TagsAAAAAAAAAAAA', 'select', selectOptions(true)),
  field('fld_OwnerAAAAAAAAAAA', 'user', { multiple: false }),
  field('fld_OwnersAAAAAAAAAA', 'user', { multiple: true }),
  field('fld_AutoAAAAAAAAAAAA', 'auto_number'),
  field('fld_CreatedAtAAAAAAA', 'created_at'),
  field('fld_UpdatedAtAAAAAAA', 'updated_at'),
  field('fld_CreatedByAAAAAAA', 'created_by'),
  field('fld_UpdatedByAAAAAAA', 'updated_by'),
  // T413: link values are record ids picked in the linked table.
  field('fld_CustomerAAAAAAAA', 'link', { link_table: 'tbl_CustomersAAAAAAA' }),
];

/** A value of `kind` as the value editors produce it. */
function operand(kind: OperandKind, index = 0): unknown {
  switch (kind) {
    case 'text':
    case 'scalar':
      return `an phat ${String(index)}`;
    case 'number':
      return 1500 + index;
    case 'date':
      return index === 0
        ? dateOperand({ mode: 'exact', date: '2026-09-25' })
        : dateOperand({ mode: 'days_ago', amount: 7 });
    case 'boolean':
      return true;
    case 'option':
      return index === 0 ? OPT_NEW : OPT_DONE;
    case 'user':
      return index === 0 ? userOperand('$var:current_user') : userOperand(USER);
    case 'record':
      return index === 0 ? 'rec_A1b2C3d4E5f6G7h8' : 'rec_B1b2C3d4E5f6G7h8';
  }
}

function sampleValue(item: FieldDto, operator: DslOperator): unknown {
  const shape = valueShapeOf(item, operator);
  switch (shape.shape) {
    case 'none':
      return undefined;
    case 'one':
      return operand(shape.kind);
    case 'pair':
      return [operand(shape.kind, 0), operand(shape.kind, 1)];
    case 'list':
      return [operand(shape.kind, 0), operand(shape.kind, 1)];
  }
}

function rootOf(...items: GroupItem['items']): GroupItem {
  return { kind: 'group', id: 'root', op: 'and', items };
}

function condition(id: string, item: FieldDto, operator: DslOperator, value?: unknown) {
  return {
    kind: 'condition' as const,
    id,
    field: item.id,
    operator,
    ...(value === undefined ? {} : { value }),
  };
}

describe('operators per field type (filter-dsl, SPEC §6.2)', () => {
  it.each(FIELDS.map((item) => [item.type, item] as const))(
    '%s offers exactly the operators of filter-dsl',
    (_type, item) => {
      expect(operatorsFor(item)).toEqual(fieldProfile(filterMetaOf(item)).operators);
      expect(operatorsFor(item).length).toBeGreaterThan(0);
    },
  );

  it('offers the record operators on links, the empty checks on parents, nothing on unsupported types', () => {
    const link = field('fld_LinkAAAAAAAAAAAA', 'link', { link_table: 'tbl_LinkedAAAAAAAAAA' });
    expect(operatorsFor(link)).toEqual(fieldProfile(filterMetaOf(link)).operators);
    expect(operatorsFor(link)).toContain('has_any_of');
    expect(operatorsFor(field('fld_ParentAAAAAAAAAA', 'parent', {}))).toEqual([
      'is_empty',
      'is_not_empty',
    ]);
    expect(operatorsFor(field('fld_FormulaAAAAAAAAA', 'formula', {}))).toEqual([]);
  });
});

describe('the builder produces valid DSL for every type × operator', () => {
  const cases = FIELDS.flatMap((item) =>
    operatorsFor(item).map((operator) => [item.type, operator, item] as const),
  );

  it.each(cases)('%s %s', (_type, operator, item) => {
    const root = rootOf(condition('c', item, operator, sampleValue(item, operator)));
    const checked = checkFilter(root, FIELDS);
    expect(checked.issues).toEqual(new Map());
    expect(checked.incomplete.size).toBe(0);
    expect(checked.filter).not.toBeNull();
    // What is sent validates like the server validates it.
    const again = validateFilter(
      checked.filter,
      { fields: FIELDS.map(filterMetaOf) },
      FIELDS.map((candidate) => candidate.id),
    );
    expect(again.ok).toBe(true);
  });
});

describe('builder tree ⇄ DSL', () => {
  const text = FIELDS[0] as FieldDto;
  const number = FIELDS[1] as FieldDto;
  const status = FIELDS[6] as FieldDto;

  it('leaves out incomplete conditions and empty groups', () => {
    const root = rootOf(condition('a', text, 'contains', 'an'), condition('b', number, 'gt'), {
      kind: 'group',
      id: 'g',
      op: 'or',
      items: [condition('c', number, 'between', [1])],
    });
    const built = toFilter(root, FIELDS);
    expect(built.filter).toEqual({
      op: 'and',
      items: [{ field: text.id, operator: 'contains', value: 'an' }],
    });
    expect([...built.incomplete].sort()).toEqual(['b', 'c']);
    expect(toFilter(rootOf(), FIELDS).filter).toBeNull();
  });

  it('keeps nested groups and maps DSL paths to items', () => {
    const root = rootOf(condition('a', text, 'is_empty'), {
      kind: 'group',
      id: 'g',
      op: 'or',
      items: [condition('b', status, 'is', OPT_NEW), condition('c', number, 'lt', 5)],
    });
    const built = toFilter(root, FIELDS);
    expect(built.filter).toEqual({
      op: 'and',
      items: [
        { field: text.id, operator: 'is_empty' },
        {
          op: 'or',
          items: [
            { field: status.id, operator: 'is', value: OPT_NEW },
            { field: number.id, operator: 'lt', value: 5 },
          ],
        },
      ],
    });
    expect(Object.fromEntries(built.paths)).toEqual({
      '': 'root',
      'items[0]': 'a',
      'items[1]': 'g',
      'items[1].items[0]': 'b',
      'items[1].items[1]': 'c',
    });
    // Server issues (`filter.` prefix) and client ones land on the deepest item.
    expect(
      Object.fromEntries(
        issuesByItem(
          [
            { path: 'filter.items[1].items[1].value', code: 'INVALID_VALUE' },
            { path: 'items[0].field', code: 'UNKNOWN_FIELD' },
            { path: 'filter', code: 'MAX_CONDITIONS_EXCEEDED' },
          ],
          built.paths,
        ),
      ),
    ).toEqual({
      c: ['INVALID_VALUE'],
      a: ['UNKNOWN_FIELD'],
      root: ['MAX_CONDITIONS_EXCEEDED'],
    });
  });

  it('reads a saved filter back, `not` nodes kept as they are', () => {
    const saved = {
      op: 'or',
      items: [
        { field: status.id, operator: 'is', value: OPT_DONE },
        { op: 'not', item: { field: text.id, operator: 'is_empty' } },
      ],
    };
    const root = fromFilter(saved);
    expect(root.op).toBe('or');
    expect(root.items.map((item) => item.kind)).toEqual(['condition', 'raw']);
    expect(toFilter(root, FIELDS).filter).toEqual(saved);
    // A lone condition becomes a root group of one.
    expect(fromFilter({ field: text.id, operator: 'is_empty' }).items).toHaveLength(1);
    expect(fromFilter(null).items).toEqual([]);
  });

  it('reports fields the user cannot read and missing options on the condition', () => {
    const root = rootOf(
      condition('hidden', field('fld_CostAAAAAAAAAAAA', 'number'), 'gt', 5),
      condition('gone', status, 'is', 'opt_GoneAAAAAAAAAAAA'),
    );
    const checked = checkFilter(root, FIELDS);
    expect(Object.fromEntries(checked.issues)).toEqual({
      hidden: ['UNKNOWN_FIELD'],
      gone: ['INVALID_SELECT_OPTION'],
    });
  });

  it('keeps a value when the new operator takes the same kind, else clears it', () => {
    const start = condition('a', number, 'gt', 5) as ConditionItem;
    expect(withOperator(start, number, 'lte').value).toBe(5);
    expect(withOperator(start, number, 'between').value).toBeUndefined();
    expect(withOperator(start, number, 'is_empty').value).toBeUndefined();
    const checkbox = FIELDS[5] as FieldDto;
    expect(newCondition(checkbox)).toMatchObject({ operator: 'is', value: true });
    expect(newCondition(text).operator).toBe('contains');
    expect(newCondition(status).operator).toBe('is');
  });

  it('enforces the filter-dsl limits: 50 conditions, 5 levels', () => {
    let root = rootOf();
    for (let index = 0; index < MAX_FILTER_CONDITIONS; index += 1) {
      root = appendTo(root, 'root', newCondition(text));
    }
    expect(conditionCount(root)).toBe(MAX_FILTER_CONDITIONS);
    expect(canAddCondition(root)).toBe(false);
    expect(canNestGroup(MAX_FILTER_DEPTH - 1)).toBe(true);
    expect(canNestGroup(MAX_FILTER_DEPTH)).toBe(false);
  });
});

describe('inverted ranges (T320 QA)', () => {
  it('spots numbers and exact dates the wrong way round, not relative dates', () => {
    expect(isInvertedRange([500, 10])).toBe(true);
    expect(isInvertedRange([10, 500])).toBe(false);
    expect(isInvertedRange([10, 10])).toBe(false);
    expect(
      isInvertedRange([{ $date: { exact: '2026-09-30' } }, { $date: { exact: '2026-09-01' } }]),
    ).toBe(true);
    expect(isInvertedRange(['2026-09-01', '2026-09-30'])).toBe(false);
    expect(
      isInvertedRange([{ $date: { relative: 'today' } }, { $date: { exact: '2020-01-01' } }]),
    ).toBe(false);
    expect(isInvertedRange([1])).toBe(false);
  });
});

describe('focusAfterRemoval', () => {
  const root: GroupItem = {
    kind: 'group',
    id: 'root',
    op: 'and',
    items: [
      { kind: 'condition', id: 'a', field: 'f', operator: 'is_empty' },
      {
        kind: 'group',
        id: 'g',
        op: 'or',
        items: [{ kind: 'condition', id: 'b', field: 'f', operator: 'is_empty' }],
      },
      { kind: 'condition', id: 'c', field: 'f', operator: 'is_empty' },
    ],
  };
  it("picks the next item, else the previous one, else the group's add button", () => {
    expect(focusAfterRemoval(root, 'a')).toEqual({ kind: 'item', id: 'g' });
    expect(focusAfterRemoval(root, 'c')).toEqual({ kind: 'item', id: 'g' });
    expect(focusAfterRemoval(root, 'b')).toEqual({ kind: 'add', id: 'g' });
    expect(focusAfterRemoval(root, 'missing')).toBeNull();
  });
});
