import type { BaseSchemaRows } from '../../computed/definition/schema-rows.js';
import type { JsonObject } from '../../db/schema.js';
import type { PackageLoadBatch } from '../../records/record-mutation.service.js';
import type {
  ImportComputedFieldInput,
  ImportFieldAiInput,
  ImportLinkFieldInput,
  ImportLinkRecordFilterInput,
  ImportTableInput,
} from '../../schema/schema.service.js';
import type { PackageMember } from '../users.js';
import type { BaseImportPhase, BaseImportResult, Id } from '@cellhive/contracts';
import type { Readable } from 'node:stream';

/**
 * Where a `.chbase` import writes (CONTRACTS §12.2): the hidden base of one
 * `base.import` job in its organization. `DbBaseImportTarget`
 * (`db-target.ts`) is the database, the object storage and the job row;
 * tests wrap it to fail at a chosen step.
 *
 * Every write goes through the services of the golden rules (DDL through
 * `SchemaService`, records through `RecordMutationService`), only into a
 * base whose `import_job_id` is the job.
 */
export interface BaseImportTarget {
  /** Members of the target organization: the only users emails may become. */
  members(): Promise<readonly PackageMember[]>;
  /** Creates the hidden base (system roles included); returns its id. */
  createBase(input: ImportBaseInput): Promise<Id<'bse'>>;
  createTable(baseId: Id<'bse'>, input: ImportTableInput): Promise<void>;
  createLink(baseId: Id<'bse'>, input: ImportLinkFieldInput): Promise<void>;
  /** Stores one file of a cell (its row first, then the object, then `ready`). */
  storeFile(baseId: Id<'bse'>, file: ImportStoredFile, content: Readable): Promise<void>;
  /** One batch of records, junction rows or parents (`loadPackageBatch`). */
  load(baseId: Id<'bse'>, batch: PackageLoadBatch): Promise<number>;

  // --- What pass 1 deferred (T1019): every object checked by the step that creates it ---

  /** Tables and active fields of the hidden base as they are now (the checks of later steps). */
  schemaRows(baseId: Id<'bse'>): Promise<BaseSchemaRows>;
  /** A formula or lookup field (`SchemaService.importComputedField`); whether it is stored. */
  createComputedField(baseId: Id<'bse'>, input: ImportComputedFieldInput): Promise<boolean>;
  /** Computes the column of a stored formula/lookup field on every record, then `ready`. */
  backfillComputed(baseId: Id<'bse'>, fieldId: Id<'fld'>): Promise<void>;
  /** `options.ai` of a text/select field (`SchemaService.importFieldAi`); nothing queued. */
  setFieldAi(baseId: Id<'bse'>, input: ImportFieldAiInput): Promise<void>;
  /** A link `record_filter` naming a field created later (`SchemaService.importLinkRecordFilter`). */
  setLinkFilter(baseId: Id<'bse'>, input: ImportLinkRecordFilterInput): Promise<void>;
  /**
   * The shared views of a table (configs checked), in place of the default
   * view `importTable` gave it; nothing when `views` is empty (the default
   * view stays).
   */
  createViews(
    baseId: Id<'bse'>,
    tableId: Id<'tbl'>,
    views: readonly ImportViewInput[],
  ): Promise<void>;
  /** The cover image of a form view (its row first, then the object, then `ready`). */
  storeFormCover(baseId: Id<'bse'>, file: ImportStoredCover, content: Readable): Promise<void>;
  /** A dashboard and its widgets (configs checked). */
  createDashboard(baseId: Id<'bse'>, input: ImportDashboardInput): Promise<void>;
  /** A custom role (config checked), assigned to nobody. */
  createRole(baseId: Id<'bse'>, input: ImportRoleInput): Promise<void>;
  /** An automation, off, `run_as` and `created_by` the importer. */
  createAutomation(baseId: Id<'bse'>, input: ImportAutomationInput): Promise<void>;
  /** An image of the body of an imported automation's email (row, object, `ready`). */
  storeEmailAsset(
    baseId: Id<'bse'>,
    file: ImportStoredEmailAsset,
    content: Readable,
  ): Promise<void>;

  /** Throws {@link BaseImportStopped} when the job no longer runs (cancelled meanwhile). */
  checkpoint(): Promise<void>;
  progress(progress: number, phase: BaseImportPhase): Promise<void>;
  /**
   * In one transaction: the base becomes visible, `base.created` and
   * `base.imported` are recorded, thumbnails of the imported images are
   * queued and the job succeeds with `result`.
   */
  finish(baseId: Id<'bse'>, result: BaseImportResult, counts: ImportAuditCounts): Promise<void>;
  /** Purges the hidden base of the job, its files included; nothing when there is none. */
  purge(): Promise<void>;
}

export interface ImportBaseInput {
  readonly name: string;
  readonly description: string | null;
  readonly icon: string | null;
  readonly settings: Record<string, unknown>;
}

/** A file of a cell, with the ids of the new base. */
export interface ImportStoredFile {
  readonly id: Id<'att'>;
  readonly tableId: Id<'tbl'>;
  readonly fieldId: Id<'fld'>;
  readonly recordId: Id<'rec'>;
  readonly filename: string;
  readonly mime: string;
  readonly size: number;
  readonly sha256: string;
}

/** A shared view of a package, its config checked (`StoredViewConfig`). */
export interface ImportViewInput {
  readonly id: Id<'viw'>;
  readonly type: 'grid' | 'kanban' | 'form';
  readonly name: string;
  /** Rank among the shared views of the table. */
  readonly position: number;
  readonly locked: boolean;
  readonly config: JsonObject;
}

/** The cover image of a form view, with the ids of the new base. */
export interface ImportStoredCover {
  readonly id: Id<'att'>;
  readonly tableId: Id<'tbl'>;
  readonly viewId: Id<'viw'>;
  readonly filename: string;
  readonly mime: string;
  readonly size: number;
  readonly sha256: string;
}

/** A dashboard of a package, checked, with its widgets. */
export interface ImportDashboardInput {
  readonly id: Id<'dsh'>;
  readonly name: string;
  readonly icon: string | null;
  readonly description: string | null;
  readonly theme: JsonObject;
  readonly globalFilters: readonly JsonObject[];
  /** Rank among the dashboards of the base. */
  readonly position: number;
  readonly widgets: readonly {
    readonly id: Id<'wgt'>;
    readonly type: string;
    readonly title: string;
    readonly config: JsonObject;
    readonly layout: JsonObject;
  }[];
}

/** A custom role of a package, its config checked. */
export interface ImportRoleInput {
  readonly id: Id<'rol'>;
  readonly name: string;
  readonly config: JsonObject;
}

/** An automation of a package: its definition parsed, every detached slot `null`. */
export interface ImportAutomationInput {
  readonly id: Id<'aut'>;
  readonly name: string;
  readonly description: string;
  readonly definition: JsonObject;
  readonly triggerType: string;
  readonly triggerTableId: Id<'tbl'> | null;
}

/** An image of an automation's email body, with the ids of the new base. */
export interface ImportStoredEmailAsset {
  readonly id: Id<'att'>;
  readonly automationId: Id<'aut'>;
  readonly filename: string;
  readonly mime: string;
  readonly size: number;
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
}

/** What `base.imported` records (counts only, never a value). */
export interface ImportAuditCounts {
  readonly tables: number;
  readonly fields: number;
  readonly records: number;
  readonly links: number;
  readonly attachments: number;
}

/**
 * The job of an import stopped running while it built the base (it was
 * cancelled, or failed elsewhere): the import stops, its base is purged,
 * the job keeps the status it has.
 */
export class BaseImportStopped extends Error {
  constructor() {
    super('The base import job no longer runs');
    this.name = 'BaseImportStopped';
  }
}
