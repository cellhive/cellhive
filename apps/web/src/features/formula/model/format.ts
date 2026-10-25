import { BINARY_PRECEDENCE, bracketName, serialize, type Expr } from '@cellhive/formula-engine';

/**
 * "Reformat" of the formula editor (board "S4b · Trình soạn công thức -
 * dialog"): the canonical text of the engine (`serialize`, upper-case
 * functions, one space around operators) with line breaks where a formula
 * gets long — one chained step (`.FILTER(…)`, `.[Field]`, `.SUM()`) per
 * line, long argument lists one argument per line, long `&&` / `||`
 * conditions one term per line. Parsing the result gives the same tree.
 */

const WIDTH = 60;
const INDENT = '  ';

const pad = (level: number) => INDENT.repeat(level);

/** Steps of a chain `receiver.a.b(…)` (members and chained calls), receiver first. */
function chainOf(node: Expr): { receiver: Expr; steps: Expr[] } {
  const steps: Expr[] = [];
  let current = node;
  for (;;) {
    if (current.type === 'member') {
      steps.unshift(current);
      current = current.object;
    } else if (current.type === 'call' && current.chained && current.args[0] !== undefined) {
      steps.unshift(current);
      current = current.args[0];
    } else {
      return { receiver: current, steps };
    }
  }
}

function needsParens(node: Expr): boolean {
  return node.type === 'binary' || node.type === 'unary';
}

class Printer {
  expr(node: Expr, level: number): string {
    if (node.type === 'member' || (node.type === 'call' && node.chained))
      return this.chain(node, level);
    if (node.type === 'call') return `${node.name}(${this.args(node.args, level)})`;
    if (node.type === 'binary' && (node.operator === '&&' || node.operator === '||')) {
      return this.logical(node, level);
    }
    return serialize(node, 'display');
  }

  private chain(node: Expr, level: number): string {
    const { receiver, steps } = chainOf(node);
    const head = needsParens(receiver)
      ? `(${serialize(receiver, 'display')})`
      : this.expr(receiver, level);
    const texts = steps.map((step) =>
      step.type === 'member'
        ? `.${step.property.name === null ? `#REF${bracketName(step.property.id ?? '')}` : bracketName(step.property.name)}`
        : step.type === 'call'
          ? `.${step.name}(${this.args(step.args.slice(1), level + 1)})`
          : '',
    );
    const flat = head + texts.join('');
    if (steps.length < 3 && !flat.includes('\n') && flat.length <= WIDTH) return flat;
    return head + texts.map((text) => `\n${pad(level + 1)}${text}`).join('');
  }

  private args(args: readonly Expr[], level: number): string {
    const texts = args.map((arg) => this.expr(arg, level + 1));
    const flat = texts.join(', ');
    if (!flat.includes('\n') && flat.length <= WIDTH) return flat;
    return `\n${texts.map((text) => pad(level + 1) + text).join(',\n')}\n${pad(level)}`;
  }

  private logical(node: Expr & { type: 'binary' }, level: number): string {
    const terms: Expr[] = [];
    const collect = (item: Expr) => {
      if (item.type === 'binary' && item.operator === node.operator) {
        collect(item.left);
        collect(item.right);
      } else {
        terms.push(item);
      }
    };
    collect(node);
    const texts = terms.map((term) => {
      const text = this.expr(term, level);
      const lower =
        term.type === 'binary' &&
        BINARY_PRECEDENCE[term.operator] < BINARY_PRECEDENCE[node.operator];
      return lower ? `(${text})` : text;
    });
    const flat = texts.join(` ${node.operator} `);
    if (!flat.includes('\n') && flat.length <= WIDTH) return flat;
    return texts.join(`\n${pad(level)}${node.operator} `);
  }
}

export function formatFormula(ast: Expr): string {
  return new Printer().expr(ast, 0);
}
