import { isId } from '@cellhive/contracts';

import { FormulaError, type SourceSpan } from './errors.js';
import { isPhase2Function, isSupportedFunction } from './function-names.js';
import { tokenize, type Token } from './lexer.js';
import {
  MAX_AST_DEPTH,
  MAX_FORMULA_LENGTH,
  MAX_FUNCTION_ARGUMENTS,
  MAX_LET_VARIABLES,
} from './limits.js';

import type { BinaryOperator, Call, Expr, Let, LetBinding, Reference } from './ast.js';

/**
 * Pratt parser (SPEC §9.2). Binding power, lowest first; binary operators
 * are left-associative, the unary sign and `.` bind tighter than any of them:
 *
 * | Power | Operators            |
 * |-------|----------------------|
 * | 1     | `\|\|`               |
 * | 2     | `&&`                 |
 * | 3     | `=` `!=` (`<>`)      |
 * | 4     | `<` `<=` `>` `>=`    |
 * | 5     | `&`                  |
 * | 6     | `+` `-`              |
 * | 7     | `*` `/` `%`          |
 * | 8     | unary `-` `+`        |
 * | 9     | `.[Field]`, `.FN(…)` |
 */
export const BINARY_PRECEDENCE: Readonly<Record<BinaryOperator, number>> = {
  '||': 1,
  '&&': 2,
  '=': 3,
  '!=': 3,
  '<': 4,
  '<=': 4,
  '>': 4,
  '>=': 4,
  '&': 5,
  '+': 6,
  '-': 6,
  '*': 7,
  '/': 7,
  '%': 7,
};
export const UNARY_PRECEDENCE = 8;
export const POSTFIX_PRECEDENCE = 9;

/**
 * `display`: what users type and see — `[Name]`, `#REF[fld_…]` for a broken reference.
 * `stored`: what is saved — `[fld_…]`/`[tbl_…]` only (SPEC §9.2).
 */
export type FormulaForm = 'display' | 'stored';

export interface ParseOptions {
  form?: FormulaForm;
  /**
   * IDs accepted as field references besides `fld_…` (stored form and
   * `#REF[…]`), e.g. the step and trigger references of automation
   * templates (BACKLOG T505). They resolve like any field: only when the
   * snapshot has a field with that ID.
   */
  referenceIds?: (id: string) => boolean;
}

const OPERATOR_ALIASES: Readonly<Record<string, BinaryOperator>> = { '<>': '!=' };
const KEYWORDS = new Set(['TRUE', 'FALSE', 'CURRENTVALUE']);

function isBinaryOperator(token: Token): BinaryOperator | null {
  if (token.type !== 'operator') return null;
  const operator = OPERATOR_ALIASES[token.value] ?? token.value;
  return operator in BINARY_PRECEDENCE ? (operator as BinaryOperator) : null;
}

function spanOf(first: SourceSpan, last: SourceSpan): SourceSpan {
  return { start: first.start, length: last.start + last.length - first.start };
}

function describe(token: Token): string {
  switch (token.type) {
    case 'string':
      return 'text';
    case 'name':
    case 'broken_ref':
      return 'reference';
    default:
      return `"${token.value}"`;
  }
}

class Parser {
  private index = 0;
  private variableCount = 0;
  /** Variables in scope, innermost `LET` last, keyed by upper-case name. */
  private readonly scopes: Set<string>[] = [];

  constructor(
    private readonly tokens: Token[],
    private readonly form: FormulaForm,
    private readonly referenceIds: ((id: string) => boolean) | null = null,
  ) {}

  parseFormula(): Expr {
    const expr = this.parseExpression(0, 1);
    const next = this.peek();
    if (next.type !== 'end') throw this.unexpected(next);
    return expr;
  }

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.index + offset, this.tokens.length - 1)] as Token;
  }

  private advance(): Token {
    const token = this.peek();
    if (token.type !== 'end') this.index += 1;
    return token;
  }

  private isOperator(token: Token, value: string): boolean {
    return token.type === 'operator' && token.value === value;
  }

  private unexpected(token: Token): FormulaError {
    if (token.type === 'end') {
      return new FormulaError('UNEXPECTED_END', 'The formula ends too early.', token);
    }
    return new FormulaError('UNEXPECTED_TOKEN', `Unexpected ${describe(token)}.`, token, {
      token: token.value,
    });
  }

  private expect(value: string): Token {
    const token = this.peek();
    if (!this.isOperator(token, value)) throw this.unexpected(token);
    return this.advance();
  }

  private parseExpression(minPower: number, depth: number): Expr {
    if (depth > MAX_AST_DEPTH) {
      throw new FormulaError(
        'MAX_DEPTH',
        `The formula is nested more than ${String(MAX_AST_DEPTH)} levels deep.`,
        this.peek(),
        { limit: MAX_AST_DEPTH },
      );
    }
    let left = this.parsePrefix(depth);
    for (;;) {
      const token = this.peek();
      if (this.isOperator(token, '.')) {
        left = this.parsePostfix(left, depth);
        continue;
      }
      const operator = isBinaryOperator(token);
      if (operator === null) break;
      const power = BINARY_PRECEDENCE[operator];
      if (power <= minPower) break;
      this.advance();
      const right = this.parseExpression(power, depth + 1);
      left = { type: 'binary', operator, left, right, ...spanOf(left, right) };
    }
    return left;
  }

  private parsePrefix(depth: number): Expr {
    const token = this.advance();
    switch (token.type) {
      case 'number':
        return { type: 'number', value: token.value, start: token.start, length: token.length };
      case 'string':
        return { type: 'string', value: token.value, start: token.start, length: token.length };
      case 'name':
      case 'broken_ref':
        return this.reference(token);
      case 'identifier':
        return this.parseIdentifier(token, depth);
      case 'operator':
        if (token.value === '(') {
          const inner = this.parseExpression(0, depth + 1);
          const close = this.expect(')');
          // The node covers its parentheses, so errors on it highlight them too.
          return { ...inner, ...spanOf(token, close) };
        }
        if (token.value === '-' || token.value === '+') {
          const operand = this.parseExpression(UNARY_PRECEDENCE - 1, depth + 1);
          return {
            type: 'unary',
            operator: token.value,
            operand,
            ...spanOf(token, operand),
          };
        }
        throw this.unexpected(token);
      case 'end':
        throw this.unexpected(token);
    }
  }

  private reference(token: Token): Reference {
    const span = { start: token.start, length: token.length };
    if (token.type === 'name' && this.form === 'display') {
      return { type: 'reference', name: token.value, id: null, kind: null, ...span };
    }
    const allowed = token.type === 'broken_ref' ? this.form === 'display' : this.form === 'stored';
    if (allowed) {
      if (isId('fld', token.value)) {
        return { type: 'reference', name: null, id: token.value, kind: 'field', ...span };
      }
      if (isId('tbl', token.value)) {
        return { type: 'reference', name: null, id: token.value, kind: 'table', ...span };
      }
      if (this.referenceIds?.(token.value) === true) {
        return { type: 'reference', name: null, id: token.value, kind: 'field', ...span };
      }
    }
    throw new FormulaError(
      'INVALID_REFERENCE',
      'The reference is not a valid field or table ID.',
      span,
    );
  }

  private parseIdentifier(token: Token, depth: number): Expr {
    const upper = token.value.toUpperCase();
    if (this.isOperator(this.peek(), '(')) {
      if (upper === 'LET') return this.parseLet(token, depth);
      this.checkFunction(token, upper);
      this.advance();
      return this.parseCall(token, upper, [], false, depth);
    }
    const span = { start: token.start, length: token.length };
    if (upper === 'TRUE' || upper === 'FALSE') {
      return { type: 'boolean', value: upper === 'TRUE', ...span };
    }
    if (upper === 'CURRENTVALUE') return { type: 'current_value', ...span };
    if (this.scopes.some((scope) => scope.has(upper))) {
      return { type: 'variable', name: token.value, ...span };
    }
    const hint = isSupportedFunction(upper) ? ` Did you mean ${upper}()?` : '';
    throw new FormulaError('UNKNOWN_NAME', `Unknown name "${token.value}".${hint}`, span, {
      name: token.value,
    });
  }

  private checkFunction(token: Token, upper: string): void {
    if (isSupportedFunction(upper)) return;
    const span = { start: token.start, length: token.length };
    if (isPhase2Function(upper)) {
      throw new FormulaError(
        'UNSUPPORTED_FUNCTION',
        `The function ${upper} is not supported yet.`,
        span,
        { name: upper },
      );
    }
    throw new FormulaError('UNKNOWN_FUNCTION', `Unknown function "${token.value}".`, span, {
      name: token.value,
    });
  }

  /** Parses the arguments after `(`; `args` already holds a chained receiver. */
  private parseCall(
    first: SourceSpan,
    name: string,
    args: Expr[],
    chained: boolean,
    depth: number,
  ): Call {
    if (!this.isOperator(this.peek(), ')')) {
      for (;;) {
        const next = this.peek();
        if (args.length === MAX_FUNCTION_ARGUMENTS) {
          throw new FormulaError(
            'MAX_ARGUMENTS',
            `A function takes at most ${String(MAX_FUNCTION_ARGUMENTS)} arguments.`,
            next,
            { limit: MAX_FUNCTION_ARGUMENTS },
          );
        }
        args.push(this.parseExpression(0, depth + 1));
        if (!this.isOperator(this.peek(), ',')) break;
        this.advance();
      }
    }
    const close = this.expect(')');
    return { type: 'call', name, args, chained, ...spanOf(first, close) };
  }

  private parsePostfix(object: Expr, depth: number): Expr {
    this.advance(); // `.`
    const token = this.advance();
    if (token.type === 'name' || token.type === 'broken_ref') {
      const property = this.reference(token);
      return { type: 'member', object, property, ...spanOf(object, property) };
    }
    if (token.type === 'identifier' && this.isOperator(this.peek(), '(')) {
      const upper = token.value.toUpperCase();
      if (upper === 'LET') {
        throw new FormulaError('INVALID_LET', 'LET cannot be chained.', token);
      }
      this.checkFunction(token, upper);
      this.advance();
      return this.parseCall(object, upper, [object], true, depth);
    }
    // `.NAME` must be a call: complain about what follows the name.
    throw this.unexpected(token.type === 'identifier' ? this.peek() : token);
  }

  private declare(token: Token, scope: Set<string>): void {
    const upper = token.value.toUpperCase();
    const span = { start: token.start, length: token.length };
    if (KEYWORDS.has(upper) || isSupportedFunction(upper) || isPhase2Function(upper)) {
      throw new FormulaError('RESERVED_NAME', `"${token.value}" cannot be a variable name.`, span, {
        name: token.value,
      });
    }
    if (scope.has(upper)) {
      throw new FormulaError(
        'DUPLICATE_VARIABLE',
        `The variable "${token.value}" is defined twice.`,
        span,
        { name: token.value },
      );
    }
    this.variableCount += 1;
    if (this.variableCount > MAX_LET_VARIABLES) {
      throw new FormulaError(
        'MAX_LET_VARIABLES',
        `A formula can define at most ${String(MAX_LET_VARIABLES)} variables.`,
        span,
        { limit: MAX_LET_VARIABLES },
      );
    }
  }

  /** `LET(name, value, …, expression)`; `token` is `LET`, the next token is `(`. */
  private parseLet(token: Token, depth: number): Let {
    this.advance(); // `(`
    const scope = new Set<string>();
    const bindings: LetBinding[] = [];
    this.scopes.push(scope);
    let body: Expr;
    for (;;) {
      const name = this.peek();
      if (name.type === 'identifier' && this.isOperator(this.peek(1), ',')) {
        this.declare(name, scope);
        this.advance();
        this.advance();
        const value = this.parseExpression(0, depth + 1);
        bindings.push({ name: name.value, value, start: name.start, length: name.length });
        scope.add(name.value.toUpperCase());
        if (!this.isOperator(this.peek(), ',')) {
          throw new FormulaError(
            'INVALID_LET',
            'LET needs an expression after the last variable: LET(name, value, expression).',
            this.peek(),
          );
        }
        this.advance();
        continue;
      }
      body = this.parseExpression(0, depth + 1);
      break;
    }
    this.scopes.pop();
    const close = this.peek();
    if (!this.isOperator(close, ')')) {
      if (this.isOperator(close, ',')) {
        throw new FormulaError('INVALID_LET', 'A LET variable name is expected here.', body);
      }
      throw this.unexpected(close);
    }
    this.advance();
    if (bindings.length === 0) {
      throw new FormulaError(
        'INVALID_LET',
        'LET needs at least one variable: LET(name, value, expression).',
        spanOf(token, close),
      );
    }
    return { type: 'let', bindings, body, ...spanOf(token, close) };
  }
}

function nodeDepthError(node: Expr): FormulaError {
  return new FormulaError(
    'MAX_DEPTH',
    `The formula is nested more than ${String(MAX_AST_DEPTH)} levels deep.`,
    node,
    { limit: MAX_AST_DEPTH },
  );
}

/**
 * Throws `MAX_DEPTH` at the first node below level `MAX_AST_DEPTH`. Depth is
 * counted on the flattened n-ary view: a left-associative chain of binary
 * operators of one precedence level (`[a] + [b] - [c] + …`) is one level, so
 * a flat sum of many terms is fine. The chain is walked iteratively and every
 * other recursion stops at `MAX_AST_DEPTH`, so no input can blow the stack.
 */
function checkDepth(node: Expr, level: number): void {
  if (level > MAX_AST_DEPTH) throw nodeDepthError(node);
  const next = level + 1;
  switch (node.type) {
    case 'member':
      checkDepth(node.object, next);
      checkDepth(node.property, next);
      return;
    case 'call':
      for (const arg of node.args) checkDepth(arg, next);
      return;
    case 'let':
      for (const binding of node.bindings) checkDepth(binding.value, next);
      checkDepth(node.body, next);
      return;
    case 'unary':
      checkDepth(node.operand, next);
      return;
    case 'binary': {
      const power = BINARY_PRECEDENCE[node.operator];
      let current: Expr = node;
      while (current.type === 'binary' && BINARY_PRECEDENCE[current.operator] === power) {
        checkDepth(current.right, next);
        current = current.left;
      }
      checkDepth(current, next);
      return;
    }
    default:
      return;
  }
}

/**
 * Parses a formula into an AST. Throws `FormulaError` (and nothing else) on
 * any invalid input. The length limit applies to the display form only: the
 * stored form replaces names with longer IDs.
 */
export function parse(source: string, options: ParseOptions = {}): Expr {
  const form = options.form ?? 'display';
  if (form === 'display' && source.length > MAX_FORMULA_LENGTH) {
    throw new FormulaError(
      'MAX_LENGTH',
      `A formula can be at most ${String(MAX_FORMULA_LENGTH)} characters long.`,
      { start: MAX_FORMULA_LENGTH, length: source.length - MAX_FORMULA_LENGTH },
      { limit: MAX_FORMULA_LENGTH },
    );
  }
  const ast = new Parser(tokenize(source), form, options.referenceIds ?? null).parseFormula();
  checkDepth(ast, 1);
  return ast;
}

export type ParseResult = { ok: true; ast: Expr } | { ok: false; error: FormulaError };

/** `parse` that returns the error instead of throwing it. */
export function tryParse(source: string, options: ParseOptions = {}): ParseResult {
  try {
    return { ok: true, ast: parse(source, options) };
  } catch (error) {
    if (error instanceof FormulaError) return { ok: false, error };
    throw error;
  }
}
