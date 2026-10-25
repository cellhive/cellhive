import { describe, expect, it } from 'vitest';

import { toGridField, type GridField } from '../../../../grid/types';
import {
  linkedFilter,
  linkedSearchParam,
  parseLinkedParam,
} from '../../../../lib/views/linked-filter';
import {
  columnTotal,
  defaultColumns,
  moveColumn,
  pickerOrder,
  readableIds,
  resolveColumns,
  restoreLink,
  subTableRows,
  summedColumn,
  toggleColumn,
  withoutLink,
} from '../model';

import type { FieldDto, RecordDto } from '@cellhive/contracts';

const NOW = '2026-09-26T00:00:00.000Z';
const TABLE = 'tbl_Details000000001';

function field(id: string, type: string, options: Record<string, unknown> = {}, position = 1) {
  const dto: FieldDto = {
    id: `fld_${id.padEnd(16, '0')}`,
    table_id: TABLE,
    name: id,
    type,
    options,
    is_primary: id === 'Product',
    required: false,
    unique_values: false,
    description: null,
    position,
    created_at: NOW,
    updated_at: NOW,
  } as FieldDto;
  return toGridField(dto);
}

const PRODUCT = field('Product', 'text', {}, 0);
const MONEY = { style: { type: 'currency', currency_code: 'VND' } };
const QTY = field('Qty', 'number', {}, 1);
const PRICE = field('Price', 'number', MONEY, 2);
const TOTAL = field('Total', 'number', MONEY, 3);
const NOTE = field('Note', 'text', {}, 4);
const ORDER = field('Order', 'link', { link_table: 'tbl_Orders0000000001' }, 5);
const DATE = field('Date', 'date', {}, 6);
const FIELDS: GridField[] = [PRODUCT, QTY, PRICE, TOTAL, NOTE, ORDER, DATE];
const id = (value: GridField) => value.field.id;

function rec(n: number, fields: Record<string, unknown> = {}): RecordDto {
  return {
    id: `rec_${String(n).padStart(16, '0')}`,
    version: 1,
    fields,
    created_at: NOW,
    updated_at: NOW,
    created_by: null,
    updated_by: null,
  } as unknown as RecordDto;
}

describe('columns', () => {
  it.each([
    ['first five', null, [PRODUCT, QTY, PRICE, TOTAL, NOTE]],
    ['skips the reverse link', id(QTY), [PRODUCT, PRICE, TOTAL, NOTE, ORDER]],
  ])('defaultColumns: %s', (_name, reverse, expected) => {
    expect(defaultColumns(FIELDS, reverse)).toEqual(expected.map(id));
  });

  it.each([
    ['nothing saved: defaults', undefined, [PRODUCT, QTY, PRICE, TOTAL, NOTE]],
    ['saved order, primary first', [id(TOTAL), id(QTY)], [PRODUCT, TOTAL, QTY]],
    ['primary saved later stays first once', [id(QTY), id(PRODUCT)], [PRODUCT, QTY]],
    ['unreadable or deleted ids dropped', ['fld_Gone000000000001', id(NOTE)], [PRODUCT, NOTE]],
    ['empty list: primary only', [], [PRODUCT]],
  ])('resolveColumns: %s', (_name, saved, expected) => {
    expect(resolveColumns(saved, FIELDS, id(ORDER)).map(id)).toEqual(expected.map(id));
  });

  it.each([
    ['check', [id(PRODUCT)], id(QTY), true, [id(PRODUCT), id(QTY)]],
    ['check twice', [id(PRODUCT), id(QTY)], id(QTY), true, [id(PRODUCT), id(QTY)]],
    ['uncheck', [id(PRODUCT), id(QTY)], id(QTY), false, [id(PRODUCT)]],
    ['primary stays', [id(PRODUCT), id(QTY)], id(PRODUCT), false, [id(PRODUCT), id(QTY)]],
  ])('toggleColumn: %s', (_name, current, fieldId, on, expected) => {
    expect(toggleColumn(current, fieldId, on, id(PRODUCT))).toEqual(expected);
  });

  const order = [id(PRODUCT), id(QTY), id(PRICE), id(TOTAL)];
  it.each([
    ['down', 1, 3, [id(PRODUCT), id(PRICE), id(TOTAL), id(QTY)]],
    ['up', 3, 1, [id(PRODUCT), id(TOTAL), id(QTY), id(PRICE)]],
    ['never above the primary', 2, 0, [id(PRODUCT), id(PRICE), id(QTY), id(TOTAL)]],
    ['the primary does not move', 0, 2, order],
    ['out of range', 9, 1, order],
  ])('moveColumn: %s', (_name, from, to, expected) => {
    expect(moveColumn(order, from, to, id(PRODUCT))).toEqual(expected);
  });

  it('pickerOrder: shown columns first, then the rest in table order', () => {
    expect(pickerOrder([PRODUCT, TOTAL], FIELDS)).toEqual(
      [PRODUCT, TOTAL, QTY, PRICE, NOTE, ORDER, DATE].map(id),
    );
  });
});

describe('rows', () => {
  const refs = [
    { id: rec(1).id, title: 'Máy POS' },
    { id: rec(2).id, title: null },
    { id: rec(3).id, title: 'Két tiền' },
  ];

  it('keeps link order, marks unreadable rows locked, caps', () => {
    const result = subTableRows(refs, [rec(3), rec(1)], 2);
    expect(result.total).toBe(3);
    expect(result.capped).toBe(true);
    expect(result.rows.map((row) => [row.ref.id, row.record?.id ?? null, row.locked])).toEqual([
      [rec(1).id, rec(1).id, false],
      [rec(2).id, null, true],
    ]);
  });

  it.each([
    ['not capped', 50, false],
    ['exactly at the cap', 3, false],
  ])('subTableRows: %s', (_name, cap, capped) => {
    expect(subTableRows(refs, undefined, cap).capped).toBe(capped);
  });

  it('readableIds: shown and readable only', () => {
    expect(readableIds(refs, 2)).toEqual([rec(1).id]);
    expect(readableIds(refs, 50)).toEqual([rec(1).id, rec(3).id]);
  });

  it.each([
    ['currency', PRICE, true],
    ['plain number', QTY, false],
    ['text', NOTE, false],
  ])('summedColumn: %s', (_name, column, expected) => {
    expect(summedColumn(column)).toBe(expected);
  });

  it('columnTotal adds numbers, ignores empty and unreadable rows', () => {
    const rows = subTableRows(
      refs,
      [rec(1, { [id(TOTAL)]: 9_800_000 }), rec(3, { [id(TOTAL)]: 1_150_000 })],
      50,
    ).rows;
    expect(columnTotal(TOTAL, rows)).toBe(10_950_000);
    expect(columnTotal(PRICE, rows)).toBeNull();
  });

  it('unlink and its undo keep the order and later changes', () => {
    const removed = refs[1] as (typeof refs)[number];
    const after = withoutLink(refs, removed.id);
    expect(after.map((ref) => ref.id)).toEqual([rec(1).id, rec(3).id]);
    const later = [...after, { id: rec(4).id, title: 'Giấy in' }];
    expect(restoreLink(later, removed, 1).map((ref) => ref.id)).toEqual([
      rec(1).id,
      rec(2).id,
      rec(3).id,
      rec(4).id,
    ]);
    expect(restoreLink(refs, removed, 0)).toEqual(refs);
    expect(restoreLink([], removed, 5)).toEqual([removed]);
  });
});

describe('texts and links', () => {
  it('?linked= round trip and filter', () => {
    const target = { fieldId: 'fld_Reverse000000001', recordId: 'rec_Customer00000001' };
    const param = linkedSearchParam(target);
    expect(param).toBe('linked=fld_Reverse000000001.rec_Customer00000001');
    expect(parseLinkedParam(new URLSearchParams(param).get('linked'))).toEqual(target);
    expect(linkedFilter(target)).toEqual({
      op: 'and',
      items: [{ field: target.fieldId, operator: 'has_any_of', value: [target.recordId] }],
    });
  });

  it.each([null, '', 'fld_x', 'rec_Customer00000001.fld_Reverse000000001', 'a.b.c'])(
    'parseLinkedParam(%s) is null',
    (value) => {
      expect(parseLinkedParam(value)).toBeNull();
    },
  );
});
