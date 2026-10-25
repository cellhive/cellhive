import { FIELD_TYPE_REGISTRY } from '../registry.js';

import type { S1FieldType } from '../core.js';

/**
 * Field type conversion (SPEC §5.5, CONTRACTS §4): which kind of change a
 * `{ type, options }` → `{ type, options }` pair is. Pure: preview and the
 * backfill job decide with the same function.
 */

/** A field definition with its options already parsed by the type's schema. */
export interface FieldDefinitionRef {
  readonly type: S1FieldType;
  readonly options: unknown;
}

/** Conversion settings of CONTRACTS §4.1 / §4.3 (`conversion` of the request). */
export interface ConversionSettings {
  /** select ← text/number: only keep values naming an existing option (like Lark). */
  readonly match_existing_only?: boolean;
  /** checkbox ← text/select: values read as checked (trimmed, case-insensitive). */
  readonly truthy_values?: readonly string[];
  /** user ← text: values are emails of members. */
  readonly match_email?: boolean;
}

/**
 * - `none`: no data changes (options/style only, or a single-value list
 *   becoming multiple): applied like a `PATCH`, no job, no column slot;
 * - `keep`: CONTRACTS §4.1, values are converted; unconvertible ones become
 *   empty (`lost`);
 * - `truncate`: CONTRACTS §4.2, needs `confirm`;
 * - `blacklist`: CONTRACTS §4.3, only for an empty column or with
 *   `accept_data_loss` (every value is dropped);
 * - `forbidden`: never (target without a column of its own, types not
 *   available yet).
 */
export type ConversionKind = 'none' | 'keep' | 'truncate' | 'blacklist' | 'forbidden';

/** Types a field can be converted to (those that store their own values). */
export const CONVERTIBLE_TARGET_TYPES = [
  'text',
  'number',
  'select',
  'datetime',
  'checkbox',
  'user',
] as const satisfies readonly S1FieldType[];

export type ConvertibleTargetType = (typeof CONVERTIBLE_TARGET_TYPES)[number];

/**
 * The type whose rules apply to a source (CONTRACTS §4.1: computed and
 * system types convert as their result type): `auto_number` → `text`,
 * `created_at`/`updated_at` → `datetime`, `created_by`/`updated_by` →
 * `user`.
 */
export type SourceKind = 'text' | 'number' | 'select' | 'datetime' | 'checkbox' | 'user';

export function sourceKindOf(type: S1FieldType): SourceKind {
  switch (type) {
    case 'auto_number':
      return 'text';
    case 'created_at':
    case 'updated_at':
      return 'datetime';
    case 'created_by':
    case 'updated_by':
      return 'user';
    default:
      return type;
  }
}

export function isConvertibleTarget(type: S1FieldType): type is ConvertibleTargetType {
  return (CONVERTIBLE_TARGET_TYPES as readonly string[]).includes(type);
}

/** Collation only matters for the text of the SQL type, never for the comparison. */
const PG_CONTEXT = { collation: 'und-x-icu' } as const;

/** SQL column type of a definition (`null` for types reading a system column). */
export function columnTypeOf(definition: FieldDefinitionRef): string | null {
  return FIELD_TYPE_REGISTRY[definition.type].pgType(definition.options as never, PG_CONTEXT);
}

function isMultiple(definition: FieldDefinitionRef): boolean {
  return (definition.options as { readonly multiple?: unknown }).multiple === true;
}

function hasTruthyValues(settings: ConversionSettings): boolean {
  return (settings.truthy_values ?? []).some((value) => value.trim() !== '');
}

/**
 * The kind of a conversion (CONTRACTS §4.1–§4.3). Same type:
 * - column type changes (datetime `date` ↔ `timestamptz`) → `keep`;
 * - select/user `multiple` true → false → `truncate`;
 * - anything else (style, options, `multiple` false → true) → `none`.
 * Another type: the whitelist of §4.1 → `keep`, targets without a column
 * of their own → `forbidden`, everything else → `blacklist`.
 */
export function classifyConversion(
  from: FieldDefinitionRef,
  to: FieldDefinitionRef,
  settings: ConversionSettings = {},
): ConversionKind {
  if (from.type === to.type) {
    if (columnTypeOf(from) !== columnTypeOf(to)) return 'keep';
    if ((to.type === 'select' || to.type === 'user') && isMultiple(from) && !isMultiple(to)) {
      return 'truncate';
    }
    return 'none';
  }
  if (!isConvertibleTarget(to.type)) return 'forbidden';
  const source = sourceKindOf(from.type);
  switch (to.type) {
    case 'text':
      return 'keep';
    case 'number':
      return source === 'text' || source === 'datetime' || source === 'checkbox'
        ? 'keep'
        : 'blacklist';
    case 'datetime':
      return source === 'text' || source === 'number' || source === 'datetime'
        ? 'keep'
        : 'blacklist';
    case 'select':
      return source === 'text' || source === 'number' ? 'keep' : 'blacklist';
    case 'checkbox':
      return (source === 'text' || source === 'select') && hasTruthyValues(settings)
        ? 'keep'
        : 'blacklist';
    case 'user':
      if (source === 'user') return isMultiple(to) || !isMultiple(from) ? 'keep' : 'truncate';
      return source === 'text' && settings.match_email === true ? 'keep' : 'blacklist';
  }
}
