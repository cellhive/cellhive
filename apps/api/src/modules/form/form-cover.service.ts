import {
  ATTACHMENT_DOWNLOAD_URL_SECONDS,
  ATTACHMENT_UPLOAD_URL_SECONDS,
  CONTENT_MISMATCH,
  FILE_TOO_LARGE,
  FORM_COVER_MAX_BYTES,
  FORM_COVER_MIME_TYPES,
  formCoverUrl,
  MIME_NOT_ACCEPTED,
  SIZE_MISMATCH,
  UPLOAD_INCOMPLETE,
  type CreateUploadResponse,
  type FormCoverDto,
  type FormCoverUploadRequest,
  type Id,
} from '@cellhive/contracts';
import {
  uploadStagingKey,
  checkUploadedObject,
  FormCoversRepository,
  normalizeMimeType,
  sanitizeFilename,
  storedViewConfigOf,
  type FormCoverRow,
  type StorageDriver,
  type ViewRow,
} from '@cellhive/server-core';
import { AppError } from '@cellhive/server-core/errors';
import { Inject, Injectable } from '@nestjs/common';

import { requestMetaOf } from '../../common/auth/request-meta.js';
import { AppLogger } from '../../common/logging/app-logger.js';
import { ShareRateLimits } from '../../common/rate-limit/share-rate-limits.js';
import { STORAGE_DRIVER } from '../../common/tokens.js';
import { ShareAccessService } from '../share/share-access.service.js';
import { ViewService } from '../view/view.service.js';

import type { Principal } from '../../common/auth/principal.js';
import type { FileRedirect } from '../file/file.service.js';
import type { FastifyRequest } from 'fastify';

const COVER_TYPES: ReadonlySet<string> = new Set(FORM_COVER_MIME_TYPES);

function notFound(): AppError {
  return new AppError('NOT_FOUND', { detail: 'Not found.' });
}

function invalid(path: string, code: string, message: string, params?: Record<string, unknown>) {
  return new AppError('VALIDATION_FAILED', {
    detail: message,
    errors: [{ path, code, message, ...(params === undefined ? {} : { params }) }],
  });
}

const FAILURE: Readonly<Record<string, { code: string; message: string }>> = {
  UPLOAD_INCOMPLETE: { code: UPLOAD_INCOMPLETE, message: 'The file has not been uploaded yet.' },
  SIZE_MISMATCH: {
    code: SIZE_MISMATCH,
    message: 'The uploaded file does not have the announced size.',
  },
  CONTENT_MISMATCH: {
    code: CONTENT_MISMATCH,
    message: 'The content of the file does not match its type.',
  },
};

/** The cover a form view's saved config names, `null` for none. */
function coverOf(view: ViewRow): string | null {
  if (view.type !== 'form') return null;
  return storedViewConfigOf(view.type, view.config).form?.cover_attachment_id ?? null;
}

/**
 * Cover images of forms (CONTRACTS §15, §17; BACKLOG T419), kept in
 * `meta.form_covers` apart from cell attachments:
 *
 * - upload (`POST /views/:viewId/form-cover/uploads` + `complete`): by
 *   whoever may change the form view's config; PNG, JPEG, GIF or WebP up to
 *   `FORM_COVER_MAX_BYTES`, content checked at `complete` like attachments;
 * - the view config names the cover (`PATCH /views/:viewId`, checked by the
 *   view service: a new value must be the saver's own ready upload);
 * - read: members who see the view (`GET /views/:viewId/form-cover/:id`:
 *   the named cover, or the caller's own upload for a form of the table
 *   the builder shows before saving) and people with the form's share link
 *   (`GET /shares/:token/form-cover/:id`: the named cover only), both a
 *   `302` to a signed URL served `inline` (raster images only).
 *
 * Covers no form view names are deleted by `attachments.cleanup` after 24
 * hours. Nothing here logs file names, storage keys or signed URLs.
 */
@Injectable()
export class FormCoverService {
  constructor(
    @Inject(ViewService) private readonly views: ViewService,
    @Inject(FormCoversRepository) private readonly covers: FormCoversRepository,
    @Inject(ShareAccessService) private readonly shares: ShareAccessService,
    @Inject(ShareRateLimits) private readonly limits: ShareRateLimits,
    @Inject(STORAGE_DRIVER) private readonly storage: StorageDriver,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  /** `POST /views/:viewId/form-cover/uploads`. */
  async createUpload(
    principal: Principal,
    viewId: Id<'viw'>,
    body: FormCoverUploadRequest,
  ): Promise<CreateUploadResponse> {
    const { base, view } = await this.views.locateEditableForm(principal, viewId);
    if (body.size > FORM_COVER_MAX_BYTES) {
      throw invalid('size', FILE_TOO_LARGE, 'The image is too large.', {
        limit: FORM_COVER_MAX_BYTES,
      });
    }
    const mime = normalizeMimeType(body.mime);
    if (mime === null) {
      throw invalid('mime', 'INVALID_FORMAT', 'Expected a MIME type of the form type/subtype.');
    }
    if (!COVER_TYPES.has(mime)) {
      throw invalid('mime', MIME_NOT_ACCEPTED, 'A cover must be a PNG, JPEG, GIF or WebP image.', {
        accept: [...FORM_COVER_MIME_TYPES],
      });
    }
    const row = await this.covers.create(base.org.scope, {
      baseId: base.base.id,
      tableId: view.table_id,
      viewId: view.id,
      createdBy: principal.userId,
      filename: sanitizeFilename(body.filename).slice(0, 255) || 'cover',
      mime,
      size: body.size,
    });
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
   * `POST /views/:viewId/form-cover/uploads/:attachmentId/complete`: the
   * uploader, for the view the upload was started for (else `404`).
   * Idempotent once `ready`. A wrong object is deleted with the row.
   */
  async complete(
    principal: Principal,
    viewId: Id<'viw'>,
    attachmentId: Id<'att'>,
  ): Promise<FormCoverDto> {
    const { base, view } = await this.views.locateEditableForm(principal, viewId);
    const scope = base.org.scope;
    const row = await this.covers.getById(scope, attachmentId);
    if (row?.view_id !== view.id || row.created_by !== principal.userId) throw notFound();
    if (row.status === 'ready') return this.dtoOf(view.id, row);
    const checked = await checkUploadedObject(this.storage, row.object_key, {
      size: Number(row.size),
      mime: row.mime,
      blockNativeExecutables: false,
    });
    if (!checked.ok) {
      const failure = FAILURE[checked.reason] ?? FAILURE['CONTENT_MISMATCH'];
      if (checked.reason !== 'UPLOAD_INCOMPLETE') {
        await this.storage.delete(row.object_key);
        await this.covers.deleteByIds(scope, [row.id]);
        this.logger.info(
          { organization_id: scope.organizationId, reason: checked.reason },
          'form cover upload refused',
        );
      }
      throw invalid('', failure?.code ?? CONTENT_MISMATCH, failure?.message ?? '');
    }
    const ready =
      (await this.covers.markReady(scope, row.id, {
        size: checked.size,
        sha256: checked.sha256,
      })) ?? (await this.covers.getById(scope, row.id));
    if (ready?.status !== 'ready') throw notFound();
    return this.dtoOf(view.id, ready);
  }

  /**
   * `GET /views/:viewId/form-cover/:attachmentId`: a member who sees the
   * view; the cover its saved config names, or the caller's own ready upload
   * for a form of the same table (the builder's draft).
   */
  async read(
    principal: Principal,
    viewId: Id<'viw'>,
    attachmentId: Id<'att'>,
  ): Promise<FileRedirect> {
    const { base, view } = await this.views.locateVisible(principal, viewId);
    const row = await this.covers.getById(base.org.scope, attachmentId);
    if (row?.status !== 'ready' || row.table_id !== view.table_id) throw notFound();
    if (coverOf(view) !== row.id && row.created_by !== principal.userId) throw notFound();
    return this.signed(row);
  }

  /**
   * `GET /shares/:token/form-cover/:attachmentId`: the per-IP file limit,
   * then the checks of every share route (token, audience, password); the
   * link must be a form link and the attachment the cover its form names.
   */
  async readViaLink(
    token: string,
    attachmentId: Id<'att'>,
    request: FastifyRequest,
  ): Promise<FileRedirect> {
    await this.limits.hitFile(requestMetaOf(request).ip);
    const { link } = await this.shares.open(token, request, { rateLimit: false });
    if (link.link.target_type !== 'form' || coverOf(link.view) !== attachmentId) throw notFound();
    const row = await this.covers.getById(link.scope, attachmentId);
    if (row?.status !== 'ready' || row.table_id !== link.view.table_id) throw notFound();
    return this.signed(row);
  }

  private async signed(row: FormCoverRow): Promise<FileRedirect> {
    const signed = await this.storage.presignGet(row.object_key, {
      filename: row.filename,
      expiresIn: ATTACHMENT_DOWNLOAD_URL_SECONDS,
      disposition: 'inline',
    });
    return { url: signed.url };
  }

  private dtoOf(viewId: Id<'viw'>, row: FormCoverRow): FormCoverDto {
    return {
      id: row.id,
      name: row.filename,
      size: Number(row.size),
      mime: row.mime,
      url: formCoverUrl(viewId, row.id),
    };
  }
}
