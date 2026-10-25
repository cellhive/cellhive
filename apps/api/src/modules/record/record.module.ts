import { Module } from '@nestjs/common';

import { ButtonController } from './button.controller.js';
import { ButtonService } from './button.service.js';
import { FollowController } from './follow.controller.js';
import { FollowService } from './follow.service.js';
import { LinkCandidatesController } from './link-candidates.controller.js';
import { RecordController } from './record.controller.js';
import { RecordService } from './record.service.js';

@Module({
  controllers: [RecordController, LinkCandidatesController, ButtonController, FollowController],
  providers: [RecordService, ButtonService, FollowService],
  exports: [RecordService],
})
export class RecordModule {}
