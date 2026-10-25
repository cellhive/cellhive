/**
 * The `PUT` of a file to its presigned URL (CONTRACTS §20) through
 * `XMLHttpRequest`: `fetch` reports no upload progress. The browser sends
 * `Content-Length` itself; the signature covers it and `Content-Type`, so
 * a body of another size or type is refused by storage (`403`, or `413`
 * from the `local` driver).
 */

/** Why a transfer stopped. `aborted`: the user cancelled it. */
export type TransferFailure =
  | { readonly kind: 'aborted' }
  | { readonly kind: 'network' }
  | { readonly kind: 'status'; readonly status: number };

export class TransferError extends Error {
  readonly failure: TransferFailure;

  constructor(failure: TransferFailure) {
    super(failure.kind === 'status' ? `Upload refused (${String(failure.status)})` : failure.kind);
    this.name = 'TransferError';
    this.failure = failure;
  }
}

export interface TransferOptions {
  /** Bytes sent so far, of `total`. */
  readonly onProgress?: (loaded: number, total: number) => void;
  readonly signal?: AbortSignal;
}

/** A factory for tests (jsdom has no network). */
export type XhrFactory = () => XMLHttpRequest;

const defaultXhr: XhrFactory = () => new XMLHttpRequest();

export function putFile(
  url: string,
  headers: Readonly<Record<string, string>>,
  body: Blob,
  options: TransferOptions = {},
  createXhr: XhrFactory = defaultXhr,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted === true) {
      reject(new TransferError({ kind: 'aborted' }));
      return;
    }
    const xhr = createXhr();
    xhr.open('PUT', url);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    const onAbort = () => {
      xhr.abort();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const done = () => {
      options.signal?.removeEventListener('abort', onAbort);
    };
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) options.onProgress?.(event.loaded, event.total);
    });
    xhr.addEventListener('load', () => {
      done();
      if (xhr.status >= 200 && xhr.status < 300) {
        options.onProgress?.(body.size, body.size);
        resolve();
      } else {
        reject(new TransferError({ kind: 'status', status: xhr.status }));
      }
    });
    xhr.addEventListener('error', () => {
      done();
      reject(new TransferError({ kind: 'network' }));
    });
    xhr.addEventListener('abort', () => {
      done();
      reject(new TransferError({ kind: 'aborted' }));
    });
    xhr.send(body);
  });
}
