import {
  formulaOptionsSchema,
  lookupOptionsSchema,
  parseComputedStyle,
  type ComputedResultType,
  type ComputedStyle,
} from '@cellhive/field-types';
import { validateFilter } from '@cellhive/filter-dsl';
import {
  analyzeAst,
  FormulaError,
  lookupToAst,
  parse,
  resolveNames,
  serialize,
  type Expr,
  type FormulaAnalysis,
  type FormulaType,
  type LookupOptions,
  type PerfWarning,
} from '@cellhive/formula-engine';
import { z } from 'zod';

import { AppError } from '../../errors/app-error.js';
import { zodIssuesToProblemErrors } from '../../errors/zod-issues.js';
import { compileCrossAnalysis } from '../../formula/cross/index.js';
import { FormulaCompileError } from '../../formula/errors.js';

import { ComputeModel } from './compute-model.js';
import { checkLookupFieldRefs, lookupFilterFieldMeta } from './lookup-where.js';
import { snapshotOfBase, type BaseSchemaRows, type SchemaReadability } from './schema-rows.js';

import type { ComputeMode, FieldRow, JsonObject } from '../../db/schema.js';
import type { Id, ProblemErrorItem } from '@cellhive/contracts';

/**
 * Definitions of computed fields (BACKLOG T456, SPEC §5.8, §9): the options
 * a request gives (display form, names) become the stored options (IDs),
 * the analysis (result type, compute mode, dependencies) and the default
 * style — checked against what the person saving may read (SPEC §9.5: an
 * unreadable table or field is reported exactly like a missing one).
 */

export type ComputedFieldTypeName = 'formula' | 'lookup';

/** How the formula text of a request is written. */
export type ExpressionForm = 'display' | 'stored';

export interface ComputedDefinitionInput {
  readonly type: ComputedFieldTypeName;
  /**
   * Options as the API takes them (CONTRACTS §13). Formula `expression` is
   * in `expressionForm` (the API: `display`; an update that keeps the
   * current text: `stored`).
   */
  readonly options: unknown;
  readonly expressionForm?: ExpressionForm;
  /**
   * `given`: `options.style` is checked against the result (a style that
   * does not fit is `422`); `keep`: `value` (the current style) is kept
   * when it still fits, else the default; `default`: the style of the
   * field the result carries (`[Số tiền] * 0.1` keeps a currency).
   */
  readonly style:
    | { readonly mode: 'given' }
    | { readonly mode: 'keep'; readonly value: unknown }
    | { readonly mode: 'default' };
}

export interface ComputedDefinitionContext {
  readonly rows: BaseSchemaRows;
  readonly tableId: Id<'tbl'>;
  /** What the saver may reference; absent: everything (the system). */
  readonly readable?: SchemaReadability;
  /** Organization zone, for the compile check (ADR-21). */
  readonly timeZone: string;
}

export interface PreparedComputedDefinition {
  readonly type: ComputedFieldTypeName;
  /** Options to store (`meta.fields.options`): stored expression / validated `where`, style. */
  readonly options: JsonObject;
  readonly analysis: FormulaAnalysis;
  readonly resultType: FormulaType;
  readonly publicType: ComputedResultType;
  readonly computeMode: ComputeMode;
  readonly style: ComputedStyle | null;
  readonly perfWarning: PerfWarning | null;
}

/** The API form of a result type (`result_type` of the field DTO, CONTRACTS §13). */
export function publicResultType(type: FormulaType): ComputedResultType {
  const list = type.kind === 'list';
  const element = type.kind === 'list' ? type.element : type;
  switch (element.kind) {
    case 'text':
    case 'number':
    case 'boolean':
    case 'date':
    case 'datetime':
    case 'user':
    case 'attachment':
    case 'null':
      return { kind: element.kind, list };
    case 'row':
      return { kind: 'record', list };
    default:
      return { kind: 'null', list };
  }
}

/** The problem path of a formula error: the expression, or the lookup option it names. */
function pathOf(error: FormulaError, type: ComputedFieldTypeName): string {
  const path = error.params['path'];
  if (type === 'lookup' && typeof path === 'string' && path !== '') return `options.${path}`;
  return type === 'formula' ? 'options.expression' : 'options';
}

/**
 * `422 FORMULA_*` for formula errors (CONTRACTS §6): the top-level code of
 * the first, every error in `errors[]` with its detail code and
 * `params.position`.
 */
export function formulaProblem(
  errors: readonly FormulaError[],
  type: ComputedFieldTypeName = 'formula',
): AppError {
  const [first] = errors;
  if (first === undefined) throw new TypeError('formulaProblem needs an error');
  return new AppError(first.code, {
    detail: first.message,
    errors: errors.map((error) => {
      const item = error.toProblemError(pathOf(error, type));
      // `params.path` of lookup errors is the problem path now.
      const params: Record<string, unknown> = { ...item.params };
      delete params['path'];
      return { ...item, params };
    }),
  });
}

function validationFailed(errors: ProblemErrorItem[]): AppError {
  return new AppError('VALIDATION_FAILED', { errors });
}

function parseOptions<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value ?? {});
  if (!parsed.success) {
    throw validationFailed(
      zodIssuesToProblemErrors(parsed.error.issues).map((item) => ({
        ...item,
        path: item.path === '' ? 'options' : `options.${item.path}`,
      })),
    );
  }
  return parsed.data;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Request options of a formula: `expression` (any text length ≤ the stored cap) and `style`. */
const formulaRequestSchema = formulaOptionsSchema.extend({
  style: z.record(z.string(), z.unknown()).nullable().optional(),
});

interface Analysed {
  readonly analysis: FormulaAnalysis;
  readonly ast: Expr;
  readonly options: Omit<JsonObject, 'style'>;
}

function analyseFormula(
  options: z.output<typeof formulaRequestSchema>,
  form: ExpressionForm,
  context: ComputedDefinitionContext,
): Analysed {
  const snapshot = snapshotOfBase(context.rows, context.tableId, context.readable);
  let ast: Expr;
  try {
    ast = resolveNames(parse(options.expression, { form }), snapshot);
  } catch (error) {
    if (error instanceof FormulaError) throw formulaProblem([error]);
    throw error;
  }
  const analysis = analyzeAst(ast, snapshot);
  if (analysis.errors.length > 0) throw formulaProblem(analysis.errors);
  return { analysis, ast, options: { expression: serialize(ast, 'stored') } };
}

function analyseLookup(options: unknown, context: ComputedDefinitionContext): Analysed {
  const parsed = parseOptions(lookupOptionsSchema, options);
  const { rows, tableId, readable } = context;
  const snapshot = snapshotOfBase(rows, tableId, readable);
  const unknownTable = () =>
    formulaProblem(
      [
        new FormulaError(
          'UNKNOWN_TABLE',
          'Unknown source table.',
          { start: 0, length: 0 },
          { path: 'from' },
        ),
      ],
      'lookup',
    );
  if (!snapshot.tables.some((table) => table.id === parsed.from)) throw unknownTable();
  const sourceFields = rows.fields.filter((field) => field.table_id === parsed.from);
  const visibleSource = sourceFields.filter(
    (field) => readable === undefined || readable.field(parsed.from, field.id),
  );
  const visibleCurrent = rows.fields.filter(
    (field) =>
      field.table_id === tableId && (readable === undefined || readable.field(tableId, field.id)),
  );
  // Filter DSL of the source table, lookup mode: `field_ref` names readable current fields.
  const validated = validateFilter(
    parsed.where,
    { fields: sourceFields.map(lookupFilterFieldMeta) },
    visibleSource.map((field) => field.id),
    { mode: 'lookup', refFieldIds: visibleCurrent.map((field) => field.id) },
  );
  if (!validated.ok) {
    throw new AppError('INVALID_FILTER', {
      detail: 'The lookup condition is invalid.',
      errors: validated.errors.map((issue) => ({
        ...issue,
        path: issue.path === '' ? 'options.where' : `options.where.${issue.path}`,
      })),
    });
  }
  const where = validated.ast as unknown as JsonObject;
  const lookup = {
    from: parsed.from,
    select: parsed.select,
    where,
    aggregate: parsed.aggregate,
  };
  let ast: Expr;
  try {
    checkLookupFieldRefs(
      where,
      new Map(visibleSource.map((field) => [field.id, field])),
      new Map(visibleCurrent.map((field) => [field.id, field])),
    );
    ast = lookupToAst(lookup as unknown as LookupOptions, snapshot);
  } catch (error) {
    if (error instanceof FormulaError) throw formulaProblem([error], 'lookup');
    throw error;
  }
  const analysis = analyzeAst(ast, snapshot);
  if (analysis.errors.length > 0) throw formulaProblem(analysis.errors, 'lookup');
  return { analysis, ast, options: lookup };
}

/**
 * Checks and prepares a formula/lookup definition. Throws `AppError`:
 * `422 VALIDATION_FAILED` (options shape, style), `FORMULA_SYNTAX_ERROR` /
 * `FORMULA_TYPE_ERROR` / `FORMULA_LIMIT_EXCEEDED` (with
 * `errors[].params.position`), `INVALID_FILTER` (lookup `where`). Cycles
 * and the per-base limit are the caller's (they need the graph under a lock).
 */
export function prepareComputedDefinition(
  input: ComputedDefinitionInput,
  context: ComputedDefinitionContext,
): PreparedComputedDefinition {
  const raw = isRecord(input.options) ? input.options : {};
  let analysed: Analysed;
  if (input.type === 'formula') {
    const options = parseOptions(formulaRequestSchema, input.options);
    analysed = analyseFormula(options, input.expressionForm ?? 'display', context);
  } else {
    analysed = analyseLookup({ ...raw, style: null }, context);
  }
  const { analysis } = analysed;
  const resultType = analysis.result_type;
  if (resultType === null) throw new TypeError('An analysis without errors has a result type');
  const publicType = publicResultType(resultType);
  // Style: the one given (validated against the result), else the default
  // one carried from the source field when it fits.
  let style: ComputedStyle | null;
  const fallback = () => {
    const parsed = parseComputedStyle(analysis.style, publicType);
    return parsed.ok ? parsed.style : null;
  };
  if (input.style.mode === 'given') {
    const parsed = parseComputedStyle(raw['style'], publicType);
    if (!parsed.ok) {
      throw validationFailed([
        { path: 'options.style', code: 'INVALID_VALUE', message: parsed.message },
      ]);
    }
    style = parsed.style;
  } else if (input.style.mode === 'keep') {
    const parsed = parseComputedStyle(input.style.value, publicType);
    style = parsed.ok && parsed.style !== null ? parsed.style : fallback();
  } else {
    style = fallback();
  }
  // Compile check (never executed): what the typecheck accepts must compile,
  // else the backfill would fail later.
  try {
    const model = new ComputeModel(context.rows, { timeZone: context.timeZone });
    compileCrossAnalysis(
      analysis,
      { timeZone: context.timeZone, tableAlias: 'cr' },
      model.cross(context.tableId),
    );
  } catch (error) {
    if (error instanceof FormulaCompileError && error.code === 'TOO_LARGE') {
      throw compiledSizeProblem(error, input.type);
    }
    if (error instanceof FormulaCompileError) {
      throw formulaProblem(
        [new FormulaError('TYPE_MISMATCH', error.message, { start: 0, length: 0 })],
        input.type,
      );
    }
    throw error;
  }
  return {
    type: input.type,
    options: { ...analysed.options, style: style as JsonObject | null },
    analysis,
    resultType,
    publicType,
    computeMode: analysis.compute_mode,
    style,
    perfWarning: analysis.perf_warning,
  };
}

/**
 * `422 FORMULA_LIMIT_EXCEEDED` / `MAX_COMPILED_SIZE` (SPEC §9.5): the SQL of
 * the definition would pass the compile budget (`FORMULA_SQL_MAX_BYTES`,
 * `FORMULA_SQL_MAX_PARAMETERS`) — values repeated too often (`LET`
 * variables, IFBLANK, SWITCH…). `params.limit` and `params.unit`
 * (`bytes` | `parameters`).
 */
function compiledSizeProblem(error: FormulaCompileError, type: ComputedFieldTypeName): AppError {
  const message = 'The formula is too complex: it repeats values too often';
  return new AppError('FORMULA_LIMIT_EXCEEDED', {
    detail: `${message}.`,
    errors: [
      {
        path: type === 'formula' ? 'options.expression' : 'options',
        code: 'MAX_COMPILED_SIZE',
        message,
        params: { ...error.params, position: { start: 0, length: 0 } },
      },
    ],
  });
}

/**
 * `422 FORMULA_CYCLE`: `params.cycle` lists the fields of the chain the
 * saver may read (`{ id, name, table_id }`, first = the field being saved),
 * never the others (SPEC §9.5, like P08).
 */
export function formulaCycleProblem(
  cycle: readonly string[],
  rows: BaseSchemaRows,
  readable: SchemaReadability | undefined,
): AppError {
  const items = cycle.flatMap((id) => {
    const field = rows.fields.find((row) => row.id === id);
    if (field === undefined) return [];
    if (readable !== undefined && !readable.field(field.table_id, field.id)) return [];
    return [{ id: field.id, name: field.name, table_id: field.table_id }];
  });
  return new AppError('FORMULA_CYCLE', {
    detail: 'The formula refers to itself through other fields.',
    errors: [
      {
        path: 'options',
        code: 'CIRCULAR_REFERENCE',
        message: 'The formula refers to itself through other fields',
        params: { cycle: items, position: { start: 0, length: 0 } },
      },
    ],
  });
}

/** `true` when `field` is a formula/lookup field. */
export function isComputedRow(field: Pick<FieldRow, 'type'>): boolean {
  return field.type === 'formula' || field.type === 'lookup';
}
