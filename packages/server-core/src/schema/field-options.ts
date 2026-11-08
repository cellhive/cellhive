import { isId, newId, UNKNOWN_OPTION, type ProblemErrorItem } from '@cellhive/contracts';

import { AppError } from '../errors/app-error.js';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionIdsOf(options: unknown): Set<string> {
  const list = isRecord(options) && Array.isArray(options.options) ? options.options : [];
  return new Set(
    list.flatMap((item: unknown) =>
      isRecord(item) && typeof item.id === 'string' ? [item.id] : [],
    ),
  );
}

/**
 * Options of a new field as sent by the client, with a fresh `opt_…` id for
 * every select option given without one. Everything else is validated by
 * the type's schema in `SchemaService`.
 */
export function withNewOptionIds(type: string, options: JsonRecord | undefined): unknown {
  if (type !== 'select' || options === undefined || !Array.isArray(options.options)) {
    return options;
  }
  return {
    ...options,
    options: options.options.map((item: unknown) =>
      isRecord(item) && item.id === undefined ? { ...item, id: newId('opt') } : item,
    ),
  };
}

/**
 * The full options of a field PATCH (SPEC §5.5), computed by
 * `SchemaService.updateField` under the table's schema lock from the
 * current (locked) options: top-level keys of `patch` replace the current
 * ones. For a select field whose `options` list is given:
 *
 * - an item with an `id` keeps it (rename, recolour, reorder); an id the
 *   field does not have is `422 VALIDATION_FAILED` (`UNKNOWN_OPTION`), so a
 *   client cannot invent or reuse ids;
 * - an item without `id` is a new option and gets one;
 * - options missing from the list are deleted (`SchemaService` queues the
 *   job that removes them from records) and dropped from `default_value`
 *   unless the patch sets `default_value` itself;
 * - with `base` (the options the caller read before sending the patch),
 *   options added to the field since then by a concurrent change are not
 *   the caller's to delete: they are kept, after the listed ones.
 *
 * With `keepUnlisted` (MCP `update_field`, CONTRACTS §30.7, Quyết định S9
 * #36) the list is an upsert instead: see {@link upsertSelectOptions}.
 */
export function mergeFieldOptions(
  type: string,
  current: unknown,
  patch: Readonly<JsonRecord>,
  base?: unknown,
  mode: { readonly keepUnlisted?: boolean } = {},
): JsonRecord {
  const locked = isRecord(current) ? current : {};
  const merged: JsonRecord = { ...locked, ...patch };
  if (type !== 'select' || !Array.isArray(patch.options)) return merged;
  if (mode.keepUnlisted === true) {
    merged.options = upsertSelectOptions(locked.options, patch.options as unknown[]);
    return merged;
  }

  const existing = optionIdsOf(locked);
  const errors: ProblemErrorItem[] = [];
  const listed: unknown[] = (patch.options as unknown[]).map((item: unknown, index: number) => {
    if (!isRecord(item) || item.id === undefined) {
      return isRecord(item) ? { ...item, id: newId('opt') } : item;
    }
    if (typeof item.id !== 'string' || !existing.has(item.id)) {
      errors.push({
        path: `options.options[${String(index)}].id`,
        code: UNKNOWN_OPTION,
        message: 'The field has no option with this id; leave `id` out to add an option',
      });
    }
    return item;
  });
  if (errors.length > 0) {
    throw new AppError('VALIDATION_FAILED', {
      detail: 'Select options can only keep ids the field already has.',
      errors,
    });
  }
  const listedIds = optionIdsOf({ options: listed });
  const known = base === undefined ? undefined : optionIdsOf(base);
  const concurrent =
    known === undefined || !Array.isArray(locked.options)
      ? []
      : (locked.options as unknown[]).filter(
          (item: unknown) =>
            isRecord(item) &&
            typeof item.id === 'string' &&
            !known.has(item.id) &&
            !listedIds.has(item.id),
        );
  const options = [...listed, ...concurrent];
  merged.options = options;

  if (!('default_value' in patch)) {
    const kept = optionIdsOf({ options });
    const fallback = locked.default_value;
    if (Array.isArray(fallback)) {
      merged.default_value = fallback.filter(
        (id: unknown) => typeof id === 'string' && kept.has(id),
      );
    } else if (isId('opt', fallback) && !kept.has(fallback)) {
      merged.default_value = null;
    }
  }
  return merged;
}

/**
 * The select options of a patch that never deletes one (MCP `update_field`,
 * CONTRACTS §30.7), computed from the options read under the table's schema
 * lock, so that an option added by a concurrent change is never lost:
 *
 * - every current option stays, in its current order;
 * - an item with an `id` updates that option in place (an id the field does
 *   not have is `UNKNOWN_OPTION`, as without the mode);
 * - an item without `id` whose `name` is a current option's updates it in
 *   place (its colour), keeping its id;
 * - any other item is a new option with a fresh id, added at the end.
 *
 * No option is ever removed, so `default_value` needs no clean-up and no
 * job removes values from the records.
 */
export function upsertSelectOptions(current: unknown, items: readonly unknown[]): unknown[] {
  const options: unknown[] = Array.isArray(current) ? [...(current as unknown[])] : [];
  const indexOf = (match: (option: JsonRecord) => boolean) =>
    options.findIndex((option) => isRecord(option) && match(option));
  const errors: ProblemErrorItem[] = [];
  items.forEach((item, position) => {
    if (!isRecord(item)) {
      options.push(item);
      return;
    }
    if (item.id !== undefined) {
      const at = indexOf((option) => option.id === item.id);
      if (at === -1) {
        errors.push({
          path: `options.options[${String(position)}].id`,
          code: UNKNOWN_OPTION,
          message: 'The field has no option with this id; leave `id` out to add an option',
        });
        return;
      }
      options[at] = { ...(options[at] as JsonRecord), ...item };
      return;
    }
    const at = indexOf((option) => option.name === item.name);
    if (at === -1) {
      options.push({ ...item, id: newId('opt') });
      return;
    }
    options[at] = { ...(options[at] as JsonRecord), ...item, id: (options[at] as JsonRecord).id };
  });
  if (errors.length > 0) {
    throw new AppError('VALIDATION_FAILED', {
      detail: 'Select options can only keep ids the field already has.',
      errors,
    });
  }
  return options;
}
