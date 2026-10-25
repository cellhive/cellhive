import {
  idOf,
  thumbnailQuerySchema,
  thumbnailSizeOf,
  type Id,
  type ThumbnailQuery,
} from '@cellhive/contracts';
import { Controller, Get, Inject, Param, Query, Req, Res } from '@nestjs/common';

import { Public } from '../../common/auth/principal.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { sendFileRedirect, sendThumbnail } from '../file/file-replies.js';

import { ShareFileService } from './share-file.service.js';

import type { FastifyReply, FastifyRequest } from 'fastify';

const attachmentIdPipe = new ZodValidationPipe(idOf('att'));

/**
 * Files of a shared view (CONTRACTS §16A, BACKLOG T409): the download
 * (`allow_download`) and the thumbnail (no flag needed). The share headers
 * (`noindex`, `no-referrer`, `no-store`) are added to every response by
 * `registerShareResponseHeaders`.
 */
@Controller('shares/:token/files')
@Public()
export class ShareFileController {
  constructor(@Inject(ShareFileService) private readonly files: ShareFileService) {}

  @Get(':attachmentId')
  async download(
    @Param('token') token: string,
    @Param('attachmentId', attachmentIdPipe) attachmentId: Id<'att'>,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await sendFileRedirect(reply, await this.files.download(token, attachmentId, request));
  }

  @Get(':attachmentId/thumbnail')
  async thumbnail(
    @Param('token') token: string,
    @Param('attachmentId', attachmentIdPipe) attachmentId: Id<'att'>,
    @Query(new ZodValidationPipe(thumbnailQuerySchema)) query: ThumbnailQuery,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await sendThumbnail(
      reply,
      await this.files.thumbnail(token, attachmentId, thumbnailSizeOf(query), request),
    );
  }
}
