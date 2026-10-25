import { describe, expect, it } from 'vitest';

import { createBody, draftOf, updateBody, validateDraft, type FieldDraft } from '../draft';

import type { FieldDto } from '@cellhive/contracts';

/** T466: the formula part of the field form (CONTRACTS §13 `options.expression` / `style`). */

const NOW = '2026-09-28T00:00:00.000Z';
const CURRENCY = { type: 'currency', currency_code: 'VND' };

function formulaField(options: Record<string, unknown>): FieldDto {
  return {
    id: 'fld_Commission000001',
    table_id: 'tbl_Tickets000000001',
    name: 'Commission',
    type: 'formula',
    options,
    is_primary: false,
    required: false,
    unique_values: false,
    description: null,
    position: 3,
    created_at: NOW,
    updated_at: NOW,
    result_type: { kind: 'number', list: false },
    compute_mode: 'stored',
    compute_state: 'ready',
    compute_error: null,
  };
}

function newFormula(expression: string, extra: Partial<FieldDraft['formula']> = {}): FieldDraft {
  return {
    ...draftOf(),
    name: 'Commission',
    type: 'formula',
    formula: { expression, style: null, styleTouched: false, ...extra },
  };
}

describe('formula drafts', () => {
  it('reads the saved expression and style', () => {
    const draft = draftOf(formulaField({ expression: '[Amount] * 0.1', style: CURRENCY }));
    expect(draft.type).toBe('formula');
    expect(draft.formula).toEqual({
      expression: '[Amount] * 0.1',
      style: CURRENCY,
      styleTouched: false,
    });
  });

  it.each<[string, FieldDraft, Record<string, unknown>]>([
    [
      'without a chosen style (the server keeps the carried one)',
      newFormula('  [Amount] * 0.1 '),
      { expression: '[Amount] * 0.1' },
    ],
    [
      'with a chosen style',
      newFormula('[Amount] * 0.1', { style: CURRENCY, styleTouched: true }),
      { expression: '[Amount] * 0.1', style: CURRENCY },
    ],
    [
      'with the style removed',
      newFormula('[Amount] * 0.1', { style: null, styleTouched: true }),
      { expression: '[Amount] * 0.1', style: null },
    ],
  ])('creates %s', (_label, draft, options) => {
    expect(createBody(draft)).toEqual({ name: 'Commission', type: 'formula', options });
  });

  it('requires a formula', () => {
    expect(validateDraft(newFormula('  ')).issues).toEqual([
      { path: 'options.expression', detail: { code: 'REQUIRED' } },
    ]);
    expect(validateDraft(newFormula('1 + 1')).issues).toEqual([]);
  });

  it('updates only what changed', () => {
    const field = formulaField({ expression: '[Amount] * 0.1', style: CURRENCY });
    const same = draftOf(field);
    expect(updateBody(field, same)).toBeNull();
    expect(
      updateBody(field, { ...same, formula: { ...same.formula, expression: '[Amount] * 0.2' } }),
    ).toEqual({
      options: { expression: '[Amount] * 0.2' },
    });
    const plain = { type: 'plain', precision: 2, percentage: false, thousands_separator: true };
    expect(
      updateBody(field, {
        ...same,
        formula: { ...same.formula, style: plain, styleTouched: true },
      }),
    ).toEqual({ options: { style: plain } });
    expect(updateBody(field, { ...same, name: 'Bonus' })).toEqual({ name: 'Bonus' });
  });
});
