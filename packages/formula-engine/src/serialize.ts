import {
  BINARY_PRECEDENCE,
  POSTFIX_PRECEDENCE,
  UNARY_PRECEDENCE,
  type FormulaForm,
} from './parser.js';

import type { Expr, Reference } from './ast.js';

/**
 * Canonical text of an AST: upper-case function names, `!=` for `<>`,
 * one space around binary operators and after commas, parentheses only where
 * precedence needs them. `parse(serialize(ast, form), { form })` gives the
 * same tree (spans aside).
 *
 * - `display`: `[Name]`; a reference without a name is `#REF[id]`.
 * - `stored`: `[fld_…]`/`[tbl_…]`; every reference must have an ID (after `resolveNames`).
 */
export function serialize(node: Expr, form: FormulaForm = 'display'): string {
  return new Serializer(form).expr(node);
}

const STRING_ESCAPES: Readonly<Record<string, string>> = {
  '"': '\\"',
  '\\': '\\\\',
  '\n': '\\n',
  '\t': '\\t',
  '\r': '\\r',
};

export function quoteString(value: string): string {
  return `"${value.replace(/["\\\n\t\r]/g, (char) => STRING_ESCAPES[char] ?? char)}"`;
}

export function bracketName(name: string): string {
  return `[${name.replace(/[\\\]]/g, (char) => `\\${char}`)}]`;
}

function precedence(node: Expr): number {
  switch (node.type) {
    case 'binary':
      return BINARY_PRECEDENCE[node.operator];
    case 'unary':
      return UNARY_PRECEDENCE;
    default:
      return POSTFIX_PRECEDENCE + 1;
  }
}

class Serializer {
  constructor(private readonly form: FormulaForm) {}

  private wrap(node: Expr, parenthesize: boolean): string {
    const text = this.expr(node);
    return parenthesize ? `(${text})` : text;
  }

  private reference(node: Reference): string {
    if (this.form === 'stored') {
      if (node.id === null) {
        throw new TypeError(
          `Reference "${node.name ?? ''}" is not resolved; call resolveNames first.`,
        );
      }
      // Escaped like a name: ids never hold `]` or `\`, but automation
      // references to webhook data may (`[@body.items[0\]]`, BACKLOG T604).
      return bracketName(node.id);
    }
    if (node.name !== null) return bracketName(node.name);
    return `#REF[${node.id ?? ''}]`;
  }

  private args(nodes: readonly Expr[]): string {
    return nodes.map((node) => this.expr(node)).join(', ');
  }

  expr(node: Expr): string {
    switch (node.type) {
      case 'number':
        return node.value;
      case 'string':
        return quoteString(node.value);
      case 'boolean':
        return node.value ? 'TRUE' : 'FALSE';
      case 'reference':
        return this.reference(node);
      case 'current_value':
        return 'CurrentValue';
      case 'variable':
        return node.name;
      case 'member':
        return `${this.wrap(node.object, precedence(node.object) <= POSTFIX_PRECEDENCE)}.${this.reference(node.property)}`;
      case 'call': {
        const [receiver, ...rest] = node.args;
        if (node.chained && receiver !== undefined) {
          const object = this.wrap(receiver, precedence(receiver) <= POSTFIX_PRECEDENCE);
          return `${object}.${node.name}(${this.args(rest)})`;
        }
        return `${node.name}(${this.args(node.args)})`;
      }
      case 'let': {
        const parts = node.bindings.map(
          (binding) => `${binding.name}, ${this.expr(binding.value)}`,
        );
        parts.push(this.expr(node.body));
        return `LET(${parts.join(', ')})`;
      }
      case 'unary':
        return `${node.operator}${this.wrap(node.operand, precedence(node.operand) < UNARY_PRECEDENCE)}`;
      case 'binary': {
        const power = BINARY_PRECEDENCE[node.operator];
        const left = this.wrap(node.left, precedence(node.left) < power);
        const right = this.wrap(node.right, precedence(node.right) <= power);
        return `${left} ${node.operator} ${right}`;
      }
    }
  }
}
