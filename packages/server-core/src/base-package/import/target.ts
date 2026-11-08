import type { PackageLoadBatch } from '../../records/record-mutation.service.js';
import type { ImportLinkFieldInput, ImportTableInput } from '../../schema/schema.service.js';
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
