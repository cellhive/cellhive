import { recordWebhookRequest, type WebhookRequestResult } from '@cellhive/server-core';
import { isAppError } from '@cellhive/server-core/errors';
import { Controller, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';

import { Public } from '../../common/auth/principal.js';
import { RawUpload, uploadContentType } from '../../common/http/raw-upload.js';
import { MetricsService } from '../metrics/metrics.service.js';

import { HookReceiveService } from './hook-receive.service.js';

import type { ErrorCode, HookReceiveResponse } from '@cellhive/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';

/** `webhook_requests_total{result}` of a refused request, by its error code. */
const RESULT_OF_CODE: Partial<Record<ErrorCode, WebhookRequestResult>> = {
  NOT_FOUND: 'not_found',
  RATE_LIMITED: 'rate_limited',
  DEPENDENCY_UNAVAILABLE: 'unavailable',
  PAYLOAD_TOO_LARGE: 'too_large',
  UNSUPPORTED_MEDIA_TYPE: 'unsupported',
  MALFORMED_JSON: 'malformed',
  UNAUTHENTICATED: 'unauthorized',
};

/**
 * `POST /api/v1/hooks/:token` (BACKLOG T603, CONTRACTS §25.2): public,
 * authorised by the URL token and the hook's credentials, never by a
 * session. The body arrives unparsed (`@RawUpload()`, this route only) so
 * the size limit stops reading at once and the signature is checked over
 * the exact bytes. Only this controller parses it.
 */
@Controller()
export class HookReceiveController {
  constructor(
    @Inject(HookReceiveService) private readonly receiver: HookReceiveService,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  @Post('hooks/:token')
  @Public({ ignoreSession: true })
  @RawUpload()
  @HttpCode(202)
  async receive(
    @Param('token') token: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<HookReceiveResponse> {
    const started = performance.now();
    let result: WebhookRequestResult = 'accepted';
    try {
      const contentType = uploadContentType(request);
      // `request.headers` carries the raw-upload type `@RawUpload()` swapped in: keep (and
      // store) the Content-Type the sender used (QA S5c).
      const headers = { ...request.headers };
      if (contentType === undefined) delete headers['content-type'];
      else headers['content-type'] = contentType;
      const received = await this.receiver.receive({
        token,
        ip: request.ip === '' ? null : request.ip,
        host: request.host,
        url: request.url,
        headers,
        contentType,
        body: request.raw,
      });
      result = received.result;
      return received.response;
    } catch (error) {
      const code = isAppError(error) ? error.code : undefined;
      result = (code === undefined ? undefined : RESULT_OF_CODE[code]) ?? 'unavailable';
      // The rest of an oversized body is never read: close the connection after the answer.
      if (code === 'PAYLOAD_TOO_LARGE') void reply.header('connection', 'close');
      throw error;
    } finally {
      recordWebhookRequest(result);
      this.metrics.observeWebhookRequest(result, performance.now() - started);
    }
  }
}
