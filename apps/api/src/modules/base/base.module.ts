import { Module } from '@nestjs/common';

import { BaseController } from './base.controller.js';
import { BaseService } from './base.service.js';

@Module({
  controllers: [BaseController],
  providers: [BaseService],
})
export class BaseModule {}
