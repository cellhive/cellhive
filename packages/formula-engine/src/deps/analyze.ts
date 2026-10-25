import { FormulaError } from '../errors.js';
import { parse, type FormulaForm } from '../parser.js';
import { resolveNames, type SchemaSnapshot, type SnapshotField } from '../resolve.js';
import { typecheck, type Style } from '../typecheck/typecheck.js';

import type { FormulaDependency } from './collector.js';
import type { Expr } from '../ast.js';
import type { ComputeMode } from '../types/field-type.js';
import type { FormulaType } from '../types/formula-type.js';

/** Why a computed field is `virtual` (SPEC §5.9), for the editor to explain it. */
export type VirtualReason =
  | { kind: 'volatile_function'; function: string }
  | { kind: 'virtual_dependency'; field_id: string };

/**
 * Why reading the field may be slow (BACKLOG S4b open question #11), for the
 * editor to warn: `cross_table_scan` — a `virtual` formula (volatile
 * function) that queries another table without going through a link (no
 * link field of that table in its conditions), so every row it is read on
 * scans that table. Non-volatile formulas of that kind are `stored`.
 */
export type PerfWarning = 'cross_table_scan';

export interface FormulaAnalysis {
  /** Resolved AST (IDs and current names); `null` when the text does not parse or resolve. */
  ast: Expr | null;
  /** Type of the result; `null` when there are errors. */
  result_type: FormulaType | null;
  /** Default `style` of the result, taken from the fields it carries (number/date results). */
  style: Style | null;
  /** `virtual` with a volatile function or a dependency on a virtual field, else `stored`. */
  compute_mode: ComputeMode;
  virtual_reason: VirtualReason | null;
  /** Performance hint for the editor (`null`: none). */
  perf_warning: PerfWarning | null;
  dependencies: FormulaDependency[];
  /** Tables whose records the formula reads (through `[Table]` or links), in first-seen order. */
  referenced_tables: string[];
  /** Type of every AST node (for T453/T454); empty when the text does not resolve. */
  types: ReadonlyMap<Expr, FormulaType>;
  /** Syntax, reference, limit and type errors, each with its position. */
  errors: FormulaError[];
}

export interface AnalyzeOptions {
  /** `stored` (default): IDs as saved; `display`: names as typed in the editor. */
  form?: FormulaForm;
}

function fieldsById(snapshot: SchemaSnapshot): Map<string, SnapshotField> {
  const out = new Map<string, SnapshotField>();
  for (const table of snapshot.tables) for (const field of table.fields) out.set(field.id, field);
  return out;
}

/**
 * Records of another table read without a link: a cross-table dependency
 * whose records (`link_path` empty) are selected by no link field of theirs
 * (the SQL compiler turns link conditions into semi-joins on the junction;
 * anything else is a scan per row, BACKLOG S4b #11).
 */
function scansOtherTable(
  dependencies: readonly FormulaDependency[],
  fields: ReadonlyMap<string, SnapshotField>,
): boolean {
  const direct = dependencies.filter(
    (item) => item.kind === 'cross_table' && item.link_path.length === 0,
  );
  if (direct.length === 0) return false;
  return !direct.some((item) => {
    const field = fields.get(item.field_id);
    return field?.linkTableId !== undefined && field.linkTableId !== null;
  });
}

/**
 * Typechecks a resolved AST (from `resolveNames` or `lookupToAst`) and
 * works out its dependencies and compute mode.
 */
export function analyzeAst(ast: Expr, snapshot: SchemaSnapshot): FormulaAnalysis {
  const checked = typecheck(ast, snapshot);
  const dependencies = checked.dependencies.result();
  const fields = fieldsById(snapshot);
  let virtualReason: VirtualReason | null = null;
  const volatile = checked.volatileFunctions[0];
  if (volatile !== undefined) {
    virtualReason = { kind: 'volatile_function', function: volatile };
  } else {
    const dependency = dependencies.find(
      (item) => fields.get(item.field_id)?.computeMode === 'virtual',
    );
    if (dependency !== undefined) {
      virtualReason = { kind: 'virtual_dependency', field_id: dependency.field_id };
    }
  }
  const failed = checked.errors.length > 0;
  const computeMode: ComputeMode = virtualReason === null ? 'stored' : 'virtual';
  return {
    ast,
    result_type: failed ? null : checked.type,
    style: checked.style,
    compute_mode: computeMode,
    virtual_reason: virtualReason,
    perf_warning:
      computeMode === 'virtual' && scansOtherTable(dependencies, fields)
        ? 'cross_table_scan'
        : null,
    dependencies,
    referenced_tables: [...checked.dependencies.tables],
    types: checked.types,
    errors: checked.errors,
  };
}

/**
 * Everything the server and the editor need to know about a formula
 * (T452): parse (stored form by default), resolve against the snapshot,
 * typecheck, dependencies (`same_row` / `via_link` / `cross_table`, SPEC
 * §5.9) and `compute_mode`. Never throws: problems are in `errors`.
 */
export function analyze(
  source: string,
  snapshot: SchemaSnapshot,
  options: AnalyzeOptions = {},
): FormulaAnalysis {
  let ast: Expr;
  try {
    ast = resolveNames(parse(source, { form: options.form ?? 'stored' }), snapshot);
  } catch (error) {
    if (!(error instanceof FormulaError)) throw error;
    return {
      ast: null,
      result_type: null,
      style: null,
      compute_mode: 'stored',
      virtual_reason: null,
      perf_warning: null,
      dependencies: [],
      referenced_tables: [],
      types: new Map(),
      errors: [error],
    };
  }
  return analyzeAst(ast, snapshot);
}
