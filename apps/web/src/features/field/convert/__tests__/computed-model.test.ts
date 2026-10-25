import { describe, expect, it } from 'vitest';

import { draftOf, type FieldDraft } from '../../draft';
import {
  canChangeType,
  computedConversionRequest,
  conversionRequestOf,
  isComputedType,
  sourceTypeOf,
  staticTypeOf,
  targetChoices,
} from '../model';

import type { FieldDto } from '@cellhive/contracts';

const NOW = '2026-09-28T00:00:00.000Z';
const CUSTOMERS = 'tbl_Customers0000001';

function field(type: string, options: Record<string, unknown> = {}): FieldDto {
  return {
    id: 'fld_Code000000000001',
    table_id: 'tbl_Orders0000000001',
    name: 'Code',
    type: type as FieldDto['type'],
    options,
    is_primary: false,
    required: false,
    unique_values: false,
    description: null,
    position: 1,
    created_at: NOW,
    updated_at: NOW,
  };
}

const kinds = (source: FieldDto) =>
  Object.fromEntries(targetChoices(source).map((choice) => [choice.type, choice.kind]));

function computed(
  type: 'formula' | 'lookup',
  kind: NonNullable<FieldDto['result_type']>['kind'],
  list = false,
  options: Record<string, unknown> = {},
): FieldDto {
  return { ...field(type, options), result_type: { kind, list } };
}

describe('conversions to and from formula/lookup (T463, T469)', () => {
  it('a field of an S1 type may become computed, except the primary field', () => {
    expect(kinds(field('text'))).toMatchObject({ formula: 'keep', lookup: 'keep' });
    const primary = targetChoices({ ...field('text'), is_primary: true });
    expect(primary.find((choice) => choice.type === 'formula')).toMatchObject({
      kind: 'forbidden',
      refusal: 'primaryField',
    });
  });

  it.each([
    ['number', false, { number: 'keep', text: 'keep', datetime: 'keep', checkbox: 'blacklist' }],
    ['boolean', false, { checkbox: 'keep', text: 'keep', number: 'keep' }],
    ['user', true, { user: 'keep', text: 'keep' }],
    ['record', true, { text: 'keep', select: 'keep' }],
  ] as const)('a formula of %s (list %s) converts by its result type', (kind, list, expected) => {
    expect(kinds(computed('formula', kind, list))).toMatchObject({
      ...expected,
      formula: 'none',
      lookup: 'keep',
      link: 'forbidden',
      created_at: 'forbidden',
      auto_number: 'forbidden',
    });
  });

  it.each([
    [{ kind: 'number', list: false }, 'number'],
    [{ kind: 'number', list: true }, 'text'],
    [{ kind: 'boolean', list: false }, 'checkbox'],
    [{ kind: 'date', list: false }, 'datetime'],
    [{ kind: 'user', list: true }, 'user'],
    [{ kind: 'record', list: true }, 'text'],
    [{ kind: 'null', list: false }, 'text'],
  ] as const)('the static type of %o is %s', (result, expected) => {
    expect(staticTypeOf({ options: {}, result_type: result })).toBe(expected);
  });

  it('builds the bodies: to a formula once it has an expression, from one with its style', () => {
    const text = field('text');
    const empty: FieldDraft = { ...draftOf(text), type: 'formula' };
    expect(conversionRequestOf(text, empty)).toBeNull();
    const written: FieldDraft = {
      ...empty,
      formula: { expression: '[Amount] * 2', style: null, styleTouched: false },
    };
    expect(conversionRequestOf(text, written)).toEqual({
      type: 'formula',
      options: { expression: '[Amount] * 2' },
    });
    expect(conversionRequestOf(text, { ...draftOf(text), type: 'lookup' })).toBeNull();
    const currency = { type: 'currency', precision: 0, currency_code: 'VND' };
    const formula = computed('formula', 'number', false, {
      expression: '[Amount] * 2',
      style: currency,
    });
    const request = conversionRequestOf(formula, { ...draftOf(formula), type: 'number' });
    expect(request).toMatchObject({ type: 'number', options: { style: currency } });
  });

  it('reads the conversion settings of a computed source by its result', () => {
    expect(sourceTypeOf(computed('formula', 'number'), 'select')).toBe('text');
    expect(sourceTypeOf(computed('formula', 'number'), 'number')).toBe('number');
    expect(sourceTypeOf(field('number'), 'select')).toBe('number');
    expect(computedConversionRequest('lookup', { from: CUSTOMERS })).toEqual({
      type: 'lookup',
      options: { from: CUSTOMERS },
    });
    expect(isComputedType('lookup')).toBe(true);
    expect(isComputedType('text')).toBe(false);
    expect(canChangeType(field('formula'))).toBe(true);
  });
});
