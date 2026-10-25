import { describe, expect, it } from 'vitest';

import {
  analyzeAst,
  evaluate,
  formatType,
  lookupToAst,
  MVP_FUNCTION_NAMES,
  parse,
  resolveNames,
  S4B_FUNCTION_NAMES,
  type Expr,
} from '../src/index.js';

import {
  caseContext,
  fixtureDataSource,
  fixtureLookupOptions,
  loadFormulaFixture,
  type FixtureCase,
} from './fixtures/formula-fixture.js';

const { schema, cases } = loadFormulaFixture();
const resolve = fixtureDataSource(schema);

function prepare(item: FixtureCase) {
  const context = caseContext(schema, item, resolve);
  const ast =
    item.lookup === undefined
      ? resolveNames(parse(item.formula, { form: 'display' }), context.snapshot)
      : lookupToAst(
          fixtureLookupOptions(schema, item.lookup, item.table ?? schema.defaults.table),
          context.snapshot,
        );
  const analysis = analyzeAst(ast, context.snapshot);
  return { ast, analysis, context };
}

/** Function names (and LET) used in a formula. */
function functionsOf(node: Expr, out = new Set<string>()): Set<string> {
  switch (node.type) {
    case 'call':
      out.add(node.name);
      for (const arg of node.args) functionsOf(arg, out);
      break;
    case 'let':
      out.add('LET');
      for (const binding of node.bindings) functionsOf(binding.value, out);
      functionsOf(node.body, out);
      break;
    case 'member':
      functionsOf(node.object, out);
      break;
    case 'unary':
      functionsOf(node.operand, out);
      break;
    case 'binary':
      functionsOf(node.left, out);
      functionsOf(node.right, out);
      break;
    default:
      break;
  }
  return out;
}

/** Numbers compare as decimals, within `tolerance` (relative) when set. */
function sameNumber(actual: unknown, expected: string, tolerance: string | undefined): boolean {
  if (typeof actual !== 'string') return false;
  if (tolerance === undefined) return Number(actual) === Number(expected) && actual === expected;
  const a = Number(actual);
  const b = Number(expected);
  return Math.abs(a - b) <= Number(tolerance) * Math.max(1, Math.abs(b));
}

describe('shared formula fixture (T453, TS ≡ SQL)', () => {
  it('has at least 300 cases with unique ids', () => {
    expect(cases.length).toBeGreaterThanOrEqual(300);
    expect(new Set(cases.map((item) => item.id)).size).toBe(cases.length);
  });

  it('covers every catalogue function (and LET) at least twice', () => {
    const counts = new Map<string, number>();
    for (const item of cases) {
      for (const name of functionsOf(prepare(item).ast)) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
    const scarce = [...MVP_FUNCTION_NAMES, ...S4B_FUNCTION_NAMES].filter(
      (name) => (counts.get(name) ?? 0) < 2,
    );
    expect(scarce).toEqual([]);
  });

  it('covers both time zones and the same-row subset T454 replays', () => {
    const zones = new Set(cases.map((item) => item.tz ?? schema.defaults.tz));
    expect(zones).toContain('Asia/Ho_Chi_Minh');
    expect(zones).toContain('America/New_York');
    expect(cases.filter((item) => item.scope === 'same_row').length).toBeGreaterThanOrEqual(250);
  });

  describe.each(cases.map((item) => [item.id, item] as const))('%s', (_id, item) => {
    it(item.formula, () => {
      const { ast, analysis, context } = prepare(item);
      expect(analysis.errors.map((error) => error.detail)).toEqual([]);
      expect(analysis.result_type === null ? null : formatType(analysis.result_type)).toBe(
        item.type,
      );
      expect(analysis.referenced_tables.length === 0 ? 'same_row' : 'cross_table').toBe(item.scope);
      const actual = evaluate(ast, { ...context, types: analysis.types });
      if (item.type === 'number' && typeof item.expected === 'string') {
        expect(
          sameNumber(actual, item.expected, item.tolerance),
          `${JSON.stringify(actual)} ≠ ${item.expected}`,
        ).toBe(true);
      } else {
        expect(actual).toEqual(item.expected);
      }
    });
  });
});
