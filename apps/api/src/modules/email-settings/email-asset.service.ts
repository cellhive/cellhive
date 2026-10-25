import { createHash } from 'node:crypto';

import {
  ATTACHMENT_DOWNLOAD_URL_SECONDS,
  ATTACHMENT_UPLOAD_URL_SECONDS,
  automationEmailAssetUrl,
  CONTENT_MISMATCH,
  EMAIL_IMAGE_IN_USE,
  EMAIL_IMAGE_MAX_UPLOAD_BYTES,
  EMAIL_IMAGE_MIME_TYPES,
  EMAIL_INLINE_IMAGE_MAX_BYTES,
  FILE_TOO_LARGE,
  IMAGE_UNREADABLE,
  MIME_NOT_ACCEPTED,
  orgEmailAssetUrl,
  SIZE_MISMATCH,
  UPLOAD_INCOMPLETE,
  type CreateUploadResponse,
  type EmailAssetDto,
  type EmailAssetUploadRequest,
  type Id,
} from '@cellhive/contracts';
import { imageMarkdown } from '@cellhive/markdown';
import {
  uploadStagingKey,
  checkUploadedObject,
  EmailAssetsRepository,
  normalizeMimeType,
  sanitizeFilename,
  withTxScope,
  type Db,
  type EmailAssetRow,
  type OrgScope,
  type StorageDriver,
} from '@cellhive/server-core';
import { AppError } from '@cellhive/server-core/errors';
import { processEmailImage, readAtMost } from '@cellhive/worker';
import { Inject, Injectable } from '@nestjs/common';

import { AppLogger } from '../../common/logging/app-logger.js';
import { DB, STORAGE_DRIVER } from '../../common/tokens.js';

import type { FileRedirect } from '../file/file.service.js';

/** Who an email asset belongs to: signatures of the organization, or one automation's body. */
export type EmailAssetOwner =
  | { readonly kind: 'signature' }
  | { readonly kind: 'automation'; readonly automationId: Id<'aut'> };

const IMAGE_TYPES: ReadonlySet<string> = new Set(EMAIL_IMAGE_MIME_TYPES);
/** Default width inserted in the Markdown: the body column of the 600 px layout. */
const DEFAULT_INSERT_WIDTH = 552;

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

function belongsTo(row: EmailAssetRow, owner: EmailAssetOwner): boolean {
  if (row.kind !== owner.kind) return false;
  return owner.kind === 'signature' || row.automation_id === owner.automationId;
}

/**
 * Images of automation emails (CONTRACTS §23.5; BACKLOG T534), kept in
 * `meta.email_assets`. The controllers check who may act — organization
 * owners/admins for signature images, people who manage the automation for
 * its body images — and pass the owner; an asset of another owner (or
 * organization) is `404` like a missing one.
 *
 * - upload: `POST …/uploads` (PNG, JPEG, GIF or WebP up to 10 MiB, presigned
 *   `PUT`) then `POST …/uploads/:id/complete` by the uploader: the stored
 *   object is checked like an attachment (size, first bytes), then
 *   re-encoded by `processEmailImage` — upright, metadata (EXIF, GPS)
 *   removed, inside 1280 × 1280 px — and must stay ≤ 2 MiB; the processed
 *   image replaces the upload. A refused file is deleted with its row;
 * - read: `302` to a signed URL (60 s, `inline`) for the editor's preview;
 * - delete: refused while a signature or the automation still shows it
 *   (`EMAIL_IMAGE_IN_USE`); assets nothing references are otherwise deleted
 *   by `attachments.cleanup` 24 hours after their upload.
 *
 * Nothing here logs file names, storage keys or signed URLs.
 */
@Injectable()
export class EmailAssetService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(EmailAssetsRepository) private readonly assets: EmailAssetsRepository,
    @Inject(STORAGE_DRIVER) private readonly storage: StorageDriver,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  async createUpload(
    scope: OrgScope,
    owner: EmailAssetOwner,
    userId: Id<'usr'>,
    body: EmailAssetUploadRequest,
  ): Promise<CreateUploadResponse> {
    if (body.size > EMAIL_IMAGE_MAX_UPLOAD_BYTES) {
      throw invalid('size', FILE_TOO_LARGE, 'The image is too large.', {
        limit: EMAIL_IMAGE_MAX_UPLOAD_BYTES,
      });
    }
    const mime = normalizeMimeType(body.mime);
    if (mime === null) {
      throw invalid('mime', 'INVALID_FORMAT', 'Expected a MIME type of the form type/subtype.');
    }
    if (!IMAGE_TYPES.has(mime)) {
      throw invalid(
        'mime',
        MIME_NOT_ACCEPTED,
        'An email image must be a PNG, JPEG, GIF or WebP image.',
        { accept: [...EMAIL_IMAGE_MIME_TYPES] },
      );
    }
    const row = await this.assets.create(scope, {
      kind: owner.kind,
      automationId: owner.kind === 'automation' ? owner.automationId : null,
      createdBy: userId,
      filename: sanitizeFilename(body.filename).slice(0, 255) || 'image',
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
   * Checks and processes the uploaded image (see the class comment). Only
   * the uploader, for the owner the upload was started for (else `404`);
   * idempotent once `ready`.
   */
  async complete(
    scope: OrgScope,
    owner: EmailAssetOwner,
    userId: Id<'usr'>,
    assetId: Id<'att'>,
  ): Promise<EmailAssetDto> {
    const row = await this.assets.getById(scope, assetId);
    if (row === undefined || !belongsTo(row, owner) || row.created_by !== userId) {
      throw notFound();
    }
    if (row.status === 'ready') return this.dtoOf(scope, owner, row);
    const checked = await checkUploadedObject(this.storage, row.object_key, {
      size: Number(row.size),
      mime: row.mime,
      blockNativeExecutables: false,
    });
    if (!checked.ok) {
      const failure = FAILURE[checked.reason] ?? FAILURE['CONTENT_MISMATCH'];
      if (checked.reason !== 'UPLOAD_INCOMPLETE') await this.refuse(scope, row, checked.reason);
      throw invalid('', failure?.code ?? CONTENT_MISMATCH, failure?.message ?? '');
    }
    const stream = await this.storage.getStream(row.object_key);
    const original =
      stream === null ? null : await readAtMost(stream, EMAIL_IMAGE_MAX_UPLOAD_BYTES);
    if (original === null) {
      await this.refuse(scope, row, 'SIZE_MISMATCH');
      throw invalid('', SIZE_MISMATCH, FAILURE['SIZE_MISMATCH']?.message ?? '');
    }
    const processed = await processEmailImage(original);
    if (!processed.ok) {
      await this.refuse(scope, row, processed.reason);
      throw invalid(
        '',
        IMAGE_UNREADABLE,
        'The file is not a readable PNG, JPEG, GIF or WebP image.',
        {
          reason: processed.reason,
        },
      );
    }
    const { image } = processed;
    if (image.data.length > EMAIL_INLINE_IMAGE_MAX_BYTES) {
      await this.refuse(scope, row, 'too_large');
      throw invalid('', FILE_TOO_LARGE, 'The image is still too large once resized.', {
        limit: EMAIL_INLINE_IMAGE_MAX_BYTES,
      });
    }
    // The processed image (no metadata) replaces the upload under the same key.
    await this.storage.put(row.object_key, image.data, { contentType: image.mime });
    const ready =
      (await this.assets.markReady(scope, row.id, {
        mime: image.mime,
        size: image.data.length,
        sha256: createHash('sha256').update(image.data).digest('hex'),
        width: image.width,
        height: image.height,
      })) ?? (await this.assets.getById(scope, row.id));
    if (ready?.status !== 'ready') throw notFound();
    return this.dtoOf(scope, owner, ready);
  }

  /** `302` to the image (signed 60 s, `inline`), for the editor's preview. */
  async read(scope: OrgScope, owner: EmailAssetOwner, assetId: Id<'att'>): Promise<FileRedirect> {
    const row = await this.assets.getById(scope, assetId);
    if (row?.status !== 'ready' || !belongsTo(row, owner)) throw notFound();
    const signed = await this.storage.presignGet(row.object_key, {
      filename: row.filename,
      expiresIn: ATTACHMENT_DOWNLOAD_URL_SECONDS,
      disposition: 'inline',
    });
    return { url: signed.url };
  }

  /** Deletes an asset nothing shows (`422 EMAIL_IMAGE_IN_USE` otherwise): object, then row. */
  async delete(scope: OrgScope, owner: EmailAssetOwner, assetId: Id<'att'>): Promise<void> {
    await this.db.withTx(async (tx) => {
      const txScope = withTxScope(scope, tx);
      const row = await this.assets.lockById(txScope, assetId);
      if (row === undefined || !belongsTo(row, owner)) throw notFound();
      if (await this.assets.isReferenced(txScope, row.id)) {
        throw invalid(
          '',
          EMAIL_IMAGE_IN_USE,
          'A signature or an automation still shows this image.',
        );
      }
      await this.storage.delete(row.object_key);
      await this.assets.deleteByIds(txScope, [row.id]);
    });
  }

  /** A refused upload: the object and the row are deleted (logged without names). */
  private async refuse(scope: OrgScope, row: EmailAssetRow, reason: string): Promise<void> {
    await this.storage.delete(row.object_key);
    await this.assets.deleteByIds(scope, [row.id]);
    this.logger.info(
      { organization_id: scope.organizationId, reason },
      'email image upload refused',
    );
  }

  private dtoOf(scope: OrgScope, owner: EmailAssetOwner, row: EmailAssetRow): EmailAssetDto {
    const width = row.width ?? 1;
    const name = row.filename.replace(/\.[A-Za-z0-9]{1,5}$/u, '');
    return {
      id: row.id,
      kind: row.kind,
      name: row.filename,
      mime: row.mime as EmailAssetDto['mime'],
      size: Number(row.size),
      width,
      height: row.height ?? 1,
      markdown: imageMarkdown({
        source: 'asset',
        id: row.id,
        alt: name,
        width: Math.min(width, DEFAULT_INSERT_WIDTH),
      }),
      url:
        owner.kind === 'signature'
          ? orgEmailAssetUrl(scope.organizationId, row.id)
          : automationEmailAssetUrl(owner.automationId, row.id),
    };
  }
}
