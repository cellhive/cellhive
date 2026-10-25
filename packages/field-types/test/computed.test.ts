import { describe, expect, it } from 'vitest';

import {
  COMPUTED_FIELD_TYPES,
  formatComputedText,
  formulaOptionsSchema,
  isComputedFieldType,
  lookupOptionsSchema,
  parseComputedStyle,
  type ComputedResultType,
} from '../src/index.js';

const vi = { locale: 'vi', timeZone: 'Asia/Ho_Chi_Minh' };
const en = { locale: 'en-US', timeZone: 'UTC' };
const VND = { type: 'currency', currency_code: 'VND' } as const;

const number: ComputedResultType = { kind: 'number', list: false };

describe('computed field types (T456)', () => {
  it('registers formula and lookup as computed types', () => {
    expect(Object.keys(COMPUTED_FIELD_TYPES).sort()).toEqual(['formula', 'lookup']);
    expect(isComputedFieldType('formula')).toBe(true);
    expect(isComputedFieldType('lookup')).toBe(true);
    expect(isComputedFieldType('text')).toBe(false);
  });

  it('formula options: stored expression and a style defaulting to null', () => {
    expect(formulaOptionsSchema.parse({ expression: '[fld_0000000000000001] * 2' })).toEqual({
      expression: '[fld_0000000000000001] * 2',
      style: null,
    });
    expect(formulaOptionsSchema.safeParse({ expression: '' }).success).toBe(false);
    expect(formulaOptionsSchema.safeParse({ expression: 'x', other: 1 }).success).toBe(false);
  });

  it('lookup options: four parts, aggregate defaulting to raw_value', () => {
    const parsed = lookupOptionsSchema.parse({
      from: 'tbl_0000000000000001',
      select: 'fld_0000000000000001',
      where: {
        field: 'fld_0000000000000002',
        operator: 'intersects',
        value: { field_ref: '__id' },
      },
    });
    expect(parsed.aggregate).toBe('raw_value');
    expect(parsed.style).toBeNull();
    expect(lookupOptionsSchema.safeParse({ ...parsed, aggregate: 'median' }).success).toBe(false);
    expect(lookupOptionsSchema.safeParse({ ...parsed, from: 'Orders' }).success).toBe(false);
  });

  it.each<[string, unknown, ComputedResultType, boolean]>([
    ['currency on a number', VND, number, true],
    ['currency on a list of numbers', VND, { kind: 'number', list: true }, true],
    ['a date format on a date', { format: 'dd/MM/yyyy' }, { kind: 'date', list: false }, true],
    ['a number style on a date', VND, { kind: 'date', list: false }, false],
    ['a style on a text', { format: 'dd/MM/yyyy' }, { kind: 'text', list: false }, false],
    ['null on anything', null, { kind: 'text', list: false }, true],
    ['an unknown currency', { type: 'currency', currency_code: 'XXQ' }, number, false],
  ])('parseComputedStyle: %s', (_name, style, type, ok) => {
    expect(parseComputedStyle(style, type).ok).toBe(ok);
  });

  it.each<[string, unknown, ComputedResultType, unknown, typeof vi, string]>([
    ['sum with a VND currency style (S4b milestone)', 1500000, number, VND, vi, '1.500.000 ₫'],
    ['a numeric string from PostgreSQL', '1500000', number, VND, vi, '1.500.000 ₫'],
    ['no style keeps the decimals', '2.5', number, null, en, '2.5'],
    [
      'a date',
      '2026-09-28',
      { kind: 'date', list: false },
      { format: 'dd/MM/yyyy' },
      vi,
      '28/09/2026',
    ],
    ['a list of numbers', [1, 2], { kind: 'number', list: true }, VND, vi, '1 ₫, 2 ₫'],
    ['a boolean', true, { kind: 'boolean', list: false }, null, vi, 'TRUE'],
    [
      'records by title',
      [{ id: 'rec_1', title: 'An' }],
      { kind: 'record', list: true },
      null,
      vi,
      'An',
    ],
    ['empty', null, number, VND, vi, ''],
  ])('formatComputedText: %s', (_name, value, type, style, ctx, text) => {
    const parsed = parseComputedStyle(style, type);
    if (!parsed.ok) throw new Error(parsed.message);
    expect(
      formatComputedText(value, type, parsed.style, ctx).replaceAll(String.fromCharCode(160), ' '),
    ).toBe(text);
  });
});
