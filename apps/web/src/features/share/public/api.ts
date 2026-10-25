import {
  formSubmissionStatusSchema,
  formSubmitResponseSchema,
  formSubmitTokenSchema,
  recordGroupCountsResponseSchema,
  recordListResponseSchema,
  recordSchema,
  recordSummariesResponseSchema,
  SHARE_CSRF_HEADER,
  sharedDashboardSchema,
  shareFormMemberListSchema,
  shareMetaSchema,
  shareUnlockResponseSchema,
  widgetDataSchema,
  widgetOptionsSchema,
  type FormSubmitRequest,
  type ShareRecordGroupCountsRequest,
  type ShareRecordQueryRequest,
  type ShareRecordSummariesRequest,
  type TableExportFormat,
  type WidgetDataRequest,
  type WidgetLiveFilterInput,
  type WidgetOptionsRequest,
} from '@cellhive/contracts';

import { API_BASE, apiRequest, UNCHECKED_SCHEMA } from '../../../lib/api/client';

/** Cells as the grid reads them (FRONTEND §3.1): field ids, json values. */
const READ = { field_key_type: 'id', cell_format: 'json' } as const;

/**
 * The public API of one share link (CONTRACTS §16A, §17). A link with a
 * password answers `403 SHARE_PASSWORD_REQUIRED` until `unlock` sets its
 * HttpOnly cookie; every non-GET request carrying that cookie then needs
 * `X-Share-CSRF-Token` (CONTRACTS §12.0) — the token from `unlock` or
 * `meta`, kept here in memory only (never in storage).
 */
export class ShareApi {
  readonly token: string;
  #csrf: string | null = null;

  constructor(token: string) {
    this.token = token;
  }

  #path(rest: string): string {
    return `/shares/${encodeURIComponent(this.token)}${rest}`;
  }

  /**
   * `GET /shares/:token/form-cover/:attachmentId` (T419, CONTRACTS §17): the
   * cover image of the form, for an `<img>` (same as `sharedFormCoverUrl`
   * of the contracts, built here so the page's first load does not carry
   * the cover schemas).
   */
  formCoverUrl(attachmentId: string): string {
    return `/api/v1${this.#path(`/form-cover/${encodeURIComponent(attachmentId)}`)}`;
  }

  /** Header of non-GET requests while the link is unlocked. */
  #headers(): Record<string, string> {
    return this.#csrf === null ? {} : { [SHARE_CSRF_HEADER]: this.#csrf };
  }

  /** `GET /shares/:token/meta`: what the page shows; refreshes the CSRF token. */
  async meta(signal?: AbortSignal) {
    const meta = await apiRequest(
      this.#path('/meta'),
      import.meta.env.DEV ? shareMetaSchema : UNCHECKED_SCHEMA,
      { signal },
    );
    this.#csrf = meta.csrf_token;
    return meta;
  }

  /**
   * (T814) `GET /shares/:token/dashboard`: a dashboard link (its `meta`
   * answers `404 DASHBOARD_LINK`); refreshes the CSRF token like `meta`.
   */
  async dashboard(signal?: AbortSignal) {
    const dashboard = await apiRequest(
      this.#path('/dashboard'),
      import.meta.env.DEV ? sharedDashboardSchema : UNCHECKED_SCHEMA,
      { signal },
    );
    this.#csrf = dashboard.csrf_token;
    return dashboard;
  }

  /** (T814) `POST /shares/:token/widgets/:id/data` (CONTRACTS §16A, §28.3). */
  widgetData(widgetId: string, body: WidgetDataRequest, signal?: AbortSignal) {
    return apiRequest(
      this.#path(`/widgets/${encodeURIComponent(widgetId)}/data`),
      import.meta.env.DEV ? widgetDataSchema : UNCHECKED_SCHEMA,
      { method: 'POST', body, signal, headers: this.#headers() },
    );
  }

  /** (T814) `POST /shares/:token/widgets/:id/options` (with `allow_filter_controls`). */
  widgetOptions(widgetId: string, body: WidgetOptionsRequest, signal?: AbortSignal) {
    return apiRequest(
      this.#path(`/widgets/${encodeURIComponent(widgetId)}/options`),
      import.meta.env.DEV ? widgetOptionsSchema : UNCHECKED_SCHEMA,
      { method: 'POST', body, signal, headers: this.#headers() },
    );
  }

  /** (T814) `GET /shares/:token/widgets/:id/export?format=csv…` (with `allow_export`). */
  widgetCsvUrl(
    widgetId: string,
    filters: readonly WidgetLiveFilterInput[],
    timezone: string | null,
  ): string {
    const query = new URLSearchParams({ format: 'csv' });
    if (filters.length > 0) query.set('filters', JSON.stringify(filters));
    if (timezone !== null) query.set('timezone', timezone);
    return `${API_BASE}${this.#path(`/widgets/${encodeURIComponent(widgetId)}/export`)}?${query.toString()}`;
  }

  /**
   * (T814) `GET /shares/:token/export?format=…&tz=` (T810, with
   * `allow_export`): the whole saved view as a file, in the viewer's zone.
   */
  exportUrl(format: TableExportFormat, timeZone: string | null): string {
    const query = new URLSearchParams({ format });
    if (timeZone !== null) query.set('tz', timeZone);
    return `${API_BASE}${this.#path('/export')}?${query.toString()}`;
  }

  /** `POST /shares/:token/unlock`: sets the unlock cookie (24 h). */
  async unlock(password: string) {
    const unlocked = await apiRequest(
      this.#path('/unlock'),
      import.meta.env.DEV ? shareUnlockResponseSchema : UNCHECKED_SCHEMA,
      {
        method: 'POST',
        body: { password },
      },
    );
    this.#csrf = unlocked.csrf_token;
    return unlocked;
  }

  /** `POST /shares/:token/records/query`. */
  query(body: ShareRecordQueryRequest, signal?: AbortSignal) {
    return apiRequest(
      this.#path('/records/query'),
      import.meta.env.DEV ? recordListResponseSchema : UNCHECKED_SCHEMA,
      {
        method: 'POST',
        query: READ,
        body,
        signal,
        headers: this.#headers(),
      },
    );
  }

  /** `POST /shares/:token/records/group-counts` (T317). */
  groupCounts(body: ShareRecordGroupCountsRequest, signal?: AbortSignal) {
    return apiRequest(
      this.#path('/records/group-counts'),
      import.meta.env.DEV ? recordGroupCountsResponseSchema : UNCHECKED_SCHEMA,
      {
        method: 'POST',
        query: READ,
        body,
        signal,
        headers: this.#headers(),
      },
    );
  }

  /** `POST /shares/:token/records/summaries` (T472): the summary bar of the shared grid (T470). */
  summaries(body: ShareRecordSummariesRequest, signal?: AbortSignal) {
    return apiRequest(
      this.#path('/records/summaries'),
      import.meta.env.DEV ? recordSummariesResponseSchema : UNCHECKED_SCHEMA,
      {
        method: 'POST',
        query: READ,
        body,
        signal,
        headers: this.#headers(),
      },
    );
  }

  /** `GET /shares/:token/records/:recordId` (only with `show_record_detail`). */
  record(recordId: string, signal?: AbortSignal) {
    return apiRequest(
      this.#path(`/records/${encodeURIComponent(recordId)}`),
      import.meta.env.DEV ? recordSchema : UNCHECKED_SCHEMA,
      {
        query: READ,
        signal,
      },
    );
  }

  /** `GET /shares/:token/submit-token`: the anti-spam token of a form (CONTRACTS §17). */
  submitToken(signal?: AbortSignal) {
    return apiRequest(
      this.#path('/submit-token'),
      import.meta.env.DEV ? formSubmitTokenSchema : UNCHECKED_SCHEMA,
      { signal },
    );
  }

  /** `GET /shares/:token/submission-status` (T321): the limit of a sign-in form already reached? */
  submissionStatus(signal?: AbortSignal) {
    return apiRequest(
      this.#path('/submission-status'),
      import.meta.env.DEV ? formSubmissionStatusSchema : UNCHECKED_SCHEMA,
      { signal },
    );
  }

  /** `GET /shares/:token/members` (T321): people a user question of an `org` form link offers. */
  members(signal?: AbortSignal) {
    return apiRequest(
      this.#path('/members'),
      import.meta.env.DEV ? shareFormMemberListSchema : UNCHECKED_SCHEMA,
      { signal },
    );
  }

  /** Headers of a non-GET request of this link (its unlock CSRF token), for `form-inputs-api.ts`. */
  csrfHeaders(): Record<string, string> {
    return this.#headers();
  }

  /** `POST /shares/:token/submit`. */
  submit(body: FormSubmitRequest) {
    return apiRequest(
      this.#path('/submit'),
      import.meta.env.DEV ? formSubmitResponseSchema : UNCHECKED_SCHEMA,
      {
        method: 'POST',
        body,
        headers: this.#headers(),
      },
    );
  }
}
