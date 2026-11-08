import {
  BASE_EXPORT_PHASES,
  BASE_IMPORT_PHASES,
  BASE_PACKAGE_EXTENSION,
  BASE_PACKAGE_MAX_BYTES_LIMIT,
  BASE_PACKAGE_UPLOAD_FIELD,
  baseExportPhaseOf,
  baseExportResultSchema,
  baseImportPhaseOf,
  baseImportResultSchema,
  CSRF_COOKIE,
  CSRF_HEADER,
  jobAcceptedSchema,
  type BaseExportPhase,
  type BaseExportResult,
  type BaseImportPhase,
  type BaseImportResult,
  type JobAccepted,
  type JobDto,
} from '@cellhive/contracts';

import {
  API_BASE,
  ApiError,
  apiRequest,
  problemToApiError,
  readCookie,
  UNCHECKED_SCHEMA,
} from './client';

/**
 * Whole-base packages (`.chbase`, CONTRACTS §12.2, FRONTEND §17.5): start an
 * export, upload a package to import, and read the `base.export` /
 * `base.import` jobs. Imported only by the lazy screens that use it (the
 * export page of base settings, the import dialog of a workspace), never by
 * the app shell (`lib/api/index.ts`).
 */

const id = encodeURIComponent;

export interface PackageUploadOptions {
  /** Share of the file sent so far, 0–1. */
  readonly onProgress?: (sent: number) => void;
  readonly signal?: AbortSignal;
}

function retryAfter(xhr: XMLHttpRequest): number | undefined {
  const value = Number(xhr.getResponseHeader('retry-after') ?? Number.NaN);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * `POST /workspaces/:id/bases/import` as `multipart/form-data` with one
 * `file` part. XHR rather than `fetch`: only it reports upload progress.
 * Same headers as the API client (CSRF double submit, FRONTEND §12); no
 * `Idempotency-Key` (the server ignores it on uploads: sending again is
 * another import).
 */
function uploadPackage(
  workspaceId: string,
  file: File,
  options: PackageUploadOptions = {},
): Promise<JobAccepted> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/workspaces/${id(workspaceId)}/bases/import`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Accept', 'application/json');
    const csrf = readCookie(CSRF_COOKIE);
    if (csrf !== undefined) xhr.setRequestHeader(CSRF_HEADER, csrf);
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && event.total > 0) {
        options.onProgress?.(event.loaded / event.total);
      }
    });
    const abort = () => {
      xhr.abort();
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    const settle = () => {
      options.signal?.removeEventListener('abort', abort);
    };
    xhr.addEventListener('load', () => {
      settle();
      let body: unknown;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = undefined;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        const parsed = jobAcceptedSchema.safeParse(body);
        if (parsed.success) resolve(parsed.data);
        else reject(new ApiError({ status: xhr.status, code: 'UNEXPECTED_RESPONSE' }));
        return;
      }
      reject(problemToApiError(xhr.status, body, retryAfter(xhr)));
    });
    xhr.addEventListener('error', () => {
      settle();
      reject(new ApiError({ status: 0, code: 'NETWORK_ERROR' }));
    });
    xhr.addEventListener('abort', () => {
      settle();
      reject(new DOMException('The upload was cancelled.', 'AbortError'));
    });
    const form = new FormData();
    form.append(BASE_PACKAGE_UPLOAD_FIELD, file, file.name);
    xhr.send(form);
  });
}

export const basePackagesApi = {
  /** `202 { job_id }`: base owners/admins and organization owners/admins. */
  export: (baseId: string, idempotencyKey: string) =>
    apiRequest(
      `/bases/${id(baseId)}/export`,
      import.meta.env.DEV ? jobAcceptedSchema : UNCHECKED_SCHEMA,
      { method: 'POST', body: {}, idempotencyKey },
    ),
  /** `202 { job_id }`: whoever may create a base in the workspace. */
  import: uploadPackage,
};

/** Why a file is not offered for upload (checked before sending). */
export type PackageFileProblem = 'extension' | 'empty' | 'tooLarge';

/**
 * A `.chbase` file (any case) that no instance would refuse for its size:
 * the cap of this instance (`BASE_PACKAGE_MAX_BYTES`, 2 GiB by default) is
 * the server's answer (`413` with `params.limit`); the largest cap any
 * instance may set is refused here already.
 */
export function checkPackageFile(file: Pick<File, 'name' | 'size'>): PackageFileProblem | null {
  if (!file.name.toLowerCase().endsWith(BASE_PACKAGE_EXTENSION)) return 'extension';
  if (file.size === 0) return 'empty';
  if (file.size > BASE_PACKAGE_MAX_BYTES_LIMIT) return 'tooLarge';
  return null;
}

/** `result` of a succeeded `base.export` job, when it has the documented shape. */
export function exportResultOf(job: JobDto | undefined): BaseExportResult | undefined {
  if (job?.status !== 'succeeded') return undefined;
  const parsed = baseExportResultSchema.safeParse(job.result);
  return parsed.success ? parsed.data : undefined;
}

/** `result` of a succeeded `base.import` job, when it has the documented shape. */
export function importResultOf(job: JobDto | undefined): BaseImportResult | undefined {
  if (job?.status !== 'succeeded') return undefined;
  const parsed = baseImportResultSchema.safeParse(job.result);
  return parsed.success ? parsed.data : undefined;
}

/** The download link of an export, only when it is one of this API's own paths. */
export function packageDownloadUrl(result: BaseExportResult | undefined): string | null {
  const url = result?.download_url;
  return typeof url === 'string' && /^\/api\/v1\/files\/exports\/[A-Za-z0-9_-]+$/u.test(url)
    ? url
    : null;
}

/** The problem+json of a failed job as an `ApiError` (translated like any API error). */
export function jobErrorOf(job: JobDto | undefined): ApiError | undefined {
  if (job?.status !== 'failed' || job.error === null) return undefined;
  const status = typeof job.error['status'] === 'number' ? job.error['status'] : 422;
  return problemToApiError(status, job.error);
}

/** `params.more_problems` of an `INVALID_PACKAGE`: problems past the 100 listed. */
export function moreProblemsOf(job: JobDto | undefined): number {
  const params = job?.error?.['params'];
  if (typeof params !== 'object' || params === null) return 0;
  const more = (params as Record<string, unknown>)['more_problems'];
  return typeof more === 'number' && more > 0 ? more : 0;
}

export const EXPORT_PHASES: readonly BaseExportPhase[] = BASE_EXPORT_PHASES.map(([name]) => name);
export const IMPORT_PHASES: readonly BaseImportPhase[] = BASE_IMPORT_PHASES.map(([name]) => name);
export { baseExportPhaseOf, baseImportPhaseOf };
