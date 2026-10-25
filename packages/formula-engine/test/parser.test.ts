import { describe, expect, it } from 'vitest';

import {
  BINARY_PRECEDENCE,
  FormulaError,
  MAX_AST_DEPTH,
  MAX_FORMULA_LENGTH,
  MAX_FUNCTION_ARGUMENTS,
  MAX_LET_VARIABLES,
  parse,
  renderNames,
  resolveNames,
  serialize,
  stripSpans,
  tryParse,
  type BinaryOperator,
  type Expr,
} from '../src/index.js';

import { nodes, shape } from './fixture.js';

const catchError = (source: string, form: 'display' | 'stored' = 'display'): FormulaError => {
  const result = tryParse(source, { form });
  if (result.ok) throw new Error(`expected "${source}" to fail`);
  return result.error;
};

describe('parse: SPEC §9.2 examples', () => {
  const cases: { source: string; expected: string }[] = [
    {
      source: 'IF([Trạng thái] = "Hoàn thành", [Số tiền] * 0.1, 0)',
      expected: 'IF(([Trạng thái] = "Hoàn thành"), ([Số tiền] * 0.1), 0)',
    },
    { source: '[Khách hàng].[Hạng]', expected: '[Khách hàng].[Hạng]' },
    {
      source:
        '[Đơn hàng].FILTER(CurrentValue.[Khách hàng].CONTAIN([Tên]) && CurrentValue.[Trạng thái] = "Đã giao").[Số tiền].SUM()',
      expected:
        '~SUM(~FILTER([Đơn hàng], (~CONTAIN(CV.[Khách hàng], [Tên]) && (CV.[Trạng thái] = "Đã giao"))).[Số tiền])',
    },
    {
      source:
        'COUNTIF([Tickets], CurrentValue.[Người phụ trách] = [Nhân viên] && CurrentValue.[Hạn] < TODAY())',
      expected:
        'COUNTIF([Tickets], ((CV.[Người phụ trách] = [Nhân viên]) && (CV.[Hạn] < TODAY())))',
    },
    {
      source: '[Tags].FILTER(CurrentValue != "Nội bộ").ARRAYJOIN(", ")',
      expected: '~ARRAYJOIN(~FILTER([Tags], (CV != "Nội bộ")), ", ")',
    },
    { source: 'WORKDAY([Ngày nhận], 3)', expected: 'WORKDAY([Ngày nhận], 3)' },
    { source: 'SUM([A], [B])', expected: 'SUM([A], [B])' },
    {
      source: '[Orders].FILTER(TRUE).[Amount].SUM()',
      expected: '~SUM(~FILTER([Orders], TRUE).[Amount])',
    },
    { source: '[LinkA].[LinkB].[Field]', expected: '[LinkA].[LinkB].[Field]' },
    { source: '[LinkA].[LinkB].[LinkC].[Field]', expected: '[LinkA].[LinkB].[LinkC].[Field]' },
    { source: '[Table]', expected: '[Table]' },
    { source: 'CurrentValue', expected: 'CV' },
    { source: '[Tags].LISTCOMBINE()', expected: '~LISTCOMBINE([Tags])' },
  ];

  it.each(cases)('$source', ({ source, expected }) => {
    expect(shape(parse(source))).toBe(expected);
  });
});

describe('parse: operator precedence (SPEC §9.2 table)', () => {
  const operators = Object.keys(BINARY_PRECEDENCE) as BinaryOperator[];
  const pairs = operators.flatMap((first) => operators.map((second) => [first, second] as const));

  it.each(pairs)('1 %s 2 %s 3', (first, second) => {
    const tighter = BINARY_PRECEDENCE[second] > BINARY_PRECEDENCE[first];
    const expected = tighter ? `(1 ${first} (2 ${second} 3))` : `((1 ${first} 2) ${second} 3)`;
    expect(shape(parse(`1 ${first} 2 ${second} 3`))).toBe(expected);
  });

  const cases: { source: string; expected: string }[] = [
    { source: '1 + 2 * 3', expected: '(1 + (2 * 3))' },
    { source: '(1 + 2) * 3', expected: '((1 + 2) * 3)' },
    { source: '1 - 2 - 3', expected: '((1 - 2) - 3)' },
    { source: '1 - (2 - 3)', expected: '(1 - (2 - 3))' },
    { source: '8 / 4 / 2', expected: '((8 / 4) / 2)' },
    { source: '7 % 4 * 2', expected: '((7 % 4) * 2)' },
    { source: '-1', expected: '(-1)' },
    { source: '+1', expected: '(+1)' },
    { source: '--1', expected: '(-(-1))' },
    { source: '-+-1', expected: '(-(+(-1)))' },
    { source: '-2 * 3', expected: '((-2) * 3)' },
    { source: '2 * -3', expected: '(2 * (-3))' },
    { source: '-2 % 3', expected: '((-2) % 3)' },
    { source: '1 - -1', expected: '(1 - (-1))' },
    { source: '-[A].SUM()', expected: '(-~SUM([A]))' },
    { source: '-[A].[B]', expected: '(-[A].[B])' },
    { source: '"a" & 1 + 2', expected: '("a" & (1 + 2))' },
    { source: '"a" & "b" = "ab"', expected: '(("a" & "b") = "ab")' },
    { source: '1 < 2 = TRUE', expected: '((1 < 2) = TRUE)' },
    { source: '1 <> 2', expected: '(1 != 2)' },
    { source: '[A] > 1 && [B] < 2 || [C]', expected: '((([A] > 1) && ([B] < 2)) || [C])' },
    { source: '[A] || [B] && [C]', expected: '([A] || ([B] && [C]))' },
    { source: '([A] || [B]) && [C]', expected: '(([A] || [B]) && [C])' },
    { source: '((((1))))', expected: '1' },
    { source: '1 >= 2 != 3 <= 4', expected: '((1 >= 2) != (3 <= 4))' },
  ];

  it.each(cases)('$source', ({ source, expected }) => {
    expect(shape(parse(source))).toBe(expected);
  });
});

describe('parse: literals, keywords, calls and chaining', () => {
  const cases: { source: string; expected: string }[] = [
    { source: 'TRUE', expected: 'TRUE' },
    { source: 'false', expected: 'FALSE' },
    { source: 'True()', expected: 'TRUE()' },
    { source: 'currentvalue', expected: 'CV' },
    { source: 'CURRENTVALUE.[X]', expected: 'CV.[X]' },
    { source: 'today()', expected: 'TODAY()' },
    { source: 'Sum(1, 2)', expected: 'SUM(1, 2)' },
    { source: 'NOW()', expected: 'NOW()' },
    { source: 'IF(1, 2)', expected: 'IF(1, 2)' },
    { source: 'IF( 1 , IF(2,3,4) , 5 )', expected: 'IF(1, IF(2, 3, 4), 5)' },
    { source: '[A].sum()', expected: '~SUM([A])' },
    { source: '[A].ROUND(2)', expected: '~ROUND([A], 2)' },
    { source: '1.5.ROUND()', expected: '~ROUND(1.5)' },
    { source: '"x".LEN()', expected: '~LEN("x")' },
    { source: '(1 + 2).ROUND(0)', expected: '~ROUND((1 + 2), 0)' },
    { source: 'LIST(1, 2).FIRST()', expected: '~FIRST(LIST(1, 2))' },
    {
      source: '[A].FILTER(CurrentValue > 1).SORT().FIRST()',
      expected: '~FIRST(~SORT(~FILTER([A], (CV > 1))))',
    },
    { source: '[A] . [B]', expected: '[A].[B]' },
    { source: '[A].[B].SUM() + 1', expected: '(~SUM([A].[B]) + 1)' },
    { source: 'SUM([A].[B])', expected: 'SUM([A].[B])' },
    { source: 'FILTER([T], CurrentValue.[X] = 1).[Y]', expected: 'FILTER([T], (CV.[X] = 1)).[Y]' },
    { source: 'RECORD_ID()', expected: 'RECORD_ID()' },
    { source: 'PI()', expected: 'PI()' },
    { source: 'LOOKUP([T], 1)', expected: 'LOOKUP([T], 1)' },
    { source: 'STDEV([A])', expected: 'STDEV([A])' },
    { source: '[a\\]b]', expected: '[a]b]' },
    { source: '#REF[fld_abcdefghijklmnop]', expected: '[#fld_abcdefghijklmnop]' },
    { source: '[L].#REF[fld_abcdefghijklmnop]', expected: '[L].[#fld_abcdefghijklmnop]' },
  ];

  it.each(cases)('$source', ({ source, expected }) => {
    expect(shape(parse(source))).toBe(expected);
  });

  it('keeps the number text and marks chained calls', () => {
    const ast = parse('[A].ROUND(2.50)');
    expect(ast).toMatchObject({
      type: 'call',
      name: 'ROUND',
      chained: true,
      args: [
        { type: 'reference', name: 'A' },
        { type: 'number', value: '2.50' },
      ],
    });
  });
});

describe('parse: LET', () => {
  const cases: { source: string; expected: string }[] = [
    { source: 'LET(x, 1, x + 1)', expected: 'LET(x=1; ($x + 1))' },
    { source: 'let(x, 1, y, x * 2, x + y)', expected: 'LET(x=1, y=($x * 2); ($x + $y))' },
    { source: 'LET(tổng, [A] + [B], tổng * 2)', expected: 'LET(tổng=([A] + [B]); ($tổng * 2))' },
    { source: 'LET(x, 1, X)', expected: 'LET(x=1; $X)' },
    {
      source: 'LET(x, 1, LET(y, x + 1, x * y))',
      expected: 'LET(x=1; LET(y=($x + 1); ($x * $y)))',
    },
    {
      source: 'LET(x, 1, LET(x, 2, x))',
      expected: 'LET(x=1; LET(x=2; $x))',
    },
    {
      source: 'LET(x, LET(y, 2, y * 2), x)',
      expected: 'LET(x=LET(y=2; ($y * 2)); $x)',
    },
    {
      source: 'LET(rows, [T].FILTER(CurrentValue.[A] > 1), rows.[B].SUM())',
      expected: 'LET(rows=~FILTER([T], (CV.[A] > 1)); ~SUM($rows.[B]))',
    },
    { source: 'LET(x, 1, x).ROUND()', expected: '~ROUND(LET(x=1; $x))' },
    { source: 'LET(_a1, 1, _a1)', expected: 'LET(_a1=1; $_a1)' },
  ];

  it.each(cases)('$source', ({ source, expected }) => {
    expect(shape(parse(source))).toBe(expected);
  });
});

describe('parse: spans', () => {
  it('gives every node a span inside the source', () => {
    const source = 'IF([Số tiền] > 1, [L].[X].SUM() & "😀", LET(x, -2, x))';
    for (const node of nodes(parse(source))) {
      expect(node.start).toBeGreaterThanOrEqual(0);
      expect(node.length).toBeGreaterThan(0);
      expect(node.start + node.length).toBeLessThanOrEqual(source.length);
    }
  });

  const cases: { source: string; pick: (ast: Expr) => Expr; text: string }[] = [
    { source: '  1 + 2 ', pick: (ast) => ast, text: '1 + 2' },
    { source: '(1 + 2) * 3', pick: (ast) => ast, text: '(1 + 2) * 3' },
    { source: '((1)) + 2', pick: (ast) => (ast.type === 'binary' ? ast.left : ast), text: '((1))' },
    { source: 'SUM(1, 2)', pick: (ast) => ast, text: 'SUM(1, 2)' },
    { source: '[A].SUM()', pick: (ast) => ast, text: '[A].SUM()' },
    { source: '[Số].[Tiền]', pick: (ast) => ast, text: '[Số].[Tiền]' },
    { source: '-[A]', pick: (ast) => ast, text: '-[A]' },
    {
      source: '"a😀b" & 1',
      pick: (ast) => (ast.type === 'binary' ? ast.left : ast),
      text: '"a😀b"',
    },
    { source: 'LET(x, 1, x)', pick: (ast) => ast, text: 'LET(x, 1, x)' },
    {
      source: 'LET(x, 1, x)',
      pick: (ast) => (ast.type === 'let' ? ast.body : ast),
      text: 'x',
    },
  ];

  it.each(cases)('$source → "$text"', ({ source, pick, text }) => {
    const node = pick(parse(source));
    expect(source.slice(node.start, node.start + node.length)).toBe(text);
  });

  it('keeps the span of a LET binding on its name', () => {
    const ast = parse('LET(abc, 1, abc)');
    expect(ast.type === 'let' && ast.bindings[0]).toMatchObject({
      name: 'abc',
      start: 4,
      length: 3,
    });
  });
});

describe('parse: errors at their position', () => {
  const cases: { name: string; source: string; detail: string; start: number; length: number }[] = [
    { name: 'empty formula', source: '', detail: 'UNEXPECTED_END', start: 0, length: 0 },
    { name: 'blank formula', source: '   ', detail: 'UNEXPECTED_END', start: 3, length: 0 },
    { name: 'dangling operator', source: '1 +', detail: 'UNEXPECTED_END', start: 3, length: 0 },
    { name: 'two operators', source: '1 + * 2', detail: 'UNEXPECTED_TOKEN', start: 4, length: 1 },
    { name: 'two values', source: '[A] [B]', detail: 'UNEXPECTED_TOKEN', start: 4, length: 3 },
    { name: 'two numbers', source: '1 2', detail: 'UNEXPECTED_TOKEN', start: 2, length: 1 },
    {
      name: 'unclosed parenthesis',
      source: '(1 + 2',
      detail: 'UNEXPECTED_END',
      start: 6,
      length: 0,
    },
    {
      name: 'extra closing parenthesis',
      source: '(1))',
      detail: 'UNEXPECTED_TOKEN',
      start: 3,
      length: 1,
    },
    { name: 'empty parentheses', source: '()', detail: 'UNEXPECTED_TOKEN', start: 1, length: 1 },
    { name: 'unclosed call', source: 'SUM(1, 2', detail: 'UNEXPECTED_END', start: 8, length: 0 },
    { name: 'trailing comma', source: 'SUM(1,)', detail: 'UNEXPECTED_TOKEN', start: 6, length: 1 },
    { name: 'leading comma', source: 'SUM(,1)', detail: 'UNEXPECTED_TOKEN', start: 4, length: 1 },
    { name: 'double comma', source: 'IF(1,,2)', detail: 'UNEXPECTED_TOKEN', start: 5, length: 1 },
    {
      name: 'comma outside a call',
      source: '1, 2',
      detail: 'UNEXPECTED_TOKEN',
      start: 1,
      length: 1,
    },
    {
      name: 'unknown function',
      source: '1 + FOO(1)',
      detail: 'UNKNOWN_FUNCTION',
      start: 4,
      length: 3,
    },
    {
      name: 'unknown chained function',
      source: '[A].FOO()',
      detail: 'UNKNOWN_FUNCTION',
      start: 4,
      length: 3,
    },
    {
      name: 'Phase 2 function',
      source: 'RANDOMBETWEEN(1, 9)',
      detail: 'UNSUPPORTED_FUNCTION',
      start: 0,
      length: 13,
    },
    {
      name: 'Phase 2 trigonometry',
      source: '1 + sin(1)',
      detail: 'UNSUPPORTED_FUNCTION',
      start: 4,
      length: 3,
    },
    {
      name: 'Phase 2 chained',
      source: '[A].REGEXEXTRACTALL("x")',
      detail: 'UNSUPPORTED_FUNCTION',
      start: 4,
      length: 15,
    },
    {
      name: 'Phase 2 SEQUENCE',
      source: 'SEQUENCE(3)',
      detail: 'UNSUPPORTED_FUNCTION',
      start: 0,
      length: 8,
    },
    {
      name: 'Phase 2 DISTANCE',
      source: 'DISTANCE(1, 2)',
      detail: 'UNSUPPORTED_FUNCTION',
      start: 0,
      length: 8,
    },
    {
      name: 'Phase 2 RANDOMITEM',
      source: 'RANDOMITEM([A])',
      detail: 'UNSUPPORTED_FUNCTION',
      start: 0,
      length: 10,
    },
    {
      name: 'function without parentheses',
      source: 'TODAY + 1',
      detail: 'UNKNOWN_NAME',
      start: 0,
      length: 5,
    },
    { name: 'unknown bare word', source: 'abc', detail: 'UNKNOWN_NAME', start: 0, length: 3 },
    {
      name: 'variable outside its LET',
      source: 'LET(x, 1, x) + x',
      detail: 'UNKNOWN_NAME',
      start: 15,
      length: 1,
    },
    {
      name: 'variable used in its own value',
      source: 'LET(x, x, 1)',
      detail: 'UNKNOWN_NAME',
      start: 7,
      length: 1,
    },
    {
      name: 'later variable used early',
      source: 'LET(x, y, y, 1, x)',
      detail: 'UNKNOWN_NAME',
      start: 7,
      length: 1,
    },
    {
      name: 'chained member without name',
      source: '[A].',
      detail: 'UNEXPECTED_END',
      start: 4,
      length: 0,
    },
    { name: 'chained number', source: '[A].1', detail: 'UNEXPECTED_TOKEN', start: 4, length: 1 },
    {
      name: 'chained name without call',
      source: '[A].SUM',
      detail: 'UNEXPECTED_END',
      start: 7,
      length: 0,
    },
    {
      name: 'chained name then operator',
      source: '[A].SUM + 1',
      detail: 'UNEXPECTED_TOKEN',
      start: 8,
      length: 1,
    },
    {
      name: 'call on a reference',
      source: '[A](1)',
      detail: 'UNEXPECTED_TOKEN',
      start: 3,
      length: 1,
    },
    { name: 'dot at start', source: '.SUM()', detail: 'UNEXPECTED_TOKEN', start: 0, length: 1 },
    {
      name: 'closing parenthesis first',
      source: ')',
      detail: 'UNEXPECTED_TOKEN',
      start: 0,
      length: 1,
    },
    {
      name: 'string then name',
      source: '"a" [B]',
      detail: 'UNEXPECTED_TOKEN',
      start: 4,
      length: 3,
    },
    { name: 'LET without variables', source: 'LET(1)', detail: 'INVALID_LET', start: 0, length: 6 },
    { name: 'LET without body', source: 'LET(x, 1)', detail: 'INVALID_LET', start: 8, length: 1 },
    {
      name: 'LET with a non-name variable',
      source: 'LET([A], 1, 2)',
      detail: 'INVALID_LET',
      start: 4,
      length: 3,
    },
    {
      name: 'LET with a string variable',
      source: 'LET("x", 1, 2)',
      detail: 'INVALID_LET',
      start: 4,
      length: 3,
    },
    { name: 'LET chained', source: '[A].LET(x, 1, x)', detail: 'INVALID_LET', start: 4, length: 3 },
    {
      name: 'LET variable named like a function',
      source: 'LET(sum, 1, sum)',
      detail: 'RESERVED_NAME',
      start: 4,
      length: 3,
    },
    {
      name: 'LET variable named IF',
      source: 'LET(IF, 1, 2)',
      detail: 'RESERVED_NAME',
      start: 4,
      length: 2,
    },
    {
      name: 'LET variable named TRUE',
      source: 'LET(true, 1, 2)',
      detail: 'RESERVED_NAME',
      start: 4,
      length: 4,
    },
    {
      name: 'LET variable named CurrentValue',
      source: 'LET(CurrentValue, 1, 2)',
      detail: 'RESERVED_NAME',
      start: 4,
      length: 12,
    },
    {
      name: 'LET variable named LET',
      source: 'LET(let, 1, 2)',
      detail: 'RESERVED_NAME',
      start: 4,
      length: 3,
    },
    {
      name: 'LET variable named like a Phase 2 function',
      source: 'LET(sin, 1, 2)',
      detail: 'RESERVED_NAME',
      start: 4,
      length: 3,
    },
    {
      name: 'LET duplicate variable',
      source: 'LET(x, 1, X, 2, x)',
      detail: 'DUPLICATE_VARIABLE',
      start: 10,
      length: 1,
    },
    { name: 'LET unclosed', source: 'LET(x, 1, x', detail: 'UNEXPECTED_END', start: 11, length: 0 },
    { name: 'LET empty', source: 'LET()', detail: 'UNEXPECTED_TOKEN', start: 4, length: 1 },
    {
      name: 'stored text in display form',
      source: '#REF[abc]',
      detail: 'INVALID_REFERENCE',
      start: 0,
      length: 9,
    },
    {
      name: 'broken reference with a record ID',
      source: '#REF[rec_abcdefghijklmnop]',
      detail: 'INVALID_REFERENCE',
      start: 0,
      length: 26,
    },
  ];

  it.each(cases)('$name: $source → $detail', ({ source, detail, start, length }) => {
    const error = catchError(source);
    expect({
      code: error.code,
      detail: error.detail,
      start: error.start,
      length: error.length,
    }).toEqual({
      code: 'FORMULA_SYNTAX_ERROR',
      detail,
      start,
      length,
    });
  });

  it('hints the parentheses of a function used as a name', () => {
    expect(catchError('TODAY').message).toContain('TODAY()');
  });

  it('turns into a problem error item with the position', () => {
    expect(catchError('1 + FOO(1)').toProblemError('options.formula')).toEqual({
      path: 'options.formula',
      code: 'UNKNOWN_FUNCTION',
      message: 'Unknown function "FOO".',
      params: { name: 'FOO', position: { start: 4, length: 3 } },
    });
  });

  it('parse throws the same FormulaError', () => {
    expect(() => parse('1 +')).toThrow(FormulaError);
  });
});

describe('parse: stored form', () => {
  const field = 'fld_abcdefghijklmnop';
  const table = 'tbl_abcdefghijklmnop';

  it.each([
    [`[${field}]`, { type: 'reference', id: field, kind: 'field', name: null }],
    [`[${table}]`, { type: 'reference', id: table, kind: 'table', name: null }],
    [`[${table}].[${field}]`, { type: 'member', property: { id: field, kind: 'field' } }],
  ])('%s', (source, expected) => {
    expect(parse(source, { form: 'stored' })).toMatchObject(expected);
  });

  it.each([
    ['[Số tiền]', 0, 9],
    ['[fld_short]', 0, 11],
    ['[rec_abcdefghijklmnop]', 0, 22],
    [`#REF[${field}]`, 0, 26],
    [`1 + [${field}].[Tên]`, 27, 5],
  ])('rejects %s', (source, start, length) => {
    const error = catchError(source, 'stored');
    expect([error.detail, error.start, error.length]).toEqual(['INVALID_REFERENCE', start, length]);
  });

  it('has no length limit (IDs are longer than names)', () => {
    const source = Array.from({ length: 250 }, () => `[${field}]`).join(' & ');
    expect(source.length).toBeGreaterThan(MAX_FORMULA_LENGTH);
    expect(() =>
      parse(`CONCATENATE(${source.replaceAll(' & ', ', ')})`, { form: 'stored' }),
    ).not.toThrow();
  });
});

describe('parse: SPEC §9.5 limits', () => {
  const limit = (source: string) => {
    const error = catchError(source);
    return {
      code: error.code,
      detail: error.detail,
      limit: error.params.limit,
      start: error.start,
    };
  };

  it(`accepts ${String(MAX_FORMULA_LENGTH)} characters`, () => {
    const source = `"${'x'.repeat(MAX_FORMULA_LENGTH - 2)}"`;
    expect(parse(source)).toMatchObject({ type: 'string' });
  });

  it(`rejects ${String(MAX_FORMULA_LENGTH + 1)} characters`, () => {
    const source = `"${'x'.repeat(MAX_FORMULA_LENGTH - 1)}"`;
    expect(limit(source)).toEqual({
      code: 'FORMULA_LIMIT_EXCEEDED',
      detail: 'MAX_LENGTH',
      limit: MAX_FORMULA_LENGTH,
      start: MAX_FORMULA_LENGTH,
    });
  });

  const nestedCalls = (levels: number) => `${'ABS('.repeat(levels - 1)}1${')'.repeat(levels - 1)}`;
  const nestedParens = (levels: number) => `${'('.repeat(levels - 1)}1${')'.repeat(levels - 1)}`;
  const sumChain = (terms: number) =>
    Array.from({ length: terms }, (_, i) => String(i)).join(' + ');

  it.each([
    ['nested calls', nestedCalls(MAX_AST_DEPTH)],
    ['nested parentheses', nestedParens(MAX_AST_DEPTH)],
    ['flat chain of 60 terms is one level', sumChain(60)],
    ['flat chain of mixed + and - is one level', sumChain(60).replaceAll(' + 1', ' - 1')],
    [
      'flat chain inside the deepest call',
      `${'ABS('.repeat(MAX_AST_DEPTH - 2)}${sumChain(60)}${')'.repeat(MAX_AST_DEPTH - 2)}`,
    ],
    ['chained calls', `1${'.ABS()'.repeat(MAX_AST_DEPTH - 1)}`],
    ['unary chain', `${'-'.repeat(MAX_AST_DEPTH - 1)}1`],
  ])(`accepts depth ${String(MAX_AST_DEPTH)}: %s`, (_name, source) => {
    expect(() => parse(source)).not.toThrow();
  });

  it.each([
    ['nested calls', nestedCalls(MAX_AST_DEPTH + 1)],
    ['nested parentheses', nestedParens(MAX_AST_DEPTH + 1)],
    ['chained calls', `1${'.ABS()'.repeat(MAX_AST_DEPTH)}`],
    [
      'flat chain one level too deep',
      `${'ABS('.repeat(MAX_AST_DEPTH - 1)}${sumChain(3)}${')'.repeat(MAX_AST_DEPTH - 1)}`,
    ],
    ['unary chain', `${'-'.repeat(MAX_AST_DEPTH)}1`],
    ['very deep nesting does not overflow the stack', nestedParens(1500)],
    ['very deep unary nesting', `${'-'.repeat(1500)}1`],
    ['very long chained calls', `1${'.ABS()'.repeat(600)}`],
  ])(`rejects depth ${String(MAX_AST_DEPTH + 1)}: %s`, (_name, source) => {
    const error = catchError(source);
    expect([error.code, error.detail, error.params.limit]).toEqual([
      'FORMULA_LIMIT_EXCEEDED',
      'MAX_DEPTH',
      MAX_AST_DEPTH,
    ]);
  });

  it.each([
    ['2,000-term sum', Array.from({ length: 2000 }, () => '1').join('+')],
    [
      '2,000 terms of mixed levels',
      Array.from({ length: 2000 }, (_, i) => (i % 2 === 0 ? '1' : '2'))
        .join('*')
        .replace(/\*2\*/g, '*2+'),
    ],
    ['2,000-term string concatenation', Array.from({ length: 2000 }, () => '1').join('&')],
  ])('accepts a %s within the length limit, through the whole pipeline', (_name, source) => {
    expect(source.length).toBeLessThanOrEqual(MAX_FORMULA_LENGTH);
    const ast = parse(source);
    const text = serialize(ast);
    expect(stripSpans(parse(text.replaceAll(' ', '')))).toEqual(stripSpans(ast));
    const snapshot = {
      tableId: 'tbl_t000000000000000',
      tables: [{ id: 'tbl_t000000000000000', name: 'T', fields: [] }],
    };
    const stored = serialize(resolveNames(ast, snapshot), 'stored');
    expect(renderNames(stored, snapshot)).toBe(text);
  });

  const args = (count: number) => Array.from({ length: count }, () => '1').join(',');

  it(`accepts ${String(MAX_FUNCTION_ARGUMENTS)} arguments`, () => {
    expect(() => parse(`SUM(${args(MAX_FUNCTION_ARGUMENTS)})`)).not.toThrow();
    expect(() => parse(`[A].SUM(${args(MAX_FUNCTION_ARGUMENTS - 1)})`)).not.toThrow();
  });

  it(`rejects ${String(MAX_FUNCTION_ARGUMENTS + 1)} arguments at the extra one`, () => {
    const source = `SUM(${args(MAX_FUNCTION_ARGUMENTS + 1)})`;
    expect(limit(source)).toEqual({
      code: 'FORMULA_LIMIT_EXCEEDED',
      detail: 'MAX_ARGUMENTS',
      limit: MAX_FUNCTION_ARGUMENTS,
      start: 4 + MAX_FUNCTION_ARGUMENTS * 2,
    });
  });

  it('counts a chained receiver as an argument', () => {
    expect(limit(`[A].SUM(${args(MAX_FUNCTION_ARGUMENTS)})`).detail).toBe('MAX_ARGUMENTS');
  });

  const letWith = (count: number) => {
    const names = Array.from({ length: count }, (_, i) => `v${String(i)}`);
    return `LET(${names.map((name) => `${name}, 1`).join(', ')}, 0)`;
  };

  it(`accepts ${String(MAX_LET_VARIABLES)} LET variables`, () => {
    expect(() => parse(letWith(MAX_LET_VARIABLES))).not.toThrow();
  });

  it(`rejects ${String(MAX_LET_VARIABLES + 1)} LET variables`, () => {
    expect(limit(letWith(MAX_LET_VARIABLES + 1))).toMatchObject({
      detail: 'MAX_LET_VARIABLES',
      limit: MAX_LET_VARIABLES,
    });
  });

  it('counts LET variables across nested LETs', () => {
    const inner = letWith(MAX_LET_VARIABLES - 1).replace(/^LET\(/, 'LET(w, 1, ');
    const source = `LET(outer, 1, ${inner})`;
    expect(limit(source).detail).toBe('MAX_LET_VARIABLES');
  });
});
