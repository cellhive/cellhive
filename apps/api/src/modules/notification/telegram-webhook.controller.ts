import { Controller, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';

import { Public } from '../../common/auth/principal.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';

import { TelegramWebhookService } from './telegram-webhook.service.js';

import type { FastifyRequest } from 'fastify';

const SECRET_HEADER = 'x-telegram-bot-api-secret-token';

/**
 * Telegram's webhook for notification bots in webhook mode (BACKLOG T609,
 * ADR-35 §7, CONTRACTS §22.7). Public — authorized by the unguessable path
 * token and the `X-Telegram-Bot-Api-Secret-Token` header, never by a
 * session (the cookie is not even read). Not in the public OpenAPI: only
 * Telegram calls it.
 */
@Controller('telegram/webhook')
export class TelegramWebhookController {
  constructor(@Inject(TelegramWebhookService) private readonly service: TelegramWebhookService) {}

  @Post(':pathToken')
  @Public({ ignoreSession: true })
  @HttpCode(200)
  async receive(
    // Any segment: a malformed token answers `404` like an unknown one (never `422`).
    @Param('pathToken', new ZodValidationPipe(z.string())) pathToken: string,
    @Req() request: FastifyRequest,
  ): Promise<Record<string, never>> {
    const secret = request.headers[SECRET_HEADER];
    const secretHeader = typeof secret === 'string' ? secret : undefined;
    const header = Number(request.headers['content-length']);
    await this.service.receive(
      pathToken,
      secretHeader,
      Number.isFinite(header) ? header : null,
      request.body,
    );
    return {};
  }
}
