import { Module } from '@nestjs/common';

import { InvitationController } from './invitation.controller.js';
import { InvitationService } from './invitation.service.js';

@Module({
  controllers: [InvitationController],
  providers: [InvitationService],
})
export class InvitationModule {}
