import {
  formSubmitRequestSchema,
  idOf,
  shareFormUploadCompleteRequestSchema,
  shareFormUploadRequestSchema,
  shareLinkCandidatesQuerySchema,
  type CreateUploadResponse,
  type FormSubmissionStatus,
  type FormSubmitRequest,
  type FormSubmitResponse,
  type FormSubmitTokenDto,
  type Id,
  type ShareFormMemberList,
  type ShareFormUploadCompleteRequest,
  type ShareFormUploadDto,
  type ShareFormUploadRequest,
  type ShareLinkCandidatesDto,
  type ShareLinkCandidatesQuery,
} from '@cellhive/contracts';
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';

import { OptionalPrincipal, Public, type Principal } from '../../common/auth/principal.js';
import { requestMetaOf } from '../../common/auth/request-meta.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';

import { assertFormBodySize } from './form-body.js';
import { FormService } from './form.service.js';
import { ShareFormInputsService } from './share-form-inputs.service.js';

import type { FastifyRequest } from 'fastify';

/**
 * Form submission through a share link (CONTRACTS §17): the only
 * `/shares/:token/*` routes outside the read-only share module (T305) —
 * `submit-token`, `submit`, (T321) `submission-status` and `members`, and
 * (T410) `link-candidates/:fieldId` and `uploads`.
 * Public: a session, when present, is used for `org` links and forms that
 * require sign-in (and then CSRF applies).
 */
@Controller()
@Public()
export class ShareFormController {
  constructor(
    @Inject(FormService) private readonly forms: FormService,
    @Inject(ShareFormInputsService) private readonly inputs: ShareFormInputsService,
  ) {}

  @Get('shares/:token/link-candidates/:fieldId')
  linkCandidates(
    @Param('token') token: string,
    @Param('fieldId', new ZodValidationPipe(idOf('fld'))) fieldId: Id<'fld'>,
    @Query(new ZodValidationPipe(shareLinkCandidatesQuerySchema)) query: ShareLinkCandidatesQuery,
    @Req() request: FastifyRequest,
  ): Promise<ShareLinkCandidatesDto> {
    return this.inputs.linkCandidates(token, fieldId, query, request);
  }

  @Post('shares/:token/uploads')
  @HttpCode(201)
  createUpload(
    @Param('token') token: string,
    @Body(new ZodValidationPipe(shareFormUploadRequestSchema)) body: ShareFormUploadRequest,
    @Req() request: FastifyRequest,
  ): Promise<CreateUploadResponse> {
    return this.inputs.createUpload(token, body, request);
  }

  @Post('shares/:token/uploads/:attachmentId/complete')
  @HttpCode(200)
  completeUpload(
    @Param('token') token: string,
    @Param('attachmentId', new ZodValidationPipe(idOf('att'))) attachmentId: Id<'att'>,
    @Body(new ZodValidationPipe(shareFormUploadCompleteRequestSchema))
    body: ShareFormUploadCompleteRequest,
    @Req() request: FastifyRequest,
  ): Promise<ShareFormUploadDto> {
    return this.inputs.completeUpload(token, attachmentId, body, request);
  }

  @Get('shares/:token/submit-token')
  submitToken(
    @Param('token') token: string,
    @Req() request: FastifyRequest,
  ): Promise<FormSubmitTokenDto> {
    return this.forms.submitToken(token, request);
  }

  @Get('shares/:token/submission-status')
  submissionStatus(
    @Param('token') token: string,
    @Req() request: FastifyRequest,
  ): Promise<FormSubmissionStatus> {
    return this.forms.submissionStatusViaLink(token, request);
  }

  @Get('shares/:token/members')
  members(
    @Param('token') token: string,
    @Req() request: FastifyRequest,
  ): Promise<ShareFormMemberList> {
    return this.forms.membersViaLink(token, request);
  }

  @Post('shares/:token/submit')
  @HttpCode(200)
  submit(
    @Param('token') token: string,
    @Body(new ZodValidationPipe(formSubmitRequestSchema)) body: FormSubmitRequest,
    @OptionalPrincipal() principal: Principal | undefined,
    @Req() request: FastifyRequest,
  ): Promise<FormSubmitResponse> {
    assertFormBodySize(request);
    return this.forms.submitViaLink(token, principal, body, requestMetaOf(request), request);
  }
}
