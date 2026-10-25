import {
  buttonClickParamsSchema,
  type ButtonClickParams,
  type ButtonClickResponse,
} from '@cellhive/contracts';
import { Controller, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';

import { CurrentPrincipal, type Principal } from '../../common/auth/principal.js';
import { requestMetaOf } from '../../common/auth/request-meta.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';

import { ButtonService } from './button.service.js';

import type { FastifyRequest } from 'fastify';

/**
 * `POST /tables/:tableId/records/:recordId/buttons/:fieldId/click` (BACKLOG
 * T517, CONTRACTS §21): runs the automation of a button field as its
 * `run_as`; `202 { run_id }`.
 */
@Controller('tables/:tableId/records/:recordId/buttons/:fieldId/click')
export class ButtonController {
  constructor(@Inject(ButtonService) private readonly buttons: ButtonService) {}

  @Post()
  @HttpCode(202)
  click(
    @Param(new ZodValidationPipe(buttonClickParamsSchema)) params: ButtonClickParams,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<ButtonClickResponse> {
    return this.buttons.click(principal, params, requestMetaOf(request));
  }
}
