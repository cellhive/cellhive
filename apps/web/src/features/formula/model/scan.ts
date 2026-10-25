import { isFormulaError, tokenize, type Token } from '@cellhive/formula-engine';

/**
 * Tolerant tokens of a formula being typed (T466). The editor highlights
 * with the formula engine's own lexer (BACKLOG T466: no grammar of its
 * own); where the lexer stops on an error, the rest is scanned again after
 * the bad part so that everything before and after keeps its colours:
 *
 * - `open_name`: a `[Name` not closed yet (what the user is typing, the
 *   autocomplete's query), up to the end;
 * - `string`: also a `"text` not closed yet, up to the end;
 * - `invalid`: a character that starts no token (`@`, `;`).
 */
export type ScanTokenType = Exclude<Token['type'], 'end'> | 'open_name' | 'invalid';

export interface ScanToken {
  readonly type: ScanTokenType;
  /** Decoded value (name, string content, identifier, operator…); raw text for `invalid`. */
  readonly value: string;
  readonly start: number;
  readonly length: number;
}

function shifted(tokens: readonly Token[], offset: number): ScanToken[] {
  const out: ScanToken[] = [];
  for (const token of tokens) {
    if (token.type === 'end') continue;
    out.push({
      type: token.type,
      value: token.value,
      start: token.start + offset,
      length: token.length,
    });
  }
  return out;
}

/** Tokens of `source` (without the lexer's `end`); never throws. */
export function scanFormula(source: string): ScanToken[] {
  const out: ScanToken[] = [];
  let offset = 0;
  while (offset <= source.length) {
    const rest = source.slice(offset);
    try {
      out.push(...shifted(tokenize(rest), offset));
      return out;
    } catch (error) {
      if (!isFormulaError(error)) throw error;
      // Everything before the error scans cleanly: the lexer reads left to right.
      out.push(...shifted(tokenize(rest.slice(0, error.start)), offset));
      const start = offset + error.start;
      switch (error.detail) {
        case 'UNTERMINATED_NAME':
          out.push({
            type: 'open_name',
            value: source.slice(start + 1).replace(/\\([\\\]])/gu, '$1'),
            start,
            length: source.length - start,
          });
          return out;
        case 'UNTERMINATED_STRING':
          out.push({
            type: 'string',
            value: source.slice(start + 1),
            start,
            length: source.length - start,
          });
          return out;
        default: {
          const length = Math.max(1, error.length);
          out.push({ type: 'invalid', value: source.slice(start, start + length), start, length });
          offset = start + length;
        }
      }
    }
  }
  return out;
}

/** 1-based line and column (UTF-16) of an offset, as the error list shows it ("1:32"). */
export function lineColumn(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  const end = Math.min(offset, source.length);
  for (let index = 0; index < end; index += 1) {
    if (source.charCodeAt(index) === 10) {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: end - lineStart + 1 };
}
