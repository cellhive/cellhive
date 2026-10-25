import { Module } from '@nestjs/common';

import { NotificationChannelsController } from './notification-channels.controller.js';
import { NotificationChannelsService } from './notification-channels.service.js';
import { NotificationController } from './notification.controller.js';
import { NotificationService } from './notification.service.js';
import { TelegramWebhookController } from './telegram-webhook.controller.js';
import { TelegramWebhookService } from './telegram-webhook.service.js';

/**
 * In-app notifications, preferences, settings and base mutes (BACKLOG T511,
 * CONTRACTS §22); the notification bot and personal channels (T549, §22.7)
 * and its webhook route (T609).
 */
@Module({
  controllers: [NotificationController, NotificationChannelsController, TelegramWebhookController],
  providers: [NotificationService, NotificationChannelsService, TelegramWebhookService],
})
export class NotificationModule {}
