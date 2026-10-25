import { Module } from '@nestjs/common';

import { SetupController } from './setup.controller.js';
import { SetupService } from './setup.service.js';

@Module({
  controllers: [SetupController],
  providers: [SetupService],
})
export class SetupModule {}
