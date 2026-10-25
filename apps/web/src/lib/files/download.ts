import { ApiError, problemToApiError } from '../api/client';

/**
 * File downloads (T318, CONTRACTS §18, FRONTEND §7; shared by the table
 * export and, T813, the dashboard widget CSV and PNG): the file is streamed
 * by the browser straight to disk — the SPA never holds it in memory.
 *
 * An export route answers either the file (`Content-Disposition:
 * attachment`) or, before the first byte, a problem+json (`403` without
 * `base_rule.download`, `404`, `422`, `429` while another export of the
 * user runs). A plain link would replace the app with that JSON, so the URL
 * is opened in a hidden same-origin frame: a file becomes a download (the
 * frame shows nothing, no `load` of a document happens), an error loads a
 * JSON document the page can read and turn into a toast.
 */

/** A frame without an answer is removed after this long (the download itself goes on). */
export const DOWNLOAD_FRAME_TTL_MS = 10 * 60_000;

export interface FileDownloadOptions {
  /** Accessible name of the (hidden) frame, translated. */
  readonly title: string;
  /** The server refused before sending the file. */
  readonly onError: (error: ApiError) => void;
  readonly frameTtlMs?: number;
  readonly document?: Document;
}

/** Text of the document the frame shows, or `null` (a download, or unreadable). */
function frameText(frame: HTMLIFrameElement): string | null {
  try {
    const doc = frame.contentDocument;
    // The initial `about:blank` (or a download) has no text.
    if (doc === null) return null;
    // Chrome wraps JSON in a <pre> (plus a "pretty print" control).
    const text = doc.querySelector('pre')?.textContent ?? doc.body.textContent;
    return text.trim() === '' ? null : text;
  } catch {
    // A cross-origin document (a proxy redirect): nothing to read.
    return null;
  }
}

/** The problem+json shown by a frame, as an `ApiError`. */
export function errorOfFrameText(text: string): ApiError {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return new ApiError({ status: 0, code: 'UNEXPECTED_RESPONSE' });
  }
  const status =
    typeof body === 'object' &&
    body !== null &&
    typeof (body as { status?: unknown }).status === 'number'
      ? (body as { status: number }).status
      : 0;
  return problemToApiError(status, body);
}

/**
 * Starts downloading `url` without loading it into the page. Returns a
 * function that forgets the frame (the download, once started, continues).
 */
export function startFileDownload(url: string, options: FileDownloadOptions): () => void {
  const doc = options.document ?? document;
  const frame = doc.createElement('iframe');
  frame.hidden = true;
  frame.tabIndex = -1;
  frame.title = options.title;
  frame.setAttribute('aria-hidden', 'true');
  frame.dataset['download'] = 'export';
  let done = false;
  const remove = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    frame.remove();
  };
  const timer = setTimeout(remove, options.frameTtlMs ?? DOWNLOAD_FRAME_TTL_MS);
  frame.addEventListener('load', () => {
    if (done) return;
    const text = frameText(frame);
    if (text === null) return;
    remove();
    options.onError(errorOfFrameText(text));
  });
  frame.src = url;
  doc.body.append(frame);
  return remove;
}

/**
 * (T813) Saves a file made in the page (a chart PNG) under `filename`: an
 * object URL (`blob:`, allowed by the CSP — no `data:` navigation, no
 * `fetch` of a data URL, which `connect-src` would block) clicked through a
 * detached `<a download>`, revoked right after.
 */
export function saveBlob(blob: Blob, filename: string, doc: Document = document): void {
  const url = URL.createObjectURL(blob);
  const link = doc.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  link.hidden = true;
  doc.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

/** A `data:…;base64,` URL (ECharts `getDataURL`) as a Blob, decoded in the page. */
export function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',');
  const meta = dataUrl.slice(5, comma);
  const type = meta.split(';')[0] ?? 'application/octet-stream';
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type });
}
