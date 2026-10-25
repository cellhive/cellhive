import { Module } from '@nestjs/common';

import { GroupController } from './group.controller.js';
import { GroupService } from './group.service.js';

@Module({
  controllers: [GroupController],
  providers: [GroupService],
})
export class GroupModule {}
