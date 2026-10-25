import {
  automationActionIdSchema,
  httpTestRequestSchema,
  idOf,
  type HttpTestAccepted,
  type HttpTestRequest,
  type Id,
} from '@cellhive/contracts';
import { Body, Controller, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';

import { CurrentPrincipal, type Principal } from '../../common/auth/principal.js';
import { requestMetaOf } from '../../common/auth/request-meta.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';

import { AutomationHttpTestService } from './automation-http-test.service.js';

import type { FastifyRequest } from 'fastify';

/** "Send a test" of an `http_request` step (CONTRACTS §25.5; BACKLOG T606). */
@Controller()
export class AutomationHttpTestController {
  constructor(
    @Inject(AutomationHttpTestService) private readonly http: AutomationHttpTestService,
  ) {}

  @Post('automations/:automationId/actions/:actionId/http-test')
  @HttpCode(202)
  test(
    @Param('automationId', new ZodValidationPipe(idOf('aut'))) automationId: Id<'aut'>,
    @Param('actionId', new ZodValidationPipe(automationActionIdSchema)) actionId: string,
    @Body(new ZodValidationPipe(httpTestRequestSchema)) body: HttpTestRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<HttpTestAccepted> {
    return this.http.test(principal, automationId, actionId, body, requestMetaOf(request));
  }
}
