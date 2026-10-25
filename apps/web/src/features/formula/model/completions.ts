import {
  bracketName,
  listCatalogue,
  type FunctionDefinition,
  type FunctionGroup,
} from '@cellhive/formula-engine';

import { formulaContext, type Rows } from './context';
import { matchLabel } from './match';
import { tableOf, type FormulaSchema, type FormulaSchemaField } from './schema';

/**
 * Autocomplete of the formula editor (T466; BACKLOG S4b design decision
 * #3; board "S4b · Gợi ý khi gõ công thức"):
 *
 * - `[`: fields of the current table first, then the tables of the base;
 * - `[Table].` / `[Link].`: fields of that table, then the functions that
 *   take a table ("Hàm cho bảng");
 * - `CurrentValue.` inside FILTER/MAP/COUNTIF/SUMIF/SORTBY over a table:
 *   fields of that table, not of the current one;
 * - a word: fields, tables, variables (`CurrentValue`, `LET` names) and
 *   functions whose name matches.
 *
 * Only what the schema holds is offered: the tables and fields the author
 * reads (`GET …/tables`, `GET …/fields` leave the others out).
 */

export type SuggestionSection =
  | { readonly kind: 'fields'; readonly table: string }
  | { readonly kind: 'tables' }
  | { readonly kind: 'variables' }
  | { readonly kind: 'tableFunctions' }
  | { readonly kind: 'functions'; readonly group: FunctionGroup };

export interface Suggestion {
  readonly kind: 'field' | 'table' | 'function' | 'variable' | 'keyword';
  readonly label: string;
  /** Text that replaces `from`…`to`. */
  readonly apply: string;
  /** Caret offset in `apply` after inserting it. */
  readonly caret: number;
  /** Suggest again right after inserting (a table, `CurrentValue.`). */
  readonly reopen: boolean;
  readonly section: SuggestionSection;
  /** Bold part of `label`. */
  readonly match: readonly [number, number];
  readonly field?: FormulaSchemaField;
  readonly tableId?: string;
  readonly definition?: FunctionDefinition;
}

export interface SuggestionResult {
  readonly from: number;
  readonly to: number;
  readonly items: readonly Suggestion[];
}

/** Functions whose first argument is a table (or its records): what `[Table].` chains to. */
const TABLE_PARAM_KINDS: ReadonlySet<string> = new Set(['range', 'rows', 'items']);

let catalogue: FunctionDefinition[] | null = null;
function functions(): FunctionDefinition[] {
  catalogue ??= listCatalogue().filter(
    (entry): entry is FunctionDefinition => !entry.phase2 && entry.name !== 'LET',
  );
  return catalogue;
}

function takesTable(definition: FunctionDefinition): boolean {
  return definition.signatures.some((signature) => {
    const first = signature.params[0];
    return first !== undefined && TABLE_PARAM_KINDS.has(first.kind);
  });
}

function takesNothing(definition: FunctionDefinition): boolean {
  return definition.signatures.every((signature) => signature.params.length === 0);
}

interface Ranked {
  readonly item: Suggestion;
  readonly rank: number;
  readonly order: number;
}

class Collector {
  private readonly ranked: Ranked[] = [];

  constructor(private readonly query: string) {}

  add(item: Omit<Suggestion, 'match'>): void {
    const match = matchLabel(item.label, this.query);
    if (match === null) return;
    this.ranked.push({
      item: { ...item, match: match.range },
      rank: match.rank,
      order: this.ranked.length,
    });
  }

  /** Sections keep their order; inside one, better matches first. */
  result(sectionOrder: (section: SuggestionSection) => number): Suggestion[] {
    return [...this.ranked]
      .sort(
        (a, b) =>
          sectionOrder(a.item.section) - sectionOrder(b.item.section) ||
          a.rank - b.rank ||
          a.order - b.order,
      )
      .map((entry) => entry.item);
  }
}

const SECTION_ORDER: Readonly<Record<SuggestionSection['kind'], number>> = {
  fields: 0,
  tables: 1,
  variables: 2,
  tableFunctions: 3,
  functions: 4,
};
const GROUP_ORDER: readonly FunctionGroup[] = ['logic', 'number', 'text', 'date', 'list'];

function sectionOrder(section: SuggestionSection): number {
  const base = SECTION_ORDER[section.kind] * 10;
  return section.kind === 'functions' ? base + GROUP_ORDER.indexOf(section.group) : base;
}

function addFields(collector: Collector, schema: FormulaSchema, tableId: string): void {
  const table = tableOf(schema, tableId);
  if (table === undefined) return;
  for (const field of table.fields) {
    const apply = bracketName(field.name);
    collector.add({
      kind: 'field',
      label: field.name,
      apply,
      caret: apply.length,
      reopen: false,
      section: { kind: 'fields', table: table.name },
      field,
      tableId,
    });
  }
}

function addTables(collector: Collector, schema: FormulaSchema): void {
  for (const table of schema.tables) {
    const apply = `${bracketName(table.name)}.`;
    collector.add({
      kind: 'table',
      label: table.name,
      apply,
      caret: apply.length,
      reopen: true,
      section: { kind: 'tables' },
      tableId: table.id,
    });
  }
}

function addFunction(
  collector: Collector,
  definition: FunctionDefinition,
  nextChar: string,
  tableSection: boolean,
): void {
  const name = definition.name;
  const open = nextChar === '(';
  const apply = open ? name : `${name}()`;
  collector.add({
    kind: 'function',
    label: name,
    apply,
    caret: open || takesNothing(definition) ? apply.length : name.length + 1,
    reopen: false,
    section: tableSection
      ? { kind: 'tableFunctions' }
      : { kind: 'functions', group: definition.group },
    definition,
  });
}

function addVariables(
  collector: Collector,
  current: Rows | 'value' | null,
  variables: readonly string[],
): void {
  if (current !== null) {
    const apply = current === 'value' ? 'CurrentValue' : 'CurrentValue.';
    collector.add({
      kind: 'variable',
      label: 'CurrentValue',
      apply,
      caret: apply.length,
      reopen: current !== 'value',
      section: { kind: 'variables' },
    });
  }
  for (const name of variables) {
    collector.add({
      kind: 'variable',
      label: name,
      apply: name,
      caret: name.length,
      reopen: false,
      section: { kind: 'variables' },
    });
  }
}

/**
 * Suggestions at `pos` of `source` (only the text before the caret counts).
 * `explicit`: asked for with Ctrl/⌘+Space — then a list comes even where
 * nothing is being typed.
 */
export function suggest(
  source: string,
  pos: number,
  schema: FormulaSchema,
  explicit: boolean,
): SuggestionResult | null {
  const context = formulaContext(source.slice(0, pos), schema);
  const tokens = context.tokens;
  const last = tokens.at(-1);
  const beforeLast = tokens.at(-2);
  const nextChar = source.charAt(pos);
  const endsHere = last !== undefined && last.start + last.length === pos;

  // `[Name` being typed.
  if (last?.type === 'open_name') {
    const collector = new Collector(last.value);
    const to = nextChar === ']' ? pos + 1 : pos;
    const member = beforeLast?.type === 'operator' && beforeLast.value === '.';
    if (member) {
      const ref = context.names.at(-1);
      if (ref?.tableId === null || ref === undefined) return null;
      addFields(collector, schema, ref.tableId);
    } else {
      addFields(collector, schema, schema.tableId);
      addTables(collector, schema);
    }
    return { from: last.start, to, items: collector.result(sectionOrder) };
  }

  // Inside a string being typed, or right after a value: nothing to suggest.
  if (last !== undefined && endsHere && (last.type === 'string' || last.type === 'number')) {
    return null;
  }

  const word = last?.type === 'identifier' && endsHere ? last : null;
  const dot = word === null ? last : beforeLast;
  const afterDot =
    dot?.type === 'operator' && dot.value === '.' && (word !== null || (endsHere && dot === last));
  const query = word?.value ?? '';
  const from = word?.start ?? pos;

  if (afterDot) {
    const collector = new Collector(query);
    // `context.rows` is the receiver (a `.` leaves the rows before it).
    const receiver = word === null ? context.rows : receiverBefore(source, dot.start, schema);
    if (receiver !== null) {
      addFields(collector, schema, receiver.tableId);
      for (const definition of functions()) {
        if (takesTable(definition)) addFunction(collector, definition, nextChar, true);
      }
    } else {
      for (const definition of functions()) {
        if (!takesNothing(definition)) addFunction(collector, definition, nextChar, false);
      }
    }
    // Fields are written `[…]`: the dot stays, the word is replaced.
    return { from, to: pos, items: collector.result(sectionOrder) };
  }

  if (word === null && !explicit) return null;
  if (word === null && last !== undefined && endsHere) {
    // Right after a value (`[A]`, `)`) only an operator fits.
    const closesValue =
      last.type === 'name' ||
      last.type === 'broken_ref' ||
      (last.type === 'operator' && last.value === ')');
    if (closesValue) return null;
  }
  const collector = new Collector(query);
  addFields(collector, schema, schema.tableId);
  addTables(collector, schema);
  addVariables(collector, context.current, context.variables);
  for (const definition of functions()) addFunction(collector, definition, nextChar, false);
  for (const keyword of ['TRUE', 'FALSE']) {
    collector.add({
      kind: 'keyword',
      label: keyword,
      apply: keyword,
      caret: keyword.length,
      reopen: false,
      section: { kind: 'functions', group: 'logic' },
    });
  }
  return { from, to: pos, items: collector.result(sectionOrder) };
}

/** Records the expression before the `.` at `dot` stands for. */
function receiverBefore(source: string, dot: number, schema: FormulaSchema): Rows | null {
  return formulaContext(source.slice(0, dot + 1), schema).rows;
}
