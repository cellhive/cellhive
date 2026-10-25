import type { Id } from '@cellhive/contracts';

/** Storage key of an uploaded import file: `{org}/{imp_…}` (SPEC §16, ids only). */
export function importUploadKey(organizationId: Id<'org'>, importId: Id<'imp'>): string {
  return `${organizationId}/${importId}`;
}

/** Storage key of the error report of an import job: `{org}/import-errors-{job}.csv`. */
export function importReportKey(organizationId: Id<'org'>, jobId: Id<'job'>): string {
  return `${organizationId}/import-errors-${jobId}.csv`;
}
