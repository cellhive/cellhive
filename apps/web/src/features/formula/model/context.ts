import { scanFormula, type ScanToken } from './scan';
import { tableOf, type FormulaSchema, type FormulaSchemaField } from './schema';

/**
 * What the tokens of a formula refer to, worked out from the tokens alone
 * so that it also holds while the formula is incomplete (T466): the table
 * each `[Name]` is read in (SPEC §9.2 — a field of the current table
 * first, then a table of the base; after `x.` a field of the records `x`
 * stands for), the `CurrentValue` scope of FILTER/MAP/COUNTIF/SUMIF/SORTBY,
 * and the function calls still open at the end (signature bar).
 */

/** Functions whose later arguments run once per element of the first (`CurrentValue`). */
export const ITERATING_FUNCTIONS: ReadonlySet<string> = new Set([
  'FILTER',
  'MAP',
  'COUNTIF',
  'SUMIF',
  'SORTBY',
]);

/** Functions returning elements of their first argument: rows stay rows of the same table. */
const ROW_PRESERVING: ReadonlySet<string> = new Set([
  'FILTER',
  'SORTBY',
  'SORT',
  'UNIQUE',
  'FIRST',
  'LAST',
  'NTH',
]);

/** Records of a table an expression stands for (`[Table]`, a link, `CurrentValue`, FILTER of them). */
export interface Rows {
  readonly tableId: string;
  /** Reached from `[Table]` (not through a link of the current record). */
  readonly fromTable: boolean;
}

/** A `[Name]` token and what it resolves to. */
export interface NameRef {
  readonly start: number;
  readonly length: number;
  readonly name: string;
  /** `field`: `field` set; `table`: `tableId` is the table; `unknown`: nothing matches. */
  readonly kind: 'field' | 'table' | 'unknown';
  /** Table of the field, or the table itself. */
  readonly tableId: string | null;
  readonly field: FormulaSchemaField | null;
}

/** A function call whose `(` is open. */
export interface OpenCall {
  /** Upper case; `null` for plain parentheses. */
  readonly name: string | null;
  /** Written `x.NAME(…)`: the receiver is argument 0. */
  readonly chained: boolean;
  /** Index of the argument being written, counting the receiver of a chained call. */
  readonly argument: number;
  /** Offset of the `(`. */
  readonly open: number;
  /** Offset of the function name. */
  readonly nameStart: number;
}

export interface FormulaContext {
  readonly tokens: readonly ScanToken[];
  readonly names: readonly NameRef[];
  /** Calls still open after the last token, innermost last. */
  readonly open: readonly OpenCall[];
  /** Records `CurrentValue` stands for at the end: rows, a plain value, or outside iteration. */
  readonly current: Rows | 'value' | null;
  /** `LET` variables defined before the end. */
  readonly variables: readonly string[];
  /** Records of the expression that ends with the last token (before a `.`: the receiver). */
  readonly rows: Rows | null;
}

interface Frame {
  name: string | null;
  chained: boolean;
  receiver: Rows | null;
  firstArg: Rows | null;
  /** Comma-separated argument inside the parentheses (0-based). */
  index: number;
  open: number;
  nameStart: number;
}

function fieldIn(schema: FormulaSchema, tableId: string, name: string) {
  return tableOf(schema, tableId)?.fields.find((field) => field.name === name);
}

function tableNamed(schema: FormulaSchema, name: string) {
  return schema.tables.find((table) => table.name === name);
}

function linkRows(field: FormulaSchemaField, fromTable: boolean): Rows | null {
  return field.linkTableId === null ? null : { tableId: field.linkTableId, fromTable };
}

/** What a `[name]` resolves to: after `x.` (`receiver` given) or on its own. */
export function resolveName(
  schema: FormulaSchema,
  name: string,
  receiver: Rows | null | undefined,
): { ref: Omit<NameRef, 'start' | 'length' | 'name'>; rows: Rows | null } {
  if (receiver !== undefined) {
    if (receiver === null)
      return { ref: { kind: 'unknown', tableId: null, field: null }, rows: null };
    const field = fieldIn(schema, receiver.tableId, name);
    if (field === undefined) {
      return { ref: { kind: 'unknown', tableId: receiver.tableId, field: null }, rows: null };
    }
    return {
      ref: { kind: 'field', tableId: receiver.tableId, field },
      rows: linkRows(field, receiver.fromTable),
    };
  }
  const field = fieldIn(schema, schema.tableId, name);
  if (field !== undefined) {
    return { ref: { kind: 'field', tableId: schema.tableId, field }, rows: linkRows(field, false) };
  }
  const table = tableNamed(schema, name);
  if (table !== undefined) {
    return {
      ref: { kind: 'table', tableId: table.id, field: null },
      rows: { tableId: table.id, fromTable: true },
    };
  }
  return { ref: { kind: 'unknown', tableId: null, field: null }, rows: null };
}

/** `CurrentValue` inside the innermost iterating call whose condition is being written. */
function currentOf(frames: readonly Frame[]): Rows | 'value' | null {
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index] as Frame;
    if (frame.name === null || !ITERATING_FUNCTIONS.has(frame.name)) continue;
    const argument = frame.chained ? frame.index + 1 : frame.index;
    if (argument < 1) continue;
    const range = frame.chained ? frame.receiver : frame.firstArg;
    return range ?? 'value';
  }
  return null;
}

/** Walks the tokens of `source`. */
export function formulaContext(source: string, schema: FormulaSchema): FormulaContext {
  const tokens = scanFormula(source);
  const names: NameRef[] = [];
  const frames: Frame[] = [];
  const variables: string[] = [];
  /** Records of the expression ending at the previous token (`undefined`: no expression ends there). */
  let rows: Rows | null | undefined;
  /** Records before the `.` just read (`undefined`: the previous token is not a `.`). */
  let receiver: Rows | null | undefined;
  let pending: { name: string; chained: boolean; receiver: Rows | null; start: number } | null =
    null;

  tokens.forEach((token, index) => {
    const next = tokens[index + 1];
    const afterDot = receiver;
    receiver = undefined;
    switch (token.type) {
      case 'name':
      case 'open_name': {
        const resolved = resolveName(schema, token.value, afterDot);
        names.push({
          start: token.start,
          length: token.length,
          name: token.value,
          ...resolved.ref,
        });
        rows = resolved.rows;
        break;
      }
      case 'broken_ref':
        names.push({
          start: token.start,
          length: token.length,
          name: token.value,
          kind: 'unknown',
          tableId: null,
          field: null,
        });
        rows = null;
        break;
      case 'identifier': {
        const upper = token.value.toUpperCase();
        if (next?.type === 'operator' && next.value === '(') {
          pending = {
            name: upper,
            chained: afterDot !== undefined,
            receiver: afterDot ?? null,
            start: token.start,
          };
          rows = undefined;
        } else if (upper === 'CURRENTVALUE') {
          const current = currentOf(frames);
          rows = current === 'value' ? null : current;
        } else {
          // A LET variable is written right after `(` or `,` at an even position of LET.
          const frame = frames.at(-1);
          const previous = tokens[index - 1];
          if (
            frame?.name === 'LET' &&
            frame.index % 2 === 0 &&
            next?.type === 'operator' &&
            next.value === ',' &&
            previous?.type === 'operator' &&
            (previous.value === '(' || previous.value === ',') &&
            !variables.includes(token.value)
          ) {
            variables.push(token.value);
          }
          rows = null;
        }
        break;
      }
      case 'operator':
        switch (token.value) {
          case '(':
            frames.push({
              name: pending?.name ?? null,
              chained: pending?.chained ?? false,
              receiver: pending?.receiver ?? null,
              firstArg: null,
              index: 0,
              open: token.start,
              nameStart: pending?.start ?? token.start,
            });
            pending = null;
            rows = undefined;
            break;
          case ',': {
            const frame = frames.at(-1);
            if (frame !== undefined) {
              if (frame.index === 0) frame.firstArg = rows ?? null;
              frame.index += 1;
            }
            rows = undefined;
            break;
          }
          case ')': {
            const frame = frames.pop();
            if (frame === undefined) {
              rows = null;
              break;
            }
            if (frame.index === 0) frame.firstArg = rows ?? null;
            if (frame.name === null) {
              // Plain parentheses keep what they hold.
              rows = frame.index === 0 ? frame.firstArg : null;
            } else if (ROW_PRESERVING.has(frame.name)) {
              rows = frame.chained ? frame.receiver : frame.firstArg;
            } else {
              rows = null;
            }
            break;
          }
          case '.':
            receiver = rows ?? null;
            break;
          default:
            rows = undefined;
        }
        break;
      default:
        rows = null;
    }
  });

  return {
    tokens,
    names,
    open: frames.map((frame) => ({
      name: frame.name,
      chained: frame.chained,
      argument: frame.chained ? frame.index + 1 : frame.index,
      open: frame.open,
      nameStart: frame.nameStart,
    })),
    current: currentOf(frames),
    variables,
    rows: rows ?? null,
  };
}
