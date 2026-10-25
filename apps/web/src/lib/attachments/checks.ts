import { DEFAULT_ATTACHMENT_MAX_FILE_BYTES } from '@cellhive/contracts';
import {
  fileExtensionOf,
  isBlockedFileType,
  mimeAccepted,
  normalizeMimeType,
  type AttachmentOptions,
} from '@cellhive/field-types';

/**
 * Checks made before an upload starts (T418, CONTRACTS §20): the server
 * makes them again, in the same order (size, blocked type, `accept`), and
 * answers with the same detail codes; `max_files` is checked here against
 * the files of the cell and the uploads already on their way.
 */

/** Why a file is not uploaded, as a detail code of CONTRACTS §6 (`VALIDATION_FAILED`). */
export type UploadCheckCode =
  'FILE_TOO_LARGE' | 'BLOCKED_FILE_TYPE' | 'MIME_NOT_ACCEPTED' | 'TOO_MANY_VALUES';

export interface UploadCheckIssue {
  readonly code: UploadCheckCode;
  readonly params?: Readonly<Record<string, unknown>>;
}

/** Types of common extensions, for files the browser gives no type (`File.type === ''`). */
const EXTENSION_TYPES: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  csv: 'text/csv',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  zip: 'application/zip',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  m4a: 'audio/x-m4a',
  wav: 'audio/wav',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** The MIME type sent for a file: the browser's, else by extension, else `application/octet-stream`. */
export function mimeOfFile(file: { readonly name: string; readonly type: string }): string {
  return (
    normalizeMimeType(file.type) ??
    EXTENSION_TYPES[fileExtensionOf(file.name)] ??
    'application/octet-stream'
  );
}

export interface CheckLimits {
  /** Files already in the cell plus uploads on their way (they count against `max_files`). */
  readonly used: number;
  /** `ATTACHMENT_MAX_FILE_BYTES` (the server's default when the client knows no other). */
  readonly maxBytes?: number;
}

export interface CheckedFile<F> {
  readonly file: F;
  readonly mime: string;
  readonly issue: UploadCheckIssue | null;
}

/** One file against the field's options: size, blocked type, `accept` (server order). */
export function checkFile(
  file: { readonly name: string; readonly type: string; readonly size: number },
  options: AttachmentOptions,
  maxBytes: number = DEFAULT_ATTACHMENT_MAX_FILE_BYTES,
): UploadCheckIssue | null {
  const mime = mimeOfFile(file);
  if (file.size > maxBytes) return { code: 'FILE_TOO_LARGE', params: { limit: maxBytes } };
  if (isBlockedFileType(file.name, mime, options.blocked_extensions)) {
    return { code: 'BLOCKED_FILE_TYPE', params: { extension: fileExtensionOf(file.name) } };
  }
  if (!mimeAccepted(mime, options.accept)) {
    return { code: 'MIME_NOT_ACCEPTED', params: { accept: options.accept ?? [] } };
  }
  return null;
}

/**
 * Files picked, dropped or pasted, in order, each with the reason it cannot
 * be uploaded: its own problem first, then `max_files` (the files that
 * would go past it, counting only the acceptable ones before them).
 */
export function checkFiles<F extends { name: string; type: string; size: number }>(
  files: readonly F[],
  options: AttachmentOptions,
  limits: CheckLimits,
): CheckedFile<F>[] {
  let room = options.max_files - limits.used;
  return files.map((file) => {
    const mime = mimeOfFile(file);
    const own = checkFile(file, options, limits.maxBytes);
    if (own !== null) return { file, mime, issue: own };
    if (room <= 0) {
      return { file, mime, issue: { code: 'TOO_MANY_VALUES', params: { max: options.max_files } } };
    }
    room -= 1;
    return { file, mime, issue: null };
  });
}

/**
 * Short names of accepted types for the helper line ("JPG, PNG, WEBP"):
 * common image and document types by their usual name, `type/*` by family.
 */
const TYPE_NAMES: Readonly<Record<string, string>> = {
  'image/jpeg': 'JPG',
  'image/png': 'PNG',
  'image/webp': 'WEBP',
  'image/gif': 'GIF',
  'image/heic': 'HEIC',
  'application/pdf': 'PDF',
  'application/zip': 'ZIP',
  'text/csv': 'CSV',
  'text/plain': 'TXT',
  'video/mp4': 'MP4',
  'audio/mpeg': 'MP3',
  'application/msword': 'DOC',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
  'application/vnd.ms-excel': 'XLS',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX',
  'application/vnd.ms-powerpoint': 'PPT',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PPTX',
};

/** An `accept` entry for people: `JPG`, or the family key of `type/*` (`image`, `video`…). */
export type AcceptLabel = { readonly name: string } | { readonly family: string };

export function acceptLabels(accept: readonly string[]): AcceptLabel[] {
  return accept.map((entry) => {
    if (entry.endsWith('/*')) return { family: entry.slice(0, -2) };
    const known = TYPE_NAMES[entry];
    if (known !== undefined) return { name: known };
    const subtype = entry.split('/')[1] ?? entry;
    return { name: subtype.replace(/^x-/u, '').toUpperCase() };
  });
}

/** The `accept` attribute of a file input for the field (`null` → any file). */
export function inputAccept(accept: readonly string[] | null): string | undefined {
  if (accept === null || accept.length === 0) return undefined;
  const extensions = Object.entries(EXTENSION_TYPES)
    .filter(([, mime]) => accept.includes(mime))
    .map(([extension]) => `.${extension}`);
  return [...accept, ...extensions].join(',');
}
