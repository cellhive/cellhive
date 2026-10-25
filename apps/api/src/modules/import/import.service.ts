import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import {
  IMPORT_JOB_TYPE,
  IMPORT_MAX_FILE_BYTES,
  IMPORT_UPLOAD_TTL_HOURS,
  newId,
  type Id,
  type ImportPreview,
  type ImportPreviewQuery,
  type ImportUploadDto,
  type JobAccepted,
  type JobDto,
  type StartImportRequest,
} from '@cellhive/contracts';
import {
  analyzeImportFile,
  cancelImportJob,
  checkAppendImport,
  checkCreateTableImport,
  detectImportFormat,
  enqueue,
  FieldsRepository,
  ImportsRepository,
  importSpecOf,
  importUploadKey,
  JobsRepository,
  readHead,
  TablesRepository,
  withTxScope,
  type AppConfig,
  type Db,
  type ImportRow,
  type StorageDriver,
  type StoredImportOptions,
} from '@cellhive/server-core';
import { AppError } from '@cellhive/server-core/errors';
import { Inject, Injectable } from '@nestjs/common';

import {
  AccessService,
  notFound,
  permissionDenied,
  type BaseAccess,
} from '../../common/access/access.service.js';
import { settingOf } from '../../common/access/time-zone.js';
import { requireTokenScope } from '../../common/auth/scope.guard.js';
import { APP_CONFIG, DB, STORAGE_DRIVER } from '../../common/tokens.js';
import { jobDtoOf, jobVisibleTo } from '../job/job.service.js';

import { receiveMultipartFile } from './multipart-upload.js';

import type { Principal } from '../../common/auth/principal.js';
import type { Readable } from 'node:stream';

const CONTENT_TYPES = {
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
} as const;

/** Whether the access lets the caller import at all: base admin, or a table to add records to. */
export function canImport(access: BaseAccess['access']): boolean {
  if (access.is_admin) return true;
  return Object.values(access.tables).some(
    (table) =>
      (table.perm === 'edit' || table.perm === 'manage') && table.operations.includes('add'),
  );
}

/**
 * CSV/XLSX import (SPEC §17, CONTRACTS §19; BACKLOG T308): uploads and
 * previews, and the start of the `table.import` job. Every check the job
 * repeats with the caller's current access runs here first, so a request
 * the job would refuse is refused before anything is queued.
 */
@Injectable()
export class ImportService {
  private readonly tables: TablesRepository;
  private readonly fields: FieldsRepository;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(JobsRepository) private readonly jobs: JobsRepository,
    @Inject(ImportsRepository) private readonly imports: ImportsRepository,
    @Inject(STORAGE_DRIVER) private readonly storage: StorageDriver,
  ) {
    this.tables = new TablesRepository(db);
    this.fields = new FieldsRepository(db);
  }

  /** `POST /bases/:baseId/imports/uploads` (multipart). */
  async upload(
    principal: Principal,
    baseId: Id<'bse'>,
    request: { readonly contentType: string | undefined; readonly body: Readable },
  ): Promise<ImportUploadDto> {
    let base: BaseAccess;
    try {
      base = await this.importableBase(principal, baseId);
    } catch (error) {
      request.body.resume();
      throw error;
    }
    const dir = await mkdtemp(join(tmpdir(), 'cellhive-upload-'));
    try {
      const file = await receiveMultipartFile(
        request.body,
        request.contentType,
        dir,
        IMPORT_MAX_FILE_BYTES,
      );
      const format = detectImportFormat(file.filename, await readHead(file.path, 8));
      if (format === undefined) {
        throw new AppError('UNSUPPORTED_MEDIA_TYPE', {
          detail: 'Only CSV and XLSX files can be imported.',
        });
      }
      const analysis = await analyzeImportFile(file.path, format, { locale: this.localeOf(base) });
      const id = newId('imp');
      await this.storage.putStream(
        importUploadKey(base.org.organizationId, id),
        createReadStream(file.path),
        {
          contentType: CONTENT_TYPES[format],
          contentLength: file.size,
        },
      );
      const row = await this.imports.create(base.org.scope, {
        id,
        baseId,
        createdBy: principal.userId,
        filename: file.filename,
        format,
        size: file.size,
        options: analysis.options,
        expiresAt: new Date(Date.now() + IMPORT_UPLOAD_TTL_HOURS * 3_600_000),
      });
      return {
        id: row.id,
        filename: row.filename,
        format,
        size: Number(row.size),
        expires_at: row.expires_at.toISOString(),
        preview: analysis.preview,
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** `GET /bases/:baseId/imports/uploads/:uploadId/preview`. */
  async preview(
    principal: Principal,
    baseId: Id<'bse'>,
    uploadId: Id<'imp'>,
    query: ImportPreviewQuery,
  ): Promise<ImportPreview> {
    const base = await this.importableBase(principal, baseId);
    const upload = await this.usableUpload(base, principal, uploadId);
    const dir = await mkdtemp(join(tmpdir(), 'cellhive-preview-'));
    try {
      const path = join(dir, 'upload');
      const stream = await this.storage.getStream(
        importUploadKey(base.org.organizationId, upload.id),
      );
      if (stream === null) throw notFound();
      await pipeline(stream, createWriteStream(path, { mode: 0o600 }));
      const analysis = await analyzeImportFile(path, upload.format, {
        locale: this.localeOf(base),
        encoding: query.encoding,
        delimiter: query.delimiter,
        sheet: query.sheet,
        headerRow: query.header_row,
      });
      await this.imports.setOptions(base.org.scope, upload.id, analysis.options);
      return analysis.preview;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** `POST /bases/:baseId/imports`: checks everything, then queues `table.import`. */
  async start(
    principal: Principal,
    baseId: Id<'bse'>,
    body: StartImportRequest,
  ): Promise<JobAccepted> {
    const base = await this.importableBase(principal, baseId);
    const spec = importSpecOf(body);
    // Creating a table is a schema change: a token needs `schema:write` too (T705).
    if (spec.mode === 'create_table') requireTokenScope(principal, 'schema:write');
    const upload = await this.usableUpload(base, principal, body.upload_id);
    const options = upload.options as unknown as StoredImportOptions;
    const columnCount = Array.isArray(options.columns) ? options.columns.length : 0;
    const scope = base.org.scope;
    if (spec.mode === 'create_table') {
      checkCreateTableImport(spec, {
        isAdmin: base.access.is_admin,
        columnCount,
        maxFields: this.config.limits.maxFieldsPerTable,
      });
      if (await this.tables.nameTaken(scope, baseId, spec.table.name.normalize('NFC').trim())) {
        throw new AppError('NAME_CONFLICT', {
          detail: 'A table with this name already exists.',
          errors: [
            {
              path: 'table.name',
              code: 'NAME_CONFLICT',
              message: 'The table name is already used',
            },
          ],
        });
      }
    } else {
      const table = await this.tables.getById(scope, spec.table_id);
      if (table?.base_id !== baseId) throw notFound();
      checkAppendImport(spec, {
        resolved: base.resolved,
        fields: await this.fields.listByTable(scope, spec.table_id),
        columnCount,
      });
    }
    const jobId = await this.db.withTx(async (tx) => {
      const txScope = withTxScope(scope, tx);
      const job = await this.jobs.create(txScope, {
        type: IMPORT_JOB_TYPE,
        createdBy: principal.userId,
      });
      const claimed = await this.imports.claim(
        txScope,
        { id: upload.id, baseId, userId: principal.userId },
        job.id,
      );
      // A concurrent start used the upload first: roll the job back.
      if (claimed === undefined) throw notFound();
      await enqueue(tx, 'table.import', {
        organization_id: base.org.organizationId,
        job_id: job.id,
        import_id: upload.id,
        base_id: baseId,
        user_id: principal.userId,
        // The import's writes carry `via.api_token_id` next to `import_job_id` (T705).
        ...(principal.kind === 'api_token' ? { api_token_id: principal.tokenId } : {}),
        spec,
      });
      return job.id;
    });
    return { job_id: jobId };
  }

  /** `POST /bases/:baseId/imports/:jobId/cancel`. */
  async cancel(principal: Principal, baseId: Id<'bse'>, jobId: Id<'job'>): Promise<JobDto> {
    const base = await this.access.findBase(principal, baseId);
    if (base === undefined) throw notFound();
    const scope = base.org.scope;
    const upload = await this.imports.getByJob(scope, jobId);
    const job = await this.jobs.getById(scope, jobId);
    if (
      upload?.base_id !== baseId ||
      job?.type !== IMPORT_JOB_TYPE ||
      !jobVisibleTo(job, principal.userId, base.org.isAdmin)
    ) {
      throw notFound();
    }
    if (job.status === 'queued' || job.status === 'running') {
      // A job that never started gets `import.finished` here; a running one from its worker (T548).
      const cancelled = await cancelImportJob(this.db, this.jobs, {
        organizationId: base.org.organizationId,
        jobId,
        baseId,
        cancelledBy: principal.userId,
      });
      if (cancelled !== undefined) return jobDtoOf(cancelled);
    }
    const current = await this.jobs.getById(scope, jobId);
    if (current === undefined) throw notFound();
    return jobDtoOf(current);
  }

  /** A readable base (else `404`) where the caller may import (else `403`). */
  private async importableBase(principal: Principal, baseId: Id<'bse'>): Promise<BaseAccess> {
    const base = await this.access.findBase(principal, baseId);
    if (base === undefined) throw notFound();
    if (!canImport(base.access)) {
      throw permissionDenied('You cannot import into this base.');
    }
    return base;
  }

  /** The caller's own unused upload in this base (else `404`). */
  private async usableUpload(
    base: BaseAccess,
    principal: Principal,
    uploadId: Id<'imp'>,
  ): Promise<ImportRow> {
    const upload = await this.imports.getUsable(base.org.scope, {
      id: uploadId,
      baseId: base.base.id,
      userId: principal.userId,
    });
    if (upload === undefined) throw notFound();
    return upload;
  }

  /** Locale of type guesses: the base's, else the organization's (CONTRACTS §2). */
  private localeOf(base: BaseAccess): string {
    const candidates = [
      settingOf(base.base.settings, 'locale'),
      settingOf(base.org.membership.settings, 'locale'),
    ];
    return (
      candidates.find((locale): locale is string => typeof locale === 'string' && locale !== '') ??
      this.config.defaults.locale
    );
  }
}
