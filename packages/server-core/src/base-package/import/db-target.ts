import {
  ATTACHMENT_THUMBNAIL_SIZES,
  attachmentHasThumbnail,
  COMPUTED_BACKFILL_BATCH_SIZE,
  type BaseImportResult,
  type Id,
} from '@cellhive/contracts';

import { AuditWriter } from '../../audit/audit-writer.js';
import { AutomationsRepository } from '../../automation/repository/automations.repository.js';
import { createBaseRecord, finishImportedBase } from '../../bases/create-base.js';
import { loadBaseSchemaRows } from '../../computed/definition/schema-rows.js';
import { DashboardWidgetsRepository } from '../../dashboards/dashboard-widgets.repository.js';
import { DashboardsRepository } from '../../dashboards/dashboards.repository.js';
import { JOB_STATEMENT_TIMEOUT_MS } from '../../db/create-db.js';
import { jsonb } from '../../db/json.js';
import { sqlStateOf } from '../../db/pg-errors.js';
import { BaseRolesRepository } from '../../db/repositories/base-roles.repository.js';
import { BasesRepository } from '../../db/repositories/bases.repository.js';
import { OrgMembersRepository } from '../../db/repositories/org-members.repository.js';
import { withTxScope, type OrgScope } from '../../db/repository.js';
import { AppError } from '../../errors/app-error.js';
import { enqueue } from '../../jobs/enqueue.js';
import { JobsRepository } from '../../jobs/jobs.repository.js';
import { EmailAssetsRepository } from '../../mail/images/email-assets.repository.js';
import {
  attachmentThumbnailKey,
  AttachmentsRepository,
} from '../../records/attachments/attachments.repository.js';
import { TablesRepository } from '../../schema/tables.repository.js';
import { FormCoversRepository } from '../../views/form-covers.repository.js';
import { ViewsRepository } from '../../views/views.repository.js';

import { BaseImportStopped } from './target.js';

import type {
  BaseImportTarget,
  ImportAuditCounts,
  ImportAutomationInput,
  ImportBaseInput,
  ImportDashboardInput,
  ImportRoleInput,
  ImportStoredCover,
  ImportStoredEmailAsset,
  ImportStoredFile,
  ImportViewInput,
} from './target.js';
import type { AuditContext } from '../../audit/audit-entry.js';
import type { BaseSchemaRows } from '../../computed/definition/schema-rows.js';
import type { Db } from '../../db/create-db.js';
import type { DashboardWidgetKind, JsonObject, JsonValue } from '../../db/schema.js';
import type {
  PackageLoadBatch,
  RecordMutationService,
} from '../../records/record-mutation.service.js';
import type { SchemaService } from '../../schema/schema.service.js';
import type { StorageDriver } from '../../storage/storage-driver.js';
import type { PackageMember } from '../users.js';
import type { Readable } from 'node:stream';

/** Members read per statement. */
const PAGE = 1_000;
/** SQLSTATE of a unique violation. */
const UNIQUE_VIOLATION = '23505';
/** Attempts of the thumbnail job of an imported image (like an upload's). */
const THUMBNAIL_MAX_ATTEMPTS = 3;

/** What an import uses of `SchemaService` (T1018, T1019). */
export type BaseImportSchemaMethods =
  | 'importTable'
  | 'importLinkField'
  | 'importComputedField'
  | 'markImportedComputedReady'
  | 'importFieldAi'
  | 'importLinkRecordFilter'
  | 'purgeBase';

export interface DbBaseImportTargetDeps {
  readonly db: Db;
  /** DDL and fields of the hidden base (AGENTS.md rule 1). */
  readonly schema: Pick<SchemaService, BaseImportSchemaMethods>;
  /** Records of the hidden base (AGENTS.md rule 1); a job statement timeout suits. */
  readonly records: Pick<RecordMutationService, 'loadPackageBatch' | 'backfillComputedBatch'>;
  readonly storage: Pick<StorageDriver, 'putStream' | 'delete'>;
}

export interface DbBaseImportJob {
  readonly jobId: Id<'job'>;
  readonly workspaceId: Id<'wsp'>;
  /** The importer: owner of the new base, creator of its files, actor of its audit entries. */
  readonly importerId: Id<'usr'>;
  readonly context: AuditContext;
}

const audit = new AuditWriter();

/**
 * The hidden base of one `base.import` job (CONTRACTS §12.2) as a
 * {@link BaseImportTarget}: tables, fields and links through
 * `SchemaService`, records through `RecordMutationService`, files in object
 * storage under `{org}/{att}` (their row first, so a purge always knows
 * them), the job row of `meta.jobs`. Every query is bound to the
 * organization; every write checks that the base is still hidden and owned
 * by the job. Worker code (the `base.import` job) only.
 */
export class DbBaseImportTarget implements BaseImportTarget {
  private readonly jobs: JobsRepository;
  private readonly attachments: AttachmentsRepository;
  private readonly thumbnails: Id<'att'>[] = [];

  constructor(
    private readonly deps: DbBaseImportTargetDeps,
    private readonly scope: OrgScope,
    private readonly job: DbBaseImportJob,
  ) {
    this.jobs = new JobsRepository(deps.db);
    this.attachments = new AttachmentsRepository(deps.db);
  }

  private base(baseId: Id<'bse'>) {
    return { baseId, importJobId: this.job.jobId };
  }

  async members(): Promise<PackageMember[]> {
    const repository = new OrgMembersRepository(this.deps.db);
    const members: PackageMember[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = await repository.listPage(this.scope, { offset, limit: PAGE });
      for (const member of page.items) {
        members.push({ id: member.user.id, email: member.user.email });
      }
      if (page.items.length < PAGE) break;
    }
    return members;
  }

  async createBase(input: ImportBaseInput): Promise<Id<'bse'>> {
    const { db } = this.deps;
    const base = await db.withTx((tx) =>
      createBaseRecord(
        db,
        tx,
        this.scope,
        {
          workspaceId: this.job.workspaceId,
          ownerId: this.job.importerId,
          name: input.name,
          icon: input.icon,
          description: input.description,
          settings: input.settings as JsonObject,
          importJobId: this.job.jobId,
        },
        this.job.context,
      ),
    );
    return base.id;
  }

  async createTable(baseId: Id<'bse'>, input: Parameters<BaseImportTarget['createTable']>[1]) {
    await this.deps.schema.importTable(this.scope, this.base(baseId), input);
  }

  async createLink(baseId: Id<'bse'>, input: Parameters<BaseImportTarget['createLink']>[1]) {
    await this.deps.schema.importLinkField(this.scope, this.base(baseId), input);
  }

  async storeFile(baseId: Id<'bse'>, file: ImportStoredFile, content: Readable): Promise<void> {
    const { db, storage } = this.deps;
    const row = await this.attachments.create(this.scope, {
      id: file.id,
      baseId,
      tableId: file.tableId,
      fieldId: file.fieldId,
      createdBy: this.job.importerId,
      filename: file.filename,
      mime: file.mime,
      size: file.size,
    });
    if (
      (await new BasesRepository(db).findImporting(this.scope, this.job.jobId, baseId)) ===
      undefined
    ) {
      throw new AppError('NOT_FOUND', { detail: 'The base being imported is gone.' });
    }
    await storage.putStream(row.object_key, content, {
      contentType: file.mime,
      contentLength: file.size,
    });
    const thumbnail = attachmentHasThumbnail(file.mime, file.size);
    await db.withTx(async (tx) => {
      const txScope = withTxScope(this.scope, tx);
      const ready = await this.attachments.markReady(txScope, row.id, {
        size: file.size,
        sha256: file.sha256,
        thumbnailStatus: thumbnail ? 'pending' : null,
      });
      if (ready === undefined) throw new AppError('NOT_FOUND', { detail: 'A file row is gone.' });
      await this.attachments.attach(txScope, [row.id], file.recordId);
    });
    if (thumbnail) this.thumbnails.push(row.id);
  }

  load(baseId: Id<'bse'>, batch: PackageLoadBatch): Promise<number> {
    return this.deps.records.loadPackageBatch(this.scope, this.base(baseId), batch);
  }

  schemaRows(baseId: Id<'bse'>): Promise<BaseSchemaRows> {
    return loadBaseSchemaRows(this.deps.db, this.scope, baseId);
  }

  async createComputedField(
    baseId: Id<'bse'>,
    input: Parameters<BaseImportTarget['createComputedField']>[1],
  ): Promise<boolean> {
    const field = await this.deps.schema.importComputedField(this.scope, this.base(baseId), input);
    return field.compute_mode === 'stored' && field.compute_state === 'backfilling';
  }

  async backfillComputed(baseId: Id<'bse'>, fieldId: Id<'fld'>): Promise<void> {
    let cursor = 0n;
    for (;;) {
      const result = await this.deps.records.backfillComputedBatch(this.scope, {
        fieldId,
        afterAuto: cursor,
        limit: COMPUTED_BACKFILL_BATCH_SIZE,
        statementTimeoutMs: JOB_STATEMENT_TIMEOUT_MS,
      });
      if (result.status === 'skipped' || result.status === 'superseded') {
        throw new AppError('NOT_FOUND', { detail: 'A field of the base being imported is gone.' });
      }
      if (result.status === 'done') break;
      cursor = result.cursor;
      await this.checkpoint();
    }
    await this.deps.schema.markImportedComputedReady(this.scope, this.base(baseId), fieldId);
  }

  async setFieldAi(
    baseId: Id<'bse'>,
    input: Parameters<BaseImportTarget['setFieldAi']>[1],
  ): Promise<void> {
    await this.deps.schema.importFieldAi(this.scope, this.base(baseId), input);
  }

  async setLinkFilter(
    baseId: Id<'bse'>,
    input: Parameters<BaseImportTarget['setLinkFilter']>[1],
  ): Promise<void> {
    await this.deps.schema.importLinkRecordFilter(this.scope, this.base(baseId), input);
  }

  async createViews(
    baseId: Id<'bse'>,
    tableId: Id<'tbl'>,
    views: readonly ImportViewInput[],
  ): Promise<void> {
    if (views.length === 0) return;
    await this.inImportingBase(baseId, async (txScope) => {
      const table = await new TablesRepository(this.deps.db).getById(txScope, tableId);
      if (table?.base_id !== baseId) {
        throw new AppError('NOT_FOUND', { detail: 'A table of the base being imported is gone.' });
      }
      const repository = new ViewsRepository(this.deps.db);
      await repository.lockTable(txScope, tableId);
      // The default view `importTable` gave the table makes way for the package's.
      await repository.deleteByTable(txScope, tableId);
      for (const view of views) {
        await repository.insert(txScope, {
          id: view.id,
          tableId,
          type: view.type,
          name: view.name,
          config: view.config,
          position: view.position,
          ownerId: null,
        });
        if (view.locked) await repository.update(txScope, view.id, { locked: true });
      }
    });
  }

  async storeFormCover(
    baseId: Id<'bse'>,
    file: ImportStoredCover,
    content: Readable,
  ): Promise<void> {
    const covers = new FormCoversRepository(this.deps.db);
    const row = await this.inImportingBase(baseId, (txScope) =>
      covers.insertImported(txScope, {
        id: file.id,
        baseId,
        tableId: file.tableId,
        viewId: file.viewId,
        createdBy: this.job.importerId,
        filename: file.filename,
        mime: file.mime,
        size: file.size,
      }),
    );
    await this.deps.storage.putStream(row.object_key, content, {
      contentType: file.mime,
      contentLength: file.size,
    });
    const ready = await this.inImportingBase(baseId, (txScope) =>
      covers.markReady(txScope, row.id, { size: file.size, sha256: file.sha256 }),
    );
    if (ready === undefined) throw new AppError('NOT_FOUND', { detail: 'A cover row is gone.' });
  }

  async createDashboard(baseId: Id<'bse'>, input: ImportDashboardInput): Promise<void> {
    await this.inImportingBase(baseId, async (txScope) => {
      const dashboard = await new DashboardsRepository(this.deps.db).insert(txScope, {
        id: input.id,
        baseId,
        name: input.name,
        icon: input.icon,
        description: input.description,
        theme: input.theme,
        globalFilters: jsonb(input.globalFilters as JsonValue),
        position: input.position,
        createdBy: this.job.importerId,
      });
      const widgets = new DashboardWidgetsRepository(this.deps.db);
      for (const widget of input.widgets) {
        await widgets.insert(txScope, {
          id: widget.id,
          dashboardId: dashboard.id,
          type: widget.type as DashboardWidgetKind,
          title: widget.title,
          config: widget.config,
          layout: widget.layout,
        });
      }
    });
  }

  async createRole(baseId: Id<'bse'>, input: ImportRoleInput): Promise<void> {
    await this.inImportingBase(baseId, async (txScope) => {
      const roles = new BaseRolesRepository(this.deps.db);
      if ((await roles.findByName(txScope, baseId, input.name)) !== undefined) {
        throw new AppError('NAME_CONFLICT', { detail: 'Another role of the base has this name.' });
      }
      await roles.create(txScope, {
        id: input.id,
        baseId,
        name: input.name,
        kind: 'custom',
        config: input.config,
        position: await roles.nextPosition(txScope, baseId),
      });
    });
  }

  async createAutomation(baseId: Id<'bse'>, input: ImportAutomationInput): Promise<void> {
    try {
      await this.inImportingBase(baseId, async (txScope) => {
        await new AutomationsRepository(this.deps.db).insert(txScope, {
          id: input.id,
          baseId,
          name: input.name,
          description: input.description,
          // Off, whatever the package says (CONTRACTS §12.2): `run_as` = `created_by` = the importer.
          enabled: false,
          definition: input.definition,
          triggerType: input.triggerType,
          triggerTableId: input.triggerTableId,
          createdBy: this.job.importerId,
        });
      });
    } catch (error) {
      // Two automations of the package on one button (`automations_button_field_key`).
      if (sqlStateOf(error) === UNIQUE_VIOLATION) {
        throw new AppError('VALIDATION_FAILED', {
          detail: 'Another automation of the package is attached to this button.',
          errors: [
            {
              path: 'definition.trigger.field_id',
              code: 'BUTTON_IN_USE',
              message: 'Another automation is attached to the button',
            },
          ],
        });
      }
      throw error;
    }
  }

  async storeEmailAsset(
    baseId: Id<'bse'>,
    file: ImportStoredEmailAsset,
    content: Readable,
  ): Promise<void> {
    const assets = new EmailAssetsRepository(this.deps.db);
    const row = await this.inImportingBase(baseId, async (txScope) => {
      const automation = await new AutomationsRepository(this.deps.db).get(
        txScope,
        file.automationId,
      );
      if (automation?.base_id !== baseId) {
        throw new AppError('NOT_FOUND', { detail: 'An automation of the import is gone.' });
      }
      return assets.insertImported(txScope, {
        id: file.id,
        automationId: file.automationId,
        createdBy: this.job.importerId,
        filename: file.filename,
        mime: file.mime,
        size: file.size,
      });
    });
    await this.deps.storage.putStream(row.object_key, content, {
      contentType: file.mime,
      contentLength: file.size,
    });
    const ready = await this.inImportingBase(baseId, (txScope) =>
      assets.markReady(txScope, row.id, {
        mime: file.mime,
        size: file.size,
        sha256: file.sha256,
        width: file.width,
        height: file.height,
      }),
    );
    if (ready === undefined) throw new AppError('NOT_FOUND', { detail: 'An image row is gone.' });
  }

  /**
   * `step` in one transaction holding the row of the hidden base (`FOR
   * UPDATE`): `404` when it is no longer the job's hidden base.
   */
  private async inImportingBase<T>(
    baseId: Id<'bse'>,
    step: (scope: OrgScope) => Promise<T>,
  ): Promise<T> {
    return this.deps.db.withTx(async (tx) => {
      const txScope = withTxScope(this.scope, tx);
      const base = await new BasesRepository(this.deps.db).findImporting(
        txScope,
        this.job.jobId,
        baseId,
      );
      if (base === undefined) {
        throw new AppError('NOT_FOUND', { detail: 'The base being imported is gone.' });
      }
      return step(txScope);
    });
  }

  async checkpoint(): Promise<void> {
    const job = await this.jobs.getById(this.scope, this.job.jobId);
    if (job?.status !== 'running') {
      throw new BaseImportStopped();
    }
  }

  async progress(progress: number): Promise<void> {
    await this.jobs.setProgress(this.scope, this.job.jobId, progress);
  }

  async finish(
    baseId: Id<'bse'>,
    result: BaseImportResult,
    counts: ImportAuditCounts,
  ): Promise<void> {
    const { db } = this.deps;
    await db.withTx(async (tx) => {
      const txScope = withTxScope(this.scope, tx);
      const base = await finishImportedBase(
        db,
        tx,
        this.scope,
        this.base(baseId),
        this.job.context,
      );
      if (base === undefined) {
        throw new AppError('NOT_FOUND', { detail: 'The base being imported is gone.' });
      }
      await audit.write(tx, {
        action: 'base.imported',
        organizationId: this.scope.organizationId,
        baseId,
        entityType: 'job',
        entityId: this.job.jobId,
        after: { counts: { ...counts } },
        context: this.job.context,
      });
      // Thumbnails only now: no job ever renders a file of a hidden base.
      for (const id of this.thumbnails) {
        await enqueue(
          tx,
          'file.thumbnail',
          { organization_id: this.scope.organizationId, attachment_id: id },
          { maxAttempts: THUMBNAIL_MAX_ATTEMPTS, jobKey: `file.thumbnail:${id}` },
        );
      }
      const succeeded = await this.jobs.markSucceeded(txScope, this.job.jobId, result);
      // Cancelled meanwhile: nothing of the import may stay (the caller purges).
      if (succeeded === undefined) throw new BaseImportStopped();
    });
  }

  async purge(): Promise<void> {
    await purgeBaseImport(this.deps, this.scope, this.job.jobId);
  }
}

/**
 * Removes what an import job wrote (CONTRACTS §12.2): the objects of the
 * files of its hidden base (thumbnails included), then the base itself
 * (`SchemaService.purgeBase`). Nothing when the job has no hidden base.
 * Safe to run again after a failure part-way (deleting a missing object is
 * a no-op; the rows naming the objects go last).
 */
export async function purgeBaseImport(
  deps: Pick<DbBaseImportTargetDeps, 'db' | 'schema' | 'storage'>,
  scope: OrgScope,
  importJobId: Id<'job'>,
): Promise<boolean> {
  const { db, storage } = deps;
  const base = await new BasesRepository(db).findImporting(scope, importJobId);
  if (base === undefined) return false;
  const keys = [
    ...(await new AttachmentsRepository(db).objectKeysOfImportingBase(scope, base.id, importJobId)),
    ...(await new FormCoversRepository(db).objectKeysOfImportingBase(scope, base.id, importJobId)),
    ...(await new EmailAssetsRepository(db).objectKeysOfImportingBase(scope, base.id, importJobId)),
  ];
  for (const key of keys) {
    await storage.delete(key);
    for (const size of ATTACHMENT_THUMBNAIL_SIZES) {
      await storage.delete(attachmentThumbnailKey(key, size));
    }
  }
  await deps.schema.purgeBase(scope, { baseId: base.id, importJobId });
  return true;
}

/** Storage key of an uploaded package: `{org}/base-import-{job}.chbase` (ids only). */
export function basePackageImportKey(organizationId: Id<'org'>, jobId: Id<'job'>): string {
  return `${organizationId}/base-import-${jobId}.chbase`;
}
