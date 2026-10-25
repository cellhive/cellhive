import { EXPORT_TOO_LARGE, type Id, type ShareExportQuery } from '@cellhive/contracts';
import {
  AuditWriter,
  FieldsRepository,
  RecordQueryService,
  TABLE_EXPORT_CONTENT_TYPES,
  tableExportBody,
  tableExportDisposition,
  type AppConfig,
  type Db,
  type RecordOutput,
} from '@cellhive/server-core';
import { AppError } from '@cellhive/server-core/errors';
import { Inject, Injectable } from '@nestjs/common';

import { firstTimeZone, settingOf } from '../../common/access/time-zone.js';
import { auditContextOf, requestMetaOf } from '../../common/auth/request-meta.js';
import { AppLogger } from '../../common/logging/app-logger.js';
import { APP_CONFIG, DB } from '../../common/tokens.js';
import { ExportLeases, type ExportLease } from '../export/export-leases.js';

import { ShareAccessStats } from './share-access-stats.js';
import { ShareAccessService } from './share-access.service.js';
import { sharedResultKind } from './share-computed.js';
import {
  COMPUTED_ATTACHMENTS,
  COMPUTED_RECORDS,
  redactSharedRecord,
  type ShareValueContext,
} from './share-values.js';

import type { ExportFile } from '../export/export.service.js';
import type { FastifyRequest } from 'fastify';

/** Most `Accept-Language` entries looked at (the header is client input). */
const MAX_LANGUAGE_RANGES = 20;

/**
 * The viewer's locale from `Accept-Language` (RFC 9110 §12.5.4): the
 * well-formed language tag with the highest `q` (ties: first listed),
 * ignoring `*` and `q=0`; `fallback` when none.
 */
export function viewerLocale(header: string | string[] | undefined, fallback: string): string {
  const value = Array.isArray(header) ? header.join(',') : header;
  if (value === undefined || value === '') return fallback;
  const ranges = value
    .split(',')
    .slice(0, MAX_LANGUAGE_RANGES)
    .map((part, index) => {
      const [tag = '', ...params] = part.split(';').map((item) => item.trim());
      const q = params.find((param) => /^q=/iu.test(param));
      const weight = q === undefined ? 1 : Number(q.slice(2));
      return { tag, weight: Number.isFinite(weight) ? weight : 0, index };
    })
    .filter((range) => range.tag !== '' && range.tag !== '*' && range.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  for (const range of ranges) {
    try {
      const [canonical] = Intl.getCanonicalLocales(range.tag);
      if (canonical !== undefined) return canonical;
    } catch {
      // Not a BCP 47 tag: try the next one.
    }
  }
  return fallback;
}

function notFound(): AppError {
  return new AppError('NOT_FOUND', { detail: 'Not found.' });
}

const auditWriter = new AuditWriter();

/**
 * Export of a shared view (SPEC §15A, CONTRACTS §16A, §18; BACKLOG T810,
 * S7 decision 17): `GET /shares/:token/export?format=csv|xlsx&tz=`.
 *
 * Checks, in order: the share route checks (per-IP read limit `429`, token
 * `404`/`410`, audience `401`/`404`, password `403
 * SHARE_PASSWORD_REQUIRED`); a form link `404` (no records); `allow_export
 * = false` → `403 PERMISSION_DENIED` / `NOT_ALLOWED`; the creator without
 * `base_rule.download` **now** → `403 PERMISSION_DENIED`; another export of
 * the link or from the IP running → `429` + `Retry-After`; more rows than
 * `EXPORT_MAX_ROWS` → `422 EXPORT_TOO_LARGE`. Every check happens before the
 * first byte.
 *
 * Rows and columns are the link's: the creator's current access ∩ the view
 * (view filter always, fail closed; fields hidden in the view never
 * exported; the creator's read rule), the saved view only — no filter,
 * sort or search of the viewer. Values are `cell_format=text` in the
 * viewer's locale (`Accept-Language`) and zone (`tz`, default the
 * organization's), with the share redactions (users by name, records out
 * of the creator's reach without title, no file of another table).
 * Audited as `export.created` (actor `share_link`, `via.share_link_id`),
 * never with the token or a value.
 */
@Injectable()
export class ShareExportService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ShareAccessService) private readonly shares: ShareAccessService,
    @Inject(ShareAccessStats) private readonly stats: ShareAccessStats,
    @Inject(RecordQueryService) private readonly query: RecordQueryService,
    @Inject(FieldsRepository) private readonly fields: FieldsRepository,
    @Inject(ExportLeases) private readonly leases: ExportLeases,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  async open(
    token: string,
    query: ShareExportQuery,
    request: FastifyRequest,
    signal: AbortSignal,
  ): Promise<ExportFile> {
    const opened = await this.shares.open(token, request);
    const { link, view, scope, settings, creator, recordAccess } = opened.link;
    if (link.target_type !== 'view') throw notFound();
    if (!settings.allow_export) {
      throw new AppError('PERMISSION_DENIED', {
        detail: 'This link does not allow exporting.',
        errors: [{ path: '', code: 'NOT_ALLOWED', message: 'Not allowed by this link.' }],
      });
    }
    // The creator's right now, not when the link was made (S7 decision 17).
    if (!creator.access.base_rule.download) {
      throw new AppError('PERMISSION_DENIED', { detail: 'This link does not allow exporting.' });
    }

    const meta = requestMetaOf(request);
    const orgSettings = creator.org.membership.settings;
    const orgLocale = settingOf(orgSettings, 'locale');
    const orgZone = settingOf(orgSettings, 'timezone');
    const display = {
      locale: viewerLocale(
        request.headers['accept-language'],
        typeof orgLocale === 'string' && orgLocale !== '' ? orgLocale : this.config.defaults.locale,
      ),
      timeZone: firstTimeZone([query.tz, orgZone], this.config.defaults.timezone),
    };
    const maxRows = this.config.limits.exportMaxRows;
    const held: ExportLease[] = [];
    const finish = async () => {
      await Promise.all(held.map((lease) => lease.release()));
    };
    try {
      const stream = await this.query.openStream(
        scope,
        view.table_id,
        recordAccess,
        { view_id: view.id, cell_format: 'text' },
        {
          maxRows,
          signal,
          viewScope: 'share_link',
          display,
          beforeRead: async () => {
            const busy = 'Another export of this link is still running; try again later.';
            held.push(await this.leases.acquire(link.id, busy));
            held.push(await this.leases.acquire(`ip:${meta.ip ?? 'unknown'}`, busy));
          },
        },
      );
      if (stream.exceedsMaxRows) {
        throw new AppError('VALIDATION_FAILED', {
          detail: `More than ${String(maxRows)} records match.`,
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
      await this.db.withTx(async (tx) => {
        await auditWriter.write(tx, {
          action: 'export.created',
          organizationId: scope.organizationId,
          baseId: link.base_id,
          tableId: view.table_id,
          entityType: 'table',
          entityId: view.table_id,
          after: {
            view_id: view.id,
            format: query.format,
            row_count: stream.rowCount,
            share_link_id: link.id,
          },
          context: {
            ...auditContextOf(meta, { type: 'share_link', id: link.id }),
            via: { share_link_id: link.id },
          },
        });
      });
      this.stats.record(scope.organizationId, link.id, false);
      const values = await this.valueContext(scope, view.table_id, token);
      const target = { share_link_id: link.id, view_id: view.id, format: query.format };
      const body = tableExportBody(
        query.format,
        stream,
        stream.fields,
        this.observed(stream.records(), values, target, signal, finish),
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

  /** Field types of the table, to apply the share redactions to text values (T409, T462). */
  private async valueContext(
    scope: Parameters<FieldsRepository['listByTable']>[0],
    tableId: Id<'tbl'>,
    token: string,
  ): Promise<ShareValueContext> {
    const types = new Map<string, string>();
    for (const field of await this.fields.listByTable(scope, tableId)) {
      const kind = sharedResultKind(field);
      types.set(
        field.id,
        kind === 'record'
          ? COMPUTED_RECORDS
          : kind === 'attachment'
            ? COMPUTED_ATTACHMENTS
            : field.type,
      );
    }
    return { token, types };
  }

  /** Redacted `records`; logs the outcome (never values or the token) and frees the slots. */
  private async *observed(
    records: AsyncGenerator<RecordOutput[], void, undefined>,
    values: ShareValueContext,
    target: { share_link_id: Id<'shl'>; view_id: Id<'viw'>; format: string },
    signal: AbortSignal,
    finish: () => Promise<void>,
  ): AsyncGenerator<RecordOutput[], void, undefined> {
    const started = performance.now();
    let rows = 0;
    try {
      for await (const chunk of records) {
        rows += chunk.length;
        yield chunk.map((record) => redactSharedRecord(record, values));
      }
      this.logger.info(
        { ...target, rows, duration_ms: Math.round(performance.now() - started) },
        'share link export finished',
      );
    } catch (error) {
      if (signal.aborted) {
        this.logger.info({ ...target, rows }, 'share link export aborted by the client');
      } else {
        this.logger.warn(
          { ...target, rows, err: error },
          'share link export failed while streaming',
        );
      }
      throw error;
    } finally {
      await finish();
    }
  }
}
