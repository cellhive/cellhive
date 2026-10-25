import { describe, expect, it } from 'vitest';

import { analyze, FormulaError, MVP_FUNCTION_NAMES, S4B_FUNCTION_NAMES } from '../src/index.js';

import { customers, orders } from './typed-fixture.js';

/** Deterministic PRNG (mulberry32). */
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

const FIELDS = [
  '[Số tiền]',
  '[Tiêu đề]',
  '[Trạng thái]',
  '[Tags]',
  '[Ngày nhận]',
  '[Hạn chót]',
  '[Đã trả]',
  '[Tệp]',
  '[Khách hàng]',
  '[Người tạo]',
  '[Tickets]',
  '[Đơn hàng]',
  '[Tên]',
  '[Các đơn]',
  'CurrentValue',
  'CurrentValue.[Hạn]',
  'CurrentValue.[Số tiền]',
  '[Khách hàng].[Tên]',
  '[Tickets].[Hạn]',
  '[Đơn hàng].[Tags]',
  '"a"',
  '1',
  'TRUE',
  'x',
];
const FUNCTIONS = [...MVP_FUNCTION_NAMES, ...S4B_FUNCTION_NAMES].filter((name) => name !== 'LET');
const OPERATORS = [' + ', ' - ', ' * ', ' & ', ' = ', ' < ', ' && ', ' || '];

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)] as T;
}

/** A random, mostly well-formed expression, so the typecheck (not the parser) does the work. */
function expression(random: () => number, depth: number): string {
  const roll = random();
  if (depth > 3 || roll < 0.3) return pick(random, FIELDS);
  if (roll < 0.5)
    return `${expression(random, depth + 1)}${pick(random, OPERATORS)}${expression(random, depth + 1)}`;
  if (roll < 0.6)
    return `LET(x, ${expression(random, depth + 1)}, ${expression(random, depth + 1)})`;
  const name = pick(random, FUNCTIONS);
  const count = Math.floor(random() * 4);
  const args = Array.from({ length: count }, () => expression(random, depth + 1));
  if (args.length > 0 && random() < 0.4) {
    const [first, ...rest] = args;
    return `${first ?? ''}.${name}(${rest.join(', ')})`;
  }
  return `${name}(${args.join(', ')})`;
}

describe('fuzz: analyze never throws', () => {
  const random = prng(0x7452);
  const inputs = Array.from({ length: 3000 }, () => expression(random, 0));

  it('returns results or FormulaErrors for 3,000 random formulas', { timeout: 60_000 }, () => {
    let typed = 0;
    for (const source of inputs) {
      for (const snapshot of [orders, customers]) {
        const result = analyze(source, snapshot, { form: 'display' });
        for (const error of result.errors) expect(error).toBeInstanceOf(FormulaError);
        expect(result.result_type === null).toBe(result.errors.length > 0);
        if (result.errors.length === 0) typed += 1;
      }
    }
    // The generator reaches well-typed formulas too.
    expect(typed).toBeGreaterThan(100);
  });
});
