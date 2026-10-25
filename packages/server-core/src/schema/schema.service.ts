import { setTimeout as delay } from 'node:timers/promises';

import {
  COMPUTED_BACKFILL_JOB_TYPE,
  DEFAULT_COMPUTED_FIELDS_MAX_PER_BASE,
  DEFAULT_VIEW_NAME,
  isId,
  newId,
  type Id,
  type ProblemErrorItem,
} from '@cellhive/contracts';
import {
  buttonOptionsSchema,
  classifyConversion,
  collateClause,
  getFieldType,
  isImplementedFieldType,
  isS1FieldType,
  linkOptionsSchema,
  MAX_OPTION_COLOR,
  MAX_SELECT_OPTIONS,
  parentOptionsSchema,
  planComputedConversion,
  selectOptionsSchema,
  type AnyFieldTypeDefinition,
  type ConversionSettings,
  type ImplementedFieldType,
  type LinkConversionChange,
  type LinkOptions,
  type S1FieldType,
  type SelectOption,
} from '@cellhive/field-types';
import { joinPath, validateFilter, type FilterIssue } from '@cellhive/filter-dsl';
import { sql, type RawBuilder } from 'kysely';

import { AuditLogsRepository } from '../audit/audit-logs.repository.js';
import { AuditWriter } from '../audit/audit-writer.js';
import {
  analysisOfField,
  computedFingerprint,
  formulaCycleProblem,
  isComputedRow,
  loadBaseSchemaRows,
  prepareComputedDefinition,
  formulaTypeOf,
  type BaseSchemaRows,
  type ComputedDefinitionInput,
  type ComputedFieldTypeName,
  type PreparedComputedDefinition,
  type SchemaReadability,
} from '../computed/definition/index.js';
import {
  fieldErrorJson,
  fieldErrorOf,
  fieldErrorsOf,
  loadFieldErrorsState,
  sameFieldError,
  type FieldError,
} from '../computed/errors/index.js';
import {
  dependentsInOrder,
  edgesOf,
  FieldDependenciesRepository,
  findCycle,
  type FieldDependencyEdge,
} from '../computed/graph/index.js';
import { ComputedRecomputeQueueRepository } from '../computed/recompute/queue.repository.js';
import { ComputedRecomputeService } from '../computed/recompute/recompute.service.js';
import { computedTablePurgeHooks } from '../computed/recompute/table-purge-hooks.js';
import { afterCommit } from '../db/create-db.js';
import { isIndexRowTooLarge, sqlStateOf } from '../db/pg-errors.js';
import { BasesRepository } from '../db/repositories/bases.repository.js';
import { isOrgScope, orgScope, withTxScope, type OrgScope } from '../db/repository.js';
import { AppError } from '../errors/app-error.js';
import { zodIssuesToProblemErrors } from '../errors/zod-issues.js';
import { emit } from '../events/event-writer.js';
import { enqueue } from '../jobs/enqueue.js';
import { JobsRepository } from '../jobs/jobs.repository.js';
import { NotificationBufferRepository } from '../notifications/buffer/notification-buffer.repository.js';
import { RecordFollowsRepository } from '../notifications/follows/record-follows.repository.js';
import { NotificationsRepository } from '../notifications/notifications.repository.js';
import { publishFieldConverting } from '../realtime/field-converting.js';
import { AttachmentsRepository } from '../records/attachments/attachments.repository.js';
import { computedSourceOf } from '../records/conversions/computed-source.js';
import { dueValueKindOf } from '../records/due/due-scan.js';
import {
  backupCellIds,
  hasMultiLinkCells,
  restoreLinkBackup,
  type LinkCellsRef,
} from '../records/links/link-conversion.js';
import { toFieldModel } from '../records/table-model.js';
import { ShareLinksRepository } from '../share-links/share-links.repository.js';
import { configJson, defaultViewConfig } from '../views/view-config.js';
import { ViewsRepository } from '../views/views.repository.js';

import {
  collationExists,
  dueIndexedColumnsOf,
  foreignKeysReferencing,
  indexNamesOf,
  outgoingForeignKeyCount,
  usedColumnSlots,
  type IncomingForeignKey,
} from './catalog.js';
import { checkSchemaConsistency, parentColumnKept, planStoredField } from './consistency.js';
import {
  addShadowColumnSql,
  canonicalOfOldColumn,
  computedDefinitionJson,
  computedDefinitionOf,
  conversionAuditContext,
  conversionColumnsOf,
  definitionJson,
  definitionRefOf,
  dropOldColumnSql,
  dropShadowColumnSql,
  isComputedDefinitionJson,
  planAnyDefinition,
  planComputedDefinition,
  planDefinition,
  restoreOldColumnAsSql,
  retireColumnSql,
  revertAnyColumnSql,
  revertColumnSql,
  storedDefinitionOf,
  swapColumnsSql,
  type StoredDefinition,
} from './conversion-ddl.js';
import { FieldConversionsRepository } from './field-conversions.repository.js';
import { mergeFieldOptions } from './field-options.js';
import { FieldsRepository } from './fields.repository.js';
import {
  assertDataTableName,
  assertFieldColumnName,
  assertJunctionTableName,
  autoSequenceName,
  canonicalColumnOf,
  DATA_SCHEMA,
  dataTableName,
  deletedColumnName,
  DUE_INDEX_SUFFIX,
  fieldColumnName,
  indexName,
  JUNCTION_TABLE_NAME_PATTERN,
  oldColumnName,
  junctionTableName,
  linkBackupTableName,
  parentForeignKeyName,
  renamePrefixed,
  shadowColumnName,
} from './names.js';
import {
  addColumnSql,
  addParentColumnSql,
  analyzeTableSql,
  computedColumnType,
  dropComputedColumnSql,
  planComputedColumn,
  columnDdl,
  createDueIndexSql,
  createIndexSql,
  dropDataTableSql,
  dropJunctionSql,
  createJunctionSql,
  createLinkBackupSql,
  createTableSql,
  dropIndexSql,
  dropJunctionSingleIndexSql,
  junctionSingleIndexSql,
  dropLinkBackupSql,
  dropParentColumnSql,
  dropSingleValueCheckSql,
  PARENT_COLUMN,
  parentColumnDdl,
  parentForeignKeySql,
  parentIndexSql,
  planColumn,
  singleValueCheckSql,
  SYSTEM_COLUMN_NAMES,
  systemIndexesSql,
  UNIQUE_CAPABLE_TYPES,
  validateParentForeignKeySql,
  type ColumnPlan,
} from './physical.js';
import {
  COMPACTION_STATEMENT_TIMEOUT_MS,
  DDL_LOCK_TIMEOUT_MS,
  DDL_MAX_ATTEMPTS,
  ddlRetryDelayMs,
  DEFAULT_SLOT_THRESHOLDS,
  effectiveMaxFields,
  isRetryableDdlError,
  schemaLockKey,
  slotDecision,
  type SlotThresholds,
} from './policy.js';
import { removeDateReminders, syncDateReminder, validateDateReminder } from './reminders.js';
import {
  noopSchemaChangePublisher,
  type SchemaChange,
  type SchemaChangeAction,
  type SchemaChangePublisher,
} from './schema-change-publisher.js';
import { type PurgedTable, type PurgeTableOptions, type TablePurgeHooks } from './table-purge.js';
import { TablesRepository } from './tables.repository.js';

import type { AuditContext } from '../audit/audit-entry.js';
import type { Db, Tx } from '../db/create-db.js';
import type {
  FieldConversionRow,
  FieldRow,
  JsonObject,
  JsonValue,
  TableRow,
  ViewRow,
} from '../db/schema.js';

/** `meta.jobs.type` of the job removing deleted select options from records. */
export const REMOVE_SELECT_OPTIONS_JOB_TYPE = 'schema.remove_select_options';

/** Collation of a base without `settings.collation` (SPEC §18). */
export const DEFAULT_COLLATION = 'und-x-icu';
/** Longest table/field name, in characters (after trimming). */
export const MAX_SCHEMA_NAME_LENGTH = 255;
/** A deleted field can be restored for 30 days (SPEC §5.5, ADR-23 §3). */
export const FIELD_RESTORE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** A type conversion can be reverted for 7 days (SPEC §5.5, ADR-23 §3). */
export const FIELD_CONVERSION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** `meta.jobs.type` of the conversion backfill (T403). */
export const FIELD_CONVERT_JOB = 'field.convert';

export interface SchemaServiceOptions {
  /** `MAX_FIELDS_PER_TABLE` (capped at 1 000). */
  readonly maxFieldsPerTable: number;
  /** `lock_timeout` of each DDL transaction; default 3 s (SPEC §5.1). */
  readonly lockTimeoutMs?: number;
  /** Attempts on lock timeout / serialization failure / deadlock; default 3. */
  readonly maxAttempts?: number;
  /** Column slot thresholds (ADR-20); tests may lower them. */
  readonly slotThresholds?: SlotThresholds;
  /** `statement_timeout` of the compaction transaction; default 30 min. */
  readonly compactionTimeoutMs?: number;
  readonly random?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Realtime hook called after each committed change (S2 wires the WS gateway); default: no-op. */
  readonly publisher?: SchemaChangePublisher;
  /** Receives publisher failures (the change itself has committed). */
  readonly onPublishError?: (error: unknown) => void;
  /**
   * Run inside each table purge transaction (T461), after the `#REF` of
   * computed fields (T460). Default: the recompute of computed fields reading the
   * table or the link fields purged with it (T458).
   */
  readonly tablePurgeHooks?: TablePurgeHooks;
  /** Incremental recompute of computed fields (T458); default: one on the same `Db`. */
  readonly recompute?: ComputedRecomputeService;
  /** `COMPUTED_FIELDS_MAX_PER_BASE` (SPEC §9.5, §20); default 200. */
  readonly maxComputedFieldsPerBase?: number;
}

export interface CreateTableInput {
  readonly baseId: Id<'bse'>;
  readonly name: string;
  /** Name of the primary field, a `text` field (SPEC §5.5). */
  readonly primaryFieldName: string;
  readonly description?: string | null;
}

export interface CreatedTable {
  readonly table: TableRow;
  readonly primaryField: FieldRow;
  /** The grid view every new table gets (SPEC §8, BACKLOG T301). */
  readonly defaultView: ViewRow;
}

export interface AddFieldInput {
  readonly name: string;
  readonly type: string;
  /** Options of the type; validated and defaulted by its schema (`@cellhive/field-types`). */
  readonly options?: unknown;
  readonly description?: string | null;
  readonly required?: boolean;
  readonly uniqueValues?: boolean;
  /** `link` fields: what the saver may use of the linked table. */
  readonly link?: LinkFieldContext;
  /** `formula`/`lookup` fields: what the saver may reference (T456). */
  readonly computed?: ComputedFieldContext;
}

/**
 * What the person saving a `formula`/`lookup` field may reference (SPEC
 * §9.5, BACKLOG T456; permission checks belong to the caller).
 */
export interface ComputedFieldContext {
  /** Tables and fields the saver can read; absent: every one (the system). */
  readonly readable?: SchemaReadability;
  /** Organization zone (ADR-21) for the compile check; default UTC. */
  readonly timeZone?: string;
}

/**
 * What the person saving a `link` field may use of the linked table
 * (permission checks belong to the caller, BACKLOG T401).
 */
export interface LinkFieldContext {
  /**
   * Fields of the linked table the saver can read: `record_filter` may only
   * name these (like a filter of a query, P08). Absent: every active field.
   */
  readonly readableTargetFieldIds?: ReadonlySet<string>;
}

/** Changes of `updateTable`; omitted keys stay as they are. */
export interface TablePatch {
  readonly name?: string;
  readonly description?: string | null;
  /** New 0-based index among the base's tables (clamped); the others shift. */
  readonly position?: number;
}

/**
 * Changes of `updateField`; omitted keys stay as they are. The type never
 * changes here (conversion is S4).
 */
export interface FieldPatch {
  readonly name?: string;
  /** Full new options (validated by the type's schema). Excludes `optionsPatch`. */
  readonly options?: unknown;
  /**
   * Partial options of an API PATCH: merged with the current options under
   * the table's schema lock (`mergeFieldOptions`), so concurrent PATCHes of
   * one field never lose each other's changes. Excludes `options`.
   */
  readonly optionsPatch?: Readonly<Record<string, unknown>>;
  /**
   * The options the caller read before computing `optionsPatch`: select
   * options added since by a concurrent change are kept rather than deleted
   * as "missing from the list". Default: the current options.
   */
  readonly optionsBase?: unknown;
  readonly uniqueValues?: boolean;
  readonly required?: boolean;
  readonly description?: string | null;
  /** New 0-based index among the table's fields (clamped); the others shift. */
  readonly position?: number;
  /** `link` fields: what the saver may use of the linked table (`record_filter`). */
  readonly link?: LinkFieldContext;
  /** `formula`/`lookup` fields: what the saver may reference (T456). */
  readonly computed?: ComputedFieldContext;
}

export interface UpdateFieldOptionsInput {
  /** Full new options (validated by the type's schema); the type itself never changes here. */
  readonly options?: unknown;
  readonly uniqueValues?: boolean;
  readonly required?: boolean;
  readonly description?: string | null;
}

/** A type change of `startConversion` (T403, SPEC §5.5). */
export interface StartConversionInput {
  /** The definition the field had when the caller planned the change (stale → 409). */
  readonly expectedFrom: { readonly type: string; readonly options: JsonValue };
  readonly toType: string;
  /**
   * Full options of the new definition, validated by the type's schema; for
   * select ← text/number they already hold the options the values create.
   */
  readonly toOptions: unknown;
  readonly settings: ConversionSettings;
  /** Locale and zone the values are converted with (base locale, organization zone). */
  readonly locale: string;
  readonly timeZone: string;
  /**
   * A conversion to a formula/lookup (T463): what the person converting may
   * reference (SPEC §9.5) and the organization zone. `toOptions` are then
   * the API options of the definition (display-form expression).
   */
  readonly computed?: ComputedFieldContext;
  /**
   * The caller counted the values (preview counts: lost cells needing
   * `confirm`, select options the values create) at this `data_version` of
   * the table. Records written since then could add lost cells or options
   * nobody confirmed: under the schema lock, where no record write runs,
   * `recount` decides again (throwing, e.g. `CONVERSION_REQUIRES_CONFIRM`,
   * or returning the `toOptions` to use).
   */
  readonly counted?: {
    readonly dataVersion: string;
    readonly recount: () => Promise<unknown>;
  };
}

export interface StartedConversion {
  readonly field: FieldRow;
  readonly jobId: Id<'job'>;
}

/** How a revert treats cells written after the conversion (BACKLOG S4 design decision #7). */
export type RevertMode = 'keep_later_edits' | 'overwrite_later_edits';

export interface RevertConversionOptions {
  readonly mode: RevertMode;
  /**
   * `keep_later_edits`: the edits were merged into the old column from
   * this time on; a record write of the field since then (audit) means
   * another merge is needed (`ConcurrentFieldEditsError`).
   */
  readonly mergedSince?: Date | string;
  /** Counts shown to the caller (`field.converted` event data). */
  readonly counts?: JsonObject;
}

/** A link conversion (T404, ADR-28) as `startLinkConversion` takes it. */
export interface StartLinkConversionInput {
  /** The options the caller planned with (stale → 409). */
  readonly expectedOptions: JsonValue;
  readonly change: LinkConversionChange;
  /** `to_two_way`: name of the reverse field (default: this table's name). */
  readonly reverseName?: string | null;
  /** Counts of the preview: `total` = cells the job works on, `affected` = non-empty cells. */
  readonly counts?: { readonly total: number; readonly affected: number };
}

/** The field was written while a revert merged later edits: merge again. */
export class ConcurrentFieldEditsError extends Error {
  constructor() {
    super('the field was written during the revert');
    this.name = 'ConcurrentFieldEditsError';
  }
}

/** Outcome of a backfill, recorded by `finishConversion`. */
export interface ConversionOutcome {
  readonly status: 'succeeded' | 'failed';
  /** `{ total, affected, lost, truncated }`. */
  readonly counts: JsonObject;
  /** problem+json of a failed backfill (no cell values). */
  readonly error?: JsonObject & { readonly code: string };
}

export interface CompactionResult {
  readonly tableId: Id<'tbl'>;
  readonly dbTableName: string;
  readonly slotsBefore: number;
  readonly slotsAfter: number;
  readonly rows: number;
  /** Deleted fields whose `__deleted_` column was dropped: no longer restorable. */
  readonly purgedFieldIds: readonly Id<'fld'>[];
  /** Deleted fields still restorable (≤ 30 days) whose column was kept. */
  readonly keptDeletedFieldIds: readonly Id<'fld'>[];
  /**
   * Slots are still at or above the compaction threshold after compaction,
   * because of kept trashed columns; the caller logs a warning.
   */
  readonly stillOverBudget: boolean;
  /** Junction foreign keys moved to the new table (ADR-20 step 6). */
  readonly junctionForeignKeys: readonly string[];
}

interface LockOptions {
  readonly includeDeleted?: boolean;
  readonly allowCompacting?: boolean;
  readonly timeoutMs?: number;
}

/** The slot budget is exhausted; compaction is queued outside the failed transaction. */
class SlotBudgetExhausted extends Error {
  constructor(readonly usedSlots: number) {
    super('column slot budget exhausted');
  }
}

/** Names of meta unique indexes that mean "name already used". */
const NAME_CONSTRAINTS: ReadonlySet<string> = new Set([
  'tables_base_name_key',
  'fields_table_name_key',
]);
/** Control characters (`Cc`: U+0000–U+001F, U+007F–U+009F). */
const CONTROL_CHARACTERS = /\p{Cc}/u;
/** `confdeltype` → SQL, for re-created junction foreign keys. */
const ON_DELETE_ACTIONS: Readonly<Record<string, string>> = {
  a: 'NO ACTION',
  r: 'RESTRICT',
  c: 'CASCADE',
  n: 'SET NULL',
  d: 'SET DEFAULT',
};
const CATALOG_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

/** Text hashed into the advisory lock that serialises table order changes of a base. */
function tableOrderLockKey(baseId: Id<'bse'>): string {
  return `schema-order:${baseId}`;
}

/** Moves `id` to `index` (clamped) in `ids`; `null` when it is already there or absent. */
function reorder<T extends string>(
  ids: readonly T[],
  id: T,
  index: number,
): { readonly order: T[]; readonly from: number; readonly to: number } | null {
  const from = ids.indexOf(id);
  if (from < 0) return null;
  const to = Math.min(Math.max(index, 0), ids.length - 1);
  if (from === to) return null;
  const order = ids.filter((candidate) => candidate !== id);
  order.splice(to, 0, id);
  return { order, from, to };
}

/** Rows whose `position` differs from their index in `order`. */
function positionChanges<T extends string>(
  order: readonly T[],
  rows: readonly { readonly id: T; readonly position: number }[],
): { id: T; position: number }[] {
  const current = new Map(rows.map((row) => [row.id, row.position]));
  return order.flatMap((id, index) => (current.get(id) === index ? [] : [{ id, position: index }]));
}

function assertPosition(position: number | undefined): void {
  if (position !== undefined && (!Number.isSafeInteger(position) || position < 0)) {
    throw validationFailed([
      { path: 'position', code: 'TOO_SMALL', message: 'Must be a non-negative integer' },
    ]);
  }
}

/** `{ before, after }` restricted to the keys whose values differ; `null` when none do. */
function changedKeys(
  before: JsonObject,
  after: JsonObject,
): { before: JsonObject; after: JsonObject } | null {
  const changed: { before: JsonObject; after: JsonObject } = { before: {}, after: {} };
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const from = before[key] ?? null;
    const to = after[key] ?? null;
    if (!sameJson(from, to)) {
      changed.before[key] = from;
      changed.after[key] = to;
    }
  }
  return Object.keys(changed.after).length === 0 ? null : changed;
}

/** Ids of the select options of `before` that `after` no longer has. */
function removedOptionIds(before: JsonValue, after: JsonValue): Id<'opt'>[] {
  const previous = selectOptionsSchema.safeParse(before ?? {});
  const next = selectOptionsSchema.safeParse(after ?? {});
  if (!previous.success || !next.success) return [];
  const kept = new Set<string>(next.data.options.map((option) => option.id));
  return previous.data.options.map((option) => option.id).filter((id) => !kept.has(id));
}

/**
 * Whether new options change what formulas read of the field's values
 * (T458): a select option renamed (formulas see option names, BACKLOG S4b
 * #10) or a date field's own zone (ADR-21).
 */
function changesFormulaValues(before: FieldRow, after: FieldRow): boolean {
  if (before.type === 'select') {
    const previous = selectOptionsSchema.safeParse(before.options ?? {});
    const next = selectOptionsSchema.safeParse(after.options ?? {});
    if (!previous.success || !next.success) return false;
    const names = new Map<string, string>(
      next.data.options.map((option) => [option.id, option.name]),
    );
    return previous.data.options.some(
      (option) => names.has(option.id) && names.get(option.id) !== option.name,
    );
  }
  if (before.type === 'datetime' || before.type === 'created_at' || before.type === 'updated_at') {
    const zone = (options: JsonValue) =>
      isRecordValue(options) && typeof options['timezone'] === 'string'
        ? options['timezone']
        : null;
    return zone(before.options) !== zone(after.options);
  }
  return false;
}

function validationFailed(errors: ProblemErrorItem[], detail?: string): AppError {
  return new AppError('VALIDATION_FAILED', {
    ...(detail === undefined ? {} : { detail }),
    errors,
  });
}

/** Trimmed name, or `VALIDATION_FAILED` for empty/too long/control characters. */
export function normalizeSchemaName(value: unknown, path = 'name'): string {
  if (typeof value !== 'string') {
    throw validationFailed([{ path, code: 'EXPECTED_STRING', message: 'Expected a string' }]);
  }
  const name = value.normalize('NFC').trim();
  if (name.length === 0 || name.length > MAX_SCHEMA_NAME_LENGTH) {
    throw validationFailed([
      {
        path,
        code: 'INVALID_LENGTH',
        message: `Must be 1 to ${String(MAX_SCHEMA_NAME_LENGTH)} characters`,
        params: { minimum: 1, maximum: MAX_SCHEMA_NAME_LENGTH },
      },
    ]);
  }
  if (CONTROL_CHARACTERS.test(name)) {
    throw validationFailed([
      { path, code: 'INVALID_CHARACTERS', message: 'Must not contain control characters' },
    ]);
  }
  return name;
}

function nameConflict(kind: 'table' | 'field', name: string): AppError {
  return new AppError('NAME_CONFLICT', {
    detail: `A ${kind} with this name already exists.`,
    errors: [{ path: 'name', code: 'NAME_CONFLICT', message: `The ${kind} name is already used` }],
    params: { kind, name },
  });
}

/** `422 VALIDATION_FAILED` / `LINK_TABLE_PURGED`: the junction of the link went with its table (T461). */
function linkTablePurged(field: FieldRow): AppError {
  return validationFailed(
    [
      {
        path: 'field_id',
        code: 'LINK_TABLE_PURGED',
        message: 'The linked table was permanently deleted',
        params: { field_id: field.id },
      },
    ],
    'The linked table was permanently deleted: this link field cannot be restored.',
  );
}

function notFound(kind: 'base' | 'table' | 'field'): AppError {
  return new AppError('NOT_FOUND', { detail: `The ${kind} does not exist.` });
}

function fieldSnapshot(field: FieldRow): JsonObject {
  return {
    id: field.id,
    table_id: field.table_id,
    name: field.name,
    type: field.type,
    options: field.options,
    is_primary: field.is_primary,
    required: field.required,
    unique_values: field.unique_values,
    description: field.description,
    position: field.position,
    // Formula/lookup (T456): how the value is kept and its type.
    ...(field.compute_mode === null
      ? {}
      : { compute_mode: field.compute_mode, result_type: field.result_type }),
  };
}

function tableSnapshot(table: TableRow): JsonObject {
  return {
    id: table.id,
    base_id: table.base_id,
    name: table.name,
    description: table.description,
    primary_field_id: table.primary_field_id,
    position: table.position,
  };
}

function parseOptions(
  definition:
    | Pick<AnyFieldTypeDefinition, 'optionsSchema'>
    | { readonly optionsSchema: typeof linkOptionsSchema }
    | { readonly optionsSchema: typeof parentOptionsSchema }
    | { readonly optionsSchema: typeof buttonOptionsSchema },
  options: unknown,
  path = 'options',
): unknown {
  const parsed = definition.optionsSchema.safeParse(options ?? {});
  if (!parsed.success) {
    throw validationFailed(
      zodIssuesToProblemErrors(parsed.error.issues).map((item) => ({
        ...item,
        path: item.path === '' ? path : `${path}.${item.path}`,
      })),
    );
  }
  return parsed.data;
}

/** A `button` field (T517) holds no value: never unique, never required. */
function assertButtonConstraints(
  uniqueValues: boolean | undefined,
  required: boolean | undefined,
): void {
  const errors: ProblemErrorItem[] = [];
  if (uniqueValues === true) {
    errors.push({
      path: 'unique_values',
      code: 'UNIQUE_NOT_SUPPORTED',
      message: 'Field type button cannot require unique values',
      params: { type: 'button' },
    });
  }
  if (required === true) {
    errors.push({
      path: 'required',
      code: 'REQUIRED_NOT_SUPPORTED',
      message: 'Field type button cannot be required: it holds no value',
      params: { type: 'button' },
    });
  }
  if (errors.length > 0) throw validationFailed(errors);
}

/** A `parent` field is never unique nor required (roots have no parent). */
function assertParentConstraints(
  uniqueValues: boolean | undefined,
  required: boolean | undefined,
): void {
  const errors: ProblemErrorItem[] = [];
  if (uniqueValues === true) {
    errors.push({
      path: 'unique_values',
      code: 'UNIQUE_NOT_SUPPORTED',
      message: 'Field type parent cannot require unique values',
      params: { type: 'parent' },
    });
  }
  if (required === true) {
    errors.push({
      path: 'required',
      code: 'REQUIRED_NOT_SUPPORTED',
      message: 'Field type parent cannot be required: roots have no parent',
      params: { type: 'parent' },
    });
  }
  if (errors.length > 0) throw validationFailed(errors);
}

function s1Definition(type: string): {
  type: ImplementedFieldType;
  definition: AnyFieldTypeDefinition;
} {
  if (!isImplementedFieldType(type)) {
    throw validationFailed([
      {
        path: 'type',
        code: 'UNSUPPORTED_FIELD_TYPE',
        message: `Field type ${JSON.stringify(type)} is not supported`,
        params: { type },
      },
    ]);
  }
  const definition = getFieldType(type);
  if (definition === undefined) throw new TypeError(`No definition for ${type}`);
  return { type, definition };
}

/** A type conversions work with (T403: stored and system types, not link/attachment). */
function conversionDefinition(type: string): {
  type: S1FieldType;
  definition: AnyFieldTypeDefinition;
} {
  // Link, parent, attachment and reserved types all answer the same code
  // (T404: `parent` used to fall through to `UNSUPPORTED_FIELD_TYPE`).
  if (!isS1FieldType(type)) {
    throw new AppError('CONVERSION_NOT_ALLOWED', {
      detail: `Fields of type ${type} cannot be converted.`,
      errors: [
        {
          path: 'type',
          code: 'CONVERSION_NOT_ALLOWED',
          message: `Fields of type ${type} cannot be converted`,
          params: { type },
        },
      ],
    });
  }
  const found = s1Definition(type);
  return { type, definition: found.definition };
}

/**
 * The only code allowed to run DDL on `data.*` (AGENTS.md rule 1). Each
 * operation runs in one transaction that also writes meta, the event and the
 * audit entry, so the physical table and `meta.tables`/`meta.fields` always
 * change together (SPEC §5.1):
 *
 * - `SET LOCAL lock_timeout` (3 s) and `pg_advisory_xact_lock` keyed by the
 *   table id serialise schema changes of a table; a lock timeout,
 *   serialization failure or deadlock retries the whole transaction up to 3
 *   times with jitter, then answers `409 SCHEMA_LOCKED`;
 * - a table being compacted answers `409 SCHEMA_LOCKED`;
 * - identifiers come from meta short ids (`t_…`, `f_…`) through `sql.id()`;
 *   user-chosen names only ever reach SQL as bound parameters (meta rows);
 * - the column budget of ADR-20 is checked before every DDL that consumes a
 *   slot.
 *
 * Permission checks belong to the caller (T103): the service only enforces
 * tenant isolation through the `OrgScope`. The scope must not carry a
 * transaction: the service opens (and may retry) its own.
 */
export class SchemaService {
  private readonly tables: TablesRepository;
  private readonly fields: FieldsRepository;
  private readonly bases: BasesRepository;
  private readonly jobs: JobsRepository;
  private readonly views: ViewsRepository;
  private readonly conversions: FieldConversionsRepository;
  private readonly auditLogs: AuditLogsRepository;
  private readonly shareLinks: ShareLinksRepository;
  private readonly attachments: AttachmentsRepository;
  private readonly tablePurgeHooks: TablePurgeHooks;
  private readonly recompute: ComputedRecomputeService;
  private readonly dependencies: FieldDependenciesRepository;
  private readonly maxComputed: number;
  private readonly audit = new AuditWriter();
  private readonly maxFields: number;
  private readonly lockTimeoutMs: number;
  private readonly maxAttempts: number;
  private readonly thresholds: SlotThresholds;
  private readonly compactionTimeoutMs: number;
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly publisher: SchemaChangePublisher;
  private readonly onPublishError: (error: unknown) => void;

  constructor(
    private readonly db: Db,
    options: SchemaServiceOptions,
  ) {
    this.tables = new TablesRepository(db);
    this.fields = new FieldsRepository(db);
    this.bases = new BasesRepository(db);
    this.jobs = new JobsRepository(db);
    this.views = new ViewsRepository(db);
    this.conversions = new FieldConversionsRepository(db);
    this.auditLogs = new AuditLogsRepository(db);
    this.shareLinks = new ShareLinksRepository(db);
    this.attachments = new AttachmentsRepository(db);
    this.recompute = options.recompute ?? new ComputedRecomputeService(db);
    this.tablePurgeHooks = options.tablePurgeHooks ?? computedTablePurgeHooks(this.recompute);
    this.dependencies = new FieldDependenciesRepository(db);
    this.maxComputed = options.maxComputedFieldsPerBase ?? DEFAULT_COMPUTED_FIELDS_MAX_PER_BASE;
    this.maxFields = effectiveMaxFields(options.maxFieldsPerTable);
    this.lockTimeoutMs = options.lockTimeoutMs ?? DDL_LOCK_TIMEOUT_MS;
    this.maxAttempts = options.maxAttempts ?? DDL_MAX_ATTEMPTS;
    this.thresholds = options.slotThresholds ?? DEFAULT_SLOT_THRESHOLDS;
    this.compactionTimeoutMs = options.compactionTimeoutMs ?? COMPACTION_STATEMENT_TIMEOUT_MS;
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? ((ms) => delay(ms));
    this.publisher = options.publisher ?? noopSchemaChangePublisher;
    this.onPublishError = options.onPublishError ?? (() => undefined);
    if (!Number.isSafeInteger(this.lockTimeoutMs) || this.lockTimeoutMs < 1) {
      throw new RangeError('lockTimeoutMs must be a positive integer');
    }
    if (!Number.isSafeInteger(this.maxAttempts) || this.maxAttempts < 1) {
      throw new RangeError('maxAttempts must be a positive integer');
    }
  }

  // -------------------------------------------------------------------------
  // Tables

  /**
   * Creates `data.t_<shortId>` with the system columns, a `text` primary
   * field with its trigram index, and the meta rows, in one transaction. The
   * table's text collation is the base's `settings.collation` (default
   * `und-x-icu`), checked against `pg_collation`.
   */
  async createTable(
    scope: OrgScope,
    input: CreateTableInput,
    context: AuditContext,
  ): Promise<CreatedTable> {
    this.assertScope(scope);
    const name = normalizeSchemaName(input.name, 'name');
    const primaryName = normalizeSchemaName(input.primaryFieldName, 'primary_field_name');
    const tableId = newId('tbl');
    const created = await this.retrying(tableId, async () =>
      this.db.withTx(async (tx) => {
        await this.lock(tx, tableId);
        const txScope = withTxScope(scope, tx);
        const base = await this.bases.getById(txScope, input.baseId);
        if (base === undefined) throw notFound('base');
        await this.lockTableOrder(tx, input.baseId);
        const collation = await this.baseCollation(tx, base.settings);
        if (await this.tables.nameTaken(txScope, input.baseId, name)) {
          throw nameConflict('table', name);
        }

        const dbTableName = dataTableName();
        const primaryId = newId('fld');
        const primaryOptions = parseOptions(s1Definition('text').definition, {});
        const plan = planColumn(
          {
            type: 'text',
            options: primaryOptions,
            column: fieldColumnName(),
            isPrimary: true,
            uniqueValues: false,
          },
          dbTableName,
          collation,
        );
        if (plan === null) throw new TypeError('text fields always have a column');

        await this.execute(tx, [createTableSql(dbTableName), ...systemIndexesSql(dbTableName)]);
        await this.execute(tx, columnDdl(dbTableName, plan));

        await this.tables.insert(txScope, {
          id: tableId,
          baseId: input.baseId,
          name,
          description: input.description ?? null,
          dbTableName,
          collation,
          position: await this.tables.nextPosition(txScope, input.baseId),
        });
        const primaryField = await this.fields.insert(txScope, {
          id: primaryId,
          tableId,
          name: primaryName,
          type: 'text',
          dbColumnName: plan.column,
          options: primaryOptions as JsonObject,
          isPrimary: true,
          required: false,
          uniqueValues: false,
          description: null,
          position: 0,
        });
        const table = await this.tables.update(txScope, tableId, { primaryFieldId: primaryId });
        if (table === undefined) throw new Error('table row vanished');
        const defaultView = await this.views.insert(txScope, {
          id: newId('viw'),
          tableId,
          type: 'grid',
          name: DEFAULT_VIEW_NAME,
          config: configJson(defaultViewConfig('grid')),
          position: 0,
          ownerId: null,
        });

        const after = { ...tableSnapshot(table), primary_field: fieldSnapshot(primaryField) };
        await this.record(tx, context, {
          type: 'table.created',
          table,
          entityType: 'table',
          entityId: table.id,
          before: null,
          after,
        });
        await this.record(tx, context, {
          type: 'view.created',
          table,
          entityType: 'view',
          entityId: defaultView.id,
          before: null,
          after: {
            id: defaultView.id,
            table_id: table.id,
            type: defaultView.type,
            name: defaultView.name,
            is_personal: false,
          },
        });
        // The new table is part of every role's access (SPEC §14.1).
        await this.bases.bumpPermissionVersion(txScope, { baseIds: [table.base_id] });
        return { table, primaryField, defaultView };
      }),
    );
    await this.publish(created.table, 'table', created.table.id, 'created');
    return created;
  }

  /** Renames a table (meta only). */
  async renameTable(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    newName: string,
    context: AuditContext,
  ): Promise<TableRow> {
    return this.updateTable(scope, tableId, { name: newName }, context);
  }

  /**
   * Changes a table's name, description or display order (meta only, also
   * while the table is compacted). One `table.updated` event with the
   * changed keys; nothing is written when nothing changes. `position` moves
   * the table to that index among the base's tables and renumbers the others.
   */
  async updateTable(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    patch: TablePatch,
    context: AuditContext,
  ): Promise<TableRow> {
    this.assertScope(scope);
    const name = patch.name === undefined ? undefined : normalizeSchemaName(patch.name);
    assertPosition(patch.position);
    const result = await this.withTableLock(
      scope,
      tableId,
      async (tx, table) => {
        const txScope = withTxScope(scope, tx);
        const rename = name !== undefined && name !== table.name;
        if (rename && (await this.tables.nameTaken(txScope, table.base_id, name, tableId))) {
          throw nameConflict('table', name);
        }
        const describe = patch.description !== undefined && patch.description !== table.description;
        let current = table;
        if (rename || describe) {
          const updated = await this.tables.update(txScope, tableId, {
            ...(rename ? { name } : {}),
            ...(describe ? { description: patch.description } : {}),
          });
          if (updated === undefined) throw notFound('table');
          current = updated;
        }
        const before: JsonObject = {};
        const after: JsonObject = {};
        if (rename) {
          before.name = table.name;
          after.name = current.name;
        }
        if (describe) {
          before.description = table.description;
          after.description = current.description;
        }
        if (patch.position !== undefined) {
          await this.lockTableOrder(tx, table.base_id);
          const siblings = await this.tables.listByBase(txScope, table.base_id);
          const moved = reorder(
            siblings.map((row) => row.id),
            tableId,
            patch.position,
          );
          if (moved !== null) {
            await this.tables.setPositions(
              txScope,
              table.base_id,
              positionChanges(moved.order, siblings),
            );
            current = (await this.tables.getById(txScope, tableId)) ?? current;
            before.position = moved.from;
            after.position = moved.to;
          }
        }
        if (Object.keys(after).length === 0) return { table: current, changed: false };
        await this.record(tx, context, {
          type: 'table.updated',
          table: current,
          entityType: 'table',
          entityId: tableId,
          before,
          after,
        });
        return { table: current, changed: true };
      },
      { allowCompacting: true },
    );
    if (result.changed) await this.publish(result.table, 'table', tableId, 'updated');
    return result.table;
  }

  /**
   * Restores a table from the trash (meta only: the physical table was
   * kept). The name must still be free (`409 NAME_CONFLICT`); the table goes
   * to the end of the base's order. A table outside the trash is returned
   * as it is.
   */
  async restoreTable(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    context: AuditContext,
  ): Promise<TableRow> {
    this.assertScope(scope);
    const result = await this.withTableLock(
      scope,
      tableId,
      async (tx, table) => {
        if (table.deleted_at === null) return { table, changed: false };
        const txScope = withTxScope(scope, tx);
        if (await this.tables.nameTaken(txScope, table.base_id, table.name, tableId)) {
          throw nameConflict('table', table.name);
        }
        await this.lockTableOrder(tx, table.base_id);
        const updated = await this.tables.update(txScope, tableId, {
          deletedAt: null,
          position: await this.tables.nextPosition(txScope, table.base_id),
        });
        if (updated === undefined) throw notFound('table');
        await this.record(tx, context, {
          type: 'table.restored',
          table: updated,
          entityType: 'table',
          entityId: tableId,
          before: null,
          after: tableSnapshot(updated),
        });
        // T460: fields reading it heal; its own stored formula/lookup fields
        // missed every change of other tables while in the trash: computed again.
        const own = await this.fields.listByTable(txScope, tableId);
        await this.reconcileComputedErrors(tx, scope, table.base_id, context, {
          backfill: own.filter(isComputedRow).map((field) => field.id),
        });
        await this.bases.bumpPermissionVersion(txScope, { baseIds: [table.base_id] });
        return { table: updated, changed: true };
      },
      { includeDeleted: true },
    );
    if (result.changed) await this.publish(result.table, 'table', tableId, 'restored');
    return result.table;
  }

  /**
   * Moves a table to the trash (meta only: the physical table stays, so a
   * restore is instant; purging drops it later).
   */
  async deleteTable(scope: OrgScope, tableId: Id<'tbl'>, context: AuditContext): Promise<TableRow> {
    this.assertScope(scope);
    const deleted = await this.withTableLock(scope, tableId, async (tx, table) => {
      const txScope = withTxScope(scope, tx);
      const updated = await this.tables.update(txScope, tableId, {
        deletedAt: new Date(),
      });
      if (updated === undefined) throw notFound('table');
      await this.record(tx, context, {
        type: 'table.deleted',
        table: updated,
        entityType: 'table',
        entityId: tableId,
        before: tableSnapshot(table),
        after: null,
      });
      // T460: formula/lookup fields of other tables reading it → `REF`.
      await this.reconcileComputedErrors(tx, scope, table.base_id, context);
      await this.bases.bumpPermissionVersion(txScope, { baseIds: [table.base_id] });
      return updated;
    });
    await this.publish(deleted, 'table', tableId, 'deleted');
    return deleted;
  }

  // -------------------------------------------------------------------------
  // Table purge (BACKLOG T461, CONTRACTS §13, ADR-23 §3)

  /**
   * Deletes a table of the trash for good, in one transaction holding the
   * schema locks of the table and of every table linking to it:
   *
   * - `link` fields of other tables pointing at it (one-way links, reverse
   *   fields of two-way links, fields already in the trash included) go to
   *   the trash marked `link_table_purged_at`: a restore answers `422
   *   LINK_TABLE_PURGED` (their junction is gone). One `field.deleted` per
   *   field that was active, published as `schema.changed` after commit;
   * - DDL: the backup tables of link conversions (`l_x__old_*`), every
   *   junction referencing the table, then `data.t_x` (its `__old_` /
   *   `__deleted_` columns and sequences go with it);
   * - meta: the table's fields marked purged, its views deleted, the share
   *   links of its views/forms revoked (`share_link.revoked`, `reason =
   *   table_purged`), conversions `cleaned`, its files handed to
   *   `attachments.cleanup` (`record_purged_at`: an object shared with
   *   another table is kept), `purged_at` set;
   * - `#REF` of computed fields (T460), the `tablePurgeHooks`, then one `table.purged` event and
   *   audit entry, `after = { name, record_count, partner_field_ids }`.
   *
   * Manual (`reason = manual`, base admins: the caller checks): a table
   * outside the trash → `422 TABLE_NOT_IN_TRASH`, `confirmName` not the
   * table name → `422 CONFIRM_NAME_MISMATCH`. Retention: `null` (nothing
   * done) when the table left the trash or was deleted after
   * `deletedBefore`. A purged or missing table → `404`; a field of the
   * table or of a linking table being converted → `409 SCHEMA_LOCKED`.
   */
  async purgeTable(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    options: PurgeTableOptions,
    context: AuditContext,
  ): Promise<PurgedTable | null> {
    this.assertScope(scope);
    const result = await this.withTableLock(
      scope,
      tableId,
      async (tx, table) => {
        if (table.deleted_at === null) {
          if (options.reason === 'retention') return null;
          throw validationFailed(
            [
              {
                path: 'table_id',
                code: 'TABLE_NOT_IN_TRASH',
                message: 'The table is not in the trash',
              },
            ],
            'Only a table in the trash can be deleted permanently.',
          );
        }
        if (
          options.deletedBefore !== undefined &&
          table.deleted_at.getTime() >= options.deletedBefore.getTime()
        ) {
          return null;
        }
        if (
          options.reason === 'manual' &&
          (options.confirmName ?? '').normalize('NFC').trim() !== table.name
        ) {
          throw validationFailed(
            [
              {
                path: 'confirm_name',
                code: 'CONFIRM_NAME_MISMATCH',
                message: 'Type the table name to confirm',
              },
            ],
            'The confirmation does not match the table name.',
          );
        }
        return this.purgeLocked(tx, scope, table, options, context);
      },
      { includeDeleted: true },
    );
    if (result === null) return null;
    for (const partner of result.trashed) {
      await this.publish(partner.table, 'field', partner.field.id, 'deleted');
    }
    return result.purged;
  }

  private async purgeLocked(
    tx: Tx,
    scope: OrgScope,
    table: TableRow,
    options: PurgeTableOptions,
    context: AuditContext,
  ): Promise<{ purged: PurgedTable; trashed: LinkPartner[] }> {
    const txScope = withTxScope(scope, tx);
    // Tables linking to this one, locked in id order. Creating, deleting or
    // restoring a link to this table also needs its lock (held), so the set
    // below cannot change until commit.
    const touching = await this.fields.listLinksTouching(txScope, table.id);
    const partnerTables = new Map<Id<'tbl'>, TableRow>();
    const partnerTableIds = [
      ...new Set(touching.filter((f) => f.table_id !== table.id).map((f) => f.table_id)),
    ].sort();
    for (const partnerTableId of partnerTableIds) {
      const locked = await this.lockLinkPartnerTable(tx, txScope, table, partnerTableId);
      if (locked !== undefined) partnerTables.set(partnerTableId, locked);
    }
    // Re-read under every lock: a partner field may have changed meanwhile.
    const links = await this.fields.listLinksTouching(txScope, table.id);
    const partners = links.filter(
      (field) => field.table_id !== table.id && partnerTables.has(field.table_id),
    );
    const conversions = await this.conversions.listTouching(
      txScope,
      table.id,
      partners.map((field) => field.id),
    );
    const running = conversions.find((conversion) => conversion.status === 'running');
    if (running !== undefined) throw fieldConvertingError(running.field_id, 'table_id');

    const { rows: counted } = await sql<{ n: string | number | bigint }>`
      SELECT count(*) AS n FROM ${this.tableRef(table.db_table_name)}
    `.execute(tx);
    const recordCount = Number(counted[0]?.n ?? 0);

    // DDL: link backups, then every junction referencing the table (meta and
    // catalog agree; the catalog also catches a junction meta lost), then
    // the data table without CASCADE.
    const junctions = new Set<string>();
    for (const link of links) if (link.link_junction !== null) junctions.add(link.link_junction);
    for (const key of await foreignKeysReferencing(tx, table.db_table_name)) {
      if (!key.self && key.schema === DATA_SCHEMA && JUNCTION_TABLE_NAME_PATTERN.test(key.table)) {
        junctions.add(key.table);
      }
    }
    const backups = [
      ...new Set(
        conversions
          .map((conversion) => conversion.backup_table_name)
          .filter((name): name is string => name !== null),
      ),
    ].sort();
    await this.execute(tx, [
      ...backups.map((backup) => dropLinkBackupSql(backup)),
      ...[...junctions].sort().map((junction) => dropJunctionSql(junction)),
      dropDataTableSql(table.db_table_name),
    ]);

    const now = new Date();
    // Link fields of other tables: in the trash for good ("delete one side",
    // ADR-28 §2, without the restore: the junction is gone).
    const marked = await this.fields.markLinkTablePurged(
      txScope,
      partners.map((field) => field.id),
      now,
    );
    const trashed: LinkPartner[] = [];
    for (const field of marked) {
      const before = partners.find((partner) => partner.id === field.id);
      const partnerTable = partnerTables.get(field.table_id);
      // A field already in the trash only gets the mark.
      if (before === undefined || before.deleted_at !== null || partnerTable === undefined) {
        continue;
      }
      await this.record(tx, context, {
        type: 'field.deleted',
        table: partnerTable,
        entityType: 'field',
        entityId: field.id,
        before: fieldSnapshot(before),
        after: null,
        data: { reason: 'table_purged', purged_table_id: table.id },
      });
      trashed.push({ table: partnerTable, field });
    }
    const partnerFieldIds = marked.map((field) => field.id);

    const fields = await this.fields.listByTable(txScope, table.id, { includeDeleted: true });
    await this.fields.markTablePurged(txScope, table.id, now);
    await this.views.deleteByTable(txScope, table.id);
    await this.revokeShareLinksOfTable(tx, txScope, table, context);
    await this.conversions.markManyCleaned(
      txScope,
      conversions
        .filter((conversion) => conversion.status === 'succeeded')
        .map((conversion) => conversion.job_id),
    );
    await this.attachments.markTablePurged(txScope, table.id, now);
    // ADR-32 §1 (T515): notifications about its records go with them.
    await new NotificationsRepository(this.db).deleteRecordsOfTable(txScope, table.id);
    // T543: so do the follows of its records (the meta row stays, `purged_at`).
    await new RecordFollowsRepository(this.db).deleteForTable(txScope, table.id);
    // T560 (T543 note): and its rows waiting for a grouped notification.
    await new NotificationBufferRepository(this.db).deleteForTable(txScope, table.id);
    // T547: its date fields remind of nothing any more (no cascade: the field rows stay).
    await removeDateReminders(
      this.db,
      txScope,
      fields.map((field) => field.id),
    );
    const purged = await this.tables.markPurged(txScope, table.id, now);
    if (purged === undefined) throw notFound('table');
    await this.bases.bumpPermissionVersion(txScope, {
      baseIds: [...new Set([table.base_id, ...[...partnerTables.values()].map((t) => t.base_id)])],
    });
    // T460: formula/lookup fields reading the table (already `REF` since it
    // went to the trash) or a link field trashed for good above → `REF`.
    await this.reconcileComputedErrors(tx, scope, table.base_id, context, {
      causes: partnerFieldIds,
    });
    await this.tablePurgeHooks.onTablePurged(tx, {
      table: purged,
      fields,
      partnerFields: marked,
      context,
    });
    await this.record(tx, context, {
      type: 'table.purged',
      table: purged,
      entityType: 'table',
      entityId: table.id,
      before: null,
      after: { name: table.name, record_count: recordCount, partner_field_ids: partnerFieldIds },
      data: { reason: options.reason },
    });
    return { purged: { table: purged, recordCount, partnerFieldIds }, trashed };
  }

  /**
   * Share links of the views and forms of a purged table: revoked, one
   * `share_link.revoked` (`reason = table_purged`) + audit entry each; the
   * token then answers `410` (CONTRACTS §16A).
   */
  private async revokeShareLinksOfTable(
    tx: Tx,
    scope: OrgScope,
    table: TableRow,
    context: AuditContext,
  ): Promise<void> {
    const revokedBy =
      context.actor.type === 'user' && isId('usr', context.actor.id) ? context.actor.id : null;
    const links = await this.shareLinks.revokeByTable(scope, table.id, revokedBy);
    for (const link of links) {
      const snapshot: JsonObject = {
        id: link.id,
        base_id: link.base_id,
        table_id: link.table_id,
        target_type: link.target_type,
        target_id: link.target_id,
        audience: link.audience,
        has_password: link.password_hash !== null,
        expires_at: link.expires_at === null ? null : link.expires_at.toISOString(),
        enabled: link.enabled,
        settings: link.settings,
        created_by: link.created_by,
      };
      await emit(tx, {
        type: 'share_link.revoked',
        organizationId: table.organization_id,
        entityType: 'share_link',
        entityId: link.id,
        actor: context.actor,
        baseId: link.base_id,
        tableId: table.id,
        data: {
          target_type: link.target_type,
          target_id: link.target_id,
          audience: link.audience,
          reason: 'table_purged',
        },
      });
      await this.audit.write(tx, {
        action: 'share_link.revoked',
        organizationId: table.organization_id,
        baseId: link.base_id,
        tableId: table.id,
        entityType: 'share_link',
        entityId: link.id,
        before: snapshot,
        after: null,
        context,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Fields

  /**
   * Adds a field: `ALTER TABLE … ADD COLUMN f_<shortId> <pgType>` (plus the
   * single-value CHECK, GIN/unique indexes), the meta row, `field.created`
   * and its audit entry, in one transaction.
   *
   * - `MAX_FIELDS_PER_TABLE` active fields → `422 FIELD_LIMIT_EXCEEDED`;
   * - column slots ≥ 1 550 → `409 SCHEMA_LOCKED` (compaction is queued);
   *   ≥ 1 400 after this column → `schema.compact_table` is queued;
   * - an `auto_number` field queues `schema.recompute_auto_number` to number
   *   existing records.
   */
  async addField(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    input: AddFieldInput,
    context: AuditContext,
  ): Promise<FieldRow> {
    this.assertScope(scope);
    if (input.type === 'link') return this.addLinkField(scope, tableId, input, context);
    if (input.type === 'parent') return this.addParentField(scope, tableId, input, context);
    if (input.type === 'formula' || input.type === 'lookup') {
      return this.addComputedField(scope, tableId, input, context);
    }
    if (input.type === 'button') return this.addButtonField(scope, tableId, input, context);
    const name = normalizeSchemaName(input.name);
    const { type, definition } = s1Definition(input.type);
    const options = parseOptions(definition, input.options);
    const uniqueValues = input.uniqueValues ?? false;
    if (uniqueValues && !UNIQUE_CAPABLE_TYPES.has(type)) {
      throw validationFailed([
        {
          path: 'unique_values',
          code: 'UNIQUE_NOT_SUPPORTED',
          message: `Field type ${type} cannot require unique values`,
          params: { type },
        },
      ]);
    }
    try {
      const added = await this.withTableLock(scope, tableId, async (tx, table) => {
        const txScope = withTxScope(scope, tx);
        await this.assertFieldCapacity(txScope, tableId);
        if (await this.fields.nameTaken(txScope, tableId, name)) throw nameConflict('field', name);
        // T547: the references of a date reminder, then its cursor below.
        if (type === 'datetime') await validateDateReminder(this.db, txScope, tableId, options);

        const plan = planColumn(
          { type, options, column: fieldColumnName(), isPrimary: false, uniqueValues },
          table.db_table_name,
          table.collation,
        );
        if (plan !== null) {
          await this.reserveSlots(tx, table, 1);
          await this.execute(tx, columnDdl(table.db_table_name, plan));
        }
        const field = await this.fields.insert(txScope, {
          id: newId('fld'),
          tableId,
          name,
          type,
          dbColumnName: plan?.column ?? null,
          options: options as JsonObject,
          isPrimary: false,
          required: input.required ?? false,
          uniqueValues,
          description: input.description ?? null,
          position: await this.fields.nextPosition(txScope, tableId),
        });
        if (type === 'auto_number') await this.enqueueAutoNumberRecompute(tx, field);
        await syncDateReminder(this.db, txScope, field.id, null, field);
        await this.record(tx, context, {
          type: 'field.created',
          table,
          entityType: 'field',
          entityId: field.id,
          before: null,
          after: fieldSnapshot(field),
        });
        // The new field is part of every role's access (SPEC §14.1).
        await this.bases.bumpPermissionVersion(txScope, { baseIds: [table.base_id] });
        return { field, table };
      });
      await this.publish(added.table, 'field', added.field.id, 'created');
      return added.field;
    } catch (error) {
      if (error instanceof SlotBudgetExhausted) {
        await this.db.withTx((tx) => this.enqueueCompaction(tx, scope.organizationId, tableId));
        throw new AppError('SCHEMA_LOCKED', {
          detail:
            'The table has used its column budget; it is being compacted. Try again in a few minutes.',
          params: { table_id: tableId, used_slots: error.usedSlots },
        });
      }
      throw error;
    }
  }

  /** Renames a field (meta only: the column is named after the field id). */
  async renameField(
    scope: OrgScope,
    fieldId: Id<'fld'>,
    newName: string,
    context: AuditContext,
  ): Promise<FieldRow> {
    return this.updateField(scope, fieldId, { name: newName }, context);
  }

  /**
   * Changes `options` (style, select options, rules…), `unique_values`,
   * `required` or `description` without changing the column type (see
   * `updateField`).
   */
  async updateFieldOptions(
    scope: OrgScope,
    fieldId: Id<'fld'>,
    patch: UpdateFieldOptionsInput,
    context: AuditContext,
  ): Promise<FieldRow> {
    return this.updateField(
      scope,
      fieldId,
      {
        ...(patch.options === undefined ? {} : { options: patch.options }),
        ...(patch.uniqueValues === undefined ? {} : { uniqueValues: patch.uniqueValues }),
        ...(patch.required === undefined ? {} : { required: patch.required }),
        ...(patch.description === undefined ? {} : { description: patch.description }),
      },
      context,
    );
  }

  /**
   * Changes a field without changing its type, in one transaction with one
   * `field.updated` event holding the changed keys (nothing is written when
   * nothing changes):
   *
   * - `name` (meta only: the column is named after the field id);
   * - `options` (style, select options, rules…), `unique_values`,
   *   `required`, `description`;
   * - `position`: moves the field to that index among the table's fields
   *   and renumbers the others.
   *
   * Rules:
   * - a change that would change the column type (datetime format between
   *   date-only and date-time: `date` ↔ `timestamptz`) → `422
   *   CONVERSION_NOT_ALLOWED` until the conversion flow (S4, SPEC §5.5);
   * - `multiple` false → true drops the single-value CHECK; true → false
   *   truncates data, a conversion → `422 CONVERSION_NOT_ALLOWED` (CONTRACTS §4.2);
   * - `unique_values` creates/drops the partial unique index; existing
   *   duplicates → `422 UNIQUE_VIOLATION`;
   * - changed `auto_number` rules queue `schema.recompute_auto_number`;
   * - select options missing from the new `options.options` queue
   *   `schema.remove_select_options`, which removes their ids from the
   *   records through `RecordMutationService` (renaming or recolouring an
   *   option changes meta only: records store option ids).
   *
   * Name, description and position changes are allowed while the table is
   * compacted; the others answer `409 SCHEMA_LOCKED` meanwhile.
   */
  async updateField(
    scope: OrgScope,
    fieldId: Id<'fld'>,
    patch: FieldPatch,
    context: AuditContext,
  ): Promise<FieldRow> {
    return (await this.updateFieldWithJob(scope, fieldId, patch, context)).field;
  }

  /**
   * `updateField`, also returning the `schema.remove_select_options` job it
   * queued (`null` when no select option was deleted), so the API can hand
   * its id to the caller (CONTRACTS §13).
   */
  async updateFieldWithJob(
    scope: OrgScope,
    fieldId: Id<'fld'>,
    patch: FieldPatch,
    context: AuditContext,
  ): Promise<{ readonly field: FieldRow; readonly removeOptionsJobId: Id<'job'> | null }> {
    this.assertScope(scope);
    const name = patch.name === undefined ? undefined : normalizeSchemaName(patch.name);
    assertPosition(patch.position);
    if (patch.options !== undefined && patch.optionsPatch !== undefined) {
      throw new TypeError('updateField: pass either options or optionsPatch');
    }
    const metaOnly =
      patch.options === undefined &&
      patch.optionsPatch === undefined &&
      patch.uniqueValues === undefined &&
      patch.required === undefined;
    const result = await this.withFieldLock(
      scope,
      fieldId,
      async (tx, table, field) => {
        const txScope = withTxScope(scope, tx);
        await this.assertNotConverting(txScope, field);
        const rename = name !== undefined && name !== field.name;
        if (rename && (await this.fields.nameTaken(txScope, table.id, name, fieldId))) {
          throw nameConflict('field', name);
        }
        // Merged here, from the options read under the lock (never from a
        // snapshot taken before it: that would lose concurrent changes).
        // Formula/lookup (T456): the definition is re-analysed (display form
        // of the API merged with the stored one), columns and dependents follow.
        const computed = isComputedRow(field);
        let computedChange: ComputedChange | null = null;
        if (computed) {
          assertComputedConstraints(field.type, patch.uniqueValues, patch.required);
          const given =
            patch.optionsPatch ?? (isRecordValue(patch.options) ? patch.options : undefined);
          if (given !== undefined) {
            computedChange = await this.changeComputedDefinition(
              tx,
              scope,
              table,
              field,
              given,
              patch.computed,
              context,
            );
          }
        }
        const requested = computed
          ? undefined
          : patch.optionsPatch === undefined
            ? patch.options
            : mergeFieldOptions(field.type, field.options, patch.optionsPatch, patch.optionsBase);
        const options =
          requested === undefined
            ? undefined
            : field.type === 'link'
              ? await this.linkOptionsForUpdate(txScope, field, requested, patch.link)
              : field.type === 'parent'
                ? (parseOptions({ optionsSchema: parentOptionsSchema }, requested) as JsonObject)
                : field.type === 'button'
                  ? (parseOptions({ optionsSchema: buttonOptionsSchema }, requested) as JsonObject)
                  : (parseOptions(s1Definition(field.type).definition, requested) as JsonObject);
        if (!metaOnly && !computed) {
          if (field.type === 'parent') {
            assertParentConstraints(patch.uniqueValues, patch.required);
          } else if (field.type === 'button') {
            // No column: options are meta only (T517).
            assertButtonConstraints(patch.uniqueValues, patch.required);
          } else if (field.type === 'link') {
            await this.applyLinkFieldOptions(tx, field, options, patch.uniqueValues);
          } else {
            await this.applyFieldOptions(tx, table, field, options, patch.uniqueValues);
          }
        }

        // T547: a date reminder names a field of this table or members.
        if (field.type === 'datetime' && options !== undefined) {
          await validateDateReminder(this.db, txScope, table.id, options, field);
        }
        let current = computedChange?.field ?? field;
        const changes = {
          ...(rename ? { name } : {}),
          ...(options === undefined ? {} : { options }),
          ...(patch.uniqueValues === undefined ? {} : { uniqueValues: patch.uniqueValues }),
          ...(patch.required === undefined ? {} : { required: patch.required }),
          ...(patch.description === undefined ? {} : { description: patch.description }),
        };
        if (Object.keys(changes).length > 0) {
          const updated = await this.fields.update(txScope, fieldId, changes);
          if (updated === undefined) throw notFound('field');
          current = updated;
        }
        // Positions are compared as indexes below, not as stored sort keys.
        const snapshotBefore = fieldSnapshot(field);
        const snapshotAfter = fieldSnapshot(current);
        delete snapshotBefore.position;
        delete snapshotAfter.position;
        const changed = changedKeys(snapshotBefore, snapshotAfter) ?? { before: {}, after: {} };
        // A field in error saved again, or healed by its new definition (T460).
        if (computed && !sameJson(field.compute_error, current.compute_error)) {
          changed.before.compute_error = field.compute_error;
          changed.after.compute_error = current.compute_error;
        }
        if (patch.position !== undefined) {
          const siblings = await this.fields.listByTable(txScope, table.id);
          const moved = reorder(
            siblings.map((row) => row.id),
            fieldId,
            patch.position,
          );
          if (moved !== null) {
            await this.fields.setPositions(
              txScope,
              table.id,
              positionChanges(moved.order, siblings),
            );
            current = (await this.fields.getById(txScope, fieldId)) ?? current;
            changed.before.position = moved.from;
            changed.after.position = moved.to;
          }
        }
        if (Object.keys(changed.after).length === 0) {
          return { field: current, table, changed: false, jobId: undefined, dependents: undefined };
        }

        if (field.type === 'auto_number' && !sameJson(field.options, current.options)) {
          await this.enqueueAutoNumberRecompute(tx, current);
        }
        // T547: turned on, changed (re-armed: no catch-up) or off.
        await syncDateReminder(this.db, txScope, fieldId, field, current);
        let jobId: Id<'job'> | undefined = computedChange?.jobId;
        if (field.type === 'select' && field.db_column_name !== null) {
          const removed = removedOptionIds(field.options, current.options);
          if (removed.length > 0) {
            jobId = await this.enqueueOptionRemoval(tx, current, removed, context);
          }
        }
        // Formulas see option names and field zones (BACKLOG S4b #10, ADR-21):
        // the computed fields reading this one are recomputed (T458, job).
        if (!computed && changesFormulaValues(field, current)) {
          await this.recomputeReaders(tx, table, [fieldId]);
        }
        await this.record(tx, context, {
          type: 'field.updated',
          table,
          entityType: 'field',
          entityId: fieldId,
          before: changed.before,
          after: changed.after,
          ...(jobId === undefined ? {} : { jobId }),
        });
        return {
          field: current,
          table,
          changed: true,
          jobId,
          dependents: computedChange?.dependents,
        };
      },
      { allowCompacting: metaOnly },
    );
    if (result.changed) await this.publish(result.table, 'field', fieldId, 'updated');
    for (const dependent of result.dependents ?? []) {
      await this.publish(dependent.table, 'field', dependent.fieldId, 'updated');
    }
    return { field: result.field, removeOptionsJobId: result.jobId ?? null };
  }

  /**
   * Physical side of an options/unique change: refuses column type changes
   * and single-value truncation (S4 conversions), then adds/drops the
   * single-value CHECK and the unique index.
   */
  private async applyFieldOptions(
    tx: Tx,
    table: TableRow,
    field: FieldRow,
    newOptions: JsonObject | undefined,
    newUniqueValues: boolean | undefined,
  ): Promise<void> {
    const { type, definition } = s1Definition(field.type);
    const options = newOptions ?? parseOptions(definition, field.options);
    const uniqueValues = newUniqueValues ?? field.unique_values;
    if (uniqueValues && !UNIQUE_CAPABLE_TYPES.has(type)) {
      throw validationFailed([
        {
          path: 'unique_values',
          code: 'UNIQUE_NOT_SUPPORTED',
          message: `Field type ${type} cannot require unique values`,
          params: { type },
        },
      ]);
    }
    const before = planStoredField(field, table);
    const after =
      field.db_column_name === null
        ? null
        : planColumn(
            {
              type,
              options,
              column: field.db_column_name,
              isPrimary: field.is_primary,
              uniqueValues,
            },
            table.db_table_name,
            table.collation,
          );
    if (before === null || after === null) return;
    if (before.pgType !== after.pgType) {
      throw new AppError('CONVERSION_NOT_ALLOWED', {
        detail:
          'This change alters the column type; it needs the field conversion flow, which is not available yet.',
        errors: [
          {
            path: type === 'datetime' ? 'options.style.format' : 'options',
            code: 'CONVERSION_NOT_ALLOWED',
            message: `Changing the column type from ${before.pgType} to ${after.pgType} is not allowed here`,
            params: { from: before.pgType, to: after.pgType },
          },
        ],
      });
    }
    if (!before.singleValue && after.singleValue) {
      throw new AppError('CONVERSION_NOT_ALLOWED', {
        detail: 'Switching to a single value truncates data; it needs the conversion flow.',
        errors: [
          {
            path: 'options.multiple',
            code: 'CONVERSION_NOT_ALLOWED',
            message: 'Changing multiple from true to false is a conversion',
          },
        ],
      });
    }
    await this.alterConstraints(tx, table.db_table_name, before, after);
  }

  /**
   * Adds select options named `names` to `fieldId` **inside the caller's
   * transaction** (`scope.tx`), for `RecordMutationService` creating options
   * from typecast values (CONTRACTS §2, SPEC §14.1 `option_edit_fields`) in
   * the same transaction as the record write: the options exist if and only
   * if the records that use them are written.
   *
   * Every other SchemaService operation opens (and may retry) its own
   * transaction; this one cannot, so it neither retries nor changes
   * `lock_timeout`. It takes the table's schema advisory lock (re-entrant:
   * the caller normally already holds it exclusively, before touching the
   * data table, which keeps the lock order of DDL) and changes meta only —
   * select options live in `meta.fields.options`, no DDL. Names that already
   * exist are skipped; new options get fresh `opt_…` ids. Emits
   * `field.updated` and its audit entry like `updateFieldOptions`.
   *
   * Permission checks belong to the caller. More than 1 000 options →
   * `422 TOO_MANY_OPTIONS`.
   *
   * The change is committed by the caller, so it cannot be published here:
   * when options were added, the `schema.changed` change is pushed onto
   * `committed`, for the caller to hand to `publishCommitted` after its
   * commit (and to drop on rollback).
   */
  async addSelectOptionsInTx(
    scope: OrgScope,
    fieldId: Id<'fld'>,
    names: readonly string[],
    context: AuditContext,
    committed?: SchemaChange[],
  ): Promise<FieldRow> {
    if (!isOrgScope(scope)) {
      throw new TypeError('SchemaService: an OrgScope from orgScope() is required');
    }
    const tx = scope.tx;
    if (tx === undefined) {
      throw new TypeError(
        'addSelectOptionsInTx runs in the caller transaction; pass a scope with tx',
      );
    }
    const located = await this.fields.getById(scope, fieldId);
    if (located === undefined) throw notFound('field');
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${schemaLockKey(located.table_id)}, 0))`.execute(
      tx,
    );
    const table = await this.tables.getById(scope, located.table_id);
    if (table === undefined) throw notFound('table');
    if (table.schema_state === 'compacting') {
      throw new AppError('SCHEMA_LOCKED', {
        detail: 'The table is being compacted; try again in a few minutes.',
        params: { table_id: table.id, schema_state: table.schema_state },
      });
    }
    const field = await this.fields.getById(scope, fieldId);
    if (field === undefined) throw notFound('field');
    if (field.type !== 'select') throw new TypeError('addSelectOptionsInTx: not a select field');
    const { definition } = s1Definition(field.type);
    const current = selectOptionsSchema.parse(field.options ?? {});
    const existing = new Set(current.options.map((option) => option.name));
    const added: SelectOption[] = [];
    for (const raw of names) {
      const name = raw.trim();
      if (existing.has(name)) continue;
      existing.add(name);
      added.push({
        id: newId('opt'),
        name,
        color: (current.options.length + added.length) % (MAX_OPTION_COLOR + 1),
      });
    }
    if (added.length === 0) return field;
    if (current.options.length + added.length > MAX_SELECT_OPTIONS) {
      throw new AppError('TOO_MANY_OPTIONS', {
        detail: `A select field can have at most ${String(MAX_SELECT_OPTIONS)} options.`,
        errors: [
          {
            path: 'options',
            code: 'TOO_MANY_OPTIONS',
            message: `A select field can have at most ${String(MAX_SELECT_OPTIONS)} options`,
            params: { limit: MAX_SELECT_OPTIONS },
          },
        ],
      });
    }
    const options = parseOptions(definition, {
      ...current,
      options: [...current.options, ...added],
    });
    const updated = await this.fields.update(scope, fieldId, { options: options as JsonObject });
    if (updated === undefined) throw notFound('field');
    await this.record(tx, context, {
      type: 'field.updated',
      table,
      entityType: 'field',
      entityId: fieldId,
      before: fieldSnapshot(field),
      after: fieldSnapshot(updated),
    });
    committed?.push(schemaChangeOf(table, 'field', fieldId, 'updated'));
    return updated;
  }

  /**
   * Publishes schema changes made in a caller's transaction
   * (`addSelectOptionsInTx`) once that transaction has committed. Failures
   * go to `onPublishError`, never to the caller.
   */
  async publishCommitted(changes: readonly SchemaChange[]): Promise<void> {
    for (const change of changes) {
      try {
        await this.publisher.publish(change);
      } catch (error) {
        this.onPublishError(error);
      }
    }
  }

  /**
   * Moves a field to the trash: `deleted_at` in meta and
   * `RENAME COLUMN f_x TO f_x__deleted_<epoch>` (no slot consumed). The
   * primary field cannot be deleted.
   */
  async deleteField(scope: OrgScope, fieldId: Id<'fld'>, context: AuditContext): Promise<FieldRow> {
    this.assertScope(scope);
    const deleted = await this.withFieldLock(scope, fieldId, async (tx, table, field) => {
      await this.assertNotConverting(withTxScope(scope, tx), field);
      if (field.is_primary) {
        throw validationFailed(
          [
            {
              path: 'field_id',
              code: 'PRIMARY_FIELD_NOT_DELETABLE',
              message: 'The primary field cannot be deleted',
            },
          ],
          'The primary field cannot be deleted.',
        );
      }
      const deletedAt = new Date();
      let deletedColumn: string | null = null;
      if (field.db_column_name !== null) {
        deletedColumn = deletedColumnName(field.db_column_name, deletedAt);
        await this.execute(tx, [
          sql`ALTER TABLE ${this.tableRef(table.db_table_name)} RENAME COLUMN ${sql.id(field.db_column_name)} TO ${sql.id(deletedColumn)}`,
        ]);
      }
      const updated = await this.fields.update(withTxScope(scope, tx), fieldId, {
        deletedAt,
        deletedColumnName: deletedColumn,
      });
      if (updated === undefined) throw notFound('field');
      // T547: a field in the trash reminds of nothing (re-armed if restored).
      await syncDateReminder(this.db, withTxScope(scope, tx), fieldId, field, updated);
      await this.record(tx, context, {
        type: 'field.deleted',
        table,
        entityType: 'field',
        entityId: fieldId,
        before: fieldSnapshot(field),
        after: null,
      });
      // SPEC §5.6: the other side of a two-way link becomes one-way.
      const partner =
        field.type === 'link'
          ? await this.detachLinkPartner(tx, scope, table, field, context)
          : null;
      // T460: formula/lookup fields naming it (or reading one that does) → `REF`.
      await this.reconcileComputedErrors(tx, scope, table.base_id, context, {
        causes: [fieldId],
      });
      await this.bases.bumpPermissionVersion(withTxScope(scope, tx), {
        baseIds: [table.base_id],
      });
      return { field: updated, table, partner };
    });
    await this.publish(deleted.table, 'field', fieldId, 'deleted');
    if (deleted.partner !== null) {
      await this.publish(deleted.partner.table, 'field', deleted.partner.field.id, 'updated');
    }
    return deleted.field;
  }

  /**
   * Restores a field from the trash within 30 days: renames the column back
   * (no slot consumed). Past the window, or once compaction dropped the
   * column (`purged_at`), the field is gone: `404 NOT_FOUND` (ADR-23 §3).
   * The name must still be free (`409 NAME_CONFLICT`) and the active field
   * limit applies.
   */
  async restoreField(
    scope: OrgScope,
    fieldId: Id<'fld'>,
    context: AuditContext,
  ): Promise<FieldRow> {
    this.assertScope(scope);
    const restored = await this.withFieldLock(
      scope,
      fieldId,
      async (tx, table, field) => {
        const txScope = withTxScope(scope, tx);
        if (field.deleted_at === null) return { field, table, changed: false, partner: null };
        if (
          field.purged_at !== null ||
          Date.now() - field.deleted_at.getTime() > FIELD_RESTORE_WINDOW_MS
        ) {
          throw notFound('field');
        }
        if (field.link_table_purged_at !== null) throw linkTablePurged(field);
        await this.assertFieldCapacity(txScope, table.id);
        if (await this.fields.nameTaken(txScope, table.id, field.name, fieldId)) {
          throw nameConflict('field', field.name);
        }
        if (field.deleted_column_name !== null) {
          const column = canonicalColumnOf(field.deleted_column_name);
          await this.execute(tx, [
            sql`ALTER TABLE ${this.tableRef(table.db_table_name)} RENAME COLUMN ${sql.id(field.deleted_column_name)} TO ${sql.id(column)}`,
          ]);
        }
        let updated = await this.fields.update(txScope, fieldId, {
          deletedAt: null,
          deletedColumnName: null,
        });
        if (updated === undefined) throw notFound('field');
        // SPEC §5.6: a restored side of a two-way link joins its partner again.
        let partner: LinkPartner | null = null;
        if (updated.type === 'link') {
          const relinked = await this.reattachLinkPartner(tx, scope, table, updated, context);
          updated = relinked.field;
          partner = relinked.partner;
        }
        // T460: fields naming it heal (backfilled); a stored formula/lookup
        // missed every change while in the trash: computed again (T456); a
        // restore closing a reference cycle → `CIRCLE` on every field of it.
        await this.reconcileComputedErrors(tx, scope, table.base_id, context, {
          causes: [fieldId],
          backfill: isComputedRow(updated) ? [fieldId] : [],
        });
        updated = (await this.fields.getById(txScope, fieldId)) ?? updated;
        // T547: a restored reminding field is armed again (no catch-up of the trash time).
        await syncDateReminder(this.db, txScope, fieldId, field, updated);
        await this.record(tx, context, {
          type: 'field.restored',
          table,
          entityType: 'field',
          entityId: fieldId,
          before: null,
          after: fieldSnapshot(updated),
        });
        await this.bases.bumpPermissionVersion(txScope, { baseIds: [table.base_id] });
        return { field: updated, table, changed: true, partner };
      },
      { includeDeletedField: true },
    );
    if (restored.changed) await this.publish(restored.table, 'field', fieldId, 'restored');
    if (restored.partner != null) {
      await this.publish(restored.partner.table, 'field', restored.partner.field.id, 'updated');
    }
    return restored.field;
  }

  /**
   * Adds a `button` field (SPEC §5.5, BACKLOG T517, ADR-32 §2): meta only —
   * no column, no slot of ADR-20 —, `field.created` and its audit entry in
   * one transaction under the table's schema lock. Never unique nor
   * required. What a click does is the automation attached to it.
   */
  private async addButtonField(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    input: AddFieldInput,
    context: AuditContext,
  ): Promise<FieldRow> {
    const name = normalizeSchemaName(input.name);
    const options = parseOptions({ optionsSchema: buttonOptionsSchema }, input.options);
    assertButtonConstraints(input.uniqueValues, input.required);
    const added = await this.withTableLock(scope, tableId, async (tx, table) => {
      const txScope = withTxScope(scope, tx);
      await this.assertFieldCapacity(txScope, tableId);
      if (await this.fields.nameTaken(txScope, tableId, name)) throw nameConflict('field', name);
      const field = await this.fields.insert(txScope, {
        id: newId('fld'),
        tableId,
        name,
        type: 'button',
        dbColumnName: null,
        options: options as JsonObject,
        isPrimary: false,
        required: false,
        uniqueValues: false,
        description: input.description ?? null,
        position: await this.fields.nextPosition(txScope, tableId),
      });
      await this.record(tx, context, {
        type: 'field.created',
        table,
        entityType: 'field',
        entityId: field.id,
        before: null,
        after: fieldSnapshot(field),
      });
      await this.bases.bumpPermissionVersion(txScope, { baseIds: [table.base_id] });
      return { field, table };
    });
    await this.publish(added.table, 'field', added.field.id, 'created');
    return added.field;
  }

  // -------------------------------------------------------------------------
  // Sub-records (SPEC §5.7, BACKLOG T405)

  /**
   * Turns sub-records on: adds the `parent` field and the system column
   * `__parent_id` (self-reference `ON DELETE SET NULL`, btree index), one
   * slot. At most one `parent` field per table: an active one, or one in the
   * trash that can still be restored, answers `422 VALIDATION_FAILED`
   * (`SUBRECORDS_ALREADY_ENABLED`, `params.field_id`); one in the trash past
   * the restore window is purged first (its column dropped). Turning
   * sub-records off is deleting the field: its column and values are kept
   * for a restore (CONTRACTS §13).
   */
  private async addParentField(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    input: AddFieldInput,
    context: AuditContext,
  ): Promise<FieldRow> {
    const name = normalizeSchemaName(input.name);
    assertParentConstraints(input.uniqueValues, input.required);
    const options = parseOptions({ optionsSchema: parentOptionsSchema }, input.options);
    try {
      const added = await this.withTableLock(scope, tableId, async (tx, table) => {
        const txScope = withTxScope(scope, tx);
        await this.assertFieldCapacity(txScope, tableId);
        if (await this.fields.nameTaken(txScope, tableId, name)) throw nameConflict('field', name);
        const existing = (
          await this.fields.listByTable(txScope, tableId, { includeDeleted: true })
        ).find((field) => field.type === 'parent' && field.purged_at === null);
        if (existing !== undefined) {
          const restorable =
            existing.deleted_at === null ||
            Date.now() - existing.deleted_at.getTime() <= FIELD_RESTORE_WINDOW_MS;
          if (restorable) {
            throw validationFailed(
              [
                {
                  path: 'type',
                  code: 'SUBRECORDS_ALREADY_ENABLED',
                  message: 'The table already has a parent field',
                  params: { field_id: existing.id, deleted: existing.deleted_at !== null },
                },
              ],
              'Sub-records are already turned on for this table.',
            );
          }
          await this.execute(tx, [dropParentColumnSql(table.db_table_name)]);
          await this.fields.markPurged(txScope, tableId, [existing.id]);
        }
        await this.reserveSlots(tx, table, 1);
        await this.execute(tx, parentColumnDdl(table.db_table_name));
        const field = await this.fields.insert(txScope, {
          id: newId('fld'),
          tableId,
          name,
          type: 'parent',
          dbColumnName: null,
          options: options as JsonObject,
          isPrimary: false,
          required: false,
          uniqueValues: false,
          description: input.description ?? null,
          position: await this.fields.nextPosition(txScope, tableId),
        });
        await this.record(tx, context, {
          type: 'field.created',
          table,
          entityType: 'field',
          entityId: field.id,
          before: null,
          after: fieldSnapshot(field),
        });
        await this.bases.bumpPermissionVersion(txScope, { baseIds: [table.base_id] });
        return { field, table };
      });
      await this.publish(added.table, 'field', added.field.id, 'created');
      return added.field;
    } catch (error) {
      if (error instanceof SlotBudgetExhausted) {
        await this.db.withTx((tx) => this.enqueueCompaction(tx, scope.organizationId, tableId));
        throw new AppError('SCHEMA_LOCKED', {
          detail:
            'The table has used its column budget; it is being compacted. Try again in a few minutes.',
          params: { table_id: tableId, used_slots: error.usedSlots },
        });
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Type conversion (T403, SPEC §5.5, CONTRACTS §4, ADR-23 §3)

  /**
   * Starts a type conversion that changes data (kind `keep`, `truncate` or
   * `blacklist`; the caller checked `confirm`/`accept_data_loss` against a
   * preview), in one transaction under the table's schema lock:
   *
   * 1. column budget (ADR-20): one slot, `409 SCHEMA_LOCKED` at the hard
   *    threshold; a field whose values are already converting → `409`;
   * 2. `ADD COLUMN f_x__new_<ms>` typed as the new definition (the shadow,
   *    no constraint). The field keeps its definition and column: until the
   *    job ends it shows its old values, read-only (record writes to it and
   *    schema changes of it answer `409 SCHEMA_LOCKED`; BACKLOG S4 design
   *    decisions #8, open question #8);
   * 3. a `meta.jobs` row, the `meta.field_conversions` row (definitions,
   *    columns, context, last `__auto`, 7-day expiry) and the
   *    `field.convert` job on queue `schema:<tableId>`;
   * 4. after commit `schema.changed` `updated` (clients see the lock).
   *
   * The definition the caller planned with must still be the field's
   * (`expectedFrom`), else `409 SCHEMA_LOCKED`. The job's end
   * (`finishConversion`) swaps the columns and emits `field.converted`.
   */
  async startConversion(
    scope: OrgScope,
    fieldId: Id<'fld'>,
    input: StartConversionInput,
    context: AuditContext,
  ): Promise<StartedConversion> {
    this.assertScope(scope);
    // T463: from or to a formula/lookup, planned under the lock (below).
    const computedTarget = input.toType === 'formula' || input.toType === 'lookup';
    const plain = computedTarget ? null : conversionDefinition(input.toType);
    const plannedOptions =
      plain === null ? null : (parseOptions(plain.definition, input.toOptions) as JsonObject);
    try {
      const started = await this.withFieldLock(scope, fieldId, async (tx, table, field) => {
        const txScope = withTxScope(scope, tx);
        await this.assertNotConverting(txScope, field);
        if (
          field.type !== input.expectedFrom.type ||
          !sameJson(field.options, input.expectedFrom.options)
        ) {
          throw new AppError('SCHEMA_LOCKED', {
            detail: 'The field changed since the conversion was planned; preview it again.',
            params: { field_id: fieldId },
          });
        }
        let toOptions = plannedOptions;
        let planned = input;
        if (
          input.counted !== undefined &&
          String(table.data_version) !== input.counted.dataVersion
        ) {
          // Written since the caller counted: count again while no write can run.
          planned = { ...input, toOptions: await input.counted.recount() };
          toOptions =
            plain === null
              ? null
              : (parseOptions(plain.definition, planned.toOptions) as JsonObject);
        }
        // T547: a `datetime` target may carry a reminder: its references now.
        if (plain?.type === 'datetime') {
          await validateDateReminder(this.db, txScope, table.id, toOptions);
        }
        const canonical = field.db_column_name ?? fieldColumnName();
        let fromJson: JsonObject;
        let toJson: JsonObject;
        let kind: string;
        let newPlan: ColumnPlan | null;
        if (computedTarget || isComputedRow(field)) {
          const computed = await this.planComputedConversionLocked(
            tx,
            scope,
            table,
            field,
            canonical,
            planned,
          );
          ({ fromJson, toJson, kind, newPlan } = computed);
        } else {
          if (plain === null || toOptions === null)
            throw new TypeError('startConversion: no target');
          const { type: fromType, definition: fromDefinition } = conversionDefinition(field.type);
          const from: StoredDefinition = {
            type: fromType,
            options: parseOptions(fromDefinition, field.options) as JsonObject,
            unique_values: field.unique_values,
          };
          const to: StoredDefinition = {
            type: plain.type,
            options: toOptions,
            unique_values: false,
          };
          kind = classifyConversion(from, to, input.settings);
          if (kind === 'none' || kind === 'forbidden') {
            throw new TypeError(`startConversion: a ${kind} change is not a conversion`);
          }
          newPlan = planDefinition(to, canonical, table, field.is_primary);
          if (newPlan === null) throw new TypeError('startConversion: target has no column');
          fromJson = definitionJson(from);
          toJson = definitionJson(to);
        }

        // A `virtual` formula/lookup target stores nothing: no shadow, no slot.
        if (newPlan !== null) await this.reserveSlots(tx, table, 1);
        const startedAt = new Date();
        const shadow = shadowColumnName(canonical, startedAt);
        const oldColumn =
          field.db_column_name === null ? null : oldColumnName(field.db_column_name, startedAt);
        if (newPlan !== null) {
          await addShadowColumnSql(table.db_table_name, newPlan, shadow).execute(tx);
        }

        const { rows } = await sql<{ max_auto: string | null; total: string }>`
          SELECT max(__auto)::text AS max_auto, count(*)::text AS total
            FROM ${this.tableRef(table.db_table_name)}
        `.execute(tx);
        const createdBy =
          context.actor.type === 'user' && isId('usr', context.actor.id) ? context.actor.id : null;
        const job = await this.jobs.create(txScope, { type: FIELD_CONVERT_JOB, createdBy });
        const conversion = await this.conversions.insert(txScope, {
          jobId: job.id,
          tableId: table.id,
          fieldId,
          fromDefinition: fromJson,
          toDefinition: toJson,
          oldColumnName: oldColumn,
          newColumnName: canonical,
          shadowColumnName: shadow,
          context: {
            locale: input.locale,
            time_zone: input.timeZone,
            settings: settingsJson(input.settings),
            kind,
            request_id: context.request_id,
            // The worker's audit/events of the conversion keep the token source (T705).
            ...(context.via?.api_token_id === undefined
              ? {}
              : { api_token_id: context.via.api_token_id }),
          },
          maxAuto: BigInt(rows[0]?.max_auto ?? '0'),
          counts: {
            total: Number(rows[0]?.total ?? '0'),
            processed: 0,
            affected: 0,
            lost: 0,
            truncated: 0,
          },
          createdBy,
          expiresAt: new Date(startedAt.getTime() + FIELD_CONVERSION_WINDOW_MS),
        });
        await enqueue(
          tx,
          'field.convert',
          {
            organization_id: table.organization_id,
            table_id: table.id,
            field_id: fieldId,
            job_id: job.id,
          },
          { queueName: `schema:${table.id}`, jobKey: `field.convert:${job.id}`, maxAttempts: 5 },
        );
        await publishFieldConverting(this.db, tx, conversion, table.base_id, 'running', 0);
        return { field, table, jobId: job.id };
      });
      await this.publish(started.table, 'field', fieldId, 'updated');
      return { field: started.field, jobId: started.jobId };
    } catch (error) {
      if (error instanceof SlotBudgetExhausted) {
        const located = await this.fields.getById(scope, fieldId);
        if (located !== undefined) {
          await this.db.withTx((tx) =>
            this.enqueueCompaction(tx, scope.organizationId, located.table_id),
          );
        }
        throw new AppError('SCHEMA_LOCKED', {
          detail:
            'The table has used its column budget; it is being compacted. Try again in a few minutes.',
          params: { field_id: fieldId, used_slots: error.usedSlots },
        });
      }
      throw error;
    }
  }

  /**
   * Ends a conversion (the backfill job's last step), under the table's
   * schema lock (no record write runs meanwhile):
   *
   * - `succeeded`: rows added after the backfill position (a default value
   *   written by a create) → `pending`, the job converts them first; else the
   *   swap (old column → `f_x__old_<ms>` without constraints, shadow → `f_x`
   *   with the new CHECK/indexes), meta gets the new definition
   *   (`unique_values = false`), `permission_version` + 1;
   * - `failed`: the shadow column is dropped, the field stays as it was.
   *
   * Either way the job row is updated and one `field.converted` event and
   * audit entry is written (definitions before/after and counts, never cell
   * values; BACKLOG S4 open question #7: no per-record entries); after
   * commit `schema.changed` `converted` (clients refetch schema and
   * records). A conversion no longer running is left alone (`not_running`).
   */
  async finishConversion(
    scope: OrgScope,
    jobId: Id<'job'>,
    outcome: ConversionOutcome,
  ): Promise<'finished' | 'pending' | 'not_running'> {
    this.assertScope(scope);
    const conversion = await this.conversions.getByJob(scope, jobId);
    if (conversion === undefined) return 'not_running';
    const done = await this.withTableLock(
      scope,
      conversion.table_id,
      async (tx, table) => {
        const txScope = withTxScope(scope, tx);
        const locked = await this.conversions.lockByJob(txScope, jobId);
        if (locked?.status !== 'running') return 'not_running' as const;
        const field = await this.fields.getById(txScope, locked.field_id, { includeDeleted: true });
        if (field === undefined) throw notFound('field');
        if (locked.kind !== 'column') {
          return this.finishLinkConversion(tx, scope, table, locked, field, outcome);
        }
        // T463: from or to a formula/lookup.
        if (
          isComputedDefinitionJson(locked.from_definition) ||
          isComputedDefinitionJson(locked.to_definition)
        ) {
          const ended = await this.finishComputedConversion(
            tx,
            scope,
            table,
            locked,
            field,
            outcome,
          );
          return ended === 'pending'
            ? ('pending' as const)
            : { ...ended, partner: null as PartnerPublish | null };
        }
        const from = storedDefinitionOf(locked.from_definition);
        const to = storedDefinitionOf(locked.to_definition);
        const newColumn = locked.new_column_name;
        const shadowColumn = locked.shadow_column_name;
        if (newColumn === null || shadowColumn === null) {
          throw new TypeError('finishConversion: a column conversion without columns');
        }

        if (outcome.status === 'succeeded') {
          const { rows } = await sql<{ max_auto: string | null }>`
            SELECT max(__auto)::text AS max_auto FROM ${this.tableRef(table.db_table_name)}
          `.execute(tx);
          if (BigInt(rows[0]?.max_auto ?? '0') > locked.cursor_auto) return 'pending' as const;
          const oldPlan = planStoredField(field, table);
          const newPlan = planDefinition(to, newColumn, table, field.is_primary);
          if (newPlan === null) throw new TypeError('finishConversion: target has no column');
          // A field in the trash keeps its `__deleted_` column: only live ones swap.
          if (field.deleted_at !== null) {
            await dropShadowColumnSql(table.db_table_name, shadowColumn).execute(tx);
          } else {
            await this.execute(
              tx,
              swapColumnsSql(
                table.db_table_name,
                oldPlan,
                locked.old_column_name,
                newPlan,
                shadowColumn,
              ),
            );
            const converted = await this.fields.update(txScope, field.id, {
              type: to.type,
              options: to.options,
              uniqueValues: false,
              ...(field.db_column_name === null ? { dbColumnName: newColumn } : {}),
            });
            // T547: a new type or format re-arms a reminder (or ends it).
            await syncDateReminder(this.db, txScope, field.id, field, converted ?? null);
          }
          await this.tables.bumpDataVersion(txScope, table.id);
          // Computed fields reading the converted values: new result types
          // follow, those no longer typechecking are `INVALID_CONFIG` (T460),
          // the others are recomputed (T458).
          if (field.deleted_at === null) {
            await this.followConvertedField(
              tx,
              scope,
              table,
              field.id,
              conversionAuditContext(locked),
            );
          }
          await this.recomputeReaders(tx, table, [field.id]);
          await this.jobs.markSucceeded(txScope, jobId, { field_id: field.id, ...outcome.counts });
          // Record rules and filters on the field now read a new type (SPEC §14.1).
          await this.bases.bumpPermissionVersion(txScope, { baseIds: [table.base_id] });
        } else {
          await dropShadowColumnSql(table.db_table_name, shadowColumn).execute(tx);
          await this.jobs.markFailed(txScope, jobId, outcome.error ?? { code: 'INTERNAL' });
        }
        await this.conversions.markFinished(txScope, jobId, outcome.status, outcome.counts);
        await publishFieldConverting(this.db, tx, locked, table.base_id, outcome.status, 1);
        await this.record(tx, conversionAuditContext(locked), {
          type: 'field.converted',
          table,
          entityType: 'field',
          entityId: field.id,
          before: definitionJson(from),
          after: {
            ...definitionJson(outcome.status === 'succeeded' ? to : from),
            counts: outcome.counts,
          },
          jobId,
          data: { status: outcome.status, counts: outcome.counts },
        });
        return { table, fieldId: field.id, partner: null as PartnerPublish | null };
      },
      { includeDeleted: true, allowCompacting: true },
    );
    if (typeof done === 'string') return done;
    await this.publish(done.table, 'field', done.fieldId, 'converted');
    if (done.partner !== null) {
      await this.publish(done.partner.table, 'field', done.partner.fieldId, done.partner.action);
    }
    return 'finished';
  }

  /**
   * `POST /fields/:id/revert-conversion` (ADR-23 §3): undoes the latest
   * conversion of the field within 7 days. Drops the converted column,
   * renames `f_x__old_<ms>` back (with its CHECK and indexes) and restores
   * type, options and `unique_values`; name, description, position stay.
   * Values written since the conversion are overwritten (BACKLOG S4 design
   * decision #7; the caller checked `confirm`). No revertible conversion
   * (none, failed, expired, reverted, cleaned) → `404`; one still running →
   * `409 SCHEMA_LOCKED`. Emits `field.converted` (`data.reverted_job_id`),
   * bumps `permission_version`; after commit `schema.changed` `converted`.
   */
  async revertConversion(
    scope: OrgScope,
    fieldId: Id<'fld'>,
    context: AuditContext,
    options: RevertConversionOptions = { mode: 'overwrite_later_edits' },
  ): Promise<FieldRow> {
    this.assertScope(scope);
    const reverted = await this.withFieldLock(scope, fieldId, async (tx, table, field) => {
      const txScope = withTxScope(scope, tx);
      await this.assertNotConverting(txScope, field);
      const conversion = revertible(await this.conversions.latestForField(txScope, fieldId));
      // T463: from or to a formula/lookup (no edits to merge: see the caller).
      if (
        conversion?.kind === 'column' &&
        (isComputedDefinitionJson(conversion.from_definition) ||
          isComputedDefinitionJson(conversion.to_definition))
      ) {
        const updated = await this.revertComputedConversionLocked(
          tx,
          scope,
          table,
          field,
          conversion,
          context,
        );
        return { field: updated, table };
      }
      if (
        conversion === undefined ||
        conversion.kind !== 'column' ||
        conversion.new_column_name === null ||
        field.db_column_name !== conversion.new_column_name
      ) {
        throw notFound('field');
      }
      const newColumn = conversion.new_column_name;
      if (
        options.mode === 'keep_later_edits' &&
        options.mergedSince !== undefined &&
        (await this.auditLogs.hasRecordFieldChangesSince(txScope, {
          tableId: table.id,
          fieldId,
          since: options.mergedSince,
        }))
      ) {
        throw new ConcurrentFieldEditsError();
      }
      const from = storedDefinitionOf(conversion.from_definition);
      const to = storedDefinitionOf(conversion.to_definition);
      const oldPlan =
        conversion.old_column_name === null
          ? null
          : planDefinition(from, newColumn, table, field.is_primary);
      await this.execute(
        tx,
        revertColumnSql(table.db_table_name, newColumn, conversion.old_column_name, oldPlan),
      );
      const updated = await this.fields.update(txScope, fieldId, {
        type: from.type,
        options: from.options,
        uniqueValues: from.unique_values,
        ...(conversion.old_column_name === null ? { dbColumnName: null } : {}),
      });
      if (updated === undefined) throw notFound('field');
      // T547: back to a reminding `datetime` (armed again) or away from one.
      await syncDateReminder(this.db, txScope, fieldId, field, updated);
      await this.conversions.markReverted(txScope, conversion.job_id);
      // T460: readers typecheck again with the old type (healed) or not.
      await this.followConvertedField(tx, scope, table, fieldId, context);
      await this.recomputeReaders(tx, table, [fieldId]);
      await this.record(tx, context, {
        type: 'field.converted',
        table,
        entityType: 'field',
        entityId: fieldId,
        before: definitionJson({
          ...to,
          options: field.options as JsonObject,
          unique_values: field.unique_values,
        }),
        after: definitionJson(from),
        data: {
          status: 'reverted',
          reverted_job_id: conversion.job_id,
          mode: options.mode,
          ...(options.counts === undefined ? {} : { counts: options.counts }),
        },
      });
      await this.bases.bumpPermissionVersion(txScope, { baseIds: [table.base_id] });
      return { field: updated, table };
    });
    await this.publish(reverted.table, 'field', fieldId, 'converted');
    return reverted.field;
  }

  /**
   * "Restore as a new field" (BACKLOG S4 design decision #7, non-destructive
   * like Lark): within 7 days of the latest conversion, the old column
   * becomes a new field with the old definition (its values as they were
   * before the conversion), next to the converted field, which is not
   * touched. The conversion can no longer be reverted (`cleaned`). The
   * active field limit and name uniqueness apply; emits `field.created`
   * (`data.restored_from_job_id`), bumps `permission_version`, then
   * `schema.changed` `created`. No revertible conversion → `404`; a
   * conversion from a type without a column of its own (created/updated
   * at/by) → `422 CONVERSION_NOT_ALLOWED` (nothing to restore).
   */
  async restoreConversionAsNewField(
    scope: OrgScope,
    fieldId: Id<'fld'>,
    name: string,
    context: AuditContext,
  ): Promise<FieldRow> {
    this.assertScope(scope);
    const newName = normalizeSchemaName(name);
    const created = await this.withFieldLock(scope, fieldId, async (tx, table, field) => {
      const txScope = withTxScope(scope, tx);
      await this.assertNotConverting(txScope, field);
      const conversion = revertible(await this.conversions.latestForField(txScope, fieldId));
      // T463: a field converted to a formula/lookup may have another column (or none) now.
      const toComputed =
        conversion !== undefined && isComputedDefinitionJson(conversion.to_definition);
      if (
        conversion === undefined ||
        (!toComputed && field.db_column_name !== conversion.new_column_name)
      ) {
        throw notFound('field');
      }
      // A formula/lookup had no values of its own to restore (T463).
      if (
        conversion.old_column_name === null ||
        conversion.kind !== 'column' ||
        isComputedDefinitionJson(conversion.from_definition)
      ) {
        throw new AppError('CONVERSION_NOT_ALLOWED', {
          detail: 'The field had no values of its own before the conversion.',
          errors: [
            {
              path: 'mode',
              code: 'CONVERSION_NOT_ALLOWED',
              message: 'Nothing to restore as a new field',
            },
          ],
        });
      }
      await this.assertFieldCapacity(txScope, table.id);
      if (await this.fields.nameTaken(txScope, table.id, newName)) {
        throw nameConflict('field', newName);
      }
      const from = storedDefinitionOf(conversion.from_definition);
      const column = fieldColumnName();
      const plan = planDefinition(from, column, table, false);
      if (plan === null) throw new TypeError('restoreConversionAsNewField: no column');
      await this.execute(
        tx,
        restoreOldColumnAsSql(table.db_table_name, conversion.old_column_name, plan),
      );
      const restored = await this.fields.insert(txScope, {
        id: newId('fld'),
        tableId: table.id,
        name: newName,
        type: from.type,
        dbColumnName: column,
        options: from.options,
        isPrimary: false,
        required: false,
        uniqueValues: from.unique_values,
        description: null,
        position: await this.fields.nextPosition(txScope, table.id),
      });
      await this.conversions.markCleaned(txScope, conversion.job_id);
      // T547: the old definition may carry a reminder: the new field reminds from now.
      await syncDateReminder(this.db, txScope, restored.id, null, restored);
      await this.record(tx, context, {
        type: 'field.created',
        table,
        entityType: 'field',
        entityId: restored.id,
        before: null,
        after: fieldSnapshot(restored),
        data: { restored_from_job_id: conversion.job_id, converted_field_id: fieldId },
      });
      await this.bases.bumpPermissionVersion(txScope, { baseIds: [table.base_id] });
      return { field: restored, table };
    });
    await this.publish(created.table, 'field', created.field.id, 'created');
    return created.field;
  }

  /**
   * The latest conversion of the field when it is running (the caller
   * answers `409`) or `revertConversion` would undo it now (`succeeded`,
   * within 7 days); `undefined` otherwise.
   */
  async revertibleConversion(
    scope: OrgScope,
    fieldId: Id<'fld'>,
  ): Promise<FieldConversionRow | undefined> {
    this.assertScope(scope);
    const latest = await this.conversions.latestForField(scope, fieldId);
    if (latest?.status === 'running') return latest;
    return revertible(latest);
  }

  /**
   * Cleanup (`field.conversion_cleanup`, SPEC §5.5 step 3): drops the old
   * column of a succeeded conversion past its 7 days and marks it
   * `cleaned`. `false` when there was nothing to do.
   */
  async dropExpiredConversionColumn(
    scope: OrgScope,
    jobId: Id<'job'>,
    now: Date = new Date(),
  ): Promise<boolean> {
    this.assertScope(scope);
    const conversion = await this.conversions.getByJob(scope, jobId);
    if (conversion === undefined) return false;
    return this.withTableLock(
      scope,
      conversion.table_id,
      async (tx, table) => {
        const txScope = withTxScope(scope, tx);
        const locked = await this.conversions.lockByJob(txScope, jobId);
        if (locked?.status !== 'succeeded' || locked.expires_at.getTime() > now.getTime()) {
          return false;
        }
        if (locked.old_column_name !== null) {
          await dropOldColumnSql(table.db_table_name, locked.old_column_name).execute(tx);
        }
        if (locked.backup_table_name !== null) {
          await dropLinkBackupSql(locked.backup_table_name).execute(tx);
        }
        await this.conversions.markCleaned(txScope, jobId);
        return true;
      },
      { includeDeleted: true },
    );
  }

  /** `409 SCHEMA_LOCKED` (`FIELD_CONVERTING`) while the field's values are being converted. */
  private async assertNotConverting(scope: OrgScope, field: FieldRow): Promise<void> {
    const running = await this.conversions.runningFieldIds(scope, field.table_id);
    if (running.has(field.id)) throw fieldConvertingError(field.id);
  }

  // -------------------------------------------------------------------------
  // Conversions from and to formula/lookup (T463, CONTRACTS §4.1)

  /**
   * Plans a conversion from or to a formula/lookup, under the field's lock
   * (`startConversion`):
   *
   * - to a formula/lookup ("any → formula/lookup"): the definition is
   *   checked like a save (`prepareComputedDefinition` against what the
   *   converter reads, `422 FORMULA_*`, `FORMULA_LIMIT_EXCEEDED`), a cycle
   *   through the field is `422 FORMULA_CYCLE`; a primary field, a link,
   *   parent or attachment field cannot become one (`422
   *   CONVERSION_NOT_ALLOWED`). The shadow is the column of the result type
   *   (none for `virtual`);
   * - from a formula/lookup to a stored type ("convert to static values"):
   *   the kind of its result type to the target (`planComputedConversion`).
   *
   * Definitions keep what a revert needs: `required` of a stored source,
   * result type, mode and dependency edges of a computed one.
   */
  private async planComputedConversionLocked(
    tx: Tx,
    scope: OrgScope,
    table: TableRow,
    field: FieldRow,
    canonical: string,
    input: StartConversionInput,
  ): Promise<{
    readonly fromJson: JsonObject;
    readonly toJson: JsonObject;
    readonly kind: string;
    readonly newPlan: ColumnPlan | null;
  }> {
    const txScope = withTxScope(scope, tx);
    const fromComputed = isComputedRow(field);
    let fromJson: JsonObject;
    if (fromComputed) {
      const ownEdges = (await this.dependencies.listByBase(txScope, table.base_id)).filter(
        (edge) => edge.fieldId === field.id,
      );
      fromJson = computedDefinitionJson({
        type: field.type as 'formula' | 'lookup',
        options: isRecordValue(field.options) ? field.options : {},
        unique_values: false,
        result_type: field.result_type,
        compute_mode: field.compute_mode ?? 'stored',
        dependencies: edgesJson(ownEdges),
      });
    } else {
      if (!isS1FieldType(field.type)) {
        throw computedConversionNotAllowed(
          `A ${field.type} field cannot be converted to ${input.toType}.`,
          { from: field.type, to: input.toType },
        );
      }
      const { type, definition } = conversionDefinition(field.type);
      fromJson = {
        ...definitionJson({
          type,
          options: parseOptions(definition, field.options) as JsonObject,
          unique_values: field.unique_values,
        }),
        required: field.required,
      };
    }

    if (input.toType === 'formula' || input.toType === 'lookup') {
      if (field.is_primary) {
        throw computedConversionNotAllowed(
          'The primary field cannot become a formula or lookup field.',
          { from: field.type, to: input.toType },
        );
      }
      await this.lockComputedGraph(tx, table.base_id);
      if (!fromComputed) await this.assertComputedCapacity(txScope, table.base_id);
      const rows = await loadBaseSchemaRows(this.db, txScope, table.base_id);
      const prepared = prepareComputedDefinition(
        {
          type: input.toType,
          options: input.toOptions,
          expressionForm: 'display',
          style: styleModeOf(input.toOptions, undefined),
        },
        computedContextOf(rows, table.id, input.computed),
      );
      const newEdges = edgesOf(field.id, prepared.analysis.dependencies);
      const edges: FieldDependencyEdge[] = [
        ...(await this.dependencies.listByBase(txScope, table.base_id)).filter(
          (edge) => edge.fieldId !== field.id,
        ),
        ...newEdges,
      ];
      const active = new Set<string>(rows.fields.filter(isComputedRow).map((row) => row.id));
      active.add(field.id);
      const cycle = findCycle(field.id, edges, active);
      if (cycle !== null) throw formulaCycleProblem(cycle, rows, input.computed?.readable);
      const toJson = computedDefinitionJson({
        type: input.toType,
        options: prepared.options,
        unique_values: false,
        result_type: prepared.resultType,
        compute_mode: prepared.computeMode,
        dependencies: edgesJson(newEdges),
      });
      const newPlan =
        prepared.computeMode === 'stored'
          ? planComputedColumn(canonical, prepared.resultType, table.collation)
          : null;
      return { fromJson, toJson, kind: 'keep', newPlan };
    }

    // "Convert to static values".
    const { type, definition } = conversionDefinition(input.toType);
    const to: StoredDefinition = {
      type,
      options: parseOptions(definition, input.toOptions) as JsonObject,
      unique_values: false,
    };
    const plan = planComputedConversion(
      computedSourceOf(field),
      definitionRefOf(to),
      input.settings,
    );
    if (plan.kind === 'forbidden') {
      throw computedConversionNotAllowed(
        `A ${field.type} field cannot be converted to ${input.toType}.`,
        { from: field.type, to: input.toType },
      );
    }
    const newPlan = planDefinition(to, canonical, table, field.is_primary);
    if (newPlan === null) throw new TypeError('startConversion: target has no column');
    return { fromJson, toJson: definitionJson(to), kind: plan.kind, newPlan };
  }

  /**
   * `finishConversion` of a conversion from or to a formula/lookup (T463),
   * in its transaction (table lock held):
   *
   * - to a formula/lookup: the old column (when the field had one) becomes
   *   `f_x__old_<ms>`, the shadow (computed while the field still showed its
   *   old values) the field's column; meta gets the definition, mode, result
   *   type and dependency edges. Values were computed while sources could
   *   still change: a stored field is then recomputed for every record by
   *   the recompute job (`recomputing`, cells keep their values; only
   *   changed rows are written). A result type that moved meanwhile (a
   *   source converted) gets its column and backfill like any definition
   *   (T456); errors (`REF` of a source deleted meanwhile, `CIRCLE`) are
   *   set by the reconciliation (T460);
   * - to a stored type: the computed column (stored) becomes the old
   *   column, the shadow the field's; meta loses the computed part and the
   *   field its dependency edges. A computed field whose column moved during
   *   the job (its result type followed a source) cannot swap: the
   *   conversion fails, the field is unchanged.
   *
   * The readers of the field follow its new type (T460) and are recomputed.
   */
  private async finishComputedConversion(
    tx: Tx,
    scope: OrgScope,
    table: TableRow,
    locked: FieldConversionRow,
    field: FieldRow,
    outcome: ConversionOutcome,
  ): Promise<'pending' | { readonly table: TableRow; readonly fieldId: Id<'fld'> }> {
    const txScope = withTxScope(scope, tx);
    const jobId = locked.job_id;
    const fromC = computedDefinitionOf(locked.from_definition);
    const toC = computedDefinitionOf(locked.to_definition);
    const newColumn = locked.new_column_name;
    const shadowColumn = locked.shadow_column_name;
    if (newColumn === null || shadowColumn === null) {
      throw new TypeError('finishConversion: a column conversion without columns');
    }
    const context = conversionAuditContext(locked);
    let status = outcome.status;
    let failure = outcome.error;
    if (status === 'succeeded') {
      const { rows } = await sql<{ max_auto: string | null }>`
        SELECT max(__auto)::text AS max_auto FROM ${this.tableRef(table.db_table_name)}
      `.execute(tx);
      if (BigInt(rows[0]?.max_auto ?? '0') > locked.cursor_auto) return 'pending';
      const expectedColumn = locked.old_column_name === null ? null : newColumn;
      if (
        fromC !== null &&
        field.deleted_at === null &&
        (field.db_column_name !== expectedColumn || !sameJson(field.result_type, fromC.result_type))
      ) {
        status = 'failed';
        failure = {
          code: 'SCHEMA_LOCKED',
          title: 'The field changed while its values were being converted',
          status: 409,
        };
      }
    }

    if (status === 'succeeded' && field.deleted_at !== null) {
      // A field in the trash keeps its `__deleted_` column: only live ones swap.
      await dropShadowColumnSql(table.db_table_name, shadowColumn).execute(tx);
    } else if (status === 'succeeded') {
      const oldPlan =
        locked.old_column_name === null
          ? null
          : fromC !== null
            ? planComputedColumn(newColumn, field.result_type, table.collation)
            : planStoredField(field, table);
      await this.lockComputedGraph(tx, table.base_id);
      if (toC !== null) {
        const newPlan = planComputedDefinition(toC, newColumn, table);
        if (newPlan !== null) {
          await this.execute(
            tx,
            swapColumnsSql(
              table.db_table_name,
              oldPlan,
              locked.old_column_name,
              newPlan,
              shadowColumn,
            ),
          );
        } else if (oldPlan !== null && locked.old_column_name !== null) {
          await this.execute(
            tx,
            retireColumnSql(table.db_table_name, oldPlan, locked.old_column_name),
          );
        }
        const updated = await this.fields.update(txScope, field.id, {
          type: toC.type,
          options: toC.options,
          uniqueValues: false,
          required: false,
          computeMode: toC.compute_mode,
          resultType: toC.result_type as JsonObject,
          computeState: 'ready',
          computeError: null,
          dbColumnName: newPlan === null ? null : newColumn,
        });
        if (updated === undefined) throw notFound('field');
        // T547: a formula/lookup never reminds (a `datetime` reminder ends here).
        await syncDateReminder(this.db, txScope, field.id, field, updated);
        const rows = await loadBaseSchemaRows(this.db, txScope, table.base_id);
        const analysis = analysisOfField(updated, rows);
        await this.dependencies.replaceForField(txScope, {
          baseId: table.base_id,
          fieldId: field.id,
          edges:
            analysis === null
              ? edgesFromJson(field.id, toC.dependencies)
              : edgesOf(field.id, analysis.dependencies),
        });
        let retyped = false;
        if (
          analysis?.result_type != null &&
          (!sameJson(updated.result_type, analysis.result_type) ||
            updated.compute_mode !== analysis.compute_mode)
        ) {
          await this.followResultType(
            tx,
            scope,
            table,
            updated,
            { resultType: analysis.result_type, computeMode: analysis.compute_mode },
            context,
          );
          retyped = true;
        }
        await this.tables.bumpDataVersion(txScope, table.id);
        await this.followConvertedField(tx, scope, table, field.id, context, {
          backfill: retyped ? [field.id] : [],
        });
        const now = await this.fields.getById(txScope, field.id);
        if (now?.compute_mode === 'stored' && now.compute_state === 'ready') {
          const result = await this.recompute.enqueueFieldRecompute(
            tx,
            table.organization_id,
            table.base_id,
            [field.id],
          );
          this.publishStateChanges(tx, table, result.stateChanged);
        }
      } else {
        const to = storedDefinitionOf(locked.to_definition);
        const newPlan = planDefinition(to, newColumn, table, field.is_primary);
        if (newPlan === null) throw new TypeError('finishConversion: target has no column');
        await this.execute(
          tx,
          swapColumnsSql(
            table.db_table_name,
            oldPlan,
            locked.old_column_name,
            newPlan,
            shadowColumn,
          ),
        );
        const converted = await this.fields.update(txScope, field.id, {
          type: to.type,
          options: to.options,
          uniqueValues: false,
          computeMode: null,
          resultType: null,
          computeState: null,
          computeError: null,
          dbColumnName: newColumn,
        });
        // T547: a `datetime` target with a reminder starts reminding now.
        await syncDateReminder(this.db, txScope, field.id, field, converted ?? null);
        await this.dependencies.replaceForField(txScope, {
          baseId: table.base_id,
          fieldId: field.id,
          edges: [],
        });
        await this.tables.bumpDataVersion(txScope, table.id);
        await this.followConvertedField(tx, scope, table, field.id, context);
      }
    }
    if (status === 'succeeded') {
      await this.recomputeReaders(tx, table, [field.id]);
      await this.jobs.markSucceeded(txScope, jobId, { field_id: field.id, ...outcome.counts });
      await this.bases.bumpPermissionVersion(txScope, { baseIds: [table.base_id] });
    } else {
      await dropShadowColumnSql(table.db_table_name, shadowColumn).execute(tx);
      await this.jobs.markFailed(txScope, jobId, failure ?? { code: 'INTERNAL' });
    }
    await this.conversions.markFinished(txScope, jobId, status, outcome.counts);
    await publishFieldConverting(this.db, tx, locked, table.base_id, status, 1);
    await this.record(tx, context, {
      type: 'field.converted',
      table,
      entityType: 'field',
      entityId: field.id,
      before: auditDefinition(locked.from_definition),
      after: {
        ...auditDefinition(status === 'succeeded' ? locked.to_definition : locked.from_definition),
        counts: outcome.counts,
      },
      jobId,
      data: { status, counts: outcome.counts },
    });
    return { table, fieldId: field.id };
  }

  /**
   * The revert of a conversion from or to a formula/lookup (T463, ADR-23
   * §3), inside `revertConversion` (field lock held): the current column
   * (when there is one) is dropped, the old one renamed back; meta gets the
   * old definition. A formula/lookup coming back is analysed again with
   * today's schema — its dependency edges restored (the stored ones when it
   * no longer analyses), its column following a result type that moved —
   * and computed again (`backfilling`; the old column still shows its
   * values meanwhile), unless it is now in error: a revert closing a cycle
   * is `CIRCLE` for every field on it, a source gone `REF` (T460). Values
   * written to the stored field since are replaced (the caller asked for
   * `confirm`). A stored type coming back gets its old values; the field's
   * edges go. Readers follow the type the field has again.
   */
  private async revertComputedConversionLocked(
    tx: Tx,
    scope: OrgScope,
    table: TableRow,
    field: FieldRow,
    conversion: FieldConversionRow,
    context: AuditContext,
  ): Promise<FieldRow> {
    const txScope = withTxScope(scope, tx);
    const fromC = computedDefinitionOf(conversion.from_definition);
    const toC = computedDefinitionOf(conversion.to_definition);
    const stillConverted =
      toC !== null
        ? field.type === toC.type
        : !isComputedRow(field) && field.db_column_name === conversion.new_column_name;
    if (!stillConverted) throw notFound('field');
    await this.lockComputedGraph(tx, table.base_id);
    const restoredColumn =
      conversion.old_column_name === null ? null : canonicalOfOldColumn(conversion.old_column_name);
    const oldPlan =
      restoredColumn === null
        ? null
        : planAnyDefinition(conversion.from_definition, restoredColumn, table, field.is_primary);
    await this.execute(
      tx,
      revertAnyColumnSql(
        table.db_table_name,
        field.db_column_name,
        conversion.old_column_name,
        oldPlan,
      ),
    );
    let updated: FieldRow | undefined;
    if (fromC === null) {
      const from = storedDefinitionOf(conversion.from_definition);
      const fromJson = conversion.from_definition as JsonObject;
      updated = await this.fields.update(txScope, field.id, {
        type: from.type,
        options: from.options,
        uniqueValues: from.unique_values,
        required: fromJson.required === true,
        computeMode: null,
        resultType: null,
        computeState: null,
        computeError: null,
        dbColumnName: restoredColumn,
      });
      if (updated === undefined) throw notFound('field');
      // T547: back to a reminding `datetime` (armed again).
      await syncDateReminder(this.db, txScope, field.id, field, updated);
      await this.dependencies.replaceForField(txScope, {
        baseId: table.base_id,
        fieldId: field.id,
        edges: [],
      });
      await this.followConvertedField(tx, scope, table, field.id, context);
    } else {
      updated = await this.fields.update(txScope, field.id, {
        type: fromC.type,
        options: fromC.options,
        uniqueValues: false,
        required: false,
        computeMode: fromC.compute_mode,
        resultType: fromC.result_type as JsonObject,
        computeState: 'ready',
        computeError: null,
        dbColumnName: fromC.compute_mode === 'stored' ? restoredColumn : null,
      });
      if (updated === undefined) throw notFound('field');
      // T547: a formula/lookup never reminds.
      await syncDateReminder(this.db, txScope, field.id, field, updated);
      const rows = await loadBaseSchemaRows(this.db, txScope, table.base_id);
      const analysis = analysisOfField(updated, rows);
      await this.dependencies.replaceForField(txScope, {
        baseId: table.base_id,
        fieldId: field.id,
        edges:
          analysis === null
            ? edgesFromJson(field.id, fromC.dependencies)
            : edgesOf(field.id, analysis.dependencies),
      });
      const storedType = formulaTypeOf(fromC.result_type);
      const target =
        analysis?.result_type != null
          ? { resultType: analysis.result_type, computeMode: analysis.compute_mode }
          : storedType === null
            ? null
            : { resultType: storedType, computeMode: fromC.compute_mode };
      const typeMoved =
        target !== null &&
        (!sameJson(updated.result_type, target.resultType) ||
          updated.compute_mode !== target.computeMode);
      const columnMissing = updated.compute_mode === 'stored' && updated.db_column_name === null;
      if (target !== null && (typeMoved || columnMissing)) {
        updated =
          (await this.followResultType(tx, scope, table, updated, target, context)) ?? updated;
      }
      await this.followConvertedField(tx, scope, table, field.id, context, {
        backfill: [field.id],
      });
    }
    await this.conversions.markReverted(txScope, conversion.job_id);
    await this.recomputeReaders(tx, table, [field.id]);
    await this.record(tx, context, {
      type: 'field.converted',
      table,
      entityType: 'field',
      entityId: field.id,
      before: auditDefinition(conversion.to_definition),
      after: auditDefinition(conversion.from_definition),
      data: { status: 'reverted', reverted_job_id: conversion.job_id },
    });
    await this.bases.bumpPermissionVersion(txScope, { baseIds: [table.base_id] });
    return (await this.fields.getById(txScope, field.id)) ?? updated;
  }

  /** `schema.changed` (field `updated`) after commit for fields whose `compute_state` changed. */
  private publishStateChanges(
    tx: Tx,
    table: TableRow,
    changed: readonly {
      readonly baseId: Id<'bse'>;
      readonly tableId: Id<'tbl'>;
      readonly fieldId: Id<'fld'>;
    }[],
  ): void {
    const changes = changed.map((item): SchemaChange => ({
      organization_id: table.organization_id,
      base_id: item.baseId,
      table_id: item.tableId,
      entity: 'field',
      entity_id: item.fieldId,
      action: 'updated',
    }));
    if (changes.length > 0) afterCommit(tx, () => this.publishCommitted(changes));
  }

  // -------------------------------------------------------------------------
  // Link conversions (ADR-28, CONTRACTS §4; BACKLOG T404)

  /**
   * Starts a link conversion (the caller checked schema rights on both
   * tables and `confirm`), in one transaction holding the schema locks of
   * the field's table and of the other side's:
   *
   * - `to_two_way`: the linked table must be active in the base (`404`),
   *   have room for one more field (`422 FIELD_LIMIT_EXCEEDED`) and not use
   *   the reverse name (`409 NAME_CONFLICT`); the reverse field's id is
   *   chosen now (the field left in the trash by an earlier `to_one_way`
   *   when the junction has one: at most one field per side, trash
   *   included);
   * - `to_one_way`: the field must be two-way with an active partner;
   * - `to_single`: creates the backup table of the links the job removes.
   *
   * Then the `meta.field_conversions` row (`kind` = the change, partner,
   * backup), the `field.convert` job (queue `schema:<tableId>`) and
   * `field.converting`; after commit `schema.changed` `updated` for the
   * field (and the partner). Until the job ends both fields answer `409
   * SCHEMA_LOCKED` to schema changes; record writes go on (ADR-28 §3).
   */
  async startLinkConversion(
    scope: OrgScope,
    fieldId: Id<'fld'>,
    input: StartLinkConversionInput,
    context: AuditContext,
  ): Promise<StartedConversion> {
    this.assertScope(scope);
    const started = await this.withFieldLock(scope, fieldId, async (tx, table, field) => {
      const txScope = withTxScope(scope, tx);
      await this.assertNotConverting(txScope, field);
      const stale = () =>
        new AppError('SCHEMA_LOCKED', {
          detail: 'The field changed since the conversion was planned; preview it again.',
          params: { field_id: fieldId },
        });
      if (
        field.type !== 'link' ||
        field.link_junction === null ||
        field.link_side === null ||
        !sameJson(field.options, input.expectedOptions)
      ) {
        throw stale();
      }
      const options = linkOptionsSchema.parse(field.options);
      const startedAt = new Date();
      let toOptions: LinkOptions;
      let partner: { table: TableRow; fieldId: Id<'fld'>; active: boolean } | null = null;
      let backupTable: string | null = null;
      let reverseName: string | null = null;
      switch (input.change) {
        case 'to_two_way': {
          if (options.bidirectional) throw stale();
          const target = await this.lockLinkTarget(tx, txScope, table, options.link_table);
          reverseName = normalizeSchemaName(
            input.reverseName ?? table.name,
            'bidirectional_link_field_name',
          );
          const existing = await this.otherLinkSide(txScope, field);
          if (existing?.deleted_at === null) throw stale();
          await this.assertReverseFieldFits(txScope, field, target, reverseName, existing?.id);
          const partnerId = existing?.id ?? newId('fld');
          partner = { table: target, fieldId: partnerId, active: false };
          toOptions = {
            ...options,
            bidirectional: true,
            bidirectional_link_field_name: reverseName,
            symmetric_field_id: partnerId,
          };
          break;
        }
        case 'to_one_way': {
          if (!options.bidirectional || options.symmetric_field_id === null) throw stale();
          const located = await this.activeLinkPartner(tx, txScope, table, field);
          if (located === null) throw stale();
          await this.assertNotConverting(txScope, located.field);
          partner = { table: located.table, fieldId: located.field.id, active: true };
          toOptions = {
            ...options,
            bidirectional: false,
            bidirectional_link_field_name: null,
            symmetric_field_id: null,
          };
          break;
        }
        case 'to_single': {
          if (!options.allow_multiple) throw stale();
          const located = options.bidirectional
            ? await this.activeLinkPartner(tx, txScope, table, field)
            : null;
          if (located !== null) {
            await this.assertNotConverting(txScope, located.field);
            partner = { table: located.table, fieldId: located.field.id, active: true };
          }
          backupTable = linkBackupTableName(field.link_junction, startedAt);
          await createLinkBackupSql(backupTable).execute(tx);
          toOptions = { ...options, allow_multiple: false };
          break;
        }
        default:
          throw new TypeError('startLinkConversion: unknown change');
      }

      const createdBy =
        context.actor.type === 'user' && isId('usr', context.actor.id) ? context.actor.id : null;
      const job = await this.jobs.create(txScope, { type: FIELD_CONVERT_JOB, createdBy });
      const conversion = await this.conversions.insert(txScope, {
        jobId: job.id,
        tableId: table.id,
        fieldId,
        kind: input.change,
        partner: partner === null ? null : { tableId: partner.table.id, fieldId: partner.fieldId },
        backupTableName: backupTable,
        fromDefinition: { type: 'link', options: field.options, unique_values: false },
        toDefinition: { type: 'link', options: toOptions as JsonObject, unique_values: false },
        oldColumnName: null,
        newColumnName: null,
        shadowColumnName: null,
        context: {
          kind: input.change,
          request_id: context.request_id,
          ...(reverseName === null ? {} : { reverse_name: reverseName }),
          ...(context.via?.api_token_id === undefined
            ? {}
            : { api_token_id: context.via.api_token_id }),
        },
        maxAuto: 0,
        counts: {
          total: input.counts?.total ?? 0,
          processed: 0,
          affected: input.counts?.affected ?? 0,
          lost: 0,
          truncated: 0,
        },
        createdBy,
        expiresAt: new Date(startedAt.getTime() + FIELD_CONVERSION_WINDOW_MS),
      });
      await enqueue(
        tx,
        'field.convert',
        {
          organization_id: table.organization_id,
          table_id: table.id,
          field_id: fieldId,
          job_id: job.id,
        },
        { queueName: `schema:${table.id}`, jobKey: `field.convert:${job.id}`, maxAttempts: 5 },
      );
      await publishFieldConverting(this.db, tx, conversion, table.base_id, 'running', 0);
      return { field, table, jobId: job.id, partner };
    });
    await this.publish(started.table, 'field', fieldId, 'updated');
    if (started.partner?.active === true) {
      await this.publish(started.partner.table, 'field', started.partner.fieldId, 'updated');
    }
    return { field: started.field, jobId: started.jobId };
  }

  /**
   * The end of a link conversion (`finishConversion`, under the schema lock
   * of the field's table; the other side's is taken here):
   *
   * - `to_two_way`: the reverse field (sharing the junction, `allow_multiple
   *   = true`, no `record_filter`) is created in the linked table —
   *   `field.created` — or, when the junction still has a field on that
   *   side in the trash, that field comes back with the new name —
   *   `field.restored`; no record event (the data does not change). The
   *   limit, the name or the linked table no longer fitting ends the
   *   conversion `failed`;
   * - `to_one_way`: the partner goes to the trash (`field.deleted`,
   *   restorable 30 days; the revert restores it);
   * - `to_single`: cells written with several links meanwhile → `pending`
   *   (the job cuts them first); else the unique index of the field's side
   *   and `allow_multiple = false`.
   *
   * A failed `to_single` puts the removed links back and drops its backup.
   */
  private async finishLinkConversion(
    tx: Tx,
    scope: OrgScope,
    table: TableRow,
    locked: FieldConversionRow,
    field: FieldRow,
    outcome: ConversionOutcome,
  ): Promise<'pending' | { table: TableRow; fieldId: Id<'fld'>; partner: PartnerPublish | null }> {
    const txScope = withTxScope(scope, tx);
    const change = locked.kind as LinkConversionChange;
    const from = linkOptionsSchema.parse(field.options);
    const to = linkOptionsSchema.parse(definitionOptionsOf(locked.to_definition));
    const junction = field.link_junction;
    const side = field.link_side;
    if (junction === null || side === null) throw new TypeError('link conversion: no junction');
    let status = outcome.status;
    let error = outcome.error;
    let partner: PartnerPublish | null = null;
    const ref = await this.linkCellsRef(txScope, field, from);

    if (status === 'succeeded') {
      if (change === 'to_single') {
        if (await hasMultiLinkCells(tx, ref)) return 'pending';
        await junctionSingleIndexSql(junction, side).execute(tx);
        await this.fields.update(txScope, field.id, { options: to as JsonObject });
        await this.tables.bumpDataVersion(txScope, table.id);
        if (locked.partner_table_id !== null && locked.partner_field_id !== null) {
          const partnerTable = await this.lockLinkPartnerTable(
            tx,
            txScope,
            table,
            locked.partner_table_id,
          );
          if (partnerTable !== undefined) {
            await this.tables.bumpDataVersion(txScope, partnerTable.id);
            partner = {
              table: partnerTable,
              fieldId: locked.partner_field_id,
              action: 'converted',
            };
          }
        }
      } else if (change === 'to_two_way') {
        const created = await this.addReverseLinkField(tx, txScope, table, field, locked, to);
        if (created instanceof AppError) {
          status = 'failed';
          error = { code: created.code, title: 'Link conversion failed', status: created.status };
        } else {
          partner = created;
          await this.fields.update(txScope, field.id, { options: to as JsonObject });
        }
      } else {
        const located = await this.activeLinkPartner(tx, txScope, table, field);
        if (located !== null && located.field.id === locked.partner_field_id) {
          const deleted = await this.fields.update(txScope, located.field.id, {
            deletedAt: new Date(),
            deletedColumnName: null,
          });
          if (deleted !== undefined) {
            await this.record(tx, conversionAuditContext(locked), {
              type: 'field.deleted',
              table: located.table,
              entityType: 'field',
              entityId: located.field.id,
              before: fieldSnapshot(located.field),
              after: null,
              jobId: locked.job_id,
            });
            partner = { table: located.table, fieldId: located.field.id, action: 'deleted' };
          }
        }
        await this.fields.update(txScope, field.id, { options: to as JsonObject });
      }
    }
    if (status === 'failed' && change === 'to_single' && locked.backup_table_name !== null) {
      const tables = await this.linkTablesOf(txScope, table, field, from);
      if (tables !== null) {
        await restoreLinkBackup(tx, {
          ref,
          backupTable: locked.backup_table_name,
          ...tables,
          ownIds: null,
          overwrite: false,
        });
      }
      await dropLinkBackupSql(locked.backup_table_name).execute(tx);
    }

    const counts = outcome.counts;
    if (status === 'succeeded') {
      // Computed fields reading either side of the link (ADR-28 §2): the
      // other side deleted → `REF`, taken back by `to_two_way` → healed
      // (T460); the others recomputed (T458).
      await this.reconcileComputedErrors(tx, scope, table.base_id, conversionAuditContext(locked), {
        causes: [field.id, ...(partner === null ? [] : [partner.fieldId])],
      });
      await this.recomputeReaders(tx, table, [field.id]);
      if (partner !== null) await this.recomputeReaders(tx, partner.table, [partner.fieldId]);
      await this.jobs.markSucceeded(txScope, locked.job_id, { field_id: field.id, ...counts });
      await this.bases.bumpPermissionVersion(txScope, { baseIds: [table.base_id] });
    } else {
      await this.jobs.markFailed(txScope, locked.job_id, error ?? { code: 'INTERNAL' });
    }
    await this.conversions.markFinished(txScope, locked.job_id, status, counts);
    await publishFieldConverting(this.db, tx, locked, table.base_id, status, 1);
    await this.record(tx, conversionAuditContext(locked), {
      type: 'field.converted',
      table,
      entityType: 'field',
      entityId: field.id,
      before: { type: 'link', options: from as JsonObject },
      after: { type: 'link', options: (status === 'succeeded' ? to : from) as JsonObject, counts },
      jobId: locked.job_id,
      data: {
        status,
        counts,
        link_change: change,
        partner_field_id: locked.partner_field_id,
      },
    });
    return { table, fieldId: field.id, partner };
  }

  /**
   * `POST /fields/:id/revert-conversion` of a link conversion (ADR-28 §2,
   * BACKLOG S4 design decision #7), within 7 days, in one transaction under
   * the schema locks of both tables:
   *
   * - `to_two_way`: the reverse field goes to the trash, the field is
   *   one-way again;
   * - `to_one_way`: the other side comes back from the trash with its id
   *   (like `POST /fields/:otherId/restore`: `409 NAME_CONFLICT`, `422
   *   FIELD_LIMIT_EXCEEDED`); already back → only the conversion is marked;
   * - `to_single`: the unique index goes, `allow_multiple = true`, and the
   *   removed links come back: `keep_later_edits` (default) for the cells
   *   whose audit trail shows no write of the field since the conversion
   *   (edited cells keep their value), `overwrite_later_edits` for every
   *   cut cell (exactly its links from before). One audit entry per record
   *   whose cell changed.
   *
   * Emits `field.converted` (`status: reverted`) and the partner's event;
   * after commit `schema.changed` for both tables.
   */
  async revertLinkConversion(
    scope: OrgScope,
    fieldId: Id<'fld'>,
    context: AuditContext,
    mode: RevertMode = 'keep_later_edits',
  ): Promise<FieldRow> {
    this.assertScope(scope);
    const reverted = await this.withFieldLock(scope, fieldId, async (tx, table, field) => {
      const txScope = withTxScope(scope, tx);
      await this.assertNotConverting(txScope, field);
      const conversion = revertible(await this.conversions.latestForField(txScope, fieldId));
      if (conversion === undefined || conversion.kind === 'column' || field.type !== 'link') {
        throw notFound('field');
      }
      const change = conversion.kind;
      const options = linkOptionsSchema.parse(field.options);
      let next: LinkOptions;
      let partner: PartnerPublish | null = null;
      let counts: JsonObject = {};
      if (change === 'to_two_way') {
        const located = await this.activeLinkPartner(tx, txScope, table, field);
        if (located !== null) {
          await this.assertNotConverting(txScope, located.field);
          await this.fields.update(txScope, located.field.id, {
            deletedAt: new Date(),
            deletedColumnName: null,
          });
          await this.record(tx, context, {
            type: 'field.deleted',
            table: located.table,
            entityType: 'field',
            entityId: located.field.id,
            before: fieldSnapshot(located.field),
            after: null,
          });
          partner = { table: located.table, fieldId: located.field.id, action: 'deleted' };
        }
        next = {
          ...options,
          bidirectional: false,
          bidirectional_link_field_name: null,
          symmetric_field_id: null,
        };
      } else if (change === 'to_one_way') {
        const restored = await this.restoreLinkPartner(
          tx,
          txScope,
          table,
          field,
          conversion,
          context,
        );
        partner = restored.publish;
        next = {
          ...options,
          bidirectional: true,
          bidirectional_link_field_name: restored.field.name,
          symmetric_field_id: restored.field.id,
        };
      } else {
        const junction = field.link_junction;
        const side = field.link_side;
        const backup = conversion.backup_table_name;
        if (junction === null || side === null || backup === null) throw notFound('field');
        await dropJunctionSingleIndexSql(junction, side).execute(tx);
        const ref = await this.linkCellsRef(txScope, field, options);
        const tables = await this.linkTablesOf(txScope, table, field, options);
        const cut = await backupCellIds(tx, ref, backup);
        const edited =
          mode === 'overwrite_later_edits'
            ? new Set<string>()
            : await this.auditLogs.recordsWithFieldChangesSince(txScope, {
                tableId: table.id,
                fieldId,
                recordIds: cut,
                since: conversion.finished_at ?? conversion.created_at,
              });
        const restoredIds = cut.filter((id) => !edited.has(id));
        if (tables !== null) {
          await restoreLinkBackup(tx, {
            ref,
            backupTable: backup,
            ...tables,
            ownIds: restoredIds,
            overwrite: mode === 'overwrite_later_edits',
            audit: { table, fieldId, context },
          });
        }
        await dropLinkBackupSql(backup).execute(tx);
        await this.tables.bumpDataVersion(txScope, table.id);
        if (conversion.partner_table_id !== null && conversion.partner_field_id !== null) {
          const partnerTable = await this.lockLinkPartnerTable(
            tx,
            txScope,
            table,
            conversion.partner_table_id,
          );
          if (partnerTable !== undefined) {
            await this.tables.bumpDataVersion(txScope, partnerTable.id);
            partner = {
              table: partnerTable,
              fieldId: conversion.partner_field_id,
              action: 'converted',
            };
          }
        }
        counts = { cut: cut.length, restored: restoredIds.length, edited: edited.size };
        next = { ...options, allow_multiple: true };
      }
      const updated = await this.fields.update(txScope, fieldId, { options: next as JsonObject });
      if (updated === undefined) throw notFound('field');
      await this.conversions.markReverted(txScope, conversion.job_id);
      // T460: the other side back (`to_one_way`) heals what read it; the
      // reverse field trashed again (`to_two_way`) → `REF`.
      await this.reconcileComputedErrors(tx, scope, table.base_id, context, {
        causes: [fieldId, ...(partner === null ? [] : [partner.fieldId])],
      });
      await this.recomputeReaders(tx, table, [fieldId]);
      if (partner !== null) await this.recomputeReaders(tx, partner.table, [partner.fieldId]);
      await this.record(tx, context, {
        type: 'field.converted',
        table,
        entityType: 'field',
        entityId: fieldId,
        before: { type: 'link', options: options as JsonObject },
        after: { type: 'link', options: next as JsonObject },
        data: {
          status: 'reverted',
          reverted_job_id: conversion.job_id,
          mode,
          link_change: change,
          partner_field_id: conversion.partner_field_id,
          counts,
        },
      });
      await this.bases.bumpPermissionVersion(txScope, { baseIds: [table.base_id] });
      return { field: updated, table, partner };
    });
    await this.publish(reverted.table, 'field', fieldId, 'converted');
    if (reverted.partner !== null) {
      await this.publish(
        reverted.partner.table,
        'field',
        reverted.partner.fieldId,
        reverted.partner.action,
      );
    }
    return reverted.field;
  }

  /** The field on the other side of `field`'s junction, whatever its state. */
  private async otherLinkSide(scope: OrgScope, field: FieldRow): Promise<FieldRow | undefined> {
    if (field.link_junction === null) return undefined;
    const rows = await this.fields.listByJunction(scope, field.link_junction);
    return rows.find((row) => row.link_side !== field.link_side);
  }

  /** The active partner of a two-way link field, with its table under its schema lock. */
  private async activeLinkPartner(
    tx: Tx,
    scope: OrgScope,
    table: TableRow,
    field: FieldRow,
  ): Promise<{ table: TableRow; field: FieldRow } | null> {
    const options = linkOptionsSchema.safeParse(field.options);
    const partnerId = options.success ? options.data.symmetric_field_id : null;
    if (partnerId === null) return null;
    const located = await this.fields.getById(scope, partnerId);
    if (located?.link_junction !== field.link_junction) return null;
    const partnerTable = await this.lockLinkPartnerTable(tx, scope, table, located.table_id);
    if (partnerTable === undefined || partnerTable.deleted_at !== null) return null;
    const partner = await this.fields.getById(scope, partnerId);
    return partner === undefined ? null : { table: partnerTable, field: partner };
  }

  /** `422 FIELD_LIMIT_EXCEEDED` / `409 NAME_CONFLICT` for the reverse field of `to_two_way`. */
  private async assertReverseFieldFits(
    scope: OrgScope,
    field: FieldRow,
    target: TableRow,
    reverseName: string,
    existingId: Id<'fld'> | undefined,
  ): Promise<void> {
    await this.assertFieldCapacity(scope, target.id);
    if (
      (target.id === field.table_id && reverseName === field.name) ||
      (await this.fields.nameTaken(scope, target.id, reverseName, existingId))
    ) {
      throw nameConflict('field', reverseName);
    }
  }

  /**
   * The reverse field of a `to_two_way` conversion (see
   * `finishLinkConversion`); an `AppError` (nothing written) when it no
   * longer fits.
   */
  private async addReverseLinkField(
    tx: Tx,
    scope: OrgScope,
    table: TableRow,
    field: FieldRow,
    locked: FieldConversionRow,
    to: LinkOptions,
  ): Promise<PartnerPublish | AppError> {
    const partnerId = locked.partner_field_id;
    const reverseName = to.bidirectional_link_field_name;
    if (partnerId === null || reverseName == null || field.link_junction === null) {
      return new AppError('INTERNAL', { detail: 'The reverse field was not planned.' });
    }
    const target = await this.lockLinkPartnerTable(tx, scope, table, to.link_table);
    if (target === undefined || target.deleted_at !== null || target.base_id !== table.base_id) {
      return new AppError('NOT_FOUND', { detail: 'The linked table does not exist.' });
    }
    const existing = await this.fields.getById(scope, partnerId, { includeDeleted: true });
    if (existing?.deleted_at === null) {
      return new AppError('SCHEMA_LOCKED', { detail: 'The other side of the link is active.' });
    }
    try {
      await this.assertReverseFieldFits(scope, field, target, reverseName, existing?.id);
    } catch (error) {
      if (error instanceof AppError) return error;
      throw error;
    }
    const options: LinkOptions = {
      link_table: table.id,
      bidirectional: true,
      bidirectional_link_field_name: field.name,
      allow_multiple: true,
      record_filter: null,
      symmetric_field_id: field.id,
    };
    const audit = conversionAuditContext(locked);
    if (existing !== undefined) {
      const before = linkOptionsSchema.safeParse(existing.options);
      if (before.success && !before.data.allow_multiple && existing.link_side !== null) {
        await dropJunctionSingleIndexSql(field.link_junction, existing.link_side).execute(tx);
      }
      const restored = await this.fields.update(scope, existing.id, {
        name: reverseName,
        options: options as JsonObject,
        deletedAt: null,
        deletedColumnName: null,
      });
      if (restored === undefined) throw notFound('field');
      await this.record(tx, audit, {
        type: 'field.restored',
        table: target,
        entityType: 'field',
        entityId: restored.id,
        before: null,
        after: fieldSnapshot(restored),
        jobId: locked.job_id,
      });
      return { table: target, fieldId: restored.id, action: 'restored' };
    }
    const reverse = await this.fields.insert(scope, {
      id: partnerId,
      tableId: target.id,
      name: reverseName,
      type: 'link',
      dbColumnName: null,
      options: options as JsonObject,
      isPrimary: false,
      required: false,
      uniqueValues: false,
      description: null,
      position: await this.fields.nextPosition(scope, target.id),
      linkJunction: field.link_junction,
      linkSide: field.link_side === 'a' ? 'b' : 'a',
    });
    await this.record(tx, audit, {
      type: 'field.created',
      table: target,
      entityType: 'field',
      entityId: reverse.id,
      before: null,
      after: fieldSnapshot(reverse),
      jobId: locked.job_id,
    });
    return { table: target, fieldId: reverse.id, action: 'created' };
  }

  /** The revert of `to_one_way`: the other side back from the trash, two-way again. */
  private async restoreLinkPartner(
    tx: Tx,
    scope: OrgScope,
    table: TableRow,
    field: FieldRow,
    conversion: FieldConversionRow,
    context: AuditContext,
  ): Promise<{ field: FieldRow; publish: PartnerPublish | null }> {
    const partnerId = conversion.partner_field_id;
    const located =
      partnerId === null
        ? undefined
        : await this.fields.getById(scope, partnerId, { includeDeleted: true });
    if (located === undefined || located.link_junction !== field.link_junction) {
      throw notFound('field');
    }
    const partnerTable = await this.lockLinkPartnerTable(tx, scope, table, located.table_id);
    const partner = await this.fields.getById(scope, located.id, { includeDeleted: true });
    if (partnerTable === undefined || partnerTable.deleted_at !== null || partner === undefined) {
      throw notFound('field');
    }
    const options = linkOptionsSchema.parse(partner.options);
    const linked: LinkOptions = { ...options, bidirectional: true, symmetric_field_id: field.id };
    if (partner.deleted_at === null) {
      const updated = await this.fields.update(scope, partner.id, {
        options: linked as JsonObject,
      });
      if (updated === undefined) throw notFound('field');
      if (!sameJson(partner.options, updated.options)) {
        await this.recordLinkPartnerChange(tx, context, partnerTable, partner, updated);
        return {
          field: updated,
          publish: { table: partnerTable, fieldId: updated.id, action: 'updated' },
        };
      }
      return { field: updated, publish: null };
    }
    if (partner.purged_at !== null) throw notFound('field');
    await this.assertNotConverting(scope, partner);
    await this.assertFieldCapacity(scope, partnerTable.id);
    if (await this.fields.nameTaken(scope, partnerTable.id, partner.name, partner.id)) {
      throw nameConflict('field', partner.name);
    }
    const restored = await this.fields.update(scope, partner.id, {
      deletedAt: null,
      deletedColumnName: null,
      options: linked as JsonObject,
    });
    if (restored === undefined) throw notFound('field');
    await this.record(tx, context, {
      type: 'field.restored',
      table: partnerTable,
      entityType: 'field',
      entityId: restored.id,
      before: null,
      after: fieldSnapshot(restored),
    });
    return {
      field: restored,
      publish: { table: partnerTable, fieldId: restored.id, action: 'restored' },
    };
  }

  /** Where the cells of a link field live (the linked table may be in the trash). */
  private async linkCellsRef(
    scope: OrgScope,
    field: FieldRow,
    options: LinkOptions,
  ): Promise<LinkCellsRef> {
    if (field.link_junction === null || field.link_side === null) {
      throw new TypeError('link conversion: no junction');
    }
    const otherTable =
      (await this.tables.getById(scope, options.link_table, { includeDeleted: true })) ?? null;
    return {
      junction: field.link_junction,
      ownColumn: field.link_side === 'a' ? 'a_id' : 'b_id',
      otherColumn: field.link_side === 'a' ? 'b_id' : 'a_id',
      otherTable,
      side: field.link_side,
    };
  }

  /** Tables of `a_id` and `b_id` of a link field's junction; `null` when one is gone. */
  private async linkTablesOf(
    scope: OrgScope,
    table: TableRow,
    field: FieldRow,
    options: LinkOptions,
  ): Promise<{ aTable: TableRow; bTable: TableRow } | null> {
    const other = await this.tables.getById(scope, options.link_table, { includeDeleted: true });
    if (other === undefined) return null;
    return field.link_side === 'a'
      ? { aTable: table, bTable: other }
      : { aTable: other, bTable: table };
  }

  // -------------------------------------------------------------------------
  // Link fields (SPEC §5.6, ADR-28, BACKLOG T401)

  /**
   * Adds a `link` field: `CREATE TABLE data.l_<shortId>` (foreign keys to
   * both tables `ON DELETE CASCADE`, index on `b_id`, unique `a_id` when
   * `allow_multiple = false`) and the meta row; with `bidirectional`, the
   * reverse field in the linked table reading the same junction from the
   * `b_id` side (`symmetric_field_id` pointing at each other), all in one
   * transaction holding the schema locks of both tables. A link uses no
   * column slot but counts towards `MAX_FIELDS_PER_TABLE` (both tables for
   * a two-way link). Self-links are allowed.
   *
   * The linked table must be an active table of the same base (else `404`);
   * `record_filter` must validate against its fields the saver can read
   * (`422 INVALID_FILTER`). The reverse field is named
   * `bidirectional_link_field_name` (default: this table's name). Schema
   * rights on both tables are the caller's to check.
   */
  private async addLinkField(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    input: AddFieldInput,
    context: AuditContext,
  ): Promise<FieldRow> {
    const name = normalizeSchemaName(input.name);
    if (input.uniqueValues === true) {
      throw validationFailed([
        {
          path: 'unique_values',
          code: 'UNIQUE_NOT_SUPPORTED',
          message: 'Field type link cannot require unique values',
          params: { type: 'link' },
        },
      ]);
    }
    const requested = parseOptions(
      { optionsSchema: linkOptionsSchema },
      input.options,
    ) as LinkOptions;
    const added = await this.withTableLock(scope, tableId, async (tx, table) => {
      const txScope = withTxScope(scope, tx);
      const target = await this.lockLinkTarget(tx, txScope, table, requested.link_table);
      const recordFilter = await this.checkRecordFilter(
        txScope,
        target,
        requested.record_filter,
        input.link,
      );
      const self = target.id === table.id;
      await this.assertFieldCapacity(txScope, tableId, requested.bidirectional && self ? 2 : 1);
      if (requested.bidirectional && !self) await this.assertFieldCapacity(txScope, target.id);
      if (await this.fields.nameTaken(txScope, tableId, name)) throw nameConflict('field', name);
      let reverseName: string | null = null;
      if (requested.bidirectional) {
        reverseName = normalizeSchemaName(
          requested.bidirectional_link_field_name ?? table.name,
          'options.bidirectional_link_field_name',
        );
        if (
          (self && reverseName === name) ||
          (await this.fields.nameTaken(txScope, target.id, reverseName))
        ) {
          throw nameConflict('field', reverseName);
        }
      }

      const junction = junctionTableName();
      await this.execute(
        tx,
        createJunctionSql(
          junction,
          table.db_table_name,
          target.db_table_name,
          !requested.allow_multiple,
        ),
      );
      const fieldId = newId('fld');
      const reverseId = reverseName === null ? null : newId('fld');
      const options: LinkOptions = {
        link_table: target.id,
        bidirectional: reverseId !== null,
        bidirectional_link_field_name: reverseName,
        allow_multiple: requested.allow_multiple,
        record_filter: recordFilter,
        symmetric_field_id: reverseId,
      };
      const field = await this.fields.insert(txScope, {
        id: fieldId,
        tableId,
        name,
        type: 'link',
        dbColumnName: null,
        options: options as JsonObject,
        isPrimary: false,
        required: input.required ?? false,
        uniqueValues: false,
        description: input.description ?? null,
        position: await this.fields.nextPosition(txScope, tableId),
        linkJunction: junction,
        linkSide: 'a',
      });
      await this.record(tx, context, {
        type: 'field.created',
        table,
        entityType: 'field',
        entityId: field.id,
        before: null,
        after: fieldSnapshot(field),
      });
      let reverse: FieldRow | null = null;
      if (reverseId !== null && reverseName !== null) {
        const reverseOptions: LinkOptions = {
          link_table: table.id,
          bidirectional: true,
          bidirectional_link_field_name: name,
          allow_multiple: true,
          record_filter: null,
          symmetric_field_id: fieldId,
        };
        reverse = await this.fields.insert(txScope, {
          id: reverseId,
          tableId: target.id,
          name: reverseName,
          type: 'link',
          dbColumnName: null,
          options: reverseOptions as JsonObject,
          isPrimary: false,
          required: false,
          uniqueValues: false,
          description: null,
          position: await this.fields.nextPosition(txScope, target.id),
          linkJunction: junction,
          linkSide: 'b',
        });
        await this.record(tx, context, {
          type: 'field.created',
          table: target,
          entityType: 'field',
          entityId: reverse.id,
          before: null,
          after: fieldSnapshot(reverse),
        });
      }
      // The new fields are part of every role's access (SPEC §14.1).
      await this.bases.bumpPermissionVersion(txScope, { baseIds: [table.base_id] });
      return { field, table, reverse, target };
    });
    await this.publish(added.table, 'field', added.field.id, 'created');
    if (added.reverse !== null) {
      await this.publish(added.target, 'field', added.reverse.id, 'created');
    }
    return added.field;
  }

  /**
   * The linked table of a new link, under its schema lock (taken after the
   * table's own; DDL deadlocks are retried): an active table of the same
   * base (else `404`), not being compacted (else `409 SCHEMA_LOCKED`).
   */
  private async lockLinkTarget(
    tx: Tx,
    scope: OrgScope,
    table: TableRow,
    targetId: Id<'tbl'>,
  ): Promise<TableRow> {
    if (targetId === table.id) return table;
    await this.lock(tx, targetId);
    const target = await this.tables.getById(scope, targetId);
    if (target?.base_id !== table.base_id) {
      throw new AppError('NOT_FOUND', { detail: 'The linked table does not exist.' });
    }
    if (target.schema_state === 'compacting') {
      throw new AppError('SCHEMA_LOCKED', {
        detail: 'The linked table is being compacted; try again in a few minutes.',
        params: { table_id: target.id, schema_state: target.schema_state },
      });
    }
    return target;
  }

  /**
   * `record_filter` validated against the active fields of the linked table
   * the saver can read (`422 INVALID_FILTER`, paths under
   * `options.record_filter`); stored as the validated DSL.
   */
  private async checkRecordFilter(
    scope: OrgScope,
    target: TableRow,
    filter: LinkOptions['record_filter'],
    link: LinkFieldContext | undefined,
  ): Promise<JsonObject | null> {
    if (filter === null) return null;
    const models = (await this.fields.listByTable(scope, target.id))
      .map(toFieldModel)
      .filter((model) => model !== null);
    const readable = link?.readableTargetFieldIds;
    const allowed = models
      .map((model) => model.id)
      .filter((id) => readable === undefined || readable.has(id));
    const result = validateFilter(
      filter,
      { fields: models.map((model) => model.filterMeta) },
      allowed,
    );
    if (!result.ok) {
      throw new AppError('INVALID_FILTER', {
        detail: 'The record filter of the link is invalid.',
        errors: result.errors.map((issue: FilterIssue) => ({
          ...issue,
          path: issue.path === '' ? 'options.record_filter' : prefixPath(issue.path),
        })),
      });
    }
    return result.ast as unknown as JsonObject;
  }

  /**
   * Options of a link PATCH: `record_filter` (validated again when it
   * changes) and `allow_multiple` false → true may change; `link_table`,
   * `bidirectional` and `allow_multiple` true → false are conversions
   * (`422 CONVERSION_NOT_ALLOWED`, ADR-28 / CONTRACTS §4.2). Read-only keys
   * (`symmetric_field_id`, `bidirectional_link_field_name`) keep their value.
   */
  private async linkOptionsForUpdate(
    scope: OrgScope,
    field: FieldRow,
    requested: unknown,
    link: LinkFieldContext | undefined,
  ): Promise<JsonObject> {
    const current = linkOptionsSchema.parse(field.options);
    const next = parseOptions({ optionsSchema: linkOptionsSchema }, requested) as LinkOptions;
    const conversion = (path: string, message: string) =>
      new AppError('CONVERSION_NOT_ALLOWED', {
        detail: 'This change of a link field is a conversion (PUT /fields/:id).',
        errors: [{ path, code: 'CONVERSION_NOT_ALLOWED', message }],
      });
    if (next.link_table !== current.link_table) {
      throw conversion('options.link_table', 'The linked table cannot be changed');
    }
    if (next.bidirectional !== current.bidirectional) {
      throw conversion('options.bidirectional', 'Changing the direction of a link is a conversion');
    }
    if (current.allow_multiple && !next.allow_multiple) {
      throw conversion(
        'options.allow_multiple',
        'Changing allow_multiple from true to false is a conversion',
      );
    }
    let recordFilter = current.record_filter;
    if (!sameJson(next.record_filter as JsonValue, current.record_filter as JsonValue)) {
      const target = await this.tables.getById(scope, current.link_table);
      if (target === undefined && next.record_filter !== null) {
        throw new AppError('NOT_FOUND', { detail: 'The linked table does not exist.' });
      }
      recordFilter =
        target === undefined
          ? null
          : await this.checkRecordFilter(scope, target, next.record_filter, link);
    }
    const options: LinkOptions = {
      ...current,
      allow_multiple: next.allow_multiple,
      record_filter: recordFilter,
    };
    return options as JsonObject;
  }

  /**
   * Physical side of a link PATCH: `allow_multiple` false → true drops the
   * unique index of the field's side of the junction (`a_id`, or `b_id` for
   * a reverse field made single by T404); a link never has unique values.
   */
  private async applyLinkFieldOptions(
    tx: Tx,
    field: FieldRow,
    newOptions: JsonObject | undefined,
    newUniqueValues: boolean | undefined,
  ): Promise<void> {
    if (newUniqueValues === true) {
      throw validationFailed([
        {
          path: 'unique_values',
          code: 'UNIQUE_NOT_SUPPORTED',
          message: 'Field type link cannot require unique values',
          params: { type: 'link' },
        },
      ]);
    }
    if (newOptions === undefined || field.link_junction === null || field.link_side === null) {
      return;
    }
    const before = linkOptionsSchema.parse(field.options);
    const after = linkOptionsSchema.parse(newOptions);
    if (!before.allow_multiple && after.allow_multiple) {
      await this.execute(tx, [dropJunctionSingleIndexSql(field.link_junction, field.link_side)]);
    }
  }

  /**
   * The active reverse field of a deleted link side becomes one-way
   * (`bidirectional: false`, no `symmetric_field_id`; `field.updated`). The
   * deleted side keeps its options, so a restore can join it again.
   */
  private async detachLinkPartner(
    tx: Tx,
    scope: OrgScope,
    table: TableRow,
    field: FieldRow,
    context: AuditContext,
  ): Promise<LinkPartner | null> {
    const txScope = withTxScope(scope, tx);
    const options = linkOptionsSchema.safeParse(field.options);
    const partnerId = options.success ? options.data.symmetric_field_id : null;
    if (partnerId === null) return null;
    const located = await this.fields.getById(txScope, partnerId);
    if (located?.link_junction !== field.link_junction) return null;
    const partnerTable = await this.lockLinkPartnerTable(tx, txScope, table, located.table_id);
    if (partnerTable === undefined) return null;
    const partner = await this.fields.getById(txScope, partnerId);
    if (partner === undefined) return null;
    const current = linkOptionsSchema.parse(partner.options);
    const updated = await this.fields.update(txScope, partner.id, {
      options: { ...current, bidirectional: false, symmetric_field_id: null } as JsonObject,
    });
    if (updated === undefined) return null;
    await this.recordLinkPartnerChange(tx, context, partnerTable, partner, updated);
    return { table: partnerTable, field: updated };
  }

  /**
   * A restored link side whose partner is still active and one-way reads
   * the same junction as a two-way link again (both `symmetric_field_id`
   * set, `field.updated` on the partner); otherwise it stays one-way.
   */
  private async reattachLinkPartner(
    tx: Tx,
    scope: OrgScope,
    table: TableRow,
    field: FieldRow,
    context: AuditContext,
  ): Promise<{ field: FieldRow; partner: LinkPartner | null }> {
    const txScope = withTxScope(scope, tx);
    const options = linkOptionsSchema.parse(field.options);
    const partnerId = options.symmetric_field_id;
    if (partnerId === null) return { field, partner: null };
    const located = await this.fields.getById(txScope, partnerId);
    const partnerTable =
      located === undefined
        ? undefined
        : await this.lockLinkPartnerTable(tx, txScope, table, located.table_id);
    const partner =
      partnerTable === undefined ? undefined : await this.fields.getById(txScope, partnerId);
    const partnerOptions =
      partner === undefined ? null : linkOptionsSchema.safeParse(partner.options);
    if (
      partner !== undefined &&
      partnerTable !== undefined &&
      partner.link_junction === field.link_junction &&
      partnerOptions?.success === true &&
      partnerOptions.data.symmetric_field_id === null
    ) {
      const updated = await this.fields.update(txScope, partner.id, {
        options: {
          ...partnerOptions.data,
          bidirectional: true,
          symmetric_field_id: field.id,
        } as JsonObject,
      });
      if (updated !== undefined) {
        await this.recordLinkPartnerChange(tx, context, partnerTable, partner, updated);
        return { field, partner: { table: partnerTable, field: updated } };
      }
    }
    const oneWay = await this.fields.update(txScope, field.id, {
      options: { ...options, bidirectional: false, symmetric_field_id: null } as JsonObject,
    });
    return { field: oneWay ?? field, partner: null };
  }

  /** The table of a link partner under its schema lock (the trash included); `undefined` when gone. */
  private async lockLinkPartnerTable(
    tx: Tx,
    scope: OrgScope,
    table: TableRow,
    partnerTableId: Id<'tbl'>,
  ): Promise<TableRow | undefined> {
    if (partnerTableId === table.id) return table;
    await this.lock(tx, partnerTableId);
    return this.tables.getById(scope, partnerTableId, { includeDeleted: true });
  }

  private async recordLinkPartnerChange(
    tx: Tx,
    context: AuditContext,
    table: TableRow,
    before: FieldRow,
    after: FieldRow,
  ): Promise<void> {
    await this.record(tx, context, {
      type: 'field.updated',
      table,
      entityType: 'field',
      entityId: after.id,
      before: { options: before.options },
      after: { options: after.options },
    });
  }

  // -------------------------------------------------------------------------
  // Column budget and compaction (ADR-20)

  /** Column slots used by the table, dropped columns included. */
  async usedSlots(scope: OrgScope, tableId: Id<'tbl'>): Promise<number> {
    this.assertScope(scope);
    const table = await this.tables.getById(scope, tableId, { includeDeleted: true });
    if (table === undefined) throw notFound('table');
    return usedColumnSlots(this.db.kysely, table.db_table_name);
  }

  /** Mismatches between the catalog and meta for a table (empty = consistent). */
  async checkConsistency(scope: OrgScope, tableId: Id<'tbl'>): Promise<string[]> {
    this.assertScope(scope);
    const table = await this.tables.getById(scope, tableId, { includeDeleted: true });
    if (table === undefined) throw notFound('table');
    const fields = await this.fields.listByTable(scope, tableId, { includeDeleted: true });
    const conversions = await this.conversions.listLiveByTable(scope, tableId);
    return checkSchemaConsistency(
      this.db.kysely,
      table,
      fields,
      conversionColumnsOf(conversions, table),
    );
  }

  /**
   * `schema.compact_table` (ADR-20 §3): rebuilds `data.<db_table_name>` with
   * only the columns in use, so dropped and `__deleted_` columns give their
   * slots back. The table keeps its physical name, `__auto` values and
   * sequence position, indexes, constraints and incoming junction foreign
   * keys. Deleted fields whose column is dropped are marked purged (no longer
   * restorable).
   *
   * 1. `schema_state = compacting` (committed: DDL answers 409 meanwhile);
   * 2. one transaction under the table's advisory lock: `LOCK TABLE … IN
   *    SHARE MODE` (reads continue), create the new table, copy rows with
   *    `OVERRIDING SYSTEM VALUE`, move the identity sequence past the old
   *    one, rebuild indexes and CHECKs, move junction FKs (`NOT VALID` +
   *    `VALIDATE`), drop the old table, rename the new one and its indexes
   *    and sequence to the old names, verify meta against the catalog, set
   *    `compacted_at` and audit `schema.compacted`;
   * 3. on failure the state goes back to `ready` and the error is rethrown
   *    (the job retries).
   */
  async compactTable(scope: OrgScope, tableId: Id<'tbl'>): Promise<CompactionResult> {
    this.assertScope(scope);
    await this.withTableLock(
      scope,
      tableId,
      (tx) => this.tables.setSchemaState(withTxScope(scope, tx), tableId, 'compacting'),
      { includeDeleted: true, allowCompacting: true },
    );
    let result: CompactionResult;
    try {
      result = await this.withTableLock(
        scope,
        tableId,
        (tx, table) => this.compactLocked(scope, tx, table),
        { includeDeleted: true, allowCompacting: true, timeoutMs: this.compactionTimeoutMs },
      );
    } catch (error) {
      await this.withTableLock(
        scope,
        tableId,
        (tx) => this.tables.setSchemaState(withTxScope(scope, tx), tableId, 'ready'),
        { includeDeleted: true, allowCompacting: true },
      );
      throw error;
    }
    const table = await this.tables.getById(scope, tableId);
    // ADR-20 step 7: clients refetch the schema (a trashed table has no subscribers).
    if (table !== undefined) await this.publish(table, 'table', tableId, 'updated');
    return result;
  }

  private async compactLocked(scope: OrgScope, tx: Tx, table: TableRow): Promise<CompactionResult> {
    const txScope = withTxScope(scope, tx);
    const oldName = assertDataTableName(table.db_table_name);
    await sql`LOCK TABLE ${this.tableRef(oldName)} IN SHARE MODE`.execute(tx);
    const slotsBefore = await usedColumnSlots(tx, oldName);

    // `__parent_id` (sub-records, T405) is the only foreign key a data table
    // may declare; it is rebuilt on the new table below.
    const referencing = await foreignKeysReferencing(tx, oldName);
    const parentFk = referencing.find((fk) => fk.self && fk.name === parentForeignKeyName(oldName));
    if ((await outgoingForeignKeyCount(tx, oldName)) !== (parentFk === undefined ? 0 : 1)) {
      throw new Error(`Compaction of ${oldName}: unsupported foreign keys on the table`);
    }
    const incoming = referencing.filter((fk) => fk !== parentFk);
    for (const fk of incoming) {
      if (fk.self || fk.columns !== 1 || fk.schema !== DATA_SCHEMA) {
        throw new Error(`Compaction of ${oldName}: unsupported foreign key ${fk.name}`);
      }
      assertJunctionTableName(fk.table);
      for (const identifier of [fk.name, fk.column, fk.referencedColumn]) {
        if (!CATALOG_IDENTIFIER.test(identifier)) {
          throw new Error(`Compaction of ${oldName}: unexpected identifier ${identifier}`);
        }
      }
      if (ON_DELETE_ACTIONS[fk.onDelete] === undefined) {
        throw new Error(`Compaction of ${oldName}: unexpected ON DELETE action of ${fk.name}`);
      }
    }

    const newName = dataTableName();
    const fields = await this.fields.listByTable(txScope, table.id, { includeDeleted: true });
    // Active columns, plus trashed columns still restorable (30 days, ADR-23 §3).
    // Older trashed columns are dropped and their fields marked purged.
    const restorableSince = Date.now() - FIELD_RESTORE_WINDOW_MS;
    const kept: { readonly plan: ColumnPlan; readonly physical: string }[] = [];
    const keptDeletedFieldIds: Id<'fld'>[] = [];
    const toPurge: Id<'fld'>[] = [];
    // `__parent_id` is kept while its `parent` field is active or restorable.
    for (const field of fields) {
      if (
        field.type === 'parent' &&
        field.deleted_at !== null &&
        field.purged_at === null &&
        field.deleted_at.getTime() < restorableSince
      ) {
        toPurge.push(field.id);
      }
    }
    const keepParent =
      parentFk !== undefined &&
      parentColumnKept(fields.filter((field) => !toPurge.includes(field.id)));
    for (const field of fields) {
      if (field.deleted_at !== null) {
        if (field.purged_at !== null || field.deleted_column_name === null) continue;
        if (field.deleted_at.getTime() < restorableSince) {
          toPurge.push(field.id);
          continue;
        }
      }
      const plan = planStoredField(field, { db_table_name: newName, collation: table.collation });
      if (plan === null) continue;
      const physical = field.deleted_at === null ? plan.column : field.deleted_column_name;
      if (physical === null) continue;
      kept.push({ plan, physical });
      if (field.deleted_at !== null) keptDeletedFieldIds.push(field.id);
    }
    // Columns of type conversions (T403): the shadow of a running one, the
    // old column of a succeeded one within its 7 days (ADR-20 step 3);
    // expired old columns are dropped here and marked cleaned.
    const conversions = await this.conversions.listLiveByTable(txScope, table.id);
    const expiredConversions = conversions.filter(
      (conversion) =>
        conversion.status === 'succeeded' && conversion.expires_at.getTime() <= Date.now(),
    );
    const liveConversions = conversions.filter(
      (conversion) => !expiredConversions.includes(conversion),
    );
    for (const old of conversionColumnsOf(liveConversions, {
      db_table_name: newName,
      collation: table.collation,
    })) {
      kept.push({ plan: old.plan, physical: old.name });
    }

    // Scan indexes of date columns (T508) are made on demand, not planned: kept as they are.
    const dueIndexed = new Set(await dueIndexedColumnsOf(tx, oldName));

    // Step 3: new table with the system columns and every column kept.
    await this.execute(tx, [
      createTableSql(newName),
      ...kept.map(({ plan, physical }) => addColumnSql(newName, plan, physical)),
      ...(keepParent ? [addParentColumnSql(newName)] : []),
    ]);
    // Step 4: copy, keeping `__auto`; the sequence continues after the old one.
    const columns = sql.join(
      [
        ...SYSTEM_COLUMN_NAMES,
        ...kept.map(({ physical }) => physical),
        ...(keepParent ? [PARENT_COLUMN] : []),
      ].map((c) => sql.id(c)),
    );
    const copied =
      await sql`INSERT INTO ${this.tableRef(newName)} (${columns}) OVERRIDING SYSTEM VALUE SELECT ${columns} FROM ${this.tableRef(oldName)}`.execute(
        tx,
      );
    await sql`
      SELECT setval(
        pg_get_serial_sequence(${`${DATA_SCHEMA}.${newName}`}, '__auto'),
        GREATEST(
          COALESCE((SELECT max(__auto) FROM ${this.tableRef(newName)}), 0),
          COALESCE(pg_sequence_last_value(pg_get_serial_sequence(${`${DATA_SCHEMA}.${oldName}`}, '__auto')::regclass), 0)
        ) + 1,
        false
      )
    `.execute(tx);
    // Step 5: indexes and CHECK constraints.
    await this.execute(tx, [
      ...systemIndexesSql(newName),
      ...kept.flatMap(({ plan, physical }) => [
        ...(plan.singleValue ? [singleValueCheckSql(newName, plan.column, physical)] : []),
        ...plan.indexes.map((index) => createIndexSql(newName, physical, index)),
        ...(dueIndexed.has(physical) ? [createDueIndexSql(newName, physical)] : []),
      ]),
      ...(keepParent ? [parentIndexSql(newName)] : []),
    ]);
    // Step 6 (first half): junction FKs let go of the old table.
    for (const fk of incoming) {
      await sql`ALTER TABLE ${this.junctionRef(fk.table)} DROP CONSTRAINT ${sql.id(fk.name)}`.execute(
        tx,
      );
    }
    // Step 7: swap, keeping the physical name (BI tools, SPEC §1).
    await sql`DROP TABLE ${this.tableRef(oldName)}`.execute(tx);
    await sql`ALTER TABLE ${this.tableRef(newName)} RENAME TO ${sql.id(oldName)}`.execute(tx);
    for (const index of await indexNamesOf(tx, oldName)) {
      if (!index.startsWith(`${newName}_`)) continue;
      await sql`ALTER INDEX ${sql.id(DATA_SCHEMA, index)} RENAME TO ${sql.id(renamePrefixed(index, newName, oldName))}`.execute(
        tx,
      );
    }
    await sql`ALTER SEQUENCE ${sql.id(DATA_SCHEMA, autoSequenceName(newName))} RENAME TO ${sql.id(autoSequenceName(oldName))}`.execute(
      tx,
    );
    if (keepParent) {
      await this.execute(tx, [
        parentForeignKeySql(oldName, true),
        validateParentForeignKeySql(oldName),
      ]);
    }
    // Step 6 (second half): point the junction FKs at the new table.
    for (const fk of incoming) {
      await sql`ALTER TABLE ${this.junctionRef(fk.table)} ADD CONSTRAINT ${sql.id(fk.name)} FOREIGN KEY (${sql.id(fk.column)}) REFERENCES ${this.tableRef(oldName)} (${sql.id(fk.referencedColumn)}) ON DELETE ${sql.raw(ON_DELETE_ACTIONS[fk.onDelete] ?? 'NO ACTION')} NOT VALID`.execute(
        tx,
      );
      await sql`ALTER TABLE ${this.junctionRef(fk.table)} VALIDATE CONSTRAINT ${sql.id(fk.name)}`.execute(
        tx,
      );
    }

    const purgedFieldIds = await this.fields.markPurged(txScope, table.id, toPurge);
    for (const conversion of expiredConversions) {
      await this.conversions.markCleaned(txScope, conversion.job_id);
    }
    const compacted = await this.tables.markCompacted(txScope, table.id);
    if (compacted === undefined) throw notFound('table');
    const problems = await checkSchemaConsistency(
      tx,
      compacted,
      await this.fields.listByTable(txScope, table.id, { includeDeleted: true }),
      conversionColumnsOf(liveConversions, compacted),
    );
    if (problems.length > 0) {
      throw new Error(
        `Compaction of ${oldName} left an inconsistent schema: ${problems.join('; ')}`,
      );
    }
    const slotsAfter = await usedColumnSlots(tx, oldName);
    const rows = Number(copied.numAffectedRows ?? 0n);
    await this.audit.write(tx, {
      action: 'schema.compacted',
      organizationId: scope.organizationId,
      baseId: table.base_id,
      tableId: table.id,
      entityType: 'table',
      entityId: table.id,
      before: { used_slots: slotsBefore },
      after: {
        used_slots: slotsAfter,
        rows,
        purged_field_ids: purgedFieldIds,
        kept_deleted_field_ids: keptDeletedFieldIds,
      },
      context: {
        actor: { type: 'system', id: null },
        via: null,
        batch_id: null,
        request_id: null,
        ip: null,
        user_agent: null,
      },
    });
    // Hook: invalidate cached table meta on every api instance once the
    // cache layer exists (S2); `schema.changed` is published after commit.
    return {
      tableId: table.id,
      dbTableName: oldName,
      slotsBefore,
      slotsAfter,
      rows,
      purgedFieldIds,
      keptDeletedFieldIds,
      stillOverBudget: slotsAfter >= this.thresholds.compact,
      junctionForeignKeys: incoming.map((fk: IncomingForeignKey) => fk.name),
    };
  }

  // -------------------------------------------------------------------------
  // Computed fields (BACKLOG T456, SPEC §5.8, §5.9, §9)

  /**
   * Adds a `formula`/`lookup` field: the definition is parsed, resolved
   * against what the saver may read (`input.computed.readable`, SPEC §9.5)
   * and typechecked (`prepareComputedDefinition`), within the per-base
   * limit (`COMPUTED_FIELDS_MAX_PER_BASE`, `422 FORMULA_LIMIT_EXCEEDED`).
   * A `stored` field gets a column of its result type (1 slot, ADR-20) and
   * a `computed.backfill` job (`compute_state = backfilling`, cells read
   * empty meanwhile); a `virtual` one no column. Its dependencies are
   * written to `meta.field_dependencies` in the same transaction.
   */
  private async addComputedField(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    input: AddFieldInput,
    context: AuditContext,
  ): Promise<FieldRow> {
    const name = normalizeSchemaName(input.name);
    const type = input.type as ComputedFieldTypeName;
    assertComputedConstraints(type, input.uniqueValues, input.required);
    try {
      const added = await this.withTableLock(scope, tableId, async (tx, table) => {
        const txScope = withTxScope(scope, tx);
        await this.lockComputedGraph(tx, table.base_id);
        await this.assertFieldCapacity(txScope, tableId);
        if (await this.fields.nameTaken(txScope, tableId, name)) throw nameConflict('field', name);
        await this.assertComputedCapacity(txScope, table.base_id);
        const rows = await loadBaseSchemaRows(this.db, txScope, table.base_id);
        const prepared = prepareComputedDefinition(
          { type, options: input.options, style: styleModeOf(input.options, undefined) },
          computedContextOf(rows, tableId, input.computed),
        );
        const fieldId = newId('fld');
        const column = await this.computedColumn(tx, table, null, null, prepared);
        const field = await this.fields.insert(txScope, {
          id: fieldId,
          tableId,
          name,
          type,
          dbColumnName: column,
          options: prepared.options,
          isPrimary: false,
          required: false,
          uniqueValues: false,
          description: input.description ?? null,
          position: await this.fields.nextPosition(txScope, tableId),
          computed: {
            computeMode: prepared.computeMode,
            resultType: prepared.resultType,
            computeState: prepared.computeMode === 'stored' ? 'backfilling' : 'ready',
          },
        });
        await this.dependencies.replaceForField(txScope, {
          baseId: table.base_id,
          fieldId,
          edges: edgesOf(fieldId, prepared.analysis.dependencies),
        });
        const jobId =
          prepared.computeMode === 'stored'
            ? await this.enqueueComputedBackfill(tx, field, context)
            : undefined;
        await this.record(tx, context, {
          type: 'field.created',
          table,
          entityType: 'field',
          entityId: field.id,
          before: null,
          after: fieldSnapshot(field),
          ...(jobId === undefined ? {} : { jobId }),
        });
        // The new field is part of every role's access (SPEC §14.1).
        await this.bases.bumpPermissionVersion(txScope, { baseIds: [table.base_id] });
        // T460: reading a field in error makes it `REF` at once.
        await this.reconcileComputedErrors(tx, scope, table.base_id, context, {
          covered: jobId === undefined ? [] : [fieldId],
        });
        return { field: (await this.fields.getById(txScope, fieldId)) ?? field, table };
      });
      await this.publish(added.table, 'field', added.field.id, 'created');
      return added.field;
    } catch (error) {
      if (error instanceof SlotBudgetExhausted) {
        await this.db.withTx((tx) => this.enqueueCompaction(tx, scope.organizationId, tableId));
        throw new AppError('SCHEMA_LOCKED', {
          detail:
            'The table has used its column budget; it is being compacted. Try again in a few minutes.',
          params: { table_id: tableId, used_slots: error.usedSlots },
        });
      }
      throw error;
    }
  }

  /**
   * A new definition of a formula/lookup field, inside `updateField`'s
   * transaction (table lock held): `given` are the API options (formula:
   * `expression` in display form and/or `style`; lookup: any of its keys),
   * merged with the stored ones. Reference cycles (through any table, links
   * both ways, self-links) → `422 FORMULA_CYCLE` (`params.cycle`: the fields
   * of the chain the saver sees). A change of result type or of mode gets a
   * new column (the old one dropped, ADR-20) or loses it; the same column is
   * recomputed in place (cells show their previous values until then). The
   * computed fields reading this one are analysed again: new types/modes
   * follow (columns included), one that no longer typechecks is
   * `INVALID_CONFIG` and one that was in error because of this field heals
   * (T460); the backfill job then recomputes them after this one.
   */
  private async changeComputedDefinition(
    tx: Tx,
    scope: OrgScope,
    table: TableRow,
    field: FieldRow,
    given: Readonly<Record<string, unknown>>,
    computed: ComputedFieldContext | undefined,
    context: AuditContext,
  ): Promise<ComputedChange> {
    const txScope = withTxScope(scope, tx);
    await this.lockComputedGraph(tx, table.base_id);
    const rows = await loadBaseSchemaRows(this.db, txScope, table.base_id);
    const type = field.type as ComputedFieldTypeName;
    const current = isRecordValue(field.options) ? field.options : {};
    let input: ComputedDefinitionInput;
    if (type === 'formula') {
      const hasExpression = Object.hasOwn(given, 'expression');
      input = {
        type,
        options: { expression: current['expression'], ...given },
        expressionForm: hasExpression ? 'display' : 'stored',
        style: styleModeOf(given, current['style']),
      };
    } else {
      const stored: Record<string, unknown> = { ...current };
      delete stored['style'];
      input = {
        type,
        options: { ...stored, ...given },
        style: styleModeOf(given, current['style']),
      };
    }
    const prepared = prepareComputedDefinition(input, computedContextOf(rows, table.id, computed));
    const newEdges = edgesOf(field.id, prepared.analysis.dependencies);
    const edges: FieldDependencyEdge[] = [
      ...(await this.dependencies.listByBase(txScope, table.base_id)).filter(
        (edge) => edge.fieldId !== field.id,
      ),
      ...newEdges,
    ];
    const active = new Set<string>(rows.fields.filter(isComputedRow).map((row) => row.id));
    const cycle = findCycle(field.id, edges, active);
    if (cycle !== null) throw formulaCycleProblem(cycle, rows, computed?.readable);

    // Saving a field in error again (same definition) computes it again (T460: `TIMEOUT`).
    const unchanged =
      sameJson(field.options, prepared.options) &&
      sameJson(field.result_type, prepared.resultType) &&
      field.compute_mode === prepared.computeMode &&
      field.compute_state !== 'error';
    if (unchanged) return { field, jobId: undefined, dependents: [] };

    const column = await this.computedColumn(
      tx,
      table,
      field.db_column_name,
      field.result_type,
      prepared,
    );
    const updated = await this.fields.update(txScope, field.id, {
      options: prepared.options,
      computeMode: prepared.computeMode,
      resultType: prepared.resultType,
      computeState: prepared.computeMode === 'stored' ? 'backfilling' : 'ready',
      computeError: null,
      dbColumnName: column,
    });
    if (updated === undefined) throw notFound('field');
    await this.dependencies.replaceForField(txScope, {
      baseId: table.base_id,
      fieldId: field.id,
      edges: newEdges,
    });
    const { changed: dependents } = await this.cascadeComputed(
      tx,
      scope,
      rows,
      updated,
      edges,
      context,
    );
    const jobId =
      prepared.computeMode === 'stored'
        ? await this.enqueueComputedBackfill(tx, updated, context)
        : undefined;
    // T460: readers no longer typechecking → `INVALID_CONFIG`; readers of a
    // field that was in error heal (its job computes them).
    await this.reconcileComputedErrors(tx, scope, table.base_id, context, {
      causes: [field.id],
      covered: jobId === undefined ? [] : [field.id],
    });
    const reread = (await this.fields.getById(txScope, field.id)) ?? updated;
    return { field: reread, jobId, dependents };
  }

  /**
   * The computed fields reading `start` (directly or not), in topological
   * order, analysed again with its new type and mode (T456): another result
   * type or mode → column added/dropped like a definition change (and
   * `backfilling`, listed in `retyped`); the same type and mode → with
   * `mode = 'backfill'` (a new definition of `start`, whose backfill job
   * computes its readers after it) marked `backfilling` when stored, with
   * `mode = 'follow'` (a type conversion of a plain field: the recompute
   * follows) left as they are. Fields in error, or whose definition no
   * longer analyses, are left to {@link reconcileComputedErrors} (T460:
   * `INVALID_CONFIG`, or healed).
   */
  private async cascadeComputed(
    tx: Tx,
    scope: OrgScope,
    rows: BaseSchemaRows,
    start: FieldRow,
    edges: readonly FieldDependencyEdge[],
    context: AuditContext,
    mode: 'backfill' | 'follow' = 'backfill',
  ): Promise<{
    readonly changed: { readonly table: TableRow; readonly fieldId: Id<'fld'> }[];
    readonly retyped: Id<'fld'>[];
  }> {
    const txScope = withTxScope(scope, tx);
    const active = new Set<string>(rows.fields.filter(isComputedRow).map((row) => row.id));
    const order = dependentsInOrder(start.id, edges, active).slice(1);
    const fields = new Map<string, FieldRow>(rows.fields.map((row) => [row.id, row]));
    fields.set(start.id, start);
    const changed: { table: TableRow; fieldId: Id<'fld'> }[] = [];
    const retyped: Id<'fld'>[] = [];
    for (const id of order) {
      const row = fields.get(id);
      const table = rows.tables.find((item) => item.id === row?.table_id);
      if (row === undefined || table === undefined || row.compute_state === 'error') continue;
      const current: BaseSchemaRows = { ...rows, fields: [...fields.values()] };
      const analysis = analysisOfField(row, current);
      if (analysis?.result_type == null) continue;
      const sameType = sameJson(row.result_type, analysis.result_type);
      const sameMode = row.compute_mode === analysis.compute_mode;
      let next: FieldRow | undefined;
      if (sameType && sameMode) {
        if (mode === 'follow') continue;
        // Virtual: nothing stored, clients refresh (`schema.changed`).
        next =
          row.compute_mode === 'stored'
            ? await this.fields.update(txScope, row.id, {
                computeState: 'backfilling',
                computeError: null,
              })
            : row;
      } else {
        next = await this.followResultType(
          tx,
          scope,
          table,
          row,
          {
            resultType: analysis.result_type,
            computeMode: analysis.compute_mode,
          },
          context,
        );
        if (next?.compute_mode === 'stored') retyped.push(next.id);
      }
      if (next !== undefined) {
        fields.set(next.id, next);
        changed.push({ table, fieldId: next.id });
      }
    }
    return { changed, retyped };
  }

  /**
   * A computed field whose analysis now has another result type or mode
   * (T456): a new column (or none, `virtual`) like a definition change,
   * `backfilling` when stored; audit `field.updated`. Takes the schema lock
   * of its table (re-entrant when already held).
   */
  private async followResultType(
    tx: Tx,
    scope: OrgScope,
    table: TableRow,
    row: FieldRow,
    target: Pick<PreparedComputedDefinition, 'resultType' | 'computeMode'>,
    context: AuditContext,
  ): Promise<FieldRow | undefined> {
    await this.lock(tx, table.id);
    const column = await this.computedColumn(
      tx,
      table,
      row.db_column_name,
      row.result_type,
      target,
    );
    const next = await this.fields.update(withTxScope(scope, tx), row.id, {
      computeMode: target.computeMode,
      resultType: target.resultType,
      computeState: target.computeMode === 'stored' ? 'backfilling' : 'ready',
      computeError: null,
      dbColumnName: column,
    });
    if (next !== undefined) {
      await this.record(tx, context, {
        type: 'field.updated',
        table,
        entityType: 'field',
        entityId: row.id,
        before: { compute_mode: row.compute_mode, result_type: row.result_type },
        after: { compute_mode: next.compute_mode, result_type: next.result_type },
      });
    }
    return next;
  }

  // -------------------------------------------------------------------------
  // Field-level errors of computed fields (BACKLOG T460, SPEC §9.4)

  /**
   * After a type conversion of a plain field (or its revert), in its
   * transaction: the computed fields reading it follow a new result type
   * (new column, backfilled), those that no longer typecheck become
   * `INVALID_CONFIG`, those that typecheck again heal.
   */
  private async followConvertedField(
    tx: Tx,
    scope: OrgScope,
    table: TableRow,
    fieldId: Id<'fld'>,
    context: AuditContext,
    options: { readonly backfill?: readonly Id<'fld'>[] } = {},
  ): Promise<void> {
    const txScope = withTxScope(scope, tx);
    if ((await this.fields.countComputedInBase(txScope, table.base_id)) === 0) return;
    await this.lockComputedGraph(tx, table.base_id);
    const start = await this.fields.getById(txScope, fieldId);
    if (start === undefined) return;
    const rows = await loadBaseSchemaRows(this.db, txScope, table.base_id);
    const edges = await this.dependencies.listByBase(txScope, table.base_id);
    const { changed, retyped } = await this.cascadeComputed(
      tx,
      scope,
      rows,
      start,
      edges,
      context,
      'follow',
    );
    if (changed.length > 0) {
      const published = changed.map((item) => fieldUpdatedChange(item.table, item.fieldId));
      afterCommit(tx, () => this.publishCommitted(published));
    }
    await this.reconcileComputedErrors(tx, scope, table.base_id, context, {
      causes: [fieldId],
      backfill: [...retyped, ...(options.backfill ?? [])],
    });
  }

  /**
   * Brings `compute_error` of every active formula/lookup field of the base
   * in line with the meta, in the transaction of the schema change that
   * caused it (`desiredFieldErrors`: `REF`, `CIRCLE`, `INVALID_CONFIG`,
   * `TIMEOUT` kept, indirect `REF`). A field entering an error, or changing
   * it, gets `compute_state = error`; a field whose error is gone heals:
   * `backfilling` (stored; the `computed.backfill` job computes it and the
   * stored fields reading it) or `ready` (virtual). `backfill`: fields to
   * compute again even without an error change (a restored field, the
   * fields of a restored table); `covered`: fields whose backfill job was
   * already queued in this transaction (their readers need no job of their
   * own). Each error change: audit + event `field.updated`
   * (`before/after.compute_error`) and, after commit, `schema.changed`
   * field `updated`.
   */
  private async reconcileComputedErrors(
    tx: Tx,
    scope: OrgScope,
    baseId: Id<'bse'>,
    context: AuditContext,
    options: {
      readonly causes?: readonly string[];
      readonly backfill?: readonly string[];
      readonly covered?: readonly string[];
    } = {},
  ): Promise<void> {
    const txScope = withTxScope(scope, tx);
    if ((await this.fields.countComputedInBase(txScope, baseId)) === 0) return;
    await this.lockComputedGraph(tx, baseId);
    const state = await loadFieldErrorsState(this.db, txScope, baseId);
    const desired = fieldErrorsOf(state, new Set(options.causes ?? []));
    const tables = new Map<string, TableRow>(state.rows.tables.map((table) => [table.id, table]));
    const forced = new Set(options.backfill ?? []);
    const toBackfill: FieldRow[] = [];
    const changes: SchemaChange[] = [];
    const changedOf = fieldUpdatedChange;
    for (const field of state.rows.fields) {
      const table = tables.get(field.table_id);
      if (!isComputedRow(field) || table === undefined) continue;
      const want = desired.get(field.id) ?? null;
      const current = fieldErrorOf(field.compute_error);
      const inError = field.compute_state === 'error';
      if (want !== null) {
        if (inError && sameFieldError(current, want)) continue;
        await this.fields.update(txScope, field.id, {
          computeState: 'error',
          computeError: fieldErrorJson(want),
        });
        await this.recordComputeError(tx, context, table, field.id, current, want);
        changes.push(changedOf(table, field.id));
        continue;
      }
      if (!inError && current === null && !forced.has(field.id)) continue;
      // Healed (or asked for): a result type that moved gets its column first.
      let row = field;
      const analysis = analysisOfField(field, state.rows);
      if (
        analysis?.result_type != null &&
        (!sameJson(field.result_type, analysis.result_type) ||
          field.compute_mode !== analysis.compute_mode)
      ) {
        row =
          (await this.followResultType(
            tx,
            scope,
            table,
            field,
            { resultType: analysis.result_type, computeMode: analysis.compute_mode },
            context,
          )) ?? field;
      }
      const stored = row.compute_mode === 'stored';
      const nextState = stored ? 'backfilling' : 'ready';
      if (row.compute_state !== nextState || row.compute_error !== null) {
        await this.fields.update(txScope, field.id, {
          computeState: nextState,
          computeError: null,
        });
      }
      if (current !== null) {
        await this.recordComputeError(tx, context, table, field.id, current, null);
      }
      if (field.compute_state !== nextState || current !== null) {
        changes.push(changedOf(table, field.id));
      }
      if (stored) toBackfill.push(row);
    }
    // One job per field no other job computes (a backfill job computes the
    // stored fields reading its field after it, T456).
    const active = new Set<string>(state.rows.fields.filter(isComputedRow).map((f) => f.id));
    const covered = new Set(options.covered ?? []);
    const reached = new Set<string>();
    for (const id of [...covered, ...toBackfill.map((field) => field.id)]) {
      for (const reader of dependentsInOrder(id, state.edges, active).slice(1)) {
        if (reader !== id) reached.add(reader);
      }
    }
    for (const field of toBackfill) {
      if (covered.has(field.id) || reached.has(field.id)) continue;
      await this.enqueueComputedBackfill(tx, field, context);
    }
    if (changes.length > 0) afterCommit(tx, () => this.publishCommitted(changes));
  }

  /** Audit + event `field.updated` of a change of `compute_error` (T460). */
  private async recordComputeError(
    tx: Tx,
    context: AuditContext,
    table: TableRow,
    fieldId: Id<'fld'>,
    before: FieldError | null,
    after: FieldError | null,
  ): Promise<void> {
    await this.record(tx, context, {
      type: 'field.updated',
      table,
      entityType: 'field',
      entityId: fieldId,
      before: { compute_error: fieldErrorJson(before) },
      after: { compute_error: fieldErrorJson(after) },
    });
  }

  /**
   * The column a computed field needs (T456): `null` for `virtual` (a
   * current column is dropped); for `stored`, the current one when the
   * PostgreSQL type stays, else a new one (1 slot, ADR-20; the old one is
   * dropped — slots of dropped columns stay used until compaction).
   */
  private async computedColumn(
    tx: Tx,
    table: TableRow,
    currentColumn: string | null,
    currentType: JsonValue | null,
    target: Pick<PreparedComputedDefinition, 'resultType' | 'computeMode'>,
  ): Promise<string | null> {
    if (target.computeMode === 'virtual') {
      if (currentColumn !== null) {
        await this.execute(tx, [dropComputedColumnSql(table.db_table_name, currentColumn)]);
      }
      return null;
    }
    const wanted = computedColumnType(target.resultType, table.collation);
    if (currentColumn !== null && currentType !== null) {
      let existing: string | null;
      try {
        existing = computedColumnType(currentType, table.collation);
      } catch {
        existing = null;
      }
      if (existing === wanted) return currentColumn;
    }
    const plan = planComputedColumn(fieldColumnName(), target.resultType, table.collation);
    await this.reserveSlots(tx, table, 1);
    await this.execute(tx, [
      addColumnSql(table.db_table_name, plan),
      ...(currentColumn === null
        ? []
        : [dropComputedColumnSql(table.db_table_name, currentColumn)]),
    ]);
    return plan.column;
  }

  /**
   * Queues `computed.backfill` (queue `schema:<tableId>`) with its
   * `meta.jobs` row (`created_by` = the user who saved the definition).
   */
  private async enqueueComputedBackfill(
    tx: Tx,
    field: FieldRow,
    context: AuditContext,
  ): Promise<Id<'job'>> {
    const job = await this.jobs.create(orgScope(field.organization_id, tx), {
      type: COMPUTED_BACKFILL_JOB_TYPE,
      createdBy:
        context.actor.type === 'user' && isId('usr', context.actor.id) ? context.actor.id : null,
    });
    await enqueue(
      tx,
      'computed.backfill',
      {
        organization_id: field.organization_id,
        table_id: field.table_id,
        field_id: field.id,
        job_id: job.id,
        fingerprint: computedFingerprint(field),
      },
      { queueName: `schema:${field.table_id}`, maxAttempts: 5 },
    );
    return job.id;
  }

  /** Serialises changes of the computed-field graph of a base (cycle checks see every edge). */
  private async lockComputedGraph(tx: Tx, baseId: Id<'bse'>): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`computed-graph:${baseId}`}, 0))`.execute(
      tx,
    );
  }

  /** `422 FORMULA_LIMIT_EXCEEDED` (`MAX_COMPUTED_FIELDS`) past the per-base limit (SPEC §9.5). */
  private async assertComputedCapacity(scope: OrgScope, baseId: Id<'bse'>): Promise<void> {
    const count = await this.fields.countComputedInBase(scope, baseId);
    if (count >= this.maxComputed) {
      throw new AppError('FORMULA_LIMIT_EXCEEDED', {
        detail: `A base can have at most ${String(this.maxComputed)} formula and lookup fields.`,
        errors: [
          {
            path: 'type',
            code: 'MAX_COMPUTED_FIELDS',
            message: `A base can have at most ${String(this.maxComputed)} formula and lookup fields`,
            params: { limit: this.maxComputed, position: { start: 0, length: 0 } },
          },
        ],
      });
    }
  }

  /**
   * The values of `fieldIds` (fields of `table`) changed on every record:
   * the computed fields reading them are recomputed by the
   * `computed.recompute` job (T458, `ComputedRecomputeService`), in `tx`;
   * those becoming `recomputing` get `schema.changed` after commit.
   */
  private async recomputeReaders(
    tx: Tx,
    table: TableRow,
    fieldIds: readonly Id<'fld'>[],
  ): Promise<void> {
    if (fieldIds.length === 0) return;
    const result = await this.recompute.enqueue(tx, {
      organizationId: table.organization_id,
      changes: [{ kind: 'fields', baseId: table.base_id, tableId: table.id, fieldIds }],
    });
    const changes = result.stateChanged.map((item): SchemaChange => ({
      organization_id: table.organization_id,
      base_id: item.baseId,
      table_id: item.tableId,
      entity: 'field',
      entity_id: item.fieldId,
      action: 'updated',
    }));
    if (changes.length > 0) afterCommit(tx, () => this.publishCommitted(changes));
  }

  /**
   * End of the backfill of one computed field (worker, T456): `ready`, or
   * `error` with `TIMEOUT` when a batch exceeded its statement timeout
   * (SPEC §9.5; audit `field.updated` with `compute_error`). Only a field
   * still `backfilling` changes; `schema.changed` (field `updated`) tells
   * clients to refresh. Returns whether it changed.
   */
  async finishComputedBackfill(
    scope: OrgScope,
    fieldId: Id<'fld'>,
    outcome: { readonly status: 'ready' } | { readonly status: 'error'; readonly code: 'TIMEOUT' },
  ): Promise<boolean> {
    this.assertScope(scope);
    const result = await this.withFieldLock(
      scope,
      fieldId,
      async (tx, table, field) => {
        if (!isComputedRow(field) || field.compute_state !== 'backfilling') {
          return { table, changed: false };
        }
        const txScope = withTxScope(scope, tx);
        if (outcome.status === 'ready') {
          await this.fields.update(txScope, fieldId, { computeState: 'ready', computeError: null });
          return { table, changed: true };
        }
        const error = { code: outcome.code, refs: [] };
        await this.fields.update(txScope, fieldId, { computeState: 'error', computeError: error });
        await this.record(tx, systemContext(), {
          type: 'field.updated',
          table,
          entityType: 'field',
          entityId: fieldId,
          before: { compute_error: field.compute_error },
          after: { compute_error: error },
        });
        // T460: the fields reading it are `REF` (indirect) meanwhile.
        await this.reconcileComputedErrors(tx, scope, table.base_id, systemContext());
        return { table, changed: true };
      },
      { allowCompacting: true },
    );
    if (result.changed) await this.publish(result.table, 'field', fieldId, 'updated');
    return result.changed;
  }

  /**
   * A batch of `computed.recompute` exceeded its statement timeout (SPEC
   * §9.5, BACKLOG T460): the field is `error` / `TIMEOUT` (its cells read
   * empty) and its queued rows are dropped; the fields reading it are `REF`
   * meanwhile. Saving its definition again computes it again. Only a field
   * `ready` or `recomputing` changes; returns whether it changed.
   */
  async markComputedTimeout(scope: OrgScope, fieldId: Id<'fld'>): Promise<boolean> {
    this.assertScope(scope);
    const result = await this.withFieldLock(
      scope,
      fieldId,
      async (tx, table, field) => {
        if (
          !isComputedRow(field) ||
          (field.compute_state !== 'ready' && field.compute_state !== 'recomputing')
        ) {
          return { table, changed: false };
        }
        const txScope = withTxScope(scope, tx);
        const error: FieldError = { code: 'TIMEOUT', refs: [] };
        await this.fields.update(txScope, fieldId, {
          computeState: 'error',
          computeError: fieldErrorJson(error),
        });
        await new ComputedRecomputeQueueRepository(this.db).clear(txScope, fieldId);
        await this.recordComputeError(
          tx,
          systemContext(),
          table,
          fieldId,
          fieldErrorOf(field.compute_error),
          error,
        );
        await this.reconcileComputedErrors(tx, scope, table.base_id, systemContext());
        return { table, changed: true };
      },
      { allowCompacting: true },
    );
    if (result.changed) await this.publish(result.table, 'field', fieldId, 'updated');
    return result.changed;
  }

  /**
   * The btree index the time scanner reads a date column by range with
   * (BACKLOG T508, SPEC §11.2: `record.date_reached`, shared with the S5b
   * date reminders): `<table>_<column>_due` on the column of a `datetime`
   * field or a stored formula/lookup of a date type, partial on live rows
   * (`__deleted_at IS NULL`, what every read filters). Created on demand by
   * the scanner, once per column; an index of that name left on another
   * column (a type conversion renamed the old one) is replaced. `created_at`
   * reads `__created_at`, indexed with every table. Returns what happened;
   * a field gone or of another type is `not_applicable`. Plain `CREATE
   * INDEX` under the table's schema lock (writes wait while it builds).
   */
  async ensureDueIndex(
    scope: OrgScope,
    fieldId: Id<'fld'>,
  ): Promise<'exists' | 'created' | 'not_applicable'> {
    this.assertScope(scope);
    return this.withFieldLock(
      scope,
      fieldId,
      async (tx, table, field) => {
        if (field.type === 'created_at' || dueValueKindOf(field) === null) {
          return 'not_applicable';
        }
        if (field.db_column_name === null) return 'not_applicable';
        const column = assertFieldColumnName(field.db_column_name);
        const name = indexName(table.db_table_name, `${column}${DUE_INDEX_SUFFIX}`);
        const { rows } = await sql<{ column_name: string }>`
          SELECT a.attname AS column_name
            FROM pg_index AS i
            JOIN pg_class AS c ON c.oid = i.indexrelid
            JOIN pg_namespace AS n ON n.oid = c.relnamespace
            JOIN pg_attribute AS a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
           WHERE n.nspname = ${DATA_SCHEMA} AND c.relname = ${name}
        `.execute(tx);
        const existing = rows[0];
        if (existing?.column_name === column) return 'exists';
        if (existing !== undefined) {
          await sql`DROP INDEX ${sql.id(DATA_SCHEMA, name)}`.execute(tx);
        }
        await createDueIndexSql(table.db_table_name, column).execute(tx);
        return 'created';
      },
      { timeoutMs: COMPACTION_STATEMENT_TIMEOUT_MS },
    );
  }

  /**
   * `ANALYZE data.<table>` after a job wrote many computed values (BACKLOG
   * S4b conventions: ≥ 10 000 rows), so the planner sees their statistics.
   */
  async analyzeComputedTable(scope: OrgScope, tableId: Id<'tbl'>): Promise<void> {
    this.assertScope(scope);
    const table = await this.tables.getById(scope, tableId);
    if (table === undefined) return;
    await this.db.withTx((tx) => this.execute(tx, [analyzeTableSql(table.db_table_name)]), {
      timeoutMs: COMPACTION_STATEMENT_TIMEOUT_MS,
    });
  }

  // -------------------------------------------------------------------------
  // Internals

  private assertScope(scope: OrgScope): void {
    if (!isOrgScope(scope))
      throw new TypeError('SchemaService: an OrgScope from orgScope() is required');
    if (scope.tx !== undefined) {
      throw new TypeError('SchemaService runs its own transactions; pass a scope without tx');
    }
  }

  private tableRef(table: string): RawBuilder<unknown> {
    return sql.id(DATA_SCHEMA, assertDataTableName(table));
  }

  private junctionRef(table: string): RawBuilder<unknown> {
    return sql.id(DATA_SCHEMA, assertJunctionTableName(table));
  }

  private async execute(tx: Tx, statements: readonly RawBuilder<unknown>[]): Promise<void> {
    for (const statement of statements) await statement.execute(tx);
  }

  /** `SET LOCAL lock_timeout` + the table's transaction advisory lock. */
  private async lock(tx: Tx, tableId: Id<'tbl'>): Promise<void> {
    await sql`SELECT set_config('lock_timeout', ${`${String(this.lockTimeoutMs)}ms`}, true)`.execute(
      tx,
    );
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${schemaLockKey(tableId)}, 0))`.execute(
      tx,
    );
  }

  /**
   * Runs `attempt` again after a lock timeout, serialization failure or
   * deadlock (with jitter), at most `maxAttempts` times; then `409
   * SCHEMA_LOCKED`. Meta unique violations become `NAME_CONFLICT`, data
   * unique violations `UNIQUE_VIOLATION`.
   */
  private async retrying<T>(tableId: Id<'tbl'>, attempt: () => Promise<T>): Promise<T> {
    for (let n = 1; ; n += 1) {
      try {
        return await attempt();
      } catch (error) {
        if (!isRetryableDdlError(error)) throw translateDbError(error);
        if (n >= this.maxAttempts) {
          throw new AppError('SCHEMA_LOCKED', {
            detail: 'The table schema is busy; try again.',
            params: { table_id: tableId, attempts: n, sqlstate: sqlStateOf(error) },
            cause: error,
          });
        }
        await this.sleep(ddlRetryDelayMs(n, this.random));
      }
    }
  }

  private withTableLock<T>(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    fn: (tx: Tx, table: TableRow) => Promise<T>,
    options: LockOptions = {},
  ): Promise<T> {
    return this.retrying(tableId, () =>
      this.db.withTx(
        async (tx) => {
          await this.lock(tx, tableId);
          const table = await this.tables.getById(withTxScope(scope, tx), tableId, {
            includeDeleted: options.includeDeleted === true,
          });
          if (table === undefined) throw notFound('table');
          if (table.schema_state === 'compacting' && options.allowCompacting !== true) {
            throw new AppError('SCHEMA_LOCKED', {
              detail: 'The table is being compacted; try again in a few minutes.',
              params: { table_id: tableId, schema_state: table.schema_state },
            });
          }
          return fn(tx, table);
        },
        options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
      ),
    );
  }

  private async withFieldLock<T>(
    scope: OrgScope,
    fieldId: Id<'fld'>,
    fn: (tx: Tx, table: TableRow, field: FieldRow) => Promise<T>,
    options: LockOptions & { readonly includeDeletedField?: boolean } = {},
  ): Promise<T> {
    const includeDeleted = options.includeDeletedField === true;
    const located = await this.fields.getById(scope, fieldId, { includeDeleted });
    if (located === undefined) throw notFound('field');
    return this.withTableLock(
      scope,
      located.table_id,
      async (tx, table) => {
        // Re-read under the lock: the field may have changed meanwhile.
        const field = await this.fields.getById(withTxScope(scope, tx), fieldId, {
          includeDeleted,
        });
        if (field === undefined) throw notFound('field');
        return fn(tx, table, field);
      },
      options,
    );
  }

  private async assertFieldCapacity(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    adding = 1,
  ): Promise<void> {
    const active = await this.fields.countActive(scope, tableId);
    if (active + adding > this.maxFields) {
      throw new AppError('FIELD_LIMIT_EXCEEDED', {
        detail: `A table can have at most ${String(this.maxFields)} fields.`,
        errors: [
          {
            path: 'fields',
            code: 'FIELD_LIMIT_EXCEEDED',
            message: `A table can have at most ${String(this.maxFields)} fields`,
            params: { limit: this.maxFields },
          },
        ],
        params: { limit: this.maxFields, active },
      });
    }
  }

  /** ADR-20 budget check before a DDL consuming `consumed` slots. */
  private async reserveSlots(tx: Tx, table: TableRow, consumed: number): Promise<void> {
    const used = await usedColumnSlots(tx, table.db_table_name);
    const decision = slotDecision(used, consumed, this.thresholds);
    if (decision === 'locked') throw new SlotBudgetExhausted(used);
    if (decision === 'compact') await this.enqueueCompaction(tx, table.organization_id, table.id);
  }

  private async enqueueCompaction(tx: Tx, organizationId: Id<'org'>, tableId: Id<'tbl'>) {
    await enqueue(
      tx,
      'schema.compact_table',
      { organization_id: organizationId, table_id: tableId },
      {
        queueName: `schema:${tableId}`,
        jobKey: `schema.compact_table:${tableId}`,
        jobKeyMode: 'preserve_run_at',
        maxAttempts: 5,
      },
    );
  }

  /** Serialises changes of the table order of a base (create, restore, reorder). */
  private async lockTableOrder(tx: Tx, baseId: Id<'bse'>): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${tableOrderLockKey(baseId)}, 0))`.execute(
      tx,
    );
  }

  /**
   * Queues `schema.remove_select_options` with its `meta.jobs` row, so the
   * caller can follow it with `GET /jobs/:id` (`created_by` = the user who
   * removed the options). The job id is also the `batch_id` of the record
   * changes it makes (ADR-23).
   */
  private async enqueueOptionRemoval(
    tx: Tx,
    field: FieldRow,
    optionIds: readonly Id<'opt'>[],
    context: AuditContext,
  ): Promise<Id<'job'>> {
    const job = await this.jobs.create(orgScope(field.organization_id, tx), {
      type: REMOVE_SELECT_OPTIONS_JOB_TYPE,
      createdBy:
        context.actor.type === 'user' && isId('usr', context.actor.id) ? context.actor.id : null,
    });
    await enqueue(
      tx,
      'schema.remove_select_options',
      {
        organization_id: field.organization_id,
        table_id: field.table_id,
        field_id: field.id,
        option_ids: [...optionIds],
        batch_id: job.id,
      },
      { queueName: `schema:${field.table_id}`, maxAttempts: 5 },
    );
    return job.id;
  }

  /** Hands a committed change to the publisher; failures never reach the caller. */
  private async publish(
    table: TableRow,
    entity: SchemaChange['entity'],
    entityId: Id<'tbl'> | Id<'fld'>,
    action: SchemaChangeAction,
  ): Promise<void> {
    await this.publishCommitted([schemaChangeOf(table, entity, entityId, action)]);
  }

  private async enqueueAutoNumberRecompute(tx: Tx, field: FieldRow): Promise<void> {
    await enqueue(
      tx,
      'schema.recompute_auto_number',
      { organization_id: field.organization_id, table_id: field.table_id, field_id: field.id },
      {
        queueName: `schema:${field.table_id}`,
        jobKey: `schema.recompute_auto_number:${field.id}`,
        maxAttempts: 5,
      },
    );
  }

  /** Adds/drops the single-value CHECK and the unique index between two plans of a column. */
  private async alterConstraints(
    tx: Tx,
    table: string,
    before: ColumnPlan,
    after: ColumnPlan,
  ): Promise<void> {
    if (before.singleValue && !after.singleValue) {
      await dropSingleValueCheckSql(table, before.column).execute(tx);
    }
    const beforeNames = new Set(before.indexes.map((index) => index.name));
    const afterNames = new Set(after.indexes.map((index) => index.name));
    for (const index of before.indexes) {
      if (!afterNames.has(index.name)) await dropIndexSql(index).execute(tx);
    }
    for (const index of after.indexes) {
      if (!beforeNames.has(index.name)) {
        await createIndexSql(table, after.column, index).execute(tx);
      }
    }
  }

  /** The base collation after checking it names a collation of this database. */
  private async baseCollation(tx: Tx, settings: JsonValue): Promise<string> {
    const configured =
      typeof settings === 'object' && settings !== null && !Array.isArray(settings)
        ? settings.collation
        : undefined;
    const collation = typeof configured === 'string' ? configured : DEFAULT_COLLATION;
    let valid = true;
    try {
      collateClause({ collation });
    } catch {
      valid = false;
    }
    if (!valid || !(await collationExists(tx, collation))) {
      throw validationFailed(
        [
          {
            path: 'settings.collation',
            code: 'UNKNOWN_COLLATION',
            message: 'The base collation does not exist in this database',
            params: { collation },
          },
        ],
        'The base collation is not available.',
      );
    }
    return collation;
  }

  /** `emit` + audit entry of one schema change, on the same transaction. */
  private async record(
    tx: Tx,
    context: AuditContext,
    change: {
      readonly type:
        | 'table.created'
        | 'table.updated'
        | 'table.deleted'
        | 'table.restored'
        | 'table.purged'
        | 'field.created'
        | 'field.updated'
        | 'field.deleted'
        | 'field.restored'
        | 'field.converted'
        | 'view.created';
      readonly table: TableRow;
      readonly entityType: 'table' | 'field' | 'view';
      readonly entityId: string;
      readonly before: JsonObject | null;
      readonly after: JsonObject | null;
      /** Background job started by the change (`GET /jobs/:id`). */
      readonly jobId?: Id<'job'>;
      /** More event data (`field.converted`: status, counts; CONTRACTS §8). */
      readonly data?: JsonObject;
    },
  ): Promise<void> {
    const data: JsonObject = { ...(change.data ?? {}) };
    if (change.before !== null) data.before = change.before;
    if (change.after !== null) data.after = change.after;
    if (change.jobId !== undefined) data.job_id = change.jobId;
    await emit(tx, {
      type: change.type,
      organizationId: change.table.organization_id,
      entityType: change.entityType,
      entityId: change.entityId,
      actor: context.actor,
      baseId: change.table.base_id,
      tableId: change.table.id,
      data,
    });
    await this.audit.write(tx, {
      action: change.type,
      organizationId: change.table.organization_id,
      baseId: change.table.base_id,
      tableId: change.table.id,
      entityType: change.entityType,
      entityId: change.entityId,
      before: change.before,
      after: change.after,
      context,
    });
  }
}

/** A computed definition change made inside `updateField` (T456). */
interface ComputedChange {
  readonly field: FieldRow;
  /** The `computed.backfill` job queued (stored fields). */
  readonly jobId: Id<'job'> | undefined;
  /** Computed fields reading this one whose meta changed (`schema.changed` after commit). */
  readonly dependents: readonly { readonly table: TableRow; readonly fieldId: Id<'fld'> }[];
}

/** `schema.changed` field `updated` of a field of `table`. */
function fieldUpdatedChange(table: TableRow, fieldId: Id<'fld'>): SchemaChange {
  return schemaChangeOf(table, 'field', fieldId, 'updated');
}

function isRecordValue(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Formula/lookup fields are never unique nor required (their values are computed). */
function assertComputedConstraints(
  type: string,
  uniqueValues: boolean | undefined,
  required: boolean | undefined,
): void {
  const errors: ProblemErrorItem[] = [];
  if (uniqueValues === true) {
    errors.push({
      path: 'unique_values',
      code: 'UNIQUE_NOT_SUPPORTED',
      message: `Field type ${type} cannot require unique values`,
      params: { type },
    });
  }
  if (required === true) {
    errors.push({
      path: 'required',
      code: 'REQUIRED_NOT_SUPPORTED',
      message: `Field type ${type} cannot be required: its values are computed`,
      params: { type },
    });
  }
  if (errors.length > 0) throw validationFailed(errors);
}

/** How the `style` of a request applies (T456): given, kept from `current`, or the default. */
function styleModeOf(options: unknown, current: unknown): ComputedDefinitionInput['style'] {
  if (isRecordValue(options) && Object.hasOwn(options, 'style')) return { mode: 'given' };
  return current === undefined || current === null
    ? { mode: 'default' }
    : { mode: 'keep', value: current };
}

function computedContextOf(
  rows: BaseSchemaRows,
  tableId: Id<'tbl'>,
  computed: ComputedFieldContext | undefined,
): Parameters<typeof prepareComputedDefinition>[1] {
  return {
    rows,
    tableId,
    timeZone: computed?.timeZone ?? 'UTC',
    ...(computed?.readable === undefined ? {} : { readable: computed.readable }),
  };
}

/** Audit context of work the system does on its own (a job outcome). */
function systemContext(): AuditContext {
  return {
    actor: { type: 'system', id: null },
    via: null,
    batch_id: null,
    request_id: null,
    ip: null,
    user_agent: null,
  };
}

/** A schema change of the other side of a link, published after commit (T404). */
interface PartnerPublish {
  readonly table: TableRow;
  readonly fieldId: Id<'fld'>;
  readonly action: SchemaChangeAction;
}

/** `options` of a stored conversion definition (link conversions keep link options). */
function definitionOptionsOf(json: JsonValue): JsonValue {
  return typeof json === 'object' && json !== null && !Array.isArray(json)
    ? (json.options ?? {})
    : {};
}

/** The other side of a two-way link changed with a field (delete/restore). */
interface LinkPartner {
  readonly table: TableRow;
  readonly field: FieldRow;
}

/** `options.record_filter` + a filter issue path (`items[0].value`, `[0]`…). */
function prefixPath(path: string): string {
  return path.startsWith('[')
    ? `options.record_filter${path}`
    : joinPath('options.record_filter', path);
}

function schemaChangeOf(
  table: TableRow,
  entity: SchemaChange['entity'],
  entityId: Id<'tbl'> | Id<'fld'>,
  action: SchemaChangeAction,
): SchemaChange {
  return {
    organization_id: table.organization_id,
    base_id: table.base_id,
    table_id: table.id,
    entity,
    entity_id: entityId,
    action,
  };
}

function sameJson(a: JsonValue, b: JsonValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** `409 SCHEMA_LOCKED` for a field whose values are being converted (T403). */
export function fieldConvertingError(fieldId: Id<'fld'>, path = 'field_id'): AppError {
  return new AppError('SCHEMA_LOCKED', {
    detail: 'The values of this field are being converted to its new type; try again shortly.',
    errors: [
      {
        path,
        code: 'FIELD_CONVERTING',
        message: 'The field is being converted',
        params: { field_id: fieldId },
      },
    ],
    params: { field_id: fieldId },
  });
}

/** Conversion settings as stored in `meta.field_conversions.context`. */
function settingsJson(settings: ConversionSettings): JsonObject {
  const json: JsonObject = {};
  if (settings.match_existing_only !== undefined) {
    json.match_existing_only = settings.match_existing_only;
  }
  if (settings.truthy_values !== undefined) json.truthy_values = [...settings.truthy_values];
  if (settings.match_email !== undefined) json.match_email = settings.match_email;
  return json;
}

/** The latest conversion of a field when the revert may still undo it. */
function revertible(
  conversion: FieldConversionRow | undefined,
  now: number = Date.now(),
): FieldConversionRow | undefined {
  if (conversion === undefined) return undefined;
  if (conversion.status !== 'succeeded') return undefined;
  return conversion.expires_at.getTime() > now ? conversion : undefined;
}

/** Maps constraint violations raised by a schema transaction to catalogue errors. */
function translateDbError(error: unknown): unknown {
  if (error instanceof AppError) return error;
  const state = sqlStateOf(error);
  const constraint = (error as { constraint?: unknown } | null)?.constraint;
  if (state === '23505' && typeof constraint === 'string') {
    if (NAME_CONSTRAINTS.has(constraint)) {
      return new AppError('NAME_CONFLICT', {
        detail: 'The name is already used.',
        errors: [{ path: 'name', code: 'NAME_CONFLICT', message: 'The name is already used' }],
        cause: error,
      });
    }
    if (constraint.endsWith('_uniq')) {
      return new AppError('UNIQUE_VIOLATION', {
        detail: 'Existing records have duplicate values; unique values cannot be required.',
        errors: [
          {
            path: 'unique_values',
            code: 'UNIQUE_VIOLATION',
            message: 'Existing records have duplicate values',
          },
        ],
        cause: error,
      });
    }
  }
  if (state === '23505' && sqlIndexName(error)?.endsWith('_uniq') === true) {
    return new AppError('UNIQUE_VIOLATION', {
      detail: 'Existing records have duplicate values; unique values cannot be required.',
      cause: error,
    });
  }
  if (isIndexRowTooLarge(error)) {
    // The unique index of a field (B-tree, SPEC §5.4) cannot hold a value this long.
    return new AppError('VALIDATION_FAILED', {
      detail: 'Existing records have values too long for unique values.',
      errors: [
        {
          path: 'unique_values',
          code: 'UNIQUE_VALUE_TOO_LONG',
          message: 'Existing records have values too long for unique values',
        },
      ],
      cause: error,
    });
  }
  return error;
}

/** `CREATE UNIQUE INDEX` failures name the index in `detail`/`message` rather than `constraint`. */
function sqlIndexName(error: unknown): string | undefined {
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message !== 'string') return undefined;
  return /could not create unique index "([^"]+)"/.exec(message)?.[1];
}

/** Dependency edges of a field as a conversion keeps them (T463). */
function edgesJson(edges: readonly FieldDependencyEdge[]): JsonValue {
  return edges.map((edge) => ({
    depends_on: edge.dependsOnFieldId,
    kind: edge.kind,
    paths: edge.paths.map((path) => ({
      kind: path.kind,
      link_path: [...path.link_path],
      condition_refs: [...path.condition_refs],
    })),
  }));
}

const DEPENDENCY_KINDS: ReadonlySet<string> = new Set(['same_row', 'via_link', 'cross_table']);

/** The edges kept by {@link edgesJson}, read back for `fieldId` (malformed entries skipped). */
function edgesFromJson(fieldId: Id<'fld'>, json: JsonValue): FieldDependencyEdge[] {
  if (!Array.isArray(json)) return [];
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  return json.flatMap((item): FieldDependencyEdge[] => {
    if (!isRecordValue(item)) return [];
    const dependsOn = item['depends_on'];
    const kind = item['kind'];
    if (!isId('fld', dependsOn) || typeof kind !== 'string' || !DEPENDENCY_KINDS.has(kind)) {
      return [];
    }
    const paths = (Array.isArray(item['paths']) ? (item['paths'] as unknown[]) : []).flatMap(
      (path) =>
        isRecordValue(path) &&
        typeof path['kind'] === 'string' &&
        DEPENDENCY_KINDS.has(path['kind'])
          ? [
              {
                kind: path['kind'] as FieldDependencyEdge['kind'],
                link_path: strings(path['link_path']),
                condition_refs: strings(path['condition_refs']),
              },
            ]
          : [],
    );
    return [
      { fieldId, dependsOnFieldId: dependsOn, kind: kind as FieldDependencyEdge['kind'], paths },
    ];
  });
}

/** A stored definition as audit entries show it (without the kept dependency edges). */
function auditDefinition(json: JsonValue): JsonObject {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return {};
  return Object.fromEntries(Object.entries(json).filter(([key]) => key !== 'dependencies'));
}

/** `422 CONVERSION_NOT_ALLOWED` (path `type`) of a conversion from or to a formula/lookup (T463). */
function computedConversionNotAllowed(detail: string, params: JsonObject): AppError {
  return new AppError('CONVERSION_NOT_ALLOWED', {
    detail,
    errors: [
      { path: 'type', code: 'CONVERSION_NOT_ALLOWED', message: detail.replace(/\.$/, ''), params },
    ],
  });
}
