import { randomUUID } from 'node:crypto';

import {
  DEFAULT_CURSOR_LIMIT,
  DEFAULT_RECORD_LIMIT,
  EXACT_TOTAL_THRESHOLD,
  INVALID_FILTER_VALUE,
  MAX_CURSOR_LIMIT,
  idOf,
  isId,
  MAX_GROUP_COUNT_GROUPS,
  MAX_LIST_LIMIT,
  MAX_QUERY_IDS,
  MAX_RECORD_GROUP_LEVELS,
  type AiCellState,
  type FilterControlKind,
  type Id,
  type ProblemErrorItem,
  SummaryFunction,
  type WidgetGroupKey,
} from '@cellhive/contracts';
import {
  type LinkRef,
  type LocaleContext,
  type ReadContext,
  type SelectOptions,
  type UserRef,
} from '@cellhive/field-types';
import {
  joinPath,
  MAX_TEXT_VALUE_LENGTH,
  parseFilterInput,
  resolveVariables,
  type FilterIssue,
  type FilterNode,
  type ResolveContext,
  type ResolvedFilterNode,
} from '@cellhive/filter-dsl';
import { permissionFingerprintMaterial, type TableAccess } from '@cellhive/permissions';
import { sql, type RawBuilder, type SqlBool } from 'kysely';
import { z } from 'zod';

import { aiFieldLocked, isAiField } from '../ai/generation/options.js';
import { AiGenerationQueueRepository } from '../ai/generation/queue.repository.js';
import { ComputeModel } from '../computed/definition/compute-model.js';
import { loadBaseSchemaRows } from '../computed/definition/schema-rows.js';
import { runComputedPreview, type ComputedPreviewRow } from '../computed/preview/preview.js';
import { REQUEST_STATEMENT_TIMEOUT_MS, type Db, type Tx } from '../db/create-db.js';
import { afterCursor, cursorTimestamp, decodeCursor, pageWithCursor } from '../db/cursor.js';
import { isStatementTimeout, SQLSTATE, sqlStateOf } from '../db/pg-errors.js';
import { BasesRepository } from '../db/repositories/bases.repository.js';
import { isOrgScope, withTxScope, type OrgScope } from '../db/repository.js';
import { AppError } from '../errors/app-error.js';
import { formatIssuePath, zodIssuesToProblemErrors } from '../errors/zod-issues.js';
import { viewerSourceScope } from '../formula/cross/scope.js';
import { compileToSql } from '../query/index.js';
import { FieldsRepository } from '../schema/fields.repository.js';
import { assertDataTableName, DATA_SCHEMA } from '../schema/names.js';
import { HARD_MAX_FIELDS_PER_TABLE } from '../schema/policy.js';
import { TablesRepository } from '../schema/tables.repository.js';
import { hiddenFilterOf } from '../views/view-config.js';
import { ViewsRepository } from '../views/views.repository.js';

import {
  ButtonCellResolver,
  toButtonFieldModel,
  type ButtonFieldModel,
  type ButtonRecordMatcher,
} from './buttons/button-cells.js';
import {
  colorOfRow,
  colorRulePlan,
  colorRuleSelect,
  type ColorRulePlan,
} from './color-rules/evaluate.js';
import {
  ComputedCellReader,
  ComputedReadPlanner,
  computedCellValue,
  computedColumnAlias,
  computedSortKey,
  computedSortKeyMayTie,
  EMPTY_COMPUTED_CELL_DATA,
  strictComputedPermissionsOf,
  type ComputedCellData,
  type ComputedField,
} from './computed/read/index.js';
import {
  scanColumnBatch,
  type ColumnScanRequest,
  type ColumnScanRow,
} from './conversions/column-scan.js';
import {
  scanComputedBatch,
  type ComputedScanRequest,
  type ComputedScanRow,
} from './conversions/computed-source.js';
import {
  aggregateWidget,
  BROKEN as BROKEN_WIDGET,
  controlOptions,
  dimensionStatus,
  NO_PERMISSION as NO_PERMISSION_WIDGET,
  segmentCondition,
  type ControlOptionsResult,
  type WidgetAggregateInput,
  type WidgetAggregateResult,
  type WidgetSource,
} from './dashboard-aggregate/aggregate.js';
import { widgetCacheKey } from './dashboard-aggregate/cache.js';
import {
  controlFilterOf,
  type IgnoredLiveFilter,
  type SegmentLiveFilter,
  type WidgetLiveFilter,
} from './dashboard-aggregate/live-filters.js';
import { widgetQueryFieldIds, type WidgetQuery } from './dashboard-aggregate/widget-query.js';
import {
  dueValueKindOf,
  dueValueText,
  type DueScanPage,
  type DueScanRequest,
  type DueScanRow,
} from './due/due-scan.js';
import {
  createSystemScanAccess,
  isSystemScanAccess,
  systemScanContextOf,
  systemScanFieldIds,
  type SystemScanAccess,
} from './due/system-scan.js';
import {
  LinkCandidateReader,
  type LinkCandidatesInput,
  type LinkCandidatesOutput,
} from './links/link-candidates.js';
import {
  backupCellIds,
  scanLinkCellCounts,
  type LinkCellCountRow,
} from './links/link-conversion.js';
import { LinkFilterMeta, rulesOf } from './links/link-filters.js';
import { toLinkFieldModel } from './links/link-model.js';
import { LinkCellReader, linkCellValue, type LinkCells } from './links/link-reader.js';
import { LinkTargets } from './links/link-targets.js';
import { MemberDirectoryRepository } from './member-directory.repository.js';
import { summarize } from './summaries/summaries.js';
import {
  buildTableModel,
  readable as fieldReadable,
  resolveRule,
  ruleSql,
  type FieldModel,
  type TableModel,
} from './table-model.js';
import { subrecordsNotEnabled } from './tree/parent-writer.js';
import {
  ParentCellReader,
  parentCellValue,
  parentDepthSql,
  treeLevelSql,
  trashedBranchSizes,
  type TreeLevelInput,
} from './tree/tree-reader.js';
import {
  isOrderable,
  loadQueryView,
  viewFilterOf,
  viewOrderOf,
  type OrderField,
  type QueryView,
  type ViewOrderItem,
} from './view-scope.js';

import type { LinkFieldModel } from './links/link-model.js';
import type { ParentFieldModel } from './tree/parent-model.js';
import type {
  CellFormat,
  FieldKeyType,
  RecordAccessContext,
  RecordAncestorOutput,
  RecordChildrenRequest,
  RecordGroupCountsOutput,
  RecordGroupCountsRequest,
  RecordListOutput,
  RecordOutput,
  RecordQueryOptions,
  RecordQueryRequest,
  RecordReadOptions,
  RecordStream,
  RecordStreamField,
  RecordStreamOptions,
  RecordStreamRequest,
  RecordStreamTarget,
  RecordSummariesOutput,
  RecordSummariesRequest,
  RecordTrashOutput,
  RecordTrashRequest,
  RecordTreeOutput,
  RecordTreeRequest,
  RecordViewScope,
  SortDirection,
  TrashedRecordOutput,
} from './types.js';
import type { FieldConversionRow, FieldRow, TableRow } from '../db/schema.js';
import type { FormulaAnalysis } from '@cellhive/formula-engine';

/** Most sort keys one request may give (the `__auto` tie-breaker is added on top). */
export const MAX_SORT_FIELDS = 10;
/** Longest `search` string, in characters (the filter text operand limit). */
export const MAX_SEARCH_LENGTH = MAX_TEXT_VALUE_LENGTH;

export interface RecordQueryServiceOptions {
  /**
   * `statement_timeout` of each read, in milliseconds (SPEC §7.2); default
   * `REQUEST_STATEMENT_TIMEOUT_MS` (10 s). A cancelled statement becomes
   * `504 QUERY_TIMEOUT`. Ignored when the scope carries a transaction: the
   * caller's transaction keeps its own timeout.
   */
  readonly statementTimeoutMs?: number;
  /**
   * Largest row count reported as an exact `total`; above it the list carries
   * `total_estimate` (SPEC §7.1). Default `EXACT_TOTAL_THRESHOLD` (100 000);
   * tests lower it.
   */
  readonly exactTotalThreshold?: number;
  /** Clock for date operands (`today`, `days_ago`…); tests pin it. */
  readonly now?: () => Date;
  /**
   * Zone of computed values when the organization has none (ADR-21,
   * `defaults.timezone`); default `UTC`.
   */
  readonly defaultTimeZone?: string;
  /**
   * Locale of `run_as` when neither the user nor the organization has one
   * (`defaults.locale`; button cells, T517); default `en`.
   */
  readonly defaultLocale?: string;
}

/** Alias of the data table in every statement. Code constant, never user input. */
const ALIAS = 't';

// ---------------------------------------------------------------------------
// Request shape. The HTTP layer (T108) validates the public contract with the
// zod schemas of `@cellhive/contracts`; this is the service's own guard for
// callers inside the server (automations, exports, share links…).

const fieldKeyTypeSchema = z.enum(['name', 'id']).default('name');
const cellFormatSchema = z.enum(['json', 'text']).default('json');
const fieldListSchema = z.array(z.string().min(1)).max(HARD_MAX_FIELDS_PER_TABLE).nullish();

const readOptionsSchema = z.object({
  field_key_type: fieldKeyTypeSchema,
  cell_format: cellFormatSchema,
  fields: fieldListSchema,
});

const sortItemSchema = z.object({
  field: z.string().min(1),
  direction: z.enum(['asc', 'desc']).default('asc'),
});
const groupSchema = z.array(sortItemSchema).max(MAX_RECORD_GROUP_LEVELS).nullish();

/** `filter_mode` / `sort_mode` of a read through a view (CONTRACTS §1.4, T311). */
const filterModeSchema = z.enum(['and', 'replace']).default('and');
const sortModeSchema = z.enum(['append', 'replace']).default('append');

const querySchema = readOptionsSchema.extend({
  view_id: z.string().nullish(),
  filter: z.unknown().optional(),
  filter_mode: filterModeSchema,
  group: groupSchema,
  sort: z.array(sortItemSchema).max(MAX_SORT_FIELDS).nullish(),
  sort_mode: sortModeSchema,
  search: z.string().max(MAX_SEARCH_LENGTH).nullish(),
  offset: z.int().min(0).default(0),
  limit: z.int().min(1).max(MAX_LIST_LIMIT).default(DEFAULT_RECORD_LIMIT),
  ids: z.array(idOf('rec')).max(MAX_QUERY_IDS).nullish(),
  include_total: z.boolean().default(true),
});

/** `records/tree` (CONTRACTS §1.4, T405): one level of the visible tree. */
const treeSchema = readOptionsSchema.extend({
  view_id: z.string().nullish(),
  parent_id: idOf('rec').nullish(),
  filter: z.unknown().optional(),
  filter_mode: filterModeSchema,
  sort: z.array(sortItemSchema).max(MAX_SORT_FIELDS).nullish(),
  sort_mode: sortModeSchema,
  search: z.string().max(MAX_SEARCH_LENGTH).nullish(),
  show_ancestors: z.boolean().optional(),
  offset: z.int().min(0).default(0),
  limit: z.int().min(1).max(MAX_LIST_LIMIT).default(DEFAULT_RECORD_LIMIT),
  include_total: z.boolean().default(true),
});

const childrenSchema = readOptionsSchema.extend({
  offset: z.int().min(0).default(0),
  limit: z.int().min(1).max(MAX_LIST_LIMIT).default(DEFAULT_RECORD_LIMIT),
});

const groupCountsSchema = z.object({
  field_key_type: fieldKeyTypeSchema,
  cell_format: cellFormatSchema,
  view_id: z.string().nullish(),
  filter: z.unknown().optional(),
  filter_mode: filterModeSchema,
  search: z.string().max(MAX_SEARCH_LENGTH).nullish(),
  group: groupSchema,
});

/** `records/summaries` (T472): the group counts' parameters plus `summaries`. */
const summariesSchema = groupCountsSchema.extend({
  summaries: z.record(z.string().min(1), z.string()).nullish(),
});

const streamSchema = z.object({
  view_id: z.string().nullish(),
  cell_format: z.enum(['json', 'text']).default('text'),
});

/** What narrows the records of a read beyond the read rule (shared by query and group counts). */
interface Scoping {
  readonly view_id?: string | null | undefined;
  readonly filter?: unknown;
  /** `replace`: `filter` takes the place of the part of the view filter the caller sees. */
  readonly filter_mode?: 'and' | 'replace';
  readonly search?: string | null | undefined;
  readonly field_key_type: FieldKeyType;
}

const trashSchema = z.object({
  field_key_type: fieldKeyTypeSchema,
  cursor: z.string().min(1).optional(),
  limit: z.int().min(1).max(MAX_CURSOR_LIMIT).default(DEFAULT_CURSOR_LIMIT),
});

function parseRequest<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', {
      detail: 'The record query is invalid.',
      errors: zodIssuesToProblemErrors(parsed.error.issues),
    });
  }
  return parsed.data;
}

const notFound = () => new AppError('NOT_FOUND', { detail: 'The table does not exist.' });
/** `422` for a live filter value of a dashboard that cannot apply (T808). */
const invalidFilterValue = (path: string, message: string) =>
  new AppError('VALIDATION_FAILED', {
    detail: 'A filter value does not fit.',
    errors: [{ path, code: INVALID_FILTER_VALUE, message }],
  });
const recordNotFound = () => new AppError('NOT_FOUND', { detail: 'The record does not exist.' });

const unknownField = (path: string): ProblemErrorItem => ({
  path,
  code: 'UNKNOWN_FIELD',
  // Same message for a hidden field and a missing one (CONTRACTS §6).
  message: 'Field does not exist',
});

/** A readable field of a type that cannot be ordered (link, T401): `INVALID_SORT`. */
const notSortable = (path: string): ProblemErrorItem => ({
  path,
  code: 'FIELD_NOT_SORTABLE',
  message: 'This field cannot be sorted or grouped',
});

/** The issue of a sort/group key naming no sortable field: a readable link or parent, or unknown. */
function sortKeyIssue(
  model: TableModel,
  key: string,
  keyType: FieldKeyType,
  path: string,
): ProblemErrorItem {
  const relations = [
    ...model.visibleLinks,
    ...(model.visibleParent === null ? [] : [model.visibleParent]),
  ];
  const relation = relations.some((field) => (keyType === 'id' ? field.id : field.name) === key);
  return relation ? notSortable(path) : unknownField(path);
}

// ---------------------------------------------------------------------------
// SQL fragments. Identifiers only from meta through `sql.id`; values bound.

const col = (column: string) => sql.id(ALIAS, column);

/** `display_name` of an org member, `NULL` for anyone else (sort key of user cells). */
function memberNameOf(userId: RawBuilder<unknown>, organizationId: Id<'org'>) {
  return sql`(SELECT u.display_name FROM meta.users AS u JOIN meta.org_members AS m ON m.user_id = u.id WHERE m.organization_id = ${organizationId} AND u.id = ${userId})`;
}

function sortKey(field: OrderField, organizationId: Id<'org'>): RawBuilder<unknown> {
  // Formula/lookup (T457): its value, not a column.
  if ('computed' in field) return computedSortKey(field, field.value(ALIAS), organizationId);
  const ref = col(field.column);
  switch (field.type) {
    case 'select': {
      // Option order of the field, not option ids (first option for multi-select).
      const ids = (field.options as SelectOptions).options.map((option) => option.id);
      return sql`array_position(${sql.val(ids)}::text[], (${ref})[1])`;
    }
    case 'user':
      return memberNameOf(sql`(${ref})[1]`, organizationId);
    case 'created_by':
    case 'updated_by':
      return memberNameOf(ref, organizationId);
    default:
      // text/auto_number sort under the table collation the column carries.
      return ref;
  }
}

const DIRECTION: Readonly<Record<SortDirection, RawBuilder<unknown>>> = {
  asc: sql`ASC NULLS LAST`,
  desc: sql`DESC NULLS LAST`,
};

/** One ORDER BY term: an expression and its direction (empty cells last either way). */
interface OrderTerm {
  readonly expr: RawBuilder<unknown>;
  readonly direction: SortDirection;
}

/** `<expr> ASC|DESC NULLS LAST`. */
function renderTerm(term: OrderTerm): RawBuilder<unknown> {
  return sql`${term.expr} ${DIRECTION[term.direction]}`;
}

/** The ORDER BY term of a sort item. */
function orderTerm(item: ViewOrderItem, organizationId: Id<'org'>): OrderTerm {
  return { expr: sortKey(item.field, organizationId), direction: item.direction };
}

/**
 * ORDER BY terms of a group level: the sort key, then the stored value when
 * the sort key can tie for different values (select by first option, user
 * by name), so rows of one group are always contiguous and in the order of
 * `records/group-counts`.
 */
function groupTerms(item: ViewOrderItem, organizationId: Id<'org'>): OrderTerm[] {
  const terms = [orderTerm(item, organizationId)];
  const { field } = item;
  // A single select's option position already identifies its group.
  const tiesOnValue =
    'computed' in field
      ? computedSortKeyMayTie(field)
      : field.type === 'select'
        ? isMultiSelect(field)
        : sortKeyMayTie(field);
  if (tiesOnValue) terms.push({ expr: groupValue(field), direction: item.direction });
  return terms;
}

/** The final tie-breaker of every read: `__auto` ascending (unique, never null). */
const AUTO_TERM: OrderTerm = { expr: col('__auto'), direction: 'asc' };

function isMultiSelect(field: FieldModel): boolean {
  return (field.options as SelectOptions).multiple;
}

function sortKeyMayTie(field: FieldModel): boolean {
  return ['user', 'created_by', 'updated_by'].includes(field.type);
}

/**
 * The value a group level groups on: the stored cell, an empty list counting
 * as empty; for a single select, a value that is no current option (removed
 * meanwhile) counts as empty too, like its sort key.
 */
function groupValue(field: OrderField): RawBuilder<unknown> {
  // A computed value is already in stored form: an empty list is `NULL` (T457).
  if ('computed' in field) return field.value(ALIAS);
  const ref = col(field.column);
  if (field.type === 'select' && !isMultiSelect(field)) {
    const ids = (field.options as SelectOptions).options.map((option) => option.id);
    return sql`CASE WHEN array_position(${sql.val(ids)}::text[], (${ref})[1]) IS NULL THEN NULL ELSE ${ref} END`;
  }
  return field.type === 'select' || field.type === 'user' ? sql`NULLIF(${ref}, '{}')` : ref;
}

/** Alias of the `index`-th selected computed value (T457). Code only. */
const computedKey = (index: number) => `cv${String(index)}`;

/** `records` (in the order of `rows`) with `meta.color` under `colors` (T816). */
function withColors<R extends RecordOutput>(
  colors: ColorRulePlan | null,
  rows: readonly Readonly<Record<string, unknown>>[],
  records: R[],
): R[] {
  if (colors === null) return records;
  return records.map((record, index) => ({
    ...record,
    meta: { ...record.meta, color: colorOfRow(colors, rows[index] ?? {}) },
  }));
}

/**
 * Computed fields a request may filter, sort and group by (T457): read by
 * the caller and not locked — a locked field answers like a hidden one
 * (`INVALID_FILTER` / `INVALID_SORT`, P08).
 */
function filterableComputed(plan: Pick<ReadPlan, 'visibleComputed'>): readonly ComputedField[] {
  // A field in error (T460) filters like a field that no longer exists.
  return plan.visibleComputed.filter((field) => !field.locked && !inError(field));
}

/** A formula/lookup field with a field-level error (T460): its cells read `null`. */
function inError(field: ComputedField): boolean {
  return field.row.compute_state === 'error';
}

/** Readable fields a request may name in `sort`/`group`, by key. */
function orderableByKey(plan: ReadPlan, keyType: FieldKeyType): Map<string, OrderField> {
  const fields: OrderField[] = [...plan.model.visible, ...filterableComputed(plan)];
  return new Map(fields.map((field) => [keyType === 'id' ? field.id : field.name, field]));
}

/** Attachments (T406), records and attachments of computed fields (T457) never order. */
function isOrderableField(field: OrderField): boolean {
  return 'computed' in field ? field.sortKind !== null : isOrderable(field);
}

const and = (conditions: readonly RawBuilder<SqlBool>[]) =>
  sql<SqlBool>`${sql.join(conditions, sql` AND `)}`;

interface CountRow {
  readonly n: bigint;
}

interface ExplainRow {
  readonly 'QUERY PLAN': unknown;
}

/** `Plan Rows` of the top node of `EXPLAIN (FORMAT JSON)`; `null` when absent. */
function planRows(plan: unknown): number | null {
  const root = Array.isArray(plan) ? (plan[0] as unknown) : null;
  if (typeof root !== 'object' || root === null || !('Plan' in root)) return null;
  const node = root.Plan;
  if (typeof node !== 'object' || node === null || !('Plan Rows' in node)) return null;
  const rows = node['Plan Rows'];
  return typeof rows === 'number' && Number.isFinite(rows) ? Math.round(rows) : null;
}

type DataRow = Record<string, unknown> & {
  readonly __id: Id<'rec'>;
  /** `__parent_id`, selected only with the `parent` field (T405). */
  readonly __parent?: string | null;
  readonly __created_at: Date;
  readonly __updated_at: Date;
  readonly __version: number;
};

/** A prepared read: what to select, how to key it, and the WHERE of the principal. */
interface ReadPlan {
  readonly model: TableModel;
  readonly selected: readonly FieldModel[];
  /** Link fields to read (T401), after the column fields in each record. */
  readonly selectedLinks: readonly LinkFieldModel[];
  /** The `parent` field to read (T405), after the links; `null` when not selected. */
  readonly selectedParent: ParentFieldModel | null;
  /**
   * Formula/lookup fields of the table (T457): every active one (saved view
   * filters/sorts/groups apply them like other fields the caller may not
   * read), the ones the caller reads (maybe locked), and those to read.
   */
  readonly computed: readonly ComputedField[];
  readonly visibleComputed: readonly ComputedField[];
  readonly selectedComputed: readonly ComputedField[];
  /**
   * Button fields (T517): no column, a cell computed for the reader. The
   * ones the reader reads (minus hidden view fields of a share link), and
   * those to read.
   */
  readonly visibleButtons: readonly ButtonFieldModel[];
  readonly selectedButtons: readonly ButtonFieldModel[];
  /**
   * AI fields (T910, always strict): those the reader sees but is locked out
   * of (a field of the prompt they cannot read) — out of `model.visible`, so
   * never filtered/sorted/grouped by, their cells `null` — to read as such;
   * and those they read, whose cells carry `record.meta.ai`.
   */
  readonly selectedLockedAi: readonly FieldModel[];
  readonly readableAi: readonly FieldModel[];
  readonly fieldKeyType: FieldKeyType;
  readonly cellFormat: CellFormat;
  /** `__deleted_at IS NULL` AND the record read rule. */
  readonly baseConditions: readonly RawBuilder<SqlBool>[];
  /** Variables and dates of this request, resolved once (one `now`). */
  readonly context: ResolveContext;
  /** The view read through, if any. */
  readonly view: QueryView | null;
  readonly viewScope: RecordViewScope;
}

/**
 * The only reader of record data (`data.*`, SPEC §7, AGENTS.md rule 1).
 *
 * Pipeline (SPEC §7.2): table read access → view (if any) visible to the
 * caller → visible fields (field perm ≠ `no_perm`) ∩ requested → WHERE =
 * view filter AND request filter AND record read rule AND
 * `__deleted_at IS NULL` (+ primary field search) → ORDER BY group → view
 * sort → request sort → `__auto` → offset/limit → `total` or
 * `total_estimate` → serialization by `@cellhive/field-types`.
 *
 * - No read access to the table, a table of another base or organization,
 *   and records outside the read rule are all `NOT_FOUND`.
 * - Columns of fields the caller cannot read are never selected, filtered
 *   or sorted on; such fields are reported exactly like missing ones.
 * - Reads run in a read-only `REPEATABLE READ` transaction (page and count
 *   see the same snapshot) with `statement_timeout`; a cancelled statement
 *   is `504 QUERY_TIMEOUT`.
 */
export class RecordQueryService implements ButtonRecordMatcher {
  private readonly tables: TablesRepository;
  private readonly bases: BasesRepository;
  private readonly fieldsRepo: FieldsRepository;
  private readonly members: MemberDirectoryRepository;
  private readonly views: ViewsRepository;
  private readonly linkReader: LinkCellReader;
  private readonly parentReader: ParentCellReader;
  private readonly linkFilters: LinkFilterMeta;
  private readonly linkCandidateReader: LinkCandidateReader;
  private readonly computedPlanner: ComputedReadPlanner;
  private readonly computedCells: ComputedCellReader;
  private readonly buttonCells: ButtonCellResolver;
  private readonly linkTargets: LinkTargets;
  private readonly defaultTimeZone: string;
  private readonly timeoutMs: number;
  private readonly threshold: number;
  private readonly now: () => Date;

  constructor(
    private readonly db: Db,
    options: RecordQueryServiceOptions = {},
  ) {
    this.tables = new TablesRepository(db);
    this.bases = new BasesRepository(db);
    this.fieldsRepo = new FieldsRepository(db);
    this.members = new MemberDirectoryRepository(db);
    this.views = new ViewsRepository(db);
    this.linkReader = new LinkCellReader(db);
    this.parentReader = new ParentCellReader(db);
    this.linkFilters = new LinkFilterMeta(db);
    this.linkCandidateReader = new LinkCandidateReader(db, {
      statementTimeoutMs: options.statementTimeoutMs ?? REQUEST_STATEMENT_TIMEOUT_MS,
      now: options.now ?? (() => new Date()),
    });
    this.computedPlanner = new ComputedReadPlanner(db);
    this.computedCells = new ComputedCellReader(db);
    this.linkTargets = new LinkTargets(db);
    this.defaultTimeZone = options.defaultTimeZone ?? 'UTC';
    this.buttonCells = new ButtonCellResolver(db, this, {
      timeZone: this.defaultTimeZone,
      locale: options.defaultLocale ?? 'en',
    });
    this.timeoutMs = options.statementTimeoutMs ?? REQUEST_STATEMENT_TIMEOUT_MS;
    this.threshold = options.exactTotalThreshold ?? EXACT_TOTAL_THRESHOLD;
    this.now = options.now ?? (() => new Date());
    if (!Number.isSafeInteger(this.threshold) || this.threshold < 0) {
      throw new RangeError('exactTotalThreshold must be a non-negative integer');
    }
  }

  /**
   * Lists records of a table (SPEC §7.1–7.2, CONTRACTS §1.1/§1.4 query),
   * optionally through a saved view: WHERE = view filter AND request filter
   * AND read rule AND not deleted; ORDER BY = group (the request's, else the
   * view's) → view sort → request sort → `__auto`.
   */
  async query(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    access: RecordAccessContext,
    request: RecordQueryRequest = {},
    options: RecordQueryOptions = {},
  ): Promise<RecordListOutput> {
    return this.queryWith(scope, tableId, access, request, options, []);
  }

  /**
   * {@link query} with more conditions on the rows (alias `t`), built by
   * this service from meta only: the saved filter, live filters and segment
   * of a dashboard widget (click-through, T808).
   */
  private async queryWith(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    access: RecordAccessContext,
    request: RecordQueryRequest,
    options: RecordQueryOptions,
    extra: readonly RawBuilder<SqlBool>[],
  ): Promise<RecordListOutput> {
    this.assertScope(scope);
    const tableAccess = this.tableAccess(tableId, access);
    const input = parseRequest(querySchema, request);

    return this.read(scope, tableId, async (txScope, tx) => {
      const plan = await this.plan(txScope, tableId, access, tableAccess, input, 'live', {
        viewId: input.view_id ?? null,
        viewScope: options.viewScope ?? 'member',
      });
      const { model } = plan;
      const conditions = [...this.scopedConditions(plan, input), ...extra];
      if (input.ids !== undefined && input.ids !== null) {
        // Specific records (realtime `record.added` bursts), under every other rule.
        conditions.push(sql<SqlBool>`${col('__id')} = ANY(${[...input.ids]}::text[])`);
      }

      const organizationId = scope.organizationId;
      const group = this.groupItems(plan, input.group, input.field_key_type);
      // `sort_mode: replace` sets the view's sort aside (temporary sort, T311).
      const viewSort =
        plan.view === null || input.sort_mode === 'replace'
          ? []
          : viewOrderOf(plan.view.config.sort, model, plan.computed);
      const orderBy = [
        ...group.flatMap((item) => groupTerms(item, organizationId)),
        ...viewSort.map((item) => orderTerm(item, organizationId)),
        ...this.sortTerms(plan, input.sort ?? [], input.field_key_type, organizationId),
        AUTO_TERM,
      ].map(renderTerm);
      const from = this.from(model.table);
      const where = and(conditions);
      // Color rules of the view that apply to the reader (T816): one boolean column each.
      const colors = this.colorPlan(plan);
      // Deferred join: the page is chosen by sorting record ids only (narrow
      // rows, so deep offsets sort far less data), then its rows are read by
      // primary key in page order.
      const { rows } = await sql<DataRow>`
        SELECT ${this.selectList(plan, colors)}
          FROM unnest(ARRAY(
                 SELECT ${col('__id')}
                   FROM ${from}
                  WHERE ${where}
                  ORDER BY ${sql.join(orderBy)}
                  LIMIT ${input.limit} OFFSET ${input.offset}
               )) WITH ORDINALITY AS page (id, ord)
          JOIN ${from} ON ${col('__id')} = page.id
         ORDER BY page.ord
      `.execute(tx);

      const records = withColors(colors, rows, await this.serialize(txScope, plan, rows, access));
      const page = { records, offset: input.offset, limit: input.limit };
      // Later grid blocks skip the count (`include_total: false`).
      if (!input.include_total) return page;
      const counted = await this.total(tx, from, where, input.offset, input.limit, rows.length);
      return 'total' in counted
        ? { ...page, total: counted.total }
        : { ...page, total_estimate: counted.total_estimate };
    });
  }

  /**
   * Row counts per combination of group values (CONTRACTS §1.4
   * `records/group-counts`): the WHERE of {@link query} (view filter,
   * request filter, search, read rule), grouped by the request's `group`
   * (else the view's), in the row order of {@link query}, at most
   * `MAX_GROUP_COUNT_GROUPS` groups. Group levels name fields the caller
   * reads: a request `group` on another field is `422 INVALID_SORT`, levels
   * of the view's group on such fields (or on deleted ones) are left out,
   * so no value of an unreadable field is ever returned.
   */
  async groupCounts(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    access: RecordAccessContext,
    request: RecordGroupCountsRequest = {},
    options: RecordQueryOptions = {},
  ): Promise<RecordGroupCountsOutput> {
    this.assertScope(scope);
    const tableAccess = this.tableAccess(tableId, access);
    const input = parseRequest(groupCountsSchema, request);

    return this.read(scope, tableId, async (txScope, tx) => {
      const plan = await this.plan(
        txScope,
        tableId,
        access,
        tableAccess,
        { field_key_type: input.field_key_type, cell_format: input.cell_format, fields: [] },
        'live',
        { viewId: input.view_id ?? null, viewScope: options.viewScope ?? 'member' },
      );
      const readable = new Set<string>(
        [...plan.model.visible, ...filterableComputed(plan)].map((field) => field.id),
      );
      const group = this.groupItems(plan, input.group, input.field_key_type).filter((item) =>
        readable.has(item.field.id),
      );
      const where = and(this.scopedConditions(plan, input));
      const from = this.from(plan.model.table);
      const organizationId = scope.organizationId;
      const echo = group.map((item) => ({
        field: input.field_key_type === 'id' ? item.field.id : item.field.name,
        direction: item.direction,
      }));

      if (group.length === 0) {
        const { rows } = await sql<CountRow>`
          SELECT count(*) AS n FROM ${from} WHERE ${where}
        `.execute(tx);
        return {
          group: echo,
          groups: [{ values: [], count: Number(rows[0]?.n ?? 0n) }],
          truncated: false,
        };
      }

      // The inner query exposes the group values (empty lists as NULL) under
      // the same alias and column names, so the ORDER BY keys of `query`
      // apply unchanged to the groups. A computed value (T457) is exposed as
      // a column of its own, read as that column outside.
      const columnOf = (field: OrderField) =>
        'computed' in field ? computedColumnAlias(field) : field.column;
      const outer = (field: OrderField): OrderField =>
        'computed' in field ? { ...field, value: () => col(computedColumnAlias(field)) } : field;
      const distinct = [
        ...new Map(group.map((item) => [columnOf(item.field), item.field])).values(),
      ];
      const { rows } = await sql<Record<string, unknown> & { readonly n: bigint }>`
        SELECT ${sql.join(
          group.map((item, index) =>
            'computed' in item.field
              ? sql`to_jsonb(${col(columnOf(item.field))}) AS ${sql.id(`c${String(index)}`)}`
              : sql`${col(columnOf(item.field))} AS ${sql.id(`c${String(index)}`)}`,
          ),
        )},
               count(*) AS n
          FROM (
            SELECT ${sql.join(distinct.map((field) => sql`${groupValue(field)} AS ${sql.id(columnOf(field))}`))}
              FROM ${from}
             WHERE ${where}
          ) AS ${sql.id(ALIAS)}
         GROUP BY ${sql.join(distinct.map((field) => col(columnOf(field))))}
         ORDER BY ${sql.join(
           group
             .flatMap((item) =>
               groupTerms({ field: outer(item.field), direction: item.direction }, organizationId),
             )
             .map(renderTerm),
         )}
         LIMIT ${MAX_GROUP_COUNT_GROUPS + 1}
      `.execute(tx);
      const kept = rows.slice(0, MAX_GROUP_COUNT_GROUPS);
      const fields = group.map((item) => item.field);
      const users = await this.usersOf(
        txScope,
        fields.map((field) => ('computed' in field ? null : field)),
        kept,
      );
      const readContext: ReadContext = { resolveUser: (id) => users.get(id) };
      const localeContext: LocaleContext = { locale: access.locale, timeZone: access.timeZone };
      const computedFields = fields.filter((field): field is ComputedField => 'computed' in field);
      const computedData =
        computedFields.length === 0
          ? EMPTY_COMPUTED_CELL_DATA
          : await this.computedCells.read(
              txScope,
              computedFields,
              computedFields.map((field) =>
                kept.map((row) => row[`c${String(fields.indexOf(field))}`] ?? null),
              ),
              access,
              plan.context,
              localeContext,
            );
      return {
        group: echo,
        groups: kept.map((row) => ({
          values: fields.map((field, index) => {
            if ('computed' in field) {
              return computedCellValue(
                field,
                row[`c${String(index)}`] ?? null,
                computedData,
                plan.cellFormat,
                localeContext,
                plan.viewScope,
              );
            }
            const { definition, options: fieldOptions } = field;
            const json = definition.fromStorage(
              row[`c${String(index)}`],
              fieldOptions,
              readContext,
            );
            return plan.cellFormat === 'text'
              ? definition.formatText(json, fieldOptions, localeContext)
              : json;
          }),
          count: Number(row.n),
        })),
        truncated: rows.length > MAX_GROUP_COUNT_GROUPS,
      };
    });
  }

  /**
   * The summary bar (BACKLOG T472, CONTRACTS §1.4 `records/summaries`): the
   * WHERE and group levels of {@link groupCounts}, the request's
   * `summaries` or else the view's saved ones, computed by
   * `summaries/summaries.ts` in one aggregate statement. Fields the reader
   * cannot read, or that are locked for them, are never summarised.
   */
  async summaries(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    access: RecordAccessContext,
    request: RecordSummariesRequest = {},
    options: RecordQueryOptions = {},
  ): Promise<RecordSummariesOutput> {
    this.assertScope(scope);
    const tableAccess = this.tableAccess(tableId, access);
    const input = parseRequest(summariesSchema, request);

    return this.read(scope, tableId, async (txScope, tx) => {
      const plan = await this.plan(
        txScope,
        tableId,
        access,
        tableAccess,
        { field_key_type: input.field_key_type, cell_format: input.cell_format, fields: [] },
        'live',
        { viewId: input.view_id ?? null, viewScope: options.viewScope ?? 'member' },
      );
      const readable = new Set<string>(
        [...plan.model.visible, ...filterableComputed(plan)].map((field) => field.id),
      );
      const group = this.groupItems(plan, input.group, input.field_key_type).filter((item) =>
        readable.has(item.field.id),
      );
      const organizationId = scope.organizationId;
      return summarize({
        tx,
        organizationId,
        plan,
        from: this.from(plan.model.table),
        where: and(this.scopedConditions(plan, input)),
        group,
        requested: (input.summaries ?? null) as Readonly<Record<string, SummaryFunction>> | null,
        locale: { locale: access.locale, timeZone: access.timeZone },
        groupValue,
        groupOrder: (item) => groupTerms(item, organizationId).map(renderTerm),
        groupValues: (fields, rows) => this.groupValuesOf(txScope, plan, fields, rows, access),
      });
    });
  }

  /**
   * The numbers of a dashboard widget for one viewer (BACKLOG T806,
   * CONTRACTS §28.3, P21): the WHERE of {@link query} — table access, the
   * viewer's read rule, the widget's saved filter — and one aggregate
   * statement (`dashboard-aggregate/aggregate.ts`); a `records` table
   * widget reads through {@link query} itself (same columns as
   * `records/query`).
   *
   * Every field the widget names (dimension, series, metrics, comparison
   * date, record columns and sort, saved filter) must be one the viewer
   * reads — a locked formula/lookup or a field removed from their
   * permissions included — else the answer is `no_permission` without
   * running any statement on the data: a saved filter on a hidden field is
   * never set aside (that would show larger numbers). A table the viewer
   * cannot read is `no_permission` too; a table or field gone meanwhile (or
   * a saved filter that no longer validates) `broken`.
   *
   * `options.timeZone`: zone of date buckets and KPI periods for fields
   * without a zone of their own. Statement timeout as every read (10 s,
   * `QUERY_TIMEOUT`); more than `MAX_WIDGET_GROUPS` groups is `422
   * WIDGET_TOO_LARGE`.
   *
   * `options.live` (T808): live filters the API resolved from the
   * dashboard's declared sources — each one applies only on a field the
   * viewer reads; one on another field is set aside and listed in `ignored`
   * (`no_permission`) without touching the numbers, so it cannot probe
   * hidden values. See {@link liveConditions}.
   */
  async widgetData(
    scope: OrgScope,
    access: RecordAccessContext,
    query: WidgetQuery,
    options: { readonly timeZone: string; readonly live?: readonly WidgetLiveFilter[] },
  ): Promise<WidgetAggregateResult> {
    this.assertScope(scope);
    const tableId = query.tableId;
    const tableAccess = this.widgetTableAccess(tableId, access);
    if (tableAccess === null) return NO_PERMISSION_WIDGET;
    try {
      return await this.read(scope, tableId, async (txScope, tx) => {
        const { plan, computed, sources } = await this.widgetPlan(
          txScope,
          tableId,
          access,
          tableAccess,
        );
        const { model } = plan;
        // Record columns may also show buttons and the parent (T517, T405).
        const shown = new Set<string>([
          ...sources.keys(),
          ...(query.kind === 'records'
            ? [
                ...plan.visibleButtons.map((field) => field.id),
                ...(model.visibleParent === null ? [] : [model.visibleParent.id]),
              ]
            : []),
        ]);
        if (!widgetQueryFieldIds(query).every((id) => shown.has(id))) return NO_PERMISSION_WIDGET;

        const conditions = [...plan.baseConditions];
        if (query.filter !== null) {
          try {
            conditions.push(this.requestFilter(model, query.filter, 'id', plan.context, computed));
          } catch (error) {
            // A saved filter that no longer validates (a field converted since).
            if (error instanceof AppError && error.code === 'INVALID_FILTER') return BROKEN_WIDGET;
            throw error;
          }
        }
        const live = this.liveConditions(plan, computed, sources, options.live ?? [], {
          timeZone: options.timeZone,
        });
        conditions.push(...live.conditions);
        const ignored = live.ignored.length === 0 ? {} : { ignored: live.ignored };
        if (query.kind === 'records') {
          const orderable = orderableByKey(plan, 'id').get(query.sort?.field ?? '');
          const page = await this.queryWith(
            txScope,
            tableId,
            access,
            {
              field_key_type: 'id',
              fields: [...query.fields],
              filter: query.filter,
              sort:
                query.sort === null || orderable === undefined || !isOrderableField(orderable)
                  ? []
                  : [{ field: query.sort.field, direction: query.sort.direction }],
              limit: query.limit,
              include_total: false,
            },
            {},
            live.conditions,
          );
          const columns = [
            {
              key: 'record_id',
              role: 'record_id' as const,
              field_id: null,
              field_type: null,
              aggregation: null,
              date_bucket: null,
              bucket_width: null,
            },
            ...query.fields.map((id) => {
              const source = sources.get(id);
              const type =
                source === undefined
                  ? plan.visibleButtons.find((field) => field.id === id) === undefined
                    ? 'parent'
                    : 'button'
                  : source.kind === 'link'
                    ? 'link'
                    : source.field.type;
              return {
                key: id,
                role: 'field' as const,
                field_id: id,
                field_type: type,
                aggregation: null,
                date_bucket: null,
                bucket_width: null,
              };
            }),
          ];
          if (page.records.length === 0) return { status: 'empty', columns, rows: [], ...ignored };
          return {
            status: 'ok',
            columns,
            rows: page.records.map((record) => [
              record.id,
              ...query.fields.map((id) =>
                Object.hasOwn(record.fields, id) ? record.fields[id] : null,
              ),
            ]),
            ...ignored,
          };
        }
        const result = await aggregateWidget({
          scope: txScope,
          tx,
          model,
          access,
          context: plan.context,
          from: this.from(model.table),
          where: and(conditions),
          query,
          sources,
          timeZone: options.timeZone,
          now: new Date(plan.context.now),
          linkTargets: this.linkTargets,
          members: this.members,
        });
        return result.status === 'ok' || result.status === 'empty'
          ? { ...result, ...ignored }
          : result;
      });
    } catch (error) {
      // The table went to the trash (or was dropped) since the widget was read.
      if (error instanceof AppError && error.code === 'NOT_FOUND') return BROKEN_WIDGET;
      throw error;
    }
  }

  /**
   * The records behind a widget, or behind one of its groups (click-through,
   * BACKLOG T808, CONTRACTS §28.4): a page of {@link query} (`field_key_type
   * = id`, the fields the viewer reads, `__auto` order) over the rows the
   * widget counts — read rule, saved filter, live filters — and, with
   * `segment`, only the rows of that dimension (and series) group, with the
   * group key of the widget itself. Same `no_permission` / `broken` rule as
   * {@link widgetData}; a `segment` of a widget without a dimension (or a
   * `series` without a series dimension) is `422 VALIDATION_FAILED`
   * (`INVALID_FILTER_VALUE`), like a value that cannot be a group.
   */
  async widgetRecords(
    scope: OrgScope,
    access: RecordAccessContext,
    query: WidgetQuery,
    options: {
      readonly timeZone: string;
      readonly live?: readonly WidgetLiveFilter[];
      readonly segment: {
        readonly dimension: WidgetGroupKey;
        readonly series?: WidgetGroupKey | undefined;
      } | null;
      readonly offset: number;
      readonly limit: number;
    },
  ): Promise<{
    readonly status: 'ok' | 'empty' | 'no_permission' | 'broken';
    readonly page: RecordListOutput | null;
    readonly ignored: readonly IgnoredLiveFilter[];
  }> {
    this.assertScope(scope);
    const segments: SegmentLiveFilter[] = [];
    if (options.segment !== null) {
      if (query.kind !== 'grouped') {
        throw invalidFilterValue('segment', 'This widget has no groups');
      }
      segments.push({
        kind: 'segment',
        key: 'segment.dimension',
        path: 'segment.dimension',
        dimension: query.dimension,
        value: options.segment.dimension,
      });
      if (options.segment.series !== undefined) {
        if (query.series === null) {
          throw invalidFilterValue('segment.series', 'This widget has no series');
        }
        segments.push({
          kind: 'segment',
          key: 'segment.series',
          path: 'segment.series',
          dimension: query.series,
          value: options.segment.series,
        });
      }
    }
    const tableId = query.tableId;
    const tableAccess = this.widgetTableAccess(tableId, access);
    const none = (status: 'no_permission' | 'broken') => ({ status, page: null, ignored: [] });
    if (tableAccess === null) return none('no_permission');
    try {
      return await this.read(scope, tableId, async (txScope, tx) => {
        const { plan, computed, sources } = await this.widgetPlan(
          txScope,
          tableId,
          access,
          tableAccess,
        );
        const { model } = plan;
        const shown = new Set<string>([
          ...sources.keys(),
          ...(query.kind === 'records'
            ? [
                ...plan.visibleButtons.map((field) => field.id),
                ...(model.visibleParent === null ? [] : [model.visibleParent.id]),
              ]
            : []),
        ]);
        if (!widgetQueryFieldIds(query).every((id) => shown.has(id))) return none('no_permission');
        const input: WidgetAggregateInput | null =
          query.kind === 'records'
            ? null
            : {
                scope: txScope,
                tx,
                model,
                access,
                context: plan.context,
                from: this.from(model.table),
                where: and(plan.baseConditions),
                query,
                sources,
                timeZone: options.timeZone,
                now: new Date(plan.context.now),
                linkTargets: this.linkTargets,
                members: this.members,
              };
        if (input !== null && query.kind === 'grouped') {
          // The groups a viewer may see (a link dimension needs the linked titles).
          for (const spec of [query.dimension, ...(query.series === null ? [] : [query.series])]) {
            const status = await dimensionStatus(spec, input);
            if (status !== 'ok') return none(status);
          }
        }
        const conditions: RawBuilder<SqlBool>[] = [];
        if (query.filter !== null) {
          try {
            conditions.push(this.requestFilter(model, query.filter, 'id', plan.context, computed));
          } catch (error) {
            if (error instanceof AppError && error.code === 'INVALID_FILTER') return none('broken');
            throw error;
          }
        }
        const live = this.liveConditions(
          plan,
          computed,
          sources,
          [...(options.live ?? []), ...segments],
          { timeZone: options.timeZone },
        );
        // The segment is the group the viewer clicked: never set aside.
        if (live.ignored.some((item) => item.key.startsWith('segment.'))) {
          return none(
            live.ignored.some((item) => item.reason === 'no_permission')
              ? 'no_permission'
              : 'broken',
          );
        }
        conditions.push(...live.conditions);
        const page = await this.queryWith(
          txScope,
          tableId,
          access,
          {
            field_key_type: 'id',
            offset: options.offset,
            limit: options.limit,
            include_total: true,
          },
          {},
          conditions,
        );
        return {
          status: page.records.length === 0 && options.offset === 0 ? 'empty' : 'ok',
          page,
          ignored: live.ignored,
        };
      });
    } catch (error) {
      if (error instanceof AppError && error.code === 'NOT_FOUND') return none('broken');
      throw error;
    }
  }

  /**
   * The values a filter control offers (BACKLOG T808, CONTRACTS §28.4,
   * `POST /widgets/:id/options`): distinct non-empty values of its field
   * among the records the viewer reads, narrowed by `options.live` (the
   * values of its parent controls — cascading slicers, "Quyết định S7" #11)
   * and `options.search` (text: part of the value; select: of the option
   * name; user: of the member name), at most `options.limit`. A table or
   * field the viewer cannot read is `no_permission` (no value); a field that
   * no longer fits the control `broken`.
   */
  async controlOptions(
    scope: OrgScope,
    access: RecordAccessContext,
    control: {
      readonly tableId: Id<'tbl'>;
      readonly field: Id<'fld'>;
      readonly kind: FilterControlKind;
    },
    options: {
      readonly timeZone: string;
      readonly live?: readonly WidgetLiveFilter[];
      readonly search: string | null;
      readonly limit: number;
    },
  ): Promise<ControlOptionsResult> {
    this.assertScope(scope);
    const tableAccess = this.widgetTableAccess(control.tableId, access);
    const none = (status: 'no_permission' | 'broken'): ControlOptionsResult => ({
      status,
      items: [],
      hasMore: false,
    });
    if (tableAccess === null) return none('no_permission');
    try {
      return await this.read(scope, control.tableId, async (txScope, tx) => {
        const { plan, computed, sources } = await this.widgetPlan(
          txScope,
          control.tableId,
          access,
          tableAccess,
        );
        const { model } = plan;
        if (!sources.has(control.field)) return none('no_permission');
        const live = this.liveConditions(plan, computed, sources, options.live ?? [], {
          timeZone: options.timeZone,
        });
        const conditions = [...plan.baseConditions, ...live.conditions];
        if (options.search !== null && options.search !== '' && control.kind === 'text') {
          const searched = this.liveConditions(
            plan,
            computed,
            sources,
            [
              {
                kind: 'control',
                key: 'search',
                path: 'search',
                control: 'text',
                field: control.field,
                value: { values: [options.search] },
              },
            ],
            { timeZone: options.timeZone },
          );
          if (searched.ignored.length > 0) return none('broken');
          conditions.push(...searched.conditions);
        }
        const result = await controlOptions({
          scope: txScope,
          tx,
          model,
          access,
          context: plan.context,
          from: this.from(model.table),
          where: and(conditions),
          sources,
          timeZone: options.timeZone,
          linkTargets: this.linkTargets,
          members: this.members,
          field: control.field,
          control: control.kind,
          search: control.kind === 'text' ? null : options.search,
          limit: options.limit,
        });
        return live.ignored.length === 0 ? result : { ...result, ignored: live.ignored };
      });
    } catch (error) {
      if (error instanceof AppError && error.code === 'NOT_FOUND') return none('broken');
      throw error;
    }
  }

  /** The table access of a widget's viewer, or `null` when they cannot read the table. */
  private widgetTableAccess(tableId: Id<'tbl'>, access: RecordAccessContext): TableAccess | null {
    try {
      return this.tableAccess(tableId, access);
    } catch (error) {
      if (error instanceof AppError && error.code === 'NOT_FOUND') return null;
      throw error;
    }
  }

  /** The read plan of a widget and the fields the viewer reads, by id (`WidgetSource`). */
  private async widgetPlan(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    access: RecordAccessContext,
    tableAccess: TableAccess,
  ): Promise<{
    readonly plan: ReadPlan;
    readonly computed: readonly ComputedField[];
    readonly sources: Map<string, WidgetSource>;
  }> {
    const plan = await this.plan(
      scope,
      tableId,
      access,
      tableAccess,
      { field_key_type: 'id', cell_format: 'json', fields: [] },
      'live',
    );
    const { model } = plan;
    const computed = filterableComputed(plan);
    const sources = new Map<string, WidgetSource>([
      ...model.visible.map((field) => [field.id, { kind: 'column', field }] as const),
      ...model.visibleLinks.map((field) => [field.id, { kind: 'link', field }] as const),
      ...computed.map((field) => [field.id, { kind: 'computed', field }] as const),
    ]);
    return { plan, computed, sources };
  }

  /**
   * Conditions of the live filters of a dashboard (BACKLOG T808, CONTRACTS
   * §28.4) on the rows of `plan` (alias `t`). A control value becomes a
   * filter-DSL condition (`controlFilterOf`; relative dates in
   * `options.timeZone`), compiled like every request filter — only on the
   * fields the viewer reads; a segment (cross-filter, click-through) the
   * group key of the dimension (`segmentCondition`). A live filter on a
   * field the viewer cannot read is **set aside** (`no_permission`) instead
   * of applied, so its value never narrows the rows: no count can tell
   * anything about a hidden field. One whose field no longer fits is set
   * aside as `broken`. A value that cannot apply to the field (an unknown
   * option, a value of another type) is `422` at `path`.
   */
  private liveConditions(
    plan: ReadPlan,
    computed: readonly ComputedField[],
    sources: ReadonlyMap<string, WidgetSource>,
    live: readonly WidgetLiveFilter[],
    options: { readonly timeZone: string },
  ): { conditions: RawBuilder<SqlBool>[]; ignored: IgnoredLiveFilter[] } {
    const conditions: RawBuilder<SqlBool>[] = [];
    const ignored: IgnoredLiveFilter[] = [];
    const { model } = plan;
    const context: ResolveContext = { ...plan.context, timeZone: options.timeZone };
    for (const filter of live) {
      if (filter.kind === 'segment') {
        const source = sources.get(filter.dimension.field);
        if (source === undefined) {
          ignored.push({ key: filter.key, reason: 'no_permission' });
          continue;
        }
        const condition = segmentCondition(filter.dimension, source, filter.value, {
          model,
          timeZone: options.timeZone,
        });
        if (condition === 'broken') ignored.push({ key: filter.key, reason: 'broken' });
        else if (condition === 'invalid') {
          throw invalidFilterValue(filter.path, 'The value is not a group of this dimension');
        } else conditions.push(condition);
        continue;
      }
      const meta = model.queryFilterMeta.fields.find((field) => field.id === filter.field);
      if (!sources.has(filter.field) || meta === undefined) {
        ignored.push({ key: filter.key, reason: 'no_permission' });
        continue;
      }
      const node = controlFilterOf(filter, meta, plan.context.now, options.timeZone);
      if (node === 'unfit') {
        ignored.push({ key: filter.key, reason: 'broken' });
        continue;
      }
      if (node === null) continue;
      try {
        conditions.push(this.requestFilter(model, node, 'id', context, computed));
      } catch (error) {
        if (error instanceof AppError && error.code === 'INVALID_FILTER') {
          throw invalidFilterValue(filter.path, 'The value does not fit the field');
        }
        throw error;
      }
    }
    return { conditions, ignored };
  }

  /**
   * The cache key of a widget result for this viewer (BACKLOG T807,
   * CONTRACTS §28.5, `dashboard-aggregate/cache.ts`), or `null` when the
   * result must not be cached: the table is not readable (the answer is a
   * cheap `no_permission`), it is gone, or a read rule / saved filter
   * cannot be resolved for the viewer (fail closed).
   *
   * Reads meta only (no data): the tables of the base and their active
   * fields, to follow link fields from the widget's table — the tables
   * whose rows can reach the numbers (link targets, tables behind lookups
   * and link titles, transitively). The key holds their `data_version`, the
   * viewer's permission fingerprint on them (read rules resolved for the
   * viewer: `permissionFingerprintMaterial`) and a hash of everything else
   * the result depends on: the query (saved filter resolved for the
   * viewer), `options.filters`, the zones and today's date in them, the
   * schema of those tables (types, options, computed state), the viewer's
   * locale (link titles) and the base's `strict_computed_permissions`.
   * `null` for a `records` widget too: never cached (its button cells are
   * per viewer and per automation state). Must be called before {@link widgetData}
   * for the same request: the versions read here are never newer than the
   * data that answer reads.
   */
  async widgetCacheKey(
    scope: OrgScope,
    access: RecordAccessContext,
    widgetId: string,
    query: WidgetQuery,
    options: {
      readonly timeZone: string;
      /** Realtime filters of the request (T808), as sent. */
      readonly filters?: unknown;
      /** Anything else the caller's answer depends on (e.g. the organization zone). */
      readonly context?: unknown;
    },
  ): Promise<string | null> {
    this.assertScope(scope);
    // Records widgets are never cached: their rows are records, and their
    // button cells depend on what the viewer may edit (table perm, edit
    // rule), on the automation (attached, on) and on `enabled_when` read as
    // `run_as` — none of it is in the key, nor bumps a `data_version`.
    if (query.kind === 'records') return null;
    if (!this.tableReadable(query.tableId, access)) return null;
    const [tables, fields, base] = await Promise.all([
      this.tables.listByBase(scope, access.baseId),
      this.fieldsRepo.listActiveByBase(scope, access.baseId),
      this.bases.getById(scope, access.baseId),
    ]);
    const tableById = new Map(tables.map((table) => [table.id as string, table]));
    if (!tableById.has(query.tableId)) return null;
    const fieldsByTable = new Map<string, FieldRow[]>();
    for (const field of fields) {
      const list = fieldsByTable.get(field.table_id) ?? [];
      list.push(field);
      fieldsByTable.set(field.table_id, list);
    }
    // Every table reachable through link fields (lookups and titles read them).
    const reached = new Set<string>([query.tableId]);
    const queue: string[] = [query.tableId];
    while (queue.length > 0) {
      const tableId = queue.shift() as string;
      for (const field of fieldsByTable.get(tableId) ?? []) {
        if (field.type !== 'link') continue;
        const target = (field.options as { link_table?: unknown } | null)?.link_table;
        if (typeof target === 'string' && tableById.has(target) && !reached.has(target)) {
          reached.add(target);
          queue.push(target);
        }
      }
    }
    const tableIds = [...reached].sort() as Id<'tbl'>[];
    const context = this.resolveContext(access);
    const material = permissionFingerprintMaterial(
      access.resolved,
      tableIds,
      context,
      access.relatedAccess,
    );
    if (material === null) return null;
    let filter: unknown = query.filter;
    let today: string[];
    try {
      const text = JSON.stringify(query.filter);
      if (text.includes('"$var"') || text.includes('"$date"')) {
        filter = resolveVariables(query.filter as unknown as FilterNode, context);
      }
      const now = new Date(context.now);
      today = [options.timeZone, access.timeZone].map((timeZone) =>
        new Intl.DateTimeFormat('en-CA', {
          timeZone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(now),
      );
    } catch {
      return null;
    }
    const schema = tableIds.map((tableId) => ({
      id: tableId,
      primary_field_id: tableById.get(tableId)?.primary_field_id ?? null,
      fields: (fieldsByTable.get(tableId) ?? []).map((field) => ({
        id: field.id,
        type: field.type,
        options: field.options,
        result_type: field.result_type,
        compute_mode: field.compute_mode,
        compute_state: field.compute_state,
        compute_error: field.compute_error,
      })),
    }));
    return widgetCacheKey({
      widgetId,
      effectiveQuery: {
        query: { ...query, filter },
        filters: options.filters ?? [],
        time_zone: options.timeZone,
        reader_time_zone: access.timeZone,
        // Labels (link titles) are formatted in the viewer's locale.
        reader_locale: access.locale,
        today,
        context: options.context ?? null,
        strict_computed_permissions: strictComputedPermissionsOf(base?.settings),
        schema,
      },
      permissionMaterial: material,
      dataVersions: tableIds.map((tableId) => tableById.get(tableId)?.data_version ?? 0),
    });
  }

  /** Whether the table is one `access` reads (as `tableAccess`, without throwing). */
  private tableReadable(tableId: Id<'tbl'>, access: RecordAccessContext): boolean {
    try {
      this.tableAccess(tableId, access);
      return true;
    } catch (error) {
      if (error instanceof AppError && error.code === 'NOT_FOUND') return false;
      throw error;
    }
  }

  /**
   * Group values of `rows` (`c<level>`: the raw value of each level,
   * computed values as `to_jsonb`) as `records/group-counts` returns them
   * (T472 summaries of group headers).
   */
  private async groupValuesOf(
    scope: OrgScope,
    plan: ReadPlan,
    fields: readonly OrderField[],
    rows: readonly Readonly<Record<string, unknown>>[],
    access: RecordAccessContext,
  ): Promise<unknown[][]> {
    const users = await this.usersOf(
      scope,
      fields.map((field) => ('computed' in field ? null : field)),
      rows,
    );
    const readContext: ReadContext = { resolveUser: (id) => users.get(id) };
    const localeContext: LocaleContext = { locale: access.locale, timeZone: access.timeZone };
    const computedFields = fields.filter((field): field is ComputedField => 'computed' in field);
    const computedData =
      computedFields.length === 0
        ? EMPTY_COMPUTED_CELL_DATA
        : await this.computedCells.read(
            scope,
            computedFields,
            computedFields.map((field) =>
              rows.map((row) => row[`c${String(fields.indexOf(field))}`] ?? null),
            ),
            access,
            plan.context,
            localeContext,
          );
    return rows.map((row) =>
      fields.map((field, index) => {
        const raw = row[`c${String(index)}`];
        if ('computed' in field) {
          return computedCellValue(
            field,
            raw ?? null,
            computedData,
            plan.cellFormat,
            localeContext,
            plan.viewScope,
          );
        }
        const json = field.definition.fromStorage(raw, field.options, readContext);
        return plan.cellFormat === 'text'
          ? field.definition.formatText(json, field.options, localeContext)
          : json;
      }),
    );
  }

  /**
   * Records a link picker may offer for the link field `fieldId` (BACKLOG
   * T402, CONTRACTS §2); the logic lives in `links/link-candidates.ts`.
   */
  async linkCandidates(
    scope: OrgScope,
    fieldId: Id<'fld'>,
    access: RecordAccessContext,
    request: LinkCandidatesInput = {},
  ): Promise<LinkCandidatesOutput> {
    this.assertScope(scope);
    return this.linkCandidateReader.read(scope, fieldId, access, request);
  }

  /**
   * One record, with the same rules as {@link query}: a record that does not
   * exist, is in the trash or is outside the caller's read rule is
   * `NOT_FOUND`.
   */
  async getRecord(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    recordId: string,
    access: RecordAccessContext,
    options: RecordReadOptions = {},
  ): Promise<RecordOutput> {
    this.assertScope(scope);
    const tableAccess = this.tableAccess(tableId, access);
    const input = parseRequest(readOptionsSchema, options);
    return this.read(scope, tableId, async (txScope, tx) => {
      const plan = await this.plan(txScope, tableId, access, tableAccess, input);
      if (!isId('rec', recordId)) throw recordNotFound();
      const where = and([...plan.baseConditions, sql<SqlBool>`${col('__id')} = ${recordId}`]);
      const { rows } = await sql<DataRow>`
        SELECT ${this.selectList(plan)}
          FROM ${this.from(plan.model.table)}
         WHERE ${where}
         LIMIT 1
      `.execute(tx);
      const [record] = await this.serialize(txScope, plan, rows, access);
      if (record === undefined) throw recordNotFound();
      return record;
    });
  }

  /**
   * Several records by id, in the order of `recordIds`, with the same rules
   * as {@link query}. Ids that do not exist, are in the trash or are outside
   * the caller's read rule are left out (no error): `RecordMutationService`
   * reads its result back this way, inside its transaction, so hidden fields
   * stay absent and records that left the read scope are not returned.
   */
  async getRecords(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    recordIds: readonly string[],
    access: RecordAccessContext,
    options: RecordReadOptions = {},
  ): Promise<RecordOutput[]> {
    this.assertScope(scope);
    const tableAccess = this.tableAccess(tableId, access);
    const input = parseRequest(readOptionsSchema, options);
    const wanted = [...new Set(recordIds.filter((id) => isId('rec', id)))];
    return this.read(scope, tableId, async (txScope, tx) => {
      const plan = await this.plan(txScope, tableId, access, tableAccess, input);
      if (wanted.length === 0) return [];
      const where = and([
        ...plan.baseConditions,
        sql<SqlBool>`${col('__id')} = ANY(${sql.val(wanted)}::text[])`,
      ]);
      const { rows } = await sql<DataRow>`
        SELECT ${this.selectList(plan)}
          FROM ${this.from(plan.model.table)}
         WHERE ${where}
      `.execute(tx);
      const records = await this.serialize(txScope, plan, rows, access);
      const byId = new Map(records.map((record) => [record.id as string, record]));
      return recordIds.flatMap((id) => {
        const record = byId.get(id);
        return record === undefined ? [] : [record];
      });
    });
  }

  /**
   * Whether one record matches `filter` (Filter DSL with field ids, SPEC
   * §6; `null` = any) for this reader (BACKLOG T503: automation conditions
   * read as `run_as`): the record must exist, be in the reader's read rule
   * and match the filter, which may only name fields the reader can read
   * (else `422 INVALID_FILTER`, as in {@link query}). `trashed` reads a
   * record in the trash instead of a live one (`record.deleted`
   * conditions); no other state is ever matched. `fields` are field ids the
   * reader must be able to filter on too, even when `filter` does not name
   * them (T510: conditions decided from an event's `changes`); one it
   * cannot is `422 INVALID_FILTER` / `UNKNOWN_FIELD`. A table the reader
   * cannot read is `404`.
   */
  async matchRecord(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    recordId: string,
    access: RecordAccessContext,
    filter: unknown,
    options: { readonly trashed?: boolean; readonly fields?: readonly string[] } = {},
  ): Promise<boolean> {
    this.assertScope(scope);
    const tableAccess = this.tableAccess(tableId, access);
    const input = parseRequest(readOptionsSchema, { field_key_type: 'id' });
    if (!isId('rec', recordId)) return false;
    return this.read(scope, tableId, async (txScope, tx) => {
      const plan = await this.plan(txScope, tableId, access, tableAccess, input);
      if (options.fields !== undefined && options.fields.length > 0) {
        const filterable = new Set<string>(
          [...plan.model.visible, ...plan.model.visibleLinks, ...filterableComputed(plan)].map(
            (field) => field.id,
          ),
        );
        if (options.fields.some((fieldId) => !filterable.has(fieldId))) {
          throw new AppError('INVALID_FILTER', {
            detail: 'The filter is invalid.',
            errors: [unknownField('filter')],
          });
        }
      }
      const conditions = [
        options.trashed === true
          ? sql<SqlBool>`${col('__deleted_at')} IS NOT NULL`
          : sql<SqlBool>`${col('__deleted_at')} IS NULL`,
        this.readRule(plan.model, access, plan.context),
        sql<SqlBool>`${col('__id')} = ${recordId}`,
      ];
      if (filter !== null && filter !== undefined) {
        conditions.push(
          this.requestFilter(plan.model, filter, 'id', plan.context, filterableComputed(plan)),
        );
      }
      const { rows } = await sql<{ one: number }>`
        SELECT 1 AS one FROM ${this.from(plan.model.table)} WHERE ${and(conditions)} LIMIT 1
      `.execute(tx);
      return rows.length > 0;
    });
  }

  /**
   * Live records of a table matching `filter` (field ids) and the read rule
   * of `access`, split by the edit rule: `editable` — the records `access`
   * may change — and `notEditable` (BACKLOG T506: what `update_records`
   * leaves alone), each counted up to `cap` (`cap` means "at least `cap`").
   * The count `update_records` makes before writing. A filter on a field the
   * reader cannot read is `422 INVALID_FILTER`; an unreadable table is `404`.
   */
  async countEditable(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    access: RecordAccessContext,
    filter: unknown,
    cap: number,
  ): Promise<{ readonly editable: number; readonly notEditable: number }> {
    this.assertScope(scope);
    if (!Number.isSafeInteger(cap) || cap < 1) throw new RangeError('cap must be positive');
    const tableAccess = this.tableAccess(tableId, access);
    const input = parseRequest(readOptionsSchema, { field_key_type: 'id' });
    return this.read(scope, tableId, async (txScope, tx) => {
      const plan = await this.plan(txScope, tableId, access, tableAccess, input);
      const matching = and([...plan.baseConditions, ...this.filterConditions(plan, filter)]);
      const edit = this.editRule(plan, access);
      const { rows } = await sql<{ editable: number; not_editable: number }>`
        SELECT
          (SELECT count(*)::int FROM (
             SELECT 1 FROM ${this.from(plan.model.table)}
              WHERE ${matching} AND (${edit}) IS TRUE
              LIMIT ${cap}) AS e) AS editable,
          (SELECT count(*)::int FROM (
             SELECT 1 FROM ${this.from(plan.model.table)}
              WHERE ${matching} AND (${edit}) IS NOT TRUE
              LIMIT ${cap}) AS n) AS not_editable
      `.execute(tx);
      return { editable: rows[0]?.editable ?? 0, notEditable: rows[0]?.not_editable ?? 0 };
    });
  }

  /**
   * Ids of the records {@link countEditable} counts, in `__id` order after
   * `afterId` (exclusive; `null` = from the first), at most `limit`: the
   * batches of `update_records` (BACKLOG T506, SPEC §11.7).
   */
  async editableIds(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    access: RecordAccessContext,
    filter: unknown,
    page: { readonly afterId: string | null; readonly limit: number },
  ): Promise<Id<'rec'>[]> {
    this.assertScope(scope);
    if (!Number.isSafeInteger(page.limit) || page.limit < 1) {
      throw new RangeError('limit must be positive');
    }
    const tableAccess = this.tableAccess(tableId, access);
    const input = parseRequest(readOptionsSchema, { field_key_type: 'id' });
    return this.read(scope, tableId, async (txScope, tx) => {
      const plan = await this.plan(txScope, tableId, access, tableAccess, input);
      const conditions = this.editableConditions(plan, access, filter);
      if (page.afterId !== null) conditions.push(sql<SqlBool>`${col('__id')} > ${page.afterId}`);
      const { rows } = await sql<{ id: Id<'rec'> }>`
        SELECT ${col('__id')} AS id FROM ${this.from(plan.model.table)}
         WHERE ${and(conditions)}
         ORDER BY ${col('__id')}
         LIMIT ${page.limit}
      `.execute(tx);
      return rows.map((row) => row.id);
    });
  }

  /**
   * One keyset page of the live records whose date field `fieldId` lies in
   * `(lower, upper]` (`lower` inclusive when asked), in the read rule of
   * `access` and matching `filter` (field ids), ordered by `(value, __id)`
   * after `after`: the time scanner of BACKLOG T508 (`record.date_reached`)
   * and the shared time scan core (ADR-34 §1, T546; S5b date reminders).
   * The range is on the column itself, so an index on it
   * (`SchemaService.ensureDueIndex`; `__created_at` always has one) serves
   * the scan. The field must be a date field the reader can filter on
   * (`datetime`, `created_at`, a stored formula/lookup of a date type —
   * `dueValueKindOf`), else `422 INVALID_FILTER` / `UNKNOWN_FIELD`; an
   * unreadable table is `404`. `fields` (ids) adds the JSON cells of those
   * fields to each row, as {@link getRecords} returns them (a field the
   * reader cannot read is `422 VALIDATION_FAILED`).
   *
   * `access` is a member context (automation `run_as`) or a system scan
   * context from {@link systemScanAccess}: live records, no read rule, only
   * its listed fields; one created for another organization or table is
   * `404`.
   */
  async scanDue(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    access: RecordAccessContext | SystemScanAccess,
    request: DueScanRequest,
  ): Promise<DueScanPage> {
    this.assertScope(scope);
    if (!Number.isSafeInteger(request.limit) || request.limit < 1) {
      throw new RangeError('limit must be positive');
    }
    const reader = this.dueScanReader(scope, tableId, access);
    const tableAccess = this.tableAccess(tableId, reader);
    const withCells = request.fields !== undefined;
    const input = parseRequest(readOptionsSchema, {
      field_key_type: 'id',
      ...(withCells ? { fields: request.fields } : {}),
    });
    return this.read(scope, tableId, async (txScope, tx) => {
      const plan = await this.plan(txScope, tableId, reader, tableAccess, input);
      const plain = plan.model.visible.find((field) => field.id === request.fieldId);
      const computed = filterableComputed(plan).find((field) => field.id === request.fieldId);
      const row = plain?.row ?? computed?.row;
      const kind = row === undefined ? null : dueValueKindOf(row);
      if (kind === null) {
        throw new AppError('INVALID_FILTER', {
          detail: 'The filter is invalid.',
          errors: [unknownField('field_id')],
        });
      }
      const value =
        plain !== undefined ? col(plain.column) : (computed as ComputedField).value(ALIAS);
      const cast = kind === 'instant' ? sql`timestamptz` : sql`date`;
      const conditions = [
        ...plan.baseConditions,
        sql<SqlBool>`${value} IS NOT NULL`,
        request.lower.inclusive
          ? sql<SqlBool>`${value} >= ${request.lower.value}::${cast}`
          : sql<SqlBool>`${value} > ${request.lower.value}::${cast}`,
        sql<SqlBool>`${value} <= ${request.upper}::${cast}`,
        ...this.filterConditions(plan, request.filter),
      ];
      if (request.after !== null) {
        conditions.push(
          sql<SqlBool>`(${value}, ${col('__id')}) > (${request.after.value}::${cast}, ${request.after.id})`,
        );
      }
      if (withCells) {
        const { rows } = await sql<DataRow & { __due: unknown }>`
          SELECT ${this.selectList(plan)}, ${value} AS __due FROM ${this.from(plan.model.table)}
           WHERE ${and(conditions)}
           ORDER BY ${value}, ${col('__id')}
           LIMIT ${request.limit}
        `.execute(tx);
        const records = await this.serialize(txScope, plan, rows, reader);
        const cells = new Map(records.map((record) => [record.id as string, record.fields]));
        const out: DueScanRow[] = [];
        for (const item of rows) {
          const text = dueValueText(kind, item.__due);
          if (text !== null) {
            out.push({ id: item.__id, value: text, fields: cells.get(item.__id) ?? {} });
          }
        }
        return { kind, rows: out };
      }
      const { rows } = await sql<{ id: Id<'rec'>; value: unknown }>`
        SELECT ${col('__id')} AS id, ${value} AS value FROM ${this.from(plan.model.table)}
         WHERE ${and(conditions)}
         ORDER BY ${value}, ${col('__id')}
         LIMIT ${request.limit}
      `.execute(tx);
      const out: DueScanRow[] = [];
      for (const item of rows) {
        const text = dueValueText(kind, item.value);
        if (text !== null) out.push({ id: item.id, value: text });
      }
      return { kind, rows: out };
    });
  }

  /**
   * The read context of a **system** time scan (ADR-34 §1, BACKLOG T546;
   * S5b date reminders): read only, for {@link scanDue} only, over the live
   * records of `tableId` (not in the trash), reading **only** `fieldIds`
   * (any other field is unknown to it), with no record read rule. The table
   * (and its base) must be live in the organization of `scope`, else `404`.
   * Worker code only: the API never calls it, and a lock test keeps its
   * callers to `time-scan/**` and `notifications/reminders/**`. Whoever is
   * told about a record found this way is checked per recipient when told
   * (`notifications.fanout`, ADR-29 §1).
   */
  async systemScanAccess(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    fieldIds: readonly Id<'fld'>[],
  ): Promise<SystemScanAccess> {
    this.assertScope(scope);
    const ids = systemScanFieldIds(fieldIds);
    const table = await this.tables.getById(scope, tableId);
    if (table === undefined) throw notFound();
    const base = await this.bases.getById(scope, table.base_id);
    if (base === undefined) throw notFound();
    return createSystemScanAccess({
      organizationId: scope.organizationId,
      baseId: table.base_id,
      tableId,
      fieldIds: ids,
      timeZone: this.defaultTimeZone,
    });
  }

  /** The member context of a `scanDue` reader (a system scan context checked first). */
  private dueScanReader(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    access: RecordAccessContext | SystemScanAccess,
  ): RecordAccessContext {
    if (!isSystemScanAccess(access)) return access;
    const context = systemScanContextOf(access, scope.organizationId, tableId);
    if (context === null) throw notFound();
    return context;
  }

  /** Live, read rule, edit rule, `filter` (ids): what an automation may change in bulk. */
  private editableConditions(
    plan: ReadPlan,
    access: RecordAccessContext,
    filter: unknown,
  ): RawBuilder<SqlBool>[] {
    return [
      ...plan.baseConditions,
      this.editRule(plan, access),
      ...this.filterConditions(plan, filter),
    ];
  }

  /** Record edit rule of `access` (`internal.editFilters`), like the trash. */
  private editRule(plan: ReadPlan, access: RecordAccessContext): RawBuilder<SqlBool> {
    return ruleSql(
      resolveRule(access.resolved.internal.editFilters, plan.model, plan.context),
      plan.model,
      ALIAS,
    );
  }

  /** A request filter with field ids, as conditions (none without filter). */
  private filterConditions(plan: ReadPlan, filter: unknown): RawBuilder<SqlBool>[] {
    if (filter === null || filter === undefined) return [];
    return [this.requestFilter(plan.model, filter, 'id', plan.context, filterableComputed(plan))];
  }

  /**
   * Records in the trash (CONTRACTS §11.3, ADR-23 §4), newest deletion
   * first, with `deleted_at` and `deleted_by`. Needs table perm `edit` or
   * `manage` and the `delete` operation (else `403 PERMISSION_DENIED`; an
   * unreadable table is `404`); only records matching both the read and the
   * edit rule are listed. Keyset pagination on `(__deleted_at, __id)`.
   */
  async listTrash(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    access: RecordAccessContext,
    request: RecordTrashRequest = {},
  ): Promise<RecordTrashOutput> {
    this.assertScope(scope);
    const tableAccess = this.tableAccess(tableId, access);
    if (
      (tableAccess.perm !== 'edit' && tableAccess.perm !== 'manage') ||
      !tableAccess.operations.includes('delete')
    ) {
      throw new AppError('PERMISSION_DENIED', {
        detail: 'Only users who can delete records of this table see its trash.',
      });
    }
    const input = parseRequest(trashSchema, request);
    const cursor = decodeCursor(input.cursor);
    return this.read(scope, tableId, async (txScope, tx) => {
      const plan = await this.plan(
        txScope,
        tableId,
        access,
        tableAccess,
        { field_key_type: input.field_key_type, cell_format: 'json', fields: null },
        'trash',
      );
      const conditions = [...plan.baseConditions];
      if (cursor !== null) conditions.push(afterCursor(col('__deleted_at'), col('__id'), cursor));
      const { rows } = await sql<
        DataRow & { __deleted_at: Date; __deleted_by: string | null; __cursor_at: string }
      >`
        SELECT ${this.selectList(plan)},
               ${col('__deleted_at')} AS __deleted_at,
               ${col('__deleted_by')} AS __deleted_by,
               ${cursorTimestamp(col('__deleted_at'))} AS __cursor_at
          FROM (
            SELECT ${sql.id(ALIAS)}.* FROM ${this.from(plan.model.table)}
             WHERE ${and(conditions)}
             ORDER BY ${col('__deleted_at')} DESC, ${col('__id')} DESC
             LIMIT ${input.limit + 1}
          ) AS ${sql.id(ALIAS)}
         ORDER BY ${col('__deleted_at')} DESC, ${col('__id')} DESC
      `.execute(tx);
      const { items, nextCursor } = pageWithCursor(rows, input.limit, (row) => ({
        at: row.__cursor_at,
        id: row.__id,
      }));
      const records = await this.serialize(txScope, plan, items, access);
      // Sub-records (T405): descendants deleted together, that the caller may restore.
      const branchSizes =
        plan.model.visibleParent === null
          ? new Map<string, number>()
          : await trashedBranchSizes(
              tx,
              plan.model.table,
              items.map((row) => row.__id),
              and(plan.baseConditions),
            );
      const deleters = await this.members.findMembers(
        txScope,
        items.flatMap((row) => (row.__deleted_by === null ? [] : [row.__deleted_by])),
      );
      const names = new Map(deleters.map((member) => [member.id as string, member.name]));
      return {
        records: records.map((record, index): TrashedRecordOutput => {
          const row = items[index] as (typeof items)[number];
          const deletedBy = row.__deleted_by;
          return {
            ...record,
            deleted_at: row.__deleted_at.toISOString(),
            deleted_by:
              deletedBy === null || !isId('usr', deletedBy)
                ? null
                : { id: deletedBy, name: names.get(deletedBy) ?? null },
            ...(branchSizes.has(record.id) ? { branch_size: branchSizes.get(record.id) ?? 0 } : {}),
          };
        }),
        next_cursor: nextCursor,
      };
    });
  }

  /**
   * One level of the sub-record tree (CONTRACTS §1.4 `records/tree`,
   * BACKLOG T405, S4 open question #10): the roots (`parent_id` absent) or
   * the children of `parent_id` in the visible tree, paged, ordered by the
   * view sort → request sort → creation order among siblings (a tree is
   * never grouped: the view's group is ignored). Each record carries
   * `tree` = `{ parent_id, depth, children_count, ancestor_only }`.
   *
   * The visible tree holds live records the caller reads; a record whose
   * parent is unreadable or in the trash shows as a root. With a filter
   * (view, request or search) it holds the matching records and, with
   * `show_ancestors` (default: the view's `tree.show_ancestors`, else
   * true), their readable ancestors flagged `ancestor_only`.
   * `children_count` only counts records of the visible tree. A table
   * without a `parent` field the caller reads is `422 VALIDATION_FAILED`
   * (`SUBRECORDS_NOT_ENABLED`); a `parent_id` outside the visible tree is
   * `404`.
   */
  async tree(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    access: RecordAccessContext,
    request: RecordTreeRequest = {},
    options: RecordQueryOptions = {},
  ): Promise<RecordTreeOutput> {
    this.assertScope(scope);
    const tableAccess = this.tableAccess(tableId, access);
    const input = parseRequest(treeSchema, request);

    return this.read(scope, tableId, async (txScope, tx) => {
      const plan = await this.plan(txScope, tableId, access, tableAccess, input, 'live', {
        viewId: input.view_id ?? null,
        viewScope: options.viewScope ?? 'member',
      });
      const { model } = plan;
      if (model.visibleParent === null) throw subrecordsNotEnabled('');
      const conditions = this.scopedConditions(plan, input);
      const filtered = conditions.length > plan.baseConditions.length;
      const rule = resolveRule(access.resolved.internal.readFilters, model, plan.context);
      const parentId = input.parent_id ?? null;
      const level: TreeLevelInput = {
        ref: sql.id(DATA_SCHEMA, assertDataTableName(model.table.db_table_name)),
        readRule: (alias) => ruleSql(rule, model, alias),
        where: and(conditions),
        filtered,
        showAncestors: input.show_ancestors ?? plan.view?.config.tree.show_ancestors ?? true,
        parentId,
      };
      let depth = 0;
      if (parentId !== null) {
        const { rows } = await sql<{
          depth: number | null;
        }>`${parentDepthSql(level, parentId)}`.execute(tx);
        const parentDepth = rows[0]?.depth ?? null;
        if (parentDepth === null) throw recordNotFound();
        depth = parentDepth + 1;
      }
      const parts = treeLevelSql(level);
      const organizationId = scope.organizationId;
      const viewSort =
        plan.view === null || input.sort_mode === 'replace'
          ? []
          : viewOrderOf(plan.view.config.sort, model, plan.computed);
      const orderBy = [
        ...viewSort.map((item) => orderTerm(item, organizationId)),
        ...this.sortTerms(plan, input.sort ?? [], input.field_key_type, organizationId),
        AUTO_TERM,
      ].map(renderTerm);
      const from = this.from(model.table);
      // Filtered: ancestors do not match, so the level is chosen in the visible tree.
      const where = and([...(filtered ? plan.baseConditions : conditions), parts.level]);
      const colors = this.colorPlan(plan);
      const { rows } = await sql<DataRow & { __children: bigint; __ancestor_only: boolean }>`
        ${parts.with}
        SELECT ${this.selectList(plan, colors)},
               ${parts.childrenCount} AS __children,
               ${parts.ancestorOnly} AS __ancestor_only
          FROM unnest(ARRAY(
                 SELECT ${col('__id')}
                   FROM ${from}
                  WHERE ${where}
                  ORDER BY ${sql.join(orderBy)}
                  LIMIT ${input.limit} OFFSET ${input.offset}
               )) WITH ORDINALITY AS page (id, ord)
          JOIN ${from} ON ${col('__id')} = page.id
         ORDER BY page.ord
      `.execute(tx);
      const serialized = withColors(
        colors,
        rows,
        await this.serialize(txScope, plan, rows, access),
      );
      const records = serialized.map((record, index) => {
        const row = rows[index];
        return {
          ...record,
          tree: {
            parent_id: parentId,
            depth,
            children_count: Number(row?.__children ?? 0),
            ancestor_only: row?.__ancestor_only === true,
          },
        };
      });
      const page = { records, offset: input.offset, limit: input.limit };
      if (!input.include_total) return page;
      let counted: number;
      if (rows.length < input.limit && (rows.length > 0 || input.offset === 0)) {
        counted = input.offset + rows.length;
      } else {
        const { rows: count } = await sql<CountRow>`
          ${parts.with}
          SELECT count(*) AS n FROM (
            SELECT 1 FROM ${from} WHERE ${where} LIMIT ${this.threshold + 1}
          ) AS capped
        `.execute(tx);
        counted = Number(count[0]?.n ?? 0n);
      }
      return counted <= this.threshold
        ? { ...page, total: counted }
        : { ...page, total_estimate: counted };
    });
  }

  /**
   * Preview of a formula/lookup definition (BACKLOG T456, SPEC §9.6): its
   * values on the first `limit` records the caller reads (or `recordIds`
   * among them), computed by the same SQL as reads with the caller's read
   * scope on every source table (BACKLOG S4b #1b; never the stored values
   * of another person's scope). Runs as a read under `timeoutMs` (2 s):
   * slower is `504 QUERY_TIMEOUT`. See `computed/preview/preview.ts`.
   */
  async previewComputed(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    access: RecordAccessContext,
    input: {
      readonly analysis: FormulaAnalysis;
      readonly recordIds?: readonly Id<'rec'>[];
      readonly limit: number;
      /** Organization zone (ADR-21): the zone of stored values. */
      readonly timeZone: string;
      readonly timeoutMs: number;
    },
  ): Promise<ComputedPreviewRow[]> {
    this.assertScope(scope);
    const tableAccess = this.tableAccess(tableId, access);
    return this.read(
      scope,
      tableId,
      async (txScope, tx) => {
        const table = await this.tables.getById(txScope, tableId);
        if (table === undefined || table.base_id !== access.baseId) throw notFound();
        const model = await this.ruleModel(
          txScope,
          buildTableModel(table, await this.fieldsRepo.listByTable(txScope, tableId), tableAccess),
          access,
        );
        const context = this.resolveContext(access);
        const readable = this.readRule(model, access, context);
        const rows = await loadBaseSchemaRows(this.db, txScope, table.base_id);
        const models = new ComputeModel(rows, { timeZone: input.timeZone });
        return runComputedPreview(tx, {
          table,
          rows,
          analysis: input.analysis,
          alias: ALIAS,
          readable,
          limit: input.limit,
          ...(input.recordIds === undefined ? {} : { recordIds: input.recordIds }),
          compute: {
            timeZone: input.timeZone,
            now: this.now(),
            sourceScope: viewerSourceScope(access, context, (id) => models.model(id)),
          },
        });
      },
      undefined,
      input.timeoutMs,
    );
  }

  /**
   * One keyset batch of the raw values of one column, every row (trash
   * included) in `__auto` order, for field type conversions (T403 preview
   * and revert preview, `records/conversions`). `readable` tells whether the
   * record is live and in the caller's read scope (samples only show those);
   * `access = null` reads for the system (every row readable). Runs in its
   * own read transaction like every read (`ACCESS SHARE` first,
   * `statement_timeout`).
   */
  async scanColumn(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    access: RecordAccessContext | null,
    request: ColumnScanRequest,
  ): Promise<ColumnScanRow[]> {
    this.assertScope(scope);
    return this.read(scope, tableId, async (txScope, tx) => {
      const table = await this.tables.getById(txScope, tableId);
      if (table === undefined || (access !== null && table.base_id !== access.baseId)) {
        throw notFound();
      }
      let readable = sql<SqlBool>`true`;
      if (access !== null) {
        const tableAccess = this.tableAccess(tableId, access);
        const model = await this.ruleModel(
          txScope,
          buildTableModel(table, await this.fieldsRepo.listByTable(txScope, tableId), tableAccess),
          access,
        );
        const rule = this.readRule(model, access, this.resolveContext(access));
        readable = sql<SqlBool>`${col('__deleted_at')} IS NULL AND ${rule}`;
      }
      return scanColumnBatch(tx, table, request, readable);
    });
  }

  /**
   * One keyset batch of the current values of a formula/lookup field
   * (`cell_format=json`), every row (trash included) in `__auto` order, for
   * "convert to static values" previews (T463, `records/conversions/
   * computed-source.ts`); `readable` as in {@link scanColumn}. A field that
   * is not a formula/lookup of the table is `NOT_FOUND`.
   */
  async scanComputed(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    access: RecordAccessContext | null,
    fieldId: Id<'fld'>,
    request: ComputedScanRequest & { readonly timeZone: string; readonly locale: string },
  ): Promise<ComputedScanRow[]> {
    this.assertScope(scope);
    return this.read(scope, tableId, async (txScope, tx) => {
      const table = await this.tables.getById(txScope, tableId);
      if (table === undefined || (access !== null && table.base_id !== access.baseId)) {
        throw notFound();
      }
      const fields = await this.fieldsRepo.listByTable(txScope, tableId);
      const field = fields.find((row) => row.id === fieldId);
      if (field === undefined || (field.type !== 'formula' && field.type !== 'lookup')) {
        throw notFound();
      }
      let readable = sql<SqlBool>`true`;
      if (access !== null) {
        const model = await this.ruleModel(
          txScope,
          buildTableModel(table, fields, this.tableAccess(tableId, access)),
          access,
        );
        const rule = this.readRule(model, access, this.resolveContext(access));
        readable = sql<SqlBool>`${col('__deleted_at')} IS NULL AND ${rule}`;
      }
      const rows = await loadBaseSchemaRows(this.db, txScope, table.base_id);
      return scanComputedBatch(
        tx,
        { members: this.members },
        txScope,
        {
          table,
          field,
          rows,
          timeZone: request.timeZone,
          locale: { locale: request.locale, timeZone: request.timeZone },
        },
        request,
        readable,
      );
    });
  }

  /**
   * One keyset page of link cell sizes for link conversions (T404 preview,
   * `records/links/link-conversion.ts`): `own` groups the field's cells
   * (every junction row counts), `reverse` the cells of the other side of
   * the link, counting links to live records of the field's table (what a
   * reverse field reads, ADR-28 §4). `readable`: the grouped record is live
   * and in the caller's read rule on its table (samples only show those).
   * Runs in its own read transaction like every read.
   */
  async scanLinkCells(
    scope: OrgScope,
    fieldId: Id<'fld'>,
    access: RecordAccessContext,
    request: {
      readonly side: 'own' | 'reverse';
      readonly after: string | null;
      readonly limit: number;
    },
  ): Promise<LinkCellCountRow[]> {
    this.assertScope(scope);
    const field = await this.fieldsRepo.getById(scope, fieldId);
    const link = field === undefined ? null : toLinkFieldModel(field);
    if (field === undefined || link === null) throw notFound();
    return this.read(scope, field.table_id, async (txScope, tx) => {
      const ownTable = await this.tables.getById(txScope, field.table_id);
      if (ownTable?.base_id !== access.baseId) throw notFound();
      const groupTable =
        request.side === 'own' ? ownTable : await this.tables.getById(txScope, link.targetTableId);
      if (groupTable?.base_id !== access.baseId) throw notFound();
      let readable = sql<SqlBool>`false`;
      const tableAccess = access.resolved.access.tables[groupTable.id];
      if (tableAccess !== undefined && (tableAccess.perm as string) !== 'no_perm') {
        const model = await this.ruleModel(
          txScope,
          buildTableModel(
            groupTable,
            await this.fieldsRepo.listByTable(txScope, groupTable.id),
            tableAccess,
          ),
          access,
        );
        const rule = this.readRule(model, access, this.resolveContext(access));
        readable = sql<SqlBool>`${col('__id')} IS NOT NULL AND ${col('__deleted_at')} IS NULL AND ${rule}`;
      }
      return scanLinkCellCounts(
        tx,
        {
          junction: link.junction,
          groupColumn: request.side === 'own' ? link.ownColumn : link.otherColumn,
          groupTable,
          ...(request.side === 'own'
            ? {}
            : { liveThrough: { table: ownTable, column: link.ownColumn } }),
          after: request.after,
          limit: request.limit,
        },
        readable,
      );
    });
  }

  /**
   * Records whose link cell a `to_single` conversion cut (T404 revert
   * preview): the own record ids in the conversion's backup. Empty for any
   * other conversion or once the backup is gone.
   */
  async linkConversionCutCells(scope: OrgScope, conversion: FieldConversionRow): Promise<string[]> {
    this.assertScope(scope);
    const backup = conversion.backup_table_name;
    if (backup === null) return [];
    const field = await this.fieldsRepo.getById(scope, conversion.field_id);
    const link = field === undefined ? null : toLinkFieldModel(field);
    if (field === undefined || link === null) return [];
    return this.read(scope, field.table_id, async (txScope, tx) => {
      const otherTable =
        (await this.tables.getById(txScope, link.targetTableId, { includeDeleted: true })) ?? null;
      return backupCellIds(
        tx,
        {
          junction: link.junction,
          ownColumn: link.ownColumn,
          otherColumn: link.otherColumn,
          otherTable,
          side: link.side,
        },
        backup,
      );
    });
  }

  /**
   * Children of a record (`GET …/records/:recordId/children`, SPEC §5.7):
   * live children the caller reads, in creation order, paged. The record
   * must be live and readable (else `404`); a table without a `parent`
   * field the caller reads is `422 SUBRECORDS_NOT_ENABLED`.
   */
  async children(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    recordId: string,
    access: RecordAccessContext,
    request: RecordChildrenRequest = {},
  ): Promise<RecordListOutput> {
    this.assertScope(scope);
    const tableAccess = this.tableAccess(tableId, access);
    const input = parseRequest(childrenSchema, request);
    return this.read(scope, tableId, async (txScope, tx) => {
      const plan = await this.plan(txScope, tableId, access, tableAccess, input);
      await this.assertReadableRecord(tx, plan, recordId);
      if (plan.model.visibleParent === null) throw subrecordsNotEnabled('');
      const from = this.from(plan.model.table);
      const where = and([
        ...plan.baseConditions,
        sql<SqlBool>`${col('__parent_id')} = ${recordId}`,
      ]);
      // Computed values (T457) only for the page (BACKLOG S4b #11).
      const { rows } = await sql<DataRow>`
        SELECT ${this.selectList(plan)}
          FROM (
            SELECT ${sql.id(ALIAS)}.* FROM ${from}
             WHERE ${where}
             ORDER BY ${renderTerm(AUTO_TERM)}
             LIMIT ${input.limit} OFFSET ${input.offset}
          ) AS ${sql.id(ALIAS)}
         ORDER BY ${renderTerm(AUTO_TERM)}
      `.execute(tx);
      const records = await this.serialize(txScope, plan, rows, access);
      const counted = await this.total(tx, from, where, input.offset, input.limit, rows.length);
      return { records, offset: input.offset, limit: input.limit, ...counted };
    });
  }

  /**
   * Ancestors of a record, root first (`GET …/records/:recordId/ancestors`):
   * readable ones as `{ id, title }`, the others as locked placeholders
   * without id or title. Same `404`/`422` as {@link children}.
   */
  async ancestors(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    recordId: string,
    access: RecordAccessContext,
  ): Promise<{ items: RecordAncestorOutput[] }> {
    this.assertScope(scope);
    const tableAccess = this.tableAccess(tableId, access);
    return this.read(scope, tableId, async (txScope, tx) => {
      const plan = await this.plan(txScope, tableId, access, tableAccess, {
        field_key_type: 'id',
        cell_format: 'json',
        fields: [],
      });
      await this.assertReadableRecord(tx, plan, recordId);
      if (plan.model.visibleParent === null) throw subrecordsNotEnabled('');
      const items = await this.parentReader.ancestors(
        txScope,
        plan.model,
        access,
        plan.context,
        { locale: access.locale, timeZone: access.timeZone },
        recordId as Id<'rec'>,
      );
      return { items };
    });
  }

  /** `404` unless `recordId` is a live record the caller reads. */
  private async assertReadableRecord(tx: Tx, plan: ReadPlan, recordId: string): Promise<void> {
    if (!isId('rec', recordId)) throw recordNotFound();
    const { rows } = await sql<{ one: number }>`
      SELECT 1 AS one FROM ${this.from(plan.model.table)}
       WHERE ${and([...plan.baseConditions, sql<SqlBool>`${col('__id')} = ${recordId}`])}
    `.execute(tx);
    if (rows.length === 0) throw recordNotFound();
  }

  /**
   * A streamed read of every record the caller can read, optionally through
   * a saved view (exports, BACKLOG T307): WHERE = view filter AND read rule
   * AND not deleted; ORDER BY = view group → view sort → `__auto`; columns =
   * readable fields (link and `parent` fields included, T411: their titles
   * follow the caller's access to the linked records, P20; formula/lookup
   * fields too, T462: values under the caller's access, a locked one
   * empty) without the view's `hidden_fields`, in `field_order` then
   * display order.
   *
   * Opening checks the table and the view (`404`), runs `beforeRead`, and
   * counts the matching rows (stopping at `maxRows + 1`), all in one read
   * transaction. `records()` then reads keyset batches: each batch is its
   * own short read-only `REPEATABLE READ` transaction (table `ACCESS SHARE`
   * lock, `statement_timeout`) selecting the next `batchSize` rows after
   * the ORDER BY key of the previous batch's last row (keys travel as text
   * and are compared in their own SQL type, so values round-trip exactly).
   *
   * Consistency: every batch is a consistent snapshot, but batches see
   * changes committed between them (like `READ COMMITTED` at batch
   * granularity). No row is ever returned twice or skipped when its ORDER
   * BY key does not change during the read (always the case without a
   * view sort/group: `__auto` never changes); a record whose sort key moves
   * across the read position meanwhile may appear twice or not at all;
   * records created behind the position are missed, ahead of it included.
   * Holding one snapshot for the whole read would keep the table's
   * `ACCESS SHARE` lock (and a pooled connection) for minutes and make
   * every schema change of the table fail with `SCHEMA_LOCKED` meanwhile.
   * The access context and the view are the ones checked at opening.
   * A share link export (T810) reads with the link's access context and
   * `viewScope: 'share_link'`, its values formatted for the viewer
   * (`options.display`).
   */
  async openStream(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    access: RecordAccessContext,
    request: RecordStreamRequest,
    options: RecordStreamOptions,
  ): Promise<RecordStream> {
    this.assertScope(scope);
    const tableAccess = this.tableAccess(tableId, access);
    const input = parseRequest(streamSchema, request);
    const { maxRows, signal } = options;
    const viewScope = options.viewScope ?? 'member';
    // `cell_format=text` only: formatting, never filtering (date operands keep `access`).
    const display: RecordAccessContext =
      options.display === undefined ? access : { ...access, ...options.display };
    const batchSize = options.batchSize ?? RECORD_STREAM_BATCH_SIZE;
    if (!Number.isSafeInteger(maxRows) || maxRows < 0) {
      throw new RangeError('maxRows must be a non-negative integer');
    }
    if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
      throw new RangeError('batchSize must be a positive integer');
    }
    const readOptions = {
      field_key_type: 'id',
      cell_format: input.cell_format,
      fields: null,
    } as const;

    const opened = await this.read(scope, tableId, async (txScope, tx) => {
      const plan = await this.plan(txScope, tableId, access, tableAccess, readOptions, 'live', {
        viewId: input.view_id ?? null,
        viewScope,
      });
      const target: RecordStreamTarget = {
        table: { id: tableId, name: plan.model.table.name },
        view: plan.view === null ? null : { id: plan.view.row.id, name: plan.view.row.name },
      };
      await options.beforeRead?.(target);
      const where = and(this.scopedConditions(plan, { field_key_type: 'id' }));
      const { rows } = await sql<CountRow>`
        SELECT count(*) AS n FROM (
          SELECT 1 FROM ${this.from(plan.model.table)} WHERE ${where} LIMIT ${maxRows + 1}
        ) AS capped
      `.execute(tx);
      return {
        target,
        view: plan.view,
        columns: streamColumns(plan.model, plan.view, plan.visibleComputed, plan.visibleButtons),
        rowCount: Number(rows[0]?.n ?? 0n),
      };
    });

    const fieldIds = opened.columns.map((field) => field.id);
    const batch = (after: readonly (string | null)[] | null, limit: number) =>
      this.streamBatch(scope, tableId, access, tableAccess, {
        cellFormat: input.cell_format,
        view: opened.view,
        viewScope,
        fieldIds,
        after,
        limit,
        signal,
      });

    return {
      ...opened.target,
      fields: opened.columns,
      rowCount: opened.rowCount,
      exceedsMaxRows: opened.rowCount > maxRows,
      async *records() {
        let after: readonly (string | null)[] | null = null;
        let emitted = 0;
        while (emitted < maxRows) {
          if (signal?.aborted === true) return;
          const limit = Math.min(batchSize, maxRows - emitted);
          const read = await batch(after, limit);
          // Serialized in slices between which the event loop runs.
          for (let start = 0; start < read.rows.length; start += SERIALIZE_SLICE) {
            if (start > 0) await yieldToEventLoop();
            const rows = read.rows.slice(start, start + SERIALIZE_SLICE);
            const records = serializeRows(read.plan, rows, read.users, display);
            applyRelatedCells(read.plan, rows, records, read.related, display);
            applyComputedValues(read.plan, rows, records, read.computedData, display);
            applyButtonLabels(read.plan, records);
            yield records;
          }
          emitted += read.rows.length;
          if (read.rows.length < limit || read.lastKeys === null) return;
          after = read.lastKeys;
          await yieldToEventLoop();
        }
      },
    };
  }

  /** One keyset batch of {@link openStream}, in its own read transaction. */
  private async streamBatch(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    access: RecordAccessContext,
    tableAccess: TableAccess,
    batch: {
      readonly cellFormat: CellFormat;
      readonly view: QueryView | null;
      readonly viewScope: RecordViewScope;
      readonly fieldIds: readonly Id<'fld'>[];
      readonly after: readonly (string | null)[] | null;
      readonly limit: number;
      readonly signal: AbortSignal | undefined;
    },
  ): Promise<{
    plan: ReadPlan;
    rows: DataRow[];
    users: Map<string, UserRef>;
    related: RelatedCells;
    computedData: ComputedCellData | null;
    lastKeys: (string | null)[] | null;
  }> {
    const { signal } = batch;
    signal?.throwIfAborted();
    // Names this batch's backend so that an abort cancels exactly its
    // statement, including a wait for the table lock.
    const applicationName = `cellhive-stream:${randomUUID()}`;
    const onAbort = () => {
      sql`
        SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE application_name = ${applicationName}
      `
        .execute(this.db.kysely)
        .catch(() => undefined);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await this.read(
        scope,
        tableId,
        async (txScope, tx) => {
          const planned = await this.plan(
            txScope,
            tableId,
            access,
            tableAccess,
            { field_key_type: 'id', cell_format: batch.cellFormat, fields: null },
            'live',
            {
              viewId: batch.view?.row.id ?? null,
              viewScope: batch.viewScope,
              ...(batch.view === null ? {} : { pinned: batch.view }),
            },
          );
          // The columns of the opening, minus fields no longer readable.
          const readable = new Map(planned.model.visible.map((field) => [field.id, field]));
          const links = new Map(planned.model.visibleLinks.map((field) => [field.id, field]));
          const computed = new Map(planned.visibleComputed.map((field) => [field.id, field]));
          const buttons = new Map(planned.visibleButtons.map((field) => [field.id, field]));
          const parent = planned.model.visibleParent;
          const plan: ReadPlan = {
            ...planned,
            selected: batch.fieldIds.flatMap((id) => readable.get(id) ?? []),
            // Link titles (T411): the exporter's access to the linked tables (P20).
            selectedLinks: batch.fieldIds.flatMap((id) => links.get(id) ?? []),
            selectedParent: parent !== null && batch.fieldIds.includes(parent.id) ? parent : null,
            // Formula/lookup values under the exporter's access (T462): locked → empty.
            selectedComputed: batch.fieldIds.flatMap((id) => computed.get(id) ?? []),
            // Buttons export their label (T517).
            selectedButtons: batch.fieldIds.flatMap((id) => buttons.get(id) ?? []),
          };
          const organizationId = scope.organizationId;
          const terms = [
            ...this.groupItems(plan, null, 'id').flatMap((item) =>
              groupTerms(item, organizationId),
            ),
            ...(plan.view === null
              ? []
              : viewOrderOf(plan.view.config.sort, plan.model, plan.computed)
            ).map((item) => orderTerm(item, organizationId)),
            AUTO_TERM,
          ];
          const keyName = (index: number) => `k${String(index)}`;
          const keyOf = (relation: string) => (term: OrderTerm, index: number) => ({
            expr: sql.id(relation, keyName(index)),
            direction: term.direction,
          });
          const from = this.from(plan.model.table);
          const where = and(this.scopedConditions(plan, { field_key_type: 'id' }));
          const inner = terms.map(keyOf('q'));
          const outer = terms.map(keyOf('p'));
          const { rows } = await sql<DataRow>`
          SELECT ${this.selectList(plan)},
                 ${sql.join(outer.map((key, index) => sql`${key.expr}::text AS ${sql.id(`s${String(index)}`)}`))}
            FROM (
              SELECT q.*
                FROM (
                  SELECT ${col('__id')} AS __pid,
                         ${sql.join(terms.map((term, index) => sql`${term.expr} AS ${sql.id(keyName(index))}`))}
                    FROM ${from}
                   WHERE ${where}
                ) AS q
               WHERE ${batch.after === null ? sql<SqlBool>`true` : keysetAfter(inner, batch.after)}
               ORDER BY ${sql.join(inner.map(renderTerm))}
               LIMIT ${batch.limit}
            ) AS p
            JOIN ${from} ON ${col('__id')} = p.__pid
           ORDER BY ${sql.join(outer.map(renderTerm))}
        `.execute(tx);
          const users = await this.usersOf(txScope, plan.selected, rows);
          const related = await this.relatedCells(txScope, plan, rows, access);
          const computedData = await this.computedData(txScope, plan, rows, access);
          const last = rows.at(-1);
          const lastKeys =
            last === undefined
              ? null
              : terms.map((_, index) => {
                  const value = last[`s${String(index)}`];
                  return typeof value === 'string' ? value : null;
                });
          return { plan, rows, users, related, computedData, lastKeys };
        },
        applicationName,
      );
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  // -------------------------------------------------------------------------
  // Pipeline steps

  private assertScope(scope: OrgScope): void {
    if (!isOrgScope(scope)) {
      throw new TypeError('RecordQueryService: an OrgScope from orgScope() is required');
    }
  }

  /** Table read access (SPEC §14.1): tables the principal cannot see are `NOT_FOUND`. */
  private tableAccess(tableId: Id<'tbl'>, access: RecordAccessContext): TableAccess {
    // A system scan context is for `scanDue` only (ADR-34 §1): no other read takes it.
    if (isSystemScanAccess(access)) {
      throw new TypeError('RecordQueryService: a system scan context is only read by scanDue');
    }
    const tableAccess = access.resolved.access.tables[tableId];
    // `no_perm` tables are never listed; the check guards hand-built contexts.
    if (tableAccess === undefined || !['read_only', 'edit', 'manage'].includes(tableAccess.perm)) {
      throw notFound();
    }
    return tableAccess;
  }

  private async plan(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    access: RecordAccessContext,
    tableAccess: TableAccess,
    input: z.output<typeof readOptionsSchema>,
    state: 'live' | 'trash' = 'live',
    through: {
      readonly viewId: string | null;
      readonly viewScope: RecordViewScope;
      /** A view already checked by an earlier statement of the same read (streams). */
      readonly pinned?: QueryView;
    } = {
      viewId: null,
      viewScope: 'member',
    },
  ): Promise<ReadPlan> {
    const table = await this.tables.getById(scope, tableId);
    if (table?.base_id !== access.baseId) throw notFound();
    // The view is checked before anything in the request is validated: a
    // view the caller cannot see answers `404` whatever else was sent.
    const view =
      through.pinned ??
      (through.viewId === null
        ? null
        : await loadQueryView(
            this.views,
            scope,
            tableId,
            tableAccess,
            access.userId,
            through.viewId,
          ));
    const rows = await this.fieldsRepo.listByTable(scope, tableId);
    // Link fields become filterable (T402).
    let model = await this.linkFilters.withLinks(scope, buildTableModel(table, rows, tableAccess));
    const context = this.resolveContext(access);
    // Formula/lookup fields (T457): their values for this reader, filterable
    // like the fields of the table.
    const computedPlan = await this.computedPlanner.plan(
      scope,
      model,
      rows,
      tableAccess,
      access,
      context,
      { defaultTimeZone: this.defaultTimeZone, now: new Date(context.now) },
    );
    const computed = computedPlan?.fields ?? [];
    let visibleComputed = computed.filter((field) => field.readable);
    if (computed.length > 0) {
      model = {
        ...model,
        queryFilterMeta: {
          ...model.queryFilterMeta,
          // Saved conditions on a field in error are skipped like conditions
          // that no longer validate (a share link's view then shows nothing, T460).
          fields: [
            ...model.queryFilterMeta.fields,
            ...computed.filter((field) => !inError(field)).map((field) => field.filterMeta),
          ],
        },
      };
    }
    // Button fields (T517): selectable like fields the reader reads.
    let visibleButtons = rows
      .map(toButtonFieldModel)
      .filter(
        (field): field is ButtonFieldModel =>
          field !== null && fieldReadable(tableAccess, field.id),
      );
    if (view !== null && through.viewScope === 'share_link') {
      // Fields hidden in the view are outside the scope of a share link.
      const hidden = new Set<string>(view.config.hidden_fields);
      visibleComputed = visibleComputed.filter((field) => !hidden.has(field.id));
      visibleButtons = visibleButtons.filter((field) => !hidden.has(field.id));
      model = {
        ...model,
        visible: model.visible.filter((field) => !hidden.has(field.id)),
        visibleLinks: model.visibleLinks.filter((field) => !hidden.has(field.id)),
        visibleParent:
          model.visibleParent !== null && hidden.has(model.visibleParent.id)
            ? null
            : model.visibleParent,
      };
    }
    // AI fields (T910, Quyết định S8 #9) are always strict: a source the reader
    // cannot read (hidden by a share link's view too, or a locked formula) locks them.
    const hiddenInView =
      view !== null && through.viewScope === 'share_link'
        ? new Set<string>(view.config.hidden_fields)
        : new Set<string>();
    const lockedComputed = new Set<string>(
      computed.filter((field) => field.locked).map((field) => field.id),
    );
    const lockedAi = model.visible.filter((field) =>
      aiFieldLocked(
        field.row,
        (id) => fieldReadable(tableAccess, id) && !hiddenInView.has(id) && !lockedComputed.has(id),
      ),
    );
    if (lockedAi.length > 0) {
      const ids = new Set<string>(lockedAi.map((field) => field.id));
      model = { ...model, visible: model.visible.filter((field) => !ids.has(field.id)) };
    }
    const selection = this.selectedFields(
      model,
      visibleComputed,
      visibleButtons,
      input.fields ?? null,
      input.field_key_type,
      lockedAi,
    );
    return {
      view,
      viewScope: through.viewScope,
      model,
      selected: selection.fields,
      selectedLinks: selection.links,
      selectedParent: selection.parent,
      computed,
      visibleComputed,
      selectedComputed: selection.computed,
      visibleButtons,
      selectedButtons: selection.buttons,
      selectedLockedAi: selection.lockedAi,
      readableAi: selection.fields.filter((field) => isAiField(field.row)),
      fieldKeyType: input.field_key_type,
      cellFormat: input.cell_format,
      baseConditions:
        state === 'live'
          ? [sql<SqlBool>`${col('__deleted_at')} IS NULL`, this.readRule(model, access, context)]
          : [
              // ADR-23 §4: the trash shows what the caller could restore — records in
              // both the read and the edit rule.
              sql<SqlBool>`${col('__deleted_at')} IS NOT NULL`,
              this.readRule(model, access, context),
              ruleSql(
                resolveRule(access.resolved.internal.editFilters, model, context),
                model,
                ALIAS,
              ),
            ],
      context,
    };
  }

  private resolveContext(access: RecordAccessContext): ResolveContext {
    return {
      userId: access.userId,
      groupMemberUserIds: access.groupMemberUserIds,
      timeZone: access.timeZone,
      now: this.now(),
    };
  }

  /**
   * Visible fields ∩ requested (column fields, and link fields read from
   * their junctions); unknown and hidden names fail alike (422).
   */
  private selectedFields(
    model: TableModel,
    visibleComputed: readonly ComputedField[],
    visibleButtons: readonly ButtonFieldModel[],
    requested: readonly string[] | null,
    keyType: FieldKeyType,
    lockedAi: readonly FieldModel[] = [],
  ): {
    fields: FieldModel[];
    links: LinkFieldModel[];
    parent: ParentFieldModel | null;
    computed: ComputedField[];
    buttons: ButtonFieldModel[];
    lockedAi: FieldModel[];
  } {
    if (requested === null) {
      return {
        fields: [...model.visible],
        links: [...model.visibleLinks],
        parent: model.visibleParent,
        computed: [...visibleComputed],
        buttons: [...visibleButtons],
        lockedAi: [...lockedAi],
      };
    }
    const lockedByKey = new Map(
      lockedAi.map((field) => [keyType === 'id' ? field.id : field.name, field]),
    );
    const locked = new Map<Id<'fld'>, FieldModel>();
    const buttonByKey = new Map(
      visibleButtons.map((field) => [keyType === 'id' ? field.id : field.name, field]),
    );
    const buttons = new Map<Id<'fld'>, ButtonFieldModel>();
    const computedByKey = new Map(
      visibleComputed.map((field) => [keyType === 'id' ? field.id : field.name, field]),
    );
    const computed = new Map<Id<'fld'>, ComputedField>();
    const parentKey =
      model.visibleParent === null
        ? null
        : keyType === 'id'
          ? model.visibleParent.id
          : model.visibleParent.name;
    let parent: ParentFieldModel | null = null;
    const byKey = new Map(
      model.visible.map((field) => [keyType === 'id' ? field.id : field.name, field]),
    );
    const linkByKey = new Map(
      model.visibleLinks.map((field) => [keyType === 'id' ? field.id : field.name, field]),
    );
    const errors: ProblemErrorItem[] = [];
    const selected = new Map<Id<'fld'>, FieldModel>();
    const links = new Map<Id<'fld'>, LinkFieldModel>();
    requested.forEach((key, index) => {
      const field = byKey.get(key);
      const link = field === undefined ? linkByKey.get(key) : undefined;
      const formula = computedByKey.get(key);
      const button = buttonByKey.get(key);
      if (field !== undefined) selected.set(field.id, field);
      else if (link !== undefined) links.set(link.id, link);
      else if (parentKey !== null && key === parentKey) parent = model.visibleParent;
      else if (formula !== undefined) computed.set(formula.id, formula);
      else if (button !== undefined) buttons.set(button.id, button);
      else if (lockedByKey.has(key)) {
        const field = lockedByKey.get(key) as FieldModel;
        locked.set(field.id, field);
      } else errors.push(unknownField(formatIssuePath(['fields', index])));
    });
    if (errors.length > 0) {
      throw new AppError('VALIDATION_FAILED', {
        detail: 'The record query names unknown fields.',
        errors,
      });
    }
    return {
      fields: [...selected.values()],
      links: [...links.values()],
      parent,
      computed: [...computed.values()],
      buttons: [...buttons.values()],
      lockedAi: [...locked.values()],
    };
  }

  /**
   * Record read rule (`internal.readFilters`, already OR-combined across
   * roles by `resolveBaseAccess`). `null` = every record. A rule that no
   * longer validates against the table (e.g. it names a deleted field) fails
   * closed: no record is readable until the role is saved again.
   */
  /**
   * `model` with its link fields in `queryFilterMeta` when the caller's read
   * rule on the table names one (T710), so the rule compiles (else it would
   * fail closed). Query plans always carry them (`plan`).
   */
  private ruleModel(
    scope: OrgScope,
    model: TableModel,
    access: RecordAccessContext,
  ): Promise<TableModel> {
    return this.linkFilters.forRules(
      scope,
      model,
      rulesOf(model, access.resolved.internal.readFilters),
    );
  }

  private readRule(
    model: TableModel,
    access: RecordAccessContext,
    context: ResolveContext,
  ): RawBuilder<SqlBool> {
    return ruleSql(resolveRule(access.resolved.internal.readFilters, model, context), model, ALIAS);
  }

  /**
   * `__deleted_at IS NULL` AND read rule AND view filter AND request filter
   * AND search. The request can only narrow what the view shows.
   */
  private scopedConditions(plan: ReadPlan, input: Scoping): RawBuilder<SqlBool>[] {
    const { model } = plan;
    const conditions = [...plan.baseConditions];
    if (plan.view !== null) {
      let config = plan.view.config;
      if (input.filter_mode === 'replace') {
        if (plan.viewScope === 'share_link') {
          // The view filter of a share link always applies (CONTRACTS §1.4).
          throw new AppError('PERMISSION_DENIED', {
            detail: 'The view filter of a share link cannot be set aside.',
            errors: [{ path: 'filter_mode', code: 'NOT_ALLOWED', message: 'Not allowed.' }],
          });
        }
        // Only the part the caller sees is replaced: saved conditions on fields
        // the caller cannot read still apply (BACKLOG S3 decision 3, T311).
        const readable = new Set<string>(
          [...model.visible, ...model.visibleLinks, ...filterableComputed(plan)].map(
            (field) => field.id,
          ),
        );
        const active = new Set<string>(
          [...model.fields, ...model.links, ...plan.computed].map((field) => field.id),
        );
        const hidden = hiddenFilterOf(config.filter, (id) => active.has(id) && !readable.has(id));
        config = { ...config, filter: hidden };
      }
      const filter = viewFilterOf(config, model, plan.context, plan.viewScope);
      if (filter === 'none') conditions.push(sql<SqlBool>`false`);
      else if (filter !== 'all') {
        conditions.push(compileToSql(filter, model.queryFilterMeta, { tableAlias: ALIAS }));
      }
    }
    if (input.filter !== undefined && input.filter !== null) {
      conditions.push(
        this.requestFilter(
          model,
          input.filter,
          input.field_key_type,
          plan.context,
          filterableComputed(plan),
        ),
      );
    }
    const search = input.search?.trim() ?? '';
    if (search !== '') conditions.push(this.searchCondition(model, search));
    return conditions;
  }

  /**
   * Group levels: the request's `group` (fields the caller reads, like
   * `sort`; `[]` = none) when given, else the view's saved group (fields
   * the caller cannot read still count, BACKLOG S3 decision 3; deleted
   * fields are skipped).
   */
  private groupItems(
    plan: ReadPlan,
    group: readonly { field: string; direction: SortDirection }[] | null | undefined,
    keyType: FieldKeyType,
  ): ViewOrderItem[] {
    if (group !== undefined && group !== null) {
      const byKey = orderableByKey(plan, keyType);
      const errors: ProblemErrorItem[] = [];
      const items = group.flatMap((item, index) => {
        const field = byKey.get(item.field);
        if (field === undefined) {
          const path = formatIssuePath(['group', index, 'field']);
          errors.push(sortKeyIssue(plan.model, item.field, keyType, path));
          return [];
        }
        if (!isOrderableField(field)) {
          errors.push(notSortable(formatIssuePath(['group', index, 'field'])));
          return [];
        }
        return [{ field, direction: item.direction }];
      });
      if (errors.length > 0) {
        throw new AppError('INVALID_SORT', { detail: 'The group is invalid.', errors });
      }
      return items;
    }
    return plan.view === null ? [] : viewOrderOf(plan.view.config.group, plan.model, plan.computed);
  }

  /** Request filter, DSL or tuple, over visible fields only (P08). */
  private requestFilter(
    model: TableModel,
    input: unknown,
    keyType: FieldKeyType,
    context: ResolveContext,
    computed: readonly ComputedField[],
  ): RawBuilder<SqlBool> {
    // Column fields, link fields (T402) and computed fields (T457, not
    // locked) the caller reads (P08).
    const parsed = parseFilterInput(
      input,
      model.queryFilterMeta,
      [...model.visible, ...model.visibleLinks, ...computed].map((field) => field.id),
      { fieldKeyType: keyType },
    );
    if (!parsed.ok) {
      throw new AppError('INVALID_FILTER', {
        detail: 'The filter is invalid.',
        errors: parsed.errors.map((issue: FilterIssue) => ({
          ...issue,
          path: issue.path === '' ? 'filter' : joinFilterPath(issue.path),
        })),
      });
    }
    return compileToSql(resolveVariables(parsed.ast, context), model.queryFilterMeta, {
      tableAlias: ALIAS,
    });
  }

  /**
   * SPEC §7.4: `meta.f_unaccent(lower(primary)) LIKE '%…%'`, i.e. the
   * filter compiler's `contains` on the primary field, which produces the
   * trigram index expression and escapes LIKE metacharacters.
   */
  private searchCondition(model: TableModel, search: string): RawBuilder<SqlBool> {
    const primary = model.visible.find((field) => field.isPrimary);
    if (primary === undefined) {
      // The primary field is hidden from the caller: searching it would leak it.
      throw new AppError('VALIDATION_FAILED', {
        detail: 'Search is not available on this table.',
        errors: [unknownField('search')],
      });
    }
    const condition: ResolvedFilterNode = {
      field: primary.id,
      operator: 'contains',
      value: search,
    };
    return compileToSql(condition, model.filterMeta, { tableAlias: ALIAS });
  }

  private sortTerms(
    plan: ReadPlan,
    sort: readonly { field: string; direction: SortDirection }[],
    keyType: FieldKeyType,
    organizationId: Id<'org'>,
  ): OrderTerm[] {
    const byKey = orderableByKey(plan, keyType);
    const errors: ProblemErrorItem[] = [];
    const keys = sort.flatMap((item, index) => {
      const field = byKey.get(item.field);
      if (field === undefined) {
        const path = formatIssuePath(['sort', index, 'field']);
        errors.push(sortKeyIssue(plan.model, item.field, keyType, path));
        return [];
      }
      if (!isOrderableField(field)) {
        errors.push(notSortable(formatIssuePath(['sort', index, 'field'])));
        return [];
      }
      return [{ expr: sortKey(field, organizationId), direction: item.direction }];
    });
    if (errors.length > 0) {
      throw new AppError('INVALID_SORT', { detail: 'The sort is invalid.', errors });
    }
    return keys;
  }

  private from(table: TableRow): RawBuilder<unknown> {
    return sql`${sql.id(DATA_SCHEMA, assertDataTableName(table.db_table_name))} AS ${sql.id(ALIAS)}`;
  }

  /**
   * The color rules of the view read through that apply to the reader
   * (T816): rules on fields they read — in a share link's scope —, compiled
   * from meta like the view filter. `null` without view or applicable rule.
   */
  private colorPlan(plan: ReadPlan): ColorRulePlan | null {
    const rules = plan.view?.config.color_rules;
    if (rules === undefined || rules.length === 0) return null;
    const { model } = plan;
    const filterable = [...model.visible, ...model.visibleLinks, ...filterableComputed(plan)];
    const cells = [
      ...model.visible,
      ...model.visibleLinks,
      ...(model.visibleParent === null ? [] : [model.visibleParent]),
      ...plan.visibleComputed,
      ...plan.visibleButtons,
    ];
    return colorRulePlan(rules, {
      filterable: new Set<string>(filterable.map((field) => field.id)),
      cells: new Set<string>(cells.map((field) => field.id)),
      filterMeta: model.queryFilterMeta,
      context: plan.context,
      tableAlias: ALIAS,
    });
  }

  /**
   * System columns plus the selected fields' columns as `c0…cn` (never a
   * hidden column), and the color rule columns of `colors` (T816).
   */
  private selectList(
    plan: Pick<ReadPlan, 'selected' | 'selectedParent' | 'selectedComputed'>,
    colors: ColorRulePlan | null = null,
  ): RawBuilder<unknown> {
    return sql.join([
      col('__id'),
      col('__created_at'),
      col('__updated_at'),
      col('__version'),
      ...plan.selected.map(
        (field, index) => sql`${col(field.column)} AS ${sql.id(`c${String(index)}`)}`,
      ),
      // `__parent_id` only when the caller reads the `parent` field (T405).
      ...(plan.selectedParent === null ? [] : [sql`${col('__parent_id')} AS __parent`]),
      // Formula/lookup values as JSON (T457); never computed for a locked field.
      ...plan.selectedComputed.map((field, index) =>
        field.locked
          ? sql`NULL::jsonb AS ${sql.id(computedKey(index))}`
          : sql`to_jsonb(${field.value(ALIAS)}) AS ${sql.id(computedKey(index))}`,
      ),
      ...colorRuleSelect(colors),
    ]);
  }

  /**
   * `total` when at most `threshold` rows match, else `total_estimate`. A
   * short page already gives the exact count; otherwise a capped count
   * (`LIMIT threshold + 1`) bounds the work, and above the cap the planner's
   * row estimate for the same WHERE (`EXPLAIN`, i.e. `pg_class.reltuples`
   * scaled by the filter selectivity) is reported, never below what is
   * known to exist.
   */
  private async total(
    tx: Tx,
    from: RawBuilder<unknown>,
    where: RawBuilder<SqlBool>,
    offset: number,
    limit: number,
    returned: number,
  ): Promise<{ total: number } | { total_estimate: number }> {
    // Exact count, or `threshold + 1` when the cap was hit (a lower bound).
    let counted: number;
    if (returned < limit && (returned > 0 || offset === 0)) {
      counted = offset + returned;
    } else {
      const { rows } = await sql<CountRow>`
        SELECT count(*) AS n FROM (
          SELECT 1 FROM ${from} WHERE ${where} LIMIT ${this.threshold + 1}
        ) AS capped
      `.execute(tx);
      counted = Number(rows[0]?.n ?? 0n);
    }
    if (counted <= this.threshold) return { total: counted };

    const { rows } = await sql<ExplainRow>`
      EXPLAIN (FORMAT JSON) SELECT 1 FROM ${from} WHERE ${where}
    `.execute(tx);
    const estimate = planRows(rows[0]?.['QUERY PLAN']) ?? 0;
    return { total_estimate: Math.max(estimate, counted, offset + returned) };
  }

  private async serialize(
    scope: OrgScope,
    plan: ReadPlan,
    rows: readonly DataRow[],
    access: RecordAccessContext,
  ): Promise<RecordOutput[]> {
    const users = await this.usersOf(scope, plan.selected, rows);
    const records = serializeRows(plan, rows, users, access);
    if (records.length === 0) return records;
    const related = await this.relatedCells(scope, plan, rows, access);
    applyRelatedCells(plan, rows, records, related, access);
    await this.applyComputedCells(scope, plan, rows, records, access);
    await this.applyButtonCells(scope, plan, records, access);
    return this.applyAiCells(scope, plan, records);
  }

  /**
   * AI fields (T910): `null` for the ones the reader is locked out of, and
   * `meta.ai` (state of each cell still waiting, failed or paused) for the
   * ones they read.
   */
  private async applyAiCells(
    scope: OrgScope,
    plan: ReadPlan,
    records: RecordOutput[],
  ): Promise<RecordOutput[]> {
    for (const field of plan.selectedLockedAi) {
      const key = plan.fieldKeyType === 'id' ? field.id : field.name;
      for (const record of records) defineCell(record, key, null);
    }
    if (plan.readableAi.length === 0) return records;
    const rows = await new AiGenerationQueueRepository(this.db).cellStates(
      scope,
      plan.readableAi.map((field) => field.id),
      records.map((record) => record.id),
    );
    const byRecord = new Map<string, Record<string, AiCellState>>();
    for (const row of rows) {
      byRecord.set(row.record_id, { ...byRecord.get(row.record_id), [row.field_id]: row.status });
    }
    return records.map((record) => ({
      ...record,
      meta: { ...record.meta, ai: byRecord.get(record.id) ?? {} },
    }));
  }

  /**
   * Button cells (T517) of `records`, computed for the reader by
   * {@link ButtonCellResolver} in the read's transaction; the label with
   * `cell_format=text`.
   */
  private async applyButtonCells(
    scope: OrgScope,
    plan: ReadPlan,
    records: readonly RecordOutput[],
    access: RecordAccessContext,
  ): Promise<void> {
    const buttons = plan.selectedButtons;
    if (buttons.length === 0 || records.length === 0) return;
    if (plan.cellFormat === 'text') {
      applyButtonLabels(plan, records);
      return;
    }
    const cells = await this.buttonCells.cells(
      {
        scope,
        tableId: plan.model.table.id,
        access,
        anonymous: plan.viewScope === 'share_link' || access.userId === null,
      },
      buttons,
      records.map((record) => record.id),
    );
    for (const button of buttons) {
      const byRecord = cells.get(button.id);
      const key = plan.fieldKeyType === 'id' ? button.id : button.name;
      for (const record of records) {
        defineCell(record, key, byRecord?.get(record.id) ?? null);
      }
    }
  }

  /**
   * Ids among `ids` (at most a page) of live records in the reader's read
   * rule — and edit rule with `editable` — that match `filter` (Filter DSL
   * with field ids; `null` = any): button cells (T517) for the reader
   * (`edit` permission) and for `run_as` (`enabled_when`). A filter on a
   * field the reader cannot read is `422 INVALID_FILTER`; an unreadable
   * table is `404`.
   */
  async matchingIds(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    access: RecordAccessContext,
    ids: readonly Id<'rec'>[],
    filter: unknown,
    options: { readonly editable?: boolean } = {},
  ): Promise<ReadonlySet<string>> {
    this.assertScope(scope);
    const tableAccess = this.tableAccess(tableId, access);
    const input = parseRequest(readOptionsSchema, { field_key_type: 'id' });
    const wanted = [...new Set(ids.filter((id) => isId('rec', id)))];
    if (wanted.length === 0) return new Set();
    return this.read(scope, tableId, async (txScope, tx) => {
      const plan = await this.plan(txScope, tableId, access, tableAccess, input);
      const conditions = [
        ...plan.baseConditions,
        sql<SqlBool>`${col('__id')} = ANY(${sql.val(wanted)}::text[])`,
        ...this.filterConditions(plan, filter),
      ];
      if (options.editable === true) conditions.push(this.editRule(plan, access));
      const { rows } = await sql<{ id: string }>`
        SELECT ${col('__id')} AS id FROM ${this.from(plan.model.table)} WHERE ${and(conditions)}
      `.execute(tx);
      return new Set(rows.map((row) => row.id));
    });
  }

  /**
   * Ids of the live records the reader reads that match `filter` (Filter DSL
   * with field ids, `null` = every one), in `__auto` order, at most `limit`
   * (T910: the rows `POST /fields/:id/ai/generate` queues).
   */
  async allMatchingIds(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    access: RecordAccessContext,
    filter: unknown,
    limit: number,
  ): Promise<Id<'rec'>[]> {
    this.assertScope(scope);
    const tableAccess = this.tableAccess(tableId, access);
    const input = parseRequest(readOptionsSchema, { field_key_type: 'id' });
    return this.read(scope, tableId, async (txScope, tx) => {
      const plan = await this.plan(txScope, tableId, access, tableAccess, input);
      const conditions = [...plan.baseConditions, ...this.filterConditions(plan, filter)];
      const { rows } = await sql<{ id: Id<'rec'> }>`
        SELECT ${col('__id')} AS id FROM ${this.from(plan.model.table)}
         WHERE ${and(conditions)}
         ORDER BY ${col('__auto')}
         LIMIT ${limit}
      `.execute(tx);
      return rows.map((row) => row.id);
    });
  }

  /** Formula/lookup cells (T457) of `records` (same order as `rows`). */
  private async applyComputedCells(
    scope: OrgScope,
    plan: ReadPlan,
    rows: readonly DataRow[],
    records: readonly RecordOutput[],
    access: RecordAccessContext,
  ): Promise<void> {
    const data = await this.computedData(scope, plan, rows, access);
    applyComputedValues(plan, rows, records, data, access);
  }

  /** Display data of the computed cells of `rows` (members, record titles); `null` without any. */
  private async computedData(
    scope: OrgScope,
    plan: ReadPlan,
    rows: readonly DataRow[],
    access: RecordAccessContext,
  ): Promise<ComputedCellData | null> {
    const fields = plan.selectedComputed;
    if (fields.length === 0 || rows.length === 0) return null;
    const locale: LocaleContext = { locale: access.locale, timeZone: access.timeZone };
    const values = fields.map((_, index) => rows.map((row) => row[computedKey(index)] ?? null));
    return this.computedCells.read(scope, fields, values, access, plan.context, locale);
  }

  /**
   * Parent titles (T405) and link cells (T401) of `rows`: one batched read
   * of the parents' titles and one per link field, in the caller's read
   * transaction (`scope.tx`).
   */
  private async relatedCells(
    scope: OrgScope,
    plan: ReadPlan,
    rows: readonly DataRow[],
    access: RecordAccessContext,
  ): Promise<RelatedCells> {
    const locale: LocaleContext = { locale: access.locale, timeZone: access.timeZone };
    let parents: Map<string, LinkRef> | null = null;
    if (plan.selectedParent !== null && rows.length > 0) {
      const parentIds = rows.flatMap((row) =>
        typeof row.__parent === 'string' ? [row.__parent] : [],
      );
      parents = await this.parentReader.refs(
        scope,
        plan.model,
        access,
        plan.context,
        locale,
        parentIds,
      );
    }
    const links =
      plan.selectedLinks.length === 0 || rows.length === 0
        ? null
        : await this.linkReader.read(scope, {
            links: plan.selectedLinks,
            recordIds: rows.map((row) => row.__id),
            access,
            context: plan.context,
            locale,
          });
    return { parents, links };
  }

  /** Batched display data for every user id in the page's user cells (org members only). */
  private async usersOf(
    scope: OrgScope,
    selected: readonly (FieldModel | null)[],
    rows: readonly Readonly<Record<string, unknown>>[],
  ): Promise<Map<string, UserRef>> {
    const ids = new Set<string>();
    selected.forEach((field, index) => {
      if (field === null) return;
      const key = `c${String(index)}`;
      for (const row of rows) {
        const stored = row[key];
        if (field.type === 'user' && Array.isArray(stored)) {
          for (const id of stored) if (typeof id === 'string') ids.add(id);
        } else if (
          (field.type === 'created_by' || field.type === 'updated_by') &&
          typeof stored === 'string'
        ) {
          ids.add(stored);
        }
      }
    });
    const members = await this.members.findMembers(scope, [...ids]);
    return new Map(members.map((member) => [member.id, member]));
  }

  /**
   * Runs a read of `tableId`. Without a transaction in the scope: a read-only
   * `REPEATABLE READ` transaction with `statement_timeout` whose first
   * statement is `LOCK TABLE data.<table> IN ACCESS SHARE MODE`, before any
   * snapshot is taken. With one (e.g. a mutation reading back its result,
   * already under the table's schema lock): inside it. Statement timeouts
   * surface as `QUERY_TIMEOUT` either way.
   *
   * Why the lock comes first: PostgreSQL resolves columns from the latest
   * committed catalog, not from the transaction snapshot. A snapshot taken
   * before a concurrent `SchemaService` DDL commits sees the old meta (a field
   * still active) while the data query sees the new table (column renamed to
   * `__deleted_…` → `42703`; a compacted table → no visible rows). Every such
   * DDL holds `ACCESS EXCLUSIVE` on the data table until it commits, so once
   * `ACCESS SHARE` is granted, the snapshot taken next sees meta and the
   * physical table of the same moment, and no DDL can change the table
   * before this read ends. Compaction copies under `SHARE`, so reads still
   * run while it copies (ADR-20).
   */
  private async read<T>(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    fn: (txScope: OrgScope, tx: Tx) => Promise<T>,
    applicationName?: string,
    timeoutMs: number = this.timeoutMs,
  ): Promise<T> {
    const outer = scope.tx;
    if (outer !== undefined) {
      try {
        return await fn(scope, outer);
      } catch (error) {
        if (isStatementTimeout(error)) {
          throw new AppError('QUERY_TIMEOUT', {
            detail: 'The query took too long and was cancelled.',
            cause: error,
          });
        }
        throw error;
      }
    }
    // The physical name never changes (compaction keeps it, ADR-20), so it
    // can be read before the transaction. A missing table is left to `plan`.
    const table = await this.tables.getById(scope, tableId);
    return this.db.withTx(
      async (tx) => {
        await sql`SET TRANSACTION READ ONLY`.execute(tx);
        if (table !== undefined) await this.lockForRead(tx, table);
        return fn(withTxScope(scope, tx), tx);
      },
      {
        timeoutMs,
        isolationLevel: 'repeatable read',
        ...(applicationName === undefined ? {} : { applicationName }),
      },
    );
  }

  /** `ACCESS SHARE` on the data table; a table dropped meanwhile is `NOT_FOUND`. */
  private async lockForRead(tx: Tx, table: TableRow): Promise<void> {
    const ref = sql.id(DATA_SCHEMA, assertDataTableName(table.db_table_name));
    try {
      await sql`LOCK TABLE ${ref} IN ACCESS SHARE MODE`.execute(tx);
    } catch (error) {
      if (sqlStateOf(error) === SQLSTATE.undefinedTable) throw notFound();
      throw error;
    }
  }
}

/** Rows read per statement by `RecordQueryService.openStream`. */
export const RECORD_STREAM_BATCH_SIZE = 2_000;
/** Records serialized between two turns of the event loop while streaming. */
const SERIALIZE_SLICE = 250;

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * `(k0, …, kn) > after` in the ORDER BY of `keys` (empty cells last in both
 * directions): the row's key equals `after` up to some position and comes
 * after it there. `after` holds the keys as text; each is bound as a
 * parameter whose type PostgreSQL infers from the key, so the comparison
 * runs in the key's own type and collation.
 */
function keysetAfter(
  keys: readonly OrderTerm[],
  after: readonly (string | null)[],
): RawBuilder<SqlBool> {
  const equal = (key: OrderTerm, value: string | null) =>
    value === null ? sql<SqlBool>`${key.expr} IS NULL` : sql<SqlBool>`${key.expr} = ${value}`;
  const branches = keys.flatMap((key, index) => {
    const value = after[index] ?? null;
    // Nothing sorts after an empty cell but other empty cells.
    if (value === null) return [];
    const beyond =
      key.direction === 'asc'
        ? sql<SqlBool>`(${key.expr} > ${value} OR ${key.expr} IS NULL)`
        : sql<SqlBool>`(${key.expr} < ${value} OR ${key.expr} IS NULL)`;
    return [
      and([
        ...keys.slice(0, index).map((previous, at) => equal(previous, after[at] ?? null)),
        beyond,
      ]),
    ];
  });
  return branches.length === 0
    ? sql<SqlBool>`false`
    : sql<SqlBool>`(${sql.join(branches, sql` OR `)})`;
}

/**
 * Columns of a stream: readable fields without the view's `hidden_fields`,
 * first those listed in `field_order` (in that order), then the others in
 * display order.
 */
function streamColumns(
  model: TableModel,
  view: QueryView | null,
  computed: readonly ComputedField[],
  buttons: readonly ButtonFieldModel[],
): RecordStreamField[] {
  // Column fields, link fields (T401), the parent field (T405) and formula/lookup
  // fields the caller reads (T462; a locked one is an empty column), in display order.
  const readable = [
    ...model.visible.map((field) => ({ field: field.row, type: field.type })),
    ...model.visibleLinks.map((field) => ({ field: field.row, type: 'link' })),
    ...(model.visibleParent === null ? [] : [{ field: model.visibleParent.row, type: 'parent' }]),
    ...computed.map((field) => ({ field: field.row, type: field.type })),
    // Buttons export their label (T517).
    ...buttons.map((field) => ({ field: field.row, type: 'button' })),
  ]
    .sort(
      (a, b) =>
        a.field.position - b.field.position ||
        (a.field.id < b.field.id ? -1 : a.field.id > b.field.id ? 1 : 0),
    )
    .map(({ field, type }) => ({ id: field.id, name: field.name, type }));
  if (view === null) return readable;
  const hidden = new Set<string>(view.config.hidden_fields);
  const shown = readable.filter((field) => !hidden.has(field.id));
  const byId = new Map(shown.map((field) => [field.id as string, field]));
  const ordered = new Map<string, RecordStreamField>();
  for (const id of view.config.field_order) {
    const field = byId.get(id);
    if (field !== undefined) ordered.set(id, field);
  }
  for (const field of shown) if (!ordered.has(field.id)) ordered.set(field.id, field);
  return [...ordered.values()];
}

/** A cell of a record, as data (a field named `__proto__` stays data). */
function defineCell(record: RecordOutput, key: string, value: unknown): void {
  Object.defineProperty(record.fields, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** The label of every selected button (`cell_format=text`, exports; T517). */
function applyButtonLabels(
  plan: Pick<ReadPlan, 'selectedButtons' | 'fieldKeyType'>,
  records: readonly RecordOutput[],
): void {
  for (const button of plan.selectedButtons) {
    const key = plan.fieldKeyType === 'id' ? button.id : button.name;
    for (const record of records) defineCell(record, key, button.options.label);
  }
}

/** Cells not stored in the table's own columns, read in a batch per page. */
interface RelatedCells {
  /** Parent `{ id, title }` by parent id; `null` without a selected `parent` field. */
  readonly parents: ReadonlyMap<string, LinkRef> | null;
  /** Link cells by field then record; `null` without selected link fields. */
  readonly links: LinkCells | null;
}

/** Adds the parent and link cells of `related` to `records` (same order as `rows`). */
function applyRelatedCells(
  plan: Pick<ReadPlan, 'selectedParent' | 'selectedLinks' | 'fieldKeyType' | 'cellFormat'>,
  rows: readonly DataRow[],
  records: readonly RecordOutput[],
  related: RelatedCells,
  access: RecordAccessContext,
): void {
  const locale: LocaleContext = { locale: access.locale, timeZone: access.timeZone };
  const define = (record: RecordOutput, key: string, value: unknown) => {
    // A field named `__proto__` stays data.
    Object.defineProperty(record.fields, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  };
  const parent = plan.selectedParent;
  const parents = related.parents;
  if (parent !== null && parents !== null) {
    const key = plan.fieldKeyType === 'id' ? parent.id : parent.name;
    records.forEach((record, index) => {
      const stored = rows[index]?.__parent;
      define(
        record,
        key,
        parentCellValue(
          typeof stored === 'string' ? parents.get(stored) : undefined,
          plan.cellFormat,
          locale,
        ),
      );
    });
  }
  const links = related.links;
  if (links === null) return;
  for (const record of records) {
    for (const link of plan.selectedLinks) {
      const key = plan.fieldKeyType === 'id' ? link.id : link.name;
      define(
        record,
        key,
        linkCellValue(link, links.get(link.id)?.get(record.id), plan.cellFormat, locale),
      );
    }
  }
}

/** Adds the formula/lookup cells (T457) of `rows` to `records` (same order); `data` of {@link RecordQueryService}. */
function applyComputedValues(
  plan: Pick<ReadPlan, 'selectedComputed' | 'fieldKeyType' | 'cellFormat' | 'viewScope'>,
  rows: readonly DataRow[],
  records: readonly RecordOutput[],
  data: ComputedCellData | null,
  access: RecordAccessContext,
): void {
  const fields = plan.selectedComputed;
  if (data === null || fields.length === 0) return;
  const locale: LocaleContext = { locale: access.locale, timeZone: access.timeZone };
  records.forEach((record, row) => {
    fields.forEach((field, index) => {
      // A field named `__proto__` stays data.
      Object.defineProperty(record.fields, plan.fieldKeyType === 'id' ? field.id : field.name, {
        value: computedCellValue(
          field,
          rows[row]?.[computedKey(index)] ?? null,
          data,
          plan.cellFormat,
          locale,
          plan.viewScope,
        ),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    });
  });
}

/** Records of `rows` as the API returns them (`users`: display data of the user cells). */
function serializeRows(
  plan: Pick<ReadPlan, 'selected' | 'fieldKeyType' | 'cellFormat'>,
  rows: readonly DataRow[],
  users: ReadonlyMap<string, UserRef>,
  access: RecordAccessContext,
): RecordOutput[] {
  const { selected, fieldKeyType, cellFormat } = plan;
  const readContext: ReadContext = { resolveUser: (id) => users.get(id) };
  const localeContext: LocaleContext = { locale: access.locale, timeZone: access.timeZone };
  return rows.map((row) => ({
    id: row.__id,
    created_at: row.__created_at.toISOString(),
    updated_at: row.__updated_at.toISOString(),
    version: row.__version,
    // `fromEntries` defines own properties, so a field named `__proto__` stays data.
    fields: Object.fromEntries(
      selected.map((field, index) => {
        const { definition, options } = field;
        const json = definition.fromStorage(row[`c${String(index)}`], options, readContext);
        const value =
          cellFormat === 'text' ? definition.formatText(json, options, localeContext) : json;
        return [fieldKeyType === 'id' ? field.id : field.name, value];
      }),
    ),
  }));
}

/** `items[0].value` → `filter.items[0].value`; tuple paths `conditions[0][2]` likewise. */
function joinFilterPath(path: string): string {
  return path.startsWith('[') ? `filter${path}` : joinPath('filter', path);
}
