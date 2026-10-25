import {
  formatComputedText,
  type ComputedResultType,
  type ComputedStyle,
} from '@cellhive/field-types';

import { analyzeAst } from '../deps/analyze.js';
import { FormulaError } from '../errors.js';
import { tryParse, type FormulaForm } from '../parser.js';
import { renderNames, resolveNames, type SchemaSnapshot } from '../resolve.js';
import { serialize } from '../serialize.js';

import { splitTemplate, type SplitOptions, type TemplatePart } from './split.js';

import type { Expr } from '../ast.js';
import type { FormulaDependency } from '../deps/collector.js';
import type { FormulaJsonValue } from '../evaluate/values.js';
import type { Style } from '../typecheck/typecheck.js';
import type { FormulaType } from '../types/formula-type.js';

/**
 * Templates (SPEC §11.4, ADR-32 §3; BACKLOG T504): literal text with
 * `{{ formula }}` placeholders, the only template language of automations
 * (no Handlebars, no JS). Each expression is a formula of the table the
 * template runs on (the trigger record, or a `digest` row): parsed, names
 * resolved against a snapshot of what the saver may read, typechecked —
 * any result type is allowed and becomes text (`formatTemplateValue`).
 *
 * Templates are **stored with IDs** (`{{ [fld_…] }}`, the canonical stored
 * form of SPEC §9.2) and shown with names (`renderTemplateNames`): renaming
 * a field does not break them; a deleted or unreadable field is
 * `#REF[fld_…]` in the display form and an `UNKNOWN_FIELD` error when the
 * template is checked again.
 */

/** Template-level detail codes (formula codes of `FormulaError` are passed through). */
export const CROSS_TABLE_NOT_SUPPORTED = 'CROSS_TABLE_NOT_SUPPORTED';

/** One problem of a template, positioned in the template source (UTF-16 code units). */
export interface TemplateProblem {
  /** `UNTERMINATED_PLACEHOLDER`…, a formula detail code, `CROSS_TABLE_NOT_SUPPORTED`. */
  readonly code: string;
  /** English; clients translate by `code` + `params`. */
  readonly message: string;
  readonly params: Readonly<Record<string, unknown>> & {
    readonly position: { readonly start: number; readonly length: number };
  };
}

export interface CheckTemplateOptions extends SplitOptions {
  /** Form of the expressions: `stored` (IDs, default) or `display` (names, as typed). */
  readonly form?: FormulaForm;
  /** Upper-case function names refused with `UNSUPPORTED_FUNCTION`. */
  readonly disallow?: readonly string[];
  /** `false`: a `[Table]` reference is `CROSS_TABLE_NOT_SUPPORTED`. Default `true`. */
  readonly allowTables?: boolean;
  /** Extra IDs accepted as field references (`ParseOptions.referenceIds`). */
  readonly referenceIds?: (id: string) => boolean;
}

/** A placeholder that resolved and typechecked. */
export interface CheckedPlaceholder {
  readonly index: number;
  readonly start: number;
  readonly length: number;
  /** Resolved AST (IDs and current names). */
  readonly ast: Expr;
  /** Node types for the evaluator. */
  readonly types: ReadonlyMap<Expr, FormulaType>;
  readonly type: FormulaType;
  readonly style: Style | null;
  readonly stored: string;
  readonly display: string;
  readonly dependencies: readonly FormulaDependency[];
}

export interface TemplateCheck {
  readonly parts: readonly TemplatePart[];
  /** Placeholders without problems, by `index`. */
  readonly placeholders: readonly CheckedPlaceholder[];
  readonly errors: readonly TemplateProblem[];
  /** Canonical stored text (`{{ [fld_…] }}`), `null` when there are errors. */
  readonly stored: string | null;
  /** Display text with current names, `null` when there are errors. */
  readonly display: string | null;
}

const SYNTAX_MESSAGES: Readonly<Record<string, string>> = {
  UNTERMINATED_PLACEHOLDER: 'This {{ has no closing }}.',
  EMPTY_PLACEHOLDER: 'This {{ }} is empty.',
  TOO_MANY_PLACEHOLDERS: 'The template has too many {{ }} placeholders.',
};

function problemAt(
  code: string,
  message: string,
  start: number,
  length: number,
  params: Readonly<Record<string, unknown>> = {},
): TemplateProblem {
  return { code, message, params: { ...params, position: { start, length } } };
}

/** A formula error of an expression, moved to its place in the template. */
function shifted(error: FormulaError, offset: number): TemplateProblem {
  return problemAt(error.detail, error.message, offset + error.start, error.length, error.params);
}

/** Every node of an AST (no recursion limit issue: ASTs are ≤ 50 deep, spines looped). */
function* walk(root: Expr): Generator<Expr> {
  const stack: Expr[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as Expr;
    yield node;
    switch (node.type) {
      case 'member':
        stack.push(node.property, node.object);
        break;
      case 'call':
        for (let index = node.args.length - 1; index >= 0; index -= 1) {
          stack.push(node.args[index] as Expr);
        }
        break;
      case 'let':
        stack.push(node.body);
        for (let index = node.bindings.length - 1; index >= 0; index -= 1) {
          stack.push((node.bindings[index] as { value: Expr }).value);
        }
        break;
      case 'unary':
        stack.push(node.operand);
        break;
      case 'binary':
        stack.push(node.right, node.left);
        break;
      default:
        break;
    }
  }
}

/**
 * Calls of disallowed functions in an AST (parsed or resolved), as
 * `UNSUPPORTED_FUNCTION` errors (`params.function`) in source order.
 */
export function disallowedCalls(ast: Expr, disallow: readonly string[]): FormulaError[] {
  if (disallow.length === 0) return [];
  const names = new Set(disallow);
  const out: FormulaError[] = [];
  for (const node of walk(ast)) {
    if (node.type === 'call' && names.has(node.name)) {
      out.push(
        new FormulaError(
          'UNSUPPORTED_FUNCTION',
          `The function ${node.name} cannot be used in automations.`,
          node,
          { function: node.name, name: node.name },
        ),
      );
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** The first `[Table]` reference of a resolved AST (a whole table, not a link). */
function tableReference(ast: Expr): Expr | null {
  let first: Expr | null = null;
  for (const node of walk(ast)) {
    if (node.type === 'reference' && node.kind === 'table') {
      if (first === null || node.start < first.start) first = node;
    }
  }
  return first;
}

interface ExpressionCheck {
  readonly placeholder: CheckedPlaceholder | null;
  readonly errors: TemplateProblem[];
}

function checkExpression(
  part: TemplatePart & { kind: 'expression' },
  snapshot: SchemaSnapshot,
  options: CheckTemplateOptions,
): ExpressionCheck {
  const offset = part.expressionStart;
  const parsed = tryParse(part.expression, {
    form: options.form ?? 'stored',
    ...(options.referenceIds === undefined ? {} : { referenceIds: options.referenceIds }),
  });
  if (!parsed.ok) return { placeholder: null, errors: [shifted(parsed.error, offset)] };
  const refused = disallowedCalls(parsed.ast, options.disallow ?? []);
  if (refused.length > 0) {
    return { placeholder: null, errors: refused.map((error) => shifted(error, offset)) };
  }
  let resolved: Expr;
  try {
    resolved = resolveNames(parsed.ast, snapshot);
  } catch (error) {
    if (!(error instanceof FormulaError)) throw error;
    return { placeholder: null, errors: [shifted(error, offset)] };
  }
  if (options.allowTables === false) {
    const table = tableReference(resolved);
    if (table !== null) {
      return {
        placeholder: null,
        errors: [
          problemAt(
            CROSS_TABLE_NOT_SUPPORTED,
            'A template cannot read a whole table: find the records with a step, then use a digest.',
            offset + table.start,
            table.length,
          ),
        ],
      };
    }
  }
  const analysis = analyzeAst(resolved, snapshot);
  if (analysis.errors.length > 0 || analysis.result_type === null) {
    return { placeholder: null, errors: analysis.errors.map((error) => shifted(error, offset)) };
  }
  return {
    placeholder: {
      index: part.index,
      start: part.start,
      length: part.length,
      ast: resolved,
      types: analysis.types,
      type: analysis.result_type,
      style: analysis.style,
      stored: serialize(resolved, 'stored'),
      display: serialize(resolved, 'display'),
      dependencies: analysis.dependencies,
    },
    errors: [],
  };
}

/** The template with every expression replaced by `text(index)`; literal text kept as written. */
function rebuild(
  source: string,
  parts: readonly TemplatePart[],
  text: (index: number) => string,
): string {
  return parts
    .map((part) =>
      part.kind === 'text'
        ? source.slice(part.start, part.start + part.length)
        : `{{ ${text(part.index)} }}`,
    )
    .join('');
}

/**
 * Checks a template against a snapshot (SPEC §9.2): syntax of the
 * placeholders, then for each expression parse, disallowed functions,
 * names, `[Table]` references (when `allowTables` is `false`) and types.
 * Every problem is collected with its position in the template. Never
 * throws for user input.
 */
export function checkTemplate(
  source: string,
  snapshot: SchemaSnapshot,
  options: CheckTemplateOptions = {},
): TemplateCheck {
  const split = splitTemplate(source, options);
  const errors: TemplateProblem[] = split.issues.map((issue) =>
    problemAt(issue.code, SYNTAX_MESSAGES[issue.code] ?? issue.code, issue.start, issue.length),
  );
  const placeholders: CheckedPlaceholder[] = [];
  for (const part of split.parts) {
    if (part.kind !== 'expression') continue;
    const checked = checkExpression(part, snapshot, options);
    errors.push(...checked.errors);
    if (checked.placeholder !== null) placeholders.push(checked.placeholder);
  }
  errors.sort((a, b) => a.params.position.start - b.params.position.start);
  if (errors.length > 0) {
    return { parts: split.parts, placeholders, errors, stored: null, display: null };
  }
  const byIndex = new Map(placeholders.map((placeholder) => [placeholder.index, placeholder]));
  return {
    parts: split.parts,
    placeholders,
    errors,
    stored: rebuild(source, split.parts, (index) => byIndex.get(index)?.stored ?? ''),
    display: rebuild(source, split.parts, (index) => byIndex.get(index)?.display ?? ''),
  };
}

/**
 * Stored template → display template (names), never failing: an ID that is
 * gone or unreadable shows as `#REF[fld_…]`; an expression that does not
 * parse is kept as written.
 */
export function renderTemplateNames(
  stored: string,
  snapshot: SchemaSnapshot,
  options: Pick<CheckTemplateOptions, 'referenceIds'> = {},
): string {
  const split = splitTemplate(stored);
  return rebuild(stored, split.parts, (index) => {
    const part = split.parts.find((item) => item.kind === 'expression' && item.index === index);
    const expression = part?.kind === 'expression' ? part.expression : '';
    try {
      return renderNames(
        expression,
        snapshot,
        options.referenceIds === undefined ? {} : { referenceIds: options.referenceIds },
      );
    } catch (error) {
      if (error instanceof FormulaError) return expression;
      throw error;
    }
  });
}

/** The API form of a formula type (`result_type` of computed fields, CONTRACTS §13). */
export function templateResultType(type: FormulaType): ComputedResultType {
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
      return { kind: 'text', list };
  }
}

export interface TemplateFormatContext {
  /** BCP 47 tag of number/date formats (the organization's). */
  readonly locale: string;
  /** IANA zone of dates (ADR-21). */
  readonly timeZone: string;
  /** Display name of a user ID; absent or `null` → the ID. */
  readonly userName?: (userId: string) => string | null;
}

/**
 * A placeholder value as text: like `cell_format=text` of a computed value
 * (CONTRACTS §2) — numbers and dates through the result `style`, lists
 * joined with `, `, records by title, users by name, booleans
 * `TRUE`/`FALSE`, empty → `""`.
 */
export function formatTemplateValue(
  value: FormulaJsonValue,
  type: FormulaType,
  style: Style | null,
  context: TemplateFormatContext,
): string {
  const result = templateResultType(type);
  let shaped: unknown = value;
  if (result.kind === 'user' && context.userName !== undefined) {
    const named = (item: unknown): unknown => {
      if (typeof item !== 'string') return item;
      return { id: item, name: context.userName?.(item) ?? item };
    };
    shaped = Array.isArray(value) ? value.map(named) : named(value);
  }
  if (result.kind === 'text' && !result.list && typeof value !== 'string') {
    // `any`-typed results (an untyped field) keep their JSON kind.
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  }
  return formatComputedText(shaped, result, (style as ComputedStyle | null) ?? null, {
    locale: context.locale,
    timeZone: context.timeZone,
  });
}
