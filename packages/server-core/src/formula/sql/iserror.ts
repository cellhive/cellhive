import { type Expr, type Reference } from '@cellhive/formula-engine';
import { sql } from 'kysely';

import type { SqlFunction } from '../call.js';

/** ISERROR (SPEC §9.3): NULL although every field it reads is set (SPEC §9.4). */
export const ISERROR: SqlFunction = (call) => {
  const value = call.arg(0);
  const inputs = fieldReferences(call.node.args[0]).map(
    (reference) => sql`${call.compiler.compile(reference).sql} IS NOT NULL`,
  );
  return inputs.length === 0
    ? sql`(${value.sql} IS NULL)`
    : sql`(${value.sql} IS NULL AND ${sql.join(inputs, sql` AND `)})`;
};

/** `[Field]` references read by an expression (the inputs of ISERROR). */
function fieldReferences(node: Expr | undefined): Reference[] {
  if (node === undefined) return [];
  switch (node.type) {
    case 'reference':
      return node.kind === 'field' ? [node] : [];
    case 'member':
      return fieldReferences(node.object);
    case 'call':
      return node.args.flatMap(fieldReferences);
    case 'let':
      return [
        ...node.bindings.flatMap((binding) => fieldReferences(binding.value)),
        ...fieldReferences(node.body),
      ];
    case 'unary':
      return fieldReferences(node.operand);
    case 'binary':
      return [...fieldReferences(node.left), ...fieldReferences(node.right)];
    default:
      return [];
  }
}
