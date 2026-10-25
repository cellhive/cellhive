import { Module } from '@nestjs/common';

import { ApiTokenController } from './api-token.controller.js';
import { ApiTokenService } from './api-token.service.js';

/** Personal API tokens — management (BACKLOG T703, CONTRACTS §26.4). */
@Module({
  controllers: [ApiTokenController],
  providers: [ApiTokenService],
})
export class ApiTokenModule {}
