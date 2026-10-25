import {
  formatType,
  isDateLike,
  isFlatList,
  isNestedList,
  isOpen,
  type FormulaType,
} from '../types/formula-type.js';

import type { ParamKind } from '../catalogue/types.js';
import type { FormulaTypeIssueCode } from '../errors.js';

export interface ArgumentIssue {
  code: FormulaTypeIssueCode;
  message: string;
  params: Record<string, unknown>;
}

/** What to use to get one value out of a list (SPEC §9.2). */
export const LIST_TO_VALUE_SUGGESTIONS = ['SUM', 'ARRAYJOIN', 'FIRST'] as const;

const EXPECTED: Readonly<Record<ParamKind, string>> = {
  number: 'number',
  boolean: 'boolean',
  condition: 'boolean',
  date: 'date',
  text: 'text',
  single: 'value',
  value: 'value',
  mapping: 'value',
  numbers: 'number | list<number>',
  number_list: 'list<number>',
  dates: 'date | list<date>',
  list: 'list',
  items: 'list',
  range: 'list | table',
  rows: 'table | list<record>',
  values: 'value | list',
  lists: 'value | list',
};

function issue(
  code: FormulaTypeIssueCode,
  message: string,
  params: Record<string, unknown> = {},
): ArgumentIssue {
  return { code, message, params };
}

function mismatch(kind: ParamKind, type: FormulaType): ArgumentIssue {
  return issue('TYPE_MISMATCH', `Expected ${EXPECTED[kind]}, got ${formatType(type)}.`, {
    expected: EXPECTED[kind],
    actual: formatType(type),
  });
}

/** A table, or one record, where a value is needed: pick a field. */
function needsField(): ArgumentIssue {
  return issue('TABLE_NEEDS_FIELD', 'Select a field of the records: .[Field].');
}

function nestedList(): ArgumentIssue {
  return issue(
    'NESTED_LIST',
    'This is a list of lists (a multi-value field of several records): flatten it with LISTCOMBINE().',
    { suggestions: ['LISTCOMBINE'] },
  );
}

/** Why a list or table does not fit where one value is expected. */
function notSingle(kind: ParamKind, type: FormulaType): ArgumentIssue | null {
  if (type.kind === 'table') return needsField();
  if (isNestedList(type)) return nestedList();
  if (type.kind === 'list') {
    return issue(
      'LIST_AS_SCALAR',
      `Expected one ${EXPECTED[kind]}, got a list: use SUM, ARRAYJOIN, FIRST… to get one value.`,
      {
        expected: EXPECTED[kind],
        actual: formatType(type),
        suggestions: [...LIST_TO_VALUE_SUGGESTIONS],
      },
    );
  }
  return null;
}

/** `type` fits one value of the scalar kind `kind` (after list/table checks). */
function single(kind: ParamKind, type: FormulaType, fits: (type: FormulaType) => boolean) {
  const problem = notSingle(kind, type);
  if (problem !== null) return problem;
  if (type.kind === 'row' && kind !== 'text' && kind !== 'single' && kind !== 'values') {
    return needsField();
  }
  return fits(type) ? null : mismatch(kind, type);
}

/** A flat list whose elements fit `fits`. */
function listOf(kind: ParamKind, type: FormulaType, fits: (type: FormulaType) => boolean) {
  if (type.kind === 'table') return needsField();
  if (isNestedList(type)) return nestedList();
  if (type.kind !== 'list') {
    return issue('EXPECTED_LIST', `Expected ${EXPECTED[kind]}, got ${formatType(type)}.`, {
      expected: EXPECTED[kind],
      actual: formatType(type),
    });
  }
  return fits(type.element) ? null : mismatch(kind, type);
}

const isNumber = (type: FormulaType) => isOpen(type) || type.kind === 'number';
const isBoolean = (type: FormulaType) => isOpen(type) || type.kind === 'boolean';
const isDate = (type: FormulaType) => isOpen(type) || isDateLike(type);
/**
 * A date parameter also takes text (M4): a date-shaped string such as
 * `DATEDIF("2000-01-01", …)` — as in Lark. Both backends coerce it with the
 * `TODATE` rule at run time (SPEC §9.4); anything unparseable is empty.
 * List-of-dates parameters (holidays) stay strict.
 */
const isDateLikeOrText = (type: FormulaType) => isDate(type) || type.kind === 'text';
const anyType = () => true;

/**
 * Whether an argument of type `type` fits a param of kind `kind`
 * (see `ParamKind`). `any` and `null` fit everything.
 */
export function checkArgument(kind: ParamKind, type: FormulaType): ArgumentIssue | null {
  if (type.kind === 'any') return null;
  switch (kind) {
    case 'number':
      return single(kind, type, isNumber);
    case 'boolean':
    case 'condition':
      return single(kind, type, isBoolean);
    case 'date':
      return single(kind, type, isDateLikeOrText);
    case 'text':
    case 'single':
      return single(kind, type, anyType);
    case 'value':
    case 'mapping':
      return type.kind === 'table' ? needsField() : null;
    case 'numbers':
      return type.kind === 'list' ? listOf(kind, type, isNumber) : single(kind, type, isNumber);
    case 'dates':
      return type.kind === 'list' ? listOf(kind, type, isDate) : single(kind, type, isDate);
    case 'number_list':
      return listOf(kind, type, isNumber);
    case 'list':
      return listOf(kind, type, anyType);
    case 'items':
    case 'range':
      return type.kind === 'table' || isFlatList(type) || type.kind === 'null'
        ? null
        : listOf(kind, type, anyType);
    case 'rows':
      if (type.kind === 'table') return null;
      return listOf(kind, type, (element) => isOpen(element) || element.kind === 'row');
    case 'values':
      return type.kind === 'list' ? listOf(kind, type, anyType) : single(kind, type, anyType);
    case 'lists':
      return type.kind === 'table' ? needsField() : null;
  }
}
