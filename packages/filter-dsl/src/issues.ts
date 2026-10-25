/**
 * Detail codes for `errors[].code` of an `INVALID_FILTER` problem
 * (CONTRACTS §6). `path` is relative to the filter root: `items[1].value`,
 * `item.field`, or `conditions[0][1]` for the tuple form; `''` is the root.
 */
export const FILTER_ISSUE_CODES = [
  /** The node is not a group, `not` or condition, or has unknown keys. */
  'INVALID_STRUCTURE',
  /** Field does not exist or is not visible to the caller (indistinguishable on purpose). */
  'UNKNOWN_FIELD',
  /** Operator unknown, not allowed for the field type, or not allowed in this mode. */
  'OPERATOR_NOT_ALLOWED',
  /** The operator needs a value and none was given. */
  'VALUE_REQUIRED',
  /** The operator takes no value (`is_empty`, `is_not_empty`, `changed`). */
  'VALUE_NOT_ALLOWED',
  /** Value has the wrong shape or type for the operator and field. */
  'INVALID_VALUE',
  /** Select value names no existing option (by id or name). */
  'INVALID_SELECT_OPTION',
  /** `field_ref` names a field the lookup's table does not have (or the caller cannot see). */
  'UNKNOWN_FIELD_REF',
  /** More than `MAX_FILTER_DEPTH` nested groups. */
  'MAX_DEPTH_EXCEEDED',
  /** More than `MAX_FILTER_CONDITIONS` conditions. */
  'MAX_CONDITIONS_EXCEEDED',
  /** Lookup `where` must have at least one condition (SPEC §5.8). */
  'EMPTY_FILTER',
] as const;

export type FilterIssueCode = (typeof FILTER_ISSUE_CODES)[number];

/** Top-level problem code every filter issue is reported under (CONTRACTS §6). */
export const FILTER_ERROR_CODE = 'INVALID_FILTER';

/** Same shape as `ProblemErrorItem` of `@cellhive/contracts`. */
export interface FilterIssue {
  path: string;
  code: FilterIssueCode;
  /** English; UIs translate by `code` + `params`. */
  message: string;
  params?: Record<string, unknown>;
}

export function joinPath(base: string, key: string | number): string {
  if (typeof key === 'number') return `${base}[${String(key)}]`;
  return base === '' ? key : `${base}.${key}`;
}
