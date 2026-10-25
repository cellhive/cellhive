import { Buffer } from 'node:buffer';

/**
 * File type checks for uploads (BACKLOG T406, S4 decision #6). Pure
 * functions, no I/O:
 *
 * - native binaries (PE, ELF, Mach-O) are recognised by content, for the
 *   field's `blocked_extensions` (extensions and MIME types are checked by
 *   `isBlockedFileType` of `@cellhive/field-types` when the upload starts);
 * - `complete` reads the first bytes of the object and refuses a file whose
 *   content contradicts its declared MIME type (e.g. a JPEG declared PNG).
 */

/** Bytes `complete` reads from the start of the object. */
export const SNIFF_BYTES = 64;

type Check = (head: Uint8Array) => boolean;

const ascii = (text: string): number[] => Array.from(Buffer.from(text, 'latin1'));

function startsWith(head: Uint8Array, bytes: readonly number[], offset = 0): boolean {
  if (head.length < offset + bytes.length) return false;
  return bytes.every((byte, index) => head[offset + index] === byte);
}

const PNG: Check = (head) => startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG: Check = (head) => startsWith(head, [0xff, 0xd8, 0xff]);
const GIF: Check = (head) => startsWith(head, ascii('GIF87a')) || startsWith(head, ascii('GIF89a'));
const WEBP: Check = (head) => startsWith(head, ascii('RIFF')) && startsWith(head, ascii('WEBP'), 8);
const BMP: Check = (head) => startsWith(head, ascii('BM'));
const PDF: Check = (head) => startsWith(head, ascii('%PDF-'));
const ZIP: Check = (head) =>
  startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06]);
const GZIP: Check = (head) => startsWith(head, [0x1f, 0x8b]);
const ISO_MEDIA: Check = (head) => startsWith(head, ascii('ftyp'), 4);
const OLE: Check = (head) => startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const EBML: Check = (head) => startsWith(head, [0x1a, 0x45, 0xdf, 0xa3]);
const OGG: Check = (head) => startsWith(head, ascii('OggS'));
const WAVE: Check = (head) => startsWith(head, ascii('RIFF')) && startsWith(head, ascii('WAVE'), 8);
const FLAC: Check = (head) => startsWith(head, ascii('fLaC'));
/** MPEG audio frame sync (MP3, ADTS AAC). */
const FRAME_SYNC: Check = (head) =>
  head.length >= 2 && head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0;
const MP3: Check = (head) => startsWith(head, ascii('ID3')) || FRAME_SYNC(head);

/** Declared types whose first bytes are fixed: the content must match. */
const SIGNATURES: Readonly<Record<string, Check>> = {
  'image/png': PNG,
  'image/jpeg': JPEG,
  'image/gif': GIF,
  'image/webp': WEBP,
  'image/bmp': BMP,
  'application/pdf': PDF,
  'application/zip': ZIP,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ZIP,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ZIP,
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ZIP,
  'application/vnd.oasis.opendocument.text': ZIP,
  'application/vnd.oasis.opendocument.spreadsheet': ZIP,
  'application/vnd.oasis.opendocument.presentation': ZIP,
  'application/msword': OLE,
  'application/vnd.ms-excel': OLE,
  'application/vnd.ms-powerpoint': OLE,
  'application/gzip': GZIP,
  'video/mp4': ISO_MEDIA,
  'video/quicktime': ISO_MEDIA,
  'video/webm': EBML,
  'video/ogg': OGG,
  'audio/mp4': ISO_MEDIA,
  'audio/x-m4a': ISO_MEDIA,
  'audio/webm': EBML,
  'audio/ogg': OGG,
  'audio/wav': WAVE,
  'audio/x-wav': WAVE,
  'audio/flac': FLAC,
  'audio/mpeg': MP3,
  'audio/aac': FRAME_SYNC,
};

/** Native executables: PE (`MZ`), ELF, Mach-O (both byte orders, 32/64 bit). */
export function isNativeExecutable(head: Uint8Array): boolean {
  return (
    startsWith(head, ascii('MZ')) ||
    startsWith(head, [0x7f, 0x45, 0x4c, 0x46]) ||
    startsWith(head, [0xfe, 0xed, 0xfa, 0xce]) ||
    startsWith(head, [0xfe, 0xed, 0xfa, 0xcf]) ||
    startsWith(head, [0xce, 0xfa, 0xed, 0xfe]) ||
    startsWith(head, [0xcf, 0xfa, 0xed, 0xfe])
  );
}

/**
 * Whether the first bytes of a file (`head`, up to {@link SNIFF_BYTES})
 * contradict its declared, normalized MIME type: a type with a known
 * signature must start with it. Types without a signature (text, SVG,
 * CSV…) pass. Executables are checked separately ({@link isNativeExecutable}).
 */
export function contentContradictsType(mime: string, head: Uint8Array): boolean {
  const signature = SIGNATURES[mime];
  return signature !== undefined && !signature(head);
}

/**
 * Types downloads serve `inline` (BACKLOG T406, S4 decision #6): raster
 * images a browser renders without running code, and audio/video for the
 * native `<audio>`/`<video>` players. SVG and HTML never are. Each has a
 * signature, so `complete` verified the content.
 */
export const INLINE_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
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
