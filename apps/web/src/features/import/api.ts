import {
  CSRF_COOKIE,
  CSRF_HEADER,
  importPreviewSchema,
  importUploadSchema,
  jobAcceptedSchema,
  jobSchema,
  type ImportPreviewQuery,
  type ImportUploadDto,
  type StartImportRequest,
} from '@cellhive/contracts';

import {
  API_BASE,
  ApiError,
  apiRequest,
  problemToApiError,
  readCookie,
} from '../../lib/api/client';

const id = encodeURIComponent;

export interface UploadOptions {
  /** Share of the file sent so far, 0–1. */
  readonly onProgress?: (sent: number) => void;
  readonly signal?: AbortSignal;
}

function retryAfter(xhr: XMLHttpRequest): number | undefined {
  const value = Number(xhr.getResponseHeader('retry-after') ?? Number.NaN);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * `POST /bases/:id/imports/uploads` (CONTRACTS §19) as `multipart/form-data`
 * with a `file` part. XHR rather than `fetch`: only it reports upload
 * progress. Same headers as the API client (CSRF double submit, F§12).
 */
export function uploadImportFile(
  baseId: string,
  file: File,
  options: UploadOptions = {},
): Promise<ImportUploadDto> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/bases/${id(baseId)}/imports/uploads`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Accept', 'application/json');
    const csrf = readCookie(CSRF_COOKIE);
    if (csrf !== undefined) xhr.setRequestHeader(CSRF_HEADER, csrf);
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && event.total > 0)
        options.onProgress?.(event.loaded / event.total);
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
        const parsed = importUploadSchema.safeParse(body);
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
    form.append('file', file, file.name);
    xhr.send(form);
  });
}

/** Import endpoints of CONTRACTS §19 other than the upload. */
export const importsApi = {
  preview: (baseId: string, uploadId: string, query: ImportPreviewQuery, signal?: AbortSignal) =>
    apiRequest(
      `/bases/${id(baseId)}/imports/uploads/${id(uploadId)}/preview`,
      importPreviewSchema,
      { query: { ...query }, signal },
    ),
  start: (baseId: string, body: StartImportRequest, idempotencyKey: string) =>
    apiRequest(`/bases/${id(baseId)}/imports`, jobAcceptedSchema, {
      method: 'POST',
      body,
      idempotencyKey,
    }),
  cancel: (baseId: string, jobId: string) =>
    apiRequest(`/bases/${id(baseId)}/imports/${id(jobId)}/cancel`, jobSchema, { method: 'POST' }),
};
