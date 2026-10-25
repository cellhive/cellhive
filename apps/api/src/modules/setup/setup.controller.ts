import {
  setupRequestSchema,
  type SetupRequest,
  type SetupResponse,
  type SetupStatus,
} from '@cellhive/contracts';
import { Body, Controller, Get, HttpCode, Inject, Post, Req } from '@nestjs/common';

import { Public } from '../../common/auth/principal.js';
import { requestMetaOf } from '../../common/auth/request-meta.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';

import { SetupService } from './setup.service.js';

import type { FastifyRequest } from 'fastify';

/** `GET|POST /api/v1/setup` (SPEC §14.1A). */
@Controller('setup')
@Public()
export class SetupController {
  constructor(@Inject(SetupService) private readonly setup: SetupService) {}

  @Get()
  status(): Promise<SetupStatus> {
    return this.setup.status();
  }

  @Post()
  @HttpCode(201)
  complete(
    @Body(new ZodValidationPipe(setupRequestSchema)) body: SetupRequest,
    @Req() request: FastifyRequest,
  ): Promise<SetupResponse> {
    return this.setup.complete(body, requestMetaOf(request));
  }
}
