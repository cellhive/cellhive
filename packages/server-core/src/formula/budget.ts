import { FormulaCompileError } from './errors.js';

import type { Sql } from './values.js';

/**
 * Most SQL text one compiled formula may expand to (bytes, approximate:
 * fragments, identifiers and `$n` placeholders). A formula of 4 000
 * characters that does not reuse values stays far below; reuse (`LET`
 * variables, IFBLANK, SWITCH, `=`… repeat their operand's SQL) can grow it
 * exponentially, which this bound stops (SPEC §9.5).
 */
export const FORMULA_SQL_MAX_BYTES = 512 * 1024;

/** Most bound parameters of one compiled formula (PostgreSQL allows 65 535 per statement). */
export const FORMULA_SQL_MAX_PARAMETERS = 4096;

interface Size {
  readonly bytes: number;
  readonly parameters: number;
}

/**
 * Expanded size of Kysely operation nodes. Nodes are immutable and shared
 * between the expressions that embed them (the compiler builds a DAG: a
 * `LET` variable used three times is one node referenced three times), so
 * the size of each node is computed once — the walk is linear in the nodes
 * built, never in the SQL text they expand to.
 */
const sizes = new WeakMap<object, Size>();

const PLACEHOLDER_BYTES = 6;
const NODE_BYTES = 8;

function tooLarge(what: 'bytes' | 'parameters'): never {
  const limit = what === 'bytes' ? FORMULA_SQL_MAX_BYTES : FORMULA_SQL_MAX_PARAMETERS;
  throw new FormulaCompileError(
    'TOO_LARGE',
    `The formula compiles to more than ${String(limit)} SQL ${what}: it repeats values too often.`,
    { limit, unit: what },
  );
}

function measure(node: unknown): Size {
  if (typeof node !== 'object' || node === null) return { bytes: 0, parameters: 0 };
  const known = sizes.get(node);
  if (known !== undefined) return known;
  let bytes = 0;
  let parameters = 0;
  const add = (child: Size): void => {
    bytes += child.bytes;
    parameters += child.parameters;
    if (bytes > FORMULA_SQL_MAX_BYTES) tooLarge('bytes');
    if (parameters > FORMULA_SQL_MAX_PARAMETERS) tooLarge('parameters');
  };
  if (Array.isArray(node)) {
    for (const item of node) add(measure(item));
  } else {
    const record = node as Readonly<Record<string, unknown>>;
    switch (record['kind']) {
      case 'ValueNode':
        add({ bytes: PLACEHOLDER_BYTES, parameters: record['immediate'] === true ? 0 : 1 });
        break;
      case 'IdentifierNode':
        add({ bytes: String(record['name']).length + 2, parameters: 0 });
        break;
      case 'RawNode': {
        const fragments = record['sqlFragments'] as readonly string[];
        add({ bytes: fragments.reduce((sum, part) => sum + part.length, 0), parameters: 0 });
        add(measure(record['parameters']));
        break;
      }
      default:
        add({ bytes: NODE_BYTES, parameters: 0 });
        for (const value of Object.values(record)) {
          if (typeof value === 'object' && value !== null) add(measure(value));
        }
    }
  }
  const size = { bytes, parameters };
  sizes.set(node, size);
  return size;
}

/**
 * Throws `FormulaCompileError('TOO_LARGE')` when `value` expands to more
 * than `FORMULA_SQL_MAX_BYTES` of SQL or `FORMULA_SQL_MAX_PARAMETERS`
 * parameters. The compiler checks every node it compiles, so a formula
 * stops at the first node past the budget, before the SQL text is built.
 */
export function checkSqlBudget(value: Sql): void {
  measure(value.toOperationNode());
}
