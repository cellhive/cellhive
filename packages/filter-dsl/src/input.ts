import { type FilterTableMeta } from './field-meta.js';
import { type FilterIssue } from './issues.js';
import { normalizeTuple } from './tuple.js';
import {
  validateFilter,
  type ValidateFilterOptions,
  type ValidateFilterResult,
} from './validate.js';

export interface ParseFilterInputOptions extends ValidateFilterOptions {
  /** How the tuple form names fields; the DSL form always uses field ids. */
  readonly fieldKeyType: 'name' | 'id';
}

/** True when `input` looks like the tuple form (CONTRACTS §3) rather than the DSL. */
export function isTupleFilter(input: unknown): boolean {
  return (
    typeof input === 'object' &&
    input !== null &&
    !Array.isArray(input) &&
    ('conditions' in input || 'logic' in input)
  );
}

const DSL_PATH =
  /^items\[(\d+)\](?:\.item)?(?:\.items\[(\d+)\])?(?:\.(field|operator|value)(.*))?$/;
const TUPLE_SLOT = { field: 0, operator: 1, value: 2 } as const;

/**
 * Maps a path in the DSL built by `normalizeTuple` back to the tuple:
 * `items[3].item.value` → `conditions[3][2]`; a text `intersects` spread
 * into a group maps `items[3].items[1].value` → `conditions[3][2][1]`.
 */
export function tuplePathOf(dslPath: string): string {
  const match = DSL_PATH.exec(dslPath);
  if (match === null) return dslPath;
  const [, index = '', spreadIndex, slot, rest = ''] = match;
  const base = `conditions[${index}]`;
  if (slot === undefined) return base;
  const slotIndex = TUPLE_SLOT[slot as keyof typeof TUPLE_SLOT];
  if (spreadIndex !== undefined && slot === 'value') {
    return `${base}[${String(slotIndex)}][${spreadIndex}]${rest}`;
  }
  return `${base}[${String(slotIndex)}]${rest}`;
}

/**
 * Accepts a filter as sent to the API — DSL object or tuple form — and
 * returns the validated, normalised DSL. Tuple input is normalised with the
 * caller's visible fields and validation issues are reported with tuple
 * paths, so the client sees paths in what it sent.
 */
export function parseFilterInput(
  input: unknown,
  tableMeta: FilterTableMeta,
  visibleFieldIds: Iterable<string>,
  options: ParseFilterInputOptions,
): ValidateFilterResult {
  if (!isTupleFilter(input)) return validateFilter(input, tableMeta, visibleFieldIds, options);
  const visible = [...visibleFieldIds];
  const normalized = normalizeTuple(input, tableMeta, {
    fieldKeyType: options.fieldKeyType,
    visibleFieldIds: visible,
  });
  if (!normalized.ok) return normalized;
  const result = validateFilter(normalized.ast, tableMeta, visible, options);
  if (result.ok) return result;
  return {
    ok: false,
    errors: result.errors.map((issue): FilterIssue => ({
      ...issue,
      path: tuplePathOf(issue.path),
    })),
  };
}
