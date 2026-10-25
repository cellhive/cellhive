import { Module } from '@nestjs/common';

import { SecretController } from './secret.controller.js';
import { SecretService } from './secret.service.js';

/** Organization secrets: Telegram bot tokens (BACKLOG T516, CONTRACTS §24). */
@Module({
  controllers: [SecretController],
  providers: [SecretService],
})
export class SecretModule {}
