import { analyze, FUNCTIONS, listCatalogue, parse, T, type Expr } from '@cellhive/formula-engine';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';

import {
  compileAnalysis,
  compileFormula,
  FormulaCompileError,
  sqlFunctionNames,
} from '../../src/formula/index.js';

import { loadFormulaFixture, sameRowCases } from './fixture-source.js';
import { compileUnit, render, unitTable } from './model.js';

const table = unitTable();

/** Functions the same-row compiler hands to T455 (records, other tables) or never sees (LET). */
const NOT_SAME_ROW = new Set(['SORTBY', 'LOOKUP', 'LET']);

describe('SQL function table', () => {
  it('has one SQL implementation per catalogue function, and nothing else', () => {
    const catalogue = listCatalogue()
      .filter((entry) => !entry.phase2)
      .map((entry) => entry.name)
      .sort();
    expect(sqlFunctionNames()).toEqual(catalogue);
    expect(sqlFunctionNames()).toEqual(Object.keys(FUNCTIONS).sort());
  });
});

describe('same-row fixture', () => {
  const cases = sameRowCases(loadFormulaFixture());

  it('has at least 250 cases and two cases per same-row function', () => {
    expect(cases.length).toBeGreaterThanOrEqual(250);
    const uses = new Map<string, number>();
    const walk = (node: Expr): void => {
      switch (node.type) {
        case 'call':
          uses.set(node.name, (uses.get(node.name) ?? 0) + 1);
          node.args.forEach(walk);
          break;
        case 'let':
          uses.set('LET', (uses.get('LET') ?? 0) + 1);
          node.bindings.forEach((binding) => {
            walk(binding.value);
          });
          walk(node.body);
          break;
        case 'unary':
          walk(node.operand);
          break;
        case 'binary':
          walk(node.left);
          walk(node.right);
          break;
        case 'member':
          walk(node.object);
          break;
        default:
          break;
      }
    };
    for (const item of cases) walk(parse(item.formula, { form: 'display' }));
    const missing = Object.keys(FUNCTIONS).filter(
      (name) => !NOT_SAME_ROW.has(name) && (uses.get(name) ?? 0) < 2,
    );
    expect(missing).toEqual([]);
  });

  it('compiles every case', () => {
    for (const item of cases) {
      expect(() => compileUnit(table, item.formula, { timeZone: item.tz })).not.toThrow();
    }
  });
});

describe('long flat chains (T470: 4,000 characters of `1+1+…`, SPEC §9.5)', () => {
  it.each(['+', '&', '*'])('compiles and renders a 2,000-term chain of %s', (operator) => {
    const formula = Array.from({ length: 2000 }, () => '1').join(operator);
    expect(formula.length).toBeLessThanOrEqual(4000);
    const { sql: text, parameters } = render(compileUnit(table, formula));
    expect(parameters).toHaveLength(2000);
    expect(text.length).toBeGreaterThan(0);
  });
});

describe('compileFormula: SQL shape', () => {
  it('binds literals as parameters and reads columns from meta', () => {
    const { sql: text, parameters } = render(compileUnit(table, '[Amount] * 0.1 & "đ"'));
    expect(parameters).toEqual(['0.1', 'đ']);
    expect(text).toContain('"f_x00000000003"');
    expect(text).not.toContain('Amount');
    expect(text).not.toContain('0.1');
  });

  it('qualifies columns with the table alias', () => {
    const { sql: text } = render(compileUnit(table, '[Amount] + 1', { tableAlias: 'r' }));
    expect(text).toContain('"r"."f_x00000000003"');
  });

  it('passes the time zone as a parameter (ADR-21)', () => {
    const { sql: text, parameters } = render(
      compileUnit(table, 'YEAR([At])', { timeZone: 'America/New_York' }),
    );
    expect(text).toContain('fx.year(');
    expect(parameters).toEqual(['America/New_York']);
  });

  it('uses the own zone of a datetime field', () => {
    const zoned = unitTable([
      {
        name: 'Zoned',
        type: 'datetime',
        options: { style: { format: 'yyyy-MM-dd HH:mm' }, timezone: 'Europe/Paris' },
      },
    ]);
    const { parameters } = render(compileUnit(zoned, 'HOUR([Zoned]) + HOUR([At])'));
    expect(parameters).toEqual(['Europe/Paris', 'Asia/Ho_Chi_Minh']);
  });

  it('maps select option ids to names with bound arrays', () => {
    const { parameters } = render(compileUnit(table, '[Status] = "Xong"'));
    expect(parameters).toContainEqual([
      'opt_moi0000000000000',
      'opt_xong000000000000',
      'opt_dagiao0000000000',
    ]);
    expect(parameters).toContainEqual(['Mới', 'Xong', 'Đã giao']);
  });

  it('uses the safe fx variants for operations that can fail', () => {
    expect(render(compileUnit(table, '[Amount] / [Qty]')).sql).toContain('fx.div(');
    expect(render(compileUnit(table, 'VALUE([Name])')).sql).toContain('fx.value(');
    expect(render(compileUnit(table, 'SQRT([Amount])')).sql).toContain('fx.sqrt(');
  });

  it('fixes NOW() when the context gives it', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    expect(render(compileUnit(table, 'NOW()', { now })).parameters).toEqual([now.toISOString()]);
    expect(render(compileUnit(table, 'NOW()')).sql).toBe('now()');
  });

  it.each([
    ['CONTAIN([Tags], "vip")', true],
    ['CONTAINSALL([Tags], [Name], "a")', true],
    ['CONTAINSONLY(SPLIT([Note], ","), "a")', true],
    ['CONTAIN([Owner], "usr_an")', false],
    ['CONTAIN([Tags], "vip", [Owner])', false],
    ['CONTAIN(LIST(1, 2), [Amount])', false],
    ['[Name] = "vip"', false],
  ])('%s folds texts through fx.fold_all: %s (T473)', (formula, folds) => {
    const text = render(compileUnit(table, formula)).sql;
    expect(text.includes('fx.fold_all(')).toBe(folds);
  });

  it('strips trailing zeros of number results', () => {
    const compiled = compileUnit(table, '1.50');
    expect(compiled.type).toEqual(T.number);
    expect(render(compiled).sql).toMatch(/^trim_scale\(/);
  });
});

describe('compileFormula: what it refuses', () => {
  const code = (formula: string): string | null => {
    try {
      compileUnit(table, formula);
      return null;
    } catch (error) {
      return error instanceof FormulaCompileError ? error.code : String(error);
    }
  };

  it.each([
    '[Link]',
    'COUNTA([Link])',
    '[Link].[Other name]',
    '[Other].[Other name].FIRST()',
    'COUNTIF([Other], CurrentValue.[Other name] = "a")',
    '[Other].SORTBY(CurrentValue.[Other name]).[Other name]',
    'LOOKUP([Name], [Other].[Other name], [Other].[Other name]).FIRST()',
  ])('%s → CROSS_TABLE (T455)', (formula) => {
    expect(code(formula)).toBe('CROSS_TABLE');
  });

  it('refuses a formula with type errors', () => {
    const analysis = analyze('SUM("a")', table.snapshot, { form: 'display' });
    expect(analysis.errors).not.toEqual([]);
    expect(() =>
      compileAnalysis(analysis, { fields: table.model.fields, timeZone: 'UTC' }),
    ).toThrow(FormulaCompileError);
  });

  it('refuses an AST without types', () => {
    const ast = parse('1 + 2', { form: 'display' });
    expect(() =>
      compileFormula(ast, { types: new Map(), fields: table.model.fields, timeZone: 'UTC' }),
    ).toThrow(FormulaCompileError);
  });

  it('lets the extension (T455) compile cross-table nodes', () => {
    const analysis = analyze('COUNTA([Link])', table.snapshot, { form: 'display' });
    const seen: string[] = [];
    const compiled = compileAnalysis(analysis, {
      fields: table.model.fields,
      timeZone: 'UTC',
      extension: {
        compile(node) {
          seen.push(node.type);
          if (node.type !== 'reference' || node.name !== 'Link') return undefined;
          return { sql: sql`ARRAY['r1']::text[]`, type: { kind: 'list', element: T.text } };
        },
      },
    });
    expect(seen).toContain('reference');
    expect(render(compiled).sql).toContain("ARRAY['r1']");
  });
});
