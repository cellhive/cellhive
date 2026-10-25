import { describe, expect, it } from 'vitest';

import { FormulaError, tokenize, type TokenType } from '../src/index.js';

const lex = (source: string) =>
  tokenize(source)
    .filter((token) => token.type !== 'end')
    .map((token) => [token.type, token.value] as [TokenType, string]);

describe('tokenize: tokens', () => {
  const cases: { name: string; source: string; expected: [TokenType, string][] }[] = [
    { name: 'integer', source: '42', expected: [['number', '42']] },
    { name: 'decimal with dot', source: '3.14', expected: [['number', '3.14']] },
    { name: 'decimal keeps trailing zeros', source: '0.10', expected: [['number', '0.10']] },
    {
      name: 'comma is an argument separator, never a decimal one',
      source: '3,14',
      expected: [
        ['number', '3'],
        ['operator', ','],
        ['number', '14'],
      ],
    },
    {
      name: 'number followed by a chained call',
      source: '1.SUM()',
      expected: [
        ['number', '1'],
        ['operator', '.'],
        ['identifier', 'SUM'],
        ['operator', '('],
        ['operator', ')'],
      ],
    },
    { name: 'empty string', source: '""', expected: [['string', '']] },
    { name: 'string with Vietnamese text', source: '"Đã giao"', expected: [['string', 'Đã giao']] },
    { name: 'string escaped quote', source: '"say \\"hi\\""', expected: [['string', 'say "hi"']] },
    { name: 'string escaped backslash', source: '"a\\\\b"', expected: [['string', 'a\\b']] },
    {
      name: 'string newline and tab escapes',
      source: '"a\\nb\\tc\\rd"',
      expected: [['string', 'a\nb\tc\rd']],
    },
    {
      name: 'string unknown escape keeps the backslash',
      source: '"\\d+"',
      expected: [['string', '\\d+']],
    },
    { name: 'string with a raw newline', source: '"a\nb"', expected: [['string', 'a\nb']] },
    {
      name: 'string with brackets and operators',
      source: '"[x] + 1"',
      expected: [['string', '[x] + 1']],
    },
    { name: 'field name', source: '[Số tiền]', expected: [['name', 'Số tiền']] },
    { name: 'name with escaped bracket', source: '[a\\]b]', expected: [['name', 'a]b']] },
    { name: 'name with escaped backslash', source: '[a\\\\b]', expected: [['name', 'a\\b']] },
    { name: 'name with a lone backslash', source: '[a\\b]', expected: [['name', 'a\\b']] },
    { name: 'name with quotes and dots', source: '["x".y]', expected: [['name', '"x".y']] },
    { name: 'name keeps inner spaces', source: '[ a b ]', expected: [['name', ' a b ']] },
    { name: 'broken reference', source: '#REF[fld_abc]', expected: [['broken_ref', 'fld_abc']] },
    { name: 'identifier', source: 'CurrentValue', expected: [['identifier', 'CurrentValue']] },
    {
      name: 'identifier with Unicode letters',
      source: 'tổng_1',
      expected: [['identifier', 'tổng_1']],
    },
    {
      name: 'identifier with underscore',
      source: 'RECORD_ID',
      expected: [['identifier', 'RECORD_ID']],
    },
    {
      name: 'every operator',
      source: '+ - * / % & = != <> < <= > >= && || ( ) , .',
      expected: [
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
        '(',
        ')',
        ',',
        '.',
      ].map((value) => ['operator', value] as [TokenType, string]),
    },
    {
      name: 'operators without spaces',
      source: '1<=2>=3',
      expected: [
        ['number', '1'],
        ['operator', '<='],
        ['number', '2'],
        ['operator', '>='],
        ['number', '3'],
      ],
    },
    {
      name: 'unicode and line whitespace is skipped',
      source: '\t1\n+ 2 ',
      expected: [
        ['number', '1'],
        ['operator', '+'],
        ['number', '2'],
      ],
    },
    { name: 'only whitespace', source: '   ', expected: [] },
  ];

  it.each(cases)('$name', ({ source, expected }) => {
    expect(lex(source)).toEqual(expected);
  });

  it('gives UTF-16 spans and a final end token', () => {
    const tokens = tokenize('[Số] & "😀" + 1');
    expect(tokens.map(({ type, start, length }) => [type, start, length])).toEqual([
      ['name', 0, 4],
      ['operator', 5, 1],
      ['string', 7, 4],
      ['operator', 12, 1],
      ['number', 14, 1],
      ['end', 15, 0],
    ]);
  });
});

describe('tokenize: errors', () => {
  const cases: { name: string; source: string; detail: string; start: number; length: number }[] = [
    {
      name: 'unterminated string',
      source: '1 & "abc',
      detail: 'UNTERMINATED_STRING',
      start: 4,
      length: 4,
    },
    {
      name: 'string ending in a backslash',
      source: '"abc\\',
      detail: 'UNTERMINATED_STRING',
      start: 0,
      length: 5,
    },
    {
      name: 'escaped quote does not close',
      source: '"a\\"',
      detail: 'UNTERMINATED_STRING',
      start: 0,
      length: 4,
    },
    {
      name: 'unterminated name',
      source: 'SUM([Số tiền',
      detail: 'UNTERMINATED_NAME',
      start: 4,
      length: 8,
    },
    {
      name: 'escaped bracket does not close',
      source: '[a\\]',
      detail: 'UNTERMINATED_NAME',
      start: 0,
      length: 4,
    },
    {
      name: 'unterminated broken reference',
      source: '#REF[fld_x',
      detail: 'UNTERMINATED_NAME',
      start: 0,
      length: 10,
    },
    { name: 'empty name', source: '1 + []', detail: 'EMPTY_NAME', start: 4, length: 2 },
    { name: 'blank name', source: '[  ]', detail: 'EMPTY_NAME', start: 0, length: 4 },
    { name: 'at sign', source: '1 @ 2', detail: 'UNEXPECTED_CHARACTER', start: 2, length: 1 },
    { name: 'dollar', source: '$A', detail: 'UNEXPECTED_CHARACTER', start: 0, length: 1 },
    { name: 'semicolon', source: 'IF(1; 2)', detail: 'UNEXPECTED_CHARACTER', start: 4, length: 1 },
    {
      name: 'single quote strings are not supported',
      source: "'a'",
      detail: 'UNEXPECTED_CHARACTER',
      start: 0,
      length: 1,
    },
    { name: 'lone hash', source: '#N/A', detail: 'UNEXPECTED_CHARACTER', start: 0, length: 1 },
    { name: 'lone bang', source: '!TRUE', detail: 'UNEXPECTED_CHARACTER', start: 0, length: 1 },
    { name: 'lone pipe', source: '1 | 2', detail: 'UNEXPECTED_CHARACTER', start: 2, length: 1 },
    {
      name: 'astral character is one character of length 2',
      source: '1 + 😀',
      detail: 'UNEXPECTED_CHARACTER',
      start: 4,
      length: 2,
    },
    {
      name: 'closing bracket alone',
      source: 'a]',
      detail: 'UNEXPECTED_CHARACTER',
      start: 1,
      length: 1,
    },
  ];

  it.each(cases)('$name → $detail at $start', ({ source, detail, start, length }) => {
    let caught: unknown;
    try {
      tokenize(source);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FormulaError);
    const error = caught as FormulaError;
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
});
