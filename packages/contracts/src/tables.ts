import { z } from 'zod';

import { buttonFieldSummarySchema } from './buttons.js';
import { booleanQueryParam, isoDateTimeSchema } from './common.js';
import {
  COMPUTE_MODES,
  COMPUTE_STATES,
  computeErrorSchema,
  computedResultTypeSchema,
} from './computed-fields.js';
import { idOf } from './ids.js';
import { offsetListSchema, offsetQuerySchema } from './pagination.js';

/**
 * Tables and fields (SPEC §5.5, §13.1; BACKLOG T103). Field options are
 * validated per type by `@cellhive/field-types` (`fieldConfigSchema`), which
 * depends on this package; here they are an object whose shape the `type`
 * decides.
 */

/**
 * Field type names (SPEC §5.5): every type can be created (`link`: T401,
 * `parent`: T405, `attachment`: T406, `formula`/`lookup`: T456 — options in
 * `computed-fields.ts`; `button`: T517 — options in `buttons.ts`). Kept equal to `FIELD_TYPES` of
 * `@cellhive/field-types` (checked by its tests).
 */
export const FIELD_TYPE_NAMES = [
  'text',
  'number',
  'select',
  'datetime',
  'checkbox',
  'user',
  'created_at',
  'updated_at',
  'created_by',
  'updated_by',
  'auto_number',
  'link',
  'parent',
  'lookup',
  'formula',
  'attachment',
  'button',
] as const;

export const fieldTypeNameSchema = z
  .enum(FIELD_TYPE_NAMES)
  .meta({ id: 'FieldType', description: 'Field type (SPEC §5.5)' });
export type FieldTypeName = z.infer<typeof fieldTypeNameSchema>;

/** Longest table/field name, in characters after trimming. */
export const MAX_SCHEMA_NAME_LENGTH = 255;
/** Longest table/field description. */
export const MAX_SCHEMA_DESCRIPTION_LENGTH = 2000;

/** Detail code (`errors[].code` of `422 VALIDATION_FAILED`): the primary field cannot be deleted. */
export const PRIMARY_FIELD_NOT_DELETABLE = 'PRIMARY_FIELD_NOT_DELETABLE';
/** Detail code: a select option id of a PATCH does not belong to the field. */
export const UNKNOWN_OPTION = 'UNKNOWN_OPTION';

const schemaNameSchema = z.string().trim().min(1).max(MAX_SCHEMA_NAME_LENGTH);
const schemaDescriptionSchema = z.string().max(MAX_SCHEMA_DESCRIPTION_LENGTH);
const positionSchema = z.int().min(0).meta({
  description:
    'New 0-based index in the display order (clamped to the last index); the others shift',
});

function atLeastOneKey(value: object): boolean {
  return Object.values(value).some((item) => item !== undefined);
}

const AT_LEAST_ONE = { message: 'At least one property is required' } as const;

// --- Tables --------------------------------------------------------------------

export const tableSchema = z
  .object({
    id: idOf('tbl'),
    base_id: idOf('bse'),
    name: z.string(),
    description: z.string().nullable(),
    primary_field_id: idOf('fld'),
    position: z.int().min(0).meta({ description: 'Sort key of the display order' }),
    schema_state: z.enum(['ready', 'compacting']).meta({
      description: '`compacting`: schema changes answer `409 SCHEMA_LOCKED` meanwhile (ADR-20)',
    }),
    created_at: isoDateTimeSchema,
    updated_at: isoDateTimeSchema,
  })
  .meta({ id: 'Table' });
export type TableDto = z.infer<typeof tableSchema>;

export const tableListSchema = offsetListSchema(tableSchema).meta({ id: 'TableList' });
export type TableList = z.infer<typeof tableListSchema>;

export const createTableRequestSchema = z
  .strictObject({
    name: schemaNameSchema,
    description: schemaDescriptionSchema.nullable().optional(),
    primary_field_name: schemaNameSchema
      .optional()
      .meta({ description: 'Name of the primary `text` field (default `Name`)' }),
  })
  .meta({ id: 'CreateTableRequest' });
export type CreateTableRequest = z.infer<typeof createTableRequestSchema>;

/**
 * Days a table stays restorable in the trash (T461, ADR-23 §3, like fields):
 * after that the daily `tables.purge` job deletes it for good.
 */
export const TABLE_TRASH_RETENTION_DAYS = 30;

/** Detail code: `POST /tables/:id/purge` on a table that is not in the trash (T461). */
export const TABLE_NOT_IN_TRASH = 'TABLE_NOT_IN_TRASH';
/** Detail code: `confirm_name` of `POST /tables/:id/purge` is not the table name (T461). */
export const CONFIRM_NAME_MISMATCH = 'CONFIRM_NAME_MISMATCH';
/** Detail code: restoring a link field whose linked table was purged (T461, CONTRACTS §13). */
export const LINK_TABLE_PURGED = 'LINK_TABLE_PURGED';

/** `POST /tables/:tableId/purge` (T461, CONTRACTS §13). */
export const purgeTableRequestSchema = z
  .strictObject({
    confirm_name: z
      .string()
      .max(MAX_SCHEMA_NAME_LENGTH)
      .meta({
        description:
          'The table name, typed to confirm (compared exactly after trimming); another value ' +
          'answers `422 VALIDATION_FAILED` / `CONFIRM_NAME_MISMATCH`',
      }),
  })
  .meta({ id: 'PurgeTableRequest' });
export type PurgeTableRequest = z.infer<typeof purgeTableRequestSchema>;

export const purgedTableResponseSchema = z
  .strictObject({
    id: idOf('tbl'),
    name: z.string(),
    record_count: z.int().min(0).meta({
      description: 'Records deleted with the table (its trash included)',
    }),
    partner_field_ids: z.array(idOf('fld')).meta({
      description:
        'Link fields of other tables that pointed at the table: now in the trash and not ' +
        'restorable (`LINK_TABLE_PURGED`)',
    }),
  })
  .meta({ id: 'PurgedTable' });
export type PurgedTableResponse = z.infer<typeof purgedTableResponseSchema>;

/**
 * A link field of another table pointing at a trashed table (T469): purging
 * the table deletes it for good (`LINK_TABLE_PURGED`, CONTRACTS §13).
 */
export const trashedTablePartnerFieldSchema = z
  .strictObject({
    id: idOf('fld'),
    table_id: idOf('tbl'),
    name: z.string(),
    kind: z.enum(['one_way', 'two_way']).meta({
      description:
        '`one_way`: a link of that table to the trashed one; `two_way`: the other side of a ' +
        'two-way link',
    }),
    in_trash: z.boolean().meta({
      description: 'The field itself is in the trash of its table (restorable until the purge)',
    }),
  })
  .meta({ id: 'TrashedTablePartnerField' });
export type TrashedTablePartnerField = z.infer<typeof trashedTablePartnerFieldSchema>;

/** A formula/lookup field of another table in `REF` because of a trashed table (T469). */
export const trashedTableComputedFieldSchema = z
  .strictObject({
    id: idOf('fld'),
    table_id: idOf('tbl'),
    name: z.string(),
    type: z.enum(['formula', 'lookup']),
  })
  .meta({ id: 'TrashedTableComputedField' });
export type TrashedTableComputedField = z.infer<typeof trashedTableComputedFieldSchema>;

/**
 * A table of the base trash (`GET /bases/:baseId/tables/trash`, T469,
 * CONTRACTS §13): the table, when and by whom it was deleted, and what a
 * permanent delete would take with it.
 */
export const trashedTableSchema = tableSchema
  .extend({
    deleted_at: isoDateTimeSchema,
    purge_after: isoDateTimeSchema.meta({
      description: '`deleted_at` + 30 days: the daily `tables.purge` job deletes it then',
    }),
    deleted_by: z
      .strictObject({ id: z.string(), name: z.string().nullable() })
      .nullable()
      .meta({
        description:
          'The user who deleted it (`name = null` once the user is deleted); `null` for the ' +
          'system or when the audit entry is gone',
      }),
    field_count: z.int().min(0).meta({ description: 'Fields of the table (trash excluded)' }),
    partner_fields: z.array(trashedTablePartnerFieldSchema).meta({
      description:
        'Link fields of other tables pointing at the table (the trash of those tables ' +
        'included): a permanent delete deletes them for good',
    }),
    computed_fields: z.array(trashedTableComputedFieldSchema).meta({
      description:
        'Formula/lookup fields of other tables in `REF` because of the table (directly, ' +
        'through a partner link field or through another computed field): they stay `REF` ' +
        'after a permanent delete',
    }),
  })
  .meta({ id: 'TrashedTable' });
export type TrashedTableDto = z.infer<typeof trashedTableSchema>;

export const trashedTableListSchema = z
  .strictObject({ items: z.array(trashedTableSchema) })
  .meta({ id: 'TrashedTableList' });
export type TrashedTableList = z.infer<typeof trashedTableListSchema>;

export const updateTableRequestSchema = z
  .strictObject({
    name: schemaNameSchema.optional(),
    description: schemaDescriptionSchema.nullable().optional(),
    position: positionSchema.optional(),
  })
  .refine(atLeastOneKey, AT_LEAST_ONE)
  .meta({ id: 'UpdateTableRequest' });
export type UpdateTableRequest = z.infer<typeof updateTableRequestSchema>;

// --- Fields --------------------------------------------------------------------

export const fieldOptionsSchema = z.record(z.string(), z.unknown()).meta({
  id: 'FieldOptions',
  description:
    'Options of the field type (SPEC §5.5), e.g. `style`, `default_value`; for `select`: ' +
    '`multiple` and `options` (`[{ id, name, color }]`). Validated per type (CONTRACTS §13); ' +
    'the options of `link`, `parent`, `formula` and `lookup` are described by the components ' +
    '`LinkFieldOptions`, `ParentFieldOptions`, `FormulaFieldOptions` and `LookupFieldOptions`; ' +
    'the `reminder` of a `datetime` field by `DateReminderOption`.',
});
export type FieldOptions = z.infer<typeof fieldOptionsSchema>;

/**
 * The type conversion of a field that is running or can still be reverted
 * (T403, CONTRACTS §4.4, §13). Given by the field endpoints (`null`: none).
 */
export const fieldConversionStateSchema = z
  .strictObject({
    job_id: idOf('job'),
    status: z.enum(['running', 'succeeded']).meta({
      description:
        '`running`: values are being converted; the field shows its old definition and values, ' +
        'read-only (schema changes of it and record writes to it answer `409 SCHEMA_LOCKED`). ' +
        '`succeeded`: converted, revertible until `revertible_until`',
    }),
    from_type: fieldTypeNameSchema.meta({ description: 'Type before the conversion' }),
    to_type: fieldTypeNameSchema.meta({ description: 'Type after the conversion' }),
    revertible_until: isoDateTimeSchema.meta({
      description: '`POST /fields/:id/revert-conversion` is accepted until then (7 days)',
    }),
    link_change: z
      .enum(['to_two_way', 'to_one_way', 'to_single'])
      .optional()
      .meta({
        description:
          'Link conversions (T404; the type stays `link`). While `running`, record writes to ' +
          'the field go on (the junction keeps its structure); only schema changes are locked',
      }),
  })
  .meta({ id: 'FieldConversionState' });
export type FieldConversionState = z.infer<typeof fieldConversionStateSchema>;

export const fieldSchema = z
  .object({
    id: idOf('fld'),
    table_id: idOf('tbl'),
    name: z.string(),
    type: fieldTypeNameSchema,
    options: fieldOptionsSchema,
    is_primary: z.boolean(),
    required: z.boolean(),
    unique_values: z.boolean(),
    description: z.string().nullable(),
    position: z.int().min(0).meta({ description: 'Sort key of the display order' }),
    created_at: isoDateTimeSchema,
    updated_at: isoDateTimeSchema,
    deleted_at: isoDateTimeSchema.optional().meta({
      description:
        'Only on fields in the trash, listed with `include_deleted=true`: when the field was ' +
        'deleted (restorable for 30 days)',
    }),
    conversion: fieldConversionStateSchema.nullable().optional(),
    link_target_deleted: z
      .boolean()
      .optional()
      .meta({
        description:
          'Only on `link` fields whose linked table is in the trash (`true`): the field stays, its ' +
          'cells read empty and take no new links until the table is restored (CONTRACTS §13)',
      }),
    link_table_purged: z
      .boolean()
      .optional()
      .meta({
        description:
          'Only on `link` fields in the trash (listed with `include_deleted=true`) whose linked ' +
          'table was purged (`true`, T461): the links are gone and a restore answers ' +
          '`422 VALIDATION_FAILED` / `LINK_TABLE_PURGED` (CONTRACTS §13)',
      }),
    result_type: computedResultTypeSchema.optional().meta({
      description: 'Only on `formula`/`lookup` fields: the type of their value (T456)',
    }),
    compute_mode: z
      .enum(COMPUTE_MODES)
      .optional()
      .meta({
        description:
          'Only on `formula`/`lookup` fields, chosen by the server (SPEC §5.9): `stored` ' +
          '(a column, computed on write) or `virtual` (computed on read: `NOW()`/`TODAY()` or ' +
          'a virtual dependency)',
      }),
    compute_state: z
      .enum(COMPUTE_STATES)
      .optional()
      .meta({
        description:
          'Only on `formula`/`lookup` fields: `ready`, `backfilling` (values being computed ' +
          'for every record), `recomputing` (a write changed more than 1 000 rows of it, or ' +
          'every row: the `computed.recompute` job catches up and rows not recomputed yet ' +
          'keep their previous values) or `error` (see `compute_error`)',
      }),
    compute_error: computeErrorSchema
      .nullable()
      .optional()
      .meta({ description: 'Only on `formula`/`lookup` fields: `null`, or the field-level error' }),
    locked: z
      .boolean()
      .optional()
      .meta({
        description:
          'Only on `formula`/`lookup` fields (T457): `true` when the reader cannot read what ' +
          'the value is computed from — another table, a field of other records, or (base ' +
          'setting `strict_computed_permissions`) a field of the same record it cannot read. ' +
          'Its cells read `null`; filtering, sorting and grouping by it answer like a hidden ' +
          'field (`422 INVALID_FILTER` / `INVALID_SORT`)',
      }),
    button: buttonFieldSummarySchema.optional().meta({
      description:
        'Only on `button` fields returned by the field endpoints (T517): the automation ' +
        'attached to the button and its `min_permission`',
    }),
  })
  .meta({ id: 'Field' });
export type FieldDto = z.infer<typeof fieldSchema>;

export const fieldListSchema = offsetListSchema(fieldSchema).meta({ id: 'FieldList' });
export type FieldList = z.infer<typeof fieldListSchema>;

/** `GET /tables/:tableId/fields`. */
export const fieldListQuerySchema = offsetQuerySchema.extend({
  include_deleted: booleanQueryParam.default(false).meta({
    description:
      'Also list the fields in the trash that can still be restored (deleted less than 30 ' +
      'days ago, column not purged), with `deleted_at`. Needs schema rights on the table ' +
      '(base `admin` or table permission `manage`), else `403 PERMISSION_DENIED`',
  }),
});
export type FieldListQuery = z.infer<typeof fieldListQuerySchema>;

const fieldOptionsInputSchema = fieldOptionsSchema.meta({
  description:
    'Options of the type (SPEC §5.5), defaulted and validated per type. Select options ' +
    'without `id` are new and get one. `formula`: `FormulaFieldOptions` (`expression` with ' +
    'names, `style`); `lookup`: `LookupFieldOptions` (`from`, `select`, `where`, `aggregate`, ' +
    '`style`) — CONTRACTS §13.',
});

export const createFieldRequestSchema = z
  .strictObject({
    name: schemaNameSchema,
    type: fieldTypeNameSchema,
    options: fieldOptionsInputSchema.optional(),
    description: schemaDescriptionSchema.nullable().optional(),
    required: z.boolean().optional(),
    unique_values: z.boolean().optional(),
  })
  .meta({ id: 'CreateFieldRequest' });
export type CreateFieldRequest = z.infer<typeof createFieldRequestSchema>;

export const updateFieldRequestSchema = z
  .strictObject({
    name: schemaNameSchema.optional(),
    options: fieldOptionsSchema.optional().meta({
      description:
        'Top-level keys replace the current ones (e.g. only `style`). For `select`, ' +
        '`options` is the full new list: items with an `id` keep it (rename, recolour, ' +
        'reorder), items without are added, missing ones are deleted and removed from the ' +
        'records by a background job. The column type never changes here (`PUT`). ' +
        '`formula`: `expression` (names) and/or `style`; `lookup`: any of its keys — the ' +
        'definition is checked again like on create (CONTRACTS §13). `datetime`: `reminder` ' +
        '(`DateReminderOption`; `null` turns it off; turning it on or changing it never reminds ' +
        'of moments already passed — CONTRACTS §22.6).',
    }),
    description: schemaDescriptionSchema.nullable().optional(),
    required: z.boolean().optional(),
    unique_values: z.boolean().optional(),
    position: positionSchema.optional(),
  })
  .refine(atLeastOneKey, AT_LEAST_ONE)
  .meta({ id: 'UpdateFieldRequest' });
export type UpdateFieldRequest = z.infer<typeof updateFieldRequestSchema>;

/**
 * `PATCH /fields/:id` answer: the field, plus the background job that removes
 * deleted select options from the records (`null` when none was queued).
 */
export const updateFieldResponseSchema = fieldSchema
  .extend({
    job_id: idOf('job')
      .nullable()
      .meta({
        description:
          'The `schema.remove_select_options` job queued because select options were ' +
          'deleted, or the `computed.backfill` job of a changed stored formula/lookup (follow ' +
          'it with `GET /jobs/:id` or `job.progress` on `user:{id}`); `null` when the change ' +
          'queued no such job',
      }),
  })
  .meta({ id: 'UpdateFieldResponse' });
export type UpdateFieldResponse = z.infer<typeof updateFieldResponseSchema>;
