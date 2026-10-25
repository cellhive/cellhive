import { FormulaError } from './errors.js';

/**
 * Formula lexer (SPEC §9.2). Tokens:
 * - `number`: `123`, `0.5` — `.` is the decimal separator whatever the locale; no sign, no exponent;
 * - `string`: `"…"` with escapes `\"`, `\\`, `\n`, `\t`, `\r`; any other `\x` keeps the backslash;
 * - `name`: `[Name]` with escapes `\]` and `\\`; `value` is the decoded name;
 * - `broken_ref`: `#REF[fld_…]`, how `renderNames` shows an ID that no longer exists; `value` is the ID;
 * - `identifier`: function names, `TRUE`/`FALSE`, `CurrentValue`, `LET` variables (Unicode letters, digits, `_`);
 * - `operator`: `+ - * / % & = != <> < <= > >= && || ( ) , .`;
 * - `end`: after the last token.
 */

export type TokenType =
  'number' | 'string' | 'name' | 'broken_ref' | 'identifier' | 'operator' | 'end';

export interface Token {
  type: TokenType;
  /** Decoded value: the number text, string content, name, ID, identifier or operator. */
  value: string;
  start: number;
  length: number;
}

const NUMBER = /[0-9]+(?:\.[0-9]+)?/y;
const IDENTIFIER = /[\p{L}_][\p{L}\p{N}\p{M}_]*/uy;
const WHITESPACE = /\s+/uy;
const BROKEN_REF_PREFIX = '#REF[';

/** Two-character operators first, so `<=` is not read as `<` `=`. */
const OPERATORS = [
  '!=',
  '<>',
  '<=',
  '>=',
  '&&',
  '||',
  '+',
  '-',
  '*',
  '/',
  '%',
  '&',
  '=',
  '<',
  '>',
  '(',
  ')',
  ',',
  '.',
];

function matchAt(pattern: RegExp, source: string, index: number): string | null {
  pattern.lastIndex = index;
  const match = pattern.exec(source);
  return match === null ? null : match[0];
}

const STRING_ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  '\\': '\\',
  n: '\n',
  t: '\t',
  r: '\r',
};

/** Reads `"…"` starting at the opening quote. */
function readString(source: string, start: number): Token {
  let value = '';
  let index = start + 1;
  while (index < source.length) {
    const char = source[index] as string;
    if (char === '"') {
      return { type: 'string', value, start, length: index + 1 - start };
    }
    if (char === '\\' && index + 1 < source.length) {
      const next = source[index + 1] as string;
      value += STRING_ESCAPES[next] ?? `\\${next}`;
      index += 2;
      continue;
    }
    value += char;
    index += 1;
  }
  throw new FormulaError('UNTERMINATED_STRING', 'The text is missing its closing quote (").', {
    start,
    length: source.length - start,
  });
}

/** Reads `[…]` whose `[` is at `open`; the token starts at `start` (`#REF[` starts earlier). */
function readBracket(source: string, start: number, open: number): { value: string; end: number } {
  let value = '';
  let index = open + 1;
  while (index < source.length) {
    const char = source[index] as string;
    if (char === ']') return { value, end: index + 1 };
    if (char === '\\' && (source[index + 1] === ']' || source[index + 1] === '\\')) {
      value += source[index + 1] as string;
      index += 2;
      continue;
    }
    value += char;
    index += 1;
  }
  throw new FormulaError('UNTERMINATED_NAME', 'The reference is missing its closing bracket (]).', {
    start,
    length: source.length - start,
  });
}

function readToken(source: string, index: number): Token {
  const char = source[index] as string;
  if (char === '"') return readString(source, index);
  if (char === '[') {
    const { value, end } = readBracket(source, index, index);
    if (value.trim() === '') {
      throw new FormulaError('EMPTY_NAME', 'A reference needs a field or table name.', {
        start: index,
        length: end - index,
      });
    }
    return { type: 'name', value, start: index, length: end - index };
  }
  if (source.startsWith(BROKEN_REF_PREFIX, index)) {
    const { value, end } = readBracket(source, index, index + BROKEN_REF_PREFIX.length - 1);
    return { type: 'broken_ref', value, start: index, length: end - index };
  }
  const number = matchAt(NUMBER, source, index);
  if (number !== null)
    return { type: 'number', value: number, start: index, length: number.length };
  const identifier = matchAt(IDENTIFIER, source, index);
  if (identifier !== null) {
    return { type: 'identifier', value: identifier, start: index, length: identifier.length };
  }
  for (const operator of OPERATORS) {
    if (source.startsWith(operator, index)) {
      return { type: 'operator', value: operator, start: index, length: operator.length };
    }
  }
  const codePoint = source.codePointAt(index) as number;
  const length = codePoint > 0xffff ? 2 : 1;
  throw new FormulaError(
    'UNEXPECTED_CHARACTER',
    `Unexpected character "${String.fromCodePoint(codePoint)}".`,
    { start: index, length },
    { character: String.fromCodePoint(codePoint) },
  );
}

/** Splits a formula into tokens; the last one is always `end`. Throws `FormulaError`. */
export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const space = matchAt(WHITESPACE, source, index);
    if (space !== null) {
      index += space.length;
      continue;
    }
    const token = readToken(source, index);
    tokens.push(token);
    index = token.start + token.length;
  }
  tokens.push({ type: 'end', value: '', start: source.length, length: 0 });
  return tokens;
}
