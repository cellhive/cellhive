import {
  parseComputedStyle,
  type ComputedResultType,
  type ComputedStyle,
} from '@cellhive/field-types';

import type { ComputeErrorDto, FieldDto } from '@cellhive/contracts';

/**
 * Computed columns — `formula` and `lookup` (T468, SPEC §5.8, §9.4, CONTRACTS
 * §2, §13): what the grid, the record panel, the card list and the share
 * page need to show their cells. Glide-free (the DOM display uses it too).
 *
 * Cells are always read-only. What a cell shows, in order:
 * - `locked` (the reader cannot read what the value is computed from, P34–P36):
 *   a lock, never a value;
 * - a field-level error (`compute_error`): a grey token per code — the API
 *   reads `null`, the client draws the token (BACKLOG S4b additional
 *   decision #1); copy and export stay empty;
 * - `backfilling` and no value yet (a new field): a dim "…";
 * - otherwise the value by `result_type` and `style` — dimmed while the
 *   field is `recomputing` (old values kept until the job caught up,
 *   decision #6).
 */

export type ComputeErrorCode = ComputeErrorDto['code'];

/** Token drawn in the cells of a field in error (decision #1: `INVALID_CONFIG` reads `#VALUE!`). */
export const COMPUTE_ERROR_TOKENS: Readonly<Record<ComputeErrorCode, string>> = {
  REF: '#REF!',
  CIRCLE: '#CIRCLE!',
  TIMEOUT: '#TIMEOUT!',
  INVALID_CONFIG: '#VALUE!',
};

export type ComputeStateName = NonNullable<FieldDto['compute_state']>;

/** The computed side of a column (`undefined` for other fields). */
export interface ComputedColumn {
  readonly type: 'formula' | 'lookup';
  /** `null` when the API did not say: values show as plain text. */
  readonly resultType: ComputedResultType | null;
  readonly style: ComputedStyle | null;
  readonly state: ComputeStateName;
  /** Share links give the code only (`refs` empty, CONTRACTS §16A). */
  readonly error: {
    readonly code: ComputeErrorCode;
    readonly refs: ComputeErrorDto['refs'];
  } | null;
  readonly locked: boolean;
  /** The formula as written (names), only for readers with schema rights (CONTRACTS §13). */
  readonly expression: string | null;
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const RESULT_KINDS = new Set([
  'text',
  'number',
  'boolean',
  'date',
  'datetime',
  'user',
  'attachment',
  'record',
  'null',
]);

function resultTypeOf(value: unknown): ComputedResultType | null {
  if (!isObject(value)) return null;
  const kind = value['kind'];
  if (typeof kind !== 'string' || !RESULT_KINDS.has(kind)) return null;
  return { kind: kind as ComputedResultType['kind'], list: value['list'] === true };
}

const ERROR_CODES = new Set<string>(Object.keys(COMPUTE_ERROR_TOKENS));

function errorOf(value: unknown): ComputedColumn['error'] {
  if (!isObject(value)) return null;
  const code = value['code'];
  if (typeof code !== 'string' || !ERROR_CODES.has(code)) return null;
  const refs = Array.isArray(value['refs']) ? (value['refs'] as ComputeErrorDto['refs']) : [];
  return { code: code as ComputeErrorCode, refs };
}

const STATES = new Set(['ready', 'backfilling', 'recomputing', 'error']);

/**
 * The computed side of a field, or `undefined` when it is not a formula or
 * lookup. `result_type` and `compute_error` are read from the field (share
 * links give them on the shared field too, CONTRACTS §16A).
 */
export function computedColumnOf(field: FieldDto): ComputedColumn | undefined {
  if (field.type !== 'formula' && field.type !== 'lookup') return undefined;
  const options: Readonly<Record<string, unknown>> = isObject(field.options) ? field.options : {};
  const resultType = resultTypeOf(field.result_type);
  const parsedStyle =
    resultType === null ? null : parseComputedStyle(options['style'] ?? null, resultType);
  const error = errorOf(field.compute_error);
  const rawState: unknown = field.compute_state;
  const state: ComputeStateName =
    typeof rawState === 'string' && STATES.has(rawState)
      ? (rawState as ComputeStateName)
      : error === null
        ? 'ready'
        : 'error';
  const expression = options['expression'];
  return {
    type: field.type,
    resultType,
    style: parsedStyle?.ok === true ? parsedStyle.style : null,
    state,
    error,
    locked: field.locked === true,
    expression: field.type === 'formula' && typeof expression === 'string' ? expression : null,
  };
}

/** What a computed cell shows besides its value (see the module comment). */
export type ComputedCellShape =
  | { readonly kind: 'locked' }
  | { readonly kind: 'error'; readonly token: string }
  | { readonly kind: 'pending' }
  | { readonly kind: 'value'; readonly dim: boolean };

function isEmptyValue(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

export function computedCellShape(computed: ComputedColumn, value: unknown): ComputedCellShape {
  if (computed.locked) return { kind: 'locked' };
  if (computed.error !== null)
    return { kind: 'error', token: COMPUTE_ERROR_TOKENS[computed.error.code] };
  if (computed.state === 'backfilling' && isEmptyValue(value)) return { kind: 'pending' };
  return {
    kind: 'value',
    dim: computed.state === 'recomputing' || computed.state === 'backfilling',
  };
}

/** The field computes in the background (`computed.recomputing` progress on the header). */
export function isComputing(computed: ComputedColumn | undefined): boolean {
  return (
    computed !== undefined &&
    computed.error === null &&
    (computed.state === 'backfilling' || computed.state === 'recomputing')
  );
}

/** Schemes a `HYPERLINK` label may link to (BACKLOG S4b additional decision #9). */
const HYPERLINK_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/**
 * A text value of `HYPERLINK(url, label)`: `[label](url)` (SPEC §9.3). The
 * label shows; it links only for http/https/mailto (`href` is `null`
 * otherwise: plain text). `null` when the text is not of that form.
 */
export function hyperlinkOf(
  text: string,
): { readonly label: string; readonly href: string | null } | null {
  if (!text.startsWith('[') || !text.endsWith(')')) return null;
  const split = text.lastIndexOf('](');
  if (split < 1) return null;
  const label = text.slice(1, split);
  const url = text.slice(split + 2, -1).trim();
  if (label === '' || url === '') return null;
  let href: string | null;
  try {
    const parsed = new URL(url);
    href = HYPERLINK_SCHEMES.has(parsed.protocol) ? parsed.href : null;
  } catch {
    href = null;
  }
  return { label, href };
}

/**
 * The filter/sort meta type of a computed result (as the server reads it,
 * `computedFilterResultOf`): text, number, checkbox (boolean), datetime,
 * user, link (record), attachment.
 */
export function filterTypeOfResult(
  resultType: ComputedResultType,
): 'text' | 'number' | 'checkbox' | 'datetime' | 'user' | 'link' | 'attachment' | null {
  switch (resultType.kind) {
    case 'text':
      return 'text';
    case 'number':
      return 'number';
    case 'boolean':
      return 'checkbox';
    case 'date':
    case 'datetime':
      return 'datetime';
    case 'user':
      return 'user';
    case 'record':
      return 'link';
    case 'attachment':
      return 'attachment';
    default:
      return null;
  }
}
