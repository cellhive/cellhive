import { z } from 'zod';

import { booleanQueryParam, isoDateTimeSchema } from './common.js';
import { idOf } from './ids.js';
import {
  DEFAULT_RECORD_LIMIT,
  MAX_LIST_LIMIT,
  MAX_QUERY_IDS,
  recordListSchema,
} from './pagination.js';
import { recordMetaSchema } from './record-meta.js';
import { MAX_SUMMARY_FIELDS, summaryFunctionSchema } from './views.js';

/**
 * Record API (SPEC §7, §13.1; CONTRACTS §1.3, §1.4, §2, §3). Cell values
 * depend on the field type (CONTRACTS §2) and are validated by the server,
 * so they are `unknown` here.
 */

/** Most records (or ids) one write request may carry; more is `413 PAYLOAD_TOO_LARGE`. */
export const MAX_RECORDS_PER_REQUEST = 1000;
/** Most sort keys of a record query (the `__auto` tie-breaker is added by the server). */
export const MAX_RECORD_SORT_KEYS = 10;
/** Longest `search` string, in characters. */
export const MAX_RECORD_SEARCH_LENGTH = 10_000;
/** Most group levels of a record query or group count (SPEC §8). */
export const MAX_RECORD_GROUP_LEVELS = 3;
/** Most groups `POST …/records/group-counts` returns (`truncated: true` beyond). */
export const MAX_GROUP_COUNT_GROUPS = 10_000;
/** Longest `Idempotency-Key` header value. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;
/** Header of CONTRACTS §1.1 (defined apart from the schemas). */
export { IDEMPOTENCY_KEY_HEADER } from './client-constants.js';
/** Response header set when a stored response is replayed for an `Idempotency-Key`. */
export const IDEMPOTENT_REPLAYED_HEADER = 'idempotent-replayed';

export const fieldKeyTypeSchema = z
  .enum(['name', 'id'])
  .meta({ description: 'How fields are named in the request and the response' });
export type FieldKeyType = z.infer<typeof fieldKeyTypeSchema>;

export const cellFormatSchema = z
  .enum(['json', 'text'])
  .meta({ description: 'Structured values (`json`) or display strings (`text`)' });
export type CellFormat = z.infer<typeof cellFormatSchema>;

export const sortDirectionSchema = z.enum(['asc', 'desc']);

/** `Idempotency-Key`: 1–255 printable ASCII characters. */
export const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(MAX_IDEMPOTENCY_KEY_LENGTH)
  .regex(/^[\x21-\x7e]+$/, { message: 'Must be printable ASCII without spaces' })
  .meta({ description: 'Replays the stored response for 24 hours (CONTRACTS §1.1)' });

// --- Records -----------------------------------------------------------------------

export const recordIdSchema = idOf('rec');

/** Cell values keyed by field name or id (per `field_key_type`). */
export const recordFieldsSchema = z.record(z.string(), z.unknown()).meta({
  description: 'Cell values keyed by field name or id. Fields the caller cannot read are absent.',
});

export const recordSchema = z
  .strictObject({
    id: recordIdSchema,
    created_at: isoDateTimeSchema,
    updated_at: isoDateTimeSchema,
    version: z.int().min(1),
    fields: recordFieldsSchema,
    meta: recordMetaSchema.optional(),
  })
  .meta({ id: 'Record' });
export type RecordDto = z.infer<typeof recordSchema>;

/** `{ records, total | total_estimate, offset, limit }`. */
export const recordListResponseSchema = recordListSchema(recordSchema).meta({ id: 'RecordList' });
export type RecordListResponse = z.infer<typeof recordListResponseSchema>;

export const recordsResponseSchema = z
  .strictObject({ records: z.array(recordSchema) })
  .meta({ id: 'Records' });
export type RecordsResponse = z.infer<typeof recordsResponseSchema>;

export const upsertRecordsResponseSchema = z
  .strictObject({
    records: z.array(recordSchema),
    created_ids: z.array(recordIdSchema),
    updated_ids: z.array(recordIdSchema),
  })
  .meta({ id: 'UpsertRecordsResult' });
export type UpsertRecordsResponse = z.infer<typeof upsertRecordsResponseSchema>;

export const deletedRecordsResponseSchema = z
  .strictObject({ ids: z.array(recordIdSchema) })
  .meta({ id: 'DeletedRecords' });
export type DeletedRecordsResponse = z.infer<typeof deletedRecordsResponseSchema>;

/** Records stay this many days in the trash before `records.purge` deletes them (ADR-23). */
export const RECORD_TRASH_RETENTION_DAYS = 30;

/** `POST /tables/:tableId/records/trash/purge` (T408, CONTRACTS §11.3). */
export const purgeRecordsRequestSchema = z
  .strictObject({
    ids: z.array(recordIdSchema).min(1).max(MAX_RECORDS_PER_REQUEST),
    branch: z
      .boolean()
      .optional()
      .meta({
        description:
          '`true`: also permanently delete the descendants deleted together with each record ' +
          '(sub-records, "delete whole branch") that are in the caller’s trash',
      }),
  })
  .meta({ id: 'PurgeRecordsRequest' });
export type PurgeRecordsRequest = z.infer<typeof purgeRecordsRequestSchema>;

export const purgedRecordsResponseSchema = z
  .strictObject({
    ids: z.array(recordIdSchema).meta({
      description: 'Ids permanently deleted: the requested ids, then their branches',
    }),
  })
  .meta({ id: 'PurgedRecords' });
export type PurgedRecordsResponse = z.infer<typeof purgedRecordsResponseSchema>;

// --- Query string ------------------------------------------------------------------

/**
 * A list parameter: `?fields=A&fields=B`. A single value is one field name
 * (never split on commas: names may contain them).
 */
const listParam = z
  .union([z.string().min(1), z.array(z.string().min(1)).max(MAX_LIST_LIMIT)])
  .transform((value) => (Array.isArray(value) ? value : [value]));

/** A JSON document passed as one query parameter (`?filter={…}`). */
export function jsonQueryParam<T extends z.ZodType>(schema: T, description: string) {
  return z
    .string()
    .transform((text, ctx): unknown => {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        ctx.addIssue({
          code: 'custom',
          message: 'Expected a JSON document',
          params: { code: 'MALFORMED_JSON' },
        });
        return z.NEVER;
      }
    })
    .pipe(schema)
    .meta({ description });
}

const offsetParam = z.coerce.number().int().min(0).default(0);
const limitParam = z.coerce.number().int().min(1).max(MAX_LIST_LIMIT).default(DEFAULT_RECORD_LIMIT);

/** Options of reads (CONTRACTS §1.3), in the query string. */
export const recordReadParamsSchema = z.object({
  field_key_type: fieldKeyTypeSchema.default('name'),
  cell_format: cellFormatSchema.default('json'),
});
export type RecordReadParams = z.infer<typeof recordReadParamsSchema>;

/** `GET /tables/:tableId/records/:recordId`. */
export const recordGetQuerySchema = recordReadParamsSchema.extend({
  fields: listParam.optional(),
});
export type RecordGetQuery = z.infer<typeof recordGetQuerySchema>;

/** Options of writes (CONTRACTS §1.3), in the query string. */
export const recordWriteParamsSchema = z.object({
  field_key_type: fieldKeyTypeSchema.default('name'),
  typecast: booleanQueryParam
    .default(false)
    .meta({ description: 'Accept the extra input forms of CONTRACTS §2 (`true`/`false`)' }),
});
export type RecordWriteParams = z.infer<typeof recordWriteParamsSchema>;

// --- Query -------------------------------------------------------------------------

export const recordSortSchema = z.strictObject({
  field: z.string().min(1).meta({ description: 'Field name or id (per `field_key_type`)' }),
  direction: sortDirectionSchema.default('asc'),
});

const recordSortListSchema = z.array(recordSortSchema).max(MAX_RECORD_SORT_KEYS);

const recordGroupListSchema = z
  .array(recordSortSchema)
  .max(MAX_RECORD_GROUP_LEVELS)
  .meta({
    description:
      `Temporary group (at most ${String(MAX_RECORD_GROUP_LEVELS)} levels, fields the caller ` +
      "reads): replaces the view's group for this request; `[]` = no grouping. Absent or " +
      "`null`: the view's group.",
  });

const viewIdSchema = z
  .string()
  .min(1)
  .meta({
    description:
      "Read through this saved view: its filter is ANDed with the request's (only " +
      '`filter_mode: replace` sets aside the part the caller can see), its group and sort come ' +
      'first (`sort_mode: replace` sets the sort aside). A view of another table, outside ' +
      "`visible_views` or someone else's personal view is `404`.",
  });

/**
 * How the request filter combines with the saved filter of `view_id`
 * (CONTRACTS §1.4, T311): `and` (default) narrows the view; `replace` takes
 * the place of the part of the view filter the caller can see — saved
 * conditions on fields the caller cannot read still apply (BACKLOG S3
 * decision 3). Without `view_id` both mean the same.
 */
export const RECORD_FILTER_MODES = ['and', 'replace'] as const;
export const recordFilterModeSchema = z.enum(RECORD_FILTER_MODES).meta({
  description:
    "`and` (default): the request filter narrows the view's saved filter. `replace`: the " +
    'request filter (absent/`null` = none) takes the place of the saved filter, except saved ' +
    'conditions on fields the caller cannot read, which still apply (temporary filter edits). ' +
    'Not accepted through share links.',
});
export type RecordFilterMode = z.infer<typeof recordFilterModeSchema>;

/**
 * How the request sort combines with the saved sort of `view_id` (CONTRACTS
 * §1.4, T311): `append` (default) sorts after the view's keys; `replace`
 * drops the view's sort for this request (temporary sort edits).
 */
export const RECORD_SORT_MODES = ['append', 'replace'] as const;
export const recordSortModeSchema = z.enum(RECORD_SORT_MODES).meta({
  description:
    "`append` (default): the request sort comes after the view's saved sort. `replace`: the " +
    "view's saved sort is not used; rows are ordered by group → request sort → creation order.",
});
export type RecordSortMode = z.infer<typeof recordSortModeSchema>;

/**
 * A filter: the DSL of SPEC §6.1 (`{ op, items }`) or the tuple form of
 * CONTRACTS §3 (`{ logic, conditions: [[field, op, value?], …] }`). The
 * server validates it (`422 INVALID_FILTER`).
 */
export const recordFilterSchema = z.record(z.string(), z.unknown()).meta({
  id: 'RecordFilter',
  description:
    'Filter DSL `{ "op": "and", "items": [...] }` (field ids) or tuple form ' +
    '`{ "logic": "and", "conditions": [["field", "op", value]] }` (per `field_key_type`).',
});

const searchSchema = z
  .string()
  .max(MAX_RECORD_SEARCH_LENGTH)
  .meta({ description: 'Unaccented, case-insensitive substring of the primary field' });

/** `GET /tables/:tableId/records`: the query of `records/query` as query-string parameters. */
export const recordListQuerySchema = recordReadParamsSchema.extend({
  fields: listParam.optional(),
  filter: jsonQueryParam(recordFilterSchema, 'Filter as a JSON document').optional(),
  sort: jsonQueryParam(
    recordSortListSchema,
    'Sort keys as a JSON array: `[{"field":"Hạn","direction":"asc"}]`',
  ).optional(),
  search: searchSchema.optional(),
  view_id: viewIdSchema.optional(),
  group: jsonQueryParam(
    recordGroupListSchema,
    'Temporary group as a JSON array (replaces the view group): `[{"field":"status"}]`',
  ).optional(),
  filter_mode: recordFilterModeSchema.optional(),
  sort_mode: recordSortModeSchema.optional(),
  offset: offsetParam,
  limit: limitParam,
});
export type RecordListQuery = z.infer<typeof recordListQuerySchema>;

/** Body of `POST /tables/:tableId/records/query` (SPEC §7.1, CONTRACTS §1.4). */
export const recordQueryRequestSchema = z
  .strictObject({
    view_id: viewIdSchema.nullish(),
    fields: z.array(z.string().min(1)).max(MAX_LIST_LIMIT).nullish(),
    filter: recordFilterSchema.nullish(),
    filter_mode: recordFilterModeSchema.optional(),
    group: recordGroupListSchema.nullish(),
    sort: recordSortListSchema.nullish(),
    sort_mode: recordSortModeSchema.optional(),
    search: searchSchema.nullish(),
    offset: z.int().min(0).default(0),
    limit: z.int().min(1).max(MAX_LIST_LIMIT).default(DEFAULT_RECORD_LIMIT),
    ids: z
      .array(recordIdSchema)
      .max(MAX_QUERY_IDS)
      .nullish()
      .meta({
        description:
          `Only these records (at most ${String(MAX_QUERY_IDS)}), e.g. to fetch records announced ` +
          'by realtime events; every other rule (read rule, filter, fields) still applies and ' +
          'ids the caller cannot read are simply absent.',
      }),
    include_total: z
      .boolean()
      .default(true)
      .meta({
        description:
          '`false` skips counting: the response has neither `total` nor `total_estimate` ' +
          '(grid blocks after the first).',
      }),
  })
  .meta({ id: 'RecordQueryRequest' });
export type RecordQueryRequest = z.infer<typeof recordQueryRequestSchema>;

/** Body of `POST /tables/:tableId/records/group-counts` (CONTRACTS §1.4). */
export const recordGroupCountsRequestSchema = z
  .strictObject({
    view_id: viewIdSchema.nullish(),
    filter: recordFilterSchema.nullish(),
    filter_mode: recordFilterModeSchema.optional(),
    search: searchSchema.nullish(),
    group: recordGroupListSchema.nullish(),
  })
  .meta({ id: 'RecordGroupCountsRequest' });
export type RecordGroupCountsRequest = z.infer<typeof recordGroupCountsRequestSchema>;

export const recordGroupCountSchema = z
  .strictObject({
    values: z.array(z.unknown()).meta({
      description:
        'One value per group level, in the cell format of the request (`null` = empty cell)',
    }),
    count: z.int().min(0),
  })
  .meta({ id: 'RecordGroupCount' });

export const recordGroupCountsResponseSchema = z
  .strictObject({
    group: z.array(z.strictObject({ field: z.string(), direction: sortDirectionSchema })).meta({
      description: 'The group levels counted (fields per `field_key_type`)',
    }),
    groups: z
      .array(recordGroupCountSchema)
      .max(MAX_GROUP_COUNT_GROUPS)
      .meta({
        description: `Groups in row order of \`records/query\`, at most ${String(MAX_GROUP_COUNT_GROUPS)}`,
      }),
    truncated: z.boolean().meta({ description: 'More groups exist than returned' }),
  })
  .meta({ id: 'RecordGroupCounts' });
export type RecordGroupCountsResponse = z.infer<typeof recordGroupCountsResponseSchema>;

// --- Summaries (T472) -------------------------------------------------------------

const summaryRequestMapSchema = z
  .record(z.string().min(1), summaryFunctionSchema)
  .refine((value) => Object.keys(value).length <= MAX_SUMMARY_FIELDS, {
    message: `At most ${String(MAX_SUMMARY_FIELDS)} fields`,
  })
  .meta({
    description:
      'Field (per `field_key_type`) → function; replaces the saved `summaries` of the view for ' +
      'this request (absent/`null`: the view’s). A field the caller cannot read is ' +
      '`422 VALIDATION_FAILED` / `UNKNOWN_FIELD`, a function its type does not accept ' +
      '`INVALID_FIELD_TYPE`',
  });

/**
 * Body of `POST /tables/:tableId/records/summaries` (T472, CONTRACTS §1.4):
 * the parameters of `records/group-counts` plus `summaries`, which takes the
 * place of the view's saved summaries (a temporary change of the summary bar).
 */
export const recordSummariesRequestSchema = z
  .strictObject({
    view_id: viewIdSchema.nullish(),
    filter: recordFilterSchema.nullish(),
    filter_mode: recordFilterModeSchema.optional(),
    search: searchSchema.nullish(),
    group: recordGroupListSchema.nullish(),
    summaries: summaryRequestMapSchema.nullish(),
  })
  .meta({ id: 'RecordSummariesRequest' });
export type RecordSummariesRequest = z.infer<typeof recordSummariesRequestSchema>;

export const recordSummarySchema = z
  .strictObject({
    fn: summaryFunctionSchema,
    value: z.unknown().meta({
      description:
        'Counts (`count_all`, `filled`, `empty`, `unique`, `checked`, `unchecked`): an integer. ' +
        'Percentages: the share 0…1 (`null` without records) and `count`, the records behind ' +
        'it. `sum`/`avg`/`min`/`max`: a number (`cell_format=text`: formatted with the ' +
        'field’s style); `range`: `{ min, max }`; `earliest`/`latest`: a date or date-time as ' +
        'in a cell; `date_range`: `{ min, max, days }`. `null` when no cell has a value',
    }),
    count: z
      .int()
      .min(0)
      .optional()
      .meta({ description: 'Percentages only: the records counted (e.g. 46 of 48 filled)' }),
  })
  .meta({ id: 'RecordSummary' });
export type RecordSummaryDto = z.infer<typeof recordSummarySchema>;

const recordSummaryMapSchema = z.record(z.string(), recordSummarySchema).meta({
  description:
    'Field (per `field_key_type`) → its summary. Fields the caller cannot read or that are ' +
    'locked for them, and saved entries no longer valid, are absent',
});

export const recordSummaryGroupSchema = z
  .strictObject({
    values: z.array(z.unknown()).meta({
      description:
        'Values of the group levels down to this group (outer first; cell format as in ' +
        '`records/group-counts`)',
    }),
    count: z.int().min(0),
    summaries: recordSummaryMapSchema,
  })
  .meta({ id: 'RecordSummaryGroup' });
export type RecordSummaryGroupDto = z.infer<typeof recordSummaryGroupSchema>;

export const recordSummariesResponseSchema = z
  .strictObject({
    count: z
      .int()
      .min(0)
      .meta({ description: 'Records matching (view, filter, search, read rule)' }),
    summaries: recordSummaryMapSchema,
    group: z.array(z.strictObject({ field: z.string(), direction: sortDirectionSchema })).meta({
      description: 'The group levels summarised (fields per `field_key_type`)',
    }),
    groups: z
      .array(recordSummaryGroupSchema)
      .max(MAX_GROUP_COUNT_GROUPS)
      .meta({
        description:
          'Every group of every level (an outer group before its inner ones) in the row order ' +
          `of \`records/query\`, at most ${String(MAX_GROUP_COUNT_GROUPS)}; \`[]\` without group`,
      }),
    truncated: z.boolean().meta({ description: 'More groups exist than returned' }),
  })
  .meta({ id: 'RecordSummaries' });
export type RecordSummariesResponse = z.infer<typeof recordSummariesResponseSchema>;

// --- Writes ------------------------------------------------------------------------

/**
 * `parent_id` of a record in `POST`/`PATCH …/records` (sub-records, SPEC
 * §5.7, T405): the same as writing the table's `parent` field (whatever its
 * name); `null` makes the record a root.
 */
export const recordParentIdSchema = idOf('rec')
  .nullable()
  .meta({
    description:
      'Parent record (sub-records, SPEC §5.7): same as writing the `parent` field; `null` makes ' +
      'the record a root. Not together with the `parent` field itself. A table without a ' +
      '`parent` field the caller reads answers `422 VALIDATION_FAILED` (`SUBRECORDS_NOT_ENABLED`).',
  });

const recordInputSchema = z.strictObject({
  fields: recordFieldsSchema,
  parent_id: recordParentIdSchema.optional(),
});

/**
 * `POST /tables/:tableId/records`: `{ "records": [{ "fields": … }] }` (1–1 000,
 * answered with `{ "records" }`) or a single `{ "fields": … }` (answered with
 * the record).
 */
export const createRecordsRequestSchema = z
  .strictObject({
    records: z.array(recordInputSchema).min(1).max(MAX_RECORDS_PER_REQUEST).optional(),
    fields: recordFieldsSchema.optional(),
    parent_id: recordParentIdSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.records !== undefined && value.parent_id !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['parent_id'],
        message: 'Give "parent_id" per record with "records"',
        params: { code: 'NOT_ALLOWED' },
      });
    }
    if ((value.records === undefined) === (value.fields === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: value.records === undefined ? ['records'] : ['fields'],
        message: 'Send either "records" or "fields"',
        params: { code: value.records === undefined ? 'REQUIRED' : 'NOT_ALLOWED' },
      });
    }
  })
  .meta({ id: 'CreateRecordsRequest' });
export type CreateRecordsRequest = z.infer<typeof createRecordsRequestSchema>;

const updateItemSchema = z.strictObject({
  id: recordIdSchema.optional().meta({ description: 'Required unless `upsert` is given' }),
  version: z
    .int()
    .min(1)
    .optional()
    .meta({ description: 'Optimistic check; a mismatch is `409 VERSION_CONFLICT`' }),
  fields: recordFieldsSchema,
  parent_id: recordParentIdSchema.optional(),
});

export const upsertOptionsSchema = z.strictObject({
  merge_on: z
    .array(z.string().min(1))
    .min(1)
    .max(3)
    .meta({ description: '1–3 fields of type text, number, single select or auto_number' }),
});

/**
 * `PATCH /tables/:tableId/records`: bulk update (`records[].id`, only the
 * fields that change) or, with `upsert`, create-or-update matched on
 * `upsert.merge_on` (records without `id`).
 */
export const updateRecordsRequestSchema = z
  .strictObject({
    upsert: upsertOptionsSchema.optional(),
    records: z.array(updateItemSchema).min(1).max(MAX_RECORDS_PER_REQUEST),
  })
  .superRefine((value, ctx) => {
    value.records.forEach((record, index) => {
      if (value.upsert === undefined && record.id === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['records', index, 'id'],
          message: 'Required without "upsert"',
          params: { code: 'REQUIRED' },
        });
      }
      if (value.upsert !== undefined) {
        for (const key of ['id', 'version', 'parent_id'] as const) {
          if (record[key] !== undefined) {
            ctx.addIssue({
              code: 'custom',
              path: ['records', index, key],
              message: 'Not allowed with "upsert"',
              params: { code: 'NOT_ALLOWED' },
            });
          }
        }
      }
    });
  })
  .meta({ id: 'UpdateRecordsRequest' });
export type UpdateRecordsRequest = z.infer<typeof updateRecordsRequestSchema>;

/** `PATCH /tables/:tableId/records/:recordId`. */
export const updateRecordRequestSchema = z
  .strictObject({
    version: z.int().min(1).optional(),
    fields: recordFieldsSchema,
    parent_id: recordParentIdSchema.optional(),
  })
  .meta({ id: 'UpdateRecordRequest' });
export type UpdateRecordRequest = z.infer<typeof updateRecordRequestSchema>;

/** `DELETE /tables/:tableId/records` and `POST /tables/:tableId/records/restore`. */
export const recordIdsRequestSchema = z
  .strictObject({
    ids: z.array(recordIdSchema).min(1).max(MAX_RECORDS_PER_REQUEST),
  })
  .meta({ id: 'RecordIdsRequest' });
export type RecordIdsRequest = z.infer<typeof recordIdsRequestSchema>;
