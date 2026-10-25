import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import {
  IMPORT_BATCH_SIZE,
  IMPORT_MAX_ROWS,
  IMPORT_REPORT_MAX_ERRORS,
  IMPORT_REPORT_TTL_HOURS,
  IMPORT_RESULT_ERRORS,
  problemTitle,
  problemTypeUri,
  type Id,
  type ImportCell,
  type ImportJobResult,
  type ImportRowError,
  type ProblemErrorItem,
} from '@cellhive/contracts';

import { csvCell, exportDownloadPath } from '../audit/audit-export.js';
import { isIndexRowTooLarge, uniqueValueTooLongError } from '../db/pg-errors.js';
import { orgScope } from '../db/repository.js';
import { AppError } from '../errors/app-error.js';
import { FieldsRepository } from '../schema/fields.repository.js';
import { TablesRepository } from '../schema/tables.repository.js';

import { importFileError } from './file-errors.js';
import { openImportFile, type ImportFile } from './import-file.js';
import {
  importedRecordCount,
  notifyImportFinished,
  type ImportFinishedNotice,
} from './import-finished.js';
import { checkAppendImport, checkCreateTableImport, type ImportSpec } from './import-target.js';
import { importReportKey, importUploadKey } from './keys.js';
import { resolveMemberBaseAccess, type AccessDefaults } from './member-access.js';

import type { ImportsRepository } from './imports.repository.js';
import type { StoredImportOptions } from './preview.js';
import type { XlsxLimits } from './xlsx-reader.js';
import type { AuditContext } from '../audit/audit-entry.js';
import type { Db, Tx } from '../db/create-db.js';
import type { JsonObject } from '../db/schema.js';
import type { JobProblem, JobsRepository } from '../jobs/jobs.repository.js';
import type { RecordMutationService } from '../records/record-mutation.service.js';
import type { SchemaService } from '../schema/schema.service.js';
import type { StorageDriver } from '../storage/storage-driver.js';

/** Payload of the `table.import` job (CONTRACTS §12.2, §19). Never cell values. */
export interface TableImportPayload {
  readonly organization_id: Id<'org'>;
  readonly job_id: Id<'job'>;
  readonly import_id: Id<'imp'>;
  readonly base_id: Id<'bse'>;
  readonly user_id: Id<'usr'>;
  /** Started through this API token of `user_id` (T705): its writes carry `via.api_token_id`. */
  readonly api_token_id?: Id<'tok'>;
  readonly spec: ImportSpec;
}

export interface TableImportDeps {
  readonly db: Db;
  readonly schema: Pick<SchemaService, 'createTable' | 'addField' | 'deleteTable'>;
  readonly records: Pick<RecordMutationService, 'create'>;
  readonly jobs: Pick<JobsRepository, 'getById' | 'setProgress' | 'markSucceeded' | 'markFailed'>;
  readonly imports: Pick<ImportsRepository, 'getById' | 'mergeOptions'>;
  readonly storage: Pick<StorageDriver, 'getStream' | 'put' | 'delete'>;
  readonly defaults: AccessDefaults;
  /** `MAX_FIELDS_PER_TABLE`. */
  readonly maxFieldsPerTable: number;
  /** Records per transaction (default `IMPORT_BATCH_SIZE`; tests lower it). */
  readonly batchSize?: number;
  /** Row cap (default `IMPORT_MAX_ROWS`); only benchmarks raise it. */
  readonly maxRows?: number;
  readonly xlsxLimits?: XlsxLimits;
  readonly now?: () => Date;
  /** Called after each committed batch (metrics, tests). */
  readonly onBatch?: (stats: { readonly rows: number; readonly imported: number }) => void;
}

/** How a run ended; `stats` for logs (counters only, never values). */
export interface TableImportOutcome {
  readonly status: 'succeeded' | 'failed' | 'cancelled';
  readonly rows: number;
  readonly imported: number;
  readonly failed: number;
  readonly batches: number;
  /** Error code of a failed run. */
  readonly code?: string;
  /** The table the run created and then moved to the trash (failed or cancelled). */
  readonly tableTrashed?: boolean;
  /** The unexpected error behind a failed run (for the log; not an `AppError`). */
  readonly cause?: unknown;
}

/** Top-level codes whose `errors[]` name the records at fault: those rows are skipped. */
const ROW_ERROR_CODES: ReadonlySet<string> = new Set([
  'INVALID_CELL_VALUE',
  'INVALID_SELECT_OPTION',
  'REQUIRED_FIELD_MISSING',
  'UNIQUE_VIOLATION',
  'RECORD_RULE_VIOLATION',
  // Link and parent cells (T411): row codes `LINK_TARGET_NOT_FOUND`, `LINK_TARGET_AMBIGUOUS`.
  'LINK_TARGET_NOT_FOUND',
  'SUBRECORD_TOO_DEEP',
]);

const RECORD_PATH = /^records\[(\d+)\](?:\.fields\.(.+))?$/;

/** The job was cancelled (seen before a batch): stop without writing more. */
class Cancelled extends Error {
  constructor() {
    super('the import was cancelled');
  }
}

function problemOf(error: unknown): JobProblem {
  if (error instanceof AppError) {
    return {
      type: problemTypeUri(error.code),
      title: problemTitle(error.code),
      status: error.status,
      code: error.code,
      ...(error.detail === undefined ? {} : { detail: error.detail }),
      ...(error.errors === undefined
        ? {}
        : { errors: error.errors.map((item) => ({ ...item }) as unknown as JsonObject) }),
    };
  }
  return {
    type: 'https://cellhive.io/errors/INTERNAL',
    title: 'Internal error',
    status: 500,
    code: 'INTERNAL',
    detail: 'The import failed; start a new one.',
  };
}

/** Rows of a batch waiting to be written. */
interface PendingRow {
  readonly line: number;
  /** 1-based number of the data row (as the preview numbers them). */
  readonly index: number;
  readonly fields: Record<string, ImportCell>;
}

/** A cell as the error report writes it (CSV text); `null` = empty. */
function reportValue(cell: ImportCell | undefined): string | null {
  if (cell === undefined || cell === null) return null;
  return typeof cell === 'string' ? cell : String(cell);
}

/**
 * Runs one `table.import` job whose `meta.jobs` row is already `running`
 * (the worker task took the organization slot, ADR-18):
 *
 * 1. resolves the importer's **current** access to the base and checks the
 *    import again exactly like the API did (`checkCreateTableImport` /
 *    `checkAppendImport`);
 * 2. create mode: creates the table and its fields through `SchemaService`
 *    (the first column is the primary field), audited with the job as
 *    `batch_id` and `via.import_job_id`;
 * 3. streams the uploaded file from object storage into a temporary file
 *    and reads it row by row (never all in memory) with the options of the
 *    last preview;
 * 4. writes batches of ≤ 1 000 records through `RecordMutationService.create`
 *    (`typecast`, base locale; each batch one transaction with its events,
 *    audit entries — `batch_id = job_…`, `via.import_job_id` — and one
 *    realtime publication, so subscribers get `record.batch`); link and
 *    `parent` cells are titles (`importCells`, T411). Rows the
 *    service rejects (`INVALID_CELL_VALUE`, `REQUIRED_FIELD_MISSING`,
 *    `UNIQUE_VIOLATION`…) are dropped from the batch and reported with their
 *    row, column and code; the batch is written without them;
 * 5. between batches: progress (`job.progress`) and cancellation;
 * 6. ends `succeeded` with the result (first 100 row errors, a CSV report
 *    of all of them), or `failed` with a problem document. A failed or
 *    cancelled create-mode import moves its new table to the trash;
 * 7. `import.finished` for the importer (T548, ADR-34 §4) is queued in the
 *    transaction of the final state (`succeeded`, `failed`), or — for a job
 *    cancelled while it ran — once the run stops, with its counters
 *    (`group_key = job_id`: never twice).
 *
 * The uploaded file is deleted from storage when the run ends.
 */
export async function runTableImport(
  deps: TableImportDeps,
  payload: TableImportPayload,
): Promise<TableImportOutcome> {
  const scope = orgScope(payload.organization_id);
  const jobId = payload.job_id;
  const context = importContext(payload);
  const stats = { rows: 0, imported: 0, failed: 0, batches: 0 };
  let createdTable: Id<'tbl'> | undefined;
  /** The table imported into, once known (append: the target; create: the new one). */
  let targetTable: Id<'tbl'> | undefined =
    payload.spec.mode === 'append' ? payload.spec.table_id : undefined;
  let file: ImportFile | undefined;
  let tmp: string | undefined;

  const trashCreatedTable = async (): Promise<boolean> => {
    if (createdTable === undefined) return false;
    try {
      await deps.schema.deleteTable(scope, createdTable, context);
      return true;
    } catch {
      return false;
    }
  };

  /** `import.finished` for the importer (T548), with this run's counters. */
  const notice = (
    status: ImportFinishedNotice['status'],
    tableTrashed: boolean,
  ): ImportFinishedNotice => ({
    organizationId: payload.organization_id,
    jobId,
    baseId: payload.base_id,
    tableId: tableTrashed ? null : (targetTable ?? null),
    userId: payload.user_id,
    status,
    created: stats.imported,
    updated: 0,
    failedRows: stats.failed,
  });

  /**
   * The job was cancelled (`POST …/cancel` moved it to `cancelled` while it
   * ran): this run is the one that finishes it, so it notifies — in a
   * transaction that sees the job still `cancelled`.
   */
  const notifyCancelled = (tableTrashed: boolean): Promise<void> =>
    deps.db.withTx(async (tx) => {
      const job = await deps.jobs.getById(orgScope(payload.organization_id, tx), jobId);
      if (job?.status === 'cancelled') {
        await notifyImportFinished(tx, notice('cancelled', tableTrashed));
      }
    });

  try {
    const upload = await deps.imports.getById(scope, payload.import_id);
    if (upload?.job_id !== jobId || upload.base_id !== payload.base_id) {
      throw new AppError('NOT_FOUND', { detail: 'The uploaded file is gone.' });
    }
    const options = upload.options as unknown as StoredImportOptions;
    const columnNames = Array.isArray(options.columns) ? options.columns : [];

    // 1–2. Access and target.
    let access = await resolveMemberBaseAccess(
      deps.db,
      scope,
      { userId: payload.user_id, baseId: payload.base_id },
      deps.defaults,
    );
    if (access === undefined) throw new AppError('NOT_FOUND');
    const spec = payload.spec;
    let tableId: Id<'tbl'>;
    /** Field id of each imported column. */
    const fieldOfColumn = new Map<number, Id<'fld'>>();
    if (spec.mode === 'create_table') {
      checkCreateTableImport(spec, {
        isAdmin: access.isAdmin,
        columnCount: columnNames.length,
        maxFields: deps.maxFieldsPerTable,
      });
      const [primary, ...rest] = spec.table.columns;
      if (primary === undefined) throw new TypeError('create_table needs a column');
      const created = await deps.schema.createTable(
        scope,
        { baseId: payload.base_id, name: spec.table.name, primaryFieldName: primary.name },
        context,
      );
      createdTable = created.table.id;
      targetTable = created.table.id;
      tableId = created.table.id;
      await deps.imports.mergeOptions(scope, payload.import_id, { created_table_id: tableId });
      fieldOfColumn.set(primary.column, created.primaryField.id);
      for (const column of rest) {
        const field = await deps.schema.addField(
          scope,
          tableId,
          { name: column.name, type: column.type, options: column.options ?? {} },
          context,
        );
        fieldOfColumn.set(column.column, field.id);
      }
      // The new table and fields are part of the access now (SPEC §14.1).
      access = await resolveMemberBaseAccess(
        deps.db,
        scope,
        { userId: payload.user_id, baseId: payload.base_id },
        deps.defaults,
      );
      if (access === undefined) throw new AppError('NOT_FOUND');
    } else {
      tableId = spec.table_id;
      checkAppendImport(spec, {
        resolved: access.record.resolved,
        fields: await new FieldsRepository(deps.db).listByTable(scope, tableId),
        columnCount: columnNames.length,
      });
      for (const item of spec.mapping) fieldOfColumn.set(item.column, item.field_id);
    }
    const recordAccess = access.record;

    // 3. The file.
    tmp = await mkdtemp(join(tmpdir(), 'cellhive-import-'));
    const path = join(tmp, 'upload');
    const stream = await deps.storage.getStream(importUploadKey(scope.organizationId, upload.id));
    if (stream === null) throw new AppError('NOT_FOUND', { detail: 'The uploaded file is gone.' });
    await pipeline(stream, createWriteStream(path, { mode: 0o600 }));
    file = await openImportFile(
      path,
      upload.format,
      {
        encoding: options.encoding ?? undefined,
        delimiter: options.delimiter ?? undefined,
        sheet: options.sheet ?? undefined,
      },
      deps.xlsxLimits,
    );

    // 4–5. Rows, in batches.
    const errors: ImportRowError[] = [];
    // The rejected values, for the CSV report only (never in the job result or a log).
    const values: (string | null)[] = [];
    let errorsTruncated = false;
    const columnOfField = new Map([...fieldOfColumn].map(([column, field]) => [field, column]));
    const report = (
      row: PendingRow,
      item: ProblemErrorItem | undefined,
      fieldId: string | null,
    ) => {
      if (errors.length >= IMPORT_REPORT_MAX_ERRORS) {
        errorsTruncated = true;
        return;
      }
      const column = fieldId === null ? undefined : columnOfField.get(fieldId as Id<'fld'>);
      values.push(fieldId === null ? null : reportValue(row.fields[fieldId]));
      errors.push({
        row: row.line,
        data_row: row.index,
        column: column ?? null,
        column_name: column === undefined ? null : (columnNames[column] ?? null),
        field_id: fieldId === null ? null : (fieldId as Id<'fld'>),
        code: item?.code ?? 'INVALID',
      });
    };
    const total = Math.max(1, options.total_rows || 1);
    const batchSize = Math.min(deps.batchSize ?? IMPORT_BATCH_SIZE, IMPORT_BATCH_SIZE);

    const writeBatch = async (batch: PendingRow[]): Promise<void> => {
      const job = await deps.jobs.getById(scope, jobId);
      if (job?.status !== 'running') throw new Cancelled();
      let pending = batch;
      while (pending.length > 0) {
        const rows = pending;
        try {
          await deps.records.create(
            scope,
            tableId,
            recordAccess,
            {
              field_key_type: 'id',
              typecast: true,
              records: rows.map((row) => ({ fields: row.fields })),
            },
            context,
            // Link cells are title lists; ambiguous titles are row errors (T411).
            { readBack: false, importCells: true },
          );
          stats.imported += rows.length;
          pending = [];
        } catch (caught) {
          // A long text in a unique field: a row error too, found one row at a time.
          const error = isIndexRowTooLarge(caught) ? uniqueValueTooLongError(caught) : caught;
          if (!(error instanceof AppError) || !ROW_ERROR_CODES.has(error.code)) throw error;
          const bad = new Map<number, { item: ProblemErrorItem; fieldId: string | null }[]>();
          for (const item of error.errors ?? []) {
            const match = RECORD_PATH.exec(item.path);
            if (match === null) continue;
            const index = Number(match[1]);
            const list = bad.get(index) ?? [];
            list.push({ item, fieldId: match[2] ?? null });
            bad.set(index, list);
          }
          // Indexes outside the batch name no row either: retrying the same batch would loop forever.
          if (![...bad.keys()].some((index) => index < rows.length)) {
            // No row named (a unique value taken concurrently): one row at a time.
            if (rows.length === 1) {
              const [row] = rows;
              if (row !== undefined) report(row, error.errors?.[0], null);
              stats.failed += 1;
              pending = [];
              continue;
            }
            for (const row of rows) await writeBatch([row]);
            pending = [];
            continue;
          }
          const kept: PendingRow[] = [];
          rows.forEach((row, index) => {
            const problems = bad.get(index);
            if (problems === undefined) {
              kept.push(row);
              return;
            }
            stats.failed += 1;
            for (const { item, fieldId } of problems) report(row, item, fieldId);
          });
          pending = kept;
        }
      }
      stats.batches += 1;
      deps.onBatch?.({ rows: stats.rows, imported: stats.imported });
      await deps.jobs.setProgress(scope, jobId, Math.min(0.99, stats.rows / total));
    };

    let batch: PendingRow[] = [];
    let headerSkipped = !options.header_row;
    for await (const row of file.rows()) {
      if (!headerSkipped) {
        headerSkipped = true;
        continue;
      }
      stats.rows += 1;
      const maxRows = deps.maxRows ?? IMPORT_MAX_ROWS;
      if (stats.rows > maxRows) {
        throw importFileError('TOO_MANY_ROWS', `The file has more than ${String(maxRows)} rows.`, {
          limit: maxRows,
        });
      }
      const fields: Record<string, ImportCell> = {};
      for (const [column, fieldId] of fieldOfColumn) {
        const cell = row.cells[column] ?? null;
        if (cell !== null) fields[fieldId] = cell;
      }
      batch.push({ line: row.line, index: stats.rows, fields });
      if (batch.length >= batchSize) {
        await writeBatch(batch);
        batch = [];
      }
    }
    if (batch.length > 0) await writeBatch(batch);

    // 6. Result.
    const result: ImportJobResult = {
      mode: spec.mode,
      table_id: tableId,
      rows: stats.rows,
      imported: stats.imported,
      failed: stats.failed,
      errors: errors.slice(0, IMPORT_RESULT_ERRORS),
      errors_truncated: errorsTruncated,
    };
    let finalResult: JsonObject = result as unknown as JsonObject;
    if (errors.length > 0) {
      const lines = ['row,column,column_name,field_id,code,data_row,value'];
      errors.forEach((item, index) => {
        lines.push(
          [
            String(item.row),
            item.column === null ? '' : String(item.column),
            csvCell(item.column_name),
            item.field_id ?? '',
            item.code,
            item.data_row === undefined ? '' : String(item.data_row),
            csvCell(values[index] ?? null),
          ].join(','),
        );
      });
      const body = Buffer.from(`\ufeff${lines.join('\r\n')}\r\n`, 'utf8');
      await deps.storage.put(importReportKey(scope.organizationId, jobId), body, {
        contentType: 'text/csv; charset=utf-8',
      });
      const now = deps.now?.() ?? new Date();
      finalResult = {
        ...finalResult,
        download_url: exportDownloadPath(jobId),
        expires_at: new Date(now.getTime() + IMPORT_REPORT_TTL_HOURS * 3_600_000).toISOString(),
      };
    }
    // The final state and `import.finished` commit together (T548).
    const succeeded = await deps.db.withTx(async (tx) => {
      const row = await deps.jobs.markSucceeded(
        orgScope(payload.organization_id, tx),
        jobId,
        finalResult,
      );
      if (row !== undefined) await notifyImportFinished(tx, notice('succeeded', false));
      return row;
    });
    if (succeeded === undefined) {
      // Cancelled while the last batch was written.
      const tableTrashed = await trashCreatedTable();
      await notifyCancelled(tableTrashed);
      return { status: 'cancelled', ...stats, tableTrashed };
    }
    return { status: 'succeeded', ...stats };
  } catch (error) {
    if (error instanceof Cancelled) {
      const tableTrashed = await trashCreatedTable();
      await notifyCancelled(tableTrashed);
      return { status: 'cancelled', ...stats, tableTrashed };
    }
    const problem = problemOf(error);
    // The new table goes to the trash before the job reads as failed.
    const tableTrashed = await trashCreatedTable();
    await deps.db.withTx(async (tx) => {
      const txScope = orgScope(payload.organization_id, tx);
      if ((await deps.jobs.markFailed(txScope, jobId, problem)) !== undefined) {
        await notifyImportFinished(tx, notice('failed', tableTrashed));
      } else if ((await deps.jobs.getById(txScope, jobId))?.status === 'cancelled') {
        // Cancelled meanwhile: the job reads as cancelled, and so does the notification.
        await notifyImportFinished(tx, notice('cancelled', tableTrashed));
      }
    });
    return {
      status: 'failed',
      ...stats,
      code: problem.code,
      tableTrashed,
      ...(error instanceof AppError ? {} : { cause: error }),
    };
  } finally {
    file?.close();
    if (tmp !== undefined) await rm(tmp, { recursive: true, force: true });
    await deps.storage
      .delete(importUploadKey(scope.organizationId, payload.import_id))
      .catch(() => undefined);
  }
}

/**
 * Audit context of an import's writes: the importer, `batch_id = job_…`
 * (ADR-23); `via.api_token_id` too when started through a token (T705).
 */
function importContext(payload: TableImportPayload): AuditContext {
  return {
    actor: { type: 'user', id: payload.user_id },
    via: {
      import_job_id: payload.job_id,
      ...(payload.api_token_id === undefined ? {} : { api_token_id: payload.api_token_id }),
    },
    batch_id: payload.job_id,
    request_id: null,
    ip: null,
    user_agent: null,
  };
}

/**
 * Moves the table a create-mode import made to the trash (when there is one
 * and it is not there yet); whether it did.
 */
async function trashImportTable(
  deps: Pick<TableImportDeps, 'schema' | 'imports'>,
  payload: TableImportPayload,
): Promise<{ readonly created: Id<'tbl'> | undefined; readonly trashed: boolean }> {
  if (payload.spec.mode !== 'create_table') return { created: undefined, trashed: false };
  const scope = orgScope(payload.organization_id);
  const upload = await deps.imports.getById(scope, payload.import_id);
  const created = (upload?.options as Record<string, unknown> | undefined)?.created_table_id;
  if (typeof created !== 'string') return { created: undefined, trashed: false };
  try {
    await deps.schema.deleteTable(scope, created as Id<'tbl'>, importContext(payload));
    return { created: created as Id<'tbl'>, trashed: true };
  } catch {
    return { created: created as Id<'tbl'>, trashed: false };
  }
}

/**
 * The table `import.finished` names after an interrupted run: the append
 * target, or the new table while it is still live (not in the trash).
 */
async function liveImportTable(
  db: Db,
  tx: Tx,
  payload: TableImportPayload,
  created: Id<'tbl'> | undefined,
): Promise<Id<'tbl'> | null> {
  if (payload.spec.mode === 'append') return payload.spec.table_id;
  if (created === undefined) return null;
  const table = await new TablesRepository(db).getById(
    orgScope(payload.organization_id, tx),
    created,
  );
  return table === undefined ? null : created;
}

/** `import.finished` of an interrupted run: `created` from the audit log, row errors lost. */
async function notifyInterruptedImport(
  db: Db,
  tx: Tx,
  payload: TableImportPayload,
  status: ImportFinishedNotice['status'],
  created: Id<'tbl'> | undefined,
): Promise<void> {
  await notifyImportFinished(tx, {
    organizationId: payload.organization_id,
    jobId: payload.job_id,
    baseId: payload.base_id,
    tableId: await liveImportTable(db, tx, payload, created),
    userId: payload.user_id,
    status,
    created: await importedRecordCount(db, tx, {
      organizationId: payload.organization_id,
      jobId: payload.job_id,
    }),
    updated: 0,
    failedRows: 0,
  });
}

/**
 * Ends a `table.import` job found `running` when its task starts again (the
 * worker stopped mid-import): it is marked `failed` rather than run twice
 * (rows would be imported again), and a table it created is moved to the
 * trash. `import.finished` (`failed`) commits with the failure, its
 * `created` counted from the audit log (T548). The uploaded file is
 * deleted.
 */
export async function abandonTableImport(
  deps: Pick<TableImportDeps, 'db' | 'schema' | 'jobs' | 'imports' | 'storage'>,
  payload: TableImportPayload,
): Promise<{ readonly tableTrashed: boolean }> {
  const { created, trashed: tableTrashed } = await trashImportTable(deps, payload);
  await deps.db.withTx(async (tx) => {
    const scope = orgScope(payload.organization_id, tx);
    const failed = await deps.jobs.markFailed(scope, payload.job_id, {
      type: 'https://cellhive.io/errors/INTERNAL',
      title: 'Internal error',
      status: 500,
      code: 'INTERNAL',
      detail: 'The import was interrupted; start a new one.',
    });
    if (failed !== undefined) {
      await notifyInterruptedImport(deps.db, tx, payload, 'failed', created);
    } else if ((await deps.jobs.getById(scope, payload.job_id))?.status === 'cancelled') {
      await notifyInterruptedImport(deps.db, tx, payload, 'cancelled', created);
    }
  });
  await deps.storage
    .delete(importUploadKey(payload.organization_id, payload.import_id))
    .catch(() => undefined);
  return { tableTrashed };
}

/**
 * Finishes a `table.import` job that was cancelled **while it ran** and
 * whose task starts again (the worker stopped before it saw the
 * cancellation, T548): as the run would have, a table it created goes to
 * the trash (CONTRACTS §19 "Huỷ"), the uploaded file is deleted and
 * `import.finished` (`cancelled`, `created` from the audit log) is queued —
 * a no-op when the run had already notified (`group_key = job_id`).
 * Nothing for a job cancelled before it started (`POST …/cancel` notified
 * it) or in another state.
 */
export async function settleCancelledImport(
  deps: Pick<TableImportDeps, 'db' | 'schema' | 'jobs' | 'imports' | 'storage'>,
  payload: TableImportPayload,
): Promise<{ readonly settled: boolean; readonly tableTrashed: boolean }> {
  const job = await deps.jobs.getById(orgScope(payload.organization_id), payload.job_id);
  if (job?.status !== 'cancelled' || job.started_at === null) {
    return { settled: false, tableTrashed: false };
  }
  const { created, trashed: tableTrashed } = await trashImportTable(deps, payload);
  await deps.db.withTx((tx) => notifyInterruptedImport(deps.db, tx, payload, 'cancelled', created));
  await deps.storage
    .delete(importUploadKey(payload.organization_id, payload.import_id))
    .catch(() => undefined);
  return { settled: true, tableTrashed };
}
