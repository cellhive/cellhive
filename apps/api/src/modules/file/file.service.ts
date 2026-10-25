import {
  ATTACHMENT_DOWNLOAD_URL_SECONDS,
  ATTACHMENT_UPLOAD_URL_SECONDS,
  attachmentHasThumbnail,
  attachmentThumbnailUrl,
  BLOCKED_FILE_TYPE,
  CONTENT_MISMATCH,
  FILE_TOO_LARGE,
  MIME_NOT_ACCEPTED,
  SIZE_MISMATCH,
  UPLOAD_INCOMPLETE,
  type AttachmentDto,
  type AttachmentThumbnailSize,
  type CreateUploadRequest,
  type CreateUploadResponse,
  type Id,
} from '@cellhive/contracts';
import {
  uploadStagingKey,
  AppError,
  ATTACHMENT_URL_PREFIX,
  attachmentOptionsSchema,
  mimeAccepted,
  normalizeMimeType,
  AttachmentsRepository,
  attachmentThumbnailKey,
  checkUploadedObject,
  enqueue,
  fileExtensionOf,
  FieldsRepository,
  INLINE_TYPES,
  isBlockedFileType,
  orgScope,
  RecordQueryService,
  sanitizeFilename,
  withTxScope,
  type AppConfig,
  type AttachmentRow,
  type Db,
  type OrgScope,
  type StorageDriver,
  type UploadCheckFailure,
} from '@cellhive/server-core';
import { Inject, Injectable } from '@nestjs/common';

import { AccessService, notFound, permissionDenied } from '../../common/access/access.service.js';
import { AppLogger } from '../../common/logging/app-logger.js';
import { APP_CONFIG, DB, STORAGE_DRIVER } from '../../common/tokens.js';
import { RecordService } from '../record/record.service.js';

import type { Principal } from '../../common/auth/principal.js';
import type { Readable } from 'node:stream';

/** Attempts of a `file.thumbnail` job (storage errors are retried; bad images are not). */
export const FILE_THUMBNAIL_MAX_ATTEMPTS = 3;

const FAILURE_DETAIL: Readonly<Record<UploadCheckFailure, string>> = {
  UPLOAD_INCOMPLETE: 'The file has not been uploaded yet.',
  SIZE_MISMATCH: 'The uploaded file does not have the announced size.',
  CONTENT_MISMATCH: 'The content of the file does not match its type.',
  BLOCKED_FILE_TYPE: 'This type of file is blocked for this field.',
};

const FAILURE_CODE: Readonly<Record<UploadCheckFailure, string>> = {
  UPLOAD_INCOMPLETE,
  SIZE_MISMATCH,
  CONTENT_MISMATCH,
  BLOCKED_FILE_TYPE,
};

function invalid(path: string, code: string, message: string, params?: Record<string, unknown>) {
  return new AppError('VALIDATION_FAILED', {
    detail: message,
    errors: [{ path, code, message, ...(params === undefined ? {} : { params }) }],
  });
}

export function attachmentDtoOf(row: AttachmentRow): AttachmentDto {
  return {
    id: row.id,
    name: row.filename,
    size: Number(row.size),
    mime: row.mime,
    url: `${ATTACHMENT_URL_PREFIX}${row.id}`,
    // Same rule as cells (field-types): the endpoint answers once rendered (T407).
    thumbnail_url: attachmentThumbnailUrl(row.id, row.mime, Number(row.size)),
  };
}

/** Where a download redirects to, and how the file is presented. */
export interface FileRedirect {
  readonly url: string;
}

/**
 * Attachment uploads and downloads (SPEC §16, CONTRACTS §20; BACKLOG T406).
 * Writing an uploaded file to a cell goes through `RecordMutationService`
 * like any record write; this service only issues upload URLs, checks
 * finished uploads and authorises downloads.
 *
 * Nothing here logs file names, storage keys or signed URLs.
 */
@Injectable()
export class FileService {
  private readonly attachments: AttachmentsRepository;
  private readonly fields: FieldsRepository;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(RecordService) private readonly records: RecordService,
    @Inject(RecordQueryService) private readonly query: RecordQueryService,
    @Inject(STORAGE_DRIVER) private readonly storage: StorageDriver,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {
    this.attachments = new AttachmentsRepository(db);
    this.fields = new FieldsRepository(db);
  }

  /**
   * `POST /files/uploads`: the caller must be able to write the field (a
   * table or field they cannot see → `404`; seen but not writable → `403`).
   * Checks the field's `accept` and `ATTACHMENT_MAX_FILE_BYTES`, records a
   * `pending_upload` row and signs a `PUT` for the exact type and size.
   */
  async createUpload(
    principal: Principal,
    body: CreateUploadRequest,
  ): Promise<CreateUploadResponse> {
    const table = await this.records.resolve(principal, body.table_id);
    const tableAccess = table.access.resolved.access.tables[body.table_id];
    const field = await this.fields.getById(table.scope, body.field_id);
    const perm: string | undefined = tableAccess?.fields[body.field_id];
    if (
      tableAccess === undefined ||
      field?.table_id !== body.table_id ||
      perm === undefined ||
      perm === 'no_perm'
    ) {
      throw notFound();
    }
    if (field.type !== 'attachment') {
      throw invalid('field_id', 'INVALID_FIELD_TYPE', 'The field is not an attachment field.', {
        expected: 'attachment',
        type: field.type,
      });
    }
    const writable =
      (tableAccess.perm === 'edit' || tableAccess.perm === 'manage') &&
      (perm === 'edit' || perm === 'create');
    if (!writable) throw permissionDenied('You cannot add files to this field.');

    const { filename, mime } = this.checkUpload(field.options, body);
    const row = await this.attachments.create(table.scope, {
      baseId: table.base.base.id,
      tableId: body.table_id,
      fieldId: body.field_id,
      createdBy: principal.userId,
      filename,
      mime,
      size: body.size,
    });
    return this.presignUpload(row);
  }

  /**
   * The checks of a new upload against the field, in the order of CONTRACTS
   * §20: size (`FILE_TOO_LARGE`), MIME type, blocked types, `accept`.
   * Returns the sanitized name and the normalized type. Shared with form
   * link uploads (T410).
   */
  checkUpload(
    fieldOptions: unknown,
    body: { readonly filename: string; readonly size: number; readonly mime: string },
  ): { filename: string; mime: string } {
    const limit = this.config.limits.attachmentMaxFileBytes;
    if (body.size > limit) {
      throw invalid('size', FILE_TOO_LARGE, `The file is larger than ${String(limit)} bytes.`, {
        limit,
      });
    }
    const mime = normalizeMimeType(body.mime);
    if (mime === null) {
      throw invalid('mime', 'INVALID_FORMAT', 'Expected a MIME type of the form type/subtype.');
    }
    const filename = sanitizeFilename(body.filename).slice(0, 255);
    const options = attachmentOptionsSchema.parse(fieldOptions ?? {});
    if (isBlockedFileType(filename, mime, options.blocked_extensions)) {
      // BACKLOG S4 decision #6: the field's blocked types (default: executables).
      throw invalid(
        isBlockedFileType(filename, '', options.blocked_extensions) ? 'filename' : 'mime',
        BLOCKED_FILE_TYPE,
        'This type of file is blocked for this field.',
        { extension: fileExtensionOf(filename) },
      );
    }
    if (!mimeAccepted(mime, options.accept)) {
      throw invalid('mime', MIME_NOT_ACCEPTED, 'The field does not accept this type of file.', {
        accept: options.accept,
      });
    }
    return { filename, mime };
  }

  /** The presigned `PUT` of a new upload (exact type and size, 10 minutes). */
  async presignUpload(row: AttachmentRow): Promise<CreateUploadResponse> {
    const size = Number(row.size);
    const upload = await this.storage.presignPut(uploadStagingKey(row.object_key), {
      contentType: row.mime,
      maxBytes: size,
      contentLength: size,
      expiresIn: ATTACHMENT_UPLOAD_URL_SECONDS,
    });
    return {
      id: row.id,
      upload: {
        method: 'PUT',
        url: upload.url,
        headers: { ...upload.headers },
        expires_at: upload.expiresAt.toISOString(),
      },
    };
  }

  /**
   * `POST /files/uploads/:id/complete`, by the uploader only (anyone else:
   * `404`). Idempotent once `ready`. Missing object → `422
   * UPLOAD_INCOMPLETE` (retry after the `PUT`); wrong size or content →
   * the object and the upload are deleted, `422 SIZE_MISMATCH` /
   * `CONTENT_MISMATCH`.
   */
  async complete(principal: Principal, attachmentId: Id<'att'>): Promise<AttachmentDto> {
    const { scope, row } = await this.ownUpload(principal, attachmentId);
    return attachmentDtoOf(await this.finishUpload(scope, row));
  }

  /**
   * Checks an uploaded object and marks it `ready` (see `complete`); the
   * caller checked who may finish the upload. Shared with form link
   * uploads (T410).
   */
  async finishUpload(scope: OrgScope, row: AttachmentRow): Promise<AttachmentRow> {
    if (row.status !== 'pending_upload') return row;
    // The field's current blocked list (an admin may have changed it since the upload started).
    const field = await this.fields.getById(scope, row.field_id, { includeDeleted: true });
    const blocked = attachmentOptionsSchema.parse(field?.options ?? {}).blocked_extensions;
    const checked = isBlockedFileType(row.filename, row.mime, blocked)
      ? ({ ok: false, reason: 'BLOCKED_FILE_TYPE' } as const)
      : await checkUploadedObject(this.storage, row.object_key, {
          size: Number(row.size),
          mime: row.mime,
          blockNativeExecutables: blocked.includes('exe'),
        });
    if (!checked.ok) {
      if (checked.reason !== 'UPLOAD_INCOMPLETE') {
        await this.storage.delete(row.object_key);
        await this.attachments.deleteByIds(scope, [row.id]);
        this.logger.info(
          { organization_id: scope.organizationId, reason: checked.reason },
          'attachment upload refused',
        );
      }
      throw invalid('', FAILURE_CODE[checked.reason], FAILURE_DETAIL[checked.reason]);
    }
    // Raster images get thumbnails (T407): the job is enqueued with the state change.
    const thumbnail = attachmentHasThumbnail(row.mime, checked.size);
    const ready = await this.db.withTx(async (tx) => {
      const marked = await this.attachments.markReady(withTxScope(scope, tx), row.id, {
        size: checked.size,
        sha256: checked.sha256,
        thumbnailStatus: thumbnail ? 'pending' : null,
      });
      if (marked !== undefined && thumbnail) {
        await enqueue(
          tx,
          'file.thumbnail',
          { organization_id: scope.organizationId, attachment_id: marked.id },
          { maxAttempts: FILE_THUMBNAIL_MAX_ATTEMPTS, jobKey: `file.thumbnail:${marked.id}` },
        );
      }
      return marked;
    });
    if (ready !== undefined) return ready;
    // A concurrent `complete` won the race.
    const current = await this.attachments.getById(scope, row.id);
    if (current === undefined || current.status === 'pending_upload') throw notFound();
    return current;
  }

  /**
   * `GET /files/:attachmentId`: on every call, the caller must read the
   * record (read rule, live) and the field, else `404`; the field must be
   * among the role's `file_download_fields`, else `403`. Redirects to a
   * storage URL valid 60 seconds; only safe raster images, audio and video
   * are `inline` (native players, BACKLOG S4 decision #6).
   */
  async download(principal: Principal, attachmentId: Id<'att'>): Promise<FileRedirect> {
    const { row, downloadable } = await this.readable(principal, attachmentId);
    if (!downloadable) {
      throw permissionDenied('You cannot download the files of this field.');
    }
    return this.signedDownload(row);
  }

  /**
   * The storage URL (60 s) a download of an attachment the caller was
   * allowed to download redirects to: `inline` only for safe raster
   * images, audio and video. Shared with share link downloads (T409).
   */
  async signedDownload(row: AttachmentRow): Promise<FileRedirect> {
    const signed = await this.storage.presignGet(row.object_key, {
      filename: row.filename,
      expiresIn: ATTACHMENT_DOWNLOAD_URL_SECONDS,
      disposition: INLINE_TYPES.has(row.mime) ? 'inline' : 'attachment',
    });
    return { url: signed.url };
  }

  /**
   * `GET /files/:attachmentId/thumbnail` (BACKLOG T407): the same checks as
   * a download except `file_download_fields` — reading the record and the
   * field is enough (SPEC §14.1: viewing without the right to download).
   * The WebP comes from the worker (`sharp`), never from the uploader.
   * Without a thumbnail (not rendered yet, skipped): the original image for
   * callers who may download it (a redirect like `download`, so `<img>` and
   * the grid canvas need no fallback of their own), `404` for the others.
   * The uploader also sees the thumbnail of their own upload before it is
   * written to a cell (T421b: the panel shows it as soon as `complete`
   * answers), under the same field rules; nobody else does.
   */
  async thumbnail(
    principal: Principal,
    attachmentId: Id<'att'>,
    size: AttachmentThumbnailSize,
  ): Promise<{ readonly stream: Readable } | FileRedirect> {
    const { row, downloadable } = await this.readable(principal, attachmentId, {
      ownUpload: true,
    });
    return this.thumbnailOf(row, size, downloadable);
  }

  /**
   * The thumbnail of an attachment the caller may read (checked by the
   * caller): the rendered WebP, else the original image when
   * `downloadable`, else `404`. Shared with share links (T409).
   */
  async thumbnailOf(
    row: AttachmentRow,
    size: AttachmentThumbnailSize,
    downloadable: boolean,
  ): Promise<{ readonly stream: Readable } | FileRedirect> {
    if (!attachmentHasThumbnail(row.mime, Number(row.size))) throw notFound();
    if (row.thumbnail_status === 'ready') {
      const stream = await this.storage.getStream(attachmentThumbnailKey(row.object_key, size));
      if (stream !== null) return { stream };
    }
    if (!downloadable) throw notFound();
    const signed = await this.storage.presignGet(row.object_key, {
      filename: row.filename,
      expiresIn: ATTACHMENT_DOWNLOAD_URL_SECONDS,
      disposition: 'inline',
    });
    return { url: signed.url };
  }

  /**
   * An attachment in a cell whose record (read rule, live) and field the
   * caller reads, else `404`; `downloadable` = the field is among the
   * role's `file_download_fields` (S§14.1). With `ownUpload`, also the
   * caller's own finished upload not yet in any cell (never detached, not a
   * form link upload), provided they still read the field.
   */
  private async readable(
    principal: Principal,
    attachmentId: Id<'att'>,
    options: { readonly ownUpload?: boolean } = {},
  ): Promise<{ row: AttachmentRow; downloadable: boolean }> {
    const found = await this.find(principal, attachmentId);
    const row = found?.row;
    if (row?.status !== 'ready' || row.detached_at !== null) throw notFound();
    const pending =
      row.record_id === null &&
      options.ownUpload === true &&
      row.created_by === principal.userId &&
      row.upload_session === null;
    if (row.record_id === null && !pending) throw notFound();
    const table = await this.records.resolve(principal, row.table_id);
    const tableAccess = table.access.resolved.access.tables[row.table_id];
    const perm: string | undefined = tableAccess?.fields[row.field_id];
    if (tableAccess === undefined || perm === undefined || perm === 'no_perm') throw notFound();
    const downloadable = tableAccess.file_download_fields.includes(row.field_id);
    if (row.record_id === null) return { row, downloadable };
    const [record] = await this.query.getRecords(
      table.scope,
      row.table_id,
      [row.record_id],
      table.access,
      {
        field_key_type: 'id',
        fields: [row.field_id],
      },
    );
    if (record === undefined || !Object.hasOwn(record.fields, row.field_id)) throw notFound();
    return { row, downloadable };
  }

  /** The caller's own upload, in whichever of their organizations holds it; `404` otherwise. */
  private async ownUpload(
    principal: Principal,
    attachmentId: Id<'att'>,
  ): Promise<{ scope: OrgScope; row: AttachmentRow }> {
    const found = await this.find(principal, attachmentId);
    // Form link uploads (T410) are finished through their link only.
    if (
      found === undefined ||
      found.row.created_by !== principal.userId ||
      found.row.upload_session !== null
    ) {
      throw notFound();
    }
    return found;
  }

  private async find(
    principal: Principal,
    attachmentId: Id<'att'>,
  ): Promise<{ scope: OrgScope; row: AttachmentRow } | undefined> {
    for (const membership of await this.access.memberships(principal)) {
      const scope = orgScope(membership.organizationId);
      const row = await this.attachments.getById(scope, attachmentId);
      if (row !== undefined) return { scope, row };
    }
    return undefined;
  }
}
