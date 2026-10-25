import { parse, renderNames, type Expr, type SchemaSnapshot } from '@cellhive/formula-engine';

/** Every node of an AST (references and member properties included). */
function walk(node: Expr, visit: (node: Expr) => void): void {
  visit(node);
  switch (node.type) {
    case 'member':
      walk(node.object, visit);
      visit(node.property);
      return;
    case 'call':
      for (const arg of node.args) walk(arg, visit);
      return;
    case 'let':
      for (const binding of node.bindings) walk(binding.value, visit);
      walk(node.body, visit);
      return;
    case 'unary':
      walk(node.operand, visit);
      return;
    case 'binary':
      walk(node.left, visit);
      walk(node.right, visit);
      return;
    default:
      return;
  }
}

/**
 * Field and table ids a stored formula names (`[fld_…]`, `[tbl_…]`), or
 * `null` when the text is not valid stored text.
 */
export function formulaReferenceIds(
  expression: string,
): { readonly fields: ReadonlySet<string>; readonly tables: ReadonlySet<string> } | null {
  const fields = new Set<string>();
  const tables = new Set<string>();
  try {
    walk(parse(expression, { form: 'stored' }), (node) => {
      if (node.type !== 'reference' || node.id === null) return;
      if (node.kind === 'table') tables.add(node.id);
      else fields.add(node.id);
    });
  } catch {
    return null;
  }
  return { fields, tables };
}

/**
 * The display form of a stored formula for a reader whose snapshot is
 * `snapshot` (current names; an ID it lacks renders `#REF[id]`, SPEC §9.2);
 * `null` when the stored text is broken.
 */
export function displayExpression(expression: string, snapshot: SchemaSnapshot): string | null {
  try {
    return renderNames(expression, snapshot);
  } catch {
    return null;
  }
}
