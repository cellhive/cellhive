import { z } from 'zod';

import { formatWallTime, storedInstant } from '../internal/dates.js';
import { readOnlyWrites } from '../internal/results.js';
import { DATETIME_OPERATORS, MULTI_VALUE_OPERATORS } from '../operators.js';
import { toWallTime } from '../time-zone.js';

import { DATETIME_FORMATS, fieldTimeZone, timeZoneSchema } from './datetime.js';
import { userDisplayName, userRefOf } from './user.js';

import type { FieldTypeDefinition, S1FieldType, SystemColumn, UserRef } from '../core.js';

/** Options of `created_at` / `updated_at`: display format and zone only. */
export const systemTimeOptionsSchema = z.strictObject({
  style: z
    .strictObject({ format: z.enum(DATETIME_FORMATS).default('yyyy-MM-dd HH:mm') })
    .default({ format: 'yyyy-MM-dd HH:mm' }),
  timezone: timeZoneSchema.optional(),
});

/** `created_by` / `updated_by` have no options. */
export const systemUserOptionsSchema = z.strictObject({});

export type SystemTimeOptions = z.output<typeof systemTimeOptionsSchema>;
export type SystemUserOptions = z.output<typeof systemUserOptionsSchema>;

function systemTime(
  type: Extract<S1FieldType, 'created_at' | 'updated_at'>,
  column: SystemColumn,
): FieldTypeDefinition<SystemTimeOptions, never, never, string | null> {
  return {
    ...readOnlyWrites,
    type,
    systemColumn: column,
    optionsSchema: systemTimeOptionsSchema,
    pgType: () => null,
    fromStorage(stored) {
      const epochMs = storedInstant(stored);
      return epochMs === null ? null : new Date(epochMs).toISOString();
    },
    formatText(value, options, ctx) {
      const epochMs = value === null ? null : storedInstant(value);
      if (epochMs === null) return '';
      return formatWallTime(toWallTime(epochMs, fieldTimeZone(options, ctx)), options.style.format);
    },
    filterOperators: () => DATETIME_OPERATORS,
  };
}

function systemUser(
  type: Extract<S1FieldType, 'created_by' | 'updated_by'>,
  column: SystemColumn,
): FieldTypeDefinition<SystemUserOptions, never, never, UserRef | null> {
  return {
    ...readOnlyWrites,
    type,
    systemColumn: column,
    optionsSchema: systemUserOptionsSchema,
    pgType: () => null,
    fromStorage: (stored, _options, ctx) =>
      typeof stored === 'string' ? userRefOf(stored, ctx) : null,
    formatText: (value) => (value === null ? '' : userDisplayName(value)),
    filterOperators: () => MULTI_VALUE_OPERATORS,
  };
}

/** SPEC §5.5: point at `__created_at` / `__updated_at`; read-only. */
export const createdAtFieldType = systemTime('created_at', '__created_at');
export const updatedAtFieldType = systemTime('updated_at', '__updated_at');
/** SPEC §5.5: point at `__created_by` / `__updated_by`; `null` = system/automation. */
export const createdByFieldType = systemUser('created_by', '__created_by');
export const updatedByFieldType = systemUser('updated_by', '__updated_by');
