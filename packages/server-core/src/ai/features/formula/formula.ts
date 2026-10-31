import { AI_FORMULA_MAX_FORMULA_LENGTH, type Id, type ProblemErrorItem } from '@cellhive/contracts';
import {
  fieldValueType,
  listCatalogue,
  signatureText,
  type FormulaType,
} from '@cellhive/formula-engine';
import { z } from 'zod';

import { snapshotOfBase } from '../../../computed/definition/schema-rows.js';
import { UNTRUSTED_DATA_INSTRUCTIONS, untrustedBlock } from '../../untrusted.js';

import type {
  BaseSchemaRows,
  SchemaReadability,
} from '../../../computed/definition/schema-rows.js';
import type { AppError } from '../../../errors/app-error.js';
import type { AiChatMessage } from '../../client.js';
import type { AiOutputProblem } from '../../repair.js';

/**
 * "Write the formula with AI" (CONTRACTS §29.2, BACKLOG T907, ADR-39): the
 * schema digest the model sees, its answer schema, the prompt and the
 * repair problems. Pure: the API route checks the answer with the formula
 * engine (`prepareComputedDefinition`) like a save.
 */

/** Other tables of the base in the digest (the current one first, outside the count). */
export const FORMULA_DIGEST_MAX_TABLES = 20;
/** Fields per table in the digest. */
export const FORMULA_DIGEST_MAX_FIELDS = 200;
/** Option names per select field in the digest. */
export const FORMULA_DIGEST_MAX_OPTIONS = 50;
/** Characters of a field description in the digest. */
export const FORMULA_DIGEST_MAX_DESCRIPTION = 200;
/** Characters of the model's explanation. */
export const FORMULA_MAX_EXPLANATION_LENGTH = 1_000;

/** What the model answers (by name: the server never takes an id from it). */
export const aiFormulaAnswerSchema = z.strictObject({
  formula: z.string().trim().min(1).max(AI_FORMULA_MAX_FORMULA_LENGTH),
  explanation: z.string().trim().max(FORMULA_MAX_EXPLANATION_LENGTH),
});
export type AiFormulaAnswer = z.output<typeof aiFormulaAnswerSchema>;

export interface FormulaDigestField {
  readonly name: string;
  /** Field type (`number`, `select`, `link`, `formula`…). */
  readonly type: string;
  /** Formula type of its value, tables by name: `text`, `list<user>`, `list<record<Customers>>`. */
  readonly value: string;
  readonly options?: readonly string[];
  readonly description?: string;
}

export interface FormulaDigestTable {
  readonly name: string;
  readonly fields: readonly FormulaDigestField[];
}

/** The schema a formula may use, as the caller reads it: names only, never an id or a value. */
export interface FormulaDigest {
  readonly table: FormulaDigestTable;
  readonly other_tables: readonly FormulaDigestTable[];
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A formula type with table names instead of ids (`record` alone when the table is unreadable). */
function typeText(type: FormulaType, tableNames: ReadonlyMap<string, string>): string {
  switch (type.kind) {
    case 'list':
      return `list<${typeText(type.element, tableNames)}>`;
    case 'row':
    case 'table': {
      const kind = type.kind === 'row' ? 'record' : 'table';
      const name = tableNames.get(type.tableId);
      return name === undefined ? kind : `${kind}<${name}>`;
    }
    default:
      return type.kind;
  }
}

/**
 * The digest of a formula of `tableId` (BACKLOG T907): the tables and fields
 * `readable` lets through — exactly the formula-engine snapshot the answer is
 * checked against, so a hidden field is a field that does not exist (P82) —
 * minus `excludeFieldId` (the field being edited). Names, types, option
 * names and descriptions, capped.
 */
export function formulaDigest(
  rows: BaseSchemaRows,
  tableId: Id<'tbl'>,
  readable: SchemaReadability,
  excludeFieldId: Id<'fld'> | null,
): FormulaDigest {
  const snapshot = snapshotOfBase(rows, tableId, readable);
  const tableNames = new Map(snapshot.tables.map((table) => [table.id, table.name]));
  const descriptions = new Map<string, string | null>(
    rows.fields.map((field) => [field.id, field.description]),
  );
  const tableOf = (table: (typeof snapshot.tables)[number]): FormulaDigestTable => ({
    name: table.name,
    fields: table.fields
      .filter((field) => field.id !== excludeFieldId)
      .slice(0, FORMULA_DIGEST_MAX_FIELDS)
      .map((field) => {
        const choices = field.type === 'select' ? field.options?.['options'] : undefined;
        const options = Array.isArray(choices)
          ? choices
              .flatMap((option) =>
                isRecord(option) && typeof option['name'] === 'string' ? [option['name']] : [],
              )
              .slice(0, FORMULA_DIGEST_MAX_OPTIONS)
          : undefined;
        const description = descriptions.get(field.id)?.trim();
        return {
          name: field.name,
          type: field.type ?? 'unknown',
          value: typeText(fieldValueType(field), tableNames),
          ...(options === undefined ? {} : { options }),
          ...(description === undefined || description === ''
            ? {}
            : {
                description: Array.from(description)
                  .slice(0, FORMULA_DIGEST_MAX_DESCRIPTION)
                  .join(''),
              }),
        };
      }),
  });
  const current = snapshot.tables.find((table) => table.id === tableId);
  if (current === undefined) throw new TypeError('The formula table must be readable');
  return {
    table: tableOf(current),
    other_tables: snapshot.tables
      .filter((table) => table.id !== tableId)
      .slice(0, FORMULA_DIGEST_MAX_TABLES)
      .map(tableOf),
  };
}

function firstSentence(text: string): string {
  const end = text.search(/\.(\s|$)/u);
  return end === -1 ? text : text.slice(0, end + 1);
}

let catalogue: string | undefined;

/**
 * One line per supported function, generated from the formula engine's
 * catalogue (Phase 2 functions left out): syntax of every overload with its
 * result, then the first sentence of the English description.
 */
export function formulaCatalogueText(): string {
  catalogue ??= listCatalogue()
    .flatMap((entry) => {
      if (entry.phase2) return [];
      const syntax =
        entry.syntax ??
        entry.signatures
          .map((signature) => `${signatureText(entry.name, signature)} → ${signature.returns}`)
          .join(' | ');
      return [`- ${syntax}: ${firstSentence(entry.description.en)}`];
    })
    .join('\n');
  return catalogue;
}

const SYNTAX_RULES = `Formula syntax (Lark Base compatible):
- [Field] is the value of a field of the current table in the current record. [Link field].[Field] is the list of the values of the linked records (chains up to 3 links). [Table].[Field] is the list of every value of a column of another table; [Table] alone is the whole table, a range for FILTER, COUNTIF, SUMIF, SORTBY.
- CurrentValue is the item of an iteration (FILTER, MAP, COUNTIF, SUMIF…): a record over a table (write CurrentValue.[Field]), a value over a list.
- A FILTER over a table must end with .[Field]. Never put FILTER, MAP, SUMIF, COUNTIF, SORTBY or LOOKUP inside the condition of another one (chaining them is fine).
- Operators: + - * / % on numbers; = != > >= < <=; && and ||; & joins text. Dates ± numbers are dates; date − date is a number of days.
- Text in double quotes with \\" and \\\\ escapes; numbers with "." as decimal separator. Names in [...] match exactly (case included); write \\] for a ] in a name. Function names, TRUE, FALSE and CurrentValue ignore case.
- Call a function as NAME(arguments) or by chaining: [Orders].FILTER(CurrentValue.[Status] = "Paid").[Amount].SUM().
- A list is never a single value: go through SUM, ARRAYJOIN, FIRST, LAST, NTH…; a list of lists needs LISTCOMBINE first.
- A select field is its option name (text), or a list of names when it allows several. User fields are lists of users; link fields are lists of records.
- LET(name1, value1, …, expression) defines local variables.
Use only the tables, fields and functions given here: a name that is not listed does not exist.`;

/**
 * The messages of the first call (BACKLOG T907): the syntax rules, the
 * function catalogue and the answer format in the system message; the
 * digest and the formula in the editor as untrusted data blocks (names are
 * written by other people); the description of the caller as the task.
 */
export function formulaMessages(input: {
  readonly digest: FormulaDigest;
  readonly description: string;
  readonly current: string | null;
}): AiChatMessage[] {
  const system = [
    'You write formulas for Cellhive, a spreadsheet database. Turn the description of the user into one formula for a formula field of the table named "table" in the schema block.',
    SYNTAX_RULES,
    `Functions (syntax → result: description):\n${formulaCatalogueText()}`,
    UNTRUSTED_DATA_INSTRUCTIONS,
    'In the schema block, names show "ˆ" for each space: write the space in the formula ([Unit price], never [Unitˆprice]).',
    'Answer with a JSON object {"formula": "...", "explanation": "..."}: the formula with names in [...] (never ids), and one or two sentences explaining it, in the language of the description.',
  ].join('\n\n');
  const user = [
    `Tables and fields the formula may use (JSON):\n${untrustedBlock('schema', JSON.stringify(input.digest))}`,
    ...(input.current === null || input.current.trim() === ''
      ? []
      : [
          `The formula currently in the editor (fix or extend it when the description is about it):\n${untrustedBlock('current_formula', input.current)}`,
        ]),
    `Description of the formula to write:\n${input.description}`,
  ].join('\n\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** `(at character N)`: where a formula error starts, for the model. */
function positionText(item: ProblemErrorItem): string {
  const position = item.params?.['position'];
  if (!isRecord(position) || typeof position['start'] !== 'number') return '';
  return ` (at character ${String(position['start'] + 1)})`;
}

/**
 * A rejected formula (`FORMULA_*`, `VALIDATION_FAILED` of
 * `prepareComputedDefinition`, a cycle) as repair problems: codes, messages
 * and positions only — the messages name what the formula wrote or the
 * fields the caller reads, never anything else.
 */
export function formulaRepairProblems(error: AppError): AiOutputProblem[] {
  const items = error.errors ?? [];
  if (items.length === 0) {
    return [{ path: 'formula', code: error.code, message: error.detail ?? error.code }];
  }
  return items.map((item) => ({
    path: 'formula',
    code: item.code,
    message: `${item.message}${positionText(item)}`,
  }));
}
