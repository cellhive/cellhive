import { Buffer } from 'node:buffer';

import { csvCell, UTF8_BOM } from '../export/csv.js';

import { apiTokenViaPresenter, type AuditViewer } from './api-token-via.js';
import {
  AuditLogsRepository,
  type AuditLogFilter,
  type AuditLogRow,
} from './audit-logs.repository.js';

import type { Db } from '../db/create-db.js';
import type { KeysetCursor } from '../db/cursor.js';
import type { OrgScope } from '../db/repository.js';
import type { JsonObject, JsonValue } from '../db/schema.js';
import type { StorageDriver } from '../storage/storage-driver.js';
import type { AuditActionPrefix, AuditViaKind, Id } from '@cellhive/contracts';

/**
 * `meta.jobs.type` of the organization audit log export, and the task name
 * of both audit exports (CONTRACTS §11.4).
 */
export const AUDIT_EXPORT_JOB_TYPE = 'audit.export';
/**
 * `meta.jobs.type` of a base's audit log export (`POST /bases/:id/audit-logs/export`,
 * T709): run by the `audit.export` task with `filters.base_id` set; visible
 * to organization owners/admins and to its creator while still base admin.
 */
export const AUDIT_BASE_EXPORT_JOB_TYPE = 'audit.base_export';
/** Every audit export job type: one of them runs per organization at a time. */
export const AUDIT_EXPORT_JOB_TYPES: readonly string[] = [
  AUDIT_EXPORT_JOB_TYPE,
  AUDIT_BASE_EXPORT_JOB_TYPE,
];
/** How long the download link of an export stays valid (CONTRACTS §12.2: 1 hour). */
export const EXPORT_DOWNLOAD_TTL_MS = 60 * 60 * 1000;
/** Most entries one export writes; the result says `truncated` beyond it. */
export const MAX_AUDIT_EXPORT_ROWS = 100_000;
/** Entries read per query while exporting. */
export const AUDIT_EXPORT_PAGE_SIZE = 1_000;

/**
 * Filters of an export as stored in the job payload (CONTRACTS §11.4
 * names). Repeatable filters are lists; a single string (payloads queued
 * before T709) is one value.
 */
export interface AuditExportFilters {
  readonly actor_id?: string | readonly string[] | undefined;
  readonly base_id?: Id<'bse'> | undefined;
  readonly table_id?: Id<'tbl'> | undefined;
  readonly entity_type?: string | undefined;
  readonly entity_id?: string | undefined;
  readonly action?: string | readonly string[] | undefined;
  readonly action_prefix?: readonly AuditActionPrefix[] | undefined;
  readonly via?: readonly AuditViaKind[] | undefined;
  readonly batch_id?: string | undefined;
  /** ISO 8601, inclusive. */
  readonly from?: string | undefined;
  /** ISO 8601, exclusive. */
  readonly to?: string | undefined;
}

function listOf(value: string | readonly string[]): readonly string[] {
  return typeof value === 'string' ? [value] : value;
}

/** Storage key of an export file: `{org}/audit-export-{job}.csv` (never user input). */
export function auditExportKey(organizationId: Id<'org'>, jobId: Id<'job'>): string {
  return `${organizationId}/audit-export-${jobId}.csv`;
}

/** API path that checks the downloader and redirects to the file (CONTRACTS §12.2). */
export function exportDownloadPath(jobId: Id<'job'>): string {
  return `/api/v1/files/exports/${jobId}`;
}

/** Repository filter of stored export filters. */
export function auditFilterOf(filters: AuditExportFilters): AuditLogFilter {
  return {
    ...(filters.actor_id === undefined ? {} : { actorIds: listOf(filters.actor_id) }),
    ...(filters.base_id === undefined ? {} : { baseId: filters.base_id }),
    ...(filters.table_id === undefined ? {} : { tableId: filters.table_id }),
    ...(filters.entity_type === undefined ? {} : { entityType: filters.entity_type }),
    ...(filters.entity_id === undefined ? {} : { entityId: filters.entity_id }),
    ...(filters.action === undefined ? {} : { actions: listOf(filters.action) }),
    ...(filters.action_prefix === undefined ? {} : { actionPrefixes: filters.action_prefix }),
    ...(filters.via === undefined ? {} : { via: filters.via }),
    ...(filters.batch_id === undefined ? {} : { batchId: filters.batch_id }),
    ...(filters.from === undefined ? {} : { from: new Date(filters.from) }),
    ...(filters.to === undefined ? {} : { to: new Date(filters.to) }),
  };
}

export { csvCell };

export const AUDIT_CSV_COLUMNS = [
  'id',
  'created_at',
  'actor_type',
  'actor_id',
  'actor_name',
  'via',
  'action',
  'entity_type',
  'entity_id',
  'base_id',
  'table_id',
  'batch_id',
  'request_id',
  'before',
  'after',
  'ip',
  'user_agent',
] as const;

function jsonText(value: JsonValue | null): string | null {
  return value === null ? null : JSON.stringify(value);
}

/**
 * The CSV line of one entry (storage-form `before`/`after` as JSON). `via`:
 * the entry's `via` as the export's viewer sees it (`shownViaOf`, S6
 * decision #19); the stored value when left out.
 */
export function auditCsvLine(row: AuditLogRow, via: JsonValue | null = row.via): string {
  const cells: (string | null)[] = [
    row.id,
    row.created_at.toISOString(),
    row.actor_type,
    row.actor_id,
    row.actor_name,
    jsonText(via),
    row.action,
    row.entity_type,
    row.entity_id,
    row.base_id,
    row.table_id,
    row.batch_id,
    row.request_id,
    jsonText(row.before),
    jsonText(row.after),
    row.ip,
    row.user_agent,
  ];
  return cells.map(csvCell).join(',');
}

export interface AuditExportResult extends JsonObject {
  readonly download_url: string;
  readonly expires_at: string;
  readonly size: number;
  readonly rows: number;
  readonly truncated: boolean;
}

export interface AuditExportDeps {
  readonly db: Db;
  readonly storage: Pick<StorageDriver, 'put'>;
  readonly now?: () => Date;
  /** Reports progress (0…1) while writing; best effort. */
  readonly onProgress?: (progress: number) => Promise<void>;
}

/**
 * Writes the organization's audit entries matching `filters` (newest first,
 * at most `MAX_AUDIT_EXPORT_ROWS`) as a UTF-8 CSV with BOM to object storage
 * and returns the job result (CONTRACTS §12.2). Values stay in storage form,
 * like the list API; the `via` column follows the list's API token rule
 * for `viewer` — the user who started the export (S6 decision #19).
 */
export async function writeAuditExport(
  deps: AuditExportDeps,
  scope: OrgScope,
  jobId: Id<'job'>,
  filters: AuditExportFilters,
  viewer: AuditViewer,
): Promise<AuditExportResult> {
  const repository = new AuditLogsRepository(deps.db);
  const filter = auditFilterOf(filters);
  const lines: string[] = [`${UTF8_BOM}${AUDIT_CSV_COLUMNS.join(',')}`];
  let cursor: KeysetCursor | null = null;
  let rows = 0;
  let truncated = false;
  for (;;) {
    const page = await repository.list(scope, filter, { cursor, limit: AUDIT_EXPORT_PAGE_SIZE });
    const viaOf = await apiTokenViaPresenter(deps.db, scope, page.items, viewer);
    for (const row of page.items) {
      if (rows >= MAX_AUDIT_EXPORT_ROWS) {
        truncated = true;
        break;
      }
      lines.push(auditCsvLine(row, viaOf(row)));
      rows += 1;
    }
    const last = page.items[page.items.length - 1];
    if (truncated || page.nextCursor === null || last === undefined) break;
    cursor = { at: last.cursor_at, id: last.id };
    await deps.onProgress?.(Math.min(0.9, rows / MAX_AUDIT_EXPORT_ROWS));
  }
  const body = Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8');
  const stored = await deps.storage.put(auditExportKey(scope.organizationId, jobId), body, {
    contentType: 'text/csv; charset=utf-8',
  });
  const now = deps.now?.() ?? new Date();
  return {
    download_url: exportDownloadPath(jobId),
    expires_at: new Date(now.getTime() + EXPORT_DOWNLOAD_TTL_MS).toISOString(),
    size: stored.size,
    rows,
    truncated,
  };
}
