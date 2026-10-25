import { Module } from '@nestjs/common';

import { IncomingWebhookRateLimits } from '../../common/rate-limit/incoming-webhook-rate-limits.js';
import { MetricsModule } from '../metrics/metrics.module.js';

import { HookReceiveController } from './hook-receive.controller.js';
import { HookReceiveService } from './hook-receive.service.js';
import { IncomingWebhookController } from './incoming-webhook.controller.js';
import { IncomingWebhookService } from './incoming-webhook.service.js';

/**
 * Incoming webhooks: management (BACKLOG T602, CONTRACTS §25.1), the public
 * route `POST /hooks/:token` and sample listening (T603, §25.2–§25.3).
 */
@Module({
  imports: [MetricsModule],
  controllers: [IncomingWebhookController, HookReceiveController],
  providers: [IncomingWebhookService, HookReceiveService, IncomingWebhookRateLimits],
  exports: [IncomingWebhookRateLimits],
})
export class IncomingWebhookModule {}
