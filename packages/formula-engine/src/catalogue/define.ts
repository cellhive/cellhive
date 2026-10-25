import {
  elementOf,
  formatType,
  isOpen,
  listOf,
  rowOf,
  singlesComparable,
  T,
  unify,
  type FormulaType,
} from '../types/formula-type.js';

import type {
  CallContext,
  FunctionDefinition,
  FunctionExample,
  Param,
  ParamKind,
  Signature,
} from './types.js';

type DefinitionInput = Omit<FunctionDefinition, 'volatile' | 'phase2' | 'iterates'> &
  Partial<Pick<FunctionDefinition, 'volatile' | 'iterates'>>;

/** A catalogue entry with the defaults: not volatile, not iterating. */
export function define(input: DefinitionInput): FunctionDefinition {
  return { volatile: false, iterates: false, ...input, phase2: false };
}

export function p(name: string, kind: ParamKind, optional = false): Param {
  return optional ? { name, kind, optional } : { name, kind };
}

export function sig(
  returns: string,
  params: readonly Param[],
  repeat?: number,
  trailing?: Param,
): Signature {
  const out: Signature = { params, returns };
  if (repeat !== undefined) out.repeat = repeat;
  if (trailing !== undefined) out.trailing = trailing;
  return out;
}

/** Example whose formula and result read the same in every language. */
export function ex(formula: string, result: string): FunctionExample {
  return { formula: { en: formula, vi: formula }, result: { en: result, vi: result } };
}

/** Example with field names (and possibly the result) per language. */
export function exl(en: string, vi: string, result: string, resultVi = result): FunctionExample {
  return { formula: { en, vi }, result: { en: result, vi: resultVi } };
}

export function fixed(type: FormulaType): () => FormulaType {
  return () => type;
}

/** The type of argument `index`. */
export function argType(index: number): (ctx: CallContext) => FormulaType {
  return (ctx) => ctx.args[index]?.type ?? T.any;
}

/**
 * The one type all the given arguments fit (IF branches, IFERROR…);
 * the first argument that fits none of those before it is reported.
 */
export function unifyArgs(indices: (ctx: CallContext) => readonly number[]) {
  return (ctx: CallContext): FormulaType => {
    let result: FormulaType = T.null;
    for (const index of indices(ctx)) {
      const arg = ctx.args[index];
      if (arg === undefined) continue;
      const next = unify(result, arg.type);
      if (next === null) {
        return ctx.fail(
          index,
          'TYPE_MISMATCH',
          `Expected ${formatType(result)} like the other results, got ${formatType(arg.type)}. Wrap it in TEXT() to turn it into text.`,
          {
            expected: formatType(result),
            actual: formatType(arg.type),
            // M5: the branches keep their strict types; the message says how
            // to make them fit (the editor's translation uses it too).
            suggestions: ['TEXT'],
          },
        );
      }
      result = next;
    }
    return result;
  };
}

/** Indices `from, from + step, …` below the argument count. */
export function every(from: number, step: number, drop = 0) {
  return (ctx: CallContext): number[] => {
    const out: number[] = [];
    for (let index = from; index < ctx.args.length - drop; index += step) out.push(index);
    return out;
  };
}

/** Element of a list argument; a table gives one of its records. */
export function elementOfArg(index: number) {
  return (ctx: CallContext): FormulaType => {
    const type = ctx.args[index]?.type ?? T.any;
    if (type.kind === 'table') return rowOf(type.tableId);
    return type.kind === 'list' ? type.element : type;
  };
}

/**
 * A list of the elements of the given arguments (one value, or a list —
 * a list of lists too when `flatten` is 2): they must share one type.
 */
export function listOfArgs(flatten: 1 | 2) {
  return (ctx: CallContext): FormulaType => {
    let element: FormulaType = T.null;
    ctx.args.forEach((arg, index) => {
      let type = elementOf(arg.type);
      if (flatten === 2) type = elementOf(type);
      const next = unify(element, type);
      if (next === null) {
        ctx.fail(
          index,
          'MIXED_LIST',
          `A list holds values of one type: expected ${formatType(element)}, got ${formatType(type)}.`,
          { expected: formatType(element), actual: formatType(type) },
        );
        return;
      }
      element = next;
    });
    return listOf(element);
  };
}

/**
 * CONTAIN-like checks: every value (argument `from` on) must be comparable
 * with the elements of argument 0.
 */
export function checkMembers(ctx: CallContext, from: number): void {
  const range = elementOf(ctx.args[0]?.type ?? T.any);
  for (let index = from; index < ctx.args.length; index += 1) {
    const arg = ctx.args[index];
    if (arg === undefined) continue;
    const value = elementOf(arg.type);
    if (!singlesComparable(range, value)) {
      ctx.fail(
        index,
        'TYPE_MISMATCH',
        `Cannot look for ${formatType(value)} among ${formatType(range)} values.`,
        { expected: formatType(range), actual: formatType(value) },
      );
    }
  }
}

/** `MAX`/`MIN`: numbers, or dates (then the result is a date). */
export function numbersOrDates(ctx: CallContext): FormulaType {
  let result: FormulaType = T.null;
  for (const [index, arg] of ctx.args.entries()) {
    const type = elementOf(arg.type);
    const next = unify(result, type);
    const ok =
      next !== null &&
      (isOpen(next) || next.kind === 'number' || next.kind === 'date' || next.kind === 'datetime');
    if (!ok) {
      ctx.fail(
        index,
        'TYPE_MISMATCH',
        `Expected numbers or dates of one kind, got ${formatType(type)}.`,
        {
          expected: formatType(isOpen(result) ? T.number : result),
          actual: formatType(type),
        },
      );
      continue;
    }
    result = next;
  }
  return result.kind === 'null' ? T.number : result;
}

/** Checks that a string-literal argument is one of `allowed` (case-insensitive). */
export function literalOneOf(ctx: CallContext, index: number, allowed: readonly string[]): void {
  const node = ctx.args[index]?.node;
  if (node?.type !== 'string') return;
  if (!allowed.includes(node.value.toUpperCase())) {
    ctx.fail(index, 'INVALID_ARGUMENT', `Expected one of ${allowed.join(', ')}.`, { allowed });
  }
}
