import { fileExtensionOf } from '@cellhive/field-types';

import { localPreviews } from './previews';

/**
 * What a file is, for display (T418, board S4 "Ô tệp đính kèm"): raster
 * images get a thumbnail, other files a type badge ("PDF", "XLS"…) in a
 * data color (never the only channel: the file name is always written or
 * announced). Pure (but for the tab's local previews, T421b): shared by the canvas cell, the DOM lists and the tests.
 */

/**
 * Types the API serves `inline` (CONTRACTS §20, server `INLINE_TYPES`):
 * raster images drawn in `<img>` and on the canvas, audio and video for the
 * browser's own players. SVG, HTML, PDF and everything else are only
 * downloaded (never rendered in the app's origin, BACKLOG S4 decision #6).
 */
export const PREVIEW_IMAGE_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);
export const PLAYABLE_VIDEO_TYPES: ReadonlySet<string> = new Set([
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
]);
export const PLAYABLE_AUDIO_TYPES: ReadonlySet<string> = new Set([
  'audio/mpeg',
  'audio/mp4',
  'audio/x-m4a',
  'audio/aac',
  'audio/ogg',
  'audio/webm',
  'audio/wav',
  'audio/x-wav',
  'audio/flac',
]);

export type FileKind =
  'image' | 'video' | 'audio' | 'pdf' | 'sheet' | 'doc' | 'slides' | 'archive' | 'text' | 'other';

const SHEET_EXTENSIONS = new Set(['xls', 'xlsx', 'xlsm', 'ods', 'csv', 'tsv', 'numbers']);
const DOC_EXTENSIONS = new Set(['doc', 'docx', 'odt', 'rtf', 'pages']);
const SLIDE_EXTENSIONS = new Set(['ppt', 'pptx', 'odp', 'key']);
const ARCHIVE_EXTENSIONS = new Set(['zip', 'rar', '7z', 'gz', 'tgz', 'tar', 'bz2', 'xz']);
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'json', 'xml', 'log', 'yaml', 'yml']);

/** The kind of a file from its MIME type, then its extension. */
export function fileKindOf(mime: string, name: string): FileKind {
  const type = mime.toLowerCase();
  const extension = fileExtensionOf(name);
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (type === 'application/pdf' || extension === 'pdf') return 'pdf';
  if (type.includes('spreadsheet') || type.includes('excel') || SHEET_EXTENSIONS.has(extension)) {
    return 'sheet';
  }
  if (
    type.includes('presentation') ||
    type.includes('powerpoint') ||
    SLIDE_EXTENSIONS.has(extension)
  ) {
    return 'slides';
  }
  if (
    type.includes('wordprocessing') ||
    type === 'application/msword' ||
    DOC_EXTENSIONS.has(extension)
  ) {
    return 'doc';
  }
  if (
    type.includes('zip') ||
    type.includes('compressed') ||
    type.includes('tar') ||
    ARCHIVE_EXTENSIONS.has(extension)
  ) {
    return 'archive';
  }
  if (type.startsWith('text/') || TEXT_EXTENSIONS.has(extension)) return 'text';
  return 'other';
}

/** Whether the file gets a thumbnail (a raster image the API serves inline). */
export function isPreviewImage(mime: string): boolean {
  return PREVIEW_IMAGE_TYPES.has(mime.toLowerCase());
}

/** What `imageSourceOf` needs of a file. */
export interface ImageFile {
  /** Attachment id: an image uploaded in this tab is drawn from its local copy (T421b). */
  readonly id?: string | undefined;
  readonly mime: string;
  /** `/api/v1/files/att_…` of a stored file (absent for a local one). */
  readonly url?: string | undefined;
  readonly thumbnail_url?: string | null | undefined;
}

/**
 * Where a raster image is drawn from (T407, CONTRACTS §20): its thumbnail
 * (`thumbnail_url`), which only needs read permission — the API redirects
 * it to the original while it is not rendered, for users who may download
 * — else the file itself when the user may download it; `null` when
 * neither (not an image, or no right: a placeholder). Never SVG or HTML.
 * An image uploaded in this tab: its local copy (T421b, `previews.ts`).
 */
export function imageSourceOf(file: ImageFile, canDownload: boolean): string | null {
  if (!isPreviewImage(file.mime)) return null;
  const local = file.id === undefined ? null : localPreviews.get(file.id);
  if (local !== null) return local;
  const thumbnail = file.thumbnail_url ?? null;
  if (thumbnail !== null) return thumbnail;
  return canDownload && file.url !== undefined ? file.url : null;
}

/** The large thumbnail (1280 px) of an image: what the viewer shows without the right to download. */
export function largeThumbnailOf(file: ImageFile): string | null {
  const thumbnail = file.thumbnail_url ?? null;
  return isPreviewImage(file.mime) && thumbnail !== null ? `${thumbnail}?size=1280` : null;
}

/** How the lightbox shows a file (board S4 "Xem PDF và tệp khác"). */
export type PreviewMode = 'image' | 'video' | 'audio' | 'pdf' | 'download';

export function previewModeOf(mime: string, name: string): PreviewMode {
  const type = mime.toLowerCase();
  if (PREVIEW_IMAGE_TYPES.has(type)) return 'image';
  if (PLAYABLE_VIDEO_TYPES.has(type)) return 'video';
  if (PLAYABLE_AUDIO_TYPES.has(type)) return 'audio';
  if (fileKindOf(type, name) === 'pdf') return 'pdf';
  return 'download';
}

/**
 * Index of the data color (`--option-N`, FRONTEND §9.3 order: gray, sky,
 * leaf, amber, pink, teal, orange, indigo) of a kind's badge, as on the
 * board: PDF red-pink, sheets green, documents sky, video indigo.
 */
const KIND_COLORS: Readonly<Record<FileKind, number>> = {
  image: 5,
  video: 7,
  audio: 6,
  pdf: 4,
  sheet: 2,
  doc: 1,
  slides: 3,
  archive: 0,
  text: 0,
  other: 0,
};

export function kindColorIndex(kind: FileKind): number {
  return KIND_COLORS[kind];
}

const KIND_BADGES: Partial<Readonly<Record<FileKind, string>>> = {
  pdf: 'PDF',
  sheet: 'XLS',
  doc: 'DOC',
  slides: 'PPT',
  archive: 'ZIP',
};

/**
 * The short label of a type badge: "PDF", "XLS", "DOC", "PPT", "ZIP" for
 * the families, else the extension in capitals (at most 4 characters:
 * "MP4", "DWG", "HEIC"), "FILE" without one. Not translated: file types.
 */
export function badgeLabel(mime: string, name: string): string {
  const kind = fileKindOf(mime, name);
  const family = KIND_BADGES[kind];
  if (family !== undefined) return family;
  const extension = fileExtensionOf(name).toUpperCase();
  if (extension !== '' && /^[A-Z0-9]{1,4}$/u.test(extension)) return extension;
  const subtype = mime.split('/')[1]?.toUpperCase() ?? '';
  return /^[A-Z0-9]{1,4}$/u.test(subtype) ? subtype : 'FILE';
}
