import { WIDGET_NOT_EXPORTABLE, type Id, type WidgetExportQuery } from '@cellhive/contracts';
import {
  attachmentDisposition,
  AuditWriter,
  widgetCsv,
  widgetQueryOf,
  type AppConfig,
  type AuditContext,
  type Db,
  type JsonObject,
  type WidgetCsvColumn,
  type WidgetTableMeta,
} from '@cellhive/server-core';
import { Inject, Injectable } from '@nestjs/common';

import { permissionDenied } from '../../common/access/access.service.js';
import { settingOf } from '../../common/access/time-zone.js';
import { auditContextOf, type RequestMeta } from '../../common/auth/request-meta.js';
import { validationFailed } from '../../common/dto.js';
import { APP_CONFIG, DB } from '../../common/tokens.js';
import { ExportLeases, type ExportLease, type ExportSlot } from '../export/export-leases.js';

import { DashboardDataService, type WidgetReadContext } from './dashboard-data.service.js';
import { DashboardService } from './dashboard.service.js';

import type { Principal } from '../../common/auth/principal.js';

/** A widget CSV ready to be sent. */
export interface WidgetCsvFile {
  readonly body: string;
  readonly disposition: string;
}

const auditWriter = new AuditWriter();

/** A widget to export, with the tables of its base (names of the CSV header). */
export type ExportWidgetContext = WidgetReadContext & {
  readonly tables: ReadonlyMap<string, WidgetTableMeta>;
};

/** Who exports and what is checked/audited (a member, or a share link — T809). */
export interface WidgetExportOptions {
  /** `base_rule.download` of the member, or of the link's creator now. */
  readonly canDownload: boolean;
  /** Export slots to hold while computing (the user; or the link and the IP). */
  readonly leases: readonly ExportSlot[];
  /** `detail` of the `429` when a slot is taken. */
  readonly busy?: string;
  /** Language of the header (metric names). */
  readonly locale: string;
  /** Audit context of `export.created` (actor, `via`). */
  readonly audit: AuditContext;
  /** Extra keys of the audit `after` (e.g. `share_link_id`). */
  readonly auditAfter?: JsonObject;
}

const isLocale = (locale: unknown): locale is string => typeof locale === 'string' && locale !== '';

/**
 * CSV of a widget (BACKLOG T808, CONTRACTS §28.6, "Quyết định S7" #12): the
 * aggregate table the caller sees — the numbers of `POST /widgets/:id/data`
 * with the same live filters, never raw records (a record-list table widget
 * is `422 WIDGET_NOT_EXPORTABLE`).
 *
 * Order of checks: dashboard not readable → `404`; widget without an
 * aggregate table → `422`; no `base_rule.download` → `403` (P18, P74);
 * another export of the caller running → `429` + `Retry-After` (the slot of
 * table exports, C§18); the widget is `no_permission` for the caller →
 * `403`, `broken` → `422`. Then `export.created` is audited
 * (`entity_type = dashboard_widget`, no value) and the file is sent.
 */
@Injectable()
export class DashboardExportService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DashboardService) private readonly dashboards: DashboardService,
    @Inject(DashboardDataService) private readonly data: DashboardDataService,
    @Inject(ExportLeases) private readonly leases: ExportLeases,
  ) {}

  async csv(
    principal: Principal,
    widgetId: Id<'wgt'>,
    query: WidgetExportQuery,
    meta: RequestMeta,
  ): Promise<WidgetCsvFile> {
    const context = (await this.data.memberContext(principal, widgetId)) as ExportWidgetContext;
    const { base } = context;
    return this.export(context, query, {
      canDownload: base.access.base_rule.download,
      leases: [principal.userId],
      locale:
        [principal.user.locale, settingOf(base.org.membership.settings, 'locale')].find(isLocale) ??
        this.config.defaults.locale,
      audit: auditContextOf(meta, { type: 'user', id: principal.userId }),
    });
  }

  /**
   * The CSV of a widget for the reader of `context`, checked in the order
   * of CONTRACTS §28.6 (after the caller's own checks: dashboard readable,
   * link settings).
   */
  async export(
    context: ExportWidgetContext,
    query: WidgetExportQuery,
    options: WidgetExportOptions,
  ): Promise<WidgetCsvFile> {
    const { base, dashboard, widget, tables } = context;
    const widgetQuery = widgetQueryOf(widget.type, widget.config);
    if (widgetQuery === null || (widgetQuery !== 'invalid' && widgetQuery.kind === 'records')) {
      throw validationFailed('Only widgets with a table of numbers can be exported.', {
        path: '',
        code: WIDGET_NOT_EXPORTABLE,
        message: 'The widget has no table of numbers',
      });
    }
    if (!options.canDownload) {
      throw permissionDenied('Exporting needs the download right in this base.');
    }
    const held: ExportLease[] = [];
    try {
      for (const key of options.leases) held.push(await this.leases.acquire(key, options.busy));
      const result = await this.data.dataOf(context, {
        filters: query.filters ?? [],
        timezone: query.timezone,
      });
      if (result.status === 'no_permission') {
        throw permissionDenied('The widget uses fields you cannot read.');
      }
      if (result.status === 'broken' || widgetQuery === 'invalid') {
        throw validationFailed('The widget cannot be computed any more.', {
          path: '',
          code: WIDGET_NOT_EXPORTABLE,
          message: 'The widget is broken',
        });
      }
      const fields = new Map(
        (tables.get(widgetQuery.tableId)?.fields ?? []).map((field) => [field.id, field.name]),
      );
      const metrics = metricsOf(widget.config);
      const columns: WidgetCsvColumn[] = result.columns.map((column) => ({
        fieldName: column.field_id === null ? null : (fields.get(column.field_id) ?? null),
        label: column.role === 'metric' ? (metrics.get(column.key) ?? null) : null,
      }));
      const file = widgetCsv(result, columns, options.locale);
      await this.db.withTx(async (tx) => {
        await auditWriter.write(tx, {
          action: 'export.created',
          organizationId: base.org.scope.organizationId,
          baseId: base.base.id,
          tableId: widgetQuery.tableId,
          entityType: 'dashboard_widget',
          entityId: widget.id,
          after: {
            dashboard_id: dashboard.id,
            format: query.format,
            row_count: file.rowCount,
            ...options.auditAfter,
          },
          context: options.audit,
        });
      });
      const title = widget.title.trim() === '' ? widget.type : widget.title.trim();
      return {
        body: file.text,
        disposition: attachmentDisposition(`${dashboard.name} - ${title}`, 'csv'),
      };
    } finally {
      await Promise.all(held.map((lease) => lease.release()));
    }
  }
}

/** Saved metric labels of a widget config, by metric id. */
function metricsOf(config: unknown): Map<string, string | null> {
  const data = config as {
    metrics?: unknown;
    table?: { metrics?: unknown };
  } | null;
  const list = Array.isArray(data?.metrics)
    ? data.metrics
    : Array.isArray(data?.table?.metrics)
      ? data.table.metrics
      : [];
  const labels = new Map<string, string | null>();
  for (const item of list as { id?: unknown; label?: unknown }[]) {
    if (typeof item.id === 'string') {
      labels.set(item.id, typeof item.label === 'string' ? item.label : null);
    }
  }
  return labels;
}
