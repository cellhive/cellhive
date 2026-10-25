import { isId, type Id } from '@cellhive/contracts';
import { findSelectOption, type FilterOperator, type SelectOptions } from '@cellhive/field-types';

import {
  dateValueSchema,
  fieldRefValueSchema,
  isDateValue,
  isFieldRefValue,
  isVariableValue,
  MAX_FILTER_CONDITIONS,
  MAX_FILTER_DEPTH,
  MAX_TEXT_VALUE_LENGTH,
  MAX_VALUE_ITEMS,
  RECORD_ID_REF,
  variableValueSchema,
  type FilterCondition,
  type FilterNode,
  type FilterOperand,
  type FilterValue,
} from './ast.js';
import { parseExactDate } from './dates.js';
import {
  fieldProfile,
  type FieldGroup,
  type FieldProfile,
  type FilterTableMeta,
} from './field-meta.js';
import { joinPath, type FilterIssue, type FilterIssueCode } from './issues.js';
import {
  isAutomationOnlyOperator,
  isDslOperator,
  isLookupOnlyOperator,
  NO_VALUE_OPERATORS,
  type DslOperator,
} from './operators.js';

/**
 * Where a filter is used:
 * - `standard`: views, record queries, record rules, dashboards;
 * - `lookup`: a lookup `where` (adds `intersects`/`disjoint` and `field_ref`, SPEC §5.8);
 * - `automation`: an automation condition (adds `changed*`, SPEC §11.3).
 */
export type FilterMode = 'standard' | 'lookup' | 'automation';

export interface ValidateFilterOptions {
  /** Defaults to `standard`. */
  readonly mode?: FilterMode;
  /**
   * Lookup mode: fields of the current table a `field_ref` may name (visible
   * to the caller). `__id` is always allowed. Unchecked when omitted.
   */
  readonly refFieldIds?: Iterable<string>;
}

export type ValidateFilterResult =
  | { readonly ok: true; readonly ast: FilterNode }
  | { readonly ok: false; readonly errors: FilterIssue[] };

/** Kind of one operand, derived from the field group and the operator. */
type OperandKind = 'text' | 'number' | 'date' | 'boolean' | 'option' | 'user' | 'record' | 'scalar';

type ValueSpec =
  | { readonly shape: 'none' }
  | { readonly shape: 'one' | 'pair' | 'list'; readonly kind: OperandKind };

const LIST_OPERATORS: ReadonlySet<DslOperator> = new Set([
  'is_any_of',
  'is_none_of',
  'has_any_of',
  'has_all_of',
  'has_none_of',
  'is_exactly',
  'intersects',
  'disjoint',
]);

/** Groups that support the lookup set operators (SPEC §5.8). */
const SET_GROUPS: ReadonlySet<FieldGroup> = new Set([
  'text',
  'number',
  'datetime',
  'single_select',
  'multi',
]);

/** The "equals" operator of a group, used for `changed_to`/`changed_from` values. */
export function equalityOperator(group: FieldGroup): FilterOperator | null {
  switch (group) {
    case 'text':
    case 'number':
      return 'eq';
    case 'datetime':
    case 'checkbox':
    case 'single_select':
      return 'is';
    case 'multi':
      return 'is_exactly';
    default:
      return null;
  }
}

/** Operators a field accepts in a mode. */
export function allowedOperators(profile: FieldProfile, mode: FilterMode): Set<DslOperator> {
  const operators = new Set<DslOperator>(profile.operators);
  if (mode === 'lookup' && SET_GROUPS.has(profile.group)) {
    operators.add('intersects');
    operators.add('disjoint');
  }
  if (mode === 'automation' && profile.group !== 'unsupported') {
    operators.add('changed');
    if (equalityOperator(profile.group) !== null) {
      operators.add('changed_to');
      operators.add('changed_from');
    }
  }
  return operators;
}

function operandKind(profile: FieldProfile): OperandKind {
  switch (profile.group) {
    case 'text':
      return 'text';
    case 'number':
      return 'number';
    case 'datetime':
      return 'date';
    case 'checkbox':
      return 'boolean';
    case 'single_select':
      return 'option';
    default:
      return profile.element;
  }
}

function valueSpec(operator: DslOperator, profile: FieldProfile): ValueSpec {
  if (NO_VALUE_OPERATORS.has(operator)) return { shape: 'none' };
  if (operator === 'changed_to' || operator === 'changed_from') {
    // `allowedOperators` only offers these when the group has an equality operator.
    return valueSpec(equalityOperator(profile.group) ?? 'is', profile);
  }
  const kind = operandKind(profile);
  if (operator === 'between') return { shape: 'pair', kind };
  if (LIST_OPERATORS.has(operator)) return { shape: 'list', kind };
  return { shape: 'one', kind };
}

const EXPECTED: Record<OperandKind, string> = {
  text: 'a non-empty string',
  number: 'a finite number',
  date: 'YYYY-MM-DD, YYYY-MM-DDTHH:mm, a $date or the today/now variable',
  boolean: 'true or false',
  option: 'an option id or name',
  user: 'a user id or the current_user/current_user_groups variable',
  record: 'a record id',
  scalar: 'a string, number or boolean',
};

const INVALID: unique symbol = Symbol('invalid');
type Checked<T> = T | typeof INVALID;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const describe = (value: unknown): string => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
};

class FilterValidator {
  readonly errors: FilterIssue[] = [];
  private conditions = 0;
  private readonly profiles = new Map<string, FieldProfile>();

  constructor(
    private readonly fields: ReadonlyMap<string, FilterTableMeta['fields'][number]>,
    private readonly mode: FilterMode,
    private readonly refFieldIds: ReadonlySet<string> | null,
  ) {}

  run(input: unknown): FilterNode | undefined {
    const ast = this.node(input, '', 0);
    if (this.conditions > MAX_FILTER_CONDITIONS) {
      this.issue(
        '',
        'MAX_CONDITIONS_EXCEEDED',
        `Filter has ${String(this.conditions)} conditions; the maximum is ${String(MAX_FILTER_CONDITIONS)}`,
        { max: MAX_FILTER_CONDITIONS, count: this.conditions },
      );
    }
    if (this.mode === 'lookup' && this.conditions === 0 && this.errors.length === 0) {
      this.issue('', 'EMPTY_FILTER', 'A lookup condition needs at least one condition');
    }
    return ast;
  }

  private issue(
    path: string,
    code: FilterIssueCode,
    message: string,
    params?: Record<string, unknown>,
  ): typeof INVALID {
    this.errors.push(
      params === undefined ? { path, code, message } : { path, code, message, params },
    );
    return INVALID;
  }

  private checkKeys(input: Record<string, unknown>, allowed: readonly string[], path: string) {
    let ok = true;
    for (const key of Object.keys(input)) {
      if (!allowed.includes(key)) {
        this.issue(joinPath(path, key), 'INVALID_STRUCTURE', `Unknown key ${JSON.stringify(key)}`);
        ok = false;
      }
    }
    return ok;
  }

  private node(input: unknown, path: string, depth: number): FilterNode | undefined {
    if (isRecord(input)) {
      if ('op' in input) return this.group(input, path, depth);
      if ('field' in input) return this.condition(input, path);
    }
    this.issue(path, 'INVALID_STRUCTURE', 'Expected a filter group or condition');
    return undefined;
  }

  private group(
    input: Record<string, unknown>,
    path: string,
    depth: number,
  ): FilterNode | undefined {
    const { op } = input;
    if (op !== 'and' && op !== 'or' && op !== 'not') {
      this.issue(joinPath(path, 'op'), 'INVALID_STRUCTURE', 'Expected "and", "or" or "not"');
      return undefined;
    }
    if (!this.checkKeys(input, op === 'not' ? ['op', 'item'] : ['op', 'items'], path)) {
      return undefined;
    }
    if (op !== 'not' && !Array.isArray(input['items'])) {
      this.issue(joinPath(path, 'items'), 'INVALID_STRUCTURE', 'Expected an array of filters');
      return undefined;
    }
    if (depth >= MAX_FILTER_DEPTH) {
      this.issue(
        path,
        'MAX_DEPTH_EXCEEDED',
        `Filter groups are nested more than ${String(MAX_FILTER_DEPTH)} levels deep`,
        { max: MAX_FILTER_DEPTH },
      );
      return undefined;
    }
    if (op === 'not') {
      const item = this.node(input['item'], joinPath(path, 'item'), depth + 1);
      return item === undefined ? undefined : { op, item };
    }
    const items: FilterNode[] = [];
    const raws = input['items'] as unknown[];
    raws.forEach((raw, index) => {
      const item = this.node(raw, joinPath(joinPath(path, 'items'), index), depth + 1);
      if (item !== undefined) items.push(item);
    });
    return items.length === raws.length ? { op, items } : undefined;
  }

  private profile(field: FilterTableMeta['fields'][number]): FieldProfile {
    let profile = this.profiles.get(field.id);
    if (profile === undefined) {
      profile = fieldProfile(field);
      this.profiles.set(field.id, profile);
    }
    return profile;
  }

  private condition(input: Record<string, unknown>, path: string): FilterCondition | undefined {
    this.conditions += 1;
    if (!this.checkKeys(input, ['field', 'operator', 'value'], path)) return undefined;
    if (this.mode === 'lookup' && input['field'] === RECORD_ID_REF) {
      return this.recordIdCondition(input, path);
    }

    const fieldPath = joinPath(path, 'field');
    const field = typeof input['field'] === 'string' ? this.fields.get(input['field']) : undefined;
    if (field === undefined) {
      // Hidden and nonexistent fields must produce the same issue.
      this.issue(
        fieldPath,
        'UNKNOWN_FIELD',
        'Field does not exist',
        typeof input['field'] === 'string' ? { field: input['field'] } : undefined,
      );
    }

    const operatorPath = joinPath(path, 'operator');
    const operator = input['operator'];
    if (!isDslOperator(operator)) {
      this.issue(operatorPath, 'OPERATOR_NOT_ALLOWED', 'Unknown operator', {
        operator: typeof operator === 'string' ? operator : describe(operator),
      });
      return undefined;
    }
    if (field === undefined) return undefined;
    if (isLookupOnlyOperator(operator) && this.mode !== 'lookup') {
      this.issue(
        operatorPath,
        'OPERATOR_NOT_ALLOWED',
        `Operator ${operator} is only allowed in lookup conditions`,
        { operator, mode: this.mode },
      );
      return undefined;
    }
    if (isAutomationOnlyOperator(operator) && this.mode !== 'automation') {
      this.issue(
        operatorPath,
        'OPERATOR_NOT_ALLOWED',
        `Operator ${operator} is only allowed in automation conditions`,
        { operator, mode: this.mode },
      );
      return undefined;
    }
    const profile = this.profile(field);
    if (!allowedOperators(profile, this.mode).has(operator)) {
      this.issue(
        operatorPath,
        'OPERATOR_NOT_ALLOWED',
        `Operator ${operator} is not allowed for this field`,
        { operator, field_type: field.resultType ?? field.type },
      );
      return undefined;
    }

    const value = this.value(input['value'], operator, profile, joinPath(path, 'value'));
    if (value === INVALID) return undefined;
    const fieldId = field.id as Id<'fld'>;
    return value === undefined ? { field: fieldId, operator } : { field: fieldId, operator, value };
  }

  /**
   * Lookup mode: `{ field: "__id", operator: is_any_of | is_none_of, value:
   * { field_ref: <link field of the current table> } }` — the source record
   * is (not) one of the records the current record links to (CONTRACTS §13).
   * Whether the referenced field is a link to the source table is checked
   * by the caller, which knows both tables.
   */
  private recordIdCondition(
    input: Record<string, unknown>,
    path: string,
  ): FilterCondition | undefined {
    const operator = input['operator'];
    if (operator !== 'is_any_of' && operator !== 'is_none_of') {
      this.issue(
        joinPath(path, 'operator'),
        'OPERATOR_NOT_ALLOWED',
        'The record ID compares with is_any_of or is_none_of only',
        { operator: typeof operator === 'string' ? operator : describe(operator) },
      );
      return undefined;
    }
    const valuePath = joinPath(path, 'value');
    const raw = input['value'];
    const parsed = fieldRefValueSchema.safeParse(raw);
    if (!parsed.success || parsed.data.field_ref === RECORD_ID_REF) {
      this.issue(
        valuePath,
        'INVALID_VALUE',
        'Expected { "field_ref": "<link field of the current table>" }',
        { expected: 'field_ref' },
      );
      return undefined;
    }
    const ref = parsed.data.field_ref;
    if (this.refFieldIds !== null && !this.refFieldIds.has(ref)) {
      this.issue(joinPath(valuePath, 'field_ref'), 'UNKNOWN_FIELD_REF', 'Field does not exist', {
        field: ref,
      });
      return undefined;
    }
    return { field: RECORD_ID_REF as Id<'fld'>, operator, value: { field_ref: ref } };
  }

  private value(
    raw: unknown,
    operator: DslOperator,
    profile: FieldProfile,
    path: string,
  ): Checked<FilterValue | undefined> {
    const spec = valueSpec(operator, profile);
    if (spec.shape === 'none') {
      if (raw !== undefined && raw !== null) {
        return this.issue(path, 'VALUE_NOT_ALLOWED', `Operator ${operator} takes no value`, {
          operator,
        });
      }
      return undefined;
    }
    if (raw === undefined || raw === null) {
      return this.issue(path, 'VALUE_REQUIRED', `Operator ${operator} needs a value`, { operator });
    }
    if (isFieldRefValue(raw)) return this.fieldRef(raw, spec.shape, path);

    switch (spec.shape) {
      case 'one': {
        // A one-element list is accepted where one option is expected (`is ["Done"]`).
        const single =
          spec.kind === 'option' && Array.isArray(raw) && raw.length === 1
            ? (raw as unknown[])[0]
            : raw;
        if (Array.isArray(single)) {
          return this.issue(path, 'INVALID_VALUE', `Expected ${EXPECTED[spec.kind]}, got array`, {
            expected: spec.kind,
          });
        }
        return this.operand(single, spec.kind, profile.select, path);
      }
      case 'pair': {
        if (!Array.isArray(raw) || raw.length !== 2) {
          return this.issue(path, 'INVALID_VALUE', 'Expected a list of exactly 2 values', {
            expected: spec.kind,
            count: 2,
          });
        }
        const pair = raw.map((item, index) =>
          this.operand(item, spec.kind, profile.select, joinPath(path, index)),
        );
        return pair.some((item) => item === INVALID) ? INVALID : (pair as FilterOperand[]);
      }
      default: {
        const list = Array.isArray(raw) ? (raw as unknown[]) : [raw];
        if (list.length === 0) {
          return this.issue(path, 'INVALID_VALUE', 'Expected at least one value', {
            expected: spec.kind,
          });
        }
        if (list.length > MAX_VALUE_ITEMS) {
          return this.issue(
            path,
            'INVALID_VALUE',
            `Expected at most ${String(MAX_VALUE_ITEMS)} values`,
            {
              max: MAX_VALUE_ITEMS,
            },
          );
        }
        const items = list.map((item, index) =>
          this.operand(
            item,
            spec.kind,
            profile.select,
            Array.isArray(raw) ? joinPath(path, index) : path,
          ),
        );
        if (items.some((item) => item === INVALID)) return INVALID;
        const unique = new Map<string, FilterOperand>();
        for (const item of items as FilterOperand[]) unique.set(JSON.stringify(item), item);
        return [...unique.values()];
      }
    }
  }

  private fieldRef(raw: unknown, shape: 'one' | 'pair' | 'list', path: string) {
    if (this.mode !== 'lookup' || shape === 'pair') {
      return this.issue(
        path,
        'INVALID_VALUE',
        this.mode === 'lookup'
          ? 'field_ref cannot be used with between'
          : 'field_ref is only allowed in lookup conditions',
      );
    }
    const parsed = fieldRefValueSchema.safeParse(raw);
    if (!parsed.success) {
      return this.issue(path, 'INVALID_VALUE', 'Expected { "field_ref": "<field id>" | "__id" }');
    }
    const ref = parsed.data.field_ref;
    if (ref !== RECORD_ID_REF && this.refFieldIds !== null && !this.refFieldIds.has(ref)) {
      return this.issue(joinPath(path, 'field_ref'), 'UNKNOWN_FIELD_REF', 'Field does not exist', {
        field: ref,
      });
    }
    return parsed.data;
  }

  private operand(
    raw: unknown,
    kind: OperandKind,
    select: SelectOptions | null,
    path: string,
  ): Checked<FilterOperand> {
    const invalid = (): typeof INVALID =>
      this.issue(path, 'INVALID_VALUE', `Expected ${EXPECTED[kind]}, got ${describe(raw)}`, {
        expected: kind,
      });
    switch (kind) {
      case 'text':
        return typeof raw === 'string' && raw.length > 0 && raw.length <= MAX_TEXT_VALUE_LENGTH
          ? raw
          : invalid();
      case 'number':
        return typeof raw === 'number' && Number.isFinite(raw) ? raw : invalid();
      case 'boolean':
        return typeof raw === 'boolean' ? raw : invalid();
      case 'scalar':
        if (typeof raw === 'string') return raw.length <= MAX_TEXT_VALUE_LENGTH ? raw : invalid();
        if (typeof raw === 'number') return Number.isFinite(raw) ? raw : invalid();
        return typeof raw === 'boolean' ? raw : invalid();
      case 'date':
        return this.dateOperand(raw, path, invalid);
      case 'option': {
        if (typeof raw !== 'string') return invalid();
        const option = select === null ? undefined : findSelectOption(select, raw);
        if (option === undefined) {
          return this.issue(
            path,
            'INVALID_SELECT_OPTION',
            `Option ${JSON.stringify(raw)} does not exist`,
            { value: raw },
          );
        }
        return option.id;
      }
      case 'user': {
        if (isId('usr', raw)) return raw;
        if (isRecord(raw) && Object.keys(raw).length === 1 && isId('usr', raw['id'])) {
          return raw['id'];
        }
        const variable = variableValueSchema.safeParse(raw);
        if (
          variable.success &&
          (variable.data.$var === 'current_user' || variable.data.$var === 'current_user_groups')
        ) {
          return variable.data;
        }
        return invalid();
      }
      default: {
        if (isId('rec', raw)) return raw;
        if (isRecord(raw) && Object.keys(raw).length === 1 && isId('rec', raw['id'])) {
          return raw['id'];
        }
        return invalid();
      }
    }
  }

  private dateOperand(
    raw: unknown,
    path: string,
    invalid: () => typeof INVALID,
  ): Checked<FilterOperand> {
    if (typeof raw === 'string') {
      return parseExactDate(raw) === null ? invalid() : { $date: { exact: raw } };
    }
    if (isVariableValue(raw)) {
      const variable = variableValueSchema.safeParse(raw);
      return variable.success && (variable.data.$var === 'today' || variable.data.$var === 'now')
        ? variable.data
        : invalid();
    }
    if (isDateValue(raw)) {
      const parsed = dateValueSchema.safeParse(raw);
      if (parsed.success) return parsed.data;
      const [first] = parsed.error.issues;
      const subPath = (first?.path ?? []).reduce<string>(
        (acc, key) => joinPath(acc, typeof key === 'number' ? key : String(key)),
        path,
      );
      return this.issue(subPath, 'INVALID_VALUE', first?.message ?? 'Invalid $date', {
        expected: 'date',
      });
    }
    return invalid();
  }
}

/**
 * Validates a filter against the table (SPEC §6, CONTRACTS §3/§6) and
 * returns it normalised: select names become option ids, `{ id }` user and
 * record references become ids, single values of list operators become
 * one-element lists (deduplicated), date strings become `$date.exact`, and
 * `null` values of no-value operators are dropped.
 *
 * `visibleFieldIds` are the fields the caller may read; any other field is
 * reported exactly like a field that does not exist. Errors carry paths
 * relative to the filter root and are reported under `INVALID_FILTER`.
 */
export function validateFilter(
  input: unknown,
  tableMeta: FilterTableMeta,
  visibleFieldIds: Iterable<string>,
  options: ValidateFilterOptions = {},
): ValidateFilterResult {
  const visible = new Set(visibleFieldIds);
  const fields = new Map(
    tableMeta.fields.filter((field) => visible.has(field.id)).map((field) => [field.id, field]),
  );
  const validator = new FilterValidator(
    fields,
    options.mode ?? 'standard',
    options.refFieldIds === undefined ? null : new Set(options.refFieldIds),
  );
  const ast = validator.run(input);
  if (validator.errors.length > 0 || ast === undefined) {
    return { ok: false, errors: validator.errors };
  }
  return { ok: true, ast };
}

/** Alias of {@link validateFilter} with the name used in BACKLOG T104. */
export const validate = validateFilter;
