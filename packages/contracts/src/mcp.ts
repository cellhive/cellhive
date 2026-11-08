import { z } from 'zod';

import { aggregatePlanDimensionSchema, aggregatePlanMetricSchema } from './aggregate-plan.js';
import { aiAutomationWarningSchema } from './ai-automation.js';
import { timeZoneSchema } from './auth.js';
import { automationDefinitionSchema, MAX_AUTOMATION_NAME_LENGTH } from './automations.js';
import { isoDateTimeSchema } from './common.js';
import { computedResultTypeSchema, lookupFieldOptionsSchema } from './computed-fields.js';
import {
  dateBucketSchema,
  DEFAULT_WIDGET_LIMIT,
  MAX_WIDGET_LIMIT,
  MAX_WIDGET_METRICS,
  metricAggregationSchema,
  widgetSortSchema,
} from './dashboard-widgets.js';
import { errorCodeSchema, problemErrorItemSchema } from './errors.js';
import { idOf } from './ids.js';
import { idempotencyKeySchema, MAX_RECORD_SEARCH_LENGTH } from './records.js';
import {
  fieldTypeNameSchema,
  MAX_SCHEMA_DESCRIPTION_LENGTH,
  MAX_SCHEMA_NAME_LENGTH,
} from './tables.js';
import { viewTypeSchema } from './views.js';

/**
 * Built-in MCP server (CONTRACTS §30, ADR-40, BACKLOG T920): `POST /api/v1/mcp`,
 * Streamable HTTP without sessions, API tokens only.
 */

// --- Endpoint (CONTRACTS §30.1) -----------------------------------------------------

/** The only route of the MCP server; `GET`/`DELETE` answer `405`. */
export const MCP_PATH = '/api/v1/mcp';
/** Largest request body of the MCP route, in bytes; larger → `413 PAYLOAD_TOO_LARGE`. */
export const MCP_REQUEST_MAX_BYTES = 2 * 1024 * 1024;

/**
 * A JSON-RPC 2.0 message posted to the endpoint, for the OpenAPI document
 * only: the MCP SDK validates messages and answers JSON-RPC errors itself.
 */
export const mcpRequestSchema = z
  .looseObject({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.string(), z.int()]).optional().meta({ description: 'Absent for notifications' }),
    method: z.string().meta({
      description:
        '`server/discover`, `tools/list`, `tools/call` (2026-07-28, `_meta` envelope on every ' +
        'request); `initialize` and `notifications/initialized` for 2025-era clients',
    }),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .meta({ id: 'McpRequest', description: 'JSON-RPC 2.0 request or notification (MCP)' });

/** A JSON-RPC 2.0 response (always `application/json`, never a session id). */
export const mcpResponseSchema = z
  .looseObject({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.string(), z.int(), z.null()]),
    result: z.record(z.string(), z.unknown()).optional(),
    error: z
      .object({ code: z.int(), message: z.string(), data: z.unknown().optional() })
      .optional()
      .meta({
        description:
          '`-32602`: unknown or unlisted tool, bad params; `-32022`: unsupported protocol ' +
          'version; `-32020`: `Mcp-*` headers do not match the body',
      }),
  })
  .meta({ id: 'McpResponse', description: 'JSON-RPC 2.0 response (MCP)' });

// --- Tools (CONTRACTS §30.2+) ---------------------------------------------------------

/** Most items in `errors` of a tool error; `total` counts them all. */
export const MCP_TOOL_ERRORS_MAX = 100;
/**
 * Most unknown-key items (`UNKNOWN_FIELD`, `UNRECOGNIZED_KEY`) a tool error
 * keeps per record of a write (`records[i]…`), and for the rest of the input.
 */
export const MCP_TOOL_ERRORS_UNKNOWN_KEYS_MAX = 20;
/** Longest string in a tool error (message, paths, params), in graphemes; longer → cut + `…`. */
export const MCP_TOOL_ERROR_TEXT_MAX_CHARS = 500;
/** Largest tool error result (`structuredContent` and `content` as JSON), in UTF-8 bytes. */
export const MCP_TOOL_ERROR_MAX_BYTES = 64 * 1024;

/**
 * `isError` result of a tool call: an `AppError` as data, so that the model
 * can correct its call. `NOT_FOUND` has one message for every reason
 * (missing, another organization, outside `base_ids`, not readable).
 */
export const mcpToolErrorSchema = z
  .object({
    code: errorCodeSchema,
    message: z.string(),
    errors: z.array(problemErrorItemSchema).meta({
      description:
        `At most ${String(MCP_TOOL_ERRORS_MAX)} items, of which at most ` +
        `${String(MCP_TOOL_ERRORS_UNKNOWN_KEYS_MAX)} unknown keys per record`,
    }),
    total: z.int().min(0).meta({ description: 'Problems found, also those left out of `errors`' }),
    retry_after: z.int().min(1).optional().meta({ description: 'Seconds, when retrying helps' }),
  })
  .meta({ id: 'McpToolError' });
export type McpToolError = z.infer<typeof mcpToolErrorSchema>;

/** Most bases `list_bases` returns (`truncated` past it). */
export const MCP_LIST_BASES_LIMIT = 200;

/** `list_bases`: no input. */
export const listBasesInputSchema = z.strictObject({});

export const mcpBaseSchema = z.object({
  id: idOf('bse'),
  name: z.string(),
  description: z.string().nullable(),
  workspace: z.object({ id: idOf('wsp'), name: z.string() }),
});

/** `list_bases` result: bases the caller can open, by workspace then name. */
export const listBasesResultSchema = z.object({
  bases: z.array(mcpBaseSchema),
  truncated: z.boolean(),
});
export type ListBasesResult = z.infer<typeof listBasesResultSchema>;

// --- Schema reads (CONTRACTS §30.2, T921) ------------------------------------------

/** Most tables `list_tables` returns (`truncated` past it). */
export const MCP_LIST_TABLES_LIMIT = 200;
/** Most fields `describe_table` returns (`truncated` past it). */
export const MCP_DESCRIBE_FIELDS_LIMIT = 200;
/** Most option names `describe_table` gives per select field (`options_truncated` past it). */
export const MCP_FIELD_OPTIONS_LIMIT = 50;

/** `list_tables`: the tables of one base. */
export const listTablesInputSchema = z.strictObject({
  base_id: idOf('bse').meta({ description: 'A base id from `list_bases`' }),
});

/** `list_tables` result: tables the caller can read, in display order. */
export const listTablesResultSchema = z.object({
  tables: z.array(
    z.object({ id: idOf('tbl'), name: z.string(), description: z.string().nullable() }),
  ),
  truncated: z.boolean(),
});
export type ListTablesResult = z.infer<typeof listTablesResultSchema>;

/** `describe_table`: the fields and views of one table. */
export const describeTableInputSchema = z.strictObject({
  table_id: idOf('tbl').meta({ description: 'A table id from `list_tables`' }),
});

/**
 * A field the caller can read (`no_perm` fields are absent, name included).
 * The other tools name fields by `name`.
 */
export const mcpFieldSchema = z.object({
  name: z.string(),
  type: fieldTypeNameSchema,
  description: z.string().nullable(),
  is_primary: z.boolean().meta({ description: 'The title of a record (link cells show it)' }),
  read_only: z.boolean().meta({
    description:
      'Computed, system or locked field, or the caller may not write it (table read-only, ' +
      'field permission `read`)',
  }),
  create_only: z
    .literal(true)
    .optional()
    .meta({ description: 'Only `create_records` may write it (field permission `create`)' }),
  multiple: z
    .boolean()
    .optional()
    .meta({ description: '`select`, `user`, `link`: holds a list of values' }),
  options: z
    .array(z.string())
    .optional()
    .meta({ description: '`select`: option names, the values filters and writes take' }),
  options_truncated: z.boolean().optional(),
  link_table_id: idOf('tbl').optional().meta({ description: '`link`: the linked table' }),
  result_type: computedResultTypeSchema
    .optional()
    .meta({ description: '`formula`, `lookup`: type of the value' }),
});
export type McpField = z.infer<typeof mcpFieldSchema>;

/** `describe_table` result. */
export const describeTableResultSchema = z.object({
  id: idOf('tbl'),
  name: z.string(),
  description: z.string().nullable(),
  fields: z.array(mcpFieldSchema),
  truncated: z.boolean().meta({ description: 'More fields exist than returned' }),
  views: z.array(z.object({ id: idOf('viw'), name: z.string(), type: viewTypeSchema })),
});
export type DescribeTableResult = z.infer<typeof describeTableResultSchema>;

// --- Record reads (CONTRACTS §30.3, T921) ------------------------------------------

/** Longest text cell returned, in user-perceived characters (graphemes); longer → cut + `…`. */
export const MCP_TEXT_CELL_MAX_CHARS = 4_000;
/** Largest JSON result of a record read, in UTF-8 bytes; past it records are left out from the end. */
export const MCP_RESULT_MAX_BYTES = 32 * 1024;
/** Deepest `offset` of `query_records`: past it, a narrower filter is needed. */
export const MCP_MAX_OFFSET = 10_000;
/** `limit` of `query_records`: default and most. */
export const MCP_QUERY_DEFAULT_LIMIT = 20;
export const MCP_QUERY_MAX_LIMIT = 100;
/** Most conditions of a `query_records` filter, and sort keys. */
export const MCP_FILTER_MAX_CONDITIONS = 20;
export const MCP_SORT_MAX_KEYS = 5;
/** Most ids of one `get_records` call. */
export const MCP_GET_RECORDS_MAX = 20;

/** Operators of the tuple filter (CONTRACTS §3); the API test locks them to `@cellhive/filter-dsl`. */
export const MCP_FILTER_OPERATORS = [
  '==',
  '!=',
  '>',
  '>=',
  '<',
  '<=',
  'intersects',
  'disjoint',
  'empty',
  'non_empty',
] as const;

const operatorSchema = z.enum(MCP_FILTER_OPERATORS);
const fieldNameSchema = z.string().min(1).meta({ description: 'Field name' });

/** The tuple filter of the tools that read records (CONTRACTS §3), by field name. */
const mcpFilterSchema = z
  .strictObject({
    logic: z.enum(['and', 'or']).default('and'),
    conditions: z
      .array(
        z.union([
          z.tuple([fieldNameSchema, operatorSchema]),
          z.tuple([fieldNameSchema, operatorSchema, z.unknown()]),
        ]),
      )
      .min(1)
      .max(MCP_FILTER_MAX_CONDITIONS),
  })
  .optional()
  .meta({
    description:
      'One level of conditions [field name, operator, value]. Values: option names for ' +
      'select, numbers, "ExactDate(2026-09-25)", "Today", "Yesterday", "Tomorrow", ' +
      '"CurrentUser" or [{"id": "usr_…"}] for users, [{"id": "rec_…"}] for links; ' +
      '`empty`/`non_empty` take no value. `intersects` on text = contains.',
  });

/** `query_records`: one page of records, like `POST /tables/:id/records/query` with field names. */
export const queryRecordsInputSchema = z.strictObject({
  table_id: idOf('tbl'),
  filter: mcpFilterSchema,
  sort: z
    .array(
      z.strictObject({
        field: fieldNameSchema,
        direction: z.enum(['asc', 'desc']).default('asc'),
      }),
    )
    .max(MCP_SORT_MAX_KEYS)
    .optional(),
  fields: z
    .array(fieldNameSchema)
    .min(1)
    .max(MCP_DESCRIBE_FIELDS_LIMIT)
    .optional()
    .meta({ description: 'Only these fields (default: every field the caller reads)' }),
  search: z
    .string()
    .min(1)
    .max(MAX_RECORD_SEARCH_LENGTH)
    .optional()
    .meta({ description: 'Unaccented, case-insensitive substring of the primary field' }),
  view_id: idOf('viw')
    .optional()
    .meta({ description: 'Read through a view of `describe_table`: its filter and sort apply' }),
  limit: z.int().min(1).max(MCP_QUERY_MAX_LIMIT).default(MCP_QUERY_DEFAULT_LIMIT),
  offset: z
    .int()
    .min(0)
    .max(MCP_MAX_OFFSET)
    .default(0)
    .meta({ description: `At most ${String(MCP_MAX_OFFSET)}: narrow the filter to go further` }),
});
export type QueryRecordsInput = z.infer<typeof queryRecordsInputSchema>;

/** `get_records`: records by id. */
export const getRecordsInputSchema = z.strictObject({
  table_id: idOf('tbl'),
  record_ids: z.array(idOf('rec')).min(1).max(MCP_GET_RECORDS_MAX),
});
export type GetRecordsInput = z.infer<typeof getRecordsInputSchema>;

/** A record as MCP tools return it: cells (`cell_format=json`) keyed by field name. */
export const mcpRecordSchema = z.object({
  id: idOf('rec'),
  fields: z.record(z.string(), z.unknown()),
});
export type McpRecord = z.infer<typeof mcpRecordSchema>;

/** A text cell cut to `MCP_TEXT_CELL_MAX_CHARS`. */
export const mcpTruncatedCellSchema = z.object({ record_id: idOf('rec'), field: z.string() });
export type McpTruncatedCell = z.infer<typeof mcpTruncatedCellSchema>;

const recordsPartSchema = {
  records: z.array(mcpRecordSchema),
  truncated: z.boolean().meta({
    description: `Records were left out to keep the result under ${String(MCP_RESULT_MAX_BYTES)} bytes`,
  }),
  truncated_cells: z.array(mcpTruncatedCellSchema),
};

/** `query_records` result. */
export const queryRecordsResultSchema = z.object({
  ...recordsPartSchema,
  total: z.int().min(0).optional(),
  total_estimate: z
    .int()
    .min(0)
    .optional()
    .meta({ description: 'Instead of `total` when the count is large' }),
  offset: z.int().min(0),
  limit: z.int().min(1),
  next_offset: z
    .int()
    .min(0)
    .nullable()
    .meta({ description: '`offset` of the next page; `null` on the last one' }),
});
export type QueryRecordsResult = z.infer<typeof queryRecordsResultSchema>;

/** `get_records` result: ids that do not exist or the caller cannot read are absent. */
export const getRecordsResultSchema = z.object(recordsPartSchema);
export type GetRecordsResult = z.infer<typeof getRecordsResultSchema>;

// --- Aggregates (CONTRACTS §30.4, T922) --------------------------------------------

/**
 * `aggregate_records`: numbers over the records of a table, computed by the
 * widget engine with the caller's permissions — the plan by name of
 * `aggregate-plan.ts`: without `group_by` one `kpi` per metric, with it one
 * `bar`.
 */
export const aggregateRecordsInputSchema = z.strictObject({
  table_id: idOf('tbl'),
  metrics: z
    .array(aggregatePlanMetricSchema)
    .min(1)
    .max(MAX_WIDGET_METRICS)
    .meta({
      description:
        '`count` takes no field; `sum`, `avg`, `min`, `max` a number field; `count_distinct` ' +
        'a field that can be grouped',
    }),
  group_by: aggregatePlanDimensionSchema.optional().meta({
    description:
      'One group per value of a text, select (one per option), user, checkbox, link, date ' +
      '(`date_bucket` required) or number (optional `bucket_width`) field',
  }),
  filter: mcpFilterSchema,
  sort: widgetSortSchema.optional().meta({
    description:
      'Order of the groups: largest first metric by default, dates in time order (ignored ' +
      'without `group_by`)',
  }),
  limit: z
    .int()
    .min(1)
    .max(MAX_WIDGET_LIMIT)
    .default(DEFAULT_WIDGET_LIMIT)
    .meta({ description: 'Groups returned; the rest is summed up in `other`' }),
  timezone: timeZoneSchema.optional().meta({
    description:
      'IANA time zone name of date buckets and relative dates, such as Asia/Ho_Chi_Minh or ' +
      'UTC (default: the user’s, then the organization’s). UTC offsets such as +07:00 or ' +
      'UTC+7 are not accepted',
  }),
});
export type AggregateRecordsInput = z.output<typeof aggregateRecordsInputSchema>;

/** A column of `aggregate_records`, by field name. */
export const mcpAggregateColumnSchema = z.object({
  role: z.enum(['group', 'metric']),
  field: z.string().nullable().meta({ description: 'Field name; `null` for `count`' }),
  aggregation: metricAggregationSchema.nullable(),
  date_bucket: dateBucketSchema.nullable(),
  bucket_width: z.number().nullable(),
});
export type McpAggregateColumn = z.infer<typeof mcpAggregateColumnSchema>;

/** `aggregate_records` result. */
export const aggregateRecordsResultSchema = z.object({
  columns: z.array(mcpAggregateColumnSchema),
  rows: z.array(z.array(z.unknown())).meta({
    description:
      'In `columns` order. With `group_by`, one row per group: its label (option or member ' +
      'name, record title, first day of the date bucket, number, text, true/false; `null` for ' +
      'the empty group or a linked record the caller cannot read), then the metrics. Without, ' +
      'one row of metrics. `[]` when no record matches',
  }),
  other: z
    .object({ groups: z.int().min(1), rows: z.array(z.array(z.unknown())) })
    .nullable()
    .meta({ description: 'Groups past `limit`, computed together (group cell `null`)' }),
  total: z
    .array(z.number().nullable())
    .nullable()
    .meta({ description: 'Each metric over every matching record; `null` when none match' }),
  truncated: z.boolean().meta({
    description:
      `Groups were left out from the end of \`rows\` to keep the result under ` +
      `${String(MCP_RESULT_MAX_BYTES)} bytes (\`total\` still counts them)`,
  }),
});
export type AggregateRecordsResult = z.infer<typeof aggregateRecordsResultSchema>;

// --- Every write tool (CONTRACTS §30.5, §30.7, T1014) -------------------------------

/**
 * `idempotency_key` of a write tool (T1014): the same key with the same
 * arguments within 24 hours answers the stored result again (`replayed:
 * true`) without writing; with other arguments, or while the first call
 * still runs → `IDEMPOTENCY_KEY_REUSED`. Per API token, like the
 * `Idempotency-Key` header of the REST API (CONTRACTS §1.1).
 */
export const mcpIdempotencyKeySchema = idempotencyKeySchema.meta({
  description:
    'Optional, 1–255 printable ASCII characters. Send a new random key with each change and the ' +
    'same key when you resend it (lost connection): within 24 hours the stored result comes back ' +
    'with `replayed: true` and nothing is written twice. The same key with other arguments → ' +
    '`IDEMPOTENCY_KEY_REUSED`',
});

/** `replayed: true` on a result given again for an `idempotency_key`; absent otherwise. */
const replayedSchema = z
  .literal(true)
  .optional()
  .meta({ description: 'The stored result of an earlier call with this `idempotency_key`' });

// --- Record writes (CONTRACTS §30.5, T923) -----------------------------------------

/** Most records of one `create_records` / `update_records` call. */
export const MCP_WRITE_RECORDS_MAX = 50;

const writeFieldsSchema = z.record(z.string(), z.unknown()).meta({
  description:
    'Cells by field name (describe_table): option names for select, numbers, ISO dates, ' +
    '[{"id": "usr_…"}] for users, [{"id": "rec_…"}] for links. Values are never converted ' +
    'and select options are never created.',
});

/** `create_records`: like `POST /tables/:id/records` with field names, `typecast: false`. */
export const createRecordsInputSchema = z.strictObject({
  table_id: idOf('tbl'),
  records: z
    .array(z.strictObject({ fields: writeFieldsSchema }))
    .min(1)
    .max(MCP_WRITE_RECORDS_MAX),
  idempotency_key: mcpIdempotencyKeySchema.optional(),
});
export type CreateRecordsInput = z.infer<typeof createRecordsInputSchema>;

/** `update_records`: like `PATCH /tables/:id/records` — only the given fields change. */
export const updateRecordsInputSchema = z.strictObject({
  table_id: idOf('tbl'),
  records: z
    .array(z.strictObject({ id: idOf('rec'), fields: writeFieldsSchema }))
    .min(1)
    .max(MCP_WRITE_RECORDS_MAX),
  idempotency_key: mcpIdempotencyKeySchema.optional(),
});
export type UpdateRecordsInput = z.infer<typeof updateRecordsInputSchema>;

/**
 * `create_records` / `update_records` result: the written records as the
 * caller reads them now (cut like a read), in input order; those it can no
 * longer read are absent from both lists.
 */
export const writeRecordsResultSchema = z.object({
  record_ids: z.array(idOf('rec')).meta({
    description: 'Every written record the caller reads, also those left out of `records`',
  }),
  ...recordsPartSchema,
  replayed: replayedSchema,
});
export type WriteRecordsResult = z.infer<typeof writeRecordsResultSchema>;

// --- Schema writes (CONTRACTS §30.7, T1014) ----------------------------------------

/** Most calls of the schema tools per API token and minute (`RATE_LIMITED` + `retry_after` past it). */
export const MCP_SCHEMA_CALLS_PER_MINUTE = 30;
/** Most fields of one `create_table` call (besides its primary field). */
export const MCP_CREATE_TABLE_FIELDS_MAX = 50;

/**
 * Field types the schema tools create: every type a person fills in, plus
 * links, lookups and formulas — never `button` (needs an automation),
 * `parent` (turns the table into a tree) nor the system types
 * (`created_at`, `updated_at`, `created_by`, `updated_by`, `auto_number`).
 */
export const MCP_CREATABLE_FIELD_TYPES = [
  'text',
  'number',
  'select',
  'datetime',
  'checkbox',
  'user',
  'attachment',
  'link',
  'lookup',
  'formula',
] as const;
export type McpCreatableFieldType = (typeof MCP_CREATABLE_FIELD_TYPES)[number];

/**
 * Detail code (`VALIDATION_FAILED`, `MCP_SCHEMA_DETAIL_CODES`): a schema
 * change MCP never makes (`params.reason`).
 */
export const NOT_AVAILABLE_OVER_MCP = 'NOT_AVAILABLE_OVER_MCP';
/**
 * `params.reason` of `NOT_AVAILABLE_OVER_MCP`: AI settings of a field
 * (`options.ai`, set or removed), the primary field, a link going from
 * several records to one (it would cut links), the options of a field type
 * MCP does not create (`button`, `parent`, system fields).
 */
export const MCP_SCHEMA_REFUSALS = [
  'ai_options',
  'primary_field',
  'cuts_links',
  'field_type',
] as const;
export type McpSchemaRefusal = (typeof MCP_SCHEMA_REFUSALS)[number];

const schemaNameSchema = z.string().trim().min(1).max(MAX_SCHEMA_NAME_LENGTH);
const schemaDescriptionSchema = z.string().max(MAX_SCHEMA_DESCRIPTION_LENGTH).nullable();

/** One select option of a schema tool, by name: an option is never named by id. */
export const mcpSelectOptionInputSchema = z.strictObject({
  name: schemaNameSchema,
  color: z.int().min(0).max(54).optional().meta({ description: 'Colour index 0–54' }),
});

/**
 * `options` of a `select` field in the schema tools: option names; on
 * `update_field` the list is merged by name — named options are added or
 * recoloured, options left out are kept (an option is never deleted).
 * `default_value` takes option names too.
 */
export const mcpSelectOptionsInputSchema = z
  .strictObject({
    multiple: z.boolean().optional(),
    options: z
      .array(mcpSelectOptionInputSchema)
      .max(1000)
      .optional()
      .superRefine((options, ctx) => {
        const seen = new Set<string>();
        options?.forEach((option, index) => {
          if (seen.has(option.name)) {
            ctx.addIssue({
              code: 'custom',
              path: [index, 'name'],
              message: 'Duplicate option name',
            });
          }
          seen.add(option.name);
        });
      }),
    default_value: z
      .union([schemaNameSchema, z.array(schemaNameSchema)])
      .nullable()
      .optional()
      .meta({ description: 'Option name (names for a multiple select), or `null`' }),
  })
  .meta({ id: 'McpSelectOptionsInput' });
export type McpSelectOptionsInput = z.infer<typeof mcpSelectOptionsInputSchema>;

/** `options` of a new `link` field: the linked table by id (`list_tables`). */
export const mcpLinkOptionsInputSchema = z
  .strictObject({
    link_table_id: idOf('tbl').meta({ description: 'The linked table, from `list_tables`' }),
    allow_multiple: z.boolean().optional().meta({ description: 'Default `true`' }),
    bidirectional: z.boolean().optional().meta({
      description: 'Also add a link field to the linked table (needs schema rights there)',
    }),
    bidirectional_link_field_name: schemaNameSchema
      .optional()
      .meta({ description: 'Name of the field added to the linked table' }),
  })
  .meta({ id: 'McpLinkOptionsInput' });
export type McpLinkOptionsInput = z.infer<typeof mcpLinkOptionsInputSchema>;

/** `options` of a `link` field in `update_field`: only from one record to several. */
export const mcpLinkOptionsUpdateSchema = z.strictObject({
  allow_multiple: z.boolean(),
});

/** `options` of a `lookup` field: the values of `field` in the records `link_field` links to. */
export const mcpLookupOptionsInputSchema = z
  .strictObject({
    link_field: schemaNameSchema.meta({ description: 'A link field of this table, by name' }),
    field: schemaNameSchema.meta({ description: 'A field of the linked table, by name' }),
    aggregate: lookupFieldOptionsSchema.shape.aggregate,
    style: lookupFieldOptionsSchema.shape.style,
  })
  .meta({ id: 'McpLookupOptionsInput' });
export type McpLookupOptionsInput = z.infer<typeof mcpLookupOptionsInputSchema>;

const fieldOptionsDescription =
  'Options of the type, as the REST API takes them (CONTRACTS §13) except: `select` — ' +
  '`{ multiple?, options?: [{ name, color? }], default_value?: name | names }` (names, never ' +
  'ids); `link` — `{ link_table_id, allow_multiple?, bidirectional?, ' +
  'bidirectional_link_field_name? }`; `lookup` — `{ link_field, field, aggregate?, style? }` ' +
  '(names); `formula` — `{ expression, style? }`, fields as `[name]`. Never `ai`: AI fields are ' +
  'set up in the app';

/** `options` of a schema tool: an object whose shape the field type decides. */
export const mcpFieldOptionsInputSchema = z
  .record(z.string(), z.unknown())
  .meta({ description: fieldOptionsDescription });

const fieldPartsSchema = {
  options: mcpFieldOptionsInputSchema.optional(),
  description: schemaDescriptionSchema.optional(),
  required: z.boolean().optional(),
  unique_values: z.boolean().optional(),
};

/** A field to create (`create_table`, `create_field`): by name, of a creatable type. */
export const mcpFieldInputSchema = z
  .strictObject({
    name: schemaNameSchema,
    type: z.enum(MCP_CREATABLE_FIELD_TYPES),
    ...fieldPartsSchema,
  })
  .meta({ id: 'McpFieldInput' });
export type McpFieldInput = z.infer<typeof mcpFieldInputSchema>;

/** `create_table`: like `POST /bases/:id/tables`, then each field like `POST /tables/:id/fields`. */
export const createTableInputSchema = z.strictObject({
  base_id: idOf('bse').meta({ description: 'A base id from `list_bases`' }),
  name: schemaNameSchema,
  description: schemaDescriptionSchema.optional(),
  primary_field_name: schemaNameSchema
    .optional()
    .meta({ description: 'Name of the primary text field (default `Name`)' }),
  fields: z
    .array(mcpFieldInputSchema)
    .max(MCP_CREATE_TABLE_FIELDS_MAX)
    .optional()
    .meta({ description: 'Created in order: a lookup or formula may use the fields before it' }),
  idempotency_key: mcpIdempotencyKeySchema.optional(),
});
export type CreateTableInput = z.infer<typeof createTableInputSchema>;

/** `create_field`: like `POST /tables/:id/fields`. */
export const createFieldInputSchema = z.strictObject({
  table_id: idOf('tbl').meta({ description: 'A table id from `list_tables`' }),
  name: schemaNameSchema,
  type: z.enum(MCP_CREATABLE_FIELD_TYPES),
  ...fieldPartsSchema,
  idempotency_key: mcpIdempotencyKeySchema.optional(),
});
export type CreateFieldInput = z.infer<typeof createFieldInputSchema>;

/**
 * `update_field`: like `PATCH /fields/:id`, the field by name; never its
 * type, never the primary field, never deleting a select option.
 */
export const updateFieldInputSchema = z
  .strictObject({
    table_id: idOf('tbl').meta({ description: 'A table id from `list_tables`' }),
    field: schemaNameSchema.meta({
      description: 'The field to change, by name (`describe_table`)',
    }),
    name: schemaNameSchema.optional().meta({ description: 'A new name' }),
    ...fieldPartsSchema,
    idempotency_key: mcpIdempotencyKeySchema.optional(),
  })
  .refine(
    (input) =>
      [input.name, input.options, input.description, input.required, input.unique_values].some(
        (value) => value !== undefined,
      ),
    {
      message:
        'At least one change is required (name, description, options, required, unique_values)',
    },
  );
export type UpdateFieldInput = z.infer<typeof updateFieldInputSchema>;

/** `create_table` result: the new table as `describe_table` gives it. */
export const createTableResultSchema = describeTableResultSchema.extend({
  replayed: replayedSchema,
});
export type CreateTableResult = z.infer<typeof createTableResultSchema>;

/** `create_field` / `update_field` result: the field as `describe_table` gives it. */
export const mcpFieldResultSchema = z.object({
  table_id: idOf('tbl'),
  field: mcpFieldSchema,
  replayed: replayedSchema,
});
export type McpFieldResult = z.infer<typeof mcpFieldResultSchema>;

// --- Automation drafts (CONTRACTS §30.8, T1015) --------------------------------------

/** How long a draft of `draft_automation` is kept (Valkey), in seconds: 24 hours. */
export const MCP_AUTOMATION_DRAFT_TTL_SECONDS = 86_400;
/**
 * Most drafts kept per user: a new one past it drops the oldest (its
 * `open_url` then answers `404`), so that drafts never fill Valkey.
 */
export const MCP_AUTOMATION_DRAFTS_PER_USER = 20;

/**
 * `draft_automation` result: the checked draft, kept 24 hours for its
 * creator, and the builder link that opens it unsaved. Nothing is saved
 * in the base, nothing runs.
 */
export const draftAutomationResultSchema = z.object({
  name: z.string().max(MAX_AUTOMATION_NAME_LENGTH),
  definition: automationDefinitionSchema,
  warnings: z.array(aiAutomationWarningSchema),
  open_url: z.url().meta({
    description: 'The builder with the draft, for its creator signed in to Cellhive',
  }),
  expires_at: isoDateTimeSchema,
});
export type DraftAutomationResult = z.infer<typeof draftAutomationResultSchema>;
