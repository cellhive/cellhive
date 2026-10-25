import { lookupToAst, type LookupWhere } from '@cellhive/formula-engine';
import { describe, expect, it } from 'vitest';

import {
  buildWhere,
  conditionFields,
  conditionsOf,
  constantAllowed,
  recordIdField,
  EMPTY_CONDITIONS,
  initialValue,
  isComplete,
  issuesByKey,
  lookupGroupOf,
  lookupOperators,
  normalizeOperator,
  operatorLabelKey,
  refAllowed,
  refChoices,
  THIS_RECORD_REF,
  valueShape,
  withOperator,
  type LookupConditionDraft,
  type LookupConditionsDraft,
} from '../lookup-where';

import type { FieldDto } from '@cellhive/contracts';
import type { DslOperator } from '@cellhive/filter-dsl';

const NOW = '2026-09-28T00:00:00.000Z';
const CUSTOMERS = 'tbl_Customers00000001';
const ORDERS = 'tbl_Orders0000000001';
const DONE = 'opt_Done000000000001';
const OPEN = 'opt_Open000000000001';
const USER = 'usr_0123456789ABCDEF';

function field(
  id: string,
  type: string,
  options: Record<string, unknown> = {},
  extra: Partial<FieldDto> = {},
): FieldDto {
  return {
    id: id as FieldDto['id'],
    table_id: ORDERS,
    name: id.slice(4, 12),
    type: type as FieldDto['type'],
    options,
    is_primary: false,
    required: false,
    unique_values: false,
    description: null,
    position: 0,
    created_at: NOW,
    updated_at: NOW,
    ...extra,
  };
}

// Source table: Orders.
const TITLE = field('fld_OTitle0000000001', 'text', {}, { is_primary: true });
const AMOUNT = field('fld_Amount0000000001', 'number', {
  style: { type: 'currency', currency_code: 'VND' },
});
const DUE = field('fld_Due0000000000001', 'datetime', { style: { format: 'dd/MM/yyyy' } });
const PAID = field('fld_Paid000000000001', 'checkbox');
const STATUS = field('fld_Status0000000001', 'select', {
  multiple: false,
  options: [
    { id: OPEN, name: 'Open', color: 0 },
    { id: DONE, name: 'Done', color: 1 },
  ],
});
const TAGS = field('fld_Tags000000000001', 'select', {
  multiple: true,
  options: [{ id: DONE, name: 'Done', color: 1 }],
});
const OWNER = field('fld_Owner00000000001', 'user', { multiple: true });
const CUSTOMER = field('fld_Customer00000001', 'link', {
  link_table: CUSTOMERS,
  allow_multiple: false,
});
const FILES = field('fld_Files00000000001', 'attachment');
const TOTAL = field(
  'fld_Total00000000001',
  'formula',
  { style: null },
  { result_type: { kind: 'number', list: false } },
);
const SOURCE = [TITLE, AMOUNT, DUE, PAID, STATUS, TAGS, OWNER, CUSTOMER, FILES, TOTAL];

// Current table: Customers.
const NAME = field('fld_CName00000000001', 'text', {}, { table_id: CUSTOMERS, is_primary: true });
const CODE = field('fld_CCode00000000001', 'auto_number', {}, { table_id: CUSTOMERS });
const LIMIT = field('fld_CLimit0000000001', 'number', {}, { table_id: CUSTOMERS });
const SINCE = field('fld_CSince0000000001', 'datetime', {}, { table_id: CUSTOMERS });
const TIER = field(
  'fld_CTier0000000001x',
  'select',
  { multiple: false, options: [] },
  { table_id: CUSTOMERS },
);
const ORDERS_LINK = field(
  'fld_COrders000000001',
  'link',
  { link_table: ORDERS },
  { table_id: CUSTOMERS },
);
const CURRENT = [NAME, CODE, LIMIT, SINCE, TIER, ORDERS_LINK];

function condition(
  source: FieldDto,
  operator: DslOperator,
  value: LookupConditionDraft['value'],
): LookupConditionDraft {
  return { key: `k_${source.id}_${operator}`, field: source.id, operator, value };
}

describe('lookup-where: groups and operators', () => {
  it.each([
    [TITLE, 'text'],
    [AMOUNT, 'number'],
    [DUE, 'datetime'],
    [PAID, 'checkbox'],
    [STATUS, 'single_select'],
    [TAGS, 'multi'],
    [OWNER, 'multi'],
    [CUSTOMER, 'link'],
    [FILES, 'none'],
    [TOTAL, 'number'],
  ])('%o is in group %s', (source, group) => {
    expect(lookupGroupOf(source)).toBe(group);
  });

  it('lists only fields usable in a condition', () => {
    expect(conditionFields(SOURCE).map((item) => item.id)).not.toContain(FILES.id);
  });

  it('never offers intersects/disjoint by name (decision #7)', () => {
    for (const source of conditionFields(SOURCE)) {
      expect(lookupOperators(source)).not.toContain('intersects');
      expect(lookupOperators(source)).not.toContain('disjoint');
    }
  });

  it('keeps a stored operator that is not offered, first', () => {
    expect(lookupOperators(TITLE, 'intersects')[0]).toBe('intersects');
  });

  it.each([
    [TITLE, 'intersects', 'is_any_of'],
    [TITLE, 'disjoint', 'is_none_of'],
    [AMOUNT, 'intersects', 'is_any_of'],
    [TAGS, 'intersects', 'has_any_of'],
    [CUSTOMER, 'intersects', 'has_any_of'],
    [OWNER, 'disjoint', 'has_none_of'],
    [STATUS, 'eq', 'eq'],
  ] as const)('labels %o %s with the filter key %s', (source, operator, key) => {
    expect(operatorLabelKey(source, operator)).toBe(key);
  });

  it.each([
    [STATUS, 'intersects', 'is_any_of'],
    [STATUS, 'disjoint', 'is_none_of'],
    [TAGS, 'intersects', 'has_any_of'],
    [CUSTOMER, 'intersects', 'has_any_of'],
    [CUSTOMER, 'disjoint', 'has_none_of'],
    [TITLE, 'intersects', 'intersects'],
    [AMOUNT, 'eq', 'eq'],
  ] as const)('normalizes %o %s to %s', (source, operator, expected) => {
    expect(normalizeOperator(source, operator)).toBe(expected);
  });

  it.each([
    ['is_empty', 'none'],
    ['between', 'pair'],
    ['has_any_of', 'list'],
    ['intersects', 'list'],
    ['eq', 'one'],
  ] as const)('%s takes %s value', (operator, shape) => {
    expect(valueShape(operator)).toBe(shape);
  });
});

describe('lookup-where: field_ref choices (server checkLookupFieldRefs)', () => {
  const ids = (source: FieldDto) => {
    const choices = refChoices(source, CURRENT);
    return { record: choices.record, fields: choices.fields.map((item) => item.id) };
  };

  it('text compares with text, numbers, dates, ids and this record', () => {
    expect(ids(TITLE)).toEqual({
      record: true,
      fields: [NAME.id, CODE.id, LIMIT.id, SINCE.id, TIER.id],
    });
  });
  it('numbers compare with numbers only', () => {
    expect(ids(AMOUNT)).toEqual({ record: false, fields: [LIMIT.id] });
  });
  it('dates compare with dates only', () => {
    expect(ids(DUE)).toEqual({ record: false, fields: [SINCE.id] });
  });
  it('links compare with this record, text and ids (never with link fields)', () => {
    expect(ids(CUSTOMER)).toEqual({ record: true, fields: [NAME.id, CODE.id, TIER.id] });
  });
  it('checkbox and computed fields take constants only', () => {
    expect(refAllowed(PAID, 'is')).toBe(false);
    expect(refAllowed(TOTAL, 'eq')).toBe(false);
  });
  it('no field_ref without a value or with between', () => {
    expect(refAllowed(AMOUNT, 'is_empty')).toBe(false);
    expect(refAllowed(AMOUNT, 'between')).toBe(false);
    expect(refAllowed(AMOUNT, 'gt')).toBe(true);
  });
});

describe('lookup-where: the source record in a link of this table (__id)', () => {
  const record = recordIdField(ORDERS, 'Record of Orders');
  it('compares with the links of this table to the source table only', () => {
    expect(lookupGroupOf(record)).toBe('record');
    expect(lookupOperators(record)).toEqual(['is_any_of', 'is_none_of']);
    expect(constantAllowed(record)).toBe(false);
    expect(refChoices(record, CURRENT)).toEqual({ record: false, fields: [ORDERS_LINK] });
    expect(conditionFields([record, ...SOURCE])).not.toContainEqual(record);
  });
  it.each(['is_any_of', 'is_none_of'] as const)('%s builds and validates', (operator) => {
    const built = buildWhere(
      {
        op: 'and',
        conditions: [condition(record, operator, { kind: 'ref', ref: ORDERS_LINK.id })],
      },
      SOURCE,
      CURRENT,
    );
    expect(built.issues.size).toBe(0);
    expect(built.where).toEqual({
      op: 'and',
      items: [{ field: '__id', operator, value: { field_ref: ORDERS_LINK.id } }],
    });
  });
  it('reads back from a stored where', () => {
    const parsed = conditionsOf(
      { field: '__id', operator: 'is_any_of', value: { field_ref: ORDERS_LINK.id } },
      SOURCE,
    );
    expect(parsed.conditions[0]).toMatchObject({
      field: '__id',
      operator: 'is_any_of',
      value: { kind: 'ref', ref: ORDERS_LINK.id },
    });
  });
});

describe('lookup-where: new conditions', () => {
  it('a link to this table starts with "This record"', () => {
    const link = field('fld_Back000000000001', 'link', { link_table: CUSTOMERS });
    expect(initialValue(link, 'has_any_of', CUSTOMERS)).toEqual({
      kind: 'ref',
      ref: THIS_RECORD_REF,
    });
    expect(initialValue(CUSTOMER, 'has_any_of', ORDERS)).toEqual({ kind: 'ref', ref: '' });
  });
  it('a checkbox starts checked', () => {
    expect(initialValue(PAID, 'is', CUSTOMERS)).toEqual({ kind: 'constant', value: true });
  });
  it('changing the operator keeps a value that still fits and drops the auto badge', () => {
    const auto = { ...condition(STATUS, 'is_any_of', { kind: 'ref', ref: TIER.id }), auto: true };
    const next = withOperator(auto, STATUS, 'is_none_of', CUSTOMERS);
    expect(next.value).toEqual({ kind: 'ref', ref: TIER.id });
    expect(next.auto).toBeUndefined();
    const constant = condition(AMOUNT, 'gt', { kind: 'constant', value: 5 });
    expect(withOperator(constant, AMOUNT, 'lt', CUSTOMERS).value).toEqual({
      kind: 'constant',
      value: 5,
    });
    expect(withOperator(constant, AMOUNT, 'between', CUSTOMERS).value).toEqual({
      kind: 'constant',
    });
    expect(withOperator(constant, AMOUNT, 'is_empty', CUSTOMERS).value).toEqual({
      kind: 'constant',
    });
  });
  it.each([
    [condition(AMOUNT, 'gt', { kind: 'constant' }), false],
    [condition(AMOUNT, 'gt', { kind: 'constant', value: 0 }), true],
    [condition(AMOUNT, 'between', { kind: 'constant', value: [1, undefined] }), false],
    [condition(AMOUNT, 'between', { kind: 'constant', value: [1, 2] }), true],
    [condition(TITLE, 'eq', { kind: 'constant', value: '  ' }), false],
    [condition(TITLE, 'is_empty', { kind: 'constant' }), true],
    [condition(CUSTOMER, 'has_any_of', { kind: 'ref', ref: '' }), false],
    [condition(CUSTOMER, 'has_any_of', { kind: 'ref', ref: THIS_RECORD_REF }), true],
    [condition(STATUS, 'is_any_of', { kind: 'constant', value: [] }), false],
  ])('isComplete(%o) = %s', (item, expected) => {
    const source = SOURCE.find((candidate) => candidate.id === item.field);
    expect(isComplete(item, source)).toBe(expected);
  });
});

describe('lookup-where: DSL', () => {
  const draft = (
    conditions: LookupConditionDraft[],
    op: 'and' | 'or' = 'and',
  ): LookupConditionsDraft => ({ op, conditions });

  it('builds the SPEC §5.8 example as a group', () => {
    const built = buildWhere(
      draft([
        condition(CUSTOMER, 'has_any_of', { kind: 'ref', ref: THIS_RECORD_REF }),
        condition(STATUS, 'is_any_of', { kind: 'constant', value: [DONE] }),
      ]),
      SOURCE,
      CURRENT,
    );
    expect(built.where).toEqual({
      op: 'and',
      items: [
        { field: CUSTOMER.id, operator: 'has_any_of', value: { field_ref: '__id' } },
        { field: STATUS.id, operator: 'is_any_of', value: [DONE] },
      ],
    });
    expect(built.issues.size).toBe(0);
  });

  it('leaves incomplete conditions out and lists them', () => {
    const empty = condition(AMOUNT, 'gt', { kind: 'constant' });
    const built = buildWhere(
      draft([empty, condition(TITLE, 'is_not_empty', { kind: 'constant' })], 'or'),
      SOURCE,
      CURRENT,
    );
    expect(built.incomplete).toEqual(new Set([empty.key]));
    expect(built.where).toEqual({
      op: 'or',
      items: [{ field: TITLE.id, operator: 'is_not_empty' }],
    });
  });

  it('no complete condition: no where', () => {
    expect(buildWhere(EMPTY_CONDITIONS, SOURCE, CURRENT).where).toBeNull();
  });

  it('places validation issues on the condition (unknown field_ref)', () => {
    const bad = condition(TITLE, 'eq', { kind: 'ref', ref: 'fld_Gone000000000001' });
    const built = buildWhere(draft([bad]), SOURCE, CURRENT);
    expect(built.where).toBeNull();
    expect(built.issues.get(bad.key)).toEqual(['UNKNOWN_FIELD_REF']);
  });

  it('keeps an advanced stored where as is', () => {
    const stored = { op: 'not', item: { field: TITLE.id, operator: 'is_empty' } };
    const parsed = conditionsOf(stored, SOURCE);
    expect(parsed.conditions).toEqual([]);
    expect(buildWhere(parsed, SOURCE, CURRENT).where).toEqual(stored);
  });

  it('reads a stored where back (intersects on a link shown as has any of)', () => {
    const parsed = conditionsOf(
      {
        op: 'or',
        items: [
          { field: CUSTOMER.id, operator: 'intersects', value: { field_ref: '__id' } },
          { field: AMOUNT.id, operator: 'gte', value: 1000 },
        ],
      },
      SOURCE,
    );
    expect(parsed.op).toBe('or');
    expect(parsed.conditions.map((item) => [item.operator, item.value])).toEqual([
      ['has_any_of', { kind: 'ref', ref: '__id' }],
      ['gte', { kind: 'constant', value: 1000 }],
    ]);
    const single = conditionsOf({ field: TITLE.id, operator: 'is_empty' }, SOURCE);
    expect(single.conditions).toHaveLength(1);
  });

  it.each([
    [[{ path: 'items[1].value', code: 'INVALID_VALUE' }], 'b'],
    [[{ path: 'options.where.items.0.value.field_ref', code: 'INVALID_LOOKUP' }], 'a'],
    [[{ path: 'options.where', code: 'EMPTY_FILTER' }], ''],
  ])('issuesByKey(%o) → %s', (issues, key) => {
    expect([...issuesByKey(issues, ['a', 'b']).keys()]).toEqual([key]);
  });
});

/**
 * Every operator offered, with a constant and with each field_ref allowed,
 * validates like the server and compiles with the formula engine (the
 * operators the dialog offers never fail on save).
 */
describe('lookup-where: offered operators compile (lookupToAst)', () => {
  const snapshotField = (item: FieldDto) => ({
    id: item.id,
    name: item.name,
    type: item.type,
    options: item.options,
    ...(item.type === 'link'
      ? { linkTableId: (item.options as { link_table: string }).link_table }
      : {}),
    ...(item.result_type === undefined
      ? {}
      : { resultType: { kind: item.result_type.kind } as never }),
  });
  const snapshot = {
    tableId: CUSTOMERS,
    tables: [
      { id: CUSTOMERS, name: 'Customers', fields: CURRENT.map(snapshotField) },
      { id: ORDERS, name: 'Orders', fields: SOURCE.map(snapshotField) },
    ],
  };
  const constants: Record<string, unknown> = {
    text: 'An',
    number: 5,
    datetime: { $date: { exact: '2026-09-01' } },
    checkbox: true,
    single_select: DONE,
    multi: DONE,
  };
  const cases: [string, LookupConditionDraft][] = [];
  for (const source of conditionFields(SOURCE)) {
    const group = lookupGroupOf(source);
    for (const operator of lookupOperators(source)) {
      const shape = valueShape(operator);
      if (shape === 'none') {
        cases.push([
          `${source.name} ${operator}`,
          condition(source, operator, { kind: 'constant' }),
        ]);
        continue;
      }
      if (source.type !== 'link') {
        let value: unknown = group === 'multi' && source.type === 'user' ? USER : constants[group];
        if (shape === 'list') value = [value];
        if (shape === 'pair') value = [value, value];
        if (!(group === 'datetime' && shape === 'list')) {
          cases.push([
            `${source.name} ${operator} constant`,
            condition(source, operator, { kind: 'constant', value }),
          ]);
        }
      }
      if (!refAllowed(source, operator)) continue;
      const refs = refChoices(source, CURRENT);
      for (const ref of [
        ...(refs.record ? [THIS_RECORD_REF] : []),
        ...refs.fields.map((item) => item.id),
      ]) {
        cases.push([
          `${source.name} ${operator} field_ref ${ref}`,
          condition(source, operator, { kind: 'ref', ref }),
        ]);
      }
    }
  }

  it.each(cases)('%s', (_name, item) => {
    const built = buildWhere({ op: 'and', conditions: [item] }, SOURCE, CURRENT);
    expect(built.issues.size).toBe(0);
    expect(built.where).not.toBeNull();
    expect(() =>
      lookupToAst(
        { from: ORDERS, select: AMOUNT.id, where: built.where as unknown as LookupWhere },
        snapshot,
      ),
    ).not.toThrow();
  });
});
