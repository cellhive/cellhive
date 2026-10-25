import {
  datetimeOptionsSchema,
  getFieldType,
  isDateOnlyFormat,
  isS1FieldType,
  MULTI_VALUE_OPERATORS,
  selectOptionsSchema,
  type FieldType,
  type FilterOperator,
  type SelectOptions,
} from '@cellhive/field-types';

/** What the filter needs to know about one field of a table. */
export interface FilterFieldMeta {
  readonly id: string;
  readonly name: string;
  readonly type: FieldType;
  /** Raw `meta.fields.options`; only select options are read (option ids/names, `multiple`). */
  readonly options?: unknown;
  /** Formula/lookup only: type of the computed value, which decides operators and values. */
  readonly resultType?: FieldType;
  /** Formula/lookup only: options of the result type (e.g. the source select's options). */
  readonly resultOptions?: unknown;
  /** Lookup only: the value is a list (aggregate `raw_value`/`unique`) → multi-value operators. */
  readonly resultIsList?: boolean;
}

export interface FilterTableMeta {
  readonly fields: readonly FilterFieldMeta[];
}

/**
 * Columns of the SPEC §6.2 operator table (and of the CONTRACTS §3 tuple
 * table). `multi` is the last row: multi select, user, created_by/updated_by,
 * link, parent and list lookups.
 */
export type FieldGroup =
  | 'text'
  | 'number'
  | 'datetime'
  | 'checkbox'
  | 'single_select'
  | 'multi'
  | 'attachment'
  | 'unsupported';

/**
 * Kind of the elements of a `multi` field's value. `text`: a list of texts
 * computed by a formula/lookup (BACKLOG T457), compared exactly as strings.
 */
export type ElementKind = 'option' | 'user' | 'record' | 'text' | 'scalar';

export interface FieldProfile {
  readonly group: FieldGroup;
  /** Element kind for `multi`; `option` also for single select. */
  readonly element: ElementKind;
  /** Operators SPEC §6.2 allows for this field (standard mode). */
  readonly operators: readonly FilterOperator[];
  /** Parsed select options when the field (or its result) is a select. */
  readonly select: SelectOptions | null;
}

const EMPTY_OPERATORS = ['is_empty', 'is_not_empty'] as const satisfies FilterOperator[];

const UNSUPPORTED: FieldProfile = {
  group: 'unsupported',
  element: 'scalar',
  operators: [],
  select: null,
};

function groupOf(type: FieldType): FieldGroup {
  switch (type) {
    case 'text':
    case 'auto_number':
      return 'text';
    case 'number':
      return 'number';
    case 'datetime':
    case 'created_at':
    case 'updated_at':
      return 'datetime';
    case 'checkbox':
      return 'checkbox';
    case 'user':
    case 'created_by':
    case 'updated_by':
    case 'link':
    case 'parent':
      return 'multi';
    case 'attachment':
      return 'attachment';
    default:
      // `select` is decided by its options; formula/lookup by their result.
      return 'unsupported';
  }
}

function elementOf(type: FieldType): ElementKind {
  switch (type) {
    case 'select':
      return 'option';
    case 'user':
    case 'created_by':
    case 'updated_by':
      return 'user';
    case 'link':
    case 'parent':
      return 'record';
    default:
      return 'scalar';
  }
}

function parseSelect(options: unknown): SelectOptions {
  return selectOptionsSchema.parse(options ?? {});
}

function storageProfile(type: FieldType, options: unknown): FieldProfile {
  if (type === 'select') {
    const select = parseSelect(options);
    return {
      group: select.multiple ? 'multi' : 'single_select',
      element: 'option',
      operators: getFieldType('select')?.filterOperators(select) ?? [],
      select,
    };
  }
  const group = groupOf(type);
  if (group === 'unsupported') return UNSUPPORTED;
  let operators: readonly FilterOperator[];
  if (isS1FieldType(type)) {
    operators = getFieldType(type)?.filterOperators(options ?? {}) ?? [];
  } else if (group === 'attachment') {
    operators = EMPTY_OPERATORS;
  } else {
    operators = MULTI_VALUE_OPERATORS;
  }
  return { group, element: elementOf(type), operators, select: null };
}

/**
 * True when a `datetime` field (or a formula/lookup whose result is one) is
 * stored as `date` rather than `timestamptz` (its `style.format` has no time,
 * SPEC §5.5). `created_at`/`updated_at` are always `timestamptz`. Throws when
 * the datetime options in meta are invalid (meta is trusted input).
 */
export function isDateOnlyField(field: FilterFieldMeta): boolean {
  const computed = field.type === 'formula' || field.type === 'lookup';
  const type = computed ? field.resultType : field.type;
  if (type !== 'datetime') return false;
  const options = datetimeOptionsSchema.parse(
    (computed ? field.resultOptions : field.options) ?? {},
  );
  return isDateOnlyFormat(options.style.format);
}

/**
 * Filter profile of a field: its operator group, allowed operators and value
 * kind. Formula and lookup fields use their result type (SPEC §6.2); a list
 * lookup uses the multi-value operators. Throws when select options in meta
 * are invalid (meta is trusted input).
 */
export function fieldProfile(field: FilterFieldMeta): FieldProfile {
  if (field.type !== 'formula' && field.type !== 'lookup') {
    return storageProfile(field.type, field.options);
  }
  const resultType = field.resultType;
  if (resultType === undefined || resultType === 'formula' || resultType === 'lookup') {
    return UNSUPPORTED;
  }
  if (field.resultIsList === true) {
    if (resultType === 'attachment') return storageProfile('attachment', undefined);
    const element = elementOf(resultType);
    if (element === 'scalar' && resultType !== 'text') {
      // Lists of numbers, dates or booleans (BACKLOG T457): only emptiness.
      return { group: 'multi', element, operators: EMPTY_OPERATORS, select: null };
    }
    return {
      group: 'multi',
      element: resultType === 'text' ? 'text' : element,
      operators: MULTI_VALUE_OPERATORS,
      select: resultType === 'select' ? parseSelect(field.resultOptions) : null,
    };
  }
  return storageProfile(resultType, field.resultOptions);
}
