import { z } from 'zod';

import { isoDateTimeSchema } from './common.js';
import { idOf } from './ids.js';

/**
 * Attachments (SPEC §16, CONTRACTS §20; BACKLOG T406).
 *
 * Flow: `POST /files/uploads` (table, field, filename, size, mime) → a
 * presigned `PUT` valid 10 minutes, signed for the exact `Content-Type` and
 * `Content-Length` → the client uploads straight to storage →
 * `POST /files/uploads/{attachmentId}/complete` (the server checks size and
 * content, computes SHA-256) → the attachment is written to a cell as
 * `[{ "id": "att_…" }]` (CONTRACTS §2). `GET /files/{attachmentId}` checks
 * permissions on every call and redirects to a URL valid 60 seconds.
 */

/** Default of `ATTACHMENT_MAX_FILE_BYTES` (SPEC §14.2: 100 MB per file). */
export const DEFAULT_ATTACHMENT_MAX_FILE_BYTES = 100 * 1024 * 1024;
/** Validity of the presigned upload URL (SPEC §16). */
export const ATTACHMENT_UPLOAD_URL_SECONDS = 600;
/** Validity of the URL a download redirects to (SPEC §16). */
export const ATTACHMENT_DOWNLOAD_URL_SECONDS = 60;
/** An upload never written to a cell is deleted after this many hours (cron `attachments.cleanup`). */
export const ATTACHMENT_UNATTACHED_TTL_HOURS = 24;
/**
 * A file removed from a cell is kept this many days so that undo and
 * history revert can put it back (CONTRACTS §20), then deleted by the cron.
 */
export const ATTACHMENT_DETACHED_RETENTION_DAYS = 30;
/** Longest file name, in characters (after trimming). */
export const ATTACHMENT_MAX_FILENAME_LENGTH = 255;
/** Default `max_files` of an attachment field (BACKLOG S4 decision #6, like Lark); at most 100. */
export const ATTACHMENT_DEFAULT_MAX_FILES = 100;

/**
 * Default `blocked_extensions` of an attachment field (BACKLOG S4 decision
 * #6): executables. Admins (schema permission) edit the list per field; `[]`
 * blocks nothing. An upload is refused (`422 BLOCKED_FILE_TYPE`) when its
 * extension (case-insensitive, trailing dots and spaces ignored) or its MIME
 * type (`ATTACHMENT_EXTENSION_MIME_TYPES` of a listed extension) is blocked;
 * while `exe` is listed, native binaries (PE, ELF, Mach-O) are also refused
 * by content at `complete`. The main protection is how files are served
 * (CONTRACTS §20): never inline outside the preview allowlist, `nosniff`.
 */
export const ATTACHMENT_DEFAULT_BLOCKED_EXTENSIONS = [
  'exe',
  'msi',
  'bat',
  'cmd',
  'sh',
  'ps1',
  'app',
  'dmg',
  'jar',
  'com',
  'scr',
] as const;

/** MIME types refused with an extension of `blocked_extensions`. */
export const ATTACHMENT_EXTENSION_MIME_TYPES: Readonly<Record<string, readonly string[]>> = {
  exe: [
    'application/x-msdownload',
    'application/x-msdos-program',
    'application/x-dosexec',
    'application/vnd.microsoft.portable-executable',
    'application/x-executable',
    'application/x-elf',
  ],
  com: ['application/x-msdos-program'],
  scr: ['application/x-msdownload'],
  msi: ['application/x-msi', 'application/x-ms-installer'],
  bat: ['application/x-bat', 'application/x-msdos-batch', 'text/x-msdos-batch'],
  cmd: ['application/x-bat', 'application/x-msdos-batch', 'text/x-msdos-batch'],
  sh: ['application/x-sh', 'application/x-shellscript', 'text/x-shellscript', 'text/x-sh'],
  ps1: ['application/x-powershell', 'text/x-powershell'],
  app: ['application/x-mach-binary'],
  dmg: ['application/x-apple-diskimage'],
  jar: ['application/java-archive', 'application/x-java-archive'],
};

/** `meta.attachments.status`: `pending_scan` is reserved for virus scanning (Phase 2, SPEC §14.2). */
export const ATTACHMENT_STATUSES = ['pending_upload', 'ready', 'pending_scan'] as const;
export type AttachmentStatus = (typeof ATTACHMENT_STATUSES)[number];

/** Detail code (`VALIDATION_FAILED`): `size` exceeds `ATTACHMENT_MAX_FILE_BYTES` (`params.limit`). */
export const FILE_TOO_LARGE = 'FILE_TOO_LARGE';
/** Detail code (`VALIDATION_FAILED`): `mime` is not in the field's `accept` list. */
export const MIME_NOT_ACCEPTED = 'MIME_NOT_ACCEPTED';
/** Detail code (`VALIDATION_FAILED`): `complete` before the object was uploaded. */
export const UPLOAD_INCOMPLETE = 'UPLOAD_INCOMPLETE';
/** Detail code (`VALIDATION_FAILED`): the stored object does not have the announced size. */
export const SIZE_MISMATCH = 'SIZE_MISMATCH';
/** Detail code (`VALIDATION_FAILED`): the first bytes of the file contradict its MIME type. */
export const CONTENT_MISMATCH = 'CONTENT_MISMATCH';
/** Detail code (`VALIDATION_FAILED`): a type of the field's `blocked_extensions` (extension, MIME type or native binary content). */
export const BLOCKED_FILE_TYPE = 'BLOCKED_FILE_TYPE';

export const createUploadRequestSchema = z
  .strictObject({
    table_id: idOf('tbl'),
    field_id: idOf('fld'),
    filename: z
      .string()
      .trim()
      .min(1)
      .max(ATTACHMENT_MAX_FILENAME_LENGTH)
      .meta({ description: 'Original file name (kept in `meta.attachments`, never in keys)' }),
    size: z
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .meta({ description: 'Exact size in bytes; the upload URL is signed for it' }),
    mime: z.string().min(3).max(255).meta({
      description:
        'MIME type (`type/subtype`, parameters ignored); must match the field’s `accept`',
      example: 'application/pdf',
    }),
  })
  .meta({ id: 'CreateUploadRequest' });
export type CreateUploadRequest = z.infer<typeof createUploadRequestSchema>;

export const presignedUploadSchema = z
  .object({
    method: z.literal('PUT'),
    url: z.string().meta({ description: 'Presigned storage URL (`S3_PUBLIC_ENDPOINT`)' }),
    headers: z.record(z.string(), z.string()).meta({
      description:
        'Headers to send with the `PUT` (`content-type`). The body must be exactly `size` ' +
        'bytes: the signature covers `Content-Length`.',
    }),
    expires_at: isoDateTimeSchema,
  })
  .meta({ id: 'PresignedUpload' });

export const createUploadResponseSchema = z
  .object({
    id: idOf('att'),
    upload: presignedUploadSchema,
  })
  .meta({ id: 'CreateUploadResponse' });
export type CreateUploadResponse = z.infer<typeof createUploadResponseSchema>;

/**
 * Thumbnails (BACKLOG T407, CONTRACTS §20): after `complete`, the worker job
 * `file.thumbnail` renders WebP previews of raster images (at most
 * `ATTACHMENT_THUMBNAIL_MAX_INPUT_BYTES`, at most
 * `ATTACHMENT_THUMBNAIL_MAX_PIXELS`: larger ones — decompression bombs
 * among them — are skipped and the attachment stays `ready`), each fitted
 * inside a square of one of `ATTACHMENT_THUMBNAIL_SIZES` pixels (never
 * enlarged), stored as `{object_key}_t<size>`. `GET /files/{id}/thumbnail`
 * serves them to anyone who can **read** the record and the field — the
 * right to download (`file_download_fields`) is not needed.
 */
export const ATTACHMENT_THUMBNAIL_SIZES = [256, 1280] as const;
export type AttachmentThumbnailSize = (typeof ATTACHMENT_THUMBNAIL_SIZES)[number];
/** Size served when `size` is omitted: grid tiles, panel cards, kanban covers. */
export const ATTACHMENT_THUMBNAIL_DEFAULT_SIZE: AttachmentThumbnailSize = 256;
/** Types that get thumbnails: the raster images served inline (CONTRACTS §20). */
export const ATTACHMENT_THUMBNAIL_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
];
/** Larger files get no thumbnail (the worker reads the file into memory). */
export const ATTACHMENT_THUMBNAIL_MAX_INPUT_BYTES = 50 * 1024 * 1024;
/** Images with more pixels get no thumbnail (decompression bombs, BACKLOG T407). */
export const ATTACHMENT_THUMBNAIL_MAX_PIXELS = 50_000_000;
/** Validity of a served thumbnail in the browser cache, in seconds (private). */
export const ATTACHMENT_THUMBNAIL_CACHE_SECONDS = 60;

/** Whether an attachment of this type and size gets thumbnails. */
export function attachmentHasThumbnail(mime: string, size: number): boolean {
  return (
    ATTACHMENT_THUMBNAIL_TYPES.includes(mime.toLowerCase()) &&
    size > 0 &&
    size <= ATTACHMENT_THUMBNAIL_MAX_INPUT_BYTES
  );
}

/**
 * `thumbnail_url` of an attachment (CONTRACTS §2): `/api/v1/files/{id}/thumbnail`
 * for types that get thumbnails, `null` otherwise. While the thumbnail is not
 * rendered yet or was skipped, the endpoint redirects to the original for
 * callers who may download it and answers `404` to the others (clients show
 * a placeholder). `?size=1280` asks for the large one.
 */
export function attachmentThumbnailUrl(id: string, mime: string, size: number): string | null {
  return attachmentHasThumbnail(mime, size) ? `/api/v1/files/${id}/thumbnail` : null;
}

export const thumbnailQuerySchema = z.object({
  size: z
    .enum(['256', '1280'])
    .default('256')
    .meta({ description: 'Longest side in pixels of the thumbnail (default 256)' }),
});
export type ThumbnailQuery = z.output<typeof thumbnailQuerySchema>;

/** The thumbnail size a query asks for. */
export function thumbnailSizeOf(query: ThumbnailQuery): AttachmentThumbnailSize {
  return query.size === '1280' ? 1280 : 256;
}

/** An attachment as cells return it (CONTRACTS §2) and as `complete` answers. */
export const attachmentSchema = z
  .object({
    id: idOf('att'),
    name: z.string(),
    size: z.int().min(0),
    mime: z.string(),
    url: z.string().meta({ description: '`/api/v1/files/{id}`: checks permissions, then `302`' }),
    thumbnail_url: z
      .string()
      .nullable()
      .meta({
        description:
          '`/api/v1/files/{id}/thumbnail` for PNG, JPEG, GIF and WebP up to 50 MB (read ' +
          'permission is enough), else `null`',
      }),
  })
  .meta({ id: 'Attachment' });
export type AttachmentDto = z.infer<typeof attachmentSchema>;
