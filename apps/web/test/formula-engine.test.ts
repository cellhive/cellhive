import { parse, renderNames, serialize, tokenize, toStoredFormula } from '@cellhive/formula-engine';
import { describe, expect, it } from 'vitest';

/**
 * T451: the formula engine's ESM build loads in the browser environment of
 * the web client (jsdom, no Node APIs used) — the formula editor (T466)
 * parses and highlights with it.
 */
describe('@cellhive/formula-engine in the web client', () => {
  it('runs in the browser environment', () => {
    expect(typeof window).toBe('object');
    const snapshot = {
      tableId: 'tbl_orders0000000000',
      tables: [
        {
          id: 'tbl_orders0000000000',
          name: 'Orders',
          fields: [{ id: 'fld_amount0000000000', name: 'Amount' }],
        },
      ],
    };
    const { stored } = toStoredFormula('[Amount] * 2', snapshot);
    expect(stored).toBe('[fld_amount0000000000] * 2');
    expect(renderNames(stored, snapshot)).toBe('[Amount] * 2');
    expect(serialize(parse('sum(1,2)'))).toBe('SUM(1, 2)');
    expect(tokenize('[A] + 1').map((token) => token.type)).toEqual([
      'name',
      'operator',
      'number',
      'end',
    ]);
  });
});
