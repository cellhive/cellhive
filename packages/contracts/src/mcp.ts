import { z } from 'zod';

import { aggregatePlanDimensionSchema, aggregatePlanMetricSchema } from './aggregate-plan.js';
import { timeZoneSchema } from './auth.js';
import { computedResultTypeSchema } from './computed-fields.js';
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
import { MAX_RECORD_SEARCH_LENGTH } from './records.js';
import { fieldTypeNameSchema } from './tables.js';
import { viewTypeSchema } from './views.js';

/**
 * Built-in MCP server (CONTRACTS §30, ADR-40, BACKLOG T920): `POST /api/v1/mcp`,
 * Streamable HTTP without sessions, API tokens only.
 */

// --- Endpoint (CONTRACTS §30.1) -----------------------------------------------------

/** The only route of the MCP server; `GET`/`DELETE` answer `405`. */
export const MCP_PATH = '/api/v1/mcp';

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

/**
 * `isError` result of a tool call: an `AppError` as data, so that the model
 * can correct its call. `NOT_FOUND` has one message for every reason
 * (missing, another organization, outside `base_ids`, not readable).
 */
export const mcpToolErrorSchema = z
  .object({
    code: errorCodeSchema,
    message: z.string(),
    errors: z.array(problemErrorItemSchema),
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
      'Computed, system or locked field, or the caller may not edit it (table or field ' +
      'permission below `edit`)',
  }),
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
      'IANA zone of date buckets and relative dates (default: the user’s, then the ' +
      'organization’s)',
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
});
export type AggregateRecordsResult = z.infer<typeof aggregateRecordsResultSchema>;
