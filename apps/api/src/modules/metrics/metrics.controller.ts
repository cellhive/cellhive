import { Controller, Get, Headers, Inject, Res } from '@nestjs/common';

import { Public } from '../../common/auth/principal.js';

import { MetricsService } from './metrics.service.js';

import type { FastifyReply } from 'fastify';

/** `/metrics` on the main port; see `MetricsService` for the access rules. */
/** Authorised by METRICS_TOKEN, not by a session. */
@Controller()
@Public({ ignoreSession: true })
export class MetricsController {
  constructor(@Inject(MetricsService) private readonly metrics: MetricsService) {}

  @Get('metrics')
  async metricsText(
    @Headers('authorization') authorization: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<string> {
    this.metrics.authorizeMainPort(authorization);
    const { contentType, body } = await this.metrics.render();
    void reply.header('content-type', contentType);
    return body;
  }
}
