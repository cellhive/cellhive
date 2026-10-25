import { describe, expect, it } from 'vitest';

import { bracketName, parse, quoteString, serialize, stripSpans, type Expr } from '../src/index.js';

const span = { start: 0, length: 1 };
const num = (value: string): Expr => ({ type: 'number', value, ...span });
const ref = (name: string): Expr => ({ type: 'reference', name, id: null, kind: null, ...span });

describe('serialize: canonical text', () => {
  const cases: { source: string; expected: string }[] = [
    { source: '1+2*3', expected: '1 + 2 * 3' },
    { source: '(1+2)*3', expected: '(1 + 2) * 3' },
    { source: '1-(2-3)', expected: '1 - (2 - 3)' },
    { source: '(1-2)-3', expected: '1 - 2 - 3' },
    { source: '2*(3%4)', expected: '2 * (3 % 4)' },
    { source: '-(1+2)', expected: '-(1 + 2)' },
    { source: '-(-1)', expected: '--1' },
    { source: '- - 1', expected: '--1' },
    { source: '(-1).ABS()', expected: '(-1).ABS()' },
    { source: '([A]+[B]).[C]', expected: '([A] + [B]).[C]' },
    { source: '1<>2', expected: '1 != 2' },
    { source: 'a&&b', expected: '' },
    { source: '[A]>1&&[B]<2||[C]', expected: '[A] > 1 && [B] < 2 || [C]' },
    { source: '[A]||([B]&&[C])', expected: '[A] || [B] && [C]' },
    { source: '([A]||[B])&&[C]', expected: '([A] || [B]) && [C]' },
    { source: '"a"&(1+2)', expected: '"a" & 1 + 2' },
    { source: '("a"&1)+2', expected: '("a" & 1) + 2' },
    { source: 'sum( 1 ,2 )', expected: 'SUM(1, 2)' },
    { source: '[A] . sum ( )', expected: '[A].SUM()' },
    { source: 'true', expected: 'TRUE' },
    { source: 'currentvalue.[X]', expected: 'CurrentValue.[X]' },
    { source: 'let(x,1,x+1)', expected: 'LET(x, 1, x + 1)' },
    { source: '"say \\"hi\\"\n"', expected: '"say \\"hi\\"\\n"' },
    { source: '"\\d+"', expected: '"\\\\d+"' },
    { source: '[a\\]b]', expected: '[a\\]b]' },
    { source: '[a\\b]', expected: '[a\\\\b]' },
    { source: '#REF[fld_abcdefghijklmnop]', expected: '#REF[fld_abcdefghijklmnop]' },
    { source: '0.10', expected: '0.10' },
  ].filter((item) => item.expected !== '');

  it.each(cases)('$source → $expected', ({ source, expected }) => {
    expect(serialize(parse(source))).toBe(expected);
  });

  it('adds parentheses where the tree needs them even without source text', () => {
    const tree: Expr = {
      type: 'binary',
      operator: '*',
      left: { type: 'binary', operator: '+', left: num('1'), right: num('2'), ...span },
      right: { type: 'unary', operator: '-', operand: ref('A'), ...span },
      ...span,
    };
    expect(serialize(tree)).toBe('(1 + 2) * -[A]');
  });

  it('writes a chained call on a binary receiver in parentheses', () => {
    const tree: Expr = {
      type: 'call',
      name: 'ROUND',
      chained: true,
      args: [{ type: 'binary', operator: '/', left: num('1'), right: num('3'), ...span }, num('2')],
      ...span,
    };
    expect(serialize(tree)).toBe('(1 / 3).ROUND(2)');
  });

  it('refuses the stored form of an unresolved reference', () => {
    expect(() => serialize(ref('A'), 'stored')).toThrow(TypeError);
  });

  it.each([
    ['plain', 'Số tiền', '[Số tiền]'],
    ['bracket', 'a]b', '[a\\]b]'],
    ['backslash', 'a\\b', '[a\\\\b]'],
    ['opening bracket', '[x', '[[x]'],
  ])('bracketName: %s', (_name, value, expected) => {
    expect(bracketName(value)).toBe(expected);
  });

  it.each([
    ['plain', 'abc', '"abc"'],
    ['quote', 'a"b', '"a\\"b"'],
    ['controls', '\n\t\r', '"\\n\\t\\r"'],
    ['backslash', '\\', '"\\\\"'],
  ])('quoteString: %s', (_name, value, expected) => {
    expect(quoteString(value)).toBe(expected);
  });
});

describe('serialize: parse(serialize(ast)) ≡ ast', () => {
  const sources = [
    'IF([Trạng thái] = "Hoàn thành", [Số tiền] * 0.1, 0)',
    '[Khách hàng].[Hạng]',
    '[Đơn hàng].FILTER(CurrentValue.[Khách hàng].CONTAIN([Tên]) && CurrentValue.[Trạng thái] = "Đã giao").[Số tiền].SUM()',
    'COUNTIF([Tickets], CurrentValue.[Người phụ trách] = [Nhân viên] && CurrentValue.[Hạn] < TODAY())',
    '[Tags].FILTER(CurrentValue != "Nội bộ").ARRAYJOIN(", ")',
    'WORKDAY([Ngày nhận], 3)',
    '1 - (2 - (3 - 4))',
    '((1 - 2) - 3) - 4',
    '-(1 + 2) * -(3 - 4) / --5',
    '2 * 3 % 4 / 5',
    '1 = 2 = 3',
    '1 = (2 = 3)',
    '(1 < 2) < 3',
    '1 < (2 < 3)',
    '"a" & ("b" & "c")',
    '("a" & "b") & "c"',
    '[A] && ([B] || [C]) && !([D] = 1) '.replace('!', 'NOT'),
    'LET(x, 1, y, LET(z, x, z * 2), x + y).ROUND(2)',
    'LET(rows, [T].FILTER(CurrentValue.[A] > 1), rows.[B].SUM())',
    '(-[A]).[B]',
    '(1 + 2).ROUND().ABS()',
    'SUM(1, SUM(2, SUM(3)))',
    '"quote \\" backslash \\\\ newline \\n tab \\t"',
    '[name with \\] and \\\\] & [x]',
    '#REF[fld_abcdefghijklmnop] + [L].#REF[fld_abcdefghijklmnop]',
    '[A].FILTER(CurrentValue > 1).SORT().FIRST()',
    'IFS([A] > 1, "a", [A] > 0, "b", TRUE, "c")',
    'TRUE() || FALSE',
  ];

  it.each(sources)('%s', (source) => {
    const ast = parse(source);
    const text = serialize(ast);
    expect(stripSpans(parse(text))).toEqual(stripSpans(ast));
    // Canonical text is a fixed point.
    expect(serialize(parse(text))).toBe(text);
  });
});
