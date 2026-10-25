import {
  SHARE_FORM_MAX_FILES_PER_QUESTION,
  SHARE_FORM_MAX_UPLOAD_BYTES,
  UPLOAD_LIMIT_EXCEEDED,
  type CreateUploadResponse,
  type Id,
  type ShareFormUploadCompleteRequest,
  type ShareFormUploadDto,
  type ShareFormUploadRequest,
  type ShareLinkCandidatesDto,
  type ShareLinkCandidatesQuery,
} from '@cellhive/contracts';
import {
  attachmentOptionsSchema,
  AttachmentsRepository,
  FieldsRepository,
  RecordQueryService,
  storedViewConfigOf,
  type Db,
  type FieldRow,
} from '@cellhive/server-core';
import { AppError } from '@cellhive/server-core/errors';
import { Inject, Injectable } from '@nestjs/common';

import { requestMetaOf } from '../../common/auth/request-meta.js';
import { ShareRateLimits } from '../../common/rate-limit/share-rate-limits.js';
import { DB } from '../../common/tokens.js';
import { FileService } from '../file/file.service.js';
import { ShareAccessService } from '../share/share-access.service.js';
import { isHiddenQuestion } from '../share/share-form-questions.js';

import { FormSpamGuard } from './form-spam-guard.js';

import type { ResolvedShareLink } from '../share-link/share-link-resolver.service.js';
import type { FastifyRequest } from 'fastify';

function notFound(): AppError {
  return new AppError('NOT_FOUND', { detail: 'Not found.' });
}

function tooMuch(path: string, code: string, message: string, limit: number): AppError {
  return new AppError('VALIDATION_FAILED', {
    detail: message,
    errors: [{ path, code, message, params: { limit } }],
  });
}

/**
 * The inputs of `link` and `attachment` questions of a form link (SPEC §8,
 * §15A; CONTRACTS §17; BACKLOG T410, S4 open questions #4 and #14):
 *
 * - `GET /shares/:token/link-candidates/:fieldId` — records a link question
 *   of an `org` form link offers: `{ id, title }` only, live records of the
 *   linked table the link's creator reads (their current access) that match
 *   the field's `record_filter`. Checked like `meta` (per-IP read limit,
 *   token, audience, password). Public form links hide link questions:
 *   `404`, like view links, fields outside the form or not links.
 * - `POST /shares/:token/uploads` and `…/uploads/:id/complete` — files of an
 *   attachment question, uploaded while the form is filled in: per-IP upload
 *   limit (20 per 10 minutes), token, audience, password, then the field
 *   must be an attachment question of the form the link writes (`404`), and
 *   the request must carry a submit token of the link not used yet (`422
 *   SUBMIT_TOKEN_INVALID`). A token is an upload session: at most
 *   `min(max_files, 10)` files per question and 100 MB in all; the
 *   submission with that token binds only the session's files. Files never
 *   submitted are deleted after 24 hours (`attachments.cleanup`).
 *
 * Nothing here logs file names, storage keys or signed URLs.
 */
@Injectable()
export class ShareFormInputsService {
  private readonly attachments: AttachmentsRepository;

  constructor(
    @Inject(DB) db: Db,
    @Inject(ShareAccessService) private readonly shares: ShareAccessService,
    @Inject(ShareRateLimits) private readonly limits: ShareRateLimits,
    @Inject(FormSpamGuard) private readonly guard: FormSpamGuard,
    @Inject(FieldsRepository) private readonly fields: FieldsRepository,
    @Inject(RecordQueryService) private readonly query: RecordQueryService,
    @Inject(FileService) private readonly files: FileService,
  ) {
    this.attachments = new AttachmentsRepository(db);
  }

  /** `GET /shares/:token/link-candidates/:fieldId`. */
  async linkCandidates(
    token: string,
    fieldId: Id<'fld'>,
    query: ShareLinkCandidatesQuery,
    request: FastifyRequest,
  ): Promise<ShareLinkCandidatesDto> {
    const { link } = await this.shares.open(token, request);
    await this.question(link, fieldId, 'link');
    const search = query.search?.trim() ?? '';
    const page = await this.query.linkCandidates(link.scope, fieldId, link.recordAccess, {
      search: search === '' ? null : search,
      offset: query.offset,
      limit: query.limit,
    });
    return {
      // Only the title: never the display fields of the member picker.
      items: page.items.map((item) => ({ id: item.id, title: item.title })),
      offset: page.offset,
      limit: page.limit,
      has_more: page.has_more,
    };
  }

  /** `POST /shares/:token/uploads`. */
  async createUpload(
    token: string,
    body: ShareFormUploadRequest,
    request: FastifyRequest,
  ): Promise<CreateUploadResponse> {
    await this.limits.hitUpload(requestMetaOf(request).ip);
    const { link } = await this.shares.open(token, request, { rateLimit: false });
    const uploader = this.uploaderOf(link, request);
    const field = await this.question(link, body.field_id, 'attachment');
    const session = await this.guard.uploadSession(link.link.id, body.submit_token);
    const { filename, mime } = this.files.checkUpload(field.options, body);

    const formUpload = { shareLinkId: link.link.id, session };
    const usage = await this.attachments.formUploadUsage(link.scope, formUpload);
    const options = attachmentOptionsSchema.parse(field.options ?? {});
    const maxFiles = Math.min(options.max_files, SHARE_FORM_MAX_FILES_PER_QUESTION);
    if ((usage.files.get(field.id) ?? 0) >= maxFiles) {
      throw tooMuch('field_id', 'TOO_MANY_VALUES', 'This question takes no more files.', maxFiles);
    }
    if (usage.bytes + body.size > SHARE_FORM_MAX_UPLOAD_BYTES) {
      throw tooMuch(
        'size',
        UPLOAD_LIMIT_EXCEEDED,
        'The files of this submission are too large together.',
        SHARE_FORM_MAX_UPLOAD_BYTES,
      );
    }
    const row = await this.attachments.create(link.scope, {
      baseId: link.link.base_id,
      tableId: link.view.table_id,
      fieldId: field.id,
      createdBy: uploader,
      filename,
      mime,
      size: body.size,
      formUpload,
    });
    return this.files.presignUpload(row);
  }

  /** `POST /shares/:token/uploads/:attachmentId/complete`. */
  async completeUpload(
    token: string,
    attachmentId: Id<'att'>,
    body: ShareFormUploadCompleteRequest,
    request: FastifyRequest,
  ): Promise<ShareFormUploadDto> {
    const { link } = await this.shares.open(token, request);
    this.uploaderOf(link, request);
    if (link.link.target_type !== 'form') throw notFound();
    const session = await this.guard.uploadSession(link.link.id, body.submit_token);
    const row = await this.attachments.getById(link.scope, attachmentId);
    // Another link, token or session, or a member's upload: the same `404`.
    if (row?.share_link_id !== link.link.id || row.upload_session !== session) throw notFound();
    const ready = await this.files.finishUpload(link.scope, row);
    return { id: ready.id, name: ready.filename, size: Number(ready.size), mime: ready.mime };
  }

  /**
   * Who uploads: the signed-in submitter of a form with identified
   * submitters (`org` link or `require_login`, `401` without a session),
   * else nobody (anonymous).
   */
  private uploaderOf(link: ResolvedShareLink, request: FastifyRequest): Id<'usr'> | null {
    const form = storedViewConfigOf(link.view.type, link.view.config).form;
    const identified = link.link.audience === 'org' || form?.require_login === true;
    if (!identified) return null;
    const principal = request.principal;
    if (principal === undefined) {
      throw new AppError('UNAUTHENTICATED', { detail: 'Sign in to fill in this form.' });
    }
    return principal.userId;
  }

  /**
   * A question of the link's form on an active field of `type` that the link
   * writes and does not hide; anything else is `404`.
   */
  private async question(
    link: ResolvedShareLink,
    fieldId: Id<'fld'>,
    type: 'link' | 'attachment',
  ): Promise<FieldRow> {
    if (link.link.target_type !== 'form') throw notFound();
    const form = storedViewConfigOf(link.view.type, link.view.config).form;
    if (link.view.type !== 'form' || form?.fields.some((item) => item.field === fieldId) !== true) {
      throw notFound();
    }
    const tableId = link.view.table_id;
    const perm: string | undefined = link.access.access.tables[tableId]?.fields[fieldId];
    if (perm !== 'create' && perm !== 'edit') throw notFound();
    const field = await this.fields.getById(link.scope, fieldId);
    if (field?.table_id !== tableId || field.type !== type || isHiddenQuestion(link.link, type)) {
      throw notFound();
    }
    return field;
  }
}
