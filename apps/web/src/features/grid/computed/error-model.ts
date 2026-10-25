import { COMPUTE_ERROR_TOKENS, type ComputedColumn } from '../../../grid/display/computed';

import type { FieldDto } from '@cellhive/contracts';

/**
 * What the error popover of a computed column says and offers (T468,
 * CONTRACTS §13 "Lỗi cấp field", board "S4b · Cột tính toán: lỗi và tính
 * lại"). Pure: the field lists come from the caller.
 */

export type ErrorVariant =
  /** REF: named fields/tables in the trash (with `deletedAt` when this table's trash says). */
  | 'deleted'
  /** REF: a computed field it reads is itself in error. */
  | 'indirect'
  /** REF: what is missing is not visible to the reader. */
  | 'hidden'
  | 'circle'
  | 'timeout'
  | 'config'
  /** INVALID_CONFIG without a visible converted field. */
  | 'configHidden';

export interface ComputedErrorDetails {
  readonly token: string;
  readonly code: NonNullable<ComputedColumn['error']>['code'];
  readonly variant: ErrorVariant;
  /** Names of the visible objects the error is about, in order. */
  readonly names: readonly string[];
  /** When the (single) field named was deleted, from this table's trash. */
  readonly deletedAt: string | null;
  /** Fields of this table's trash that restoring clears the error (schema managers). */
  readonly restorable: readonly { readonly id: string; readonly name: string }[];
  /** `TIMEOUT` and the definition is known: "Retry" saves it again unchanged. */
  readonly retry: boolean;
}

/**
 * `options` a PATCH sends to save the definition again unchanged ("Retry"
 * of `TIMEOUT`, CONTRACTS §13: saving the field again, even unchanged,
 * clears it); `null` when the reader was not given the definition.
 */
export function retryOptionsOf(field: FieldDto): Record<string, unknown> | null {
  const options = field.options;
  if (field.type === 'formula') {
    return typeof options['expression'] === 'string' ? { expression: options['expression'] } : null;
  }
  if (field.type === 'lookup') {
    if (typeof options['from'] !== 'string' || typeof options['select'] !== 'string') return null;
    const kept: Record<string, unknown> = {};
    for (const key of ['from', 'select', 'where', 'aggregate'] as const) {
      if (options[key] !== undefined) kept[key] = options[key];
    }
    return kept;
  }
  return null;
}

export function computedErrorDetails(
  field: FieldDto,
  computed: ComputedColumn,
  /** Live fields of the table (the list the grid shows). */
  tableFields: readonly FieldDto[],
  /** Live + deleted fields of the table (`include_deleted`), schema managers only. */
  withTrash: readonly FieldDto[] | undefined,
): ComputedErrorDetails | null {
  const error = computed.error;
  if (error === null) return null;
  const refs = error.refs;
  const visible = refs.filter(
    (ref): ref is typeof ref & { id: string; name: string } => ref.id !== null && ref.name !== null,
  );
  const names = visible.map((ref) => ref.name);
  const base = {
    token: COMPUTE_ERROR_TOKENS[error.code],
    code: error.code,
    names,
    deletedAt: null,
    restorable: [],
    retry: false,
  } satisfies Omit<ComputedErrorDetails, 'variant'>;
  switch (error.code) {
    case 'REF': {
      if (visible.length === 0) return { ...base, variant: 'hidden' };
      const live = new Map<string, FieldDto>(tableFields.map((item) => [item.id, item]));
      const indirect = visible.every((ref) => live.get(ref.id)?.compute_error != null);
      if (indirect) return { ...base, variant: 'indirect' };
      const trashed = (withTrash ?? []).filter(
        (item) => item.deleted_at !== undefined && visible.some((ref) => ref.id === item.id),
      );
      const deletedAt = trashed.length === 1 ? (trashed[0]?.deleted_at ?? null) : null;
      return {
        ...base,
        variant: 'deleted',
        deletedAt,
        restorable: trashed.map((item) => ({ id: item.id, name: item.name })),
      };
    }
    case 'CIRCLE':
      return { ...base, variant: 'circle', names: names.length > 0 ? names : [field.name] };
    case 'TIMEOUT':
      return { ...base, variant: 'timeout', retry: retryOptionsOf(field) !== null };
    case 'INVALID_CONFIG':
      return { ...base, variant: visible.length === 0 ? 'configHidden' : 'config' };
  }
}
