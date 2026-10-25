import {
  formSubmitRequestSchema,
  idOf,
  type FormSubmissionStatus,
  type FormSubmitRequest,
  type FormSubmitResponse,
  type Id,
} from '@cellhive/contracts';
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';

import { CurrentPrincipal, type Principal } from '../../common/auth/principal.js';
import { requestMetaOf } from '../../common/auth/request-meta.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';

import { assertFormBodySize } from './form-body.js';
import { FormService } from './form.service.js';

import type { FastifyRequest } from 'fastify';

/**
 * `POST /views/:viewId/submit`: a member of the base fills in a form, and
 * `GET /views/:viewId/submission-status`: whether they reached its limit
 * (CONTRACTS §17).
 */
@Controller()
export class FormController {
  constructor(@Inject(FormService) private readonly forms: FormService) {}

  @Get('views/:viewId/submission-status')
  submissionStatus(
    @Param('viewId', new ZodValidationPipe(idOf('viw'))) viewId: Id<'viw'>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<FormSubmissionStatus> {
    return this.forms.submissionStatus(principal, viewId);
  }

  @Post('views/:viewId/submit')
  @HttpCode(200)
  submit(
    @Param('viewId', new ZodValidationPipe(idOf('viw'))) viewId: Id<'viw'>,
    @Body(new ZodValidationPipe(formSubmitRequestSchema)) body: FormSubmitRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<FormSubmitResponse> {
    assertFormBodySize(request);
    return this.forms.submitAsMember(principal, viewId, body, requestMetaOf(request));
  }
}
