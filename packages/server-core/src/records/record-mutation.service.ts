import { setTimeout as delay } from 'node:timers/promises';

import { isId, newId, type EventBatch, type Id, type ProblemErrorItem } from '@cellhive/contracts';
import {
  autoNumberOptionsSchema,
  FieldValueError,
  formatAutoNumber,
  isValidTimeZone,
  resolveDefaultValue,
  selectOptionSchema,
  selectOptionsSchema,
  type FieldConfig,
  type LocaleContext,
  type SelectOptions,
  type UserRef,
  type ValueIssue,
} from '@cellhive/field-types';
import {
  collectFieldIds,
  evaluate,
  type EvaluateRecord,
  type ResolveContext,
} from '@cellhive/filter-dsl';
import { sql, type RawBuilder, type SqlBool } from 'kysely';
import { z } from 'zod';

import { isAiField } from '../ai/generation/options.js';
import {
  auditContextSchema,
  type AuditContext,
  type AuditEntryInput,
} from '../audit/audit-entry.js';
import { AuditWriter } from '../audit/audit-writer.js';
import {
  runComputedBackfillBatch,
  type ComputedBackfillBatchInput,
  type ComputedBackfillBatchResult,
} from '../computed/backfill/backfill.js';
import {
  ComputedRecomputeService,
  type QueuedRecomputeBatch,
} from '../computed/recompute/recompute.service.js';
import {
  afterCommit,
  JOB_STATEMENT_TIMEOUT_MS,
  REQUEST_STATEMENT_TIMEOUT_MS,
  type Db,
  type Tx,
} from '../db/create-db.js';
import { sqlStateOf, SQLSTATE } from '../db/pg-errors.js';
import { OrganizationsRepository } from '../db/repositories/organizations.repository.js';
import { isOrgScope, withTxScope, type OrgScope } from '../db/repository.js';
import { AppError } from '../errors/app-error.js';
import { formatIssuePath, zodIssuesToProblemErrors } from '../errors/zod-issues.js';
import { EventWriter } from '../events/event-writer.js';
import { JobsRepository } from '../jobs/jobs.repository.js';
import { RecordFollowHooks } from '../notifications/follows/record-follow-hooks.js';
import { NotificationsRepository } from '../notifications/notifications.repository.js';
import { ComputedImages } from '../realtime/computed-values.js';
import { RealtimeRecordChangePublisher } from '../realtime/publishers.js';
import { reserveAutoValues } from '../schema/auto-number.js';
import { FieldConversionsRepository } from '../schema/field-conversions.repository.js';
import { FieldsRepository } from '../schema/fields.repository.js';
import { assertDataTableName, DATA_SCHEMA } from '../schema/names.js';
import { DDL_LOCK_TIMEOUT_MS, schemaLockKey } from '../schema/policy.js';
import { TablesRepository } from '../schema/tables.repository.js';

import { AttachmentCells, type AttachmentCellWrite } from './attachments/attachment-cells.js';
import {
  AttachmentsRepository,
  type FormUploadSession,
} from './attachments/attachments.repository.js';
import {
  CONVERSION_BACKFILL_BATCH_SIZE,
  runConversionBatch,
  type ConversionBatchResult,
} from './conversions/backfill.js';
import { mergeRevertEdits } from './conversions/revert-merge.js';
import { assertNotConverting } from './conversions/write-lock.js';
import { LinkFanout, type LinkFanoutKind } from './links/link-fanout.js';
import { filtersNameLinks, LinkFilterMeta, rulesOf } from './links/link-filters.js';
import { LinkImageReader } from './links/link-images.js';
import { accessibleTable, relatedAccessContext } from './links/link-targets.js';
import {
  LinkWriter,
  linkStored,
  type LinkCellChange,
  type LinkPlan,
  type PartnerChanges,
  type PreparedLinkCell,
} from './links/link-writer.js';
import { MemberDirectoryRepository } from './member-directory.repository.js';
import {
  deleteTrashedRows,
  purgeSummary,
  RECORD_PURGE_BATCH_SIZE,
  type PurgeReason,
} from './purge/record-purge.js';
import {
  type RecordChange,
  type RecordChangeField,
  type RecordChangeFanout,
  type RecordChangeLink,
  type RecordChangePublisher,
  type RecordChangeType,
  type StoredImage,
} from './record-change-publisher.js';
import { RecordQueryService } from './record-query.service.js';
import { RecordRuleFields } from './rule-fields.js';
import { sameStoredValue, storageToJson, storedValueToJson } from './storage-values.js';
import {
  buildTableModel,
  readable,
  resolveRule,
  ruleSql,
  toFieldModel,
  type FieldModel,
  type ResolvedRule,
  type TableModel,
} from './table-model.js';
import {
  assertTreeInvariants,
  liveChildrenOf,
  liveDescendantsOf,
  parentKeyOf,
  ParentWriter,
  trashedBranchOf,
  walkBranch,
  type PreparedParent,
} from './tree/parent-writer.js';

import type { LinkImageCells } from './links/link-images.js';
import type { LinkFieldModel } from './links/link-model.js';
import type {
  FieldKeyType,
  RecordAccessContext,
  RecordCreateRequest,
  RecordDeleteOutput,
  RecordIdsRequest,
  RecordMutationOutput,
  RecordUpdateRequest,
  RecordUpsertOutput,
  RecordUpsertRequest,
} from './types.js';
import type {
  ComputedBefore,
  ComputedChange,
  ComputedRecomputeResult,
  RecomputeSource,
} from '../computed/recompute/changes.js';
import type { FieldRow, JsonObject, JsonValue, TableRow } from '../db/schema.js';
import type { Actor, Causation, EventInput } from '../events/event.js';
import type { SchemaChange } from '../schema/schema-change-publisher.js';
import type { SchemaService } from '../schema/schema.service.js';
import type { TableAccess } from '@cellhive/permissions';

/** Most records one create/update/upsert/delete/restore call may touch (SPEC §7.3). */
export const MAX_RECORDS_PER_MUTATION = 1000;
/** Rows renumbered per transaction by `recomputeAutoNumber` (SPEC §5.5 backfill batches). */
export const AUTO_NUMBER_BATCH_SIZE = 5000;
/** Types allowed in upsert `merge_on` (CONTRACTS §1.4; select only when single). */
const MERGE_TYPES: ReadonlySet<string> = new Set(['text', 'number', 'select', 'auto_number']);
/** Alias of the data table in statements. Code constant, never input. */
const ALIAS = 't';

export interface RecordMutationServiceOptions {
  /**
   * Creates select options from typecast values in the mutation's
   * transaction, and publishes their `schema.changed` after commit.
   */
  readonly schema: Pick<SchemaService, 'addSelectOptionsInTx' | 'publishCommitted'>;
  /**
   * Reads results back; default: a `RecordQueryService` on the same `Db`
   * with the same `defaultTimeZone`.
   */
  readonly query?: RecordQueryService;
  /**
   * Realtime hook called after commit; default: the realtime bus attached
   * to the `Db` (`RealtimeRecordChangePublisher`), inactive without one.
   */
  readonly publisher?: RecordChangePublisher;
  /** Receives publisher failures (the mutation itself has committed). */
  readonly onPublishError?: (error: unknown) => void;
  /** Zone of `created_time` auto-number rules for organizations without `settings.timezone`. */
  readonly defaultTimeZone?: string;
  /** `statement_timeout` of a request mutation; default 10 s. */
  readonly statementTimeoutMs?: number;
  /** Wait for the table's schema lock before `409 SCHEMA_LOCKED`; default 3 s. */
  readonly lockTimeoutMs?: number;
  /** Clock of date variables in record rules (`today`…); tests pin it. */
  readonly now?: () => Date;
  /**
   * Incremental recompute of computed fields (T458), called in the write's
   * transaction; default: a `ComputedRecomputeService` on the same `Db`.
   */
  readonly recompute?: ComputedRecomputeService;
  /**
   * `AUTOMATION_MAX_RUNS_PER_BATCH` of the default recompute (events of
   * recomputed values past the fan-out cap, T509); default 1 000.
   */
  readonly automationMaxRunsPerBatch?: number;
}

/** Whole-transaction attempts of a write that hit a deadlock (`40P01`, SPEC §5.9). */
export const DEADLOCK_ATTEMPTS = 3;
/** Base pause before retrying a deadlocked write (grows with the attempt, plus jitter). */
const DEADLOCK_RETRY_BASE_MS = 50;

/** Options of one mutation call besides the request. */
export interface MutationOptions {
  /** Loop guard of automations (SPEC §11.6); user mutations leave it out (depth 0). */
  readonly causation?: Causation;
  /**
   * Runs last in the mutation's transaction, after its events and audit
   * entries (throwing rolls everything back): the automation engine marks
   * its step `succeeded` here, so the write and the step commit together
   * (SPEC §11.7 idempotency, BACKLOG T505).
   */
  readonly beforeCommit?: (tx: Tx) => Promise<void>;
}

/** Options of `update` besides the request. */
export interface UpdateOptions extends MutationOptions {
  /**
   * `false`: skip reading the records back (the result has `records: []`),
   * e.g. the 1 000-record batches of `update_records` (T506). Default `true`.
   */
  readonly readBack?: boolean;
}

/** One batch of `purgeExpired` (T408). */
export interface ExpiredPurgeResult {
  /** Records permanently deleted by this batch. */
  readonly purged: Id<'rec'>[];
  /** `true` once no record of the table is past the cutoff (the job moves on). */
  readonly done: boolean;
}

/** Options of `create` besides the request. */
export interface CreateOptions extends MutationOptions {
  /**
   * Runs in the mutation's transaction right after the rows are inserted
   * (before the events, audit entries and commit): form submissions record
   * who submitted, check per-person limits and write `form.submitted` here.
   * Throwing rolls everything back.
   */
  readonly onCreated?: (tx: Tx, ids: readonly Id<'rec'>[]) => Promise<void>;
  /** `false`: skip reading the records back (the result has `records: []`). Default `true`. */
  readonly readBack?: boolean;
  /**
   * Typecast values are cells of an imported file (CONTRACTS §19, T411): a
   * link cell given as a string is a title list, and a link or `parent`
   * title matching several records is `LINK_TARGET_AMBIGUOUS`. Imports only.
   */
  readonly importCells?: boolean;
  /**
   * A submission through a form link (T410): attachment cells bind only
   * uploads of this session (`POST /shares/:token/uploads`), never the
   * writer's other uploads nor copies of other records' files.
   */
  readonly formUpload?: FormUploadSession;
  /**
   * The person creating one record by hand follows it (CONTRACTS §22.5,
   * T543): asked for by the record API only. The follows hook still checks
   * the write (one record, a user acting directly, `auto_follow_created`).
   */
  readonly autoFollow?: boolean;
}

/** Records changed per transaction by `removeSelectOptionValues` (SPEC §5.5 batches). */
export const OPTION_REMOVAL_BATCH_SIZE = 5000;

export interface SelectOptionRemovalResult {
  /** Records whose cell lost at least one option. */
  readonly updated: number;
  /** `false` when the field no longer exists or is not a select field. */
  readonly fieldFound: boolean;
}

/** What {@link RecordMutationService.writeAiValues} did with each record. */
export interface AiValuesWrite {
  /** Values written (or already equal): their queue rows are done. */
  readonly written: Id<'rec'>[];
  /** The record changed since its prompt was rendered: generate again. */
  readonly stale: Id<'rec'>[];
  /** Gone or in the trash. */
  readonly missing: Id<'rec'>[];
  /** `false` when the field is gone or no longer an AI field. */
  readonly fieldFound: boolean;
}

export interface AutoNumberRecomputeResult {
  /** Rows visited (live and trashed). */
  readonly rows: number;
  /** Rows whose formatted value changed. */
  readonly updated: number;
  /** `false` when the field no longer exists or is not an `auto_number` field. */
  readonly fieldFound: boolean;
}

// ---------------------------------------------------------------------------
// Request guards. The HTTP layer (T108) validates the public contract with
// `@cellhive/contracts`; these protect callers inside the server.

const fieldKeyTypeSchema = z.enum(['name', 'id']).default('name');
const fieldsSchema = z.record(z.string(), z.unknown());
const writeOptionShape = {
  field_key_type: fieldKeyTypeSchema,
  typecast: z.boolean().default(false),
};
const parentIdSchema = z.string().nullable().optional();
const createSchema = z.object({
  ...writeOptionShape,
  records: z.array(z.object({ fields: fieldsSchema, parent_id: parentIdSchema })).min(1),
});
const updateSchema = z.object({
  ...writeOptionShape,
  records: z
    .array(
      z.object({
        id: z.string(),
        version: z.int().min(1).optional(),
        fields: fieldsSchema,
        parent_id: parentIdSchema,
      }),
    )
    .min(1),
});
const upsertSchema = z.object({
  ...writeOptionShape,
  merge_on: z.array(z.string().min(1)).min(1).max(3),
  records: z.array(z.object({ fields: fieldsSchema })).min(1),
});
const idsSchema = z.object({
  ids: z.array(z.string()).min(1),
  children: z.enum(['promote', 'delete']).default('promote'),
  branch: z.boolean().default(false),
});

function parseRequest<S extends z.ZodType>(schema: S, input: unknown, key: string): z.output<S> {
  const list = (input as Record<string, unknown> | null | undefined)?.[key];
  if (Array.isArray(list) && list.length > MAX_RECORDS_PER_MUTATION) {
    throw new AppError('PAYLOAD_TOO_LARGE', {
      detail: `At most ${String(MAX_RECORDS_PER_MUTATION)} records per request.`,
      errors: [
        {
          path: key,
          code: 'TOO_BIG',
          message: `At most ${String(MAX_RECORDS_PER_MUTATION)} records per request`,
          params: { maximum: MAX_RECORDS_PER_MUTATION },
        },
      ],
    });
  }
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', {
      detail: 'The record request is invalid.',
      errors: zodIssuesToProblemErrors(parsed.error.issues),
    });
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Errors

const tableNotFound = () => new AppError('NOT_FOUND', { detail: 'The table does not exist.' });

const cellPath = (index: number, key: string) => formatIssuePath(['records', index, 'fields', key]);

/** Restarts the mutation holding the schema lock exclusively (select options must be created). */
class NeedsExclusiveSchemaLock extends Error {
  constructor() {
    super('select options must be created: retry with the exclusive schema lock');
  }
}

// ---------------------------------------------------------------------------
// Internal shapes

/** One request record on its way to the database; `index` is its position in the request. */
interface WriteItem {
  readonly index: number;
  readonly fields: Readonly<Record<string, unknown>>;
  /** `parent_id` of the request record (sub-records, T405); `undefined`: not written. */
  readonly parentId?: string | null | undefined;
}

/** Storage-form values of the fields a record writes, by field id. */
type StoredCells = Map<Id<'fld'>, JsonValue>;

interface Session {
  readonly tx: Tx;
  readonly scope: OrgScope;
  readonly access: RecordAccessContext;
  readonly tableAccess: TableAccess;
  readonly audit: AuditContext;
  readonly causation: Causation | undefined;
  readonly exclusive: boolean;
  readonly keyType: FieldKeyType;
  readonly typecast: boolean;
  /** Typecast of import cells (`CreateOptions.importCells`). */
  readonly importCells: boolean;
  /** Uploads a form link submission may bind (`CreateOptions.formUpload`, T410). */
  readonly formUpload: FormUploadSession | undefined;
  /** Transaction time: `__created_at`/`__updated_at` and `record_created_time` defaults. */
  readonly now: Date;
  readonly resolve: ResolveContext;
  /** `__created_by`/`__updated_by`/`__deleted_by`. */
  readonly writer: Id<'usr'> | null;
  model: TableModel;
  /** Fields the caller can see, by request key. */
  byKey: Map<string, FieldModel>;
  /** Link fields the caller can see, by request key (T401; values in junctions). */
  linkByKey: Map<string, LinkFieldModel>;
  /** Request key of the `parent` field the caller can see (T405), else `null`. */
  parentKey: string | null;
  readRule: ResolvedRule;
  editRule: ResolvedRule;
  /**
   * The edit rule names a link field (T710): it is checked in SQL on the
   * rows as written, link cells included (`checkEditRuleAfterWrite`),
   * instead of in memory on the column values before the write.
   */
  editRuleAfterWrite: boolean;
  /** Fields of the base's record rules, when changes are published (else `null`). */
  readonly capture: RuleCapture | null;
  /** Changes to publish after commit (only while capturing). */
  readonly realtime: PendingChange[];
  /** Link fields whose values `realtime` carries (T401). */
  readonly realtimeLinks: Map<string, RecordChangeLink>;
  /** Schema changes (typecast-created select options) to publish after commit. */
  readonly schemaChanges: SchemaChange[];
  /** Events and audit entries not written yet (`flushChanges` before commit). */
  readonly pending: PendingChanges;
  /** Record changes for the computed-field recompute (T458), not handed over yet. */
  readonly computed: { readonly changes: ComputedChange[]; readonly before: ComputedBefore[] };
  changedData: boolean;
}

/** The writer's rules on a reverse side's table that name its field (T710). */
interface PartnerGuard {
  readonly table: TableRow;
  readonly model: TableModel;
  /** Table perm `edit`/`manage`. */
  readonly editable: boolean;
  readonly read: ResolvedRule;
  readonly edit: ResolvedRule;
}

/** A row locked for update/delete/restore. */
interface LockedRow {
  readonly id: Id<'rec'>;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly createdBy: string | null;
  readonly updatedBy: string | null;
  readonly deleted: boolean;
  readonly readable: boolean;
  readonly editable: boolean;
  /** `__parent_id` (sub-records, T405); `null` without a parent (or without sub-records). */
  readonly parentId: string | null;
  /** Storage-form values of every field owning a column, by field id. */
  readonly cells: StoredCells;
}

/** Values of the system columns behind created/updated at/by fields. */
interface SystemValues {
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly createdBy: string | null;
  readonly updatedBy: string | null;
}

/** What a transaction captures for realtime (T210). */
interface RuleCapture {
  /** Fields referenced by any role's read/edit rule on the table. */
  readonly ruleFieldIds: ReadonlySet<Id<'fld'>>;
}

/**
 * A record change waiting for publication: images in storage form, and the
 * storage-form values to show, converted to `cell_format=json` (one member
 * lookup for user cells) just before commit.
 */
interface PendingChange {
  readonly type: RecordChangeType;
  readonly recordId: Id<'rec'>;
  readonly version: number;
  readonly changedFieldIds: readonly Id<'fld'>[];
  readonly eventId: Id<'evt'> | null;
  readonly before: StoredImage | null;
  readonly after: StoredImage | null;
  readonly shown: StoredImage;
  /** `cell_format=json` values of link cells to show (T401), by field id. */
  readonly linkValues?: Readonly<Record<string, unknown>>;
}

/** A computed write of one record: what changes and the post-image. */
interface PlannedUpdate {
  readonly index: number;
  readonly row: LockedRow;
  /** Changed fields only: before/after in storage form. */
  readonly diff: Map<Id<'fld'>, { from: JsonValue; to: JsonValue }>;
}

type Issue = ProblemErrorItem;

/**
 * The only writer of record rows in `data.*` (SPEC §7.3, AGENTS.md rule 1).
 *
 * Every call runs in **one** transaction: any error leaves nothing written
 * (records, created select options, events, audit entries, jobs, the
 * table's `data_version`). In that transaction:
 *
 * 1. the table's schema advisory lock is taken in shared mode (exclusive
 *    when select options are created), so no DDL or compaction runs while
 *    the meta the write relies on is in use; waiting longer than 3 s is
 *    `409 SCHEMA_LOCKED`;
 * 2. table perm, record operations and field perms are checked (a field the
 *    caller cannot read is an unknown field);
 * 3. values are typecast (on request), validated and converted by
 *    `@cellhive/field-types`; defaults and required fields applied;
 * 4. existing rows are locked `FOR UPDATE` in `__id` order; they must be in
 *    the caller's read scope (else `404`) and edit scope (else `403`) before
 *    the change, `version` must match (`409`), and the post-image must still
 *    match the edit rule (`403 RECORD_RULE_VIOLATION`, evaluated in memory
 *    with `@cellhive/filter-dsl`);
 * 5. unique fields are checked against live records (the trash never
 *    blocks), then rows are written with `__version + 1`;
 * 6. one `record.*` event (storage-form `changes`) and one audit entry per
 *    changed record (ADR-23), and `meta.tables.data_version + 1`.
 *
 * After commit the changes go to the `RecordChangePublisher` (realtime).
 * Results are read back through `RecordQueryService` inside the
 * transaction, so hidden fields stay absent.
 */
export class RecordMutationService {
  private readonly tables: TablesRepository;
  private readonly fieldsRepo: FieldsRepository;
  private readonly members: MemberDirectoryRepository;
  private readonly organizations: OrganizationsRepository;
  private readonly conversions: FieldConversionsRepository;
  private readonly query: RecordQueryService;
  private readonly schema: Pick<SchemaService, 'addSelectOptionsInTx' | 'publishCommitted'>;
  private readonly publisher: RecordChangePublisher;
  private readonly onPublishError: (error: unknown) => void;
  private readonly events = new EventWriter();
  private readonly auditWriter = new AuditWriter();
  private readonly defaultTimeZone: string;
  private readonly timeoutMs: number;
  private readonly lockTimeoutMs: number;
  private readonly clock: () => Date;
  private readonly ruleFields: RecordRuleFields;
  private readonly attachmentCells: AttachmentCells;
  private readonly attachments: AttachmentsRepository;
  private readonly notifications: NotificationsRepository;
  private readonly follows: RecordFollowHooks;
  private readonly linkWriter: LinkWriter;
  private readonly parentWriter = new ParentWriter();
  private readonly linkImages: LinkImageReader;
  private readonly linkFanout: LinkFanout;
  private readonly linkFilters: LinkFilterMeta;
  private readonly recompute: ComputedRecomputeService;
  private readonly computedImages: ComputedImages;

  constructor(
    private readonly db: Db,
    options: RecordMutationServiceOptions,
  ) {
    this.tables = new TablesRepository(db);
    this.fieldsRepo = new FieldsRepository(db);
    this.members = new MemberDirectoryRepository(db);
    this.organizations = new OrganizationsRepository(db);
    this.conversions = new FieldConversionsRepository(db);
    this.ruleFields = new RecordRuleFields(db);
    this.attachmentCells = new AttachmentCells(db);
    this.attachments = new AttachmentsRepository(db);
    this.notifications = new NotificationsRepository(db);
    this.follows = new RecordFollowHooks(db);
    this.linkWriter = new LinkWriter(db);
    this.linkImages = new LinkImageReader(db);
    this.linkFanout = new LinkFanout(db);
    this.linkFilters = new LinkFilterMeta(db);
    this.computedImages = new ComputedImages(db);
    this.defaultTimeZone = options.defaultTimeZone ?? 'UTC';
    // Results read back carry computed values, computed in the same default zone (ADR-21).
    this.query =
      options.query ?? new RecordQueryService(db, { defaultTimeZone: this.defaultTimeZone });
    this.schema = options.schema;
    this.publisher = options.publisher ?? new RealtimeRecordChangePublisher(db);
    this.onPublishError = options.onPublishError ?? (() => undefined);
    this.timeoutMs = options.statementTimeoutMs ?? REQUEST_STATEMENT_TIMEOUT_MS;
    this.lockTimeoutMs = options.lockTimeoutMs ?? DDL_LOCK_TIMEOUT_MS;
    this.clock = options.now ?? (() => new Date());
    this.recompute =
      options.recompute ??
      new ComputedRecomputeService(db, {
        defaultTimeZone: this.defaultTimeZone,
        lockTimeoutMs: this.lockTimeoutMs,
        ...(options.automationMaxRunsPerBatch === undefined
          ? {}
          : { automationMaxRunsPerBatch: options.automationMaxRunsPerBatch }),
      });
    if (!isValidTimeZone(this.defaultTimeZone)) {
      throw new RangeError('defaultTimeZone must be an IANA time zone');
    }
    if (!Number.isSafeInteger(this.lockTimeoutMs) || this.lockTimeoutMs < 1) {
      throw new RangeError('lockTimeoutMs must be a positive integer');
    }
  }

  // -------------------------------------------------------------------------
  // Public operations

  /**
   * First step of a conversion revert keeping later edits (T403): writes
   * the edited cells, converted back, into the old column
   * (`records/conversions/revert-merge.ts`), in one transaction. Returns
   * the cells written.
   */
  async mergeRevertEdits(
    scope: OrgScope,
    jobId: Id<'job'>,
    edits: readonly { readonly id: Id<'rec'>; readonly value: JsonValue }[],
  ): Promise<number> {
    if (!isOrgScope(scope) || scope.tx !== undefined) {
      throw new TypeError('mergeRevertEdits: an OrgScope from orgScope() without tx is required');
    }
    try {
      return await this.db.withTx(
        (tx) =>
          mergeRevertEdits(
            tx,
            scope,
            {
              conversions: this.conversions,
              tables: this.tables,
              lockTimeoutMs: this.lockTimeoutMs,
            },
            jobId,
            edits,
          ),
        { timeoutMs: this.timeoutMs },
      );
    } catch (error) {
      throw this.translate(error);
    }
  }

  /**
   * One batch of the backfill of a field type conversion (T403, job
   * `field.convert`), in its own transaction: see `runConversionBatch`
   * (`records/conversions/backfill.ts`). No record events or audit entries
   * (BACKLOG S4 open question #7). `undefined` when the conversion is no
   * longer running.
   */
  async convertFieldBatch(
    scope: OrgScope,
    jobId: Id<'job'>,
    limit: number = CONVERSION_BACKFILL_BATCH_SIZE,
  ): Promise<ConversionBatchResult | undefined> {
    if (!isOrgScope(scope) || scope.tx !== undefined) {
      throw new TypeError('convertFieldBatch: an OrgScope from orgScope() without tx is required');
    }
    try {
      return await this.db.withTx(
        (tx) =>
          runConversionBatch(
            tx,
            scope,
            {
              db: this.db,
              members: this.members,
              conversions: this.conversions,
              jobs: new JobsRepository(this.db),
              tables: this.tables,
              lockTimeoutMs: this.lockTimeoutMs,
            },
            jobId,
            limit,
          ),
        { timeoutMs: this.timeoutMs },
      );
    } catch (error) {
      throw this.translate(error);
    }
  }

  /**
   * One batch of `computed.backfill` (BACKLOG T456): the stored column of a
   * formula/lookup field computed set-based for the next rows, in its own
   * transaction under `statementTimeoutMs` (30 s, SPEC §9.5); see
   * `runComputedBackfillBatch` (`computed/backfill/backfill.ts`). No record
   * events, audit, `__version` or `__updated_*` change (ADR-23 §2). A
   * batch past its timeout throws `QUERY_TIMEOUT` (the job marks the field
   * `TIMEOUT`).
   */
  async backfillComputedBatch(
    scope: OrgScope,
    input: Omit<ComputedBackfillBatchInput, 'lockTimeoutMs' | 'timeZone'> & {
      readonly statementTimeoutMs: number;
      /** Default: the organization's zone (ADR-21). */
      readonly timeZone?: string;
    },
  ): Promise<ComputedBackfillBatchResult> {
    if (!isOrgScope(scope) || scope.tx !== undefined) {
      throw new TypeError(
        'backfillComputedBatch: an OrgScope from orgScope() without tx is required',
      );
    }
    const { statementTimeoutMs, timeZone, ...batch } = input;
    try {
      return await this.db.withTx(
        async (tx) =>
          runComputedBackfillBatch(tx, scope, this.db, {
            ...batch,
            timeZone: timeZone ?? (await this.orgTimeZone(tx, scope.organizationId)),
            lockTimeoutMs: this.lockTimeoutMs,
          }),
        { timeoutMs: statementTimeoutMs },
      );
    } catch (error) {
      throw this.translate(error);
    }
  }

  /**
   * One batch of `computed.recompute` (BACKLOG T458): queued records of a
   * stored formula/lookup field recomputed with the fields reading them, in
   * its own transaction under `statementTimeoutMs`; see
   * `ComputedRecomputeService.runQueuedBatch` (`computed/recompute/**`). No
   * record events, audit, `__version` or `__updated_*` change (ADR-23 §2).
   * Fields whose `compute_state` changed get `schema.changed` after commit.
   * `jobId` (`job_…` of the run, T509) is the `batch.id` of the
   * `record.updated` events of recomputed values.
   */
  async recomputeComputedBatch(
    scope: OrgScope,
    fieldId: Id<'fld'>,
    options: {
      readonly statementTimeoutMs: number;
      readonly batchSize?: number;
      readonly jobId?: Id<'job'>;
    },
  ): Promise<QueuedRecomputeBatch> {
    if (!isOrgScope(scope) || scope.tx !== undefined) {
      throw new TypeError(
        'recomputeComputedBatch: an OrgScope from orgScope() without tx is required',
      );
    }
    try {
      return await this.db.withTx(
        async (tx) => {
          const batch = await this.recompute.runQueuedBatch(
            tx,
            scope.organizationId,
            fieldId,
            options.batchSize,
            options.jobId === undefined ? {} : { jobId: options.jobId },
          );
          const published = computedStateChanges(scope.organizationId, batch.result);
          if (published.length > 0) {
            afterCommit(tx, async () => {
              try {
                await this.schema.publishCommitted(published);
              } catch (error) {
                this.onPublishError(error);
              }
            });
          }
          return batch;
        },
        { timeoutMs: options.statementTimeoutMs },
      );
    } catch (error) {
      throw this.translate(error);
    }
  }

  /** Creates 1–1 000 records (CONTRACTS §1.4); requires the `add` operation. */
  async create(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    access: RecordAccessContext,
    request: RecordCreateRequest,
    auditContext: AuditContext,
    options: CreateOptions = {},
  ): Promise<RecordMutationOutput> {
    const input = parseRequest(createSchema, request, 'records');
    const tableAccess = this.writableTable(scope, tableId, access, auditContext);
    this.requireOperation(tableAccess, 'add');
    const items = input.records.map((record, index) => ({
      index,
      fields: record.fields,
      parentId: record.parent_id,
    }));
    return this.run(
      scope,
      tableId,
      access,
      tableAccess,
      auditContext,
      options,
      input,
      async (s) => {
        const ids = await this.insertRecords(s, items);
        if (options.onCreated !== undefined) await options.onCreated(s.tx, ids);
        // T543: the creator follows (logic in notifications/follows).
        await this.follows.afterCreate(s.scope, {
          tableId,
          recordIds: ids,
          context: s.audit,
          causation: s.causation,
          options,
        });
        if (options.readBack === false) return { records: [] };
        return { records: await this.readBack(s, tableId, ids) };
      },
    );
  }

  /** Updates 1–1 000 records, only the given fields (CONTRACTS §1.4). */
  async update(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    access: RecordAccessContext,
    request: RecordUpdateRequest,
    auditContext: AuditContext,
    options: UpdateOptions = {},
  ): Promise<RecordMutationOutput> {
    const input = parseRequest(updateSchema, request, 'records');
    const tableAccess = this.writableTable(scope, tableId, access, auditContext);
    const seen = new Map<string, number>();
    const duplicates: Issue[] = [];
    input.records.forEach((record, index) => {
      if (seen.has(record.id)) {
        duplicates.push({
          path: formatIssuePath(['records', index, 'id']),
          code: 'DUPLICATE_ID',
          message: 'The record appears more than once in the request',
        });
      }
      seen.set(record.id, index);
    });
    if (duplicates.length > 0) {
      throw new AppError('VALIDATION_FAILED', {
        detail: 'A record may appear only once per request.',
        errors: duplicates,
      });
    }
    return this.run(
      scope,
      tableId,
      access,
      tableAccess,
      auditContext,
      options,
      input,
      async (s) => {
        const ids = await this.updateRecords(
          s,
          input.records.map((record, index) => ({
            index,
            id: record.id,
            version: record.version,
            fields: record.fields,
            parentId: record.parent_id,
          })),
        );
        if (options.readBack === false) return { records: [] };
        return { records: await this.readBack(s, tableId, ids) };
      },
    );
  }

  /**
   * Creates or updates records matched on `merge_on` (CONTRACTS §1.4): 1–3
   * readable fields of type text, number, single select or auto_number,
   * compared in storage form among live records the caller can read. A
   * record without a value for every merge field never matches (it is
   * created). More than one match — in the table or within the request —
   * is `422 UPSERT_AMBIGUOUS`.
   */
  async upsert(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    access: RecordAccessContext,
    request: RecordUpsertRequest,
    auditContext: AuditContext,
    options: MutationOptions = {},
  ): Promise<RecordUpsertOutput> {
    const input = parseRequest(upsertSchema, request, 'records');
    const tableAccess = this.writableTable(scope, tableId, access, auditContext);
    return this.run(
      scope,
      tableId,
      access,
      tableAccess,
      auditContext,
      options,
      input,
      async (s) => {
        const mergeFields = this.mergeFields(s, input.merge_on);
        const matches = await this.matchRecords(s, mergeFields, input.records);
        const mergeKeys = new Set(
          mergeFields.map((field) => (s.keyType === 'id' ? field.id : field.name)),
        );
        const creates: WriteItem[] = [];
        const updates: UpdateItem[] = [];
        input.records.forEach((record, index) => {
          const match = matches.get(index);
          if (match === undefined) {
            // auto_number values are assigned, never written.
            const fields = Object.fromEntries(
              Object.entries(record.fields).filter(([key]) => {
                const field = s.byKey.get(key);
                return !(mergeKeys.has(key) && field?.type === 'auto_number');
              }),
            );
            creates.push({ index, fields });
          } else {
            // Merge values are equal by construction: not written.
            const fields = Object.fromEntries(
              Object.entries(record.fields).filter(([key]) => !mergeKeys.has(key)),
            );
            updates.push({ index, id: match, version: undefined, fields });
          }
        });
        if (creates.length > 0) this.requireOperation(tableAccess, 'add');
        const created = creates.length === 0 ? [] : await this.insertRecords(s, creates);
        const updated = updates.length === 0 ? [] : await this.updateRecords(s, updates);
        const idByIndex = new Map<number, Id<'rec'>>();
        creates.forEach((item, position) =>
          idByIndex.set(item.index, created[position] as Id<'rec'>),
        );
        updates.forEach((item, position) =>
          idByIndex.set(item.index, updated[position] as Id<'rec'>),
        );
        const ordered = input.records.map((_, index) => idByIndex.get(index) as Id<'rec'>);
        return {
          records: await this.readBack(s, tableId, ordered),
          created_ids: created,
          updated_ids: updated,
        };
      },
    );
  }

  /**
   * Moves records to the trash (`__deleted_at`, `__deleted_by`; ADR-23).
   * Requires the `delete` operation; each record must be live, readable
   * (else `404`) and editable (else `403`).
   */
  async delete(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    access: RecordAccessContext,
    request: RecordIdsRequest,
    auditContext: AuditContext,
    options: MutationOptions = {},
  ): Promise<RecordDeleteOutput> {
    const input = parseRequest(idsSchema, request, 'ids');
    const tableAccess = this.writableTable(scope, tableId, access, auditContext);
    this.requireOperation(tableAccess, 'delete');
    const ids = [...new Set(input.ids)];
    return this.run(scope, tableId, access, tableAccess, auditContext, options, {}, async (s) => ({
      ids: await this.softDelete(s, ids, input.ids, input.children),
    }));
  }

  /**
   * Restores records from the trash (SPEC §5.4, ADR-23 §4): table perm
   * `edit`/`manage` and the `delete` operation; each record must be in the
   * trash and match the caller's read and edit rules, else `404` (what
   * `RecordQueryService.listTrash` shows). Unique fields are checked again
   * (`422 UNIQUE_VIOLATION`).
   */
  async restore(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    access: RecordAccessContext,
    request: RecordIdsRequest,
    auditContext: AuditContext,
    options: MutationOptions = {},
  ): Promise<RecordMutationOutput> {
    const input = parseRequest(idsSchema, request, 'ids');
    const tableAccess = this.writableTable(scope, tableId, access, auditContext);
    this.requireOperation(tableAccess, 'delete');
    const ids = [...new Set(input.ids)];
    return this.run(scope, tableId, access, tableAccess, auditContext, options, {}, async (s) => {
      const restored = await this.restoreRows(s, ids, input.ids, input.branch);
      return { records: await this.readBack(s, tableId, restored) };
    });
  }

  /**
   * Permanently deletes records from the trash (T408, CONTRACTS §11.3). Needs
   * the table's schema right — base admin or `manage` (BACKLOG S4 open
   * question #5) — else `403`, and the `delete` operation; each record must
   * be in the caller's trash (trashed, read and edit rules), else `404`
   * exactly like a missing one. `branch`: the descendants deleted together
   * with each record that are in the caller's trash go too. Links to and
   * from the records disappear (junction `ON DELETE CASCADE`), children
   * become roots (`ON DELETE SET NULL`), files are handed to
   * `attachments.cleanup` (object deleted once unreferenced). One
   * `record.purged` event + summary audit entry (ADR-23 §2); realtime
   * `record.purged` to subscribers who could read them. Nothing else is
   * published: the records were already out of every cell and grid.
   */
  async purge(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    access: RecordAccessContext,
    request: RecordIdsRequest,
    auditContext: AuditContext,
    options: MutationOptions = {},
  ): Promise<RecordDeleteOutput> {
    const input = parseRequest(idsSchema, request, 'ids');
    const tableAccess = this.writableTable(scope, tableId, access, auditContext);
    if (!access.resolved.access.is_admin && tableAccess.perm !== 'manage') {
      throw new AppError('PERMISSION_DENIED', {
        detail: 'Only users who manage the table schema can permanently delete its records.',
      });
    }
    this.requireOperation(tableAccess, 'delete');
    const ids = [...new Set(input.ids)];
    return this.run(scope, tableId, access, tableAccess, auditContext, options, {}, async (s) => ({
      ids: await this.purgeRows(s, ids, input.ids, input.branch),
    }));
  }

  /**
   * One batch of the `records.purge` job (T408): permanently deletes up to
   * `batchSize` records of the table trashed before `before` (oldest first;
   * rows locked by a concurrent write are skipped until the next batch), in
   * one transaction under the shared schema lock, with the same cleanup as
   * {@link purge}. System write: no permission check, one `record.purged`
   * summary per batch carrying `auditContext` (the job's `batch_id`).
   * Idempotent: a table with nothing left (or gone) is `done`.
   */
  async purgeExpired(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    options: {
      readonly before: Date;
      readonly auditContext: AuditContext;
      readonly batchSize?: number;
    },
  ): Promise<ExpiredPurgeResult> {
    this.assertScope(scope);
    if (!auditContextSchema.safeParse(options.auditContext).success) {
      throw new TypeError('RecordMutationService: a valid AuditContext is required (ADR-23)');
    }
    const batchSize = options.batchSize ?? RECORD_PURGE_BATCH_SIZE;
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > MAX_RECORDS_PER_MUTATION) {
      throw new RangeError(`batchSize must be between 1 and ${String(MAX_RECORDS_PER_MUTATION)}`);
    }
    return this.db.withTx(
      async (tx) => {
        await this.acquireSchemaLock(tx, tableId, false);
        const txScope = withTxScope(scope, tx);
        const table = await this.tables.getById(txScope, tableId, { includeDeleted: true });
        if (table === undefined) return { purged: [], done: true };
        const ruleFieldIds = this.capturing()
          ? await this.ruleFields.of(txScope, table.base_id, table.id)
          : null;
        const model =
          ruleFieldIds === null
            ? []
            : (await this.fieldsRepo.listByTable(txScope, table.id))
                .map(toFieldModel)
                .filter((field) => field !== null);
        const imaged = model.filter((field) => ruleFieldIds?.has(field.id) === true);
        const { rows } = await sql<ImageRow & { __now: Date }>`
          SELECT now() AS __now, ${imageColumns(imaged)}
            FROM ${this.tableRef(table)} AS ${sql.id(ALIAS)}
           WHERE ${sql.id(ALIAS, '__deleted_at')} < ${options.before.toISOString()}::timestamptz
           ORDER BY ${sql.id(ALIAS, '__deleted_at')}, ${sql.id(ALIAS, '__id')}
           LIMIT ${batchSize}
             FOR UPDATE OF ${sql.id(ALIAS)} SKIP LOCKED
        `.execute(tx);
        const first = rows[0];
        if (first === undefined) return { purged: [], done: true };
        const pending = emptyPendingChanges();
        const { purged, eventId } = await this.hardDelete(txScope, table, {
          ids: rows.map((row) => row.__id),
          audit: options.auditContext,
          causation: undefined,
          pending,
          reason: 'retention',
          now: first.__now,
        });
        await this.enqueueComputed(
          tx,
          scope.organizationId,
          [
            {
              kind: 'records',
              baseId: table.base_id,
              tableId: table.id,
              recordIds: purged,
              event: 'purged',
            },
          ],
          recomputeSourceOf(options.auditContext, undefined, pending),
        );
        await this.flushPending(tx, pending);
        await this.tables.bumpDataVersion(txScope, tableId);
        if (ruleFieldIds !== null) {
          const gone = new Set<string>(purged);
          const realtime = rows
            .filter((row) => gone.has(row.__id))
            .map((row): PendingChange => ({
              type: 'record.purged',
              recordId: row.__id,
              version: row.__version,
              changedFieldIds: [],
              eventId,
              before: imageOf(imaged, imageCells(row, imaged), systemOfRow(row)),
              after: null,
              shown: {},
            }));
          await this.schedulePublish(
            txScope,
            table,
            model,
            options.auditContext.actor,
            null,
            realtime,
            [],
          );
        }
        return { purged, done: rows.length < batchSize };
      },
      { timeoutMs: JOB_STATEMENT_TIMEOUT_MS },
    );
  }

  /**
   * `schema.recompute_auto_number` (SPEC §5.5): rewrites the formatted
   * values of an `auto_number` field for every row (live and trashed), in
   * batches of `batchSize` rows, each in its own transaction under the
   * shared schema lock. The value is computed from `__auto`,
   * `__created_at` and the organization time zone, exactly like on insert.
   * `auto_number` is a computed field: no event, no audit entry (ADR-23 §2),
   * `__version`/`__updated_*` unchanged; `data_version` is bumped for each
   * batch that changed rows.
   */
  async recomputeAutoNumber(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    fieldId: Id<'fld'>,
    options: { readonly batchSize?: number } = {},
  ): Promise<AutoNumberRecomputeResult> {
    this.assertScope(scope);
    const batchSize = options.batchSize ?? AUTO_NUMBER_BATCH_SIZE;
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
      throw new RangeError('batchSize must be between 1 and 10000');
    }
    let cursor = 0n;
    let rows = 0;
    let updated = 0;
    for (;;) {
      const batch = await this.db.withTx(
        async (tx) => {
          await this.acquireSchemaLock(tx, tableId, false);
          const txScope = withTxScope(scope, tx);
          const table = await this.tables.getById(txScope, tableId);
          if (table === undefined) throw tableNotFound();
          const field = await this.fieldsRepo.getById(txScope, fieldId);
          if (
            field === undefined ||
            field.table_id !== tableId ||
            field.type !== 'auto_number' ||
            field.db_column_name === null
          ) {
            return null;
          }
          const rules = autoNumberOptionsSchema.parse(field.options).style.rules;
          const timeZone = await this.orgTimeZone(tx, scope.organizationId);
          const ref = this.tableRef(table);
          const column = field.db_column_name;
          const capture = await this.systemCapture(txScope, table, fieldId);
          const { rows: page } = await sql<ImageRow & { __auto: bigint }>`
            SELECT ${sql.id(ALIAS, '__auto')} AS __auto, ${imageColumns(capture?.fields ?? [])}
              FROM ${ref} AS ${sql.id(ALIAS)}
             WHERE ${sql.id(ALIAS, '__auto')} > ${cursor.toString()}::bigint
             ORDER BY ${sql.id(ALIAS, '__auto')}
             LIMIT ${batchSize}
               ${capture === null ? sql`` : sql`FOR UPDATE OF ${sql.id(ALIAS)}`}
          `.execute(tx);
          if (page.length === 0) return { rows: 0, updated: 0, last: cursor };
          const values = page.map((row) => ({
            __id: row.__id,
            [column]: formatAutoNumber(rules, {
              autoValue: row.__auto,
              createdAt: row.__created_at,
              timeZone,
            }),
          }));
          const { rows: renumbered } = await sql<{ id: Id<'rec'> }>`
            UPDATE ${ref} AS ${sql.id(ALIAS)}
               SET ${sql.id(column)} = x.${sql.id(column)}
              FROM jsonb_populate_recordset(NULL::${ref}, ${JSON.stringify(values)}::jsonb) AS x
             WHERE ${sql.id(ALIAS, '__id')} = x.__id
               AND ${sql.id(ALIAS, column)} IS DISTINCT FROM x.${sql.id(column)}
            RETURNING ${sql.id(ALIAS, '__id')} AS id
          `.execute(tx);
          const changed = renumbered.length;
          // Computed fields reading the numbers (T458).
          await this.enqueueComputed(tx, scope.organizationId, [
            {
              kind: 'records',
              baseId: table.base_id,
              tableId,
              recordIds: renumbered.map((row) => row.id),
              event: 'updated',
              fieldIds: [fieldId],
            },
          ]);
          if (changed > 0) await this.tables.bumpDataVersion(txScope, tableId);
          if (capture !== null && changed > 0) {
            // Computed values only: no event, same version (CONTRACTS §7 `event_id: null`).
            const pending: PendingChange[] = [];
            page.forEach((row, index) => {
              const cells = imageCells(row, capture.fields);
              const from = cells.get(fieldId) ?? null;
              const to = (values[index]?.[column] ?? null) as JsonValue;
              if (row.__deleted || sameStoredValue(from, to)) return;
              const post = new Map(cells).set(fieldId, to);
              const system = systemOfRow(row);
              pending.push({
                type: 'record.updated',
                recordId: row.__id,
                version: row.__version,
                changedFieldIds: [fieldId],
                eventId: null,
                before: imageOf(capture.fields, cells, system),
                after: imageOf(capture.fields, post, system),
                shown: { [fieldId]: to },
              });
            });
            await this.schedulePublish(
              txScope,
              table,
              capture.model,
              SYSTEM_ACTOR,
              null,
              pending,
              [],
            );
          }
          const last = page[page.length - 1]?.__auto ?? cursor;
          return { rows: page.length, updated: changed, last };
        },
        { timeoutMs: JOB_STATEMENT_TIMEOUT_MS },
      );
      if (batch === null) return { rows, updated, fieldFound: false };
      rows += batch.rows;
      updated += batch.updated;
      cursor = batch.last;
      if (batch.rows < batchSize) return { rows, updated, fieldFound: true };
    }
  }

  /**
   * `schema.remove_select_options` (T103): select options were deleted from
   * `fieldId`, so their ids are removed from every record that still holds
   * one (live and trashed, so a restored record does not bring a dangling id
   * back), in batches of `batchSize` records, each in its own transaction
   * under the shared schema lock. A cell left without options becomes empty.
   *
   * This is a data change made by the system: each changed record gets
   * `__version + 1`, `__updated_at = now()`, `__updated_by = NULL`, a
   * `record.updated` event with storage-form `changes` and one audit entry
   * (ADR-23) carrying `auditContext` (the job's `batch_id`); `data_version`
   * is bumped per batch and changes are published after each commit. No
   * permission check: the caller already removed the options with schema
   * rights. Options that exist again in the field are left alone, and a
   * field that is gone (or no longer a select) ends the work.
   */
  async removeSelectOptionValues(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    fieldId: Id<'fld'>,
    optionIds: readonly Id<'opt'>[],
    auditContext: AuditContext,
    options: { readonly batchSize?: number } = {},
  ): Promise<SelectOptionRemovalResult> {
    this.assertScope(scope);
    if (!auditContextSchema.safeParse(auditContext).success) {
      throw new TypeError('RecordMutationService: a valid AuditContext is required (ADR-23)');
    }
    const batchSize = options.batchSize ?? OPTION_REMOVAL_BATCH_SIZE;
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
      throw new RangeError('batchSize must be between 1 and 10000');
    }
    let cursor = '';
    let updated = 0;
    for (;;) {
      const batch = await this.db.withTx(
        async (tx) => {
          await this.acquireSchemaLock(tx, tableId, false);
          const txScope = withTxScope(scope, tx);
          const table = await this.tables.getById(txScope, tableId, { includeDeleted: true });
          if (table === undefined) throw tableNotFound();
          const field = await this.fieldsRepo.getById(txScope, fieldId);
          if (
            field === undefined ||
            field.table_id !== tableId ||
            field.type !== 'select' ||
            field.db_column_name === null
          ) {
            return null;
          }
          const current = selectOptionsSchema.safeParse(field.options);
          const existing = new Set<string>(
            current.success ? current.data.options.map((option) => option.id) : [],
          );
          const removed = new Set<string>(optionIds.filter((id) => !existing.has(id)));
          if (removed.size === 0) return { count: 0, last: cursor };
          const column = field.db_column_name;
          const ref = this.tableRef(table);
          const target = toFieldModel(field);
          if (target === null) return null;
          const capture = await this.systemCapture(txScope, table, fieldId);
          const fields = capture?.fields ?? [target];
          const { rows } = await sql<ImageRow & { __now: Date }>`
            SELECT now() AS __now, ${imageColumns(fields)}
              FROM ${ref} AS ${sql.id(ALIAS)}
             WHERE ${sql.id(ALIAS, column)} && ${[...removed]}::text[]
               AND ${sql.id(ALIAS, '__id')} > ${cursor}
             ORDER BY ${sql.id(ALIAS, '__id')}
             LIMIT ${batchSize}
               FOR UPDATE OF ${sql.id(ALIAS)}
          `.execute(tx);
          if (rows.length === 0) return { count: 0, last: cursor };
          const plans = rows.map((row) => {
            const cells = imageCells(row, fields);
            const from = cells.get(fieldId) ?? null;
            const kept = (Array.isArray(from) ? from : []).filter(
              (id) => typeof id !== 'string' || !removed.has(id),
            );
            return { row, cells, from, to: kept.length === 0 ? null : kept };
          });
          const values = plans.map((plan) => ({ __id: plan.row.__id, [column]: plan.to }));
          await sql`
            UPDATE ${ref} AS ${sql.id(ALIAS)}
               SET ${sql.id(column)} = x.${sql.id(column)},
                   __version = ${sql.id(ALIAS, '__version')} + 1,
                   __updated_at = now(),
                   __updated_by = NULL
              FROM jsonb_populate_recordset(NULL::${ref}, ${JSON.stringify(values)}::jsonb) AS x
             WHERE ${sql.id(ALIAS, '__id')} = x.__id
          `.execute(tx);
          // Computed fields reading the option (T458), in the job's batch (T509).
          await this.enqueueComputed(
            tx,
            scope.organizationId,
            [
              {
                kind: 'records',
                baseId: table.base_id,
                tableId,
                recordIds: plans.map((plan) => plan.row.__id),
                event: 'updated',
                fieldIds: [fieldId],
              },
            ],
            recomputeSourceOf(auditContext, undefined, null, plans.length),
          );
          const realtime: PendingChange[] = [];
          const pending = emptyPendingChanges();
          for (const plan of plans) {
            const version = plan.row.__version + 1;
            const eventId = queueRecordChange(pending, table, auditContext, undefined, {
              type: 'record.updated',
              recordId: plan.row.__id,
              version,
              changes: { [fieldId]: { from: plan.from, to: plan.to } },
              before: { [fieldId]: plan.from },
              after: { [fieldId]: plan.to },
            });
            // Trashed records are in nobody's view: nothing to tell.
            if (capture === null || plan.row.__deleted) continue;
            const before = systemOfRow(plan.row);
            const after: SystemValues = { ...before, updatedAt: plan.row.__now, updatedBy: null };
            const post = new Map(plan.cells).set(fieldId, plan.to);
            realtime.push({
              type: 'record.updated',
              recordId: plan.row.__id,
              version,
              changedFieldIds: [fieldId],
              eventId,
              before: imageOf(capture.fields, plan.cells, before),
              after: imageOf(capture.fields, post, after),
              shown: imageOf(shownOnUpdate(capture.model, [fieldId]), post, after),
            });
          }
          await this.flushPending(tx, pending);
          await this.tables.bumpDataVersion(txScope, tableId);
          if (capture !== null) {
            await this.schedulePublish(
              txScope,
              table,
              capture.model,
              auditContext.actor,
              null,
              realtime,
              [],
            );
          }
          const last = rows[rows.length - 1]?.__id ?? cursor;
          return { count: rows.length, last };
        },
        { timeoutMs: JOB_STATEMENT_TIMEOUT_MS },
      );
      if (batch === null) return { updated, fieldFound: false };
      updated += batch.count;
      if (batch.count < batchSize) return { updated, fieldFound: true };
      cursor = batch.last;
    }
  }

  /**
   * Values generated by the AI worker for an AI field (BACKLOG T910, ADR-39
   * §7): the only writer of its cells (they are read-only to everyone else).
   * A value is written only when the record's `__version` is still the one
   * the prompt was rendered from (a write since → `stale`, generated again);
   * records gone or in the trash are `missing`. Like any system write (actor
   * from `auditContext`, `via.ai_field_id`): `__version` + 1, a
   * `record.updated` event and audit entry per changed record, realtime,
   * and computed fields reading the field recomputed in the transaction.
   * `value` is text, or an option name of a select field.
   */
  async writeAiValues(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    fieldId: Id<'fld'>,
    items: readonly {
      readonly recordId: Id<'rec'>;
      readonly version: number;
      readonly value: string | null;
    }[],
    auditContext: AuditContext,
    options: { readonly causation?: Causation } = {},
  ): Promise<AiValuesWrite> {
    this.assertScope(scope);
    if (!auditContextSchema.safeParse(auditContext).success) {
      throw new TypeError('RecordMutationService: a valid AuditContext is required (ADR-23)');
    }
    const none: AiValuesWrite = { written: [], stale: [], missing: [], fieldFound: false };
    if (items.length === 0) return { ...none, fieldFound: true };
    return this.db.withTx(
      async (tx) => {
        await this.acquireSchemaLock(tx, tableId, false);
        const txScope = withTxScope(scope, tx);
        const table = await this.tables.getById(txScope, tableId);
        const field = await this.fieldsRepo.getById(txScope, fieldId);
        const target = field === undefined ? null : toFieldModel(field);
        if (
          table === undefined ||
          field?.table_id !== tableId ||
          target === null ||
          !target.ownsColumn ||
          !isAiField(field)
        ) {
          return none;
        }
        const capture = await this.systemCapture(txScope, table, fieldId);
        const fields = capture?.fields ?? [target];
        const ref = this.tableRef(table);
        const { rows } = await sql<ImageRow & { __now: Date }>`
          SELECT now() AS __now, ${imageColumns(fields)}
            FROM ${ref} AS ${sql.id(ALIAS)}
           WHERE ${sql.id(ALIAS, '__id')} = ANY(${sql.val(items.map((item) => item.recordId))}::text[])
             AND ${sql.id(ALIAS, '__deleted_at')} IS NULL
           ORDER BY ${sql.id(ALIAS, '__id')}
             FOR UPDATE OF ${sql.id(ALIAS)}
        `.execute(tx);
        const byId = new Map(rows.map((row) => [row.__id as string, row]));
        const out = {
          written: [] as Id<'rec'>[],
          stale: [] as Id<'rec'>[],
          missing: [] as Id<'rec'>[],
        };
        const plans: {
          row: ImageRow & { __now: Date };
          cells: StoredCells;
          from: JsonValue;
          to: JsonValue;
        }[] = [];
        for (const item of items) {
          const row = byId.get(item.recordId);
          if (row === undefined) out.missing.push(item.recordId);
          else if (row.__version !== item.version) out.stale.push(item.recordId);
          else {
            out.written.push(item.recordId);
            const cells = imageCells(row, fields);
            const from = cells.get(fieldId) ?? null;
            const to = storageToJson(target.definition.toStorage(item.value, target.options));
            if (!sameStoredValue(from, to)) plans.push({ row, cells, from, to });
          }
        }
        if (plans.length === 0) return { ...out, fieldFound: true };
        const column = target.column;
        const values = plans.map((plan) => ({ __id: plan.row.__id, [column]: plan.to }));
        await sql`
          UPDATE ${ref} AS ${sql.id(ALIAS)}
             SET ${sql.id(column)} = x.${sql.id(column)},
                 __version = ${sql.id(ALIAS, '__version')} + 1,
                 __updated_at = now(),
                 __updated_by = NULL
            FROM jsonb_populate_recordset(NULL::${ref}, ${JSON.stringify(values)}::jsonb) AS x
           WHERE ${sql.id(ALIAS, '__id')} = x.__id
        `.execute(tx);
        const pending = emptyPendingChanges();
        const realtime: PendingChange[] = [];
        for (const plan of plans) {
          const version = plan.row.__version + 1;
          const eventId = queueRecordChange(pending, table, auditContext, options.causation, {
            type: 'record.updated',
            recordId: plan.row.__id,
            version,
            changes: { [fieldId]: { from: plan.from, to: plan.to } },
            before: { [fieldId]: plan.from },
            after: { [fieldId]: plan.to },
          });
          if (capture === null) continue;
          const before = systemOfRow(plan.row);
          const after: SystemValues = { ...before, updatedAt: plan.row.__now, updatedBy: null };
          const post = new Map(plan.cells).set(fieldId, plan.to);
          realtime.push({
            type: 'record.updated',
            recordId: plan.row.__id,
            version,
            changedFieldIds: [fieldId],
            eventId,
            before: imageOf(capture.fields, plan.cells, before),
            after: imageOf(capture.fields, post, after),
            shown: imageOf(shownOnUpdate(capture.model, [fieldId]), post, after),
          });
        }
        // Formulas reading the AI field (T458), with the write's events and causation (T509).
        await this.enqueueComputed(
          tx,
          scope.organizationId,
          [
            {
              kind: 'records',
              baseId: table.base_id,
              tableId,
              recordIds: plans.map((plan) => plan.row.__id),
              event: 'updated',
              fieldIds: [fieldId],
            },
          ],
          recomputeSourceOf(auditContext, options.causation, pending),
        );
        await this.flushPending(tx, pending);
        await this.tables.bumpDataVersion(txScope, tableId);
        if (capture !== null) {
          await this.schedulePublish(
            txScope,
            table,
            capture.model,
            auditContext.actor,
            null,
            realtime,
            [],
          );
        }
        return { ...out, fieldFound: true };
      },
      { timeoutMs: JOB_STATEMENT_TIMEOUT_MS },
    );
  }

  // -------------------------------------------------------------------------
  // Session

  private assertScope(scope: OrgScope): void {
    if (!isOrgScope(scope)) {
      throw new TypeError('RecordMutationService: an OrgScope from orgScope() is required');
    }
    if (scope.tx !== undefined) {
      throw new TypeError(
        'RecordMutationService runs its own transactions; pass a scope without tx',
      );
    }
  }

  /**
   * Table access for a write: unreadable tables are `404`; readable tables
   * without `edit`/`manage` are `403 PERMISSION_DENIED`. Also checks the
   * audit context (ADR-23: a mutation without one is a programming error).
   */
  private writableTable(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    access: RecordAccessContext,
    auditContext: AuditContext,
  ): TableAccess {
    this.assertScope(scope);
    const context = auditContextSchema.safeParse(auditContext);
    if (!context.success) {
      throw new TypeError('RecordMutationService: a valid AuditContext is required (ADR-23)');
    }
    const tableAccess = access.resolved.access.tables[tableId];
    if (tableAccess === undefined || !['read_only', 'edit', 'manage'].includes(tableAccess.perm)) {
      throw tableNotFound();
    }
    if (tableAccess.perm === 'read_only') {
      throw new AppError('PERMISSION_DENIED', {
        detail: 'You can read this table but not change its records.',
      });
    }
    return tableAccess;
  }

  private requireOperation(tableAccess: TableAccess, operation: 'add' | 'delete'): void {
    if (!tableAccess.operations.includes(operation)) {
      throw new AppError('PERMISSION_DENIED', {
        detail:
          operation === 'add'
            ? 'You cannot add records to this table.'
            : 'You cannot delete records of this table.',
      });
    }
  }

  /**
   * Runs `fn` in one transaction and publishes its changes after commit.
   * First with the shared schema lock; when select options must be created,
   * once more from scratch with the exclusive lock (nothing was written).
   */
  private async run<T>(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    access: RecordAccessContext,
    tableAccess: TableAccess,
    auditContext: AuditContext,
    options: MutationOptions,
    input: { readonly field_key_type?: FieldKeyType; readonly typecast?: boolean },
    fn: (session: Session) => Promise<T>,
  ): Promise<T> {
    let deadlocks = 0;
    for (let exclusive = false; ;) {
      try {
        return await this.db.withTx(
          async (tx) => {
            const session = await this.openSession(tx, {
              scope,
              tableId,
              access,
              tableAccess,
              auditContext,
              causation: options.causation,
              exclusive,
              keyType: input.field_key_type ?? 'name',
              typecast: input.typecast ?? false,
              importCells: 'importCells' in options && options.importCells === true,
              formUpload:
                'formUpload' in options ? (options as CreateOptions).formUpload : undefined,
            });
            const value = await fn(session);
            await this.flushComputed(session);
            await this.flushChanges(session);
            if (session.changedData) {
              await this.tables.bumpDataVersion(session.scope, tableId);
            }
            if (options.beforeCommit !== undefined) await options.beforeCommit(tx);
            await this.schedulePublish(
              session.scope,
              session.model.table,
              session.model.fields,
              session.audit.actor,
              session.writer,
              session.realtime,
              session.schemaChanges,
              [...session.realtimeLinks.values()],
              session.model.links,
            );
            return value;
          },
          { timeoutMs: this.timeoutMs },
        );
      } catch (error) {
        if (error instanceof NeedsExclusiveSchemaLock && !exclusive) {
          exclusive = true;
          continue;
        }
        // Row locks of recomputed values taken across tables (SPEC §5.9):
        // the whole transaction is retried, at most DEADLOCK_ATTEMPTS times.
        if (sqlStateOf(error) === '40P01' && deadlocks < DEADLOCK_ATTEMPTS - 1) {
          deadlocks += 1;
          // A short random pause, so the retry does not meet the same writer again.
          await delay(
            DEADLOCK_RETRY_BASE_MS * deadlocks + Math.floor(Math.random() * DEADLOCK_RETRY_BASE_MS),
          );
          continue;
        }
        throw this.translate(error);
      }
    }
  }

  private async openSession(
    tx: Tx,
    init: {
      scope: OrgScope;
      tableId: Id<'tbl'>;
      access: RecordAccessContext;
      tableAccess: TableAccess;
      auditContext: AuditContext;
      causation: Causation | undefined;
      exclusive: boolean;
      keyType: FieldKeyType;
      typecast: boolean;
      importCells: boolean;
      formUpload: FormUploadSession | undefined;
    },
  ): Promise<Session> {
    await this.acquireSchemaLock(tx, init.tableId, init.exclusive);
    const { rows } = await sql<{ now: Date }>`SELECT now() AS now`.execute(tx);
    const now = rows[0]?.now ?? new Date();
    const scope = withTxScope(init.scope, tx);
    const model = await this.loadModel(scope, init.tableId, init.access, init.tableAccess);
    const resolve: ResolveContext = {
      userId: init.access.userId,
      groupMemberUserIds: init.access.groupMemberUserIds,
      timeZone: init.access.timeZone,
      now: this.clock(),
    };
    const actorType = init.auditContext.actor.type;
    const capture: RuleCapture | null = this.capturing()
      ? { ruleFieldIds: await this.ruleFields.of(scope, model.table.base_id, init.tableId) }
      : null;
    return {
      tx,
      scope,
      access: init.access,
      tableAccess: init.tableAccess,
      audit: init.auditContext,
      causation: init.causation,
      exclusive: init.exclusive,
      keyType: init.keyType,
      typecast: init.typecast,
      importCells: init.importCells,
      formUpload: init.formUpload,
      now,
      resolve,
      // SPEC §5.4: user id of the person behind the change; system, automations and anonymous
      // share links write NULL. A user actor is named by the audit context: through a share
      // link the access (and its variables) is the link creator's, the writer the submitter.
      writer:
        actorType === 'user'
          ? (init.auditContext.actor.id as Id<'usr'>)
          : actorType === 'api_token'
            ? init.access.userId
            : null,
      model,
      byKey: this.keyIndex(model, init.keyType),
      linkByKey: this.linkWriter.keyIndex(model, init.keyType),
      parentKey: parentKeyOf(model, init.keyType),
      readRule: resolveRule(init.access.resolved.internal.readFilters, model, resolve),
      editRule: resolveRule(init.access.resolved.internal.editFilters, model, resolve),
      editRuleAfterWrite: filtersNameLinks(
        model,
        rulesOf(model, init.access.resolved.internal.editFilters),
      ),
      capture,
      realtime: [],
      realtimeLinks: new Map(),
      schemaChanges: [],
      pending: emptyPendingChanges(),
      computed: { changes: [], before: [] },
      changedData: false,
    };
  }

  private async loadModel(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    access: RecordAccessContext,
    tableAccess: TableAccess,
  ): Promise<TableModel> {
    const table = await this.tables.getById(scope, tableId);
    if (table?.base_id !== access.baseId) throw tableNotFound();
    const rows = await this.fieldsRepo.listByTable(scope, tableId);
    const model = buildTableModel(table, rows, tableAccess);
    // Record rules naming link fields (T710) compile with the link meta.
    const { readFilters, editFilters } = access.resolved.internal;
    return this.linkFilters.forRules(scope, model, rulesOf(model, readFilters, editFilters));
  }

  private keyIndex(model: TableModel, keyType: FieldKeyType): Map<string, FieldModel> {
    return new Map(model.visible.map((field) => [keyType === 'id' ? field.id : field.name, field]));
  }

  private async reloadModel(s: Session): Promise<void> {
    s.model = await this.loadModel(s.scope, s.model.table.id, s.access, s.tableAccess);
    s.byKey = this.keyIndex(s.model, s.keyType);
    s.linkByKey = this.linkWriter.keyIndex(s.model, s.keyType);
    s.parentKey = parentKeyOf(s.model, s.keyType);
  }

  /**
   * The table's schema advisory lock (the key `SchemaService` uses), shared
   * or exclusive, waiting at most `lockTimeoutMs`; the previous
   * `lock_timeout` is restored so row locks keep the default behaviour.
   */
  private async acquireSchemaLock(tx: Tx, tableId: Id<'tbl'>, exclusive: boolean): Promise<void> {
    const { rows } = await sql<{ previous: string }>`
      SELECT current_setting('lock_timeout') AS previous,
             set_config('lock_timeout', ${`${String(this.lockTimeoutMs)}ms`}, true)
    `.execute(tx);
    const key = schemaLockKey(tableId);
    if (exclusive) {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(tx);
    } else {
      await sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`.execute(tx);
    }
    await sql`SELECT set_config('lock_timeout', ${rows[0]?.previous ?? '0'}, true)`.execute(tx);
  }

  /**
   * `VERSION_CONFLICT` items: the current version, when and by whom it was
   * written (`updated_by.name` only for members of the organization, else
   * `null`; `updated_by` is `null` for system writes), so the client can
   * tell the user who changed the record.
   */
  private async versionConflicts(
    s: Session,
    conflicts: readonly { item: UpdateItem; row: LockedRow }[],
  ): Promise<Issue[]> {
    const writers = conflicts.flatMap(({ row }) => (row.updatedBy === null ? [] : [row.updatedBy]));
    const names = new Map<string, string>(
      (await this.members.findMembers(s.scope, writers)).map((member) => [member.id, member.name]),
    );
    return conflicts.map(({ item, row }) => ({
      path: formatIssuePath(['records', item.index, 'version']),
      code: 'VERSION_CONFLICT',
      message: 'The record was changed by someone else',
      params: {
        current_version: row.version,
        version: item.version ?? null,
        updated_at: row.updatedAt.toISOString(),
        updated_by:
          row.updatedBy === null
            ? null
            : { id: row.updatedBy, name: names.get(row.updatedBy) ?? null },
      },
    }));
  }

  // -------------------------------------------------------------------------
  // Realtime (SPEC §15, T210)

  /** Whether record changes are published at all (else no image is captured). */
  private capturing(): boolean {
    return this.publisher.active !== false;
  }

  /**
   * Capture of a system write (worker jobs) on one field: every supported
   * field of the table, and those whose values go into the images (record
   * rule fields and `fieldId`). `null` when nothing is published.
   */
  private async systemCapture(
    scope: OrgScope,
    table: TableRow,
    fieldId: Id<'fld'>,
  ): Promise<{ model: FieldModel[]; fields: FieldModel[] } | null> {
    if (!this.capturing()) return null;
    const ruleFieldIds = await this.ruleFields.of(scope, table.base_id, table.id);
    const model = (await this.fieldsRepo.listByTable(scope, table.id))
      .map(toFieldModel)
      .filter((field) => field !== null);
    return {
      model,
      fields: model.filter((field) => field.id === fieldId || ruleFieldIds.has(field.id)),
    };
  }

  /**
   * Publishes after `scope`'s transaction commits (nothing on rollback):
   * first the schema changes (typecast-created options: clients refetch the
   * schema, then the records using them), then the record changes, whose
   * values are converted to `cell_format=json` here, before commit (one
   * member lookup for user cells).
   */
  private async schedulePublish(
    scope: OrgScope,
    table: TableRow,
    fields: readonly FieldModel[],
    actor: Actor,
    actorUserId: Id<'usr'> | null,
    pending: readonly PendingChange[],
    schemaChanges: readonly SchemaChange[],
    links: readonly RecordChangeLink[] = [],
    linkFields: readonly LinkFieldModel[] = [],
    fanout?: RecordChangeFanout,
  ): Promise<void> {
    const tx = scope.tx;
    if (tx === undefined) throw new TypeError('schedulePublish needs a transaction');
    const records =
      pending.length === 0
        ? undefined
        : await this.finalizeChanges(scope, table, fields, actor, actorUserId, pending, linkFields);
    if (schemaChanges.length === 0 && records === undefined) return;
    const toPublish = [...schemaChanges];
    afterCommit(tx, async () => {
      if (toPublish.length > 0) await this.schema.publishCommitted(toPublish);
      if (records !== undefined) {
        await this.publish(records.changes, records.fields, links, fanout);
      }
    });
  }

  private async finalizeChanges(
    scope: OrgScope,
    table: TableRow,
    fields: readonly FieldModel[],
    actor: Actor,
    actorUserId: Id<'usr'> | null,
    pending: readonly PendingChange[],
    linkFields: readonly LinkFieldModel[] = [],
  ): Promise<{ changes: RecordChange[]; fields: RecordChangeField[] }> {
    const byId = new Map(fields.map((field) => [field.id as string, field]));
    const linkById = new Map(linkFields.map((field) => [field.id as string, field]));
    const imaged = new Set<string>();
    const userIds = new Set<string>();
    for (const change of pending) {
      for (const key of Object.keys(change.before ?? {})) imaged.add(key);
      for (const key of Object.keys(change.after ?? {})) imaged.add(key);
      for (const [key, value] of Object.entries(change.shown)) {
        const type = byId.get(key)?.type;
        if (type === 'user' && Array.isArray(value)) {
          for (const id of value) if (typeof id === 'string') userIds.add(id);
        } else if ((type === 'created_by' || type === 'updated_by') && typeof value === 'string') {
          userIds.add(value);
        }
      }
    }
    const members = await this.members.findMembers(scope, [...userIds]);
    const users = new Map<string, UserRef>(members.map((member) => [member.id, member]));
    const readContext = { resolveUser: (id: string) => users.get(id) };
    const changes = pending.map((change): RecordChange => ({
      type: change.type,
      organizationId: table.organization_id,
      baseId: table.base_id,
      tableId: table.id,
      recordId: change.recordId,
      version: change.version,
      changedFieldIds: change.changedFieldIds,
      eventId: change.eventId,
      actor,
      actorUserId,
      before: change.before,
      after: change.after,
      values: {
        ...Object.fromEntries(
          Object.entries(change.shown).flatMap(([key, stored]) => {
            const field = byId.get(key);
            if (field === undefined) return [];
            return [[key, field.definition.fromStorage(stored, field.options, readContext)]];
          }),
        ),
        ...change.linkValues,
      },
    }));
    // Link fields in images (view filters, T402) travel with their type and options too.
    const meta = [...imaged].flatMap((key): RecordChangeField[] => {
      const field = byId.get(key) ?? linkById.get(key);
      return field === undefined
        ? []
        : [{ id: field.id, type: field.row.type, options: field.row.options }];
    });
    // Formula/lookup fields named by view filters or rules (T459, ADR-31).
    return this.computedImages.augment(scope, table, changes, meta);
  }

  private async publish(
    changes: readonly RecordChange[],
    fields: readonly RecordChangeField[],
    links: readonly RecordChangeLink[] = [],
    fanout?: RecordChangeFanout,
  ): Promise<void> {
    if (changes.length === 0) return;
    try {
      await (fanout !== undefined
        ? this.publisher.publish(changes, fields, links, fanout)
        : links.length === 0
          ? this.publisher.publish(changes, fields)
          : this.publisher.publish(changes, fields, links));
    } catch (error) {
      this.onPublishError(error);
    }
  }

  /** Database errors that reach the caller as catalogue errors. */
  private translate(error: unknown): unknown {
    if (error instanceof AppError) return error;
    const state = sqlStateOf(error);
    // 40P01: schema locks of two linked tables taken in opposite orders (T401).
    if (state === '55P03' || state === '40P01') {
      return new AppError('SCHEMA_LOCKED', {
        detail: 'The table schema is being changed; try again.',
        cause: error,
      });
    }
    if (state === SQLSTATE.uniqueViolation) {
      // A concurrent write took the value after the pre-check.
      const constraint = (error as { constraint?: unknown }).constraint;
      return new AppError('UNIQUE_VIOLATION', {
        detail: 'A value must be unique in its field.',
        errors: [
          {
            path: 'records',
            code: 'UNIQUE_VIOLATION',
            message: 'A value is already used by another record',
          },
        ],
        params: typeof constraint === 'string' ? { index: constraint } : {},
        cause: error,
      });
    }
    return error;
  }

  private async readBack(
    s: Session,
    tableId: Id<'tbl'>,
    ids: readonly Id<'rec'>[],
  ): Promise<RecordMutationOutput['records']> {
    // Computed values first, so the response has them (T458).
    await this.flushComputed(s);
    if (ids.length === 0) return [];
    return this.query.getRecords(s.scope, tableId, ids, s.access, {
      field_key_type: s.keyType,
      cell_format: 'json',
    });
  }

  private async orgTimeZone(tx: Tx, organizationId: Id<'org'>): Promise<string> {
    const organization = await this.organizations.findById(organizationId, tx);
    const settings = organization?.settings;
    const configured =
      typeof settings === 'object' && settings !== null && !Array.isArray(settings)
        ? settings.timezone
        : undefined;
    return typeof configured === 'string' && isValidTimeZone(configured)
      ? configured
      : this.defaultTimeZone;
  }

  private tableRef(table: TableRow): RawBuilder<unknown> {
    return sql.id(DATA_SCHEMA, assertDataTableName(table.db_table_name));
  }

  // -------------------------------------------------------------------------
  // Values

  /**
   * `FIELD_READ_ONLY` issues (with `params.type`, like an import mapping,
   * T462) for the unknown request keys that name a formula, lookup or
   * button (T517) field the caller reads: their values are computed (CONTRACTS §2). A hidden
   * (`no_perm`) or missing field stays `UNKNOWN_FIELD` (P08). Only on the
   * error path, so writes do not load the computed fields.
   */
  private async computedKeyIssues(
    s: Session,
    unknownKeys: ReadonlyMap<Issue, string>,
  ): Promise<Map<Issue, Issue>> {
    const rows = await this.fieldsRepo.listByTable(s.scope, s.model.table.id);
    const computed = new Map<string, FieldRow>();
    for (const row of rows) {
      // Buttons (T517) hold no value either.
      if (row.type !== 'formula' && row.type !== 'lookup' && row.type !== 'button') continue;
      if (!readable(s.tableAccess, row.id)) continue;
      computed.set(s.keyType === 'id' ? row.id : row.name, row);
    }
    const issues = new Map<Issue, Issue>();
    for (const [issue, key] of unknownKeys) {
      const row = computed.get(key);
      if (row === undefined) continue;
      issues.set(issue, {
        path: issue.path,
        code: 'FIELD_READ_ONLY',
        message:
          row.type === 'button'
            ? 'Button fields hold no value and cannot be written'
            : 'Formula and lookup fields are computed and cannot be written',
        params: { type: row.type },
      });
    }
    return issues;
  }

  /**
   * Field checks and value conversion for request records (SPEC §7.3 steps
   * 1–2): unknown/hidden keys → `422 VALIDATION_FAILED UNKNOWN_FIELD`;
   * fields the caller may not write → `403 FIELD_READ_ONLY`; values →
   * `422 INVALID_CELL_VALUE` (or `INVALID_SELECT_OPTION`). Unknown option
   * names with `typecast` are created when the caller may edit the field's
   * options (admins, `option_edit_fields`).
   */
  private async prepare(
    s: Session,
    items: readonly WriteItem[],
    mode: 'create' | 'update',
  ): Promise<StoredCells[]> {
    // 1. Keys and field permissions.
    const unknown: Issue[] = [];
    /** Request key of each `unknown` issue. */
    const unknownKeys = new Map<Issue, string>();
    const readOnly: Issue[] = [];
    for (const item of items) {
      for (const key of Object.keys(item.fields)) {
        const field = s.byKey.get(key);
        if (field === undefined) {
          if (key === s.parentKey) {
            // Parent cells are converted by the parent writer (T405); perms here.
            if (!this.mayWriteParent(s, mode)) {
              readOnly.push({
                path: cellPath(item.index, key),
                code: 'FIELD_READ_ONLY',
                message: 'You cannot write this field',
              });
            }
            continue;
          }
          const link = s.linkByKey.get(key);
          if (link !== undefined) {
            // Link cells are converted by the link writer (T401); perms here.
            const perm = s.tableAccess.fields[link.id];
            if (!(perm === 'edit' || (perm === 'create' && mode === 'create'))) {
              readOnly.push({
                path: cellPath(item.index, key),
                code: 'FIELD_READ_ONLY',
                message: 'You cannot write this field',
              });
            }
            continue;
          }
          const issue: Issue = {
            path: cellPath(item.index, key),
            code: 'UNKNOWN_FIELD',
            // Same message for a hidden field and a missing one (CONTRACTS §6).
            message: 'Field does not exist',
          };
          unknown.push(issue);
          unknownKeys.set(issue, key);
          continue;
        }
        const perm = s.tableAccess.fields[field.id];
        const writable =
          !field.definition.readOnly &&
          field.ownsColumn &&
          (perm === 'edit' || (perm === 'create' && mode === 'create'));
        if (!writable) {
          readOnly.push({
            path: cellPath(item.index, key),
            code: 'FIELD_READ_ONLY',
            message: 'You cannot write this field',
          });
        }
      }
    }
    for (const item of items) {
      // `parent_id` writes the parent field (T405): same permission.
      if (item.parentId === undefined || s.parentKey === null) continue;
      if (!this.mayWriteParent(s, mode)) {
        readOnly.push({
          path: formatIssuePath(['records', item.index, 'parent_id']),
          code: 'FIELD_READ_ONLY',
          message: 'You cannot write this field',
        });
      }
    }
    if (unknown.length > 0) {
      // Formula/lookup fields the caller reads are read-only (C§2), not unknown (T470).
      const computed = await this.computedKeyIssues(s, unknownKeys);
      readOnly.push(...computed.values());
      const rest = unknown.filter((issue) => !computed.has(issue));
      if (rest.length > 0) {
        throw new AppError('VALIDATION_FAILED', {
          detail: 'The request names unknown fields.',
          errors: rest,
        });
      }
    }
    if (readOnly.length > 0) {
      throw new AppError('FIELD_READ_ONLY', {
        detail: 'The request writes fields you can only read.',
        errors: readOnly,
      });
    }
    // T403 hook: a field whose values are being converted cannot be written.
    await assertNotConverting(
      this.conversions,
      s.scope,
      s.model.table.id,
      items.flatMap((item) =>
        Object.keys(item.fields).flatMap((key) => {
          const field = s.byKey.get(key);
          return field === undefined
            ? []
            : [{ path: cellPath(item.index, key), fieldId: field.id }];
        }),
      ),
    );

    // 2. Typecast and select options.
    const locale = this.typecastLocale(s);
    const issues: Issue[] = [];
    const values = items.map(() => new Map<Id<'fld'>, unknown>());
    const missingOptions = new Map<Id<'fld'>, { names: Set<string>; paths: Issue[] }>();
    items.forEach((item, position) => {
      for (const [key, raw] of Object.entries(item.fields)) {
        const field = s.byKey.get(key);
        if (field === undefined) continue;
        let value: unknown = raw;
        if (s.typecast) {
          const cast = field.definition.typecast(raw, field.options, locale);
          if (!cast.ok) {
            issues.push(...toIssues(cellPath(item.index, key), cast.issues));
            continue;
          }
          value = cast.value;
          if (cast.unknownOptions.length > 0) {
            const entry = missingOptions.get(field.id) ?? { names: new Set(), paths: [] };
            for (const name of cast.unknownOptions) {
              entry.names.add(name);
              entry.paths.push({
                path: cellPath(item.index, key),
                code: 'INVALID_SELECT_OPTION',
                message: `Option ${JSON.stringify(name)} does not exist`,
                params: { value: name },
              });
            }
            missingOptions.set(field.id, entry);
          }
        }
        (values[position] as Map<Id<'fld'>, unknown>).set(field.id, value);
      }
    });
    if (missingOptions.size > 0 && issues.length === 0) {
      const creatable = [...missingOptions].filter(
        ([fieldId, entry]) =>
          s.tableAccess.option_edit_fields.includes(fieldId) &&
          [...entry.names].every(isValidOptionName),
      );
      if (creatable.length === missingOptions.size) {
        if (!s.exclusive) throw new NeedsExclusiveSchemaLock();
        for (const [fieldId, entry] of creatable) {
          await this.schema.addSelectOptionsInTx(
            s.scope,
            fieldId,
            [...entry.names],
            s.audit,
            s.schemaChanges,
          );
        }
        await this.reloadModel(s);
        return this.prepare(s, items, mode);
      }
      for (const [fieldId, entry] of missingOptions) {
        if (!creatable.some(([id]) => id === fieldId)) issues.push(...entry.paths);
      }
    }

    // 3. Validation; user members.
    items.forEach((item, position) => {
      for (const [key] of Object.entries(item.fields)) {
        const field = s.byKey.get(key);
        if (field === undefined) continue;
        const map = values[position] as Map<Id<'fld'>, unknown>;
        if (!map.has(field.id)) continue;
        const result = field.definition.validate(map.get(field.id), field.options);
        if (!result.ok) {
          issues.push(...toIssues(cellPath(item.index, key), result.issues));
          map.delete(field.id);
        }
      }
    });
    const directory = await this.userDirectory(s, items, values);
    const attachments = await this.attachmentLookup(s, items, values);

    // 4. Storage form.
    const stored = items.map(() => new Map<Id<'fld'>, JsonValue>());
    items.forEach((item, position) => {
      for (const [key] of Object.entries(item.fields)) {
        const field = s.byKey.get(key);
        if (field === undefined) continue;
        const map = values[position] as Map<Id<'fld'>, unknown>;
        if (!map.has(field.id)) continue;
        const value = map.get(field.id);
        if (field.type === 'user') {
          const outsiders = userIdsOf(value).filter((id) => !directory.ids.has(id));
          if (outsiders.length > 0) {
            issues.push(
              ...outsiders.map((id) => ({
                path: cellPath(item.index, key),
                code: 'USER_NOT_FOUND',
                message: 'No member with this id',
                params: { id },
              })),
            );
            continue;
          }
        }
        try {
          const storage = field.definition.toStorage(value, field.options, {
            resolveUserEmail: (email) => directory.emails.get(email.toLowerCase()),
            resolveAttachment: (id) => attachments(field.id, id),
          });
          (stored[position] as StoredCells).set(field.id, storageToJson(storage));
        } catch (error) {
          if (!(error instanceof FieldValueError)) throw error;
          issues.push(...toIssues(cellPath(item.index, key), error.issues));
        }
      }
    });
    if (issues.length > 0) throw valueError(issues);
    return stored;
  }

  /** Members referenced by user cells, by id and by lower-cased email. */
  private async userDirectory(
    s: Session,
    items: readonly WriteItem[],
    values: readonly Map<Id<'fld'>, unknown>[],
  ): Promise<{ ids: Set<string>; emails: Map<string, Id<'usr'>> }> {
    const ids = new Set<string>();
    const emails = new Set<string>();
    items.forEach((item, position) => {
      for (const key of Object.keys(item.fields)) {
        const field = s.byKey.get(key);
        if (field?.type !== 'user') continue;
        const value = (values[position] as Map<Id<'fld'>, unknown>).get(field.id);
        if (!Array.isArray(value)) continue;
        for (const entry of value as unknown[]) {
          if (typeof entry !== 'object' || entry === null) continue;
          if ('id' in entry && typeof entry.id === 'string') ids.add(entry.id);
          else if ('email' in entry && typeof entry.email === 'string') emails.add(entry.email);
        }
      }
    });
    const byId = await this.members.findMembers(s.scope, [...ids]);
    const byEmail = await this.members.findMembersByEmail(s.scope, [...emails]);
    return {
      ids: new Set(byId.map((member) => member.id as string)),
      emails: new Map(byEmail.map((member) => [member.email.toLowerCase(), member.id])),
    };
  }

  /** Attachments named by attachment cells of the request (T406, `records/attachments`). */
  private async attachmentLookup(
    s: Session,
    items: readonly WriteItem[],
    values: readonly Map<Id<'fld'>, unknown>[],
  ) {
    const named = items.flatMap((item, position) =>
      Object.keys(item.fields).flatMap((key) => {
        // Link keys are not column fields (`records/links`): skipped here.
        const field = s.byKey.get(key);
        return field?.type === 'attachment'
          ? [(values[position] as Map<Id<'fld'>, unknown>).get(field.id)]
          : [];
      }),
    );
    return this.attachmentCells.lookup(s.scope, s.model.table.id, AttachmentCells.idsOf(named));
  }

  /**
   * Binds the attachment cells of written records to `meta.attachments`
   * (T406): may rewrite `after` cells (copies get new ids);
   * `422 INVALID_CELL_VALUE` / `ATTACHMENT_NOT_FOUND` for files the caller
   * may not use.
   */
  private async bindAttachments(
    s: Session,
    records: readonly {
      readonly index: number;
      readonly id: Id<'rec'>;
      readonly before: StoredCells | null;
      readonly after: StoredCells;
    }[],
  ): Promise<void> {
    const fields = s.model.fields.filter((field) => field.type === 'attachment');
    if (fields.length === 0) return;
    const writes: (AttachmentCellWrite & { readonly cells: StoredCells })[] = [];
    for (const record of records) {
      for (const field of fields) {
        if (!record.after.has(field.id)) continue;
        writes.push({
          recordId: record.id,
          fieldId: field.id,
          before: record.before?.get(field.id) ?? null,
          after: record.after.get(field.id) ?? null,
          path: cellPath(record.index, this.keyOf(s, field) ?? field.id),
          cells: record.after,
        });
      }
    }
    if (writes.length === 0) return;
    const issues = await this.attachmentCells.bind(s.scope, writes, {
      tableId: s.model.table.id,
      writer: s.writer,
      now: s.now,
      readableRecordIds: (ids) => this.readableRecordIds(s, ids),
      formUpload: s.formUpload,
    });
    if (issues.length > 0) throw valueError(issues);
    for (const write of writes) write.cells.set(write.fieldId, write.after);
  }

  /** Live records among `ids` in the caller's read scope. */
  private async readableRecordIds(
    s: Session,
    ids: readonly Id<'rec'>[],
  ): Promise<ReadonlySet<string>> {
    if (ids.length === 0) return new Set();
    const { rows } = await sql<{ __id: string }>`
      SELECT ${sql.id(ALIAS, '__id')} AS __id
        FROM ${this.tableRef(s.model.table)} AS ${sql.id(ALIAS)}
       WHERE ${sql.id(ALIAS, '__id')} = ANY(${sql.val([...ids])}::text[])
         AND ${sql.id(ALIAS, '__deleted_at')} IS NULL
         AND (${ruleSql(s.readRule, s.model, ALIAS)})
    `.execute(s.tx);
    return new Set(rows.map((row) => row.__id));
  }

  /** Field key as the caller names it, or `null` when the caller cannot see the field. */
  private keyOf(s: Session, field: FieldModel): string | null {
    const key = s.keyType === 'id' ? field.id : field.name;
    return s.byKey.get(key) === field ? key : null;
  }

  private requiredIssue(s: Session, index: number, field: FieldModel): Issue {
    const key = this.keyOf(s, field);
    return {
      path: key === null ? formatIssuePath(['records', index]) : cellPath(index, key),
      code: 'REQUIRED_FIELD_MISSING',
      message: 'A value is required',
    };
  }

  // -------------------------------------------------------------------------
  // Link cells (T401; logic in `records/links/**`)

  /**
   * Link cells of the request: typecast, validated, titles resolved, added
   * records checked (`422 INVALID_CELL_VALUE` / `LINK_TARGET_NOT_FOUND`).
   * `existing`: ids of the records an update writes (by position); `null`
   * for a record outside the caller's read or edit scope (its current links
   * are never consulted).
   */
  private async prepareLinks(
    s: Session,
    items: readonly WriteItem[],
    existing?: readonly (string | null)[],
  ): Promise<PreparedLinkCell[]> {
    if (s.linkByKey.size === 0) return [];
    if (!items.some((item) => Object.keys(item.fields).some((key) => s.linkByKey.has(key)))) {
      return [];
    }
    const { cells, issues } = await this.linkWriter.prepare(
      s,
      items,
      s.linkByKey,
      this.typecastLocale(s),
      existing,
    );
    if (issues.length > 0) throw valueError(issues);
    return cells;
  }

  /** The request's link cell changes (and reverse-side limits), before anything is written. */
  private async planLinks(
    s: Session,
    cells: readonly PreparedLinkCell[],
    recordIds: readonly Id<'rec'>[],
  ): Promise<LinkPlan> {
    if (cells.length === 0) return { cells: [], partners: [] };
    const { plan, issues } = await this.linkWriter.plan(s, cells, recordIds);
    if (issues.length > 0) throw valueError(issues);
    return plan;
  }

  /** `planLinks` then `applyLinks` for new records. */
  private async writeLinks(
    s: Session,
    cells: readonly PreparedLinkCell[],
    ids: readonly Id<'rec'>[],
  ): Promise<AppliedLinks> {
    return this.applyLinks(s, await this.planLinks(s, cells, ids));
  }

  /**
   * Writes the junction rows of changed link cells; records whose reverse
   * cells changed (two-way links) get their own `record.updated` + audit
   * entry (same `batch_id`), `data_version` and realtime changes on their
   * table. Returns the changes by record, with the json values to publish.
   */
  private async applyLinks(s: Session, plan: LinkPlan): Promise<AppliedLinks> {
    const byRecord = new Map<string, LinkCellChange[]>();
    const values = new Map<string, Record<string, unknown>>();
    if (plan.cells.length === 0) return { byRecord, values };
    for (const change of plan.cells) {
      byRecord.set(change.recordId, [...(byRecord.get(change.recordId) ?? []), change]);
    }
    // Reverse cells whose table's rules name them (T710): editable before, in the rule after.
    const guards = new Map<string, PartnerGuard>();
    for (const entry of plan.partners) {
      const guard = await this.partnerGuard(
        s,
        entry.target.table,
        entry.target.model,
        entry.partner,
      );
      if (guard === null) continue;
      await this.assertPartnersEditable(s, guard, [...entry.before.keys()]);
      guards.set(`${entry.target.table.id}:${entry.partner.id}`, guard);
    }
    const partners = await this.linkWriter.apply(s, plan, s.writer, s.now, (table, model) =>
      this.imageFieldsOf(s, table, model),
    );
    for (const partner of partners) {
      const guard = guards.get(`${partner.table.id}:${partner.field.id}`);
      if (guard === undefined || partner.records.length === 0) continue;
      const ids = partner.records.map((record) => record.recordId);
      const inRule = await this.idsWhere(
        s,
        guard.table,
        ids,
        ruleSql(guard.edit, guard.model, ALIAS),
      );
      const outside = ids.filter((id) => !inRule.has(id));
      if (outside.length > 0) {
        throw new AppError('RECORD_RULE_VIOLATION', {
          detail: 'The change would move linked records out of your edit rule.',
          errors: outside.map((id) => ({
            path: 'records',
            code: 'RECORD_RULE_VIOLATION',
            message: 'The change would move a linked record out of your edit rule',
            params: { record_id: id },
          })),
        });
      }
    }
    if (plan.cells.some((change) => change.changed)) s.changedData = true;
    if (s.capture !== null) {
      const locale = { locale: s.access.locale, timeZone: s.access.timeZone };
      for (const [field, changes] of groupByField(plan.cells.filter((c) => c.changed))) {
        const { refs, titleFieldId } = await this.linkWriter.refsOf(
          s.scope,
          field.targetTableId,
          s.access,
          changes.flatMap((change) => change.to),
          locale,
        );
        s.realtimeLinks.set(field.id, {
          id: field.id,
          tableId: field.targetTableId,
          titleFieldId,
        });
        for (const change of changes) {
          const record = values.get(change.recordId) ?? {};
          record[field.id] =
            change.to.length === 0
              ? null
              : change.to.map((id) => refs.get(id) ?? { id, title: null });
          values.set(change.recordId, record);
        }
      }
    }
    for (const partner of partners) await this.recordPartnerChanges(s, partner);
    return { byRecord, values };
  }

  /**
   * The writer's rules on the table of a two-way link's reverse side, when
   * one of them names the reverse field (T710, exception to BACKLOG S4
   * decision #6): changing those reverse cells changes which records the
   * rules let the writer read or edit, so they are checked like a write on
   * that table. `null` (no check, S4 #6) when no rule names the field.
   */
  private async partnerGuard(
    s: Session,
    table: TableRow,
    model: TableModel,
    partner: LinkFieldModel,
  ): Promise<PartnerGuard | null> {
    const access = relatedAccessContext(s.access, table.id);
    const { readFilters, editFilters } = access.resolved.internal;
    const names = rulesOf(model, readFilters, editFilters).some(
      (rule) => rule !== null && rule !== undefined && collectFieldIds(rule).includes(partner.id),
    );
    if (!names) return null;
    const withLinks = await this.linkFilters.withLinks(s.scope, model);
    const perm: string = accessibleTable(access, table.id)?.perm ?? 'no_perm';
    return {
      table,
      model: withLinks,
      editable: perm === 'edit' || perm === 'manage',
      read: resolveRule(readFilters, withLinks, s.resolve),
      edit: resolveRule(editFilters, withLinks, s.resolve),
    };
  }

  /**
   * Every live record of `ids` (reverse cells about to change) is one the
   * writer may edit — table perm, read and edit rule, as before an update —
   * else `403 PERMISSION_DENIED` before anything of the links is written.
   * Covers removing links to records the writer cannot read.
   */
  private async assertPartnersEditable(
    s: Session,
    guard: PartnerGuard,
    ids: readonly string[],
  ): Promise<void> {
    if (ids.length === 0) return;
    const live = await this.idsWhere(s, guard.table, ids, sql<SqlBool>`true`);
    const editable = guard.editable
      ? await this.idsWhere(
          s,
          guard.table,
          ids,
          sql<SqlBool>`(${ruleSql(guard.read, guard.model, ALIAS)}) AND (${ruleSql(guard.edit, guard.model, ALIAS)})`,
        )
      : new Set<string>();
    const denied = [...live].filter((id) => !editable.has(id));
    if (denied.length > 0) {
      throw new AppError('PERMISSION_DENIED', {
        detail: 'You cannot change the links of these records.',
        errors: denied.map((id) => ({
          path: 'records',
          code: 'PERMISSION_DENIED',
          message: 'You cannot edit this linked record',
          params: { record_id: id },
        })),
      });
    }
  }

  /** Live records of `table` among `ids` matching `condition` (over alias `ALIAS`). */
  private async idsWhere(
    s: Session,
    table: TableRow,
    ids: readonly string[],
    condition: RawBuilder<SqlBool>,
  ): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const { rows } = await sql<{ __id: string }>`
      SELECT ${sql.id(ALIAS, '__id')} AS __id
        FROM ${this.tableRef(table)} AS ${sql.id(ALIAS)}
       WHERE ${sql.id(ALIAS, '__id')} = ANY(${sql.val([...ids])}::text[])
         AND ${sql.id(ALIAS, '__deleted_at')} IS NULL
         AND (${condition})
    `.execute(s.tx);
    return new Set(rows.map((row) => row.__id));
  }

  /** Events, audit entries, `data_version` and realtime of reverse-cell changes. */
  private async recordPartnerChanges(s: Session, partner: PartnerChanges): Promise<void> {
    if (partner.records.length === 0) return;
    const field = partner.field;
    // Their reverse cells changed: computed fields reading them follow (T458).
    this.noteComputed(s, {
      kind: 'records',
      baseId: partner.table.base_id,
      tableId: partner.table.id,
      recordIds: partner.records.map((record) => record.recordId),
      event: 'updated',
      fieldIds: [field.id],
    });
    const pending: PendingChange[] = [];
    const locale = { locale: s.access.locale, timeZone: s.access.timeZone };
    const refs =
      s.capture === null
        ? null
        : await this.linkWriter.refsOf(
            s.scope,
            field.targetTableId,
            s.access,
            partner.records.flatMap((record) => record.to),
            locale,
          );
    // Link cells named by the partner table's view filters (T402), after the write.
    const imageLinks =
      refs === null ? [] : await this.imageLinksOf(s, partner.table, partner.model);
    const cellsAfter: LinkImageCells =
      imageLinks.length === 0
        ? new Map<string, Map<Id<'fld'>, JsonValue>>()
        : await this.linkImages.read(
            s.scope,
            imageLinks,
            partner.records.map((record) => record.recordId),
          );
    for (const record of partner.records) {
      const from = linkStored(record.from);
      const to = linkStored(record.to);
      const eventId = queueRecordChange(s.pending, partner.table, s.audit, s.causation, {
        type: 'record.updated',
        recordId: record.recordId,
        version: record.version,
        changes: { [field.id]: { from, to } },
        before: { [field.id]: from },
        after: { [field.id]: to },
        secondary: true,
      });
      if (refs === null) continue;
      const before: SystemValues = {
        createdAt: record.createdAt,
        updatedAt: record.updatedAtBefore,
        createdBy: record.createdBy,
        updatedBy: record.updatedByBefore,
      };
      const after: SystemValues = { ...before, updatedAt: s.now, updatedBy: s.writer };
      pending.push({
        type: 'record.updated',
        recordId: record.recordId,
        version: record.version,
        changedFieldIds: [field.id],
        eventId,
        before: {
          ...imageOf(partner.imageFields, record.cells, before),
          ...linkImageOf(cellsAfter.get(record.recordId), { [field.id]: from }),
        },
        after: {
          ...imageOf(partner.imageFields, record.cells, after),
          ...linkImageOf(cellsAfter.get(record.recordId)),
        },
        shown: imageOf(shownOnUpdate(partner.model.fields, []), record.cells, after),
        linkValues: {
          [field.id]:
            record.to.length === 0
              ? null
              : record.to.map((id) => refs.refs.get(id) ?? { id, title: null }),
        },
      });
    }
    await this.tables.bumpDataVersion(s.scope, partner.table.id);
    if (refs === null || pending.length === 0) return;
    await this.schedulePublish(
      s.scope,
      partner.table,
      partner.model.fields,
      s.audit.actor,
      s.writer,
      pending,
      [],
      [{ id: field.id, tableId: field.targetTableId, titleFieldId: refs.titleFieldId }],
      partner.model.links,
    );
  }

  /** Link fields of `model` in realtime images: those its view filters (or rules) name (T402). */
  private async imageLinksOf(
    s: Session,
    table: TableRow,
    model: TableModel,
  ): Promise<LinkFieldModel[]> {
    if (s.capture === null || model.links.length === 0) return [];
    const ids =
      table.id === s.model.table.id
        ? s.capture.ruleFieldIds
        : await this.ruleFields.of(s.scope, table.base_id, table.id);
    return model.links.filter((link) => ids.has(link.id));
  }

  /** Link cells of the session's records for their images (T402); empty when none is imaged. */
  private async sessionLinkCells(s: Session, ids: readonly string[]): Promise<LinkImageCells> {
    const links = await this.imageLinksOf(s, s.model.table, s.model);
    return links.length === 0 || ids.length === 0
      ? new Map()
      : this.linkImages.read(s.scope, links, ids);
  }

  /**
   * Cross-table realtime (T402): link cells of other records that show
   * `ids` (records of the session's table) changed — their title (primary
   * field) or whether they are live (trash, restore). Published per link
   * field after commit (`links/link-fanout.ts`).
   */
  private async fanOutLinks(
    s: Session,
    kind: LinkFanoutKind,
    ids: readonly Id<'rec'>[],
  ): Promise<void> {
    if (s.capture === null || ids.length === 0) return;
    const locale = { locale: s.access.locale, timeZone: s.access.timeZone };
    const plans = await this.linkFanout.plan(s.scope, s.model.table, s.access, kind, ids, locale);
    for (const plan of plans) {
      await this.schedulePublish(
        s.scope,
        plan.table,
        plan.model.fields,
        s.audit.actor,
        s.writer,
        plan.changes,
        [],
        [plan.link],
        plan.model.links,
        plan.fanout,
      );
    }
  }

  /** Fields of another table's records in realtime images: its record rule fields. */
  private async imageFieldsOf(
    s: Session,
    table: TableRow,
    model: TableModel,
  ): Promise<FieldModel[]> {
    if (s.capture === null) return [];
    const ruleIds = await this.ruleFields.of(s.scope, table.base_id, table.id);
    return model.fields.filter((field) => ruleIds.has(field.id));
  }

  private requiredLinkIssue(s: Session, index: number, link: LinkFieldModel): Issue {
    const key = s.keyType === 'id' ? link.id : link.name;
    return {
      path:
        s.linkByKey.get(key) === link ? cellPath(index, key) : formatIssuePath(['records', index]),
      code: 'REQUIRED_FIELD_MISSING',
      message: 'A value is required',
    };
  }

  // -------------------------------------------------------------------------
  // Parent cells (T405; logic in `records/tree/**`)

  private mayWriteParent(s: Session, mode: 'create' | 'update'): boolean {
    const parent = s.model.visibleParent;
    if (parent === null) return false;
    const perm = s.tableAccess.fields[parent.id];
    return perm === 'edit' || (perm === 'create' && mode === 'create');
  }

  /** Parent cells of the request (value or `parent_id`), typecast, validated, titles resolved. */
  private async prepareParents(s: Session, items: readonly WriteItem[]): Promise<PreparedParent[]> {
    if (!items.some((item) => item.parentId !== undefined || this.writesParentField(s, item))) {
      return [];
    }
    const { cells, issues } = await this.parentWriter.prepare(s, items, this.typecastLocale(s));
    if (issues.length > 0) throw valueError(issues);
    return cells;
  }

  private writesParentField(s: Session, item: WriteItem): boolean {
    return s.parentKey !== null && Object.hasOwn(item.fields, s.parentKey);
  }

  /** `422 LINK_TARGET_NOT_FOUND` for new parents that are not live records the caller reads. */
  private async verifyParents(
    s: Session,
    cells: readonly PreparedParent[],
    current: (position: number) => string | null | undefined,
  ): Promise<void> {
    if (cells.length === 0) return;
    const issues = await this.parentWriter.verify(s, cells, current);
    if (issues.length > 0) throw valueError(issues);
  }

  /** `{ id, title }` of parents for realtime (the gateway hides titles like link titles). */
  private async parentValues(
    s: Session,
    ids: readonly string[],
  ): Promise<Map<string, { id: string; title: string | null }>> {
    const parent = s.model.parent;
    if (s.capture === null || parent === null || ids.length === 0) return new Map();
    const locale = { locale: s.access.locale, timeZone: s.access.timeZone };
    const { refs, titleFieldId } = await this.linkWriter.refsOf(
      s.scope,
      s.model.table.id,
      s.access,
      [...new Set(ids)],
      locale,
    );
    s.realtimeLinks.set(parent.id, { id: parent.id, tableId: s.model.table.id, titleFieldId });
    return refs;
  }

  /**
   * Makes live `children` roots (`__parent_id = NULL`): a record change each
   * (`record.updated` on the parent field, audit, realtime), without
   * permission checks on them — a consequence of deleting their parent
   * (BACKLOG S4 open question #11), like the reverse cell of a link.
   */
  private async promoteChildren(s: Session, children: readonly Id<'rec'>[]): Promise<void> {
    const parent = s.model.parent;
    if (parent === null || children.length === 0) return;
    const locked = await this.lockRows(s, children);
    const rows = children.flatMap((id) => {
      const row = locked.get(id);
      return row === undefined || row.deleted || row.parentId === null ? [] : [row];
    });
    if (rows.length === 0) return;
    await sql`
      UPDATE ${this.tableRef(s.model.table)}
         SET __parent_id = NULL,
             __version = __version + 1,
             __updated_at = ${s.now.toISOString()}::timestamptz,
             __updated_by = ${s.writer}
       WHERE __id = ANY(${sql.val(rows.map((row) => row.id))}::text[])
    `.execute(s.tx);
    this.noteComputed(s, {
      kind: 'records',
      baseId: s.model.table.base_id,
      tableId: s.model.table.id,
      recordIds: rows.map((row) => row.id),
      event: 'updated',
      fieldIds: [parent.id],
    });
    const imaged = this.ruleFieldsOf(s);
    for (const row of rows) {
      const change = { from: row.parentId, to: null };
      const eventId = this.recordChange(
        s,
        'record.updated',
        row.id,
        row.version + 1,
        { [parent.id]: change },
        { [parent.id]: change.from },
        { [parent.id]: null },
        true,
      );
      if (s.capture === null) continue;
      const system: SystemValues = {
        createdAt: row.createdAt,
        updatedAt: s.now,
        createdBy: row.createdBy,
        updatedBy: s.writer,
      };
      s.realtime.push({
        type: 'record.updated',
        recordId: row.id,
        version: row.version + 1,
        changedFieldIds: [parent.id],
        eventId,
        before: imageOf(imaged, row.cells, systemOfLocked(row)),
        after: imageOf(imaged, row.cells, system),
        shown: imageOf(shownOnUpdate(s.model.fields, []), row.cells, system),
        linkValues: { [parent.id]: null },
      });
    }
    s.changedData = true;
  }

  // -------------------------------------------------------------------------
  // Create

  /**
   * The checks of new records: cell values, link cells, parents. An API
   * write stops at the first check that fails; an import (`importCells`,
   * T421b) runs them all, so that a row's report lists every bad cell.
   */
  private async checkNewRecords(
    s: Session,
    items: readonly WriteItem[],
  ): Promise<{
    prepared: StoredCells[];
    linkCells: PreparedLinkCell[];
    parentCells: PreparedParent[];
  }> {
    if (!s.importCells) {
      const prepared = await this.prepare(s, items, 'create');
      const linkCells = await this.prepareLinks(s, items);
      const parentCells = await this.prepareParents(s, items);
      await this.verifyParents(s, parentCells, () => undefined);
      return { prepared, linkCells, parentCells };
    }
    const issues: Issue[] = [];
    const collect = async <T>(check: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await check();
      } catch (error) {
        if (!(error instanceof AppError) || !VALUE_ERROR_CODES.has(error.code)) throw error;
        issues.push(...(error.errors ?? []));
        return undefined;
      }
    };
    const prepared = await collect(() => this.prepare(s, items, 'create'));
    const linkCells = await collect(() => this.prepareLinks(s, items));
    const parentCells = await collect(() => this.prepareParents(s, items));
    if (parentCells !== undefined) {
      await collect(() => this.verifyParents(s, parentCells, () => undefined));
    }
    if (issues.length > 0 || prepared === undefined || linkCells === undefined) {
      throw valueError(issues);
    }
    return { prepared, linkCells, parentCells: parentCells ?? [] };
  }

  private async insertRecords(s: Session, items: readonly WriteItem[]): Promise<Id<'rec'>[]> {
    const { prepared, linkCells, parentCells } = await this.checkNewRecords(s, items);
    const parentOf = new Map(parentCells.map((cell) => [cell.position, cell.to]));
    const { model } = s;
    const columnFields = model.fields.filter((field) => field.ownsColumn);
    const writable = columnFields.filter((field) => !field.definition.readOnly);
    const defaults = new Map<Id<'fld'>, JsonValue>();
    for (const field of writable) {
      const fallback = resolveDefaultValue(
        { type: field.type, options: field.options } as FieldConfig,
        { now: s.now, userId: s.access.userId, timeZone: s.access.timeZone },
      );
      try {
        defaults.set(
          field.id,
          storageToJson(field.definition.toStorage(fallback ?? null, field.options)),
        );
      } catch (error) {
        // A default that no longer validates (e.g. a removed option) is ignored.
        if (!(error instanceof FieldValueError)) throw error;
        defaults.set(field.id, storageToJson(field.definition.toStorage(null, field.options)));
      }
    }

    const cells = prepared.map((values) => {
      const full: StoredCells = new Map();
      for (const field of writable) {
        full.set(
          field.id,
          values.has(field.id) ? (values.get(field.id) ?? null) : (defaults.get(field.id) ?? null),
        );
      }
      return full;
    });

    // Required fields (after defaults).
    const missing: Issue[] = [];
    items.forEach((item, position) => {
      const full = cells[position] as StoredCells;
      for (const field of writable) {
        if (field.row.required && full.get(field.id) === null) {
          missing.push(this.requiredIssue(s, item.index, field));
        }
      }
      for (const link of s.model.links) {
        if (!link.row.required) continue;
        const cell = linkCells.find((c) => c.position === position && c.field === link);
        if (cell === undefined || cell.ids.length === 0) {
          missing.push(this.requiredLinkIssue(s, item.index, link));
        }
      }
    });
    if (missing.length > 0) {
      throw new AppError('REQUIRED_FIELD_MISSING', {
        detail: 'Required fields have no value.',
        errors: missing,
      });
    }

    // Record rule after the change: a new record must match the edit rule (P14).
    const ids = items.map(() => newId('rec'));
    const violations: Issue[] = [];
    items.forEach((item, position) => {
      const image = this.evaluationImage(s, cells[position] as StoredCells, {
        createdAt: s.now,
        updatedAt: s.now,
        createdBy: s.writer,
        updatedBy: s.writer,
      });
      if (!this.matchesEditRule(s, image)) {
        violations.push({
          path: formatIssuePath(['records', item.index]),
          code: 'RECORD_RULE_VIOLATION',
          message: 'The record would not match your edit rule',
        });
      }
    });
    if (violations.length > 0) {
      throw new AppError('RECORD_RULE_VIOLATION', {
        detail: 'You may only create records that match your edit rule.',
        errors: violations,
      });
    }

    await this.bindAttachments(
      s,
      items.map((item, position) => ({
        index: item.index,
        id: ids[position] as Id<'rec'>,
        before: null,
        after: cells[position] as StoredCells,
      })),
    );

    await this.checkUnique(
      s,
      items.map((item, position) => ({
        path: (key: string) => cellPath(item.index, key),
        id: ids[position] as Id<'rec'>,
        cells: cells[position] as StoredCells,
      })),
    );

    // Insert, auto numbers computed in the same statement (schema/auto-number.ts).
    const table = model.table;
    const autoFields = columnFields.filter((field) => field.type === 'auto_number');
    const autoValues =
      autoFields.length > 0 ? await reserveAutoValues(s.tx, table.db_table_name, items.length) : [];
    const timeZone =
      autoFields.length > 0 ? await this.orgTimeZone(s.tx, s.scope.organizationId) : 'UTC';
    const nowIso = s.now.toISOString();
    const rows = items.map((_, position) => {
      const row: Record<string, JsonValue> = {
        __id: ids[position] as string,
        __created_at: nowIso,
        __updated_at: nowIso,
        __created_by: s.writer,
        __updated_by: s.writer,
      };
      for (const field of writable) {
        row[field.column] = (cells[position] as StoredCells).get(field.id) ?? null;
      }
      if (model.parent !== null) row.__parent_id = parentOf.get(position) ?? null;
      const autoValue = autoValues[position];
      if (autoValue !== undefined) {
        row.__auto = autoValue.toString();
        for (const field of autoFields) {
          const rules = autoNumberOptionsSchema.parse(field.options).style.rules;
          row[field.column] = formatAutoNumber(rules, {
            autoValue,
            createdAt: s.now,
            timeZone,
          });
        }
      }
      return row;
    });
    const columns = [
      '__id',
      ...(autoValues.length > 0 ? ['__auto'] : []),
      '__created_at',
      '__updated_at',
      '__created_by',
      '__updated_by',
      ...writable.map((field) => field.column),
      ...(autoValues.length > 0 ? autoFields.map((field) => field.column) : []),
      ...(model.parent !== null ? ['__parent_id'] : []),
    ];
    const ref = this.tableRef(table);
    await sql`
      INSERT INTO ${ref} (${sql.join(columns.map((column) => sql.id(column)))})
      ${autoValues.length > 0 ? sql`OVERRIDING SYSTEM VALUE` : sql``}
      SELECT ${sql.join(columns.map((column) => sql.id('x', column)))}
        FROM jsonb_populate_recordset(NULL::${ref}, ${JSON.stringify(rows)}::jsonb) AS x
    `.execute(s.tx);
    // Link cells (T401): junction rows, and the reverse cells of two-way links.
    const links = await this.writeLinks(s, linkCells, ids);
    // Record rule after the change on link cells (T710).
    await this.checkEditRuleAfterWrite(
      s,
      items.map((item, position) => ({ index: item.index, id: ids[position] as string })),
      'You may only create records that match your edit rule.',
      'The record would not match your edit rule',
    );
    // Computed fields of the new records and of those reading them (T458).
    this.noteComputed(s, {
      kind: 'records',
      baseId: table.base_id,
      tableId: table.id,
      recordIds: ids,
      event: 'created',
    });
    // Sub-records (T405): new records are leaves, only their depth can fail.
    const withParent = parentCells.filter((cell) => cell.to !== null);
    if (withParent.length > 0) {
      const byId = new Map(withParent.map((cell) => [ids[cell.position] as string, cell.path]));
      await assertTreeInvariants(
        s.tx,
        model.table,
        [...byId.keys()],
        (id) => byId.get(id) ?? 'records',
        new Set(ids),
      );
    }
    const parentRefs = await this.parentValues(
      s,
      withParent.map((cell) => cell.to as string),
    );

    // Events and audit: every writable field with a value (computed ones are never audited).
    const system: SystemValues = {
      createdAt: s.now,
      updatedAt: s.now,
      createdBy: s.writer,
      updatedBy: s.writer,
    };
    const ruleFields = this.ruleFieldsOf(s);
    const imageLinks = await this.imageLinksOf(s, s.model.table, s.model);
    for (const position of items.keys()) {
      const id = ids[position] as Id<'rec'>;
      const full = cells[position] as StoredCells;
      const after: JsonObject = {};
      const changes: Record<string, { from: JsonValue; to: JsonValue }> = {};
      for (const field of writable) {
        const value = full.get(field.id) ?? null;
        if (value === null || value === false) continue;
        after[field.id] = value;
        changes[field.id] = { from: null, to: value };
      }
      for (const change of links.byRecord.get(id) ?? []) {
        if (change.to.length === 0) continue;
        after[change.field.id] = linkStored(change.to);
        changes[change.field.id] = { from: null, to: linkStored(change.to) };
      }
      const parentTo = parentOf.get(position) ?? null;
      const parentValue: Record<string, unknown> = {};
      if (model.parent !== null && parentTo !== null) {
        after[model.parent.id] = parentTo;
        changes[model.parent.id] = { from: null, to: parentTo };
        parentValue[model.parent.id] = parentRefs.get(parentTo) ?? { id: parentTo, title: null };
      }
      const eventId = this.recordChange(s, 'record.created', id, 1, changes, null, after);
      if (s.capture === null) continue;
      const stored: StoredCells = new Map(full);
      for (const field of autoFields) {
        stored.set(field.id, (rows[position] as Record<string, JsonValue>)[field.column] ?? null);
      }
      s.realtime.push({
        type: 'record.created',
        recordId: id,
        version: 1,
        changedFieldIds: Object.keys(changes) as Id<'fld'>[],
        eventId,
        before: null,
        after: {
          ...imageOf(ruleFields, stored, system),
          // A new record's link cells: what the request linked (T402).
          ...Object.fromEntries(
            imageLinks.map((link) => {
              const change = links.byRecord.get(id)?.find((item) => item.field === link);
              return [link.id, change === undefined ? null : linkStored(change.to)];
            }),
          ),
        },
        shown: imageOf(model.fields, stored, system),
        linkValues: { ...links.values.get(id), ...parentValue },
      });
    }
    s.changedData = true;
    return ids;
  }

  // -------------------------------------------------------------------------
  // Update

  private async updateRecords(s: Session, items: readonly UpdateItem[]): Promise<Id<'rec'>[]> {
    const prepared = await this.prepare(s, items, 'update');
    const locked = await this.lockRows(
      s,
      items.map((item) => item.id),
    );
    // Only a record the caller reads and edits may keep what its cells hold
    // now without checks (P20); for any other record the current links and
    // parent are never consulted, so the value checks cannot reveal them.
    const writable = (id: string): LockedRow | undefined => {
      const row = locked.get(id);
      return row !== undefined && !row.deleted && row.readable && row.editable ? row : undefined;
    };
    const linkCells = await this.prepareLinks(
      s,
      items,
      items.map((item) => (writable(item.id) === undefined ? null : item.id)),
    );
    const parentCells = await this.prepareParents(s, items);

    // Required fields cleared by the request.
    const missing: Issue[] = [];
    items.forEach((item, position) => {
      for (const [fieldId, value] of prepared[position] as StoredCells) {
        const field = s.model.fields.find((candidate) => candidate.id === fieldId);
        if (field?.row.required === true && value === null) {
          missing.push(this.requiredIssue(s, item.index, field));
        }
      }
    });
    for (const cell of linkCells) {
      if (cell.field.row.required && cell.ids.length === 0) {
        missing.push(this.requiredLinkIssue(s, cell.index, cell.field));
      }
    }
    if (missing.length > 0) {
      throw new AppError('REQUIRED_FIELD_MISSING', {
        detail: 'Required fields cannot be emptied.',
        errors: missing,
      });
    }

    // Keeping the current parent needs nothing, even an unreadable one (P20).
    await this.verifyParents(s, parentCells, (position) => {
      const item = items[position];
      return item === undefined ? undefined : writable(item.id)?.parentId;
    });
    const notFound: Issue[] = [];
    const forbidden: Issue[] = [];
    const conflicts: { item: (typeof items)[number]; row: LockedRow }[] = [];
    items.forEach((item) => {
      const row = locked.get(item.id);
      const path = formatIssuePath(['records', item.index, 'id']);
      if (row === undefined || row.deleted || !row.readable) {
        notFound.push({ path, code: 'NOT_FOUND', message: 'The record does not exist' });
      } else if (!row.editable) {
        forbidden.push({ path, code: 'PERMISSION_DENIED', message: 'You cannot edit this record' });
      } else if (item.version !== undefined && item.version !== row.version) {
        conflicts.push({ item, row });
      }
    });
    if (notFound.length > 0) {
      throw new AppError('NOT_FOUND', { detail: 'The record does not exist.', errors: notFound });
    }
    if (forbidden.length > 0) {
      throw new AppError('PERMISSION_DENIED', {
        detail: 'You cannot edit these records.',
        errors: forbidden,
      });
    }
    if (conflicts.length > 0) {
      throw new AppError('VERSION_CONFLICT', {
        detail: 'The record was changed since you read it.',
        errors: await this.versionConflicts(s, conflicts),
      });
    }

    await this.bindAttachments(
      s,
      items.map((item, position) => {
        const row = locked.get(item.id) as LockedRow;
        return {
          index: item.index,
          id: row.id,
          before: row.cells,
          after: prepared[position] as StoredCells,
        };
      }),
    );

    // Link cells against the current junction rows (limits of both sides).
    const linkPlan = await this.planLinks(
      s,
      linkCells,
      items.map((item) => (locked.get(item.id) as LockedRow).id),
    );
    const linkChanged = new Set<string>(
      linkPlan.cells.filter((change) => change.changed).map((change) => change.recordId),
    );
    // Parent changes (T405), by record id.
    const parentChanges = new Map<
      string,
      { from: string | null; to: string | null; path: string }
    >();
    for (const cell of parentCells) {
      const item = items[cell.position];
      const row = item === undefined ? undefined : locked.get(item.id);
      if (row === undefined || row.parentId === cell.to) continue;
      parentChanges.set(row.id, { from: row.parentId, to: cell.to, path: cell.path });
    }

    // Post-images, diffs and the record rule after the change (P12).
    const plans: PlannedUpdate[] = [];
    const violations: Issue[] = [];
    items.forEach((item, position) => {
      const row = locked.get(item.id) as LockedRow;
      const diff = new Map<Id<'fld'>, { from: JsonValue; to: JsonValue }>();
      const post: StoredCells = new Map(row.cells);
      for (const [fieldId, value] of prepared[position] as StoredCells) {
        const before = row.cells.get(fieldId) ?? null;
        post.set(fieldId, value);
        if (!sameStoredValue(before, value)) diff.set(fieldId, { from: before, to: value });
      }
      if (diff.size > 0) {
        const image = this.evaluationImage(s, post, {
          createdAt: row.createdAt,
          updatedAt: s.now,
          createdBy: row.createdBy,
          updatedBy: s.writer,
        });
        if (!this.matchesEditRule(s, image)) {
          violations.push({
            path: formatIssuePath(['records', item.index]),
            code: 'RECORD_RULE_VIOLATION',
            message: 'The change would move the record out of your edit rule',
          });
        }
      }
      plans.push({ index: item.index, row, diff });
    });
    if (violations.length > 0) {
      throw new AppError('RECORD_RULE_VIOLATION', {
        detail: 'You may only make changes that keep records within your edit rule.',
        errors: violations,
      });
    }

    const changed = plans.filter(
      (plan) =>
        plan.diff.size > 0 || linkChanged.has(plan.row.id) || parentChanges.has(plan.row.id),
    );
    await this.checkUnique(
      s,
      changed.map((plan) => ({
        path: (key: string) => cellPath(plan.index, key),
        id: plan.row.id,
        cells: new Map([...plan.diff].map(([fieldId, change]) => [fieldId, change.to])),
      })),
    );

    // Computed fields (T458): what the write changes, and the rows keyed on the
    // old values (both sides of links), found before anything is written.
    const computedChanges = this.updatedComputedChanges(s, changed, linkPlan, parentChanges);
    await this.computedBefore(s, [
      ...computedChanges,
      ...linkPlan.partners.map((entry): ComputedChange => ({
        kind: 'records',
        baseId: entry.target.table.base_id,
        tableId: entry.target.table.id,
        recordIds: [...entry.before.keys()],
        event: 'updated',
        fieldIds: [entry.partner.id],
      })),
    ]);
    for (const change of computedChanges) this.noteComputed(s, change);

    // One UPDATE per distinct set of changed columns (usually one for a bulk edit).
    const groups = new Map<string, PlannedUpdate[]>();
    for (const plan of changed) {
      const key = [
        ...[...plan.diff.keys()].sort(),
        ...(parentChanges.has(plan.row.id) ? ['__parent_id'] : []),
      ].join(',');
      const group = groups.get(key) ?? [];
      group.push(plan);
      groups.set(key, group);
    }
    const ref = this.tableRef(s.model.table);
    for (const group of groups.values()) {
      const fields = [...(group[0] as PlannedUpdate).diff.keys()].map(
        (fieldId) => s.model.fields.find((field) => field.id === fieldId) as FieldModel,
      );
      const setsParent = parentChanges.has((group[0] as PlannedUpdate).row.id);
      const rows = group.map((plan) => {
        const row: Record<string, JsonValue> = { __id: plan.row.id };
        for (const field of fields) row[field.column] = plan.diff.get(field.id)?.to ?? null;
        if (setsParent) row.__parent_id = parentChanges.get(plan.row.id)?.to ?? null;
        return row;
      });
      // A record whose only change is a link cell (T401) gets a new version too.
      const assignments = [
        ...fields.map((field) => sql`${sql.id(field.column)} = x.${sql.id(field.column)}`),
        ...(setsParent ? [sql`__parent_id = x.__parent_id`] : []),
        sql`__version = ${sql.id(ALIAS, '__version')} + 1`,
        sql`__updated_at = ${s.now.toISOString()}::timestamptz`,
        sql`__updated_by = ${s.writer}`,
      ];
      await sql`
        UPDATE ${ref} AS ${sql.id(ALIAS)}
           SET ${sql.join(assignments)}
          FROM jsonb_populate_recordset(NULL::${ref}, ${JSON.stringify(rows)}::jsonb) AS x
         WHERE ${sql.id(ALIAS, '__id')} = x.__id
      `.execute(s.tx);
    }
    // Link cells in the images (T402), before the junction changes.
    const imageLinkCells = await this.sessionLinkCells(
      s,
      changed.map((plan) => plan.row.id),
    );
    // Link cells (T401): junction rows, and the reverse cells of two-way links.
    const links = await this.applyLinks(s, linkPlan);
    // Record rule after the change on link cells (T710): every changed record.
    await this.checkEditRuleAfterWrite(
      s,
      changed.map((plan) => ({ index: plan.index, id: plan.row.id })),
      'You may only make changes that keep records within your edit rule.',
      'The change would move the record out of your edit rule',
    );
    // Sub-records (T405): no cycle, at most 10 levels, judged on the rows as written.
    const moved = [...parentChanges].filter(([, change]) => change.to !== null);
    if (moved.length > 0) {
      const paths = new Map(moved.map(([id, change]) => [id, change.path]));
      await assertTreeInvariants(
        s.tx,
        s.model.table,
        [...paths.keys()],
        (id) => paths.get(id) ?? 'records',
      );
    }
    const parentRefs = await this.parentValues(
      s,
      moved.map(([, change]) => change.to as string),
    );

    for (const plan of changed) {
      const before: JsonObject = {};
      const after: JsonObject = {};
      const changes: Record<string, { from: JsonValue; to: JsonValue }> = {};
      for (const [fieldId, change] of plan.diff) {
        before[fieldId] = change.from;
        after[fieldId] = change.to;
        changes[fieldId] = change;
      }
      const linkChanges = (links.byRecord.get(plan.row.id) ?? []).filter(
        (change) => change.changed,
      );
      for (const change of linkChanges) {
        before[change.field.id] = linkStored(change.from);
        after[change.field.id] = linkStored(change.to);
        changes[change.field.id] = { from: linkStored(change.from), to: linkStored(change.to) };
      }
      const parentChange = parentChanges.get(plan.row.id);
      const parentValue: Record<string, unknown> = {};
      const parentField = s.model.parent;
      if (parentChange !== undefined && parentField !== null) {
        before[parentField.id] = parentChange.from;
        after[parentField.id] = parentChange.to;
        changes[parentField.id] = { from: parentChange.from, to: parentChange.to };
        parentValue[parentField.id] =
          parentChange.to === null
            ? null
            : (parentRefs.get(parentChange.to) ?? { id: parentChange.to, title: null });
      }
      const eventId = this.recordChange(
        s,
        'record.updated',
        plan.row.id,
        plan.row.version + 1,
        changes,
        before,
        after,
      );
      if (s.capture === null) continue;
      // Images: rule fields and changed fields, before and after the write.
      const changedIds = [...plan.diff.keys()];
      const imaged = this.ruleFieldsOf(s, changedIds);
      const linkIds = linkChanges.map((change) => change.field.id);
      const post: StoredCells = new Map(plan.row.cells);
      for (const [fieldId, change] of plan.diff) post.set(fieldId, change.to);
      const system: SystemValues = {
        createdAt: plan.row.createdAt,
        updatedAt: s.now,
        createdBy: plan.row.createdBy,
        updatedBy: s.writer,
      };
      s.realtime.push({
        type: 'record.updated',
        recordId: plan.row.id,
        version: plan.row.version + 1,
        changedFieldIds: [...changedIds, ...linkIds, ...Object.keys(parentValue)] as Id<'fld'>[],
        eventId,
        before: {
          ...imageOf(imaged, plan.row.cells, systemOfLocked(plan.row)),
          ...linkImageOf(imageLinkCells.get(plan.row.id)),
        },
        after: {
          ...imageOf(imaged, post, system),
          ...linkImageOf(
            imageLinkCells.get(plan.row.id),
            Object.fromEntries(
              linkChanges.map((change) => [change.field.id, linkStored(change.to)]),
            ),
          ),
        },
        shown: imageOf(shownOnUpdate(s.model.fields, changedIds), post, system),
        linkValues: { ...links.values.get(plan.row.id), ...parentValue },
      });
    }
    if (changed.length > 0) s.changedData = true;
    // Titles shown by link cells elsewhere (T402): the primary field changed.
    const primary = s.model.fields.find((field) => field.isPrimary);
    if (primary !== undefined) {
      await this.fanOutLinks(
        s,
        'title',
        changed.filter((plan) => plan.diff.has(primary.id)).map((plan) => plan.row.id),
      );
    }
    return items.map((item) => (locked.get(item.id) as LockedRow).id);
  }

  /**
   * The changes of an update for the recompute (T458): records grouped by
   * the set of fields that changed on them (cells, link cells, `parent`).
   */
  private updatedComputedChanges(
    s: Session,
    changed: readonly PlannedUpdate[],
    linkPlan: LinkPlan,
    parentChanges: ReadonlyMap<string, unknown>,
  ): ComputedChange[] {
    const links = new Map<string, string[]>();
    for (const change of linkPlan.cells) {
      if (!change.changed) continue;
      links.set(change.recordId, [...(links.get(change.recordId) ?? []), change.field.id]);
    }
    const parentId = s.model.parent?.id;
    const groups = new Map<string, { fieldIds: string[]; ids: string[] }>();
    for (const plan of changed) {
      const fieldIds = [
        ...plan.diff.keys(),
        ...(links.get(plan.row.id) ?? []),
        ...(parentId !== undefined && parentChanges.has(plan.row.id) ? [parentId] : []),
      ].sort();
      const key = fieldIds.join(',');
      const group = groups.get(key) ?? { fieldIds, ids: [] };
      group.ids.push(plan.row.id);
      groups.set(key, group);
    }
    return [...groups.values()].map((group) => ({
      kind: 'records',
      baseId: s.model.table.base_id,
      tableId: s.model.table.id,
      recordIds: group.ids,
      event: 'updated',
      fieldIds: group.fieldIds,
    }));
  }

  // -------------------------------------------------------------------------
  // Delete / restore

  private async softDelete(
    s: Session,
    ids: readonly string[],
    requested: readonly string[],
    children: 'promote' | 'delete' = 'promote',
  ): Promise<Id<'rec'>[]> {
    const locked = await this.lockRows(s, ids);
    this.assertTargets(s, locked, requested, (row) => !row.deleted);
    const targets = ids.map((id) => locked.get(id) as LockedRow);
    if (s.model.parent !== null && children === 'delete') {
      // "Delete whole branch" (T405): descendants the caller may delete go too;
      // one they may not stops the branch there (it is promoted below).
      const roots = new Set<string>(targets.map((row) => row.id));
      const descendants = (await liveDescendantsOf(s.tx, s.model.table, [...roots])).filter(
        (row) => !roots.has(row.id),
      );
      const lockedBranch = await this.lockRows(
        s,
        descendants.map((row) => row.id),
      );
      const { kept } = walkBranch(roots, descendants, (row) => {
        const state = lockedBranch.get(row.id);
        return state !== undefined && !state.deleted && state.readable && state.editable;
      });
      for (const row of kept) targets.push(lockedBranch.get(row.id) as LockedRow);
    }
    // Computed fields reading these records (T458): rows keyed on them, found
    // while they are still live.
    const deletedChange: ComputedChange = {
      kind: 'records',
      baseId: s.model.table.base_id,
      tableId: s.model.table.id,
      recordIds: targets.map((row) => row.id),
      event: 'deleted',
    };
    await this.computedBefore(s, [deletedChange]);
    this.noteComputed(s, deletedChange);
    await sql`
      UPDATE ${this.tableRef(s.model.table)}
         SET __deleted_at = ${s.now.toISOString()}::timestamptz,
             __deleted_by = ${s.writer},
             __version = __version + 1
       WHERE __id = ANY(${sql.val(targets.map((row) => row.id))}::text[])
    `.execute(s.tx);
    const ruleFields = this.ruleFieldsOf(s);
    const linkCells = await this.sessionLinkCells(
      s,
      targets.map((row) => row.id),
    );
    for (const row of targets) {
      const eventId = this.recordChange(
        s,
        'record.deleted',
        row.id,
        row.version + 1,
        undefined,
        null,
        null,
      );
      if (s.capture === null) continue;
      s.realtime.push({
        type: 'record.deleted',
        recordId: row.id,
        version: row.version + 1,
        changedFieldIds: [],
        eventId,
        before: {
          ...imageOf(ruleFields, row.cells, systemOfLocked(row)),
          ...linkImageOf(linkCells.get(row.id)),
        },
        after: null,
        shown: {},
      });
    }
    s.changedData = true;
    // Link cells elsewhere stop showing these records (T402).
    await this.fanOutLinks(
      s,
      'removed',
      targets.map((row) => row.id),
    );
    if (s.model.parent !== null) {
      // "Promote children to root" (T405): live children left behind become roots.
      const deleted = new Set<string>(targets.map((row) => row.id));
      const orphans = (await liveChildrenOf(s.tx, s.model.table, [...deleted]))
        .filter((row) => !deleted.has(row.id))
        .map((row) => row.id);
      await this.promoteChildren(s, orphans);
    }
    return targets.map((row) => row.id);
  }

  private async restoreRows(
    s: Session,
    ids: readonly string[],
    requested: readonly string[],
    branch = false,
  ): Promise<Id<'rec'>[]> {
    const locked = await this.lockRows(s, ids);
    // ADR-23 §4 / CONTRACTS §11.3: a trashed record outside the caller's edit
    // rule is not in their trash at all, so restoring it is `404`, not `403`.
    this.assertTargets(s, locked, requested, (row) => row.deleted && row.editable);
    const targets = ids.map((id) => locked.get(id) as LockedRow);
    const indexOf = new Map(requested.map((id, index) => [id, index] as const));
    if (s.model.parent !== null && branch) {
      // "Restore whole branch" (T405): descendants deleted together with a record.
      const roots = new Set<string>(targets.map((row) => row.id));
      const members = (await trashedBranchOf(s.tx, s.model.table, [...roots])).filter(
        (row) => !roots.has(row.id),
      );
      const lockedBranch = await this.lockRows(
        s,
        members.map((row) => row.id),
      );
      const { kept } = walkBranch(roots, members, (row) => {
        const state = lockedBranch.get(row.id);
        return state !== undefined && state.deleted && state.readable && state.editable;
      });
      for (const row of kept) {
        targets.push(lockedBranch.get(row.id) as LockedRow);
        indexOf.set(row.id, indexOf.get(row.root) ?? 0);
      }
    }
    await this.checkUnique(
      s,
      targets.map((row) => ({
        path: () => formatIssuePath(['ids', indexOf.get(row.id) ?? 0]),
        id: row.id,
        cells: row.cells,
      })),
    );
    await sql`
      UPDATE ${this.tableRef(s.model.table)}
         SET __deleted_at = NULL, __deleted_by = NULL, __version = __version + 1
       WHERE __id = ANY(${sql.val(targets.map((row) => row.id))}::text[])
    `.execute(s.tx);
    this.noteComputed(s, {
      kind: 'records',
      baseId: s.model.table.base_id,
      tableId: s.model.table.id,
      recordIds: targets.map((row) => row.id),
      event: 'restored',
    });
    const ruleFields = this.ruleFieldsOf(s);
    const linkCells = await this.sessionLinkCells(
      s,
      targets.map((row) => row.id),
    );
    for (const row of targets) {
      const eventId = this.recordChange(
        s,
        'record.restored',
        row.id,
        row.version + 1,
        undefined,
        null,
        null,
      );
      if (s.capture === null) continue;
      s.realtime.push({
        type: 'record.restored',
        recordId: row.id,
        version: row.version + 1,
        changedFieldIds: [],
        eventId,
        before: null,
        after: {
          ...imageOf(ruleFields, row.cells, systemOfLocked(row)),
          ...linkImageOf(linkCells.get(row.id)),
        },
        shown: {},
      });
    }
    s.changedData = true;
    // Link cells elsewhere show these records again (T402).
    await this.fanOutLinks(
      s,
      'restored',
      targets.map((row) => row.id),
    );
    return targets.map((row) => row.id);
  }

  // -------------------------------------------------------------------------
  // Permanent delete (T408)

  private async purgeRows(
    s: Session,
    ids: readonly string[],
    requested: readonly string[],
    branch = false,
  ): Promise<Id<'rec'>[]> {
    const locked = await this.lockRows(s, ids);
    // Like restore: a record outside the caller's trash is `404`, never `403`.
    this.assertTargets(s, locked, requested, (row) => row.deleted && row.editable);
    const targets = ids.map((id) => locked.get(id) as LockedRow);
    if (s.model.parent !== null && branch) {
      // Descendants deleted together with a record ("delete whole branch", T405).
      const roots = new Set<string>(targets.map((row) => row.id));
      const members = (await trashedBranchOf(s.tx, s.model.table, [...roots])).filter(
        (row) => !roots.has(row.id),
      );
      const lockedBranch = await this.lockRows(
        s,
        members.map((row) => row.id),
      );
      const { kept } = walkBranch(roots, members, (row) => {
        const state = lockedBranch.get(row.id);
        return state !== undefined && state.deleted && state.readable && state.editable;
      });
      for (const row of kept) targets.push(lockedBranch.get(row.id) as LockedRow);
    }
    const { purged, eventId } = await this.hardDelete(s.scope, s.model.table, {
      ids: targets.map((row) => row.id),
      audit: s.audit,
      causation: s.causation,
      pending: s.pending,
      reason: 'manual',
      now: s.now,
    });
    this.noteComputed(s, {
      kind: 'records',
      baseId: s.model.table.base_id,
      tableId: s.model.table.id,
      recordIds: purged,
      event: 'purged',
    });
    if (s.capture !== null) {
      const ruleFields = this.ruleFieldsOf(s);
      for (const row of targets) {
        s.realtime.push({
          type: 'record.purged',
          recordId: row.id,
          version: row.version,
          changedFieldIds: [],
          eventId,
          before: imageOf(ruleFields, row.cells, systemOfLocked(row)),
          after: null,
          shown: {},
        });
      }
    }
    s.changedData = true;
    return purged;
  }

  /**
   * Deletes locked, trashed rows of `table` in the caller's transaction:
   * their files are marked for `attachments.cleanup` (never an object
   * deletion here: a rollback would lose files still referenced), then the
   * rows (junctions cascade, children become roots), then one
   * `record.purged` event + audit entry is queued.
   */
  private async hardDelete(
    scope: OrgScope,
    table: TableRow,
    input: {
      readonly ids: readonly Id<'rec'>[];
      readonly audit: AuditContext;
      readonly causation: Causation | undefined;
      readonly pending: PendingChanges;
      readonly reason: PurgeReason;
      readonly now: Date;
    },
  ): Promise<{ purged: Id<'rec'>[]; eventId: Id<'evt'> }> {
    const tx = scope.tx;
    if (tx === undefined) throw new TypeError('hardDelete needs a transaction');
    await this.attachments.markRecordsPurged(scope, table.id, input.ids, input.now);
    const deleted = new Set<string>(await deleteTrashedRows(tx, table, input.ids));
    const purged = input.ids.filter((id) => deleted.has(id));
    // ADR-32 §1 (T515): notifications about a purged record (the rendered
    // content of `automation.message`) go with it.
    await this.notifications.deleteByEntity(scope, 'record', purged);
    await this.follows.afterPurge(scope, table.id, purged);
    const summary = purgeSummary({
      table,
      ids: purged,
      audit: input.audit,
      causation: input.causation,
      reason: input.reason,
    });
    const eventId = newId('evt');
    input.pending.eventIds.push(eventId);
    input.pending.events.push(summary.event);
    input.pending.audits.push(summary.audit);
    return { purged, eventId };
  }

  /** Delete/restore targets: in the expected state and readable (else 404), editable (else 403). */
  private assertTargets(
    _s: Session,
    locked: ReadonlyMap<string, LockedRow>,
    requested: readonly string[],
    inState: (row: LockedRow) => boolean,
  ): void {
    const notFound: Issue[] = [];
    const forbidden: Issue[] = [];
    requested.forEach((id, index) => {
      const row = locked.get(id);
      const path = formatIssuePath(['ids', index]);
      if (row === undefined || !inState(row) || !row.readable) {
        notFound.push({ path, code: 'NOT_FOUND', message: 'The record does not exist' });
      } else if (!row.editable) {
        forbidden.push({
          path,
          code: 'PERMISSION_DENIED',
          message: 'You cannot change this record',
        });
      }
    });
    if (notFound.length > 0) {
      throw new AppError('NOT_FOUND', { detail: 'The record does not exist.', errors: notFound });
    }
    if (forbidden.length > 0) {
      throw new AppError('PERMISSION_DENIED', {
        detail: 'You cannot change these records.',
        errors: forbidden,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Rows, rules, uniqueness

  /**
   * Locks the rows `ids` (`FOR UPDATE`, in `__id` order so concurrent bulk
   * writes cannot deadlock) and evaluates the read and edit rules on their
   * current state in SQL (the record rule before the change).
   */
  private async lockRows(s: Session, ids: readonly string[]): Promise<Map<string, LockedRow>> {
    const wanted = [...new Set(ids.filter((id) => isId('rec', id)))];
    const result = new Map<string, LockedRow>();
    if (wanted.length === 0) return result;
    const { model } = s;
    const columns = model.fields.filter((field) => field.ownsColumn);
    const { rows } = await sql<Record<string, unknown>>`
      SELECT ${sql.id(ALIAS, '__id')} AS __id,
             ${sql.id(ALIAS, '__version')} AS __version,
             ${sql.id(ALIAS, '__created_at')} AS __created_at,
             ${sql.id(ALIAS, '__updated_at')} AS __updated_at,
             ${sql.id(ALIAS, '__created_by')} AS __created_by,
             ${sql.id(ALIAS, '__updated_by')} AS __updated_by,
             ${sql.id(ALIAS, '__deleted_at')} IS NOT NULL AS __deleted,
             (${ruleSql(s.readRule, model, ALIAS)}) AS __readable,
             (${ruleSql(s.editRule, model, ALIAS)}) AS __editable,
             ${model.parent === null ? sql`NULL::text` : sql.id(ALIAS, '__parent_id')} AS __parent
             ${sql.join(
               columns.map(
                 (field, index) =>
                   sql`, ${sql.id(ALIAS, field.column)} AS ${sql.id(`c${String(index)}`)}`,
               ),
               sql``,
             )}
        FROM ${this.tableRef(model.table)} AS ${sql.id(ALIAS)}
       WHERE ${sql.id(ALIAS, '__id')} = ANY(${sql.val(wanted)}::text[])
       ORDER BY ${sql.id(ALIAS, '__id')}
         FOR UPDATE OF ${sql.id(ALIAS)}
    `.execute(s.tx);
    for (const row of rows) {
      const cells: StoredCells = new Map();
      columns.forEach((field, index) => {
        cells.set(field.id, storedValueToJson(field.type, row[`c${String(index)}`]));
      });
      const id = row.__id as Id<'rec'>;
      result.set(id, {
        id,
        version: row.__version as number,
        createdAt: row.__created_at as Date,
        updatedAt: row.__updated_at as Date,
        createdBy: (row.__created_by as string | null) ?? null,
        updatedBy: (row.__updated_by as string | null) ?? null,
        deleted: row.__deleted === true,
        readable: row.__readable === true,
        editable: row.__editable === true,
        parentId: typeof row.__parent === 'string' ? row.__parent : null,
        cells,
      });
    }
    return result;
  }

  /** A record as `@cellhive/filter-dsl` evaluates it: storage form by field id, system fields included. */
  private evaluationImage(
    s: Session,
    cells: StoredCells,
    system: {
      readonly createdAt: Date;
      readonly updatedAt: Date;
      readonly createdBy: string | null;
      readonly updatedBy: string | null;
    },
  ): EvaluateRecord {
    const image: Record<string, unknown> = {};
    for (const field of s.model.fields) {
      switch (field.type) {
        case 'created_at':
          image[field.id] = system.createdAt;
          break;
        case 'updated_at':
          image[field.id] = system.updatedAt;
          break;
        case 'created_by':
          image[field.id] = system.createdBy;
          break;
        case 'updated_by':
          image[field.id] = system.updatedBy;
          break;
        default:
          image[field.id] = cells.get(field.id) ?? null;
      }
    }
    return image;
  }

  private matchesEditRule(s: Session, image: EvaluateRecord): boolean {
    const rule = s.editRule;
    if (rule === 'all') return true;
    if (rule === 'none') return false;
    // A rule on link cells is checked after the write (`checkEditRuleAfterWrite`).
    if (s.editRuleAfterWrite) return true;
    return evaluate(rule, image, { table: s.model.filterMeta, timeZone: s.access.timeZone });
  }

  /**
   * The edit rule on the rows as written (T710, CONTRACTS §14): a rule
   * naming a link field is evaluated in SQL — the planner's junction
   * subquery over the **live** linked records, as reads see them — once the
   * columns and the link cells of `records` are written in the
   * transaction. A record out of the rule fails the whole write (`403
   * RECORD_RULE_VIOLATION`, rolled back). No-op for other rules (checked in
   * memory before the write).
   */
  private async checkEditRuleAfterWrite(
    s: Session,
    records: readonly { readonly index: number; readonly id: string }[],
    detail: string,
    message: string,
  ): Promise<void> {
    if (!s.editRuleAfterWrite || records.length === 0) return;
    const ids = records.map((record) => record.id);
    const { rows } = await sql<{ __id: string }>`
      SELECT ${sql.id(ALIAS, '__id')} AS __id
        FROM ${this.tableRef(s.model.table)} AS ${sql.id(ALIAS)}
       WHERE ${sql.id(ALIAS, '__id')} = ANY(${sql.val(ids)}::text[])
         AND (${ruleSql(s.editRule, s.model, ALIAS)})
    `.execute(s.tx);
    const inRule = new Set(rows.map((row) => row.__id));
    const violations: Issue[] = records
      .filter((record) => !inRule.has(record.id))
      .map((record) => ({
        path: formatIssuePath(['records', record.index]),
        code: 'RECORD_RULE_VIOLATION',
        message,
      }));
    if (violations.length > 0) {
      throw new AppError('RECORD_RULE_VIOLATION', { detail, errors: violations });
    }
  }

  /**
   * SPEC §5.4 `unique_values`: the written non-empty values of each unique
   * field must not be used by another **live** record (the trash never
   * blocks) nor twice in the request. Compared by PostgreSQL with the
   * column's type and collation, as the partial unique index does. The
   * index stays the guarantee: a concurrent write caught only by it is
   * still `422 UNIQUE_VIOLATION` (see `translate`).
   */
  private async checkUnique(
    s: Session,
    writes: readonly {
      readonly path: (key: string) => string;
      readonly id: Id<'rec'>;
      readonly cells: StoredCells;
    }[],
  ): Promise<void> {
    const unique = s.model.fields.filter((field) => field.row.unique_values && field.ownsColumn);
    const errors: Issue[] = [];
    const ref = this.tableRef(s.model.table);
    for (const field of unique) {
      const entries = writes
        .map((write, position) => ({ write, position, value: write.cells.get(field.id) ?? null }))
        .filter((entry) => entry.value !== null);
      if (entries.length === 0) continue;
      const rows = entries.map((entry) => ({ __id: entry.write.id, [field.column]: entry.value }));
      const column = field.column;
      const { rows: hits } = await sql<{ ord: bigint | number | string }>`
        WITH x AS (
          SELECT p.__id AS id, p.${sql.id(column)} AS v, p.ordinality AS ord
            FROM jsonb_populate_recordset(NULL::${ref}, ${JSON.stringify(rows)}::jsonb)
                 WITH ORDINALITY AS p
        )
        SELECT x.ord FROM x
         WHERE EXISTS (
                 SELECT 1 FROM ${ref} AS ${sql.id(ALIAS)}
                  WHERE ${sql.id(ALIAS, '__deleted_at')} IS NULL
                    AND ${sql.id(ALIAS, column)} = x.v
                    AND ${sql.id(ALIAS, '__id')} <> ALL(${sql.val(entries.map((entry) => entry.write.id))}::text[])
               )
            OR EXISTS (SELECT 1 FROM x AS y WHERE y.v = x.v AND y.ord < x.ord)
         ORDER BY x.ord
      `.execute(s.tx);
      const key = this.keyOf(s, field) ?? field.id;
      for (const hit of hits) {
        const entry = entries[Number(hit.ord) - 1];
        if (entry === undefined) continue;
        errors.push({
          path: entry.write.path(key),
          code: 'UNIQUE_VIOLATION',
          message: 'This value is already used by another record',
        });
      }
    }
    if (errors.length > 0) {
      throw new AppError('UNIQUE_VIOLATION', {
        detail: 'Values must be unique in their field.',
        errors,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Upsert

  private mergeFields(s: Session, keys: readonly string[]): FieldModel[] {
    const errors: Issue[] = [];
    const fields: FieldModel[] = [];
    keys.forEach((key, index) => {
      const field = s.byKey.get(key);
      const path = formatIssuePath(['merge_on', index]);
      if (field === undefined) {
        errors.push({ path, code: 'UNKNOWN_FIELD', message: 'Field does not exist' });
      } else if (
        !MERGE_TYPES.has(field.type) ||
        (field.type === 'select' && (field.options as SelectOptions).multiple)
      ) {
        errors.push({
          path,
          code: 'MERGE_FIELD_NOT_ALLOWED',
          message: 'merge_on accepts text, number, single select and auto_number fields',
          params: { type: field.type },
        });
      } else if (fields.includes(field)) {
        errors.push({ path, code: 'DUPLICATE_FIELD', message: 'The field is listed twice' });
      } else {
        fields.push(field);
      }
    });
    if (errors.length > 0) {
      throw new AppError('VALIDATION_FAILED', { detail: 'merge_on is invalid.', errors });
    }
    return fields;
  }

  /**
   * Request index → id of the one live, readable record whose merge fields
   * equal the record's (storage form). Values that cannot be converted (or
   * name a select option that does not exist) match nothing; the record is
   * then created and validated as such.
   */
  private async matchRecords(
    s: Session,
    mergeFields: readonly FieldModel[],
    records: readonly { readonly fields: Readonly<Record<string, unknown>> }[],
  ): Promise<Map<number, Id<'rec'>>> {
    const locale = this.typecastLocale(s);
    const keyed: { index: number; values: JsonValue[] }[] = [];
    records.forEach((record, index) => {
      const values: JsonValue[] = [];
      for (const field of mergeFields) {
        const key = s.keyType === 'id' ? field.id : field.name;
        if (!Object.hasOwn(record.fields, key)) return;
        let value: unknown = record.fields[key];
        if (field.type === 'auto_number') {
          if (typeof value !== 'string' || value === '') return;
          values.push(value);
          continue;
        }
        if (s.typecast) {
          const cast = field.definition.typecast(value, field.options, locale);
          if (!cast.ok) return;
          value = cast.value;
        }
        if (!field.definition.validate(value, field.options).ok) return;
        const stored = storageToJson(field.definition.toStorage(value, field.options));
        if (stored === null) return;
        values.push(stored);
      }
      keyed.push({ index, values });
    });

    // The same key twice in the request is ambiguous too.
    const errors: Issue[] = [];
    const firstByKey = new Map<string, number>();
    for (const entry of keyed) {
      const signature = JSON.stringify(entry.values);
      if (firstByKey.has(signature)) {
        errors.push({
          path: formatIssuePath(['records', entry.index]),
          code: 'UPSERT_AMBIGUOUS',
          message: 'Another record of the request has the same merge values',
        });
      } else {
        firstByKey.set(signature, entry.index);
      }
    }
    if (errors.length > 0) {
      throw new AppError('UPSERT_AMBIGUOUS', {
        detail: 'Several records share the same merge values.',
        errors,
      });
    }
    const matches = new Map<number, Id<'rec'>>();
    if (keyed.length === 0) return matches;

    const ref = this.tableRef(s.model.table);
    const rows = keyed.map((entry) =>
      Object.fromEntries(
        mergeFields.map((field, position) => [field.column, entry.values[position] ?? null]),
      ),
    );
    const on = sql.join(
      mergeFields.map(
        (field) => sql<SqlBool>`${sql.id(ALIAS, field.column)} = x.${sql.id(field.column)}`,
      ),
      sql` AND `,
    );
    const { rows: found } = await sql<{ ord: bigint | number | string; id: Id<'rec'> }>`
      SELECT x.ordinality AS ord, ${sql.id(ALIAS, '__id')} AS id
        FROM jsonb_populate_recordset(NULL::${ref}, ${JSON.stringify(rows)}::jsonb) WITH ORDINALITY AS x
        JOIN ${ref} AS ${sql.id(ALIAS)} ON ${on}
       WHERE ${sql.id(ALIAS, '__deleted_at')} IS NULL
         AND (${ruleSql(s.readRule, s.model, ALIAS)})
       ORDER BY x.ordinality, ${sql.id(ALIAS, '__id')}
    `.execute(s.tx);
    const byOrd = new Map<number, Id<'rec'>[]>();
    for (const row of found) {
      const ord = Number(row.ord);
      const list = byOrd.get(ord) ?? [];
      list.push(row.id);
      byOrd.set(ord, list);
    }
    for (const [ord, ids] of byOrd) {
      const entry = keyed[ord - 1];
      if (entry === undefined) continue;
      if (ids.length > 1) {
        errors.push({
          path: formatIssuePath(['records', entry.index]),
          code: 'UPSERT_AMBIGUOUS',
          message: 'More than one record matches the merge values',
          params: { matches: ids.length },
        });
      } else {
        matches.set(entry.index, ids[0] as Id<'rec'>);
      }
    }
    if (errors.length > 0) {
      throw new AppError('UPSERT_AMBIGUOUS', {
        detail: 'More than one record matches the merge values.',
        errors,
      });
    }
    // Two request records matching the same existing record: ambiguous as well.
    const seen = new Map<string, number>();
    for (const [index, id] of [...matches].sort((a, b) => a[0] - b[0])) {
      if (seen.has(id)) {
        errors.push({
          path: formatIssuePath(['records', index]),
          code: 'UPSERT_AMBIGUOUS',
          message: 'Another record of the request matches the same record',
        });
      }
      seen.set(id, index);
    }
    if (errors.length > 0) {
      throw new AppError('UPSERT_AMBIGUOUS', {
        detail: 'Several records of the request match the same record.',
        errors,
      });
    }
    return matches;
  }

  // -------------------------------------------------------------------------
  // Events, audit, realtime

  /**
   * `record.*` event + audit entry (ADR-23 §2), buffered in the session and
   * written by {@link flushChanges} in the same transaction (a few multi-row
   * statements per request instead of three round trips per record);
   * realtime after commit.
   */
  private recordChange(
    s: Session,
    type: RecordChangeType,
    recordId: Id<'rec'>,
    version: number,
    changes: Record<string, { from: JsonValue; to: JsonValue }> | undefined,
    before: JsonObject | null,
    after: JsonObject | null,
    secondary = false,
  ): Id<'evt'> {
    return queueRecordChange(s.pending, s.model.table, s.audit, s.causation, {
      type,
      recordId,
      version,
      changes,
      before,
      after,
      secondary,
    });
  }

  /** Fields of the session's table in the images: record rule fields, plus `extra`. */
  private ruleFieldsOf(s: Session, extra: readonly Id<'fld'>[] = []): FieldModel[] {
    const rule = s.capture?.ruleFieldIds;
    if (rule === undefined) return [];
    const wanted = new Set<string>(extra);
    return s.model.fields.filter((field) => rule.has(field.id) || wanted.has(field.id));
  }

  /** Locale of `typecast` conversions: the base's (CONTRACTS §2), not the writer's. */
  private typecastLocale(s: Session): LocaleContext {
    return { locale: s.access.typecastLocale ?? s.access.locale, timeZone: s.access.timeZone };
  }

  // -------------------------------------------------------------------------
  // Computed fields (T458; logic in `computed/recompute/**`)

  /** Record changes of the session for the recompute of computed fields. */
  private noteComputed(s: Session, change: ComputedChange): void {
    if (change.kind === 'records' && change.recordIds.length === 0) return;
    s.computed.changes.push(change);
  }

  /**
   * The rows `changes` touch on the state before the write (`cross_table`
   * conditions on values being changed); call just before writing them.
   */
  private async computedBefore(s: Session, changes: readonly ComputedChange[]): Promise<void> {
    const wanted = changes.filter(
      (change) => change.kind !== 'records' || change.recordIds.length > 0,
    );
    if (wanted.length === 0) return;
    s.computed.before.push(...(await this.recompute.before(s.tx, s.scope.organizationId, wanted)));
  }

  /**
   * Hands the session's changes to `ComputedRecomputeService.enqueue` in its
   * transaction (before results are read back and before commit); fields
   * that went to the job get `schema.changed` after commit.
   */
  private async flushComputed(s: Session): Promise<void> {
    const { changes, before } = s.computed;
    if (changes.length === 0 && before.length === 0) return;
    const result = await this.recompute.enqueue(s.tx, {
      organizationId: s.scope.organizationId,
      changes: changes.splice(0),
      before: before.splice(0),
      source: recomputeSourceOf(s.audit, s.causation, s.pending),
    });
    s.schemaChanges.push(...computedStateChanges(s.scope.organizationId, result));
  }

  /**
   * `enqueue` for system writes outside a session (worker batches): the
   * `schema.changed` of fields sent to the job is published after commit.
   */
  private async enqueueComputed(
    tx: Tx,
    organizationId: Id<'org'>,
    changes: readonly ComputedChange[],
    source?: RecomputeSource,
  ): Promise<void> {
    const wanted = changes.filter(
      (change) => change.kind !== 'records' || change.recordIds.length > 0,
    );
    if (wanted.length === 0) return;
    const result = await this.recompute.enqueue(tx, {
      organizationId,
      changes: wanted,
      ...(source === undefined ? {} : { source }),
    });
    const published = computedStateChanges(organizationId, result);
    if (published.length > 0) {
      afterCommit(tx, async () => {
        try {
          await this.schema.publishCommitted(published);
        } catch (error) {
          this.onPublishError(error);
        }
      });
    }
  }

  /** Writes the buffered events (with their dispatch jobs) and audit entries. */
  private async flushChanges(s: Session): Promise<void> {
    await this.flushPending(s.tx, s.pending);
  }

  private async flushPending(tx: Tx, pending: PendingChanges): Promise<void> {
    const { events, eventIds, audits } = pending;
    if (events.length > 0) await this.events.writeMany(tx, withBatchSizes(pending), eventIds);
    if (audits.length > 0) await this.auditWriter.writeMany(tx, audits);
    events.length = 0;
    eventIds.length = 0;
    audits.length = 0;
    pending.primary.clear();
  }
}

/** `schema.changed` (field `updated`) of fields whose `compute_state` changed (T458). */
function computedStateChanges(
  organizationId: Id<'org'>,
  result: ComputedRecomputeResult,
): SchemaChange[] {
  return result.stateChanged.map((item) => ({
    organization_id: organizationId,
    base_id: item.baseId,
    table_id: item.tableId,
    entity: 'field',
    entity_id: item.fieldId,
    action: 'updated',
  }));
}

/** Events and audit entries not written yet (flushed before commit). */
interface PendingChanges {
  readonly events: EventInput[];
  readonly eventIds: Id<'evt'>[];
  readonly audits: AuditEntryInput[];
  /**
   * Records the call itself changed (ADR-26 §1 `batch.size`): not the
   * reverse link cells of other records nor children detached from a
   * deleted parent, which only follow the change.
   */
  readonly primary: Set<string>;
}

function emptyPendingChanges(): PendingChanges {
  return { events: [], eventIds: [], audits: [], primary: new Set() };
}

/**
 * The pending events with `batch.size` set (ADR-26 §1): every `record.*`
 * event of one call carries the number of records the call changed.
 */
function withBatchSizes(pending: PendingChanges): EventInput[] {
  const size = batchSizeOf(pending);
  return pending.events.map((event) =>
    event.batch === undefined ? event : { ...event, batch: { id: event.batch.id, size } },
  );
}

/** `batch.size` of the record events of a call (ADR-26 §1): what {@link withBatchSizes} sets. */
function batchSizeOf(pending: PendingChanges): number {
  return Math.max(
    1,
    pending.primary.size > 0
      ? pending.primary.size
      : pending.events.filter((event) => event.batch !== undefined).length,
  );
}

/**
 * The write a recompute follows (T509, S4b-decisions-followup §3.4): the
 * events of recomputed values carry its `batch` (same id and size as its
 * own record events), `via` and causation — an automation's, else rooted
 * at the write's first event (`null` pending: a system write without
 * events of its own, `size` records).
 */
function recomputeSourceOf(
  audit: AuditContext,
  causation: Causation | undefined,
  pending: PendingChanges | null,
  size?: number,
): RecomputeSource {
  const batchId = batchIdOf(audit);
  const first = pending?.eventIds[0];
  const rooted =
    causation ??
    (first === undefined ? undefined : { root_event_id: first, depth: 0, automation_chain: [] });
  // Synchronous recompute of records the call itself changed (T509): their
  // computed changes join the call's own `record.updated`, one event per record.
  const fold: RecomputeSource['fold'] =
    pending === null
      ? undefined
      : ({ tableId, recordId, changes }) => {
          if (!pending.primary.has(recordId)) return false;
          const index = pending.events.findLastIndex(
            (event) =>
              event.type === 'record.updated' &&
              event.entityId === recordId &&
              event.tableId === tableId,
          );
          const event = pending.events[index];
          if (event === undefined) return false;
          pending.events[index] = { ...event, changes: { ...event.changes, ...changes } };
          return true;
        };
  return {
    ...(fold === undefined ? {} : { fold }),
    ...(batchId === null
      ? {}
      : {
          batch: {
            id: batchId,
            size: Math.max(1, size ?? (pending === null ? 1 : batchSizeOf(pending))),
          },
        }),
    ...(audit.via === null ? {} : { via: audit.via }),
    ...(rooted === undefined ? {} : { causation: rooted }),
  };
}

/** `batch.id` of the events of a change: its audit batch, else its request (ADR-26 §1). */
function batchIdOf(audit: AuditContext): EventBatch['id'] | null {
  return audit.batch_id ?? audit.request_id;
}

/**
 * Queues the event + audit entry of one record change in `pending` and
 * returns the (pre-generated) event id.
 */
function queueRecordChange(
  pending: PendingChanges,
  table: TableRow,
  audit: AuditContext,
  causation: Causation | undefined,
  change: {
    readonly type: RecordChangeType;
    readonly recordId: Id<'rec'>;
    readonly version: number;
    readonly changes: Record<string, { from: JsonValue; to: JsonValue }> | undefined;
    readonly before: JsonObject | null;
    readonly after: JsonObject | null;
    /** A change that only follows another one of the call (reverse link cell, detached child). */
    readonly secondary?: boolean;
  },
): Id<'evt'> {
  const eventId = newId('evt');
  pending.eventIds.push(eventId);
  if (change.secondary !== true) pending.primary.add(change.recordId);
  const batchId = batchIdOf(audit);
  pending.events.push({
    type: change.type,
    organizationId: table.organization_id,
    entityId: change.recordId,
    actor: audit.actor,
    baseId: table.base_id,
    tableId: table.id,
    ...(change.changes === undefined ? {} : { changes: change.changes }),
    recordVersion: change.version,
    ...(causation === undefined ? {} : { causation }),
    // The size is the number of records of the whole call, set when flushed.
    ...(batchId === null ? {} : { batch: { id: batchId, size: 1 } }),
    ...(audit.via === null ? {} : { via: audit.via }),
  });
  pending.audits.push({
    action: change.type,
    organizationId: table.organization_id,
    baseId: table.base_id,
    tableId: table.id,
    entityType: 'record',
    entityId: change.recordId,
    before: change.before,
    after: change.after,
    context: audit,
  });
  return eventId;
}

// ---------------------------------------------------------------------------
// Realtime images (T210)

/** Actor of recomputes run by jobs. */
const SYSTEM_ACTOR: Actor = { type: 'system', id: null };

/** A row read for images: record columns and `c<i>` per column-owning field. */
interface ImageRow {
  readonly __id: Id<'rec'>;
  readonly __version: number;
  readonly __deleted: boolean;
  readonly __created_at: Date;
  readonly __updated_at: Date;
  readonly __created_by: string | null;
  readonly __updated_by: string | null;
  readonly [column: `c${string}`]: unknown;
}

/** Select list of an {@link ImageRow} over the data table aliased `t`. */
function imageColumns(fields: readonly FieldModel[]): RawBuilder<unknown> {
  const owned = fields.filter((field) => field.ownsColumn);
  return sql`${sql.id(ALIAS, '__id')} AS __id,
             ${sql.id(ALIAS, '__version')} AS __version,
             ${sql.id(ALIAS, '__deleted_at')} IS NOT NULL AS __deleted,
             ${sql.id(ALIAS, '__created_at')} AS __created_at,
             ${sql.id(ALIAS, '__updated_at')} AS __updated_at,
             ${sql.id(ALIAS, '__created_by')} AS __created_by,
             ${sql.id(ALIAS, '__updated_by')} AS __updated_by
             ${sql.join(
               owned.map(
                 (field, index) =>
                   sql`, ${sql.id(ALIAS, field.column)} AS ${sql.id(`c${String(index)}`)}`,
               ),
               sql``,
             )}`;
}

/** Storage-form cells of the column-owning `fields` of an {@link ImageRow}. */
function imageCells(row: ImageRow, fields: readonly FieldModel[]): StoredCells {
  const cells: StoredCells = new Map();
  fields
    .filter((field) => field.ownsColumn)
    .forEach((field, index) => {
      cells.set(field.id, storedValueToJson(field.type, row[`c${String(index)}`]));
    });
  return cells;
}

function systemOfRow(row: ImageRow): SystemValues {
  return {
    createdAt: row.__created_at,
    updatedAt: row.__updated_at,
    createdBy: row.__created_by ?? null,
    updatedBy: row.__updated_by ?? null,
  };
}

function systemOfLocked(row: LockedRow): SystemValues {
  return {
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
  };
}

/**
 * Storage-form image of `fields` (as `@cellhive/filter-dsl` evaluates it and
 * CONTRACTS §8 `changes` store it): created/updated at/by from the record's
 * system columns, every other field from `cells`.
 */
function imageOf(
  fields: readonly FieldModel[],
  cells: ReadonlyMap<Id<'fld'>, JsonValue>,
  system: SystemValues,
): Record<string, JsonValue> {
  const image: Record<string, JsonValue> = {};
  for (const field of fields) {
    switch (field.type) {
      case 'created_at':
        image[field.id] = system.createdAt.toISOString();
        break;
      case 'updated_at':
        image[field.id] = system.updatedAt.toISOString();
        break;
      case 'created_by':
        image[field.id] = system.createdBy;
        break;
      case 'updated_by':
        image[field.id] = system.updatedBy;
        break;
      default:
        image[field.id] = cells.get(field.id) ?? null;
    }
  }
  return image;
}

/** Fields whose values a `record.updated` shows: the changed ones and `updated_at`/`updated_by`. */
function shownOnUpdate(fields: readonly FieldModel[], changed: readonly Id<'fld'>[]): FieldModel[] {
  const wanted = new Set<string>(changed);
  return fields.filter(
    (field) => wanted.has(field.id) || field.type === 'updated_at' || field.type === 'updated_by',
  );
}

/** An update of the request (or the update half of an upsert). */
interface UpdateItem extends WriteItem {
  readonly id: string;
  readonly version: number | undefined;
}

function toIssues(path: string, issues: readonly ValueIssue[]): Issue[] {
  return issues.map((issue) => ({
    path,
    code: issue.code,
    message: issue.message,
    ...(issue.params === undefined ? {} : { params: { ...issue.params } }),
  }));
}

/** Codes of `valueError` (the checks an import runs all of, T421b). */
const VALUE_ERROR_CODES: ReadonlySet<string> = new Set([
  'INVALID_SELECT_OPTION',
  'INVALID_CELL_VALUE',
  'LINK_TARGET_NOT_FOUND',
]);

/** Detail codes of a linked record (or parent) a write could not resolve (T401, T411). */
const LINK_TARGET_CODES: ReadonlySet<string> = new Set([
  'LINK_TARGET_NOT_FOUND',
  'LINK_TARGET_AMBIGUOUS',
]);

/**
 * `INVALID_SELECT_OPTION` when every issue is a missing option,
 * `LINK_TARGET_NOT_FOUND` when every issue is a missing linked record (T401;
 * or an ambiguous title of an import cell, T411), else `INVALID_CELL_VALUE`.
 */
function valueError(issues: readonly Issue[]): AppError {
  const onlyOptions = issues.every((issue) => issue.code === 'INVALID_SELECT_OPTION');
  if (!onlyOptions && issues.every((issue) => LINK_TARGET_CODES.has(issue.code))) {
    return new AppError('LINK_TARGET_NOT_FOUND', {
      detail: 'Linked records do not exist.',
      errors: issues,
    });
  }
  return new AppError(onlyOptions ? 'INVALID_SELECT_OPTION' : 'INVALID_CELL_VALUE', {
    detail: onlyOptions ? 'Select options do not exist.' : 'Some cell values are invalid.',
    errors: issues,
  });
}

/**
 * Link cells of an image (T402): `cells` (storage form by field id) with
 * `overrides` applied to the fields present in `cells`.
 */
function linkImageOf(
  cells: ReadonlyMap<Id<'fld'>, JsonValue> | undefined,
  overrides: Readonly<Record<string, JsonValue>> = {},
): Record<string, JsonValue> {
  const image: Record<string, JsonValue> = {};
  for (const [fieldId, value] of cells ?? []) {
    image[fieldId] = Object.hasOwn(overrides, fieldId) ? (overrides[fieldId] ?? null) : value;
  }
  return image;
}

/** Link cell changes by record and the json link values to publish (T401). */
interface AppliedLinks {
  readonly byRecord: ReadonlyMap<string, readonly LinkCellChange[]>;
  readonly values: ReadonlyMap<string, Record<string, unknown>>;
}

function groupByField(changes: readonly LinkCellChange[]): Map<LinkFieldModel, LinkCellChange[]> {
  const groups = new Map<LinkFieldModel, LinkCellChange[]>();
  for (const change of changes) {
    groups.set(change.field, [...(groups.get(change.field) ?? []), change]);
  }
  return groups;
}

function userIdsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) =>
    typeof entry === 'object' && entry !== null && 'id' in entry && typeof entry.id === 'string'
      ? [entry.id]
      : [],
  );
}

function isValidOptionName(name: string): boolean {
  return selectOptionSchema.safeParse({ id: 'opt_0000000000000000', name }).success;
}
