import { describe, expect, it } from 'vitest';

import {
  FORMULA_SQL_MAX_BYTES,
  FORMULA_SQL_MAX_PARAMETERS,
  FormulaCompileError,
} from '../../src/formula/index.js';

import { loadFormulaFixture, sameRowCases } from './fixture-source.js';
import { compileUnit, render, unitTable } from './model.js';

const table = unitTable();

/** `LET(a0, [Name], a1, step(a0), …, an)`. */
function letChainWith(n: number, step: (previous: string) => string): string {
  const parts = ['a0, [Name]'];
  for (let i = 1; i <= n; i += 1) parts.push(`a${String(i)}, ${step(`a${String(i - 1)}`)}`);
  return `LET(${parts.join(', ')}, a${String(n)})`;
}

/** `LET(a0, [Name], a1, a0 & a0 & a0, …, an)`: each variable used three times. */
const letChain = (n: number): string => letChainWith(n, (v) => `${v} & ${v} & ${v}`);

function nested(n: number, wrap: (inner: string) => string, seed = '[Name]'): string {
  let formula = seed;
  for (let i = 0; i < n; i += 1) formula = wrap(formula);
  return formula;
}

/** Each case is well under the formula limits of SPEC §9.5 (4 000 chars, depth 50, 20 LET variables). */
const EXPLOSIVE: readonly { name: string; formula: string }[] = [
  { name: 'LET chain, each variable used 3 times', formula: letChain(14) },
  { name: 'LET chain, 20 variables', formula: letChain(19) },
  { name: 'nested IFBLANK', formula: nested(15, (inner) => `IFBLANK(${inner}, "x")`) },
  { name: 'nested IFBLANK, 40 levels', formula: nested(40, (inner) => `IFBLANK(${inner}, "x")`) },
  {
    name: 'nested SWITCH',
    formula: nested(12, (inner) => `SWITCH(${inner}, "a", "b", "c", "d", "e")`),
  },
  {
    name: 'LET chain through IF, ISBLANK and =',
    formula: letChainWith(16, (v) => `IF(ISBLANK(${v}) || ${v} = "y", "", ${v} & ${v})`),
  },
];

describe('compiled size budget', () => {
  it.each(EXPLOSIVE)('rejects $name fast, without building the SQL', ({ formula }) => {
    expect(formula.length).toBeLessThanOrEqual(4000);
    const started = performance.now();
    let caught: unknown;
    try {
      compileUnit(table, formula);
    } catch (error) {
      caught = error;
    }
    const elapsed = performance.now() - started;
    expect(caught).toBeInstanceOf(FormulaCompileError);
    expect(caught).toMatchObject({ code: 'TOO_LARGE' });
    expect(elapsed).toBeLessThan(100);
  });

  it('accepts a LET chain whose SQL fits', () => {
    const { sql, parameters } = render(compileUnit(table, letChain(4)));
    expect(sql.length).toBeLessThan(FORMULA_SQL_MAX_BYTES);
    expect(parameters.length).toBeLessThan(FORMULA_SQL_MAX_PARAMETERS);
  });

  it('accepts a long flat formula of 4 000 characters', () => {
    const formula = Array.from({ length: 444 }, () => '[Amount]').join('+');
    expect(formula.length).toBeLessThanOrEqual(4000);
    expect(() => render(compileUnit(table, formula))).not.toThrow();
    const dates = Array.from({ length: 190 }, () => 'DAY(TODAY())').join('+');
    expect(dates.length).toBeLessThanOrEqual(4000);
    expect(() => render(compileUnit(table, dates))).not.toThrow();
    // A select field binds its option ids and names at every reference.
    const selects = Array.from({ length: 444 }, () => '[Status]').join('&');
    expect(selects.length).toBeLessThanOrEqual(4000);
    expect(() => render(compileUnit(table, selects))).not.toThrow();
  });

  it('compiles every same-row fixture case within the budget', () => {
    for (const testCase of sameRowCases(loadFormulaFixture())) {
      let compiled;
      try {
        compiled = compileUnit(table, testCase.formula);
      } catch (error) {
        if (error instanceof FormulaCompileError && error.code === 'TOO_LARGE') {
          throw new Error(`${testCase.name} is over the budget`, { cause: error });
        }
        continue;
      }
      const { sql, parameters } = render(compiled);
      expect(sql.length).toBeLessThan(FORMULA_SQL_MAX_BYTES);
      expect(parameters.length).toBeLessThan(FORMULA_SQL_MAX_PARAMETERS);
    }
  });
});
