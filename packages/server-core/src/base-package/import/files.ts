import {
  ATTACHMENT_DEFAULT_BLOCKED_EXTENSIONS,
  type BaseImportSkippedFileReason,
} from '@cellhive/contracts';
import {
  attachmentOptionsSchema,
  isBlockedFileType,
  mimeAccepted,
  normalizeMimeType,
} from '@cellhive/field-types';

import {
  contentContradictsType,
  isNativeExecutable,
} from '../../records/attachments/content-sniff.js';
import { sanitizeFilename } from '../../storage/content-disposition.js';

/**
 * Files of a `.chbase` import (ADR-24 amendment §4, CONTRACTS §12.2): a file
 * is imported like an upload is accepted — its type and size checked
 * against the field, its first bytes against its type — except that the
 * default block list (`ATTACHMENT_DEFAULT_BLOCKED_EXTENSIONS`) always
 * applies on top of the field's own `blocked_extensions` (a field of the
 * package cannot loosen it) and native binaries are always refused. A file
 * that does not pass is left out of its cell and reported, never an error.
 */

/** What an import decides for one file of a cell. */
export type ImportFileDecision =
  | { readonly ok: true; readonly filename: string; readonly mime: string }
  | { readonly ok: false; readonly reason: BaseImportSkippedFileReason; readonly filename: string };

export interface ImportFileCheckInput {
  readonly filename: string;
  /** `mime` of `files/attachments.json`, normalized here. */
  readonly mime: string;
  /** Bytes of the entry (checked to be the size the metadata names). */
  readonly size: number;
  /** The first bytes of the content (`SNIFF_BYTES`). */
  readonly head: Uint8Array;
  /** Options of the attachment field of the target. */
  readonly fieldOptions: unknown;
  /** `ATTACHMENT_MAX_FILE_BYTES` of the instance. */
  readonly maxFileBytes: number;
}

/** `null` when the MIME type of the package is not `type/subtype`. */
export function importedMimeOf(mime: string): string | null {
  return normalizeMimeType(mime);
}

/**
 * Checks one file the way an upload is checked (CONTRACTS §20), in the
 * order size → blocked type (default list ∪ the field's, extension or MIME
 * type, native binary content) → `accept` → content against the type.
 * `blocked_file_type` also covers a type the field does not accept.
 */
export function checkImportedFile(input: ImportFileCheckInput): ImportFileDecision {
  const filename = sanitizeFilename(input.filename).slice(0, 255);
  const mime = normalizeMimeType(input.mime) ?? 'application/octet-stream';
  if (input.size > input.maxFileBytes) return { ok: false, reason: 'file_too_large', filename };
  const options = attachmentOptionsSchema.safeParse(input.fieldOptions ?? {});
  const fieldBlocked = options.success ? options.data.blocked_extensions : [];
  const blocked = [...new Set([...ATTACHMENT_DEFAULT_BLOCKED_EXTENSIONS, ...fieldBlocked])];
  if (isBlockedFileType(filename, mime, blocked) || isNativeExecutable(input.head)) {
    return { ok: false, reason: 'blocked_file_type', filename };
  }
  if (options.success && !mimeAccepted(mime, options.data.accept)) {
    return { ok: false, reason: 'blocked_file_type', filename };
  }
  if (contentContradictsType(mime, input.head)) {
    return { ok: false, reason: 'content_mismatch', filename };
  }
  return { ok: true, filename, mime };
}
