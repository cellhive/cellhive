import type { SourceSpan } from './errors.js';

/**
 * Formula AST (SPEC §9.2, §9.4). Every node carries the span of the source it
 * was parsed from (`start`/`length`, UTF-16 code units). Parentheses leave no
 * node: the serializer adds them back where precedence needs them.
 */

export type BinaryOperator =
  '||' | '&&' | '=' | '!=' | '<' | '<=' | '>' | '>=' | '&' | '+' | '-' | '*' | '/' | '%';

export type UnaryOperator = '-' | '+';

export interface NumberLiteral extends SourceSpan {
  type: 'number';
  /** Decimal text as written (`0.10` stays `0.10`), `.` as decimal separator in every locale. */
  value: string;
}

export interface StringLiteral extends SourceSpan {
  type: 'string';
  value: string;
}

export interface BooleanLiteral extends SourceSpan {
  type: 'boolean';
  value: boolean;
}

/**
 * `[Name]`, a stored `[fld_…]`/`[tbl_…]` or a display `#REF[fld_…]`.
 * - parsed from display text: `name` set, `id`/`kind` null (`#REF[…]`: `name` null, `id`/`kind` set);
 * - parsed from stored text: `id`/`kind` set, `name` null;
 * - after `resolveNames`: `id`/`kind` set, `name` the current name.
 */
export interface Reference extends SourceSpan {
  type: 'reference';
  name: string | null;
  id: string | null;
  kind: 'field' | 'table' | null;
}

/** `object.[Field]`: a field of a table, of linked records or of the `CurrentValue` row. */
export interface Member extends SourceSpan {
  type: 'member';
  object: Expr;
  property: Reference;
}

export interface CurrentValue extends SourceSpan {
  type: 'current_value';
}

/** A `LET` variable; `name` as written at this use. */
export interface Variable extends SourceSpan {
  type: 'variable';
  name: string;
}

/**
 * `NAME(a, b)` or the chained `a.NAME(b)` (`chained: true`, receiver is
 * `args[0]`): both mean the same, `chained` only keeps the written style.
 */
export interface Call extends SourceSpan {
  type: 'call';
  /** Upper case. */
  name: string;
  args: readonly Expr[];
  chained: boolean;
  /**
   * Internal, never produced by the parser nor serialized: a `CONTAIN*`
   * built by `lookupToAst` for a lookup `where` compares exactly (Filter DSL
   * semantics: select options by exact name), without the case folding of
   * user-typed `CONTAIN*` (SPEC §9.4, BACKLOG T473).
   */
  exact?: true;
}

/** One `name, value` pair of a `LET`; the span is the name's. */
export interface LetBinding extends SourceSpan {
  name: string;
  value: Expr;
}

/** `LET(name1, value1, …, expression)`; each value may use the variables before it. */
export interface Let extends SourceSpan {
  type: 'let';
  bindings: readonly LetBinding[];
  body: Expr;
}

export interface Unary extends SourceSpan {
  type: 'unary';
  operator: UnaryOperator;
  operand: Expr;
}

export interface Binary extends SourceSpan {
  type: 'binary';
  operator: BinaryOperator;
  left: Expr;
  right: Expr;
}

export type Expr =
  | NumberLiteral
  | StringLiteral
  | BooleanLiteral
  | Reference
  | Member
  | CurrentValue
  | Variable
  | Call
  | Let
  | Unary
  | Binary;

/**
 * The binary nodes down the left side of `node` (its left operand, that
 * one's left operand, …), outermost first, stopping at a node that is not
 * binary or for which `done` holds. Operators of one precedence level
 * associate to the left, so `1 + 1 + … + 1` is as deep as it is long: tree
 * walkers handle this spine bottom-up in a loop instead of recursing (T470).
 */
export function leftSpine(node: Expr, done: (link: Expr) => boolean = () => false): Binary[] {
  const chain: Binary[] = [];
  let at = node;
  while (at.type === 'binary' && at.left.type === 'binary' && !done(at.left)) {
    chain.push(at.left);
    at = at.left;
  }
  return chain;
}

/** Copy of the AST without `start`/`length`, to compare trees parsed from different text. */
export function stripSpans(node: Expr): unknown {
  switch (node.type) {
    case 'number':
    case 'string':
    case 'boolean':
      return { type: node.type, value: node.value };
    case 'reference':
      return { type: node.type, name: node.name, id: node.id, kind: node.kind };
    case 'member':
      return {
        type: node.type,
        object: stripSpans(node.object),
        property: stripSpans(node.property),
      };
    case 'current_value':
      return { type: node.type };
    case 'variable':
      return { type: node.type, name: node.name };
    case 'call':
      return {
        type: node.type,
        name: node.name,
        args: node.args.map(stripSpans),
        chained: node.chained,
      };
    case 'let':
      return {
        type: node.type,
        bindings: node.bindings.map((binding) => ({
          name: binding.name,
          value: stripSpans(binding.value),
        })),
        body: stripSpans(node.body),
      };
    case 'unary':
      return { type: node.type, operator: node.operator, operand: stripSpans(node.operand) };
    case 'binary':
      return {
        type: node.type,
        operator: node.operator,
        left: stripSpans(node.left),
        right: stripSpans(node.right),
      };
  }
}
