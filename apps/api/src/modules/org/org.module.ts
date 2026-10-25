import { Module } from '@nestjs/common';

import { OrgMemberService } from './org-member.service.js';
import { OrgController } from './org.controller.js';
import { OrgService } from './org.service.js';

@Module({
  controllers: [OrgController],
  providers: [OrgService, OrgMemberService],
  exports: [OrgService],
})
export class OrgModule {}
