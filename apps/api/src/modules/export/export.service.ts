import { EXPORT_TOO_LARGE, type Id, type TableExportQuery } from '@cellhive/contracts';
import {
  AppError,
  AuditWriter,
  RecordQueryService,
  TABLE_EXPORT_CONTENT_TYPES,
  tableExportBody,
  tableExportDisposition,
  type AppConfig,
  type Db,
  type RecordOutput,
} from '@cellhive/server-core';
import { Inject, Injectable } from '@nestjs/common';

import { permissionDenied } from '../../common/access/access.service.js';
import { auditContextOf, type RequestMeta } from '../../common/auth/request-meta.js';
import { AppLogger } from '../../common/logging/app-logger.js';
import { APP_CONFIG, DB } from '../../common/tokens.js';
import { RecordService } from '../record/record.service.js';

import { ExportLeases, type ExportLease } from './export-leases.js';

import type { Principal } from '../../common/auth/principal.js';
import type { Readable } from 'node:stream';

/** A file ready to be sent. */
export interface ExportFile {
  readonly body: Readable;
  readonly contentType: string;
  readonly disposition: string;
  /** Frees the per-user slot; call when the response closes (idempotent). */
  readonly finish: () => Promise<void>;
}

const auditWriter = new AuditWriter();

/**
 * Table export (SPEC §17, CONTRACTS §18; BACKLOG T307, S3 decision 2):
 * a synchronous stream of the records the caller reads, through a view or
 * of the whole table, as CSV or XLSX with `cell_format=text` values.
 *
 * Order of checks: table not readable → `404`; view not visible → `404`;
 * no `base_rule.download` → `403` (P18); another export of the caller
 * running → `429` + `Retry-After`; more rows than `EXPORT_MAX_ROWS` →
 * `422 VALIDATION_FAILED` / `EXPORT_TOO_LARGE`. Then `export.created` is
 * audited (table, view, format, row count; no value) and the file streams.
 */
@Injectable()
export class ExportService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(RecordService) private readonly records: RecordService,
    @Inject(RecordQueryService) private readonly query: RecordQueryService,
    @Inject(ExportLeases) private readonly leases: ExportLeases,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  async open(
    principal: Principal,
    tableId: Id<'tbl'>,
    query: TableExportQuery,
    meta: RequestMeta,
    signal: AbortSignal,
  ): Promise<ExportFile> {
    const table = await this.records.resolve(principal, tableId);
    const maxRows = this.config.limits.exportMaxRows;
    let lease: ExportLease | null = null;
    const finish = async () => {
      await lease?.release();
    };
    try {
      const stream = await this.query.openStream(
        table.scope,
        tableId,
        table.access,
        { view_id: query.view_id ?? null, cell_format: 'text' },
        {
          maxRows,
          signal,
          beforeRead: async () => {
            if (!table.base.access.base_rule.download) {
              throw permissionDenied('Exporting needs the download right in this base.');
            }
            lease = await this.leases.acquire(principal.userId);
          },
        },
      );
      if (stream.exceedsMaxRows) {
        throw new AppError('VALIDATION_FAILED', {
          detail: `More than ${String(maxRows)} records match; narrow the export with a view filter.`,
          errors: [
            {
              path: '',
              code: EXPORT_TOO_LARGE,
              message: 'Too many records to export',
              params: { limit: maxRows },
            },
          ],
        });
      }
      const target = {
        table_id: tableId,
        view_id: stream.view?.id ?? null,
        format: query.format,
      };
      await this.db.withTx(async (tx) => {
        await auditWriter.write(tx, {
          action: 'export.created',
          organizationId: table.scope.organizationId,
          baseId: table.base.base.id,
          tableId,
          entityType: 'table',
          entityId: tableId,
          after: { view_id: target.view_id, format: query.format, row_count: stream.rowCount },
          context: auditContextOf(meta, { type: 'user', id: principal.userId }),
        });
      });
      const body = tableExportBody(
        query.format,
        stream,
        stream.fields,
        this.observed(stream.records(), target, signal, finish),
      );
      return {
        body,
        contentType: TABLE_EXPORT_CONTENT_TYPES[query.format],
        disposition: tableExportDisposition(stream, query.format),
        finish,
      };
    } catch (error) {
      await finish();
      throw error;
    }
  }

  /** `records` that logs the outcome (never values) and frees the slot when done. */
  private async *observed(
    records: AsyncGenerator<RecordOutput[], void, undefined>,
    target: { table_id: Id<'tbl'>; view_id: Id<'viw'> | null; format: string },
    signal: AbortSignal,
    finish: () => Promise<void>,
  ): AsyncGenerator<RecordOutput[], void, undefined> {
    const started = performance.now();
    let rows = 0;
    try {
      for await (const chunk of records) {
        rows += chunk.length;
        yield chunk;
      }
      this.logger.info(
        { ...target, rows, duration_ms: Math.round(performance.now() - started) },
        'table export finished',
      );
    } catch (error) {
      if (signal.aborted) {
        this.logger.info({ ...target, rows }, 'table export aborted by the client');
      } else {
        this.logger.warn({ ...target, rows, err: error }, 'table export failed while streaming');
      }
      throw error;
    } finally {
      await finish();
    }
  }
}
