import {
  formCoverUploadRequestSchema,
  idOf,
  type CreateUploadResponse,
  type FormCoverDto,
  type FormCoverUploadRequest,
  type Id,
} from '@cellhive/contracts';
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';

import { CurrentPrincipal, Public, type Principal } from '../../common/auth/principal.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { sendFileRedirect } from '../file/file-replies.js';

import { FormCoverService } from './form-cover.service.js';

import type { FastifyReply, FastifyRequest } from 'fastify';

const viewIdPipe = new ZodValidationPipe(idOf('viw'));
const attachmentIdPipe = new ZodValidationPipe(idOf('att'));

/** Cover images of form views, for members (CONTRACTS §15, §17; BACKLOG T419). */
@Controller('views/:viewId/form-cover')
export class FormCoverController {
  constructor(@Inject(FormCoverService) private readonly covers: FormCoverService) {}

  @Post('uploads')
  @HttpCode(201)
  createUpload(
    @Param('viewId', viewIdPipe) viewId: Id<'viw'>,
    @Body(new ZodValidationPipe(formCoverUploadRequestSchema)) body: FormCoverUploadRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CreateUploadResponse> {
    return this.covers.createUpload(principal, viewId, body);
  }

  @Post('uploads/:attachmentId/complete')
  @HttpCode(200)
  complete(
    @Param('viewId', viewIdPipe) viewId: Id<'viw'>,
    @Param('attachmentId', attachmentIdPipe) attachmentId: Id<'att'>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<FormCoverDto> {
    return this.covers.complete(principal, viewId, attachmentId);
  }

  @Get(':attachmentId')
  async read(
    @Param('viewId', viewIdPipe) viewId: Id<'viw'>,
    @Param('attachmentId', attachmentIdPipe) attachmentId: Id<'att'>,
    @CurrentPrincipal() principal: Principal,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await sendFileRedirect(reply, await this.covers.read(principal, viewId, attachmentId));
  }
}

/** The cover of a form through its share link (CONTRACTS §17; BACKLOG T419). */
@Controller('shares/:token/form-cover')
@Public()
export class ShareFormCoverController {
  constructor(@Inject(FormCoverService) private readonly covers: FormCoverService) {}

  @Get(':attachmentId')
  async read(
    @Param('token') token: string,
    @Param('attachmentId', attachmentIdPipe) attachmentId: Id<'att'>,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await sendFileRedirect(reply, await this.covers.readViaLink(token, attachmentId, request));
  }
}
