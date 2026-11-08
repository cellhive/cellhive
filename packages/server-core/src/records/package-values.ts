import type { SelectOptions } from '@cellhive/field-types';

/**
 * Values of a `.chbase` package (ADR-24 amendment §1: cells in storage form
 * — option ids, user ids, `{ id, name, size, mime }` files) in the json write
 * shape of their field (CONTRACTS §2), so that the field type's own
 * `toStorage` checks them like any write: option ids, `{ id }` users and
 * files, the rest unchanged. Shared by the check of an import and by
 * `RecordMutationService.loadPackageBatch`.
 */
export function packageWriteValue(
  field: { readonly type: string; readonly options: unknown },
  stored: unknown,
): unknown {
  if (stored === null || stored === undefined) return null;
  switch (field.type) {
    case 'select': {
      if (!Array.isArray(stored)) return stored;
      if ((field.options as SelectOptions).multiple) return stored.length === 0 ? null : stored;
      return stored.length === 1 ? stored[0] : stored;
    }
    case 'user':
      return Array.isArray(stored)
        ? stored.map((id: unknown) => (typeof id === 'string' ? { id } : id))
        : stored;
    case 'attachment':
      return Array.isArray(stored)
        ? stored.map((entry: unknown) =>
            isPlainObject(entry) && typeof entry['id'] === 'string' ? { id: entry['id'] } : entry,
          )
        : stored;
    default:
      return stored;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
