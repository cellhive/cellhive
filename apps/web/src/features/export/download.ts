import { API_BASE } from '../../lib/api/client';

import type { TableExportFormat } from '@cellhive/contracts';

export {
  DOWNLOAD_FRAME_TTL_MS,
  errorOfFrameText,
  startFileDownload,
  type FileDownloadOptions,
} from '../../lib/files/download';

/**
 * Export downloads (T318, CONTRACTS §18, FRONTEND §7): the file is streamed
 * by the browser straight to disk — the SPA never holds it in memory.
 *
 * `GET /tables/:id/export` answers either the file (`Content-Disposition:
 * attachment`) or, before the first byte, a problem+json (`403` without
 * `base_rule.download`, `404`, `422 EXPORT_TOO_LARGE`, `429` while another
 * export of the user runs). A plain link would replace the app with that
 * JSON, so the URL is opened in a hidden same-origin frame: a file becomes a
 * download (the frame shows nothing, no `load` of a document happens), an
 * error loads a JSON document the page can read and turn into a toast.
 */

/** `GET /api/v1/tables/:id/export?view_id=&format=` of a saved view. */
export function exportUrl(tableId: string, viewId: string, format: TableExportFormat): string {
  const query = new URLSearchParams({ view_id: viewId, format });
  return `${API_BASE}/tables/${encodeURIComponent(tableId)}/export?${query.toString()}`;
}
