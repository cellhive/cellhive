import { Module } from '@nestjs/common';

import { HttpAllowlistController } from './http-allowlist.controller.js';
import { HttpAllowlistService } from './http-allowlist.service.js';

/** Outbound HTTP allowlist of an organization (BACKLOG T600, CONTRACTS §25.4). */
@Module({
  controllers: [HttpAllowlistController],
  providers: [HttpAllowlistService],
})
export class HttpAllowlistModule {}
