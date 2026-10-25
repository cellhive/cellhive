import { type AttachmentThumbnailSize, type Id } from '@cellhive/contracts';
import {
  AttachmentsRepository,
  AuditWriter,
  RecordQueryService,
  type AttachmentRow,
  type Db,
} from '@cellhive/server-core';
import { AppError } from '@cellhive/server-core/errors';
import { Inject, Injectable } from '@nestjs/common';

import { auditContextOf, requestMetaOf } from '../../common/auth/request-meta.js';
import { ShareRateLimits } from '../../common/rate-limit/share-rate-limits.js';
import { DB } from '../../common/tokens.js';
import { FileService, type FileRedirect } from '../file/file.service.js';

import { ShareAccessStats } from './share-access-stats.js';
import { ShareAccessService, type OpenedShare } from './share-access.service.js';

import type { FastifyRequest } from 'fastify';
import type { Readable } from 'node:stream';

function notFound(): AppError {
  return new AppError('NOT_FOUND', { detail: 'Not found.' });
}

/**
 * Files of a shared view (SPEC §15A.3, CONTRACTS §16A; BACKLOG T409):
 * `GET /shares/:token/files/:attachmentId` and `…/thumbnail`.
 *
 * Checked on every request, in the order of the other share routes — the
 * per-IP file limit, the token, the audience, the password — then the
 * attachment must be in a cell (not removed) of a record the link reads
 * (the view filter and the creator's record rule, live) in a field of the
 * link (not hidden in the view), else `404`. Downloading also needs
 * `allow_download` and the field among the creator's `file_download_fields`
 * (else `403`) and is audited (`share_link.file_downloaded`); a thumbnail
 * needs neither (SPEC §14.1: viewing without the right to download).
 * Storage keys, file names and signed URLs are never logged.
 */
@Injectable()
export class ShareFileService {
  private readonly attachments: AttachmentsRepository;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ShareAccessService) private readonly shares: ShareAccessService,
    @Inject(ShareRateLimits) private readonly limits: ShareRateLimits,
    @Inject(ShareAccessStats) private readonly stats: ShareAccessStats,
    @Inject(RecordQueryService) private readonly query: RecordQueryService,
    @Inject(FileService) private readonly files: FileService,
  ) {
    this.attachments = new AttachmentsRepository(db);
  }

  /** `GET /shares/:token/files/:attachmentId`: `302` to a URL valid 60 seconds. */
  async download(
    token: string,
    attachmentId: Id<'att'>,
    request: FastifyRequest,
  ): Promise<FileRedirect> {
    const { opened, row } = await this.open(token, attachmentId, request);
    if (!this.downloadable(opened, row)) {
      throw new AppError('PERMISSION_DENIED', {
        detail: 'This link does not allow downloading files.',
      });
    }
    const { link, scope } = opened.link;
    await this.db.withTx((tx) =>
      new AuditWriter().write(tx, {
        action: 'share_link.file_downloaded',
        organizationId: scope.organizationId,
        baseId: link.base_id,
        tableId: row.table_id,
        entityType: 'attachment',
        entityId: row.id,
        after: { record_id: row.record_id, field_id: row.field_id },
        context: {
          ...auditContextOf(requestMetaOf(request), { type: 'share_link', id: link.id }),
          via: { share_link_id: link.id },
        },
      }),
    );
    this.stats.record(scope.organizationId, link.id, false);
    return this.files.signedDownload(row);
  }

  /** `GET /shares/:token/files/:attachmentId/thumbnail` (T407 thumbnails through the link). */
  async thumbnail(
    token: string,
    attachmentId: Id<'att'>,
    size: AttachmentThumbnailSize,
    request: FastifyRequest,
  ): Promise<{ readonly stream: Readable } | FileRedirect> {
    const { opened, row } = await this.open(token, attachmentId, request);
    const thumbnail = await this.files.thumbnailOf(row, size, this.downloadable(opened, row));
    this.stats.record(opened.link.scope.organizationId, opened.link.link.id, false);
    return thumbnail;
  }

  /** The link opened for a file request, and the attachment if the link reaches it (else `404`). */
  private async open(
    token: string,
    attachmentId: Id<'att'>,
    request: FastifyRequest,
  ): Promise<{ opened: OpenedShare; row: AttachmentRow }> {
    await this.limits.hitFile(requestMetaOf(request).ip);
    const opened = await this.shares.open(token, request, { rateLimit: false });
    const { link, view, scope, access, recordAccess } = opened.link;
    if (link.target_type !== 'view') throw notFound();
    const tableId = view.table_id;
    const row = await this.attachments.getById(scope, attachmentId);
    if (
      row?.status !== 'ready' ||
      row.record_id === null ||
      row.detached_at !== null ||
      row.table_id !== tableId
    ) {
      throw notFound();
    }
    // The link's fields: the creator's readable fields minus those hidden in the view (T304).
    const perm: string | undefined = access.access.tables[tableId]?.fields[row.field_id];
    if (perm === undefined || perm === 'no_perm') throw notFound();
    // The record must be readable through the link now (view filter, creator's record rule).
    const [record] = await this.query.getRecords(scope, tableId, [row.record_id], recordAccess, {
      field_key_type: 'id',
      fields: [row.field_id],
    });
    if (record === undefined || !Object.hasOwn(record.fields, row.field_id)) throw notFound();
    return { opened, row };
  }

  /** `allow_download` and the creator's `file_download_fields` (S§14.1, CONTRACTS §16A). */
  private downloadable(opened: OpenedShare, row: AttachmentRow): boolean {
    const { settings, creator, view } = opened.link;
    const table = creator.resolved.access.tables[view.table_id];
    return settings.allow_download && table?.file_download_fields.includes(row.field_id) === true;
  }
}
