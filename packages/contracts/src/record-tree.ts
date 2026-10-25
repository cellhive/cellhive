import { z } from 'zod';

import { idOf } from './ids.js';
import { linkRefSchema } from './links.js';
import { DEFAULT_RECORD_LIMIT, MAX_LIST_LIMIT, recordListSchema } from './pagination.js';
import {
  cellFormatSchema,
  fieldKeyTypeSchema,
  MAX_RECORD_SEARCH_LENGTH,
  MAX_RECORD_SORT_KEYS,
  MAX_RECORDS_PER_REQUEST,
  recordFilterModeSchema,
  recordFilterSchema,
  recordSchema,
  recordSortModeSchema,
  recordSortSchema,
} from './records.js';

/**
 * Sub-records (SPEC §5.7; CONTRACTS §1.4, §2, §11.3, §13; BACKLOG T405): a
 * table with a `parent` field is a tree. The options and cell values are
 * validated by `@cellhive/field-types` (`parentOptionsSchema`,
 * `SUBRECORD_MAX_DEPTH`); the schemas here document the API shapes.
 */

/** Most levels of a sub-record tree (`SUBRECORD_MAX_DEPTH` of `@cellhive/field-types`). */
export const SUBRECORD_MAX_LEVELS = 10;

/** `options` of a `parent` field: none. */
export const parentFieldOptionsSchema = z.strictObject({}).meta({ id: 'ParentFieldOptions' });

/** A parent cell in a read: `{ id, title }` (`title = null` when unreadable, P20) or `null`. */
export const parentCellSchema = linkRefSchema.nullable().meta({ id: 'ParentCell' });
export type ParentCell = z.infer<typeof parentCellSchema>;

/** A parent cell in a write: a record id (a title with `typecast=true`), or `null` for a root. */
export const parentCellWriteSchema = z
  .union([idOf('rec'), z.looseObject({ id: idOf('rec') }), z.string()])
  .nullable()
  .meta({ id: 'ParentCellWrite' });
export type ParentCellWrite = z.infer<typeof parentCellWriteSchema>;

// --- Tree query (CONTRACTS §1.4) ---------------------------------------------------

const viewIdSchema = z
  .string()
  .min(1)
  .meta({
    description:
      "Read through this saved view (filter, sort, `tree.show_ancestors`); the view's group " +
      'is ignored (a tree is never grouped). A view the caller cannot see is `404`.',
  });

/** Body of `POST /tables/:tableId/records/tree`. */
export const recordTreeRequestSchema = z
  .strictObject({
    view_id: viewIdSchema.nullish(),
    parent_id: idOf('rec')
      .nullish()
      .meta({
        description:
          'Absent/`null`: the roots of the visible tree. A record id: its children in the ' +
          'visible tree (a branch the grid expands). A parent the caller cannot read, in the ' +
          'trash or outside the visible tree is `404`.',
      }),
    fields: z.array(z.string().min(1)).max(MAX_LIST_LIMIT).nullish(),
    filter: recordFilterSchema.nullish(),
    filter_mode: recordFilterModeSchema.optional(),
    sort: z
      .array(recordSortSchema)
      .max(MAX_RECORD_SORT_KEYS)
      .nullish()
      .meta({ description: 'Applies among siblings (after the view sort, per `sort_mode`)' }),
    sort_mode: recordSortModeSchema.optional(),
    search: z.string().max(MAX_RECORD_SEARCH_LENGTH).nullish(),
    show_ancestors: z
      .boolean()
      .optional()
      .meta({
        description:
          'With a filter or search: also show the ancestors of matching records (flagged ' +
          "`ancestor_only`). Default: the view's `tree.show_ancestors`, else `true`.",
      }),
    offset: z.int().min(0).default(0),
    limit: z.int().min(1).max(MAX_LIST_LIMIT).default(DEFAULT_RECORD_LIMIT),
    include_total: z
      .boolean()
      .default(true)
      .meta({ description: '`false` skips counting the siblings of the page' }),
  })
  .meta({ id: 'RecordTreeRequest' });
export type RecordTreeRequest = z.infer<typeof recordTreeRequestSchema>;

/** Where a record of a tree page sits in the visible tree. */
export const recordTreeNodeSchema = z
  .strictObject({
    parent_id: idOf('rec')
      .nullable()
      .meta({
        description:
          'Parent in the visible tree; `null` for a root, including a record whose parent the ' +
          'caller cannot read or that is in the trash (shown as a root)',
      }),
    depth: z
      .int()
      .min(0)
      .max(SUBRECORD_MAX_LEVELS - 1)
      .meta({ description: '0 for a root' }),
    children_count: z
      .int()
      .min(0)
      .meta({
        description:
          'Children in the visible tree: readable, live and (with a filter) matching or ' +
          'ancestors of a match; never counts records the caller cannot read',
      }),
    ancestor_only: z.boolean().meta({
      description:
        'Shown only as an ancestor of a record that matches the filter/search (UI: dimmed)',
    }),
  })
  .meta({ id: 'RecordTreeNode' });
export type RecordTreeNode = z.infer<typeof recordTreeNodeSchema>;

export const treeRecordSchema = recordSchema
  .extend({ tree: recordTreeNodeSchema })
  .meta({ id: 'TreeRecord' });
export type TreeRecordDto = z.infer<typeof treeRecordSchema>;

/** `{ records, total | total_estimate, offset, limit }` of one level of the tree. */
export const recordTreeResponseSchema = recordListSchema(treeRecordSchema).meta({
  id: 'RecordTree',
});
export type RecordTreeResponse = z.infer<typeof recordTreeResponseSchema>;

// --- Children and ancestors ---------------------------------------------------------

const listParam = z
  .union([z.string().min(1), z.array(z.string().min(1)).max(MAX_LIST_LIMIT)])
  .transform((value) => (Array.isArray(value) ? value : [value]));

/** `GET /tables/:tableId/records/:recordId/children`. */
export const recordChildrenQuerySchema = z.object({
  field_key_type: fieldKeyTypeSchema.default('name'),
  cell_format: cellFormatSchema.default('json'),
  fields: listParam.optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(MAX_LIST_LIMIT).default(DEFAULT_RECORD_LIMIT),
});
export type RecordChildrenQuery = z.infer<typeof recordChildrenQuerySchema>;

/** One ancestor of a record, root first (`GET …/records/:recordId/ancestors`). */
export const recordAncestorSchema = z
  .strictObject({
    id: idOf('rec')
      .nullable()
      .meta({ description: '`null` for an ancestor the caller cannot read (`locked`)' }),
    title: z.string().nullable().meta({
      description: 'Primary field as text; `null` when locked or the primary field is hidden',
    }),
    locked: z.boolean().meta({
      description: 'The caller cannot read this ancestor: a placeholder without id or title',
    }),
  })
  .meta({ id: 'RecordAncestor' });
export type RecordAncestorDto = z.infer<typeof recordAncestorSchema>;

export const recordAncestorsResponseSchema = z
  .strictObject({
    items: z.array(recordAncestorSchema).max(SUBRECORD_MAX_LEVELS - 1),
  })
  .meta({ id: 'RecordAncestors' });
export type RecordAncestorsResponse = z.infer<typeof recordAncestorsResponseSchema>;

// --- Delete and restore (CONTRACTS §1.4, §11.3) ------------------------------------

/**
 * What happens to the children of a deleted record (SPEC §5.7, BACKLOG S4
 * open question #11): `promote` (default) makes them roots (`parent = null`,
 * a `record.updated` each); `delete` moves the whole branch to the trash.
 */
export const SUBRECORD_DELETE_MODES = ['promote', 'delete'] as const;
export const subrecordDeleteModeSchema = z.enum(SUBRECORD_DELETE_MODES).meta({
  description:
    '`promote` (default): children of deleted records become roots. `delete`: descendants the ' +
    'caller may delete go to the trash too (same request, same `batch_id`); a descendant the ' +
    'caller cannot delete becomes a root with its own branch.',
});
export type SubrecordDeleteMode = z.infer<typeof subrecordDeleteModeSchema>;

const idsSchema = z.array(idOf('rec')).min(1).max(MAX_RECORDS_PER_REQUEST);

/** `DELETE /tables/:tableId/records`. */
export const deleteRecordsRequestSchema = z
  .strictObject({ ids: idsSchema, children: subrecordDeleteModeSchema.optional() })
  .meta({ id: 'DeleteRecordsRequest' });
export type DeleteRecordsRequest = z.infer<typeof deleteRecordsRequestSchema>;

/** `POST /tables/:tableId/records/restore`. */
export const restoreRecordsRequestSchema = z
  .strictObject({
    ids: idsSchema,
    branch: z
      .boolean()
      .optional()
      .meta({
        description:
          '`true`: also restore the descendants deleted together with each record ("delete ' +
          'whole branch", same deletion time and `batch_id`) that the caller may restore',
      }),
  })
  .meta({ id: 'RestoreRecordsRequest' });
export type RestoreRecordsRequest = z.infer<typeof restoreRecordsRequestSchema>;

/** `DELETE /tables/:tableId/records/:recordId?children=`. */
export const deleteRecordQuerySchema = z.object({
  children: subrecordDeleteModeSchema.optional(),
});
export type DeleteRecordQuery = z.infer<typeof deleteRecordQuerySchema>;
