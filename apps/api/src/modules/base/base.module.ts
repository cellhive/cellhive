import { Module } from '@nestjs/common';

import { BaseController } from './base.controller.js';
import { BaseService } from './base.service.js';

@Module({
  controllers: [BaseController],
  providers: [BaseService],
  // The MCP tools (T920) read through the same services.
  exports: [BaseService],
})
export class BaseModule {}
