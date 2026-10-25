import type { Expr } from '../ast.js';
import type { FormulaTypeIssueCode } from '../errors.js';
import type { FunctionName } from '../function-names.js';
import type { FormulaType } from '../types/formula-type.js';

/** Function groups of SPEC §9.3 (the editor's catalogue tabs). */
export const FUNCTION_GROUPS = ['logic', 'number', 'text', 'date', 'list'] as const;
export type FunctionGroup = (typeof FUNCTION_GROUPS)[number];

/** Text in every UI language (AGENTS.md rule 10: `en` and `vi`). */
export interface Localized {
  en: string;
  vi: string;
}

/**
 * What an argument accepts (checked before the function's own `result`):
 *
 * | Kind | Accepts |
 * |---|---|
 * | `number` | one number |
 * | `boolean` | one boolean |
 * | `date` | one `date` or `datetime` |
 * | `text` | one value of any single type (converted to text) |
 * | `single` | one value of any single type |
 * | `value` | anything but a table: one value, a list, a list of lists |
 * | `numbers` | a number or a list of numbers |
 * | `number_list` | a list of numbers |
 * | `dates` | a date or a list of dates |
 * | `list` | a (flat) list |
 * | `items` | a list or a table (FIRST/LAST/NTH) |
 * | `range` | a list or a table, iterated with `CurrentValue` |
 * | `rows` | a table or a list of records |
 * | `values` | one value or a list |
 * | `lists` | one value, a list or a list of lists (LISTCOMBINE) |
 * | `condition` | a boolean evaluated once per `CurrentValue` |
 * | `mapping` | a value evaluated once per `CurrentValue` |
 */
export type ParamKind =
  | 'number'
  | 'boolean'
  | 'date'
  | 'text'
  | 'single'
  | 'value'
  | 'numbers'
  | 'number_list'
  | 'dates'
  | 'list'
  | 'items'
  | 'range'
  | 'rows'
  | 'values'
  | 'lists'
  | 'condition'
  | 'mapping';

export interface Param {
  /** Key into `PARAM_NAMES` (localized display name). */
  name: string;
  kind: ParamKind;
  optional?: boolean;
}

/**
 * One overload. With `repeat: n`, the last `n` params repeat as a group
 * (`SUM(number, …)`: 1; `IFS(condition, value, …)`: 2); the group may be
 * left out entirely only when its params are optional. Optional params
 * outside a group are trailing ones.
 */
export interface Signature {
  params: readonly Param[];
  repeat?: number;
  /** One optional param after the repeated group (`SWITCH`'s default). */
  trailing?: Param;
  /** Return type as shown in the catalogue, e.g. `number`, `list<T>`. */
  returns: string;
}

/** A typed argument, for `result`. */
export interface TypedArg {
  node: Expr;
  type: FormulaType;
  style: Readonly<Record<string, unknown>> | null;
}

/** What a function's `result` sees and may report. */
export interface CallContext {
  args: readonly TypedArg[];
  /** The formula's table (`RECORD_ID()`). */
  tableId: string;
  /** Reports a type error on argument `index` (the whole call when `null`). */
  fail(
    index: number | null,
    code: FormulaTypeIssueCode,
    message: string,
    params?: Record<string, unknown>,
  ): FormulaType;
}

export interface FunctionExample {
  /** Formula as a user writes it; field names differ per language. */
  formula: Localized;
  /** Result as displayed. */
  result: Localized;
}

export interface FunctionDefinition {
  name: FunctionName;
  group: FunctionGroup;
  signatures: readonly Signature[];
  description: Localized;
  examples: readonly FunctionExample[];
  /** Differences from Lark or notes on semantics, shown under the description. */
  notes?: Localized;
  /** Result changes without any data change (`NOW`, `TODAY`): the field is `virtual` (SPEC §5.9). */
  volatile: boolean;
  phase2: false;
  /** Arguments after the first run once per element of it (`CurrentValue`, SPEC §9.2). */
  iterates: boolean;
  /**
   * Result type, after every argument matched a signature. May report
   * further errors through `ctx.fail` (which returns `any`).
   */
  result(ctx: CallContext): FormulaType;
  /** Arguments whose `style` (currency, format…) the result keeps; the first one set wins. */
  styleFrom?: 'all' | readonly number[];
  /** Signature text override (catalogue display) when the params cannot express it. */
  syntax?: string;
}

/** A Phase 2 function (SPEC §9.3): listed so the editor can explain it, rejected by the parser. */
export interface Phase2FunctionDefinition {
  name: string;
  group: FunctionGroup | 'geo';
  syntax: string;
  description: Localized;
  phase2: true;
  volatile: boolean;
}

export type CatalogueEntry = FunctionDefinition | Phase2FunctionDefinition;
