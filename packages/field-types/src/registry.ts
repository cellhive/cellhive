import { z } from 'zod';

import {
  FIELD_TYPES,
  IMPLEMENTED_FIELD_TYPES,
  S1_FIELD_TYPES,
  type AnyFieldTypeDefinition,
  type FieldType,
  type ImplementedFieldType,
  type S1FieldType,
} from './core.js';
import { isoDateInZone } from './internal/dates.js';
import { attachmentFieldType, attachmentOptionsSchema } from './types/attachment.js';
import { autoNumberFieldType, autoNumberOptionsSchema } from './types/auto-number.js';
import { checkboxFieldType, checkboxOptionsSchema } from './types/checkbox.js';
import {
  datetimeFieldType,
  datetimeOptionsSchema,
  fieldTimeZone,
  isDateOnlyFormat,
} from './types/datetime.js';
import { formulaFieldType } from './types/formula.js';
import { linkFieldType } from './types/link.js';
import { lookupFieldType } from './types/lookup.js';
import { numberFieldType, numberOptionsSchema } from './types/number.js';
import { parentFieldType } from './types/parent.js';
import { selectFieldType, selectOptionsSchema } from './types/select.js';
import {
  createdAtFieldType,
  createdByFieldType,
  systemTimeOptionsSchema,
  systemUserOptionsSchema,
  updatedAtFieldType,
  updatedByFieldType,
} from './types/system.js';
import { textFieldType, textOptionsSchema } from './types/text.js';
import { userFieldType, userOptionsSchema } from './types/user.js';

/** Every implemented field type, keyed by name. */
export const FIELD_TYPE_REGISTRY = {
  text: textFieldType,
  number: numberFieldType,
  select: selectFieldType,
  datetime: datetimeFieldType,
  checkbox: checkboxFieldType,
  user: userFieldType,
  created_at: createdAtFieldType,
  updated_at: updatedAtFieldType,
  created_by: createdByFieldType,
  updated_by: updatedByFieldType,
  auto_number: autoNumberFieldType,
  attachment: attachmentFieldType,
} as const satisfies Record<ImplementedFieldType, AnyFieldTypeDefinition>;

/**
 * Types whose values are records of a table (the junction of a link, the
 * `__parent_id` column of a sub-record table; S4): their definitions hold
 * the pure parts, the server reads and writes the values (titles, cycles).
 * Not in `FIELD_TYPE_REGISTRY`, whose types map to a column value one to
 * one.
 */
export const RELATION_FIELD_TYPES = { link: linkFieldType, parent: parentFieldType } as const;

/**
 * Computed types (S4b, BACKLOG T456): values computed by the server, never
 * written by clients; their definitions hold the option schemas and the
 * `cell_format=text` rendering. Not in `FIELD_TYPE_REGISTRY` either.
 */
export const COMPUTED_FIELD_TYPES = { formula: formulaFieldType, lookup: lookupFieldType } as const;
export type ComputedFieldType = keyof typeof COMPUTED_FIELD_TYPES;

export function isComputedFieldType(value: unknown): value is ComputedFieldType {
  return value === 'formula' || value === 'lookup';
}

export const fieldTypeSchema = z.enum(FIELD_TYPES);

export function isS1FieldType(value: unknown): value is S1FieldType {
  return typeof value === 'string' && (S1_FIELD_TYPES as readonly string[]).includes(value);
}

/** Types with a definition: S1 plus the S4 types implemented so far (`attachment`). */
export function isImplementedFieldType(value: unknown): value is ImplementedFieldType {
  return (
    typeof value === 'string' && (IMPLEMENTED_FIELD_TYPES as readonly string[]).includes(value)
  );
}

/** The definition of an implemented type; `undefined` for names still reserved. */
export function getFieldType(type: FieldType): AnyFieldTypeDefinition | undefined {
  return isImplementedFieldType(type) ? FIELD_TYPE_REGISTRY[type] : undefined;
}

const config = <T extends ImplementedFieldType, S extends z.ZodType>(type: T, options: S) =>
  // `prefault` parses the fallback, so omitted options get each schema's own defaults.
  z.strictObject({ type: z.literal(type), options: options.prefault({} as z.input<S>) });

/**
 * `{ type, options }` of a field, options defaulted and validated for the type
 * (the body of field create/update in T103).
 */
export const fieldConfigSchema = z.discriminatedUnion('type', [
  config('text', textOptionsSchema),
  config('number', numberOptionsSchema),
  config('select', selectOptionsSchema),
  config('datetime', datetimeOptionsSchema),
  config('checkbox', checkboxOptionsSchema),
  config('user', userOptionsSchema),
  config('created_at', systemTimeOptionsSchema),
  config('updated_at', systemTimeOptionsSchema),
  config('created_by', systemUserOptionsSchema),
  config('updated_by', systemUserOptionsSchema),
  config('auto_number', autoNumberOptionsSchema),
  config('attachment', attachmentOptionsSchema),
]);

export type FieldConfig = z.output<typeof fieldConfigSchema>;
/** The config of an S1 type (clients that handle only those, e.g. the grid until T418). */
export type S1FieldConfig = Extract<FieldConfig, { type: S1FieldType }>;

export interface DefaultValueContext {
  /** Creation time of the record being inserted. */
  readonly now: Date;
  /** Acting user, `null` for system/automation writes. */
  readonly userId: string | null;
  /** Org/user zone, used when the field has no `timezone`. */
  readonly timeZone: string;
}

/**
 * The json write value to use for a field the create request left out, with
 * `$slot` placeholders resolved; `undefined` when the field has no default.
 */
export function resolveDefaultValue(field: FieldConfig, ctx: DefaultValueContext): unknown {
  switch (field.type) {
    case 'text':
    case 'number':
    case 'select':
      return field.options.default_value ?? undefined;
    case 'datetime': {
      const fallback = field.options.default_value;
      if (fallback === null || fallback === undefined) return undefined;
      if (typeof fallback === 'string') return fallback;
      return isDateOnlyFormat(field.options.style.format)
        ? isoDateInZone(ctx.now.getTime(), fieldTimeZone(field.options, ctx))
        : ctx.now.toISOString();
    }
    case 'user': {
      const users = (field.options.default_value ?? []).flatMap((entry) => {
        if ('id' in entry) return [{ id: entry.id }];
        return ctx.userId === null ? [] : [{ id: ctx.userId }];
      });
      const distinct = [...new Map(users.map((user) => [user.id, user])).values()];
      return distinct.length === 0 ? undefined : distinct;
    }
    default:
      return undefined;
  }
}
