import { performance } from 'node:perf_hooks';

import { describe, expect, it } from 'vitest';

import {
  FormulaError,
  MAX_FORMULA_LENGTH,
  parse,
  renderNames,
  resolveNames,
  serialize,
  stripSpans,
} from '../src/index.js';
import { tokenize } from '../src/lexer.js';

import { inCustomers, inOrders } from './fixture.js';
import { countNodes, timingBudgetsApply } from './timing.js';

const BUDGET_MS = 5;

/** Deterministic PRNG (mulberry32), so a failure reproduces from its seed. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Formula-like fragments, so random input also reaches deep parser states, not only lexer errors. */
const FRAGMENTS = [
  '[Số tiền]',
  '[Khách hàng]',
  '[Hạng]',
  '[Tickets]',
  '[Hạn]',
  '[Tags]',
  '[Sản phẩm]',
  '[Nhà cung cấp]',
  '[Quốc gia]',
  '[Châu lục]',
  '[Tên]',
  '[Nope]',
  '#REF[fld_amount0000000000]',
  '#REF[x]',
  '[',
  ']',
  '[]',
  '"',
  '"text"',
  '"a\\"b"',
  '\\',
  '(',
  ')',
  ',',
  '.',
  '+',
  '-',
  '*',
  '/',
  '%',
  '&',
  '=',
  '!=',
  '<>',
  '<',
  '<=',
  '>',
  '>=',
  '&&',
  '||',
  '!',
  '|',
  '@',
  '#',
  ' ',
  '\n',
  '0',
  '1',
  '3.14',
  '1.',
  '.5',
  'TRUE',
  'false',
  'CurrentValue',
  'SUM(',
  'IF(',
  'FILTER(',
  'COUNTIF(',
  'LET(',
  'x',
  'y',
  'LET(x, 1, ',
  '.SUM()',
  '.FILTER(',
  '.[Tên]',
  'sin(',
  'FOO(',
  'TODAY()',
  '😀',
  '\ud800',
  'Đ',
  'ổ',
];

function randomFormula(random: () => number): string {
  const mode = random();
  if (mode < 0.2) {
    // Raw characters, including control, surrogate and non-BMP ones.
    const length = Math.floor(random() * 40);
    let text = '';
    for (let i = 0; i < length; i += 1) text += String.fromCharCode(Math.floor(random() * 0x10000));
    return text;
  }
  const count = 1 + Math.floor(random() * (mode < 0.9 ? 25 : 400));
  let text = '';
  for (let i = 0; i < count; i += 1) {
    text += FRAGMENTS[Math.floor(random() * FRAGMENTS.length)] as string;
  }
  return text;
}

/** Runs the whole pipeline; only `FormulaError` may escape. */
function pipeline(source: string): void {
  try {
    const ast = parse(source);
    const text = serialize(ast);
    expect(stripSpans(parse(text))).toEqual(stripSpans(ast));
    for (const snapshot of [inOrders, inCustomers]) {
      const resolved = resolveNames(ast, snapshot);
      renderNames(serialize(resolved, 'stored'), snapshot);
    }
  } catch (error) {
    if (!(error instanceof FormulaError)) throw error;
  }
}

function time(source: string): number {
  const started = performance.now();
  try {
    parse(source);
  } catch (error) {
    if (!(error instanceof FormulaError)) throw error;
  }
  return performance.now() - started;
}

/** Best of a few runs, so a GC pause or a busy machine does not fail the budget. */
function bestTime(source: string, runs = 5): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < runs && best >= BUDGET_MS; i += 1) best = Math.min(best, time(source));
  return best;
}

describe('fuzz: 10,000 random formulas', () => {
  const random = prng(0x5eed451);
  const inputs = Array.from({ length: 10_000 }, () => randomFormula(random));

  it('throws nothing but FormulaError through parse → serialize → resolve → render', () => {
    let parsed = 0;
    for (const source of inputs) {
      try {
        parse(source);
        parsed += 1;
      } catch (error) {
        if (!(error instanceof FormulaError)) throw error;
      }
      pipeline(source);
    }
    // The generator reaches valid formulas too, not only errors.
    expect(parsed).toBeGreaterThan(50);
  });

  it(`parses each one in under ${String(BUDGET_MS)} ms`, () => {
    for (const source of inputs.slice(0, 200)) time(source); // warm up
    const slow = inputs.filter(
      (source) => bestTime(source, 1) >= BUDGET_MS && bestTime(source) >= BUDGET_MS,
    );
    // Deterministic part (S4b-review §7.1): parsing is linear — no more tokens
    // than characters (+ end) and no more AST nodes than tokens.
    for (const source of inputs) {
      try {
        const tokens = tokenize(source).length;
        expect(tokens).toBeLessThanOrEqual(source.length + 1);
        expect(countNodes(parse(source))).toBeLessThanOrEqual(tokens);
      } catch (error) {
        if (!(error instanceof FormulaError)) throw error;
      }
    }
    // The clock only counts on a machine that is not overloaded.
    if (timingBudgetsApply()) expect(slow).toEqual([]);
  });
});

describe('performance', () => {
  /** A realistic formula of exactly MAX_FORMULA_LENGTH characters. */
  function longFormula(): string {
    const parts: string[] = [];
    let text = '';
    for (let i = 0; ; i += 1) {
      const part = `IF([Số tiền] > ${String(i)}, [Khách hàng].[Hạng] & "mức ${String(i)}", ROUND([Chi phí] * 1.5, 2))`;
      const next = `CONCATENATE(${[...parts, part].join(', ')})`;
      if (next.length > MAX_FORMULA_LENGTH) break;
      parts.push(part);
      text = next;
    }
    const padding = MAX_FORMULA_LENGTH - text.length;
    return `${text.slice(0, -1)}${padding > 0 ? `, "${'x'.repeat(Math.max(0, padding - 4))}"` : ''})`;
  }

  it(`parses a ${String(MAX_FORMULA_LENGTH)}-character formula in under ${String(BUDGET_MS)} ms`, () => {
    const source = longFormula();
    expect(source.length).toBe(MAX_FORMULA_LENGTH);
    expect(() => parse(source)).not.toThrow();
    expect(countNodes(parse(source))).toBeLessThanOrEqual(tokenize(source).length);
    for (let i = 0; i < 20; i += 1) parse(source); // warm up
    const best = bestTime(source);
    if (timingBudgetsApply()) expect(best).toBeLessThan(BUDGET_MS);
    expect(() => resolveNames(parse(source), inOrders)).not.toThrow();
  });

  it(`rejects a huge input by length before lexing it`, () => {
    const source = '('.repeat(1_000_000);
    // Deterministic: refused by the length check, before the lexer.
    expect(() => parse(source)).toThrow(
      expect.objectContaining({ code: 'FORMULA_LIMIT_EXCEEDED', detail: 'MAX_LENGTH' }),
    );
    const best = bestTime(source);
    if (timingBudgetsApply()) expect(best).toBeLessThan(BUDGET_MS);
  });
});
