import {
  createUploadRequestSchema,
  idOf,
  thumbnailQuerySchema,
  thumbnailSizeOf,
  type AttachmentDto,
  type CreateUploadRequest,
  type CreateUploadResponse,
  type Id,
  type ThumbnailQuery,
} from '@cellhive/contracts';
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Res } from '@nestjs/common';

import { CurrentPrincipal, type Principal } from '../../common/auth/principal.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';

import { sendFileRedirect, sendThumbnail } from './file-replies.js';
import { FileService } from './file.service.js';

import type { FastifyReply } from 'fastify';

const attachmentIdPipe = new ZodValidationPipe(idOf('att'));

/** Attachment uploads and downloads (SPEC §16, CONTRACTS §20; BACKLOG T406). */
@Controller('files')
export class FileController {
  constructor(@Inject(FileService) private readonly files: FileService) {}

  @Post('uploads')
  @HttpCode(201)
  createUpload(
    @Body(new ZodValidationPipe(createUploadRequestSchema)) body: CreateUploadRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CreateUploadResponse> {
    return this.files.createUpload(principal, body);
  }

  @Post('uploads/:attachmentId/complete')
  @HttpCode(200)
  complete(
    @Param('attachmentId', attachmentIdPipe) attachmentId: Id<'att'>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AttachmentDto> {
    return this.files.complete(principal, attachmentId);
  }

  /** Checks permissions on every call, then redirects to a URL valid 60 seconds. */
  @Get(':attachmentId')
  async download(
    @Param('attachmentId', attachmentIdPipe) attachmentId: Id<'att'>,
    @CurrentPrincipal() principal: Principal,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await sendFileRedirect(reply, await this.files.download(principal, attachmentId));
  }

  /**
   * The WebP thumbnail of an image (BACKLOG T407): read permission on the
   * record and the field is enough. Streamed by the API (same origin), so
   * it is never sniffed nor scripted and may be cached privately a minute.
   * Not rendered yet: a redirect to the original for callers who may
   * download it, `404` for the others.
   */
  @Get(':attachmentId/thumbnail')
  async thumbnail(
    @Param('attachmentId', attachmentIdPipe) attachmentId: Id<'att'>,
    @Query(new ZodValidationPipe(thumbnailQuerySchema)) query: ThumbnailQuery,
    @CurrentPrincipal() principal: Principal,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await sendThumbnail(
      reply,
      await this.files.thumbnail(principal, attachmentId, thumbnailSizeOf(query)),
    );
  }
}
