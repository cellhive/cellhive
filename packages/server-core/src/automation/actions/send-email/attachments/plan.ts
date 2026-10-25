import { EMAIL_MAX_MESSAGE_BYTES, type EmailAttachmentErrorCode } from '@cellhive/contracts';

import { blockedEmailExtension } from './blocked.js';

import type { EmailAttachmentLimits } from '../../../../mail/settings/org-email-settings.js';

/**
 * Which files a `send_email` step attaches (BACKLOG T532), decided from
 * `meta.attachments` before any byte is read: permissions, file states,
 * blocked types and the limits. Pure: the caller loads the rows and the
 * cells (`EmailAttachmentResolver`). Never puts a file name in a result
 * that leaves the process (params carry ids, extensions and numbers).
 */

/** The parts of a `meta.attachments` row the plan needs. */
export interface AttachmentFileRow {
  readonly id: string;
  readonly field_id: string;
  readonly record_id: string | null;
  readonly object_key: string;
  readonly filename: string;
  readonly mime: string;
  readonly size: number;
  readonly status: string;
  readonly detached_at: Date | null;
  readonly record_purged_at: Date | null;
}

/** One attachment field of the step, as `run_as` sees it now. */
export interface AttachmentFieldSource {
  readonly fieldId: string;
  /**
   * `run_as` reads the record and the field (still an attachment field)
   * and the field is among its `file_download_fields`.
   */
  readonly allowed: boolean;
  /** Attachment ids of the cell, in cell order. */
  readonly fileIds: readonly string[];
}

export interface PlanAttachmentsInput {
  readonly recordId: string;
  readonly sources: readonly AttachmentFieldSource[];
  readonly rows: ReadonlyMap<string, AttachmentFileRow>;
  readonly onMissing: 'fail' | 'skip';
  readonly limits: EmailAttachmentLimits;
  /**
   * Bytes of inline images placed in the same email (BACKLOG T534): they
   * count toward `limits.maxAttachmentBytes` like attached files. Default 0.
   */
  readonly inlineBytes?: number;
  /** UTF-8 bytes of the HTML and text parts (for the whole-message estimate). */
  readonly bodyBytes?: number;
  /** Largest encoded message (`messageByteLimit`). */
  readonly messageLimit?: number;
}

export interface PlannedAttachment {
  readonly id: string;
  readonly fieldId: string;
  readonly filename: string;
  readonly mime: string;
  readonly size: number;
  readonly objectKey: string;
}

export type AttachmentPlan =
  | {
      readonly ok: true;
      readonly files: readonly PlannedAttachment[];
      /** Original bytes of `files`. */
      readonly bytes: number;
      /** Files left out by `on_missing_attachment: skip`. */
      readonly skipped: number;
    }
  | {
      readonly ok: false;
      readonly code: EmailAttachmentErrorCode;
      readonly params: Readonly<Record<string, unknown>>;
    };

const MIB = 1024 * 1024;
/** MIME headers of one attachment part (boundary, type, disposition, encoded name). */
const PART_OVERHEAD = 1024;
/** Message headers and the multipart skeleton. */
const MESSAGE_OVERHEAD = 16 * 1024;

/** Size of `bytes` in base64 with CRLF every 76 characters (RFC 2045). */
export function base64Size(bytes: number): number {
  const encoded = Math.ceil(bytes / 3) * 4;
  return encoded + Math.ceil(encoded / 76) * 2;
}

/**
 * Upper estimate of the encoded message: attachments and body parts in
 * base64 (quoted-printable is never larger for these parts), headers.
 */
export function estimateMessageBytes(fileSizes: readonly number[], bodyBytes: number): number {
  return (
    fileSizes.reduce((total, size) => total + base64Size(size) + PART_OVERHEAD, 0) +
    base64Size(bodyBytes) +
    MESSAGE_OVERHEAD
  );
}

/**
 * Largest encoded message (BACKLOG T532): `EMAIL_MAX_MESSAGE_BYTES` (25
 * MiB), or what files up to the instance cap need with the largest bodies
 * when an operator raised `EMAIL_MAX_ATTACHMENT_BYTES` (their SMTP takes
 * larger messages). The limits of the files are checked first; this is the
 * last check before sending.
 */
export function messageByteLimit(instance: {
  readonly maxAttachmentBytes: number;
  readonly maxHtmlBytes: number;
}): number {
  const needed =
    base64Size(instance.maxAttachmentBytes) +
    base64Size(instance.maxHtmlBytes * 2) +
    MESSAGE_OVERHEAD +
    MIB;
  return Math.max(EMAIL_MAX_MESSAGE_BYTES, needed);
}

function failure(
  code: EmailAttachmentErrorCode,
  params: Readonly<Record<string, unknown>>,
): AttachmentPlan {
  return { ok: false, code, params };
}

/** A file that may be attached now: `ready`, in this cell of this record, not removed. */
function usable(row: AttachmentFileRow | undefined, fieldId: string, recordId: string): boolean {
  return (
    row !== undefined &&
    row.status === 'ready' &&
    row.field_id === fieldId &&
    row.record_id === recordId &&
    row.detached_at === null &&
    row.record_purged_at === null
  );
}

/**
 * The files to attach, or why the step fails. Order of the checks:
 * permissions (`attachment_access_denied`, whatever `onMissing` says),
 * file states (`attachment_not_ready` or skipped), blocked types
 * (`attachment_type_blocked`), number of files (`too_many_attachments`),
 * original bytes with inline images (`attachments_too_large`), then the
 * whole encoded message (`attachments_too_large`, `params.scope = message`).
 * No file is ever dropped silently: skipping is counted, limits fail.
 */
export function planEmailAttachments(input: PlanAttachmentsInput): AttachmentPlan {
  const denied = input.sources.find((source) => !source.allowed);
  if (denied !== undefined) {
    return failure('attachment_access_denied', { field_id: denied.fieldId });
  }
  const files: PlannedAttachment[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const source of input.sources) {
    for (const id of source.fileIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const row = input.rows.get(id);
      if (row === undefined || !usable(row, source.fieldId, input.recordId)) {
        if (input.onMissing === 'fail') {
          return failure('attachment_not_ready', {
            field_id: source.fieldId,
            ...(row === undefined ? {} : { status: row.status }),
          });
        }
        skipped += 1;
        continue;
      }
      const blocked = blockedEmailExtension(row.filename, row.mime);
      if (blocked !== null) {
        return failure('attachment_type_blocked', {
          field_id: source.fieldId,
          extension: blocked,
        });
      }
      files.push({
        id: row.id,
        fieldId: source.fieldId,
        filename: row.filename,
        mime: row.mime,
        size: row.size,
        objectKey: row.object_key,
      });
    }
  }
  const { limits } = input;
  if (files.length > limits.maxAttachments) {
    return failure('too_many_attachments', {
      count: files.length,
      limit: limits.maxAttachments,
    });
  }
  const bytes = files.reduce((total, file) => total + file.size, 0);
  const inlineBytes = input.inlineBytes ?? 0;
  if (bytes + inlineBytes > limits.maxAttachmentBytes) {
    return failure('attachments_too_large', {
      bytes: bytes + inlineBytes,
      limit: limits.maxAttachmentBytes,
    });
  }
  if (input.messageLimit !== undefined) {
    const estimate = estimateMessageBytes(
      [...files.map((file) => file.size), ...(inlineBytes > 0 ? [inlineBytes] : [])],
      input.bodyBytes ?? 0,
    );
    if (estimate > input.messageLimit) {
      return failure('attachments_too_large', {
        scope: 'message',
        bytes: estimate,
        limit: input.messageLimit,
      });
    }
  }
  return { ok: true, files, bytes, skipped };
}
