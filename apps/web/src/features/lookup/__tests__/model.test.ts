import { describe, expect, it } from 'vitest';

import { THIS_RECORD_REF } from '../../../lib/schema/lookup-where';
import {
  aggregatesFor,
  applyShortcut,
  buildOptions,
  changedOptions,
  cycleOf,
  EMPTY_LOOKUP,
  errorTargetOf,
  hasDefinition,
  linkShortcuts,
  lookupDraftOf,
  resultKindOf,
  styleChoiceOf,
  styleChoicesFor,
  styleOf,
  withSelect,
  withSource,
  type LinkShortcut,
  type LookupDraft,
} from '../model';

import type { FieldDto, TableDto } from '@cellhive/contracts';

const NOW = '2026-09-28T00:00:00.000Z';
const CUSTOMERS = 'tbl_Customers00000001';
const ORDERS = 'tbl_Orders0000000001';
const ITEMS = 'tbl_Items00000000001';
const DONE = 'opt_Done000000000001';

function table(id: string, name: string): TableDto {
  return {
    id,
    base_id: 'bse_0123456789ABCDEF',
    name,
    description: null,
    primary_field_id: 'fld_Primary000000001',
    position: 0,
    created_at: NOW,
    updated_at: NOW,
  } as unknown as TableDto;
}

function field(
  id: string,
  tableId: string,
  type: string,
  options: Record<string, unknown> = {},
  extra: Partial<FieldDto> = {},
): FieldDto {
  return {
    id: id as FieldDto['id'],
    table_id: tableId as FieldDto['table_id'],
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

const TABLES = [table(CUSTOMERS, 'Customers'), table(ORDERS, 'Orders'), table(ITEMS, 'Items')];

// Orders: amount (VND), status, one-way link to Customers, two-way link to Items.
const AMOUNT = field('fld_Amount0000000001', ORDERS, 'number', {
  style: { type: 'currency', currency_code: 'VND' },
});
const DUE = field('fld_Due0000000000001', ORDERS, 'datetime', { style: { format: 'dd/MM/yyyy' } });
const NOTE = field('fld_Note000000000001', ORDERS, 'text');
const STATUS = field('fld_Status0000000001', ORDERS, 'select', {
  multiple: false,
  options: [{ id: DONE, name: 'Done', color: 1 }],
});
const CUSTOMER = field('fld_Customer00000001', ORDERS, 'link', {
  link_table: CUSTOMERS,
  bidirectional: false,
  symmetric_field_id: null,
});
const ORDER_ITEMS = field('fld_OItems0000000001', ORDERS, 'link', {
  link_table: ITEMS,
  bidirectional: true,
  symmetric_field_id: 'fld_IOrder0000000001',
});
const ORDER_FIELDS = [AMOUNT, DUE, NOTE, STATUS, CUSTOMER, ORDER_ITEMS];
// Items: reverse field of the two-way link.
const ITEM_ORDER = field('fld_IOrder0000000001', ITEMS, 'link', {
  link_table: ORDERS,
  bidirectional: true,
  symmetric_field_id: ORDER_ITEMS.id,
});
const PRICE = field('fld_IPrice0000000001', ITEMS, 'number');
const ITEM_FIELDS = [ITEM_ORDER, PRICE];
// Customers: a one-way link to Items.
const FAVOURITE = field('fld_CFav000000000001', CUSTOMERS, 'link', {
  link_table: ITEMS,
  bidirectional: false,
});
const NAME = field('fld_CName00000000001', CUSTOMERS, 'text', {}, { is_primary: true });
const CUSTOMER_FIELDS = [NAME, FAVOURITE];

const fieldsOf = (id: string) =>
  ({ [ORDERS]: ORDER_FIELDS, [ITEMS]: ITEM_FIELDS, [CUSTOMERS]: CUSTOMER_FIELDS })[id];

describe('lookup model: aggregations and formats', () => {
  it.each([
    [AMOUNT, ['raw_value', 'unique', 'sum', 'average', 'max', 'min', 'counta', 'unique_counta']],
    [DUE, ['raw_value', 'unique', 'max', 'min', 'counta', 'unique_counta']],
    [NOTE, ['raw_value', 'unique', 'counta', 'unique_counta']],
    [CUSTOMER, ['raw_value', 'unique', 'counta', 'unique_counta']],
    [undefined, ['raw_value', 'unique', 'counta', 'unique_counta']],
  ])('aggregatesFor(%o)', (source, expected) => {
    expect(aggregatesFor(source)).toEqual(expected);
  });

  it.each([
    [AMOUNT, 'raw_value', 'values'],
    [AMOUNT, 'sum', 'number'],
    [DUE, 'max', 'date'],
    [NOTE, 'counta', 'number'],
  ] as const)('resultKindOf(%o, %s) = %s', (source, aggregate, kind) => {
    expect(resultKindOf(source, aggregate)).toBe(kind);
  });

  it('offers the source format first, locked for values', () => {
    expect(styleChoicesFor(AMOUNT, 'raw_value', ['dd/MM/yyyy'], 'source')).toEqual(['source']);
    expect(styleChoicesFor(AMOUNT, 'sum', ['dd/MM/yyyy'], 'source')[0]).toBe('source');
    expect(styleChoicesFor(DUE, 'max', ['dd/MM/yyyy'], 'source')).toEqual([
      'source',
      'date:dd/MM/yyyy',
    ]);
  });

  const draft = (patch: Partial<LookupDraft>): LookupDraft => ({ ...EMPTY_LOOKUP, ...patch });

  it.each([
    // The milestone: a sum of VND amounts reads as a VND currency by default.
    [draft({ aggregate: 'sum' }), AMOUNT, { type: 'currency', currency_code: 'VND' }],
    [draft({ aggregate: 'raw_value' }), AMOUNT, { type: 'currency', currency_code: 'VND' }],
    [draft({ aggregate: 'counta' }), AMOUNT, null],
    [draft({ aggregate: 'raw_value' }), NOTE, null],
    [draft({ aggregate: 'max' }), DUE, { format: 'dd/MM/yyyy' }],
    [
      draft({ aggregate: 'average', style: 'number:decimal' }),
      AMOUNT,
      { type: 'plain', precision: 2, percentage: false, thousands_separator: true },
    ],
    [
      draft({ aggregate: 'counta', style: 'number:currency' }),
      NOTE,
      { type: 'currency', currency_code: 'USD' },
    ],
    [draft({ aggregate: 'min', style: 'date:yyyy-MM-dd' }), DUE, { format: 'yyyy-MM-dd' }],
    [
      draft({ aggregate: 'sum', style: 'custom', savedStyle: { type: 'rating', max: 5 } }),
      AMOUNT,
      { type: 'rating', max: 5 },
    ],
  ])('styleOf(%o)', (value, source, expected) => {
    expect(styleOf(value, source, 'USD')).toEqual(expected);
  });

  it.each([
    [null, 'source'],
    [{ type: 'currency', currency_code: 'VND' }, 'number:currency'],
    [{ type: 'plain', precision: 2 }, 'number:decimal'],
    [{ type: 'plain', percentage: true }, 'number:percent'],
    [{ type: 'plain', precision: 0 }, 'number:plain'],
    [{ format: 'dd/MM/yyyy' }, 'date:dd/MM/yyyy'],
    [{ type: 'progress' }, 'custom'],
  ])('styleChoiceOf(%o) = %s', (style, choice) => {
    expect(styleChoiceOf(style)).toBe(choice);
  });

  it('a new field taken keeps a valid aggregation only', () => {
    const summed = draft({ aggregate: 'sum', style: 'number:percent' });
    expect(withSelect(summed, AMOUNT)).toMatchObject({ aggregate: 'sum', style: 'source' });
    expect(withSelect(summed, NOTE)).toMatchObject({ aggregate: 'raw_value', select: NOTE.id });
  });

  it('another source table resets field, conditions and shortcut', () => {
    const before = draft({ from: ORDERS, select: AMOUNT.id, shortcut: 'x' });
    expect(withSource(before, ITEMS)).toMatchObject({
      from: ITEMS,
      select: '',
      shortcut: null,
      conditions: { conditions: [] },
    });
    expect(withSource(before, ORDERS)).toBe(before);
  });
});

describe('lookup model: "through a link field"', () => {
  const summary = (item: LinkShortcut) => [
    item.key,
    item.sourceTable.id,
    item.condition.field,
    item.condition.operator,
    item.condition.ref,
  ];

  it('lists own links (two-way: reverse field, one-way: record ID) and links pointing here', () => {
    expect(linkShortcuts(CUSTOMERS, CUSTOMER_FIELDS, TABLES, fieldsOf).map(summary)).toEqual([
      // One-way link of this table: the records it links to (CONTRACTS §13).
      [`out:${FAVOURITE.id}`, ITEMS, '__id', 'is_any_of', FAVOURITE.id],
      // Orders.customer is one-way, pointing at Customers: usable from Customers.
      [`in:${CUSTOMER.id}`, ORDERS, CUSTOMER.id, 'has_any_of', '__id'],
    ]);
    expect(linkShortcuts(ORDERS, ORDER_FIELDS, TABLES, fieldsOf).map(summary)).toEqual([
      [`out:${CUSTOMER.id}`, CUSTOMERS, '__id', 'is_any_of', CUSTOMER.id],
      // Two-way: condition on the reverse field; not listed again as incoming.
      [`out:${ORDER_ITEMS.id}`, ITEMS, ITEM_ORDER.id, 'has_any_of', '__id'],
    ]);
  });

  it('a one-way link of this table makes a record ID condition, sent as is', () => {
    const [own] = linkShortcuts(ORDERS, ORDER_FIELDS, TABLES, fieldsOf);
    if (own === undefined) throw new Error('no shortcut');
    const next = { ...applyShortcut(EMPTY_LOOKUP, own), select: NAME.id };
    expect(next.conditions.conditions).toMatchObject([
      {
        field: '__id',
        operator: 'is_any_of',
        value: { kind: 'ref', ref: CUSTOMER.id },
        auto: true,
      },
    ]);
    expect(buildOptions(next, CUSTOMER_FIELDS, ORDER_FIELDS, 'USD').options).toMatchObject({
      from: CUSTOMERS,
      where: {
        op: 'and',
        items: [{ field: '__id', operator: 'is_any_of', value: { field_ref: CUSTOMER.id } }],
      },
    });
  });

  it('makes the first condition "<link> has any of This record"', () => {
    const [shortcut] = linkShortcuts(CUSTOMERS, CUSTOMER_FIELDS, TABLES, fieldsOf).slice(1);
    if (shortcut === undefined) throw new Error('no shortcut');
    const next = applyShortcut(EMPTY_LOOKUP, shortcut);
    expect(next.from).toBe(ORDERS);
    expect(next.shortcut).toBe(shortcut.key);
    expect(next.conditions.conditions).toMatchObject([
      {
        field: CUSTOMER.id,
        operator: 'has_any_of',
        value: { kind: 'ref', ref: THIS_RECORD_REF },
        auto: true,
      },
    ]);
    // Same source again: other conditions stay, the old auto one is replaced.
    const withStatus: LookupDraft = {
      ...next,
      conditions: {
        ...next.conditions,
        conditions: [
          ...next.conditions.conditions,
          {
            key: 'k2',
            field: STATUS.id,
            operator: 'is_any_of',
            value: { kind: 'constant', value: [DONE] },
          },
        ],
      },
    };
    const again = applyShortcut(withStatus, shortcut);
    expect(again.conditions.conditions.map((item) => item.field)).toEqual([CUSTOMER.id, STATUS.id]);
  });
});

describe('lookup model: options', () => {
  const complete: LookupDraft = {
    ...EMPTY_LOOKUP,
    from: ORDERS,
    select: AMOUNT.id,
    aggregate: 'sum',
    conditions: {
      op: 'and',
      conditions: [
        {
          key: 'a',
          field: CUSTOMER.id,
          operator: 'has_any_of',
          value: { kind: 'ref', ref: '__id' },
        },
        {
          key: 'b',
          field: STATUS.id,
          operator: 'is_any_of',
          value: { kind: 'constant', value: [DONE] },
        },
      ],
    },
  };

  it('builds the milestone lookup (sum of done orders, VND)', () => {
    expect(buildOptions(complete, ORDER_FIELDS, CUSTOMER_FIELDS, 'USD').options).toEqual({
      from: ORDERS,
      select: AMOUNT.id,
      where: {
        op: 'and',
        items: [
          { field: CUSTOMER.id, operator: 'has_any_of', value: { field_ref: '__id' } },
          { field: STATUS.id, operator: 'is_any_of', value: [DONE] },
        ],
      },
      aggregate: 'sum',
      style: { type: 'currency', currency_code: 'VND' },
    });
  });

  it('nothing to send while something is missing', () => {
    expect(buildOptions({ ...complete, select: '' }, ORDER_FIELDS, [], 'USD').options).toBeNull();
    const incomplete: LookupDraft = {
      ...complete,
      conditions: {
        op: 'and',
        conditions: [
          ...complete.conditions.conditions,
          { key: 'c', field: NOTE.id, operator: 'eq', value: { kind: 'constant' } },
        ],
      },
    };
    expect(buildOptions(incomplete, ORDER_FIELDS, [], 'USD').options).toBeNull();
    expect(
      buildOptions(
        { ...complete, conditions: { op: 'and', conditions: [] } },
        ORDER_FIELDS,
        [],
        'USD',
      ).options,
    ).toBeNull();
  });

  it('reads a saved lookup back and sends only what changed', () => {
    const options = buildOptions(complete, ORDER_FIELDS, CUSTOMER_FIELDS, 'USD').options ?? {};
    const saved = field('fld_Lookup0000000001', CUSTOMERS, 'lookup', { ...options });
    const back = lookupDraftOf(saved, ORDER_FIELDS);
    expect(back).toMatchObject({
      from: ORDERS,
      select: AMOUNT.id,
      aggregate: 'sum',
      style: 'number:currency',
      currency: 'VND',
    });
    expect(changedOptions(saved, options)).toBeNull();
    expect(changedOptions(saved, { ...options, aggregate: 'average' })).toEqual({
      aggregate: 'average',
    });
    expect(hasDefinition(saved)).toBe(true);
    expect(hasDefinition(field('fld_Hidden0000000001', CUSTOMERS, 'lookup', { style: null }))).toBe(
      false,
    );
    expect(hasDefinition(undefined)).toBe(true);
  });
});

describe('lookup model: server errors', () => {
  it('reads the chain of a FORMULA_CYCLE', () => {
    expect(
      cycleOf({
        code: 'FORMULA_CYCLE',
        errors: [
          {
            params: {
              cycle: [
                { id: 'fld_A', name: 'A', table_id: CUSTOMERS },
                { id: 'fld_B', name: 'B', table_id: ORDERS },
                { id: 'fld_A', name: 'A', table_id: CUSTOMERS },
              ],
            },
          },
        ],
      }),
    ).toEqual([
      { id: 'fld_A', name: 'A', tableId: CUSTOMERS },
      { id: 'fld_B', name: 'B', tableId: ORDERS },
      { id: 'fld_A', name: 'A', tableId: CUSTOMERS },
    ]);
    expect(cycleOf({ code: 'FORMULA_TYPE_ERROR', errors: [] })).toBeNull();
  });

  it.each([
    ['name', 'name'],
    ['options.from', 'from'],
    ['options.select', 'select'],
    ['options.where.items.0.value.field_ref', 'where'],
    ['options.where', 'where'],
    ['options.aggregate', 'aggregate'],
    ['options.style', 'style'],
    ['options', 'other'],
    ['options.selection', 'other'],
  ] as const)('errorTargetOf(%s) = %s', (path, target) => {
    expect(errorTargetOf(path)).toBe(target);
  });
});
