import { API_BASE } from '../../../lib/api/client';
import { dataUrlToBlob, saveBlob, startFileDownload } from '../../../lib/files/download';

import type { ApiError } from '../../../lib/api/client';
import type { WidgetLiveFilterInput } from '@cellhive/contracts';

/**
 * Widget downloads (T813, CONTRACTS §28.6, S7 decision #12) — offered only
 * with `base_rule.download` (the server checks again: `403`).
 */

/**
 * `GET /widgets/:id/export?format=csv&filters=&timezone=`: the aggregate
 * table the viewer sees, with the same live filters (never raw records).
 */
export function widgetCsvUrl(
  widgetId: string,
  filters: readonly WidgetLiveFilterInput[],
  timezone: string | null,
): string {
  const query = new URLSearchParams({ format: 'csv' });
  if (filters.length > 0) query.set('filters', JSON.stringify(filters));
  if (timezone !== null) query.set('timezone', timezone);
  return `${API_BASE}/widgets/${encodeURIComponent(widgetId)}/export?${query.toString()}`;
}

/** The CSV through the hidden download frame (`lib/files/download.ts`): an error becomes a toast. */
export function downloadWidgetCsv(
  url: string,
  options: { readonly frameTitle: string; readonly onError: (error: ApiError) => void },
): void {
  startFileDownload(url, { title: options.frameTitle, onError: options.onError });
}

const RESERVED: ReadonlySet<string> = new Set(['\\', '/', ':', '*', '?', '"', '<', '>', '|']);

/** A file name from the dashboard and widget names (no path separators or reserved marks). */
export function downloadName(dashboard: string, widget: string, extension: string): string {
  const base = Array.from(`${dashboard} - ${widget}`, (char) =>
    char.charCodeAt(0) < 32 || RESERVED.has(char) ? '_' : char,
  )
    .join('')
    .trim()
    .slice(0, 150);
  return `${base === '' ? 'widget' : base}.${extension}`;
}

/** The chart's PNG (ECharts `getDataURL`, on the theme's background) saved as a file. */
export function downloadPng(dataUrl: string, filename: string): void {
  saveBlob(dataUrlToBlob(dataUrl), filename);
}
