import type { Id, SummaryFunction } from '@cellhive/contracts';
import type { ResolvedBaseAccess } from '@cellhive/permissions';

/** How `fields`, `sort` and tuple filters name fields, and how records are keyed (CONTRACTS §1.3). */
export type FieldKeyType = 'name' | 'id';

/** Shape of the cell values in a read (CONTRACTS §1.3, §2). */
export type CellFormat = 'json' | 'text';

export type SortDirection = 'asc' | 'desc';

/**
 * Who reads, as already resolved by the caller (the api access service of
 * T008 loads memberships and roles and runs `resolveBaseAccess`). The record
 * services never load access themselves.
 */
export interface RecordAccessContext {
  /** Base the access was resolved for; a table of another base is `NOT_FOUND`. */
  readonly baseId: Id<'bse'>;
  /** Output of `resolveBaseAccess` for this principal and base. */
  readonly resolved: ResolvedBaseAccess;
  /**
   * Access to the **other** tables of the base, used where a read shows
   * values of another table (link titles; S4b lookups). Absent: `resolved`.
   * A share link reads its own table with the link's access and the linked
   * tables with its creator's current access (SPEC §15A.2, BACKLOG T409): a
   * table in `resolved` always uses `resolved`.
   */
  readonly relatedAccess?: ResolvedBaseAccess;
  /** Acting user; `null` for anonymous readers (share links) and the system. */
  readonly userId: Id<'usr'> | null;
  /**
   * `current_user_groups` (SPEC §6.1): user ids of every member of every group
   * the acting user belongs to.
   */
  readonly groupMemberUserIds: readonly Id<'usr'>[];
  /** IANA zone of the user/org: date filter operands and `cell_format=text`. */
  readonly timeZone: string;
  /** BCP 47 tag used by `cell_format=text` (the reader's locale). */
  readonly locale: string;
  /**
   * BCP 47 tag used by `typecast` (`"1.500.000"`, `"25/09/2026"`): the
   * base's locale, not the writer's (CONTRACTS §2), i.e. the base
   * `settings.locale`, else the organization default. Defaults to `locale`.
   */
  readonly typecastLocale?: string;
}

export interface RecordSortInput {
  /** Field name or id, per `field_key_type`. */
  readonly field: string;
  /** Default `asc`. */
  readonly direction?: SortDirection;
}

/** Options shared by list and single-record reads (CONTRACTS §1.3). */
export interface RecordReadOptions {
  /** Default `name`. */
  readonly field_key_type?: FieldKeyType;
  /** Default `json`. */
  readonly cell_format?: CellFormat;
  /** Field names or ids (per `field_key_type`); default: every field the caller can read. */
  readonly fields?: readonly string[] | null;
}

/** A record list request (SPEC §7.1, CONTRACTS §1.4 query). */
export interface RecordQueryRequest extends RecordReadOptions {
  /**
   * Saved view to read through (SPEC §7.1–7.2, CONTRACTS §1.4): its filter
   * is ANDed with the request's, its group and sort come first in ORDER BY.
   * A view of another table, hidden by `visible_views` or personal to
   * someone else is `NOT_FOUND`.
   */
  readonly view_id?: string | null;
  /** DSL (SPEC §6.1, field ids) or tuple form (CONTRACTS §3, per `field_key_type`). */
  readonly filter?: unknown;
  /**
   * Default `and`: `filter` narrows the view's saved filter. `replace`
   * (T311): `filter` takes the place of the part of the saved filter the
   * caller can read; conditions on fields they cannot read still apply.
   * Refused under a share link.
   */
  readonly filter_mode?: 'and' | 'replace';
  /**
   * Temporary group (≤ 3 levels, per `field_key_type`): replaces the view's
   * group for this request; `[]` = no grouping. Absent/`null` = the view's.
   */
  readonly group?: readonly RecordSortInput[] | null;
  readonly sort?: readonly RecordSortInput[] | null;
  /** Default `append`: `sort` after the view's saved sort; `replace` (T311) sets it aside. */
  readonly sort_mode?: 'append' | 'replace';
  /** Unaccented, case-insensitive substring of the primary field (SPEC §7.4). */
  readonly search?: string | null;
  /** Default 0. */
  readonly offset?: number;
  /** Default 200, at most 1 000. */
  readonly limit?: number;
  /** Only these records (at most 1 000), still under every other rule. */
  readonly ids?: readonly string[] | null;
  /** Default `true`; `false` skips the count (no `total`/`total_estimate`). */
  readonly include_total?: boolean;
}

/**
 * Who a read through a view is for (CONTRACTS §1.4):
 *
 * - `member` (default): a signed-in member. Saved conditions on fields
 *   that were deleted (or no longer validate) are ignored; `hidden_fields`
 *   of the view do not narrow the response.
 * - `share_link` (T305): the view is the scope of the link and fails
 *   closed — a saved filter naming a deleted field (or no longer valid)
 *   matches no record, and fields hidden in the view are treated as
 *   nonexistent (never returned, filtered, sorted, grouped or searched on).
 *   Callers pass the link's `recordAccess` (T304 `ShareLinkResolver`, whose
 *   read rule already ANDs the view filter and fails closed the same way)
 *   with `view_id` = the link's view.
 */
export type RecordViewScope = 'member' | 'share_link';

export interface RecordQueryOptions {
  /** Default `member`. */
  readonly viewScope?: RecordViewScope;
}

/** `POST …/records/group-counts` (CONTRACTS §1.4). */
export interface RecordGroupCountsRequest {
  /** Default `name`: how `group[].field` is named in the request and the response. */
  readonly field_key_type?: FieldKeyType;
  /** Default `json`: shape of the group values. */
  readonly cell_format?: CellFormat;
  readonly view_id?: string | null;
  readonly filter?: unknown;
  /** As {@link RecordQueryRequest.filter_mode}. */
  readonly filter_mode?: 'and' | 'replace';
  readonly search?: string | null;
  /** Replaces the view's group (≤ 3 levels); absent/`null` = the view's group. */
  readonly group?: readonly RecordSortInput[] | null;
}

export interface RecordGroupCount {
  /** One value per group level, serialized like a cell (`cell_format`). */
  readonly values: unknown[];
  readonly count: number;
}

export interface RecordGroupCountsOutput {
  /** The group levels counted, fields per `field_key_type`. */
  readonly group: { readonly field: string; readonly direction: SortDirection }[];
  /** Groups in row order (the ORDER BY of the query), at most 10 000. */
  readonly groups: RecordGroupCount[];
  /** More groups exist than returned. */
  readonly truncated: boolean;
}

/** `POST …/records/summaries` (T472, CONTRACTS §1.4): group counts' parameters plus `summaries`. */
export interface RecordSummariesRequest extends RecordGroupCountsRequest {
  /**
   * Field (per `field_key_type`) → function, replacing the view's saved
   * `config.summaries` for this request; absent/`null` = the view's.
   */
  readonly summaries?: Readonly<Record<string, SummaryFunction>> | null;
}

/** One summary of one field (CONTRACTS §1.4 `RecordSummary`). */
export interface RecordSummary {
  readonly fn: SummaryFunction;
  readonly value: unknown;
  /** Percentages only: the records behind the share. */
  readonly count?: number;
}

export interface RecordSummaryGroup {
  /** Values of the group levels down to this group, outer first (like group counts). */
  readonly values: unknown[];
  readonly count: number;
  readonly summaries: Record<string, RecordSummary>;
}

export interface RecordSummariesOutput {
  /** Records matching. */
  readonly count: number;
  /** Field (per `field_key_type`) → summary over every matching record. */
  readonly summaries: Record<string, RecordSummary>;
  readonly group: { readonly field: string; readonly direction: SortDirection }[];
  /** Every group of every level, an outer group before its inner ones, in row order. */
  readonly groups: RecordSummaryGroup[];
  readonly truncated: boolean;
}

/** One record as returned by the API (CONTRACTS §1.4). */
export interface RecordOutput {
  readonly id: Id<'rec'>;
  /** ISO 8601 UTC. */
  readonly created_at: string;
  readonly updated_at: string;
  readonly version: number;
  /**
   * Keyed by field name or id. Fields the caller cannot read are absent
   * (never `null`, CONTRACTS §2).
   */
  readonly fields: Record<string, unknown>;
  /**
   * Read through a view whose color rules apply to the reader (T816,
   * CONTRACTS §1.4): the rules that won the row and its cells.
   */
  readonly meta?: { readonly color: RecordColorOutput };
}

/** `meta.color` of a record (T816): rule ids, cells keyed by field id. */
export interface RecordColorOutput {
  readonly row?: Id<'clr'>;
  readonly cells?: Readonly<Record<Id<'fld'>, Id<'clr'>>>;
}

interface RecordPage {
  readonly records: RecordOutput[];
  readonly offset: number;
  readonly limit: number;
}

/**
 * `{ records, total | total_estimate, offset, limit }` (CONTRACTS §1.1):
 * exactly one of `total` (≤ 100 000 matching rows) and `total_estimate`,
 * or neither when the request set `include_total: false`.
 */
export type RecordListOutput =
  | (RecordPage & { readonly total: number })
  | (RecordPage & { readonly total_estimate: number })
  | RecordPage;

/** `GET …/records/trash` (CONTRACTS §11.3). */
export interface RecordTrashRequest {
  /** Default `name`. */
  readonly field_key_type?: FieldKeyType;
  /** `next_cursor` of the previous page. */
  readonly cursor?: string;
  /** Default 50, at most 200. */
  readonly limit?: number;
}

export interface TrashedRecordOutput extends RecordOutput {
  readonly deleted_at: string;
  /** Who moved the record to the trash; `null` for the system. `name` is `null` for non-members. */
  readonly deleted_by: { readonly id: Id<'usr'>; readonly name: string | null } | null;
  /** Sub-records (T405): descendants deleted together with it; absent when none. */
  readonly branch_size?: number;
}

// ---------------------------------------------------------------------------
// Sub-record trees (CONTRACTS §1.4, BACKLOG T405)

/** `POST …/records/tree`: one level of the visible tree (roots, or the children of `parent_id`). */
export interface RecordTreeRequest extends RecordReadOptions {
  readonly view_id?: string | null;
  /** Absent/`null`: roots; else the children of this record in the visible tree. */
  readonly parent_id?: string | null | undefined;
  readonly filter?: unknown;
  readonly filter_mode?: 'and' | 'replace';
  /** Among siblings, after the view sort (per `sort_mode`). */
  readonly sort?: readonly RecordSortInput[] | null;
  readonly sort_mode?: 'append' | 'replace';
  readonly search?: string | null;
  /** Default: the view's `tree.show_ancestors`, else `true`. */
  readonly show_ancestors?: boolean;
  readonly offset?: number;
  readonly limit?: number;
  readonly include_total?: boolean;
}

/** Where a record of a tree page sits (CONTRACTS §1.4). */
export interface RecordTreeNode {
  readonly parent_id: Id<'rec'> | null;
  readonly depth: number;
  readonly children_count: number;
  readonly ancestor_only: boolean;
}

export interface TreeRecordOutput extends RecordOutput {
  readonly tree: RecordTreeNode;
}

interface TreePage {
  readonly records: TreeRecordOutput[];
  readonly offset: number;
  readonly limit: number;
}

export type RecordTreeOutput =
  | (TreePage & { readonly total: number })
  | (TreePage & { readonly total_estimate: number })
  | TreePage;

/** `GET …/records/:recordId/children`. */
export interface RecordChildrenRequest extends RecordReadOptions {
  readonly offset?: number;
  readonly limit?: number;
}

/** One ancestor, root first (`GET …/records/:recordId/ancestors`). */
export interface RecordAncestorOutput {
  readonly id: Id<'rec'> | null;
  readonly title: string | null;
  readonly locked: boolean;
}

export interface RecordTrashOutput {
  readonly records: TrashedRecordOutput[];
  readonly next_cursor: string | null;
}

// ---------------------------------------------------------------------------
// Writes (CONTRACTS §1.4, SPEC §7.3)

/** Options shared by every write (CONTRACTS §1.3). */
export interface RecordWriteOptions {
  /** How `fields` are keyed in the request and the response. Default `name`. */
  readonly field_key_type?: FieldKeyType;
  /** Accept the extra input forms of CONTRACTS §2 (`"1.500.000"`, option names, emails…). Default `false`. */
  readonly typecast?: boolean;
}

/** Cell values keyed by field name or id (per `field_key_type`). */
export type RecordFieldsInput = Readonly<Record<string, unknown>>;

export interface RecordCreateRequest extends RecordWriteOptions {
  /** 1–1 000 records; `parent_id`: the parent (sub-records, T405), like the `parent` field. */
  readonly records: readonly {
    readonly fields: RecordFieldsInput;
    readonly parent_id?: string | null | undefined;
  }[];
}

export interface RecordUpdateInput {
  readonly id: string;
  /** Optimistic concurrency: a mismatch is `409 VERSION_CONFLICT`. */
  readonly version?: number;
  /** Only the fields that change. */
  readonly fields: RecordFieldsInput;
  /** New parent (sub-records, T405), like writing the `parent` field; absent: unchanged. */
  readonly parent_id?: string | null | undefined;
}

export interface RecordUpdateRequest extends RecordWriteOptions {
  /** 1–1 000 records. */
  readonly records: readonly RecordUpdateInput[];
}

export interface RecordUpsertRequest extends RecordWriteOptions {
  /** 1–3 fields of type text, number, single select or auto_number (per `field_key_type`). */
  readonly merge_on: readonly string[];
  /** 1–1 000 records. */
  readonly records: readonly { readonly fields: RecordFieldsInput }[];
}

/** Soft delete (`DELETE …/records`) and restore (`POST …/records/restore`). */
export interface RecordIdsRequest {
  /** 1–1 000 record ids. */
  readonly ids: readonly string[];
  /**
   * Delete only (sub-records, T405): `promote` (default) makes the children
   * of deleted records roots; `delete` trashes their branches too.
   */
  readonly children?: 'promote' | 'delete';
  /** Restore only (T405): also restore the descendants deleted together with each record. */
  readonly branch?: boolean;
}

/**
 * Records as read back after the write (CONTRACTS §1.4), in request order.
 * A record the caller can no longer read after the write is left out.
 */
export interface RecordMutationOutput {
  readonly records: RecordOutput[];
}

export interface RecordUpsertOutput extends RecordMutationOutput {
  readonly created_ids: Id<'rec'>[];
  readonly updated_ids: Id<'rec'>[];
}

export interface RecordDeleteOutput {
  /** Ids moved to the trash, in request order. */
  readonly ids: Id<'rec'>[];
}

/** A streamed read of every matching record (exports, BACKLOG T307). */
export interface RecordStreamRequest {
  /** Saved view to read through (same rules as {@link RecordQueryRequest.view_id}). */
  readonly view_id?: string | null;
  /** Default `text` (what a file shows). */
  readonly cell_format?: CellFormat;
}

export interface RecordStreamOptions {
  /**
   * Most rows the stream yields. The row count taken when the stream opens
   * stops at `maxRows + 1` (see {@link RecordStream.exceedsMaxRows}).
   */
  readonly maxRows: number;
  /** Rows per statement; default `RECORD_STREAM_BATCH_SIZE`. */
  readonly batchSize?: number;
  /**
   * Aborting stops the stream: the statement in flight is cancelled
   * (`pg_cancel_backend` of its own transaction) and no further batch runs.
   */
  readonly signal?: AbortSignal;
  /**
   * Runs once the table and the view are known to be visible to the caller,
   * before anything is counted or read: permission checks that must come
   * after the `404`s (e.g. `base_rule.download`, concurrency limits).
   */
  readonly beforeRead?: (target: RecordStreamTarget) => Promise<void> | void;
  /**
   * How the view is read (default `member`). `share_link` (T810): the view
   * filter fails closed and the fields hidden in the view are out of reach,
   * as for the other reads of a share link.
   */
  readonly viewScope?: RecordViewScope;
  /**
   * Locale and zone of the `cell_format=text` values when they are not the
   * access context's (T810: the viewer of a share link formats the values,
   * while date filter operands keep the zone of the link's creator).
   */
  readonly display?: { readonly locale: string; readonly timeZone: string };
}

export interface RecordStreamTarget {
  readonly table: { readonly id: Id<'tbl'>; readonly name: string };
  readonly view: { readonly id: Id<'viw'>; readonly name: string } | null;
}

/** A column of a stream: a field the caller reads, in view order. */
export interface RecordStreamField {
  readonly id: Id<'fld'>;
  readonly name: string;
  readonly type: string;
}

export interface RecordStream extends RecordStreamTarget {
  /** Columns, fixed when the stream opens: `fields` of each record are keyed by these ids. */
  readonly fields: readonly RecordStreamField[];
  /** Matching rows when the stream opened (at most `maxRows + 1`). */
  readonly rowCount: number;
  /** `rowCount > maxRows`: the caller should refuse rather than stream a cut file. */
  readonly exceedsMaxRows: boolean;
  /**
   * The records, a few hundred per chunk. Each call starts a new read; a
   * field that became unreadable or was deleted after opening is left out
   * of the records that follow (never returned).
   */
  records(): AsyncGenerator<RecordOutput[], void, undefined>;
}
