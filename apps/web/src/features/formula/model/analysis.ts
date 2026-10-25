import {
  analyze,
  MAX_CROSS_TABLE_FILTERS,
  MAX_FORMULA_LENGTH,
  type Expr,
  type FormulaAnalysis,
  type FormulaDependency,
  type FormulaType,
  type SchemaSnapshot,
} from '@cellhive/formula-engine';

import { formulaContext, ITERATING_FUNCTIONS } from './context';
import { lineColumn } from './scan';
import { resultTypeOf, toSnapshot, type FormulaSchema, type FormulaSchemaField } from './schema';

import type { ComputedResultTypeDto } from '@cellhive/contracts';

/**
 * Everything the formula editor shows about the text being typed (T466),
 * from the engine's `analyze` (display form, names as typed): positioned
 * errors, the result type, `stored`/`virtual` and why, the static
 * performance warning, whether the preview can run in the browser, and the
 * footer counters.
 */

export interface Diagnostic {
  readonly start: number;
  readonly length: number;
  /** Detail code (CONTRACTS §6 `FORMULA_*_DETAIL_CODES`), translated by the UI. */
  readonly code: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly line: number;
  readonly column: number;
}

export interface Dependency {
  readonly tableId: string;
  readonly tableName: string;
  readonly fields: readonly string[];
}

export interface EditorAnalysis {
  readonly source: string;
  readonly analysis: FormulaAnalysis;
  readonly snapshot: SchemaSnapshot;
  readonly diagnostics: readonly Diagnostic[];
  readonly resultType: ComputedResultTypeDto | null;
  /** BACKLOG S4b design decision #5 (static, never by row count). */
  readonly perfWarning: boolean;
  /**
   * Reads only fields of its own record (no link, no other table) and uses no regular
   * expression: the browser computes it.
   */
  readonly sameRow: boolean;
  readonly crossTableFilters: number;
  readonly length: number;
  readonly dependencies: readonly Dependency[];
}

function children(node: Expr): readonly Expr[] {
  switch (node.type) {
    case 'member':
      return [node.object];
    case 'call':
      return node.args;
    case 'let':
      return [...node.bindings.map((binding) => binding.value), node.body];
    case 'unary':
      return [node.operand];
    case 'binary':
      return [node.left, node.right];
    default:
      return [];
  }
}

/** Every node of the tree, in a loop (a 4,000-character `1+1+…` is ~2,000 levels deep, T470). */
function walk(node: Expr, visit: (node: Expr) => void): void {
  const pending: Expr[] = [node];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    visit(next);
    pending.push(...children(next));
  }
}

/** Regular-expression functions (T470: see {@link analyzeFormula}). */
const REGEX_FUNCTIONS: ReadonlySet<string> = new Set([
  'REGEXMATCH',
  'REGEXEXTRACT',
  'REGEXREPLACE',
]);

function usesRegex(ast: Expr): boolean {
  let found = false;
  walk(ast, (node) => {
    if (node.type === 'call' && REGEX_FUNCTIONS.has(node.name)) found = true;
  });
  return found;
}

const isCurrentValueField = (node: Expr | undefined): boolean =>
  node?.type === 'member' && node.object.type === 'current_value';

/** A function applied to `CurrentValue.[col]` somewhere in `condition` (Lark's slow pattern). */
function wrapsCurrentValue(condition: Expr): boolean {
  let found = false;
  walk(condition, (node) => {
    if (node.type === 'call' && node.args.some(isCurrentValueField)) found = true;
  });
  return found;
}

/** FILTER/COUNTIF/SUMIF/… over a table (`[Table]`, a FILTER of it) in `ast`, with their conditions. */
function crossTableCalls(
  ast: Expr,
  types: ReadonlyMap<Expr, FormulaType>,
): { count: number; conditions: Expr[] } {
  let count = 0;
  const conditions: Expr[] = [];
  walk(ast, (node) => {
    if (node.type !== 'call') return;
    const range = node.args[0];
    const overTable = range !== undefined && types.get(range)?.kind === 'table';
    if (ITERATING_FUNCTIONS.has(node.name) && overTable) {
      count += 1;
      const condition = node.args[1];
      if (condition !== undefined) conditions.push(condition);
    } else if (node.name === 'LOOKUP') {
      count += 1;
    }
  });
  return { count, conditions };
}

/**
 * Records of another table read without a link (the engine's rule for
 * `perf_warning`, T452): a cross-table dependency at the start of no link
 * path whose records no link field selects.
 */
function scansOtherTable(
  dependencies: readonly FormulaDependency[],
  fields: ReadonlyMap<string, FormulaSchemaField>,
): boolean {
  const direct = dependencies.filter(
    (item) => item.kind === 'cross_table' && item.link_path.length === 0,
  );
  if (direct.length === 0) return false;
  return !direct.some((item) => (fields.get(item.field_id)?.linkTableId ?? null) !== null);
}

function fieldsById(schema: FormulaSchema): Map<string, FormulaSchemaField> {
  const out = new Map<string, FormulaSchemaField>();
  for (const table of schema.tables) for (const field of table.fields) out.set(field.id, field);
  return out;
}

function dependenciesOf(
  schema: FormulaSchema,
  analysis: FormulaAnalysis,
  fields: ReadonlyMap<string, FormulaSchemaField>,
): Dependency[] {
  const byTable = new Map<string, string[]>();
  const tableOfField = new Map<string, string>();
  for (const table of schema.tables) {
    for (const field of table.fields) tableOfField.set(field.id, table.id);
  }
  for (const dependency of analysis.dependencies) {
    const field = fields.get(dependency.field_id);
    const tableId = tableOfField.get(dependency.field_id);
    if (field === undefined || tableId === undefined) continue;
    const list = byTable.get(tableId) ?? [];
    if (!list.includes(field.name)) list.push(field.name);
    byTable.set(tableId, list);
  }
  // Tables read as a whole (`[Table]` with no field read) still count.
  for (const tableId of analysis.referenced_tables) {
    if (!byTable.has(tableId)) byTable.set(tableId, []);
  }
  const order = (tableId: string) => (tableId === schema.tableId ? -1 : 0);
  return [...byTable.entries()]
    .sort(([a], [b]) => order(a) - order(b))
    .map(([tableId, names]) => ({
      tableId,
      tableName: schema.tables.find((table) => table.id === tableId)?.name ?? '',
      fields: names,
    }));
}

function diagnosticsOf(
  source: string,
  schema: FormulaSchema,
  analysis: FormulaAnalysis,
): Diagnostic[] {
  return analysis.errors.map((error) => {
    const params: Record<string, unknown> = { ...error.params };
    if (error.detail === 'UNEXPECTED_END') {
      // "Missing ) to close SUM(" when a call is still open at the end.
      const open = formulaContext(source, schema).open.at(-1);
      if (open?.name !== undefined && open.name !== null) params['function'] = open.name;
    }
    const { line, column } = lineColumn(source, error.start);
    return { start: error.start, length: error.length, code: error.detail, params, line, column };
  });
}

/** Analyses `source` (display form) against `schema`. */
export function analyzeFormula(source: string, schema: FormulaSchema): EditorAnalysis {
  const snapshot = toSnapshot(schema);
  const analysis = analyze(source, snapshot, { form: 'display' });
  const fields = fieldsById(schema);
  const failed = analysis.errors.length > 0 || analysis.ast === null;
  const calls =
    analysis.ast === null
      ? { count: 0, conditions: [] }
      : crossTableCalls(analysis.ast, analysis.types);
  const scans = scansOtherTable(analysis.dependencies, fields);
  const perfWarning =
    !failed &&
    scans &&
    (analysis.compute_mode === 'virtual' || calls.conditions.some(wrapsCurrentValue));
  // A pattern with nested quantifiers (`^(a+)+$`, `^([a-z]+ ?)+$`) backtracks exponentially in
  // JavaScript and would freeze the tab on a row's text while typing (QA S4b, T470); the server
  // computes it with PostgreSQL's regex engine (no such blow-up) under a 2 s statement timeout.
  const sameRow =
    !failed &&
    analysis.ast !== null &&
    !usesRegex(analysis.ast) &&
    analysis.referenced_tables.length === 0 &&
    analysis.dependencies.every(
      (dependency) =>
        dependency.kind === 'same_row' &&
        (fields.get(dependency.field_id)?.linkTableId ?? null) === null,
    );
  return {
    source,
    analysis,
    snapshot,
    diagnostics: diagnosticsOf(source, schema, analysis),
    resultType: failed ? null : resultTypeOf(analysis.result_type),
    perfWarning,
    sameRow,
    crossTableFilters: calls.count,
    length: source.length,
    dependencies: failed ? [] : dependenciesOf(schema, analysis, fields),
  };
}

export const FORMULA_LIMITS = {
  length: MAX_FORMULA_LENGTH,
  crossTableFilters: MAX_CROSS_TABLE_FILTERS,
} as const;
