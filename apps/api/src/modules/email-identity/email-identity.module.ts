import { Module } from '@nestjs/common';

import { EmailIdentityController } from './email-identity.controller.js';
import { EmailIdentityService } from './email-identity.service.js';

/** Sender identities and their public verification (BACKLOG T530, CONTRACTS §23.3). */
@Module({
  controllers: [EmailIdentityController],
  providers: [EmailIdentityService],
})
export class EmailIdentityModule {}
